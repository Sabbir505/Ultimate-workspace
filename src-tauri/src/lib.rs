//! Conduit backend entry point (Tauri v2).
//!
//! Wires up: plugins (dialog, notification, fs, opener), shared state (SQLite +
//! PtyManager), native window vibrancy (PRD §7.1), all CONTRACT.md commands,
//! and — critically — child-process cleanup on app exit (PRD §8: no orphaned
//! agent processes after the app closes).

mod browser;
mod browser_capture;
mod browser_mcp;
mod browser_mcp_register;
mod checkpoints;
pub mod agent_sessions;
mod acp;
mod acp_agents;
mod automation_task;
pub mod automations;
mod chat;
mod commands;
mod connectors;
pub mod db;
mod docs_index;
mod git;
mod github;
mod git_watcher;
mod harness_adapters;
mod harness_bundle;
mod harness_config;
mod installed_skills;
mod mcp_tools_bridge;
mod mobile;
mod pty;
mod secrets;
mod types;
mod util;

use std::fs;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::Manager;

use pty::PtyManager;

/// Shared SQLite connection. One connection behind a mutex: rusqlite
/// connections are !Sync, and Conduit's write volume is tiny.
pub struct DbState(pub Arc<Mutex<Connection>>);

pub struct PtyState(pub Arc<PtyManager>);

/// Native child-webview browser panes (Windows/macOS; see browser.rs).
pub struct BrowserState(pub Arc<browser::BrowserManager>);

/// Chat mode manager (see chat/mod.rs).
pub struct ChatState(pub Arc<chat::ChatManager>);

/// Background chat tasks (download_file / run_shell) — see chat/tasks.rs.
pub struct TaskState(pub Arc<chat::tasks::TaskManager>);

/// Mobile relay server state (see mobile/relay.rs).
pub struct MobileRelayState(pub Arc<mobile::relay::MobileRelayState>);

