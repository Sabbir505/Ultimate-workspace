//! Relay backend entry point (Tauri v2).
//!
//! Wires up: plugins (dialog, notification, fs, opener), shared state (SQLite +
//! PtyManager), native window vibrancy (PRD §7.1), all CONTRACT.md commands,
//! and — critically — child-process cleanup on app exit (PRD §8: no orphaned
//! agent processes after the app closes).

// CLIPPY ADOPTION (2026-09-19): `cargo clippy --workspace --all-targets
// -- -D warnings` is a CI gate (.github/workflows/ci.yml). Clippy had never
// been run on this codebase, so the 766 pre-existing instances (79 lint kinds,
// counts captured on 2026-09-19, rustc 1.97.1) are allowed at the crate root
// instead of being mass-fixed into unrelated diffs. House rules for this list:
//   * DELETE an entry once its debt is fixed — never grow it.
//   * New lint kinds (not listed here) fail CI immediately.
//   * `unknown_lints` guards against lint renames across toolchain updates.
#![allow(unknown_lints)]
#![allow(dead_code)] // 91
#![allow(clippy::needless_borrow)] // 84
#![allow(clippy::too_many_arguments)] // 68
#![allow(clippy::doc_lazy_continuation)] // 42
#![allow(clippy::redundant_closure)] // 32
#![allow(clippy::type_complexity)] // 30
#![allow(clippy::unnecessary_map_or)] // 30
#![allow(clippy::useless_format)] // 23
#![allow(clippy::empty_line_after_doc_comments)] // 20
#![allow(clippy::redundant_field_names)] // 16
#![allow(unused_imports)] // 16
#![allow(unused_variables)] // 14
#![allow(clippy::clone_on_copy)] // 14
#![allow(clippy::needless_option_as_deref)] // 13
#![allow(clippy::manual_pattern_char_comparison)] // 12
#![allow(clippy::cloned_ref_to_slice_refs)] // 12
#![allow(unused_assignments)] // 10
#![allow(clippy::unnecessary_lazy_evaluations)] // 10
#![allow(clippy::derivable_impls)] // 10
#![allow(clippy::manual_contains)] // 9
#![allow(clippy::map_identity)] // 8
#![allow(clippy::manual_div_ceil)] // 8
#![allow(clippy::question_mark)] // 8
#![allow(clippy::needless_borrows_for_generic_args)] // 7
#![allow(clippy::let_underscore_future)] // 7
#![allow(clippy::collapsible_match)] // 6
#![allow(clippy::let_unit_value)] // 6
#![allow(clippy::ptr_arg)] // 6
#![allow(clippy::manual_repeat_n)] // 6
#![allow(clippy::collapsible_if)] // 6
#![allow(clippy::blocks_in_conditions)] // 6
#![allow(clippy::for_kv_map)] // 6
#![allow(clippy::needless_question_mark)] // 6
#![allow(clippy::unnecessary_sort_by)] // 6
#![allow(clippy::drop_non_drop)] // 6
#![allow(clippy::manual_range_patterns)] // 6
#![allow(clippy::items_after_test_module)] // 5
#![allow(clippy::needless_as_bytes)] // 4
#![allow(clippy::unnecessary_filter_map)] // 4
#![allow(clippy::to_string_in_format_args)] // 4
#![allow(clippy::io_other_error)] // 4
#![allow(clippy::unnecessary_cast)] // 4
#![allow(clippy::option_map_unit_fn)] // 4
#![allow(clippy::manual_clamp)] // 4
#![allow(clippy::single_match)] // 4
#![allow(clippy::redundant_guards)] // 4
#![allow(non_snake_case)] // 4
#![allow(clippy::if_same_then_else)] // 3
#![allow(clippy::field_reassign_with_default)] // 3
#![allow(unused_labels)] // 2
#![allow(clippy::needless_return)] // 2
#![allow(clippy::unnecessary_to_owned)] // 2
#![allow(clippy::needless_range_loop)] // 2
#![allow(clippy::new_without_default)] // 2
#![allow(clippy::unnecessary_unwrap)] // 2
#![allow(clippy::len_zero)] // 2
#![allow(clippy::op_ref)] // 2
#![allow(clippy::collapsible_str_replace)] // 2
#![allow(clippy::let_and_return)] // 2
#![allow(clippy::useless_borrows_in_formatting)] // 2
#![allow(clippy::single_char_add_str)] // 2
#![allow(clippy::bind_instead_of_map)] // 2
#![allow(clippy::explicit_auto_deref)] // 2
#![allow(clippy::match_like_matches_macro)] // 2
#![allow(clippy::manual_map)] // 2
#![allow(clippy::iter_cloned_collect)] // 2
#![allow(clippy::byte_char_slices)] // 2
#![allow(clippy::double_ended_iterator_last)] // 2
#![allow(clippy::needless_lifetimes)] // 2
#![allow(clippy::vec_init_then_push)] // 2
#![allow(clippy::filter_next)] // 2
#![allow(clippy::inherent_to_string)] // 2
#![allow(clippy::obfuscated_if_else)] // 2
#![allow(clippy::bool_comparison)] // 2
#![allow(unused_mut)] // 1
#![allow(clippy::bool_assert_comparison)] // 1
#![allow(clippy::useless_conversion)] // 1
#![allow(clippy::err_expect)] // 1
#![allow(clippy::manual_is_multiple_of)] // 1

