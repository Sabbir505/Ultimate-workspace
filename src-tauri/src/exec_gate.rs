//! Native confirmation gate for renderer-initiated process execution.
//!
//! Three IPC surfaces execute whatever string the webview sends — `spawn_shell`
//! (a shell command line), MCP-gallery custom server installs (an arbitrary
//! command + args + env), and `set_llama_server_path` (an executable Relay will
//! spawn for local-model sessions). The code comments on those surfaces have
//! long said "callers are responsible for not letting untrusted model output
//! flow into this argument" — this module gives them a real gate instead:
//!
//! 1. The decision is remembered per identifying detail (working folder /
//!    command line / exe path) in the settings table, so a trusted setup asks
//!    exactly once.
//! 2. Unknown combos raise a NATIVE OS dialog — outside the webview, so a
//!    compromised renderer cannot answer it, style it away, or auto-click it.
//! 3. "Allow" remembers for that identifier; "Deny" refuses without recording
//!    anything (the next attempt asks again).
//!
//! Blocking-show rules: the dialog must never run on the main/UI thread, so
//! async callers go through [`confirm_remembered`] (spawn_blocking inside);
//! sync commands must first become `async` (see `spawn_shell`).

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::db;

/// Settings key for one remembered approval. `ident` may be long (a full
/// command line), so it is folded into a short stable hash — the
/// human-readable detail lives in the dialog, not in the key.
fn allow_key(kind: &str, ident: &str) -> String {
    let digest = Sha256::digest(format!("{kind}\u{0}{ident}").as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("exec.allow.{kind}.{hex}")
}

/// True when this kind/ident combo was already allowed (and remembered).
pub fn is_allowed(conn: &Connection, kind: &str, ident: &str) -> bool {
    matches!(
        db::get_setting(conn, &allow_key(kind, ident))
            .ok()
            .flatten()
            .as_deref(),
        Some("1")
    )
}

/// Record a standing approval for this kind/ident combo.
pub fn remember(conn: &Connection, kind: &str, ident: &str) {
    let _ = db::set_setting(conn, &allow_key(kind, ident), "1");
}

fn blocking_show(app: &AppHandle, title: &str, body: &str) -> bool {
    app.dialog()
        .message(body.to_string())
        .title(title.to_string())
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".to_string(),
            "Deny".to_string(),
        ))
        .blocking_show()
}

/// Ask via a native dialog (off the main thread) and remember on Allow.
/// Returns `Ok(true)` when already remembered or the user allowed; `Ok(false)`
/// when denied (callers surface a "blocked" error); `Err` when the dialog
/// itself could not be shown (fail closed — treat as denied).
pub async fn confirm_remembered(
    db: &std::sync::Arc<parking_lot::Mutex<Connection>>,
    app: &AppHandle,
    kind: &str,
    ident: &str,
    title: &str,
    body: String,
) -> Result<bool, String> {
    {
        let conn = db.lock();
        if is_allowed(&conn, kind, ident) {
            return Ok(true);
        }
    }
    let app = app.clone();
    let title = title.to_string();
    let allowed =
        tauri::async_runtime::spawn_blocking(move || blocking_show(&app, &title, &body))
            .await
            .map_err(|e| format!("confirmation dialog failed: {e}"))?;
    if allowed {
        let conn = db.lock();
        remember(&conn, kind, ident);
    }
    Ok(allowed)
}

/// Sync variant for `#[tauri::command(async)]` plain `fn` commands, which run
/// on the thread pool (never the UI thread) — see the MAIN-THREAD RULE in
/// lib.rs. Same remember-on-allow contract as [`confirm_remembered`]; a failed
/// dialog is fail-closed (`false`).
pub fn confirm_remembered_sync(
    db: &std::sync::Arc<parking_lot::Mutex<Connection>>,
    app: &AppHandle,
    kind: &str,
    ident: &str,
    title: &str,
    body: &str,
) -> bool {
    {
        let conn = db.lock();
        if is_allowed(&conn, kind, ident) {
            return true;
        }
    }
    if !blocking_show(app, title, body) {
        return false;
    }
    let conn = db.lock();
    remember(&conn, kind, ident);
    true
}