/// Tracked JoinHandle for the browser MCP stdio/socket server (mi20) so the
/// exit handler can abort it instead of orphaning the accept loop.
pub struct BrowserMcpHandle(pub Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

/// In-flight OAuth flows for the Connectors feature (see connectors/oauth.rs).
/// Registered as Tauri state so the auth webview's `on_navigation` hook can
/// look up a pending flow by id and resolve it.
pub struct OAuthFlowsState(pub Arc<connectors::oauth::OAuthFlows>);

// Note: LocalModelState is defined in chat::local_models (next to the
// registry it wraps) and registered via app.manage below. The commands in
// chat::commands declare `State<local_models::LocalModelState>`, so the
// managed type MUST be that same one — Tauri matches state by concrete type.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Chat DB location: `storage.dbDir` (Settings → Data) when set,
            // else the default `<app data dir>/conduit.db`. The setting is
            // read by peeking at the default DB, which always exists.
            let db_path = db::chat_db_path(app.handle()).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("no app data dir: {e}"))
            })?;
            if let Some(parent) = db_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let conn = db::open(&db_path)?;
            let shared_db = Arc::new(Mutex::new(conn));
            // Sweep artifacts past their 30-day retention window on startup.
            chat::commands::sweep_expired_artifacts(&shared_db);
            // Register the bundled, relocatable Python (shipped in
            // bundle.resources → resource_dir/python) so document generation
            // works on machines that have no system Python. Missing bundle
            // degrades silently to system Python — see chat::python_runtime.
            let resource_dir = app.path().resource_dir().ok();
            // Dev builds (`tauri dev` / `cargo run`) don't copy
            // bundle.resources into the target dir, so resource_dir/<bundle>
            // is absent even when the bundle is staged. Fall back to the
            // staged tree in the repo (scripts/fetch-bundled-*.mjs) so dev
            // uses the same interpreters and converters as the installed app.
            #[cfg(debug_assertions)]
            let resource_dir = resource_dir
                .filter(|d| d.join("python").is_dir() || d.join("libreoffice").is_dir())
                .or_else(|| {
                    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
                    (dev.join("python").is_dir() || dev.join("libreoffice").is_dir())
                        .then_some(dev)
                });
            chat::python_runtime::set_resource_dir(resource_dir.clone());
            // Same registration for the bundled LibreOffice that backs the
            // pptx→pdf preview path (resource_dir/libreoffice/program/soffice).
            chat::office::set_resource_dir(resource_dir);
            app.manage(DbState(Arc::clone(&shared_db)));
            app.manage(PtyState(PtyManager::new(app.handle().clone(), Arc::clone(&shared_db))));
            app.manage(BrowserState(Arc::new(browser::BrowserManager::new(
                app.handle().clone(),
            ))));
            app.manage(ChatState(Arc::new(chat::ChatManager::new())));
            app.manage(agent_sessions::AgentSessionState(Arc::new(
                agent_sessions::AgentSessionManager::new(),
            )));
            app.manage(TaskState(Arc::new(chat::tasks::TaskManager::new())));
            app.manage(MobileRelayState(Arc::new(mobile::relay::MobileRelayState::new())));
            app.manage(OAuthFlowsState(Arc::new(
                connectors::oauth::OAuthFlows::default(),
            )));
            app.manage(chat::local_models::LocalModelState(Arc::new(
                chat::local_models::LocalModelRegistry::new(),
            )));
            app.manage(std::sync::Arc::new(
                commands::local_model_market::DownloadRegistry::default(),
            ));
            app.manage(std::sync::Arc::new(docs_index::IndexRegistry::default()));
            // Git filesystem watcher — drives the `project:fs-changed` Tauri
            // event that replaces the 4-8s polling loops in
            // `useGitStatusPolling` / `DevDiffPanel` / `BranchDropdown`. See
            // src-tauri/src/git_watcher.rs for the design.
            app.manage(git_watcher::WatcherState::new());
            {
                let app_handle = app.handle().clone();
                let db_state = DbState(Arc::clone(&shared_db));
                // Defer watcher install slightly so the rest of the setup
                // (PTY manager, etc.) finishes first — we don't want
                // watcher events to fire before the frontend is listening.
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    git_watcher::install_all_known(&app_handle, &db_state);
                });
            }

            // Spawn the mobile relay server on a random localhost port so the
            // companion mobile app can connect and route chat requests through
            // the desktop (the phone never holds API keys).
            {
                let db = Arc::clone(&shared_db);
                let chat_mgr = Arc::clone(&app.state::<ChatState>().inner().0);
                let relay_state = Arc::clone(&app.state::<MobileRelayState>().inner().0);
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = mobile::relay::start_relay(app_handle, relay_state, db, chat_mgr).await;
                });
            }

            // Spawn the loopback WebSocket server that the standalone
            // conduit-browser-mcp binary connects to (agent-driven browser
            // control). Bind is non-fatal: if port BROWSER_MCP_PORT is taken
            // the MCP binary just gets connection-refused and reports
            // `browser_unavailable` — the rest of the app is unaffected.
            {
                let browser_mgr = app
                    .state::<BrowserState>()
                    .inner()
                    .0
                    .clone();
                let app_handle = app.handle().clone();
                // mi20: track the JoinHandle so app exit can abort the accept
                // loop — previously the task was orphaned and its listener
                // (plus any in-flight eval bridge connections) only died when
                // the runtime tore down.
                let handle = tauri::async_runtime::spawn(async move {
                    browser_mcp::serve(browser_mgr, app_handle).await;
                });
                app.manage(BrowserMcpHandle(Mutex::new(Some(handle))));
            }

            // Automations scheduler: 30s tick, fires due cron schedules as
            // headless one-shot agent turns (see automations.rs).
            automations::start(app.handle().clone(), Arc::clone(&shared_db));

            // Native vibrancy (PRD §7.1): acrylic blur on Windows, frosted
            // vibrancy on macOS, nothing on Linux (flat theme is the correct
            // baseline there). Failures are non-fatal — a solid window beats
            // a crash on exotic compositors.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    let _ = window_vibrancy::apply_blur(&window, Some((18, 18, 18, 125)));
                }
                #[cfg(target_os = "macos")]
                {
                    let _ = window_vibrancy::apply_vibrancy(
                        &window,
                        window_vibrancy::NSVisualEffectMaterial::HudWindow,
                        None,
                        None,
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // projects / sessions
            commands::projects::list_projects,
            commands::projects::add_project,
            commands::projects::remove_project,
            commands::projects::rename_project,
            commands::projects::init_git_repo,
            commands::projects::list_sessions,
            commands::projects::create_session,
            commands::projects::update_session_title,
            commands::projects::delete_session,
            commands::projects::touch_session,
            // pty / harnesses
            commands::pty_cmds::spawn_agent_session,
            commands::pty_cmds::spawn_shell,
            commands::pty_cmds::write_pty,
            commands::pty_cmds::resize_pty,
            commands::pty_cmds::kill_pty,
            commands::pty_cmds::pane_memory,
            commands::pty_cmds::list_harnesses,
            commands::pty_cmds::run_harness_login,
            commands::pty_cmds::pty_subscribe,
            // native browser panes (child webviews)
            commands::browser_cmds::browser_create,
            commands::browser_cmds::browser_navigate,
            commands::browser_cmds::browser_open_devtools,
            commands::browser_cmds::browser_push_state,
            commands::browser_cmds::browser_action_result,
            commands::browser_cmds::browser_go_back,
            commands::browser_cmds::browser_go_forward,
            commands::browser_cmds::browser_reload,
            commands::browser_cmds::browser_set_bounds,
            commands::browser_cmds::browser_set_visible,
            commands::browser_cmds::browser_close,
            commands::browser_cmds::browser_close_pane,
            // browser pane project registry + MCP roundtrip
            commands::browser_cmds::register_browser_pane_project,
            commands::browser_cmds::unregister_browser_pane_project,
            commands::browser_cmds::browser_resolve_pane_result,
            commands::browser_cmds::browser_open_pane_result,
            // git
            github::github_list_prs,
            github::github_create_pr,
            github::github_get_pr,
            github::github_pr_files,
            github::github_submit_review,
            github::github_pr_checks,
            github::github_draft_pr_text,
            github::github_local_branches,
            commands::git_cmds::get_git_status,
            commands::git_cmds::get_changed_files,
            commands::git_cmds::create_worktree,
            commands::git_cmds::get_git_diff,
            commands::git_cmds::get_git_file_diff,
            commands::git_cmds::list_git_branches,
            commands::git_cmds::create_git_branch,
            commands::git_cmds::checkout_git_branch,
            commands::git_cmds::delete_git_branch,
            commands::git_cmds::get_git_log,
            commands::git_cmds::get_remote_url,
            commands::git_cmds::git_commit,
            commands::git_cmds::git_push,
            // git filesystem watcher — installs/uninstalls per-path watchers
            // that drive the `project:fs-changed` Tauri event. Replaces the
            // 4-8s polling loops in the frontend. See git_watcher.rs.
            commands::git_cmds::install_git_watcher,
            commands::git_cmds::uninstall_git_watcher,
            commands::git_cmds::refresh_git_watchers,
            // automations (scheduled headless agent runs)
            commands::automation_cmds::list_automations,
            commands::automation_cmds::create_automation,
            commands::automation_cmds::update_automation,
            commands::automation_cmds::delete_automation,
            commands::automation_cmds::set_automation_enabled,
            commands::automation_cmds::run_automation_now,
            automation_task::get_run_while_closed,
            automation_task::set_run_while_closed,
            automation_task::test_automation_webhook,
            commands::automation_cmds::list_automation_runs,
            commands::automation_cmds::count_automation_runs,
            // settings / skills / quick actions / secrets / cost / misc
            commands::data::get_setting,
            commands::data::set_setting,
            commands::data::get_chat_db_path,
            commands::data::set_chat_db_dir,
            commands::data::get_data_paths,
            commands::data::list_skills,
            commands::data::create_skill,
            commands::data::update_skill,
            commands::data::delete_skill,
            commands::data::list_quick_actions,
            commands::data::create_quick_action,
            commands::data::update_quick_action,
            commands::data::delete_quick_action,
            commands::data::set_secret,
            commands::data::delete_secret,
            commands::data::list_secret_keys,
            commands::data::get_cost_events,
            commands::data::get_cost_rollups,
            commands::data::export_session_markdown,
            commands::data::read_file_text,
            // workspaces (pane layout save/restore)
            commands::data::list_workspaces,
            commands::data::save_workspace,
            commands::data::delete_workspace,
            commands::data::pop_out_chat,
            // installed skills / loops (harness skill directories)
            commands::skills_cmds::list_installed_skills,
            commands::skills_cmds::list_installed_loops,
            commands::skills_cmds::read_installed_skill,
            commands::skills_cmds::save_installed_skill,
            commands::skills_cmds::create_installed_skill,
            commands::skills_cmds::delete_installed_skill,
            commands::skills_cmds::make_installed_global,
            commands::skills_cmds::list_chat_skills,
            // chat mode
            commands::chat_cmds::list_chat_sessions,
            commands::chat_cmds::search_chat_messages,
            commands::chat_cmds::list_chat_checkpoints,
            commands::chat_cmds::restore_chat_checkpoint,
            commands::chat_cmds::create_chat_session,
            commands::chat_cmds::delete_chat_session,
            commands::chat_cmds::delete_all_chat_sessions,
            commands::chat_cmds::delete_empty_chat_sessions,
            commands::chat_cmds::delete_chat_message,
            commands::chat_cmds::supersede_chat_tail,
            commands::chat_cmds::update_chat_session_title,
            commands::chat_cmds::generate_chat_title,
            commands::chat_cmds::generate_commit_message,
            commands::chat_cmds::set_chat_session_starred,
            commands::chat_cmds::set_chat_session_unread,
            commands::chat_cmds::update_chat_session_model,
            commands::chat_cmds::update_chat_session_provider,
            commands::chat_cmds::update_chat_session_watch_mode,
            commands::chat_cmds::update_chat_session_permission_mode,
            commands::chat_cmds::update_chat_session_agent,
            commands::chat_cmds::set_chat_session_project,
            commands::chat_cmds::get_chat_messages,
            commands::chat_cmds::get_chat_session_metrics,
            commands::chat_cmds::touch_chat_session,
            commands::chat_cmds::send_chat_message,
            commands::chat_cmds::cancel_chat_message,
            commands::chat_cmds::persist_partial_chat_message,
            commands::agent_cmds::send_agent_chat_message,
            commands::agent_cmds::cancel_agent_chat_message,
            commands::agent_cmds::list_harness_models,
            commands::agent_cmds::list_acp_agents,
            commands::agent_cmds::chat_token_subscribe,
            commands::chat_cmds::resolve_tool_action,
            commands::chat_cmds::set_chat_api_key,
            commands::chat_cmds::delete_chat_api_key,
            commands::chat_cmds::get_chat_config,
            commands::chat_cmds::list_chat_models,
            commands::chat_cmds::read_artifact_preview,
            commands::chat_cmds::is_libreoffice_available,
            commands::chat_cmds::download_artifact,
            commands::chat_cmds::download_artifacts_zip,
            commands::chat_cmds::list_artifacts,
            commands::chat_cmds::list_chat_artifacts,
            commands::chat_cmds::delete_artifact,
            commands::chat_cmds::delete_all_artifacts,
            // local models (GGUF scan / llama-server sidecar)
            commands::chat_cmds::scan_local_models,
            commands::chat_cmds::start_local_model,
            commands::chat_cmds::stop_local_model,
            commands::chat_cmds::local_model_status,
            commands::chat_cmds::count_context_tokens,
            commands::chat_cmds::count_context_breakdown,
            // connectors (OAuth + remote MCP): Settings → Connectors + per-chat attach
            commands::connectors_cmds::list_connectors,
            commands::connectors_cmds::connector_connect,
            commands::connectors_cmds::connector_connect_family,
            commands::connectors_cmds::connector_disconnect,
            commands::connectors_cmds::set_session_connectors,
            commands::connectors_cmds::list_session_connectors,
            // auto-updater (Tauri updater plugin)
            commands::updater_cmds::check_for_update,
            commands::updater_cmds::download_and_install_update,
            // mobile relay
            mobile::commands::start_mobile_relay,
            mobile::commands::stop_mobile_relay,
            mobile::commands::get_mobile_relay_status,
            mobile::commands::get_mobile_pairing_info,
            mobile::commands::tailscale_serve_enable,
            mobile::commands::tailscale_serve_disable,
            // local model market (Hugging Face browse + download)
            commands::local_model_market::fetch_model_catalog,
            commands::local_model_market::get_gpu_vram,
            commands::local_model_market::get_market_settings,
            commands::local_model_market::set_models_directory,
            commands::local_model_market::pick_models_directory,
            commands::local_model_market::set_hugging_face_token,
            commands::local_model_market::clear_hugging_face_token,
            commands::local_model_market::start_model_download,
            commands::local_model_market::cancel_model_download,
            commands::local_model_market::delete_downloaded_model,
            commands::local_model_market::download_mmproj,
            docs_index::docs_embedding_status,
            docs_index::docs_add_corpus,
            docs_index::docs_remove_corpus,
            docs_index::docs_list_corpora,
            docs_index::docs_set_corpus_enabled,
            docs_index::docs_start_index,
            docs_index::docs_cancel_index,
            chat::export::export_chat_zip,
            chat::export::export_project_zip,
            chat::export::import_chat_zip,
            commands::budget::list_budgets,
            commands::budget::set_budget,
            commands::budget::remove_budget,
            commands::budget::check_budgets,
            commands::speech::transcribe_audio,
            commands::worktree_cmds::ensure_chat_session_worktree,
            commands::worktree_cmds::set_chat_session_worktree,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Conduit");

    // Exit cleanup (PRD §8): every child pty process must be terminated when
    // the app quits — closing the last window triggers ExitRequested, and
    // Exit is the belt-and-braces backstop. kill_all is idempotent.
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = handle.try_state::<PtyState>() {
                state.0.kill_all();
            }
            // Native browser webviews are child views of the main window; they
            // would die with it anyway, but close them explicitly so no
            // renderer process outlives the app.
            if let Some(state) = handle.try_state::<BrowserState>() {
                state.0.close_all();
            }
            if let Some(state) = handle.try_state::<ChatState>() {
                state.0.cancel_all();
            }
            // Kill headless CLI chat processes (claude stream-json sessions).
            if let Some(state) = handle.try_state::<agent_sessions::AgentSessionState>() {
                state.0.kill_all();
            }
            // Kill one-shot automation CLI trees too — they aren't in the
            // session registry (M13); children that already exited are
            // skipped so a recycled pid is never hit.
            agent_sessions::kill_one_shot_children();
            // Stop any running local-model sidecars (llama-server processes).
            if let Some(state) = handle.try_state::<chat::local_models::LocalModelState>() {
                // B8: bound the block_on — stop_all awaits child.wait(), and
                // an unresponsive llama-server (stuck driver, zombie pipe)
                // would otherwise hang app shutdown indefinitely. kill() is
                // issued inside stop_all before the wait, so on timeout the
                // termination request was already delivered; we just stop
                // waiting for the confirmation.
                tauri::async_runtime::block_on(async {
                    if tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        state.0.stop_all(),
                    )
                    .await
                    .is_err()
                    {
                        eprintln!("[conduit] llama-server stop_all timed out after 3s; exiting anyway (kill already delivered)");
                    }
                });
            }
            // Stop the mobile relay server.
            if let Some(state) = handle.try_state::<MobileRelayState>() {
                mobile::relay::stop_relay(&state.0);
            }
            // Abort the browser MCP server task (mi20).
            if let Some(state) = handle.try_state::<BrowserMcpHandle>() {
                if let Some(h) = state.0.lock().take() {
                    h.abort();
                }
            }
        }
    });
}