mod app_ui;
mod browser;
mod browser_js;
mod browser_mcp;
mod browser_mcp_register;
mod checkpoints;
pub mod agent_sessions;
mod acp;
mod acp_agents;
mod automation_task;
pub mod automations;
pub mod automation_templates;
pub mod automation_triggers;
pub mod automation_webhook;
pub mod artifacts;
mod chat;
mod commands;
mod connectors;
pub mod db;
mod download;
mod docs_index;
mod docs_watcher;
mod sidecar_sweep;
mod exec_gate;
pub mod wiki;
mod skills_gallery;
mod git;
mod github;
mod git_watcher;
mod harness_adapters;
mod harness_bundle;
mod harness_config;
mod harness_subagent_watch;
mod hooks;
mod improve_engine;
mod installed_skills;
pub mod llm_log;
pub mod memory;
mod mcp_gallery;
mod mcp_tools_bridge;
// The browser-mcp bin's static-fallback parity test pins its tools/list copy
// against this allowlist (test-build only — the shipped bin stays lib-free).
pub use mcp_tools_bridge::ALLOWED_RELAY_TOOLS;
mod mobile;
// OS toasts under the app's own identity (Windows) — see the module doc.
mod os_toast;
mod pricing_live;
mod pty;
mod secrets;
mod session_fabric;
mod types;
pub mod agents_md;
pub mod prompt_firewall;
pub mod user_dirs;
pub mod vault;
mod util;

use std::fs;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::Manager;

use pty::PtyManager;

