//! Conduit backend entry point (Tauri v2).
//!
//! Wires up: plugins (dialog, notification, fs, opener), shared state (SQLite +
//! PtyManager), native window vibrancy (PRD §7.1), all CONTRACT.md commands,
//! and — critically — child-process cleanup on app exit (PRD §8: no orphaned
//! agent processes after the app closes).

mod browser;
mod chat;
mod commands;
mod db;
mod git;
mod harness_adapters;
mod installed_skills;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("no app data dir: {e}"))
            })?;
            fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("conduit.db"))?;
            let shared_db = Arc::new(Mutex::new(conn));
            app.manage(DbState(Arc::clone(&shared_db)));
            app.manage(PtyState(PtyManager::new(app.handle().clone(), shared_db)));
            app.manage(BrowserState(Arc::new(browser::BrowserManager::new(
                app.handle().clone(),
            ))));
            app.manage(ChatState(Arc::new(chat::ChatManager::new())));

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
            commands::pty_cmds::list_harnesses,
            commands::pty_cmds::run_harness_login,
            // native browser panes (child webviews)
            commands::browser_cmds::browser_create,
            commands::browser_cmds::browser_navigate,
            commands::browser_cmds::browser_push_state,
            commands::browser_cmds::browser_go_back,
            commands::browser_cmds::browser_go_forward,
            commands::browser_cmds::browser_reload,
            commands::browser_cmds::browser_set_bounds,
            commands::browser_cmds::browser_set_visible,
            commands::browser_cmds::browser_close,
            commands::browser_cmds::browser_close_pane,
            // git
            commands::git_cmds::get_git_status,
            commands::git_cmds::create_worktree,
            commands::git_cmds::get_git_diff,
            // settings / skills / quick actions / secrets / cost / misc
            commands::data::get_setting,
            commands::data::set_setting,
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
            // installed skills / loops (harness skill directories)
            commands::skills_cmds::list_installed_skills,
            commands::skills_cmds::list_installed_loops,
            commands::skills_cmds::read_installed_skill,
            commands::skills_cmds::save_installed_skill,
            commands::skills_cmds::create_installed_skill,
            commands::skills_cmds::delete_installed_skill,
            // chat mode
            commands::chat_cmds::list_chat_sessions,
            commands::chat_cmds::create_chat_session,
            commands::chat_cmds::delete_chat_session,
            commands::chat_cmds::update_chat_session_title,
            commands::chat_cmds::update_chat_session_model,
            commands::chat_cmds::get_chat_messages,
            commands::chat_cmds::touch_chat_session,
            commands::chat_cmds::send_chat_message,
            commands::chat_cmds::cancel_chat_message,
            commands::chat_cmds::set_chat_api_key,
            commands::chat_cmds::delete_chat_api_key,
            commands::chat_cmds::get_chat_config,
            commands::chat_cmds::list_chat_models,
            commands::chat_cmds::read_artifact_preview,
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
        }
    });
}