/// Shared SQLite connection. One connection behind a mutex: rusqlite
/// connections are !Sync, and Relay's write volume is tiny.
///
/// RULE: the lock guards SQL ONLY. Never hold it across file IO, subprocesses,
/// zip compression, or HTTP — collect the data under the lock, release, then
/// do the slow work (see export.rs / git_cmds.rs / sessions.rs for the
/// pattern). The one deliberate exception is `swap_chat_db_files`
/// (commands/data.rs), whose single hold is the documented atomicity
/// mechanism for the WAL-checkpoint-and-copy.
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
    // Migrate the pre-rebrand app data dir (dev.conduit.app → dev.relay.app)
    // BEFORE Tauri creates windows/webviews, so the WebView2 profile and the
    // DB land in the same (new) location on first launch of this build.
    let _ = user_dirs::app_data_dir_default();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // User hooks — lifecycle observers (Settings → Hooks). Fired from
            // the global turn-finalization events so EVERY engine (built-in
            // loop, harness headless, ACP, mobile-dispatched turns) gets
            // turn_complete without touching each emit site. Detached and
            // pre-trusted by design — see hooks::lifecycle_detached.
            {
                use tauri::Listener;
                let handle = app.handle().clone();
                app.listen("chat:done", move |event| {
                    let sid = serde_json::from_str::<serde_json::Value>(event.payload())
                        .ok()
                        .and_then(|v| {
                            v.get("chatSessionId")
                                .and_then(|s| s.as_str())
                                .map(str::to_string)
                        });
                    if let Some(sid) = sid {
                        crate::hooks::lifecycle_detached(
                            &handle,
                            crate::hooks::HookEvent::TurnComplete,
                            &sid,
                            "done",
                            "",
                        );
                    }
                });
                let handle = app.handle().clone();
                app.listen("chat:error", move |event| {
                    let parsed = serde_json::from_str::<serde_json::Value>(event.payload()).ok();
                    if let Some(v) = parsed {
                        let sid = v
                            .get("chatSessionId")
                            .and_then(|s| s.as_str())
                            .map(str::to_string);
                        let msg = v
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string();
                        if let Some(sid) = sid {
                            crate::hooks::lifecycle_detached(
                                &handle,
                                crate::hooks::HookEvent::TurnComplete,
                                &sid,
                                "error",
                                &msg,
                            );
                        }
                    }
                });
            }
            // Chat DB location: `storage.dbDir` (Settings → Data) when set,
            // else the default `<app data dir>/relay.db`. The setting is
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
            // Exec-gate approvals (§4.1.4): drop legacy plain-"1" rows so a
            // DB writer can no longer pre-allow execution by writing one.
            // One pass per boot; valid seals survive untouched.
            exec_gate::migrate_legacy(&shared_db.lock());
            // Checkpoint pruning (§5.16): enforce checkpoints.max_per_session
            // across every session and drop rows older than
            // checkpoints.max_age_days (when set). Git ref deletion runs on a
            // detached thread (see boot_prune).
            checkpoints::boot_prune(&shared_db.lock());
            // Bundled loops (§4.4.10): materialize the packaged Relay-native
            // loop definitions into ~/.agents/loops exactly once per machine
            // so the Skills Library's Loops tab is never empty on a fresh
            // install. Tombstoned — user deletions and edits stick.
            installed_skills::materialize_bundled_loops(&shared_db.lock());
            // Orphaned sidecar sweep: kill llama-server / whisper-server /
            // sd-server processes managed by a PREVIOUS instance (parent
            // dead) before this instance starts any sidecar of its own. A
            // dev restart (Ctrl+C) or crash skips the graceful-exit cleanup,
            // and each orphan holds a CUDA context + model memory forever.
            // The live embedding/STT/image sidecars of THIS instance (or a
            // concurrently running second instance) have a live parent and
            // are spared.
            {
                let bin_root = user_dirs::app_data_dir_default().join("bin");
                if bin_root.is_dir() {
                    match bin_root.canonicalize() {
                        Ok(canon) => {
                            let killed = sidecar_sweep::sweep(&canon);
                            if killed > 0 {
                                eprintln!("[relay] sidecar sweep: reaped {killed} orphaned sidecar(s) at boot");
                            }
                        }
                        Err(e) => eprintln!("[relay] sidecar sweep skipped (canonicalize failed): {e}"),
                    }
                }
            }
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
            // Pre-create the hidden HTML→PDF print window on the main thread
            // (setup runs there), so document generation never has to build a
            // window from an async worker. Failure is non-fatal — the PDF
            // tool falls back to the Python engine with a hint.
            #[cfg(windows)]
            if let Err(e) = chat::pdfprint::ensure_print_window(app.handle()) {
                eprintln!("[relay] hidden PDF print window unavailable: {e}");
            }
            // Subagent run-history boot sweep: the live-run registry and the
            // release watchers are per-process, so a `running` row from a
            // previous process is a crash leftover. Only rows older than the
            // watchers' own release ceiling settle — a younger one may belong
            // to a concurrently running second instance.
            {
                let conn = shared_db.lock();
                crate::db::sweep_stale_subagent_runs(&conn, crate::chat::subagents::STALE_RUNNING_SECS);
                // Same for AUTOMATION runs: an app close mid-run (runs last
                // up to 2h) left the row `running` forever — a phantom
                // in-progress entry in Past Runs (audit H23).
                crate::db::automations::sweep_stale_automation_runs(
                    &conn,
                    crate::automations::STALE_RUNNING_SECS,
                );
            }
            app.manage(DbState(Arc::clone(&shared_db)));
            app.manage(PtyState(PtyManager::new(app.handle().clone(), Arc::clone(&shared_db))));
            app.manage(BrowserState(Arc::new(browser::BrowserManager::new(
                app.handle().clone(),
            ))));
            app.manage(ChatState(Arc::new(chat::ChatManager::new())));
            app.manage(agent_sessions::AgentSessionState(Arc::new(
                agent_sessions::AgentSessionManager::new(),
            )));
            // Session Mesh runtime (mailbox pumps + parked question calls).
            app.manage(session_fabric::FabricState(Arc::new(
                session_fabric::FabricRuntime::default(),
            )));
            app.manage(TaskState(Arc::new(chat::tasks::TaskManager::new())));
            app.manage(chat::plan::PlanState::default());
            // Pending self-UI requests awaiting the renderer's reply. Empty by
            // construction at startup: a request only lives between a tool call
            // and the bridge answering it (or its timeout).
            app.manage(app_ui::SelfUiPending::default());
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
            // Speech-to-text: curated whisper.cpp models + the whisper-server
            // sidecar (Settings → Knowledge manages it; the composer mic uses
            // it for transcription).
            app.manage(commands::stt::SttState::default());
            // Local image generation: stable-diffusion.cpp's sd-server sidecar
            // + the GGUF model catalog (Settings → Local Models → Images).
            app.manage(commands::image_gen::ImageGenState::default());
            // Orphan sweep: an sd-server child of a FORCE-killed previous
            // instance (task manager / taskkill /F skips the graceful exit
            // cleanup) holds VRAM and its port forever. Scope the kill to OUR
            // sidecar via the PID file written at spawn — a name-wide
            // `taskkill /IM` would also murder an sd-server the user started
            // themselves or another app instance's live render.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt as _;
                let pid_file = user_dirs::app_data_dir(app.handle()).join("sd-server.pid");
                if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                    let pid = pid.trim();
                    if !pid.is_empty()
                        // PID reuse guard: only kill when that exact PID is
                        // still an sd-server.exe (tasklist CSV line 2).
                        && std::process::Command::new("tasklist")
                            .args(["/FI", &format!("PID eq {pid}")])
                            .creation_flags(0x0800_0000)
                            .output()
                            .map(|o| String::from_utf8_lossy(&o.stdout).contains("sd-server.exe"))
                            .unwrap_or(false)
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", pid, "/F"])
                            .creation_flags(0x0800_0000)
                            .output();
                    }
                    let _ = std::fs::remove_file(&pid_file);
                }
            }
            // Text-to-speech: Kokoro-82M runs in-process (no sidecar to reap) —
            // the state holds the loaded ONNX session, dropped on model switch
            // and on app exit.
            app.manage(commands::tts::TtsState::default());
            app.manage(std::sync::Arc::new(docs_index::IndexRegistry::default()));
            // Project wiki (§6.15): per-project build/update job slots.
            app.manage(std::sync::Arc::new(wiki::WikiJobRegistry::default()));
            // Git filesystem watcher — drives the `project:fs-changed` Tauri
            // event that replaces the 4-8s polling loops in
            // `useGitStatusPolling` / `DevDiffPanel` / `BranchDropdown`. See
            // src-tauri/src/git_watcher.rs for the design.
            app.manage(git_watcher::WatcherState::new());
            // Knowledge corpus watcher (§5.25): file changes inside an enabled
            // corpus folder re-run the incremental index without a manual
            // Index press. Same deferred slot as the git watcher below.
            app.manage(docs_watcher::DocsWatcherState::new());
            // Vault (local markdown knowledge base): root + fs watcher. The
            // index lives in the shared SQLite; the root re-binds lazily from
            // the DB setting (vault::current_root) so no boot hook is needed.
            app.manage(vault::VaultState::new());
            // MCP gallery: live stdio MCP server children (§3.2.14). Killed
            // on app exit via mcp_gallery::kill_all in the RunEvent handler.
            app.manage(mcp_gallery::McpGalleryState::default());
            {
                let app_handle = app.handle().clone();
                let db_state = DbState(Arc::clone(&shared_db));
                // Defer watcher install slightly so the rest of the setup
                // (PTY manager, etc.) finishes first — we don't want
                // watcher events to fire before the frontend is listening.
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    git_watcher::install_all_known(&app_handle, &db_state);
                    // Automation file triggers (automation_triggers.rs): one
                    // notify watcher per distinct trigger_config.path of every
                    // enabled `file` automation. Same deferred slot as the git
                    // watcher — same reasons.
                    automation_triggers::sync_fs_watchers(&app_handle, &db_state.0);
                    // Same deferred slot: corpus watchers need the frontend
                    // listening for `docs:index:progress` before they fire.
                    docs_watcher::install_all_enabled(&app_handle, &db_state);
                });
            }
            // Project wiki freshness task (§6.15): re-checks every wiki's
            // HEAD each minute and runs the update pass when it moved (no-op
            // costs one git rev-parse; the model is only called for pages
            // whose cited evidence changed).
            wiki::spawn_freshness_task(app.handle().clone());
            // CLI harnesses' native subagent stores (`~/.claude/agents/*.md`):
            // watch the user-level dirs, then start reacting to the change
            // events so an agent a harness authors — or a prompt a human edits
            // in a terminal — reaches the registry without the user opening
            // the Subagents panel. Same deferred slot as the git watcher: the
            // event bus needs the window up before anything listens.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn({
                    let app_handle = app_handle.clone();
                    async move {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        harness_subagent_watch::install_store_watchers(&app_handle);
                    }
                });
                harness_subagent_watch::listen(&app_handle);
            }
            // STT auto-start (Settings → Knowledge opt-in): same deferred
            // pattern — the sidecar spawns once the managed states exist.
            {
                let app_handle = app.handle().clone();
                let db_state = DbState(Arc::clone(&shared_db));
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    commands::stt::maybe_autostart(&app_handle, &db_state);
                    // Read-aloud: load the voice model up front when the user
                    // chose "keep loaded" (otherwise the first play pays for it).
                    commands::tts::maybe_preload(&app_handle, &db_state);
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
            // relay-browser-mcp binary connects to (agent-driven browser
            // control). Binds an OS-assigned ephemeral port (published via
            // browser_mcp::bound_port + a handshake file, so registration and
            // third-party clients always find it). Bind failure is non-fatal:
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
            // headless one-shot agent turns (see automations.rs). The tick
            // also evaluates git triggers (automation_triggers.rs).
            automations::start(app.handle().clone(), Arc::clone(&shared_db));

            // Inbound webhook trigger listener (automation_webhook.rs):
            // loopback HTTP on an ephemeral port; GET/POST
            // /trigger/<id>/<secret> fires the automation (app-open only).
            // Bind failure is non-fatal — webhook triggers just don't answer.
            {
                let app_handle = app.handle().clone();
                let db = Arc::clone(&shared_db);
                // Tracked for the exit handler (same pattern as mi20):
                // aborting the task closes the accept loop + its listener.
                let handle = tauri::async_runtime::spawn(async move {
                    automation_webhook::serve(app_handle, db).await;
                });
                app.manage(automation_webhook::WebhookServerHandle(Mutex::new(
                    Some(handle),
                )));
            }

            // Local-model request log + loopback gateway (src/llm_log/).
            // Other apps point their base_url at the gateway so their traffic
            // is captured too; Relay's own calls are captured in-process at the
            // provider builders. Bind failure is non-fatal — logging stops, the
            // app does not.
            {
                let app_handle = app.handle().clone();
                // Its own connection, not `shared_db`. The gateway runs an
                // async accept loop and needs a tokio mutex (a parking_lot
                // guard is !Send, so it can't cross an await); opening a
                // second handle to the same file is what WAL mode is for, and
                // it keeps the gateway off the hot path's lock.
                let gw_conn = db::open(&db_path).ok();
                let handle = gw_conn.map(|c| {
                    let db = Arc::new(tokio::sync::Mutex::new(c));
                    tauri::async_runtime::spawn(async move {
                        llm_log::gateway::serve(app_handle, db).await;
                    })
                });
                if let Some(h) = handle {
                    app.manage(llm_log::gateway::GatewayHandle(Mutex::new(Some(h))));
                }
            }

            // Retention prune. Hourly rather than per-request so a chatty
            // local model never pays a DELETE on the hot path.
            {
                let db_state = DbState(Arc::clone(&shared_db));
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
                        let conn = db_state.0.lock();
                        let cfg = llm_log::LogConfig::load(&conn);
                        if cfg.enabled {
                            llm_log::prune(&conn, &cfg);
                        }
                    }
                });
            }

            // Budget alert timer (commands/budget.rs): the frontend re-checks
            // after cost events, but a backend cadence keeps threshold alerts
            // firing when no chat window is open to drive the IPC call.
            // Advisory-only: alerts never abort a running turn.
            {
                let app_handle = app.handle().clone();
                let db_state = DbState(Arc::clone(&shared_db));
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3 * 60)).await;
                    loop {
                        commands::budget::run_budget_checks(
                            app_handle.clone(),
                            Arc::clone(&db_state.0),
                        )
                        .await;
                        tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                    }
                });
            }

            // Live model pricing (pricing_live.rs): auto-fetch the LiteLLM
            // community registry ~60s after boot, then daily, so the rate
            // table tracks new model releases without a settings visit.
            // Failure keeps the previous blob and only logs — stale rates
            // beat no rates (see refresh_prices).
            {
                let db_state = DbState(Arc::clone(&shared_db));
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    loop {
                        let client = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(30))
                            .user_agent("relay-desktop")
                            .build();
                        match client {
                            Ok(client) => {
                                if let Err(e) = crate::pricing_live::refresh_prices(
                                    client,
                                    Arc::clone(&db_state.0),
                                )
                                .await
                                {
                                    eprintln!("[relay] live price refresh failed: {e}");
                                }
                            }
                            Err(e) => {
                                eprintln!("[relay] live price http client unavailable: {e}")
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
                    }
                });
            }

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
        // MAIN-THREAD RULE (read before adding a command): a `#[tauri::command]`
        // that is NOT `async` runs INLINE on the IPC thread — which is the UI
        // thread. Every command here takes the single shared `DbState` mutex
        // (and many shell out to git, walk directories, or exec a subprocess), so
        // a non-async command turns any contention or slow work into a frozen
        // window that Windows reports as "not responding". Two ways to stay off
        // it, both invisible to the frontend (invoke always returns a promise):
        //   * `#[tauri::command(async)]` on a plain `fn` — runs the body on the
        //     async thread pool, body unchanged. Right answer for DB-only work.
        //   * `async fn` + `tokio::task::spawn_blocking` for the blocking part —
        //     right answer for subprocess/file/network work.
        // Note `State<..>` args must be written `State<'_, ..>` either way.
.invoke_handler(tauri::generate_handler![
            // Relay self-control: the injected self-UI bridge reports each
            // result here, resolving the pending request for the tool call
            // that asked for it. `async` so it never runs on the UI thread.
            app_ui::app_ui_result,
            // OS toast under the app identity (Windows; dev runs only —
            // installed builds get it from the plugin's own AUMID path).
            os_toast::os_toast,
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
            commands::pty_cmds::check_harness_updates,
            commands::pty_cmds::install_harness,
            commands::pty_cmds::run_harness_login,
            commands::pty_cmds::pty_subscribe,
            // native browser panes (child webviews)
            commands::browser_cmds::browser_create,
            commands::browser_cmds::browser_navigate,
            commands::browser_cmds::browser_open_devtools,
            commands::browser_cmds::browser_push_state,
            commands::browser_cmds::browser_report_title,
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
            commands::browser_cmds::browser_tab_result,
            commands::browser_cmds::browser_confirm_result,
            commands::browser_cmds::browser_set_agent_paused,
            commands::browser_cmds::browser_cancel_agent,
            commands::browser_cmds::browser_timeline,
            commands::browser_cmds::browser_clear_site_data,
            // git
            github::github_list_prs,
            github::github_create_pr,
            github::github_get_pr,
            github::github_pr_files,
            github::github_submit_review,
            github::github_pr_checks,
            github::github_draft_pr_text,
            github::github_local_branches,
            // github issues + PAT fallback (§4.4.6)
            github::github_list_issues,
            github::github_get_issue,
            github::github_create_issue,
            github::github_add_issue_comment,
            github::github_set_issue_state,
            github::github_list_issue_comments,
            github::github_set_pat,
            github::github_clear_pat,
            github::github_has_pat,
            // user hooks (Settings → Hooks; config rides get/set_setting)
            commands::hooks_cmds::hooks_test,
            commands::hooks_cmds::hooks_import_claude,
            commands::git_cmds::get_git_status,
            commands::git_cmds::get_changed_files,
            commands::git_cmds::create_worktree,
            commands::git_cmds::get_git_diff,
            commands::git_cmds::get_git_file_diff,
            commands::git_cmds::get_git_file_diff_scoped,
            commands::git_cmds::get_branch_changed_files,
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
            commands::automation_cmds::list_automation_templates,
            commands::automation_cmds::list_automations,
            commands::automation_cmds::create_automation,
            commands::automation_cmds::update_automation,
            commands::automation_cmds::delete_automation,
            commands::automation_cmds::set_automation_enabled,
            commands::automation_cmds::run_automation_now,
            commands::automation_cmds::stop_automation_run,
            commands::appearance_cmds::import_sidebar_art,
            commands::appearance_cmds::set_sidebar_art_preset,
            commands::appearance_cmds::read_sidebar_art_data,
            commands::appearance_cmds::clear_sidebar_art,
            commands::appearance_cmds::get_sidebar_art_path,
            commands::appearance_cmds::import_app_wallpaper,
            commands::appearance_cmds::set_app_wallpaper_preset,
            commands::appearance_cmds::read_app_wallpaper_data,
            commands::appearance_cmds::clear_app_wallpaper,
            automation_task::get_run_while_closed,
            automation_task::set_run_while_closed,
            automation_task::test_automation_webhook,
            commands::automation_cmds::list_automation_runs,
            commands::automation_cmds::count_automation_runs,
            commands::automation_cmds::automation_next_fire,
            commands::automation_cmds::automation_webhook_info,
            // subagents (declarative subagents) — CRUD over the persisted
            // agent registry. The 7 builtin roles are seeded rows and are
            // returned with the list; run/export/import land with the spawn
            // phases.
            commands::subagent_cmds::list_subagents,
            commands::subagent_cmds::get_subagent,
            commands::subagent_cmds::create_subagent,
            commands::subagent_cmds::update_subagent,
            commands::subagent_cmds::delete_subagent,
            commands::subagent_cmds::run_subagent,
            commands::subagent_cmds::export_subagents,
            commands::subagent_cmds::import_subagent,
            commands::subagent_cmds::import_harness_subagent,
            commands::subagent_cmds::sync_harness_subagents,
            commands::subagent_cmds::unlink_native_subagent,
            commands::subagent_cmds::list_subagent_runs,
            // artifact generation (conversational creation)
            commands::artifact_cmds::generate_artifact_cmd,
            commands::artifact_cmds::validate_artifact_cmd,
            commands::artifact_cmds::create_artifact_cmd,
            commands::artifact_cmds::regenerate_artifact_cmd,
            commands::artifact_cmds::save_artifact_cmd,
            commands::artifact_cmds::search_artifacts_cmd,
            commands::artifact_cmds::update_artifact_cmd,
            commands::artifact_cmds::get_artifact_context_cmd,
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
            commands::pricing_cmds::prices_refresh_now,
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
            commands::skills_cmds::install_skill_from_url,
            skills_gallery::list_skill_gallery,
            skills_gallery::verify_skill_gallery_entry,
            commands::skills_cmds::delete_installed_skill,
            commands::skills_cmds::make_installed_global,
            commands::skills_cmds::list_chat_skills,
            // chat mode
            commands::chat_cmds::list_chat_sessions,
            commands::chat_cmds::persist_chat_command_message,
            commands::chat_cmds::search_chat_messages,
            commands::chat_cmds::list_chat_checkpoints,
            commands::chat_cmds::restore_chat_checkpoint,
            commands::chat_cmds::create_chat_session,
            commands::chat_cmds::fork_chat_session,
            commands::chat_cmds::delete_chat_session,
            commands::chat_cmds::delete_all_chat_sessions,
            commands::chat_cmds::delete_empty_chat_sessions,
            commands::chat_cmds::delete_chat_message,
            commands::chat_cmds::supersede_chat_tail,
            commands::chat_cmds::update_chat_session_title,
            commands::chat_cmds::generate_chat_title,
            commands::chat_cmds::generate_commit_message,
            commands::chat_cmds::generate_diff_review,
            commands::chat_cmds::set_chat_session_starred,
            commands::chat_cmds::set_chat_session_unread,
            commands::chat_cmds::update_chat_session_model,
            commands::chat_cmds::update_chat_session_effort,
            commands::chat_cmds::update_chat_session_provider,
            commands::chat_cmds::update_chat_session_watch_mode,
            commands::chat_cmds::update_chat_session_policies,
            commands::chat_cmds::update_chat_session_agent,
            commands::chat_cmds::set_chat_session_auto,
            commands::chat_cmds::set_chat_session_project,
            commands::chat_cmds::set_chat_session_cwd,
            commands::chat_cmds::get_chat_messages,
            commands::chat_cmds::get_chat_session_metrics,
            commands::chat_cmds::touch_chat_session,
            commands::chat_cmds::send_chat_message,
            commands::chat_cmds::cancel_chat_message,
            commands::chat_cmds::persist_partial_chat_message,
            commands::agent_cmds::send_agent_chat_message,
            commands::agent_cmds::cancel_agent_chat_message,
            commands::agent_cmds::reconcile_agent_sessions,
            commands::agent_cmds::list_harness_models,
            commands::agent_cmds::list_harness_subagents,
            commands::agent_cmds::list_acp_agents,
            commands::agent_cmds::chat_token_subscribe,
            commands::chat_cmds::resolve_tool_action,
            commands::chat_cmds::resolve_plan_proposal,
            commands::chat_cmds::resolve_agent_question,
            commands::chat_cmds::get_agent_actual_model,
            commands::chat_cmds::set_chat_session_plan_mode,
            commands::chat_cmds::set_chat_session_permission_mode,
            commands::chat_cmds::set_chat_api_key,
            commands::chat_cmds::delete_chat_api_key,
            commands::chat_cmds::set_search_api_key,
            commands::chat_cmds::has_search_api_key,
            commands::chat_cmds::delete_search_api_key,
            commands::chat_cmds::set_chat_default_model,
            commands::chat_cmds::get_chat_config,
            commands::chat_cmds::list_chat_instances,
            commands::chat_cmds::list_chat_models,
            commands::chat_cmds::read_artifact_preview,
            commands::chat_cmds::is_libreoffice_available,
            commands::chat_cmds::office_accurate_pdf,
            commands::chat_cmds::docgen_complete,
            commands::chat_cmds::docdesign_complete,
            commands::chat_cmds::docdesign_qa_complete,
            commands::chat_cmds::get_file_mtime,
            commands::chat_cmds::find_file_by_basename,
            commands::chat_cmds::open_artifact_external,
            commands::chat_cmds::download_artifact,
            commands::chat_cmds::download_artifacts_zip,
            commands::chat_cmds::list_artifacts,
            commands::chat_cmds::list_chat_artifacts,
            commands::chat_cmds::delete_artifact,
            commands::chat_cmds::delete_all_artifacts,
            // local models (GGUF scan / llama-server sidecar)
            commands::chat_cmds::scan_local_models,
            commands::chat_cmds::start_local_model,
            commands::chat_cmds::warmup_local_prompt,
            commands::chat_cmds::stop_local_model,
            commands::chat_cmds::local_model_status,
            commands::chat_cmds::get_llama_server_path,
            commands::chat_cmds::set_llama_server_path,
            commands::chat_cmds::detect_llama_server_path,
            commands::chat_cmds::count_context_tokens,
            commands::chat_cmds::count_context_breakdown,
            llm_log::commands::llm_log_list,
            llm_log::commands::llm_log_get,
            llm_log::commands::llm_log_clear,
            llm_log::commands::llm_log_stats,
            llm_log::commands::llm_log_prune,
            llm_log::commands::llm_log_config_get,
            llm_log::commands::llm_log_config_set,
            llm_log::commands::gateway_status,
            llm_log::commands::gateway_set_require_auth,
            llm_log::commands::gateway_set_default_target,
            llm_log::commands::gateway_set_targets,
            llm_log::commands::gateway_probe,
            commands::chat_cmds::chat_compact_now,
            commands::chat_cmds::list_compacted_messages,
            commands::chat_cmds::research_citation_report,
            commands::chat_cmds::fetch_provider_model_windows,
            commands::chat_cmds::set_selected_models,
            // connectors (OAuth + remote MCP): Settings → Connectors + per-chat attach
            commands::connectors_cmds::list_connectors,
            commands::connectors_cmds::connector_connect,
            commands::connectors_cmds::connector_connect_family,
            commands::connectors_cmds::connector_disconnect,
            commands::connectors_cmds::set_session_connectors,
            commands::connectors_cmds::list_session_connectors,
            commands::connectors_cmds::add_session_connector,
            commands::connectors_cmds::remove_session_connector,
            // auto-updater (Tauri updater plugin)
            commands::updater_cmds::check_for_update,
            commands::updater_cmds::download_and_install_update,
            // mobile relay
            mobile::commands::start_mobile_relay,
            mobile::commands::regen_mobile_pairing_token,
            mobile::commands::stop_mobile_relay,
            mobile::commands::get_mobile_relay_status,
            mobile::commands::get_mobile_pairing_info,
            mobile::commands::tailscale_serve_enable,
            mobile::commands::tailscale_serve_disable,
            mobile::commands::tailscale_login,
            // local model market (Hugging Face browse + download)
            commands::local_model_market::fetch_model_catalog,
            commands::local_model_market::fetch_model_file_sizes,
            commands::local_model_market::get_gpu_vram,
            commands::local_model_market::detect_gpu_power,
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
            docs_index::docs_start_reranker,
            docs_index::docs_add_corpus,
            docs_index::docs_remove_corpus,
            docs_index::docs_list_corpora,
            wiki::commands::wiki_list_all,
            wiki::commands::wiki_get,
            wiki::commands::wiki_build_start,
            wiki::commands::wiki_cancel,
            wiki::commands::wiki_update,
            wiki::commands::wiki_read_page,
            wiki::commands::wiki_remove,
            docs_index::docs_set_corpus_enabled,
            docs_index::docs_attach_corpus_to_chat,
            docs_index::docs_detach_corpus_from_chat,
            docs_index::docs_attached_corpus_ids,
            docs_index::docs_start_index,
            docs_index::docs_cancel_index,
            // Vault (local markdown knowledge base)
            vault::vault_get_state,
            vault::vault_bind,
            vault::vault_unbind,
            vault::vault_rescan,
            vault::vault_tree,
            vault::vault_read_note,
            vault::vault_read_binary,
            vault::vault_create_note,
            vault::vault_write_note,
            vault::vault_delete_note,
            vault::vault_move_file,
            vault::vault_import_file,
            vault::vault_write_binary,
            vault::vault_rename_note,
            vault::vault_create_folder,
            vault::vault_delete_folder,
            vault::vault_search,
            vault::vault_note_meta,
            vault::vault_graph,
            vault::vault_all_tags,
            vault::vault_stats,
            chat::export::export_chat_zip,
            chat::export::export_project_zip,
            chat::export::import_chat_zip,
            commands::budget::list_budgets,
            commands::budget::set_budget,
            commands::budget::remove_budget,
            commands::budget::check_budgets,
            commands::budget::list_hidden_cost_projects,
            commands::budget::hide_cost_project,
            commands::budget::unhide_cost_project,
            commands::improve_cmds::list_improve_artifacts,
            commands::improve_cmds::list_improve_versions,
            commands::improve_cmds::set_improve_channel,
            commands::improve_cmds::record_artifact_run,
            commands::improve_cmds::finish_artifact_runs,
            commands::improve_cmds::record_artifact_feedback,
            commands::improve_cmds::loop_session_start,
            commands::improve_cmds::loop_session_advance,
            commands::improve_cmds::loop_session_finish,
            commands::improve_cmds::get_loop_session,
            commands::improve_cmds::latest_loop_session,
            commands::improve_cmds::list_improvement_proposals,
            commands::improve_cmds::run_improvement_sweep,
            commands::improve_cmds::evaluate_improvement_proposal,
            commands::improve_cmds::apply_improvement_proposal,
            commands::improve_cmds::reject_improvement_proposal,
            commands::improve_cmds::list_improve_eval_cases,
            commands::improve_cmds::set_improve_case_quarantine,
            commands::improve_cmds::list_improve_pack_health,
            commands::improve_cmds::get_artifact_costs,
            commands::improve_cmds::set_improve_autonomy,
            commands::improve_cmds::get_improve_autonomy,
            commands::improve_cmds::check_improvement_canaries,
            commands::speech::transcribe_audio,
            commands::speech::transcribe_cancel,
            commands::stt::stt_status,
            commands::stt::stt_start,
            commands::stt::stt_stop,
            commands::stt::stt_install_server,
            commands::stt::stt_install_cuda,
            commands::stt::stt_set_default,
            commands::stt::stt_set_auto_start,
            commands::stt::stt_set_server_path,
            commands::stt::stt_set_device,
            // Local image generation (stable-diffusion.cpp sd-server sidecar).
            commands::image_gen::image_gen_status,
            commands::image_gen::image_gen_start,
            commands::image_gen::image_gen_stop,
            commands::image_gen::image_gen_install,
            commands::image_gen::image_gen_set_default,
            commands::image_gen::image_gen_set_file_role,
            commands::image_gen::image_gen_set_file_layout,
            commands::image_gen::image_gen_select,
            commands::image_gen::image_gen_use_family,
            commands::image_gen::image_gen_family_plans,
            commands::image_gen::image_gen_set_device,
            commands::image_gen::image_gen_set_server_path,
            commands::image_gen::image_generate,
            // Local text-to-speech (Kokoro-82M, in-process) — reads assistant
            // answers and text artifacts aloud.
            commands::tts::tts_status,
            commands::tts::tts_speak,
            commands::tts::tts_preload,
            commands::tts::tts_unload,
            commands::tts::tts_install_model,
            commands::tts::tts_set_model,
            commands::tts::tts_set_voice,
            commands::tts::tts_set_speed,
            commands::tts::tts_set_auto_read,
            commands::tts::tts_set_device,
            commands::tts::tts_set_keep_loaded,
            commands::tts_gpu::tts_gpu_status,
            commands::tts_gpu::tts_install_gpu,
            // Update checks for the pinned native builds (whisper CPU/CUDA,
            // llama CUDA server, TTS GPU runtime) — the harness-updater shape
            // for binaries.
            commands::build_updates::check_build_updates,
            commands::llama_build::llama_install_cuda,
            commands::worktree_cmds::ensure_chat_session_worktree,
            commands::worktree_cmds::set_chat_session_worktree,
            mcp_gallery::mcp_registry_search,
            mcp_gallery::mcp_registry_install,
            mcp_gallery::mcp_gallery_list,
            mcp_gallery::mcp_gallery_install,
            mcp_gallery::mcp_gallery_remove,
            mcp_gallery::mcp_gallery_set_enabled,
            mcp_gallery::mcp_gallery_connect,
            mcp_gallery::mcp_gallery_disconnect,
            // persistent user memory (MEMORY_DESIGN_ARCHITECTURE.md §12)
            commands::memory_cmds::memory_list,
            commands::memory_cmds::memory_update,
            commands::memory_cmds::memory_delete,
            commands::memory_cmds::memory_purge,
            commands::memory_cmds::memory_evidence,
            commands::memory_cmds::memory_export,
            commands::memory_cmds::memory_status,
            commands::memory_cmds::memory_set_enabled,
            commands::memory_cmds::memory_create,
            commands::memory_cmds::memory_set_document,
            commands::memory_cmds::memory_document_history,
            commands::memory_cmds::memory_recent_ops,
            commands::memory_cmds::memory_set_extract_model,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Relay");

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
            // Quit mid-stream: persist what the built-in turns had accumulated
            // (chat/partial_buf.rs) BEFORE cancel_all aborts the turn tasks —
            // the abort discards their buffers, and this is the only chance to
            // keep the partial text the user watched. Best-effort, bounded by
            // the per-session cap; harness sessions persist their own rows in
            // finish_turn and are not recorded there.
            let partials = chat::partial_buf::drain_all();
            if !partials.is_empty() {
                if let Some(db) = handle.try_state::<DbState>() {
                    let conn = db.0.lock();
                    for (sid, text) in partials {
                        chat::commands::persist_partial_row(&conn, &sid, &text);
                    }
                }
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
                        eprintln!("[relay] llama-server stop_all timed out after 3s; exiting anyway (kill already delivered)");
                    }
                });
            }
            // Kill the whisper-server sidecar too. Without this every app
            // quit orphans a whisper-server process holding a CUDA context —
            // with auto-start on, one leaks per app session and the GPU
            // slowly fills up with zombie contexts.
            if let Some(state) = handle.try_state::<commands::stt::SttState>() {
                tauri::async_runtime::block_on(async {
                    if tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        commands::stt::stop_sidecar(&state),
                    )
                    .await
                    .is_err()
                    {
                        eprintln!("[stt] sidecar kill timed out at exit; exiting anyway");
                    }
                });
            }
            // Kill the sd-server image sidecar too — same orphaned-CUDA-context
            // concern as the whisper sidecar (plus gigabytes of model memory).
            if let Some(state) = handle.try_state::<commands::image_gen::ImageGenState>() {
                tauri::async_runtime::block_on(async {
                    if tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        commands::image_gen::stop_sidecar(&state),
                    )
                    .await
                    .is_err()
                    {
                        eprintln!("[image-gen] sidecar kill timed out at exit; exiting anyway");
                    }
                });
            }
            // Drop the Kokoro TTS engine. Nothing is orphaned (synthesis is
            // in-process), but the ONNX session holds ~100 MB of weights plus
            // its arena; releasing it makes a fast restart cheap.
            if let Some(state) = handle.try_state::<commands::tts::TtsState>() {
                commands::tts::unload(&state);
            }
            // Stop the mobile relay server.
            if let Some(state) = handle.try_state::<MobileRelayState>() {
                mobile::relay::stop_relay(&state.0);
            }
            // Kill every live MCP-gallery stdio child (§3.2.14).
            mcp_gallery::kill_all(handle);
            // Abort the browser MCP server task (mi20).
            if let Some(state) = handle.try_state::<BrowserMcpHandle>() {
                if let Some(h) = state.0.lock().take() {
                    h.abort();
                }
            }
            // Abort the local-model gateway listener too — same
            // orphaned-accept-loop concern as the browser MCP server.
            if let Some(state) = handle.try_state::<llm_log::gateway::GatewayHandle>() {
                if let Some(h) = state.0.lock().take() {
                    h.abort();
                }
            }
            // Abort the automation webhook trigger listener too — same
            // orphaned-accept-loop concern as the browser MCP server.
            if let Some(state) = handle.try_state::<automation_webhook::WebhookServerHandle>() {
                if let Some(h) = state.0.lock().take() {
                    h.abort();
                }
            }
        }
    });
}
