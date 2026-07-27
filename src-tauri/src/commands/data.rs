//! Settings, skills, quick actions, secrets, cost, export and file-peek
//! commands (CONTRACT.md last section).

use std::fs;
use std::path::Path;

use tauri::State;

use crate::db;
use crate::secrets;
use crate::types::{CostEvent, CostRollups, QuickAction, Skill, WorkspaceRecord};
use crate::{DbState, PtyState};

type CmdResult<T> = Result<T, String>;

/// `read_file_text` hard cap (CONTRACT.md: ~512KB).
const READ_FILE_CAP: u64 = 512 * 1024;

// ---- settings ----

#[tauri::command]
pub fn get_setting(key: String, db: State<DbState>) -> CmdResult<Option<String>> {
    let conn = db.0.lock();
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

// ---- skills ----

#[tauri::command]
pub fn list_skills(project_id: Option<String>, db: State<DbState>) -> CmdResult<Vec<Skill>> {
    let conn = db.0.lock();
    db::list_skills(&conn, project_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_skill(
    name: String,
    slash_command: String,
    content: String,
    scope: String,
    db: State<DbState>,
) -> CmdResult<Skill> {
    let conn = db.0.lock();
    db::create_skill(&conn, &name, &slash_command, &content, &scope).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_skill(
    id: String,
    name: String,
    slash_command: String,
    content: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_skill(&conn, &id, &name, &slash_command, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_skill(id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_skill(&conn, &id).map_err(|e| e.to_string())
}

// ---- quick actions ----

#[tauri::command]
pub fn list_quick_actions(project_id: String, db: State<DbState>) -> CmdResult<Vec<QuickAction>> {
    let conn = db.0.lock();
    db::list_quick_actions(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_quick_action(
    project_id: String,
    label: String,
    command: String,
    keybinding: Option<String>,
    run_on_worktree: Option<bool>,
    db: State<DbState>,
) -> CmdResult<QuickAction> {
    let conn = db.0.lock();
    db::create_quick_action(
        &conn,
        &project_id,
        &label,
        &command,
        keybinding.as_deref(),
        run_on_worktree.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_quick_action(
    id: String,
    label: String,
    command: String,
    keybinding: Option<String>,
    run_on_worktree: Option<bool>,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_quick_action(
        &conn,
        &id,
        &label,
        &command,
        keybinding.as_deref(),
        run_on_worktree.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_quick_action(id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_quick_action(&conn, &id).map_err(|e| e.to_string())
}

// ---- secrets (values live in the OS keychain — see secrets.rs) ----

#[tauri::command]
pub fn set_secret(
    project_id: String,
    key: String,
    value: String,
    db: State<DbState>,
) -> CmdResult<()> {
    if key.trim().is_empty() {
        return Err("secret key must not be empty".to_string());
    }
    let conn = db.0.lock();
    secrets::set_secret(&conn, &project_id, &key, &value)
}

#[tauri::command]
pub fn delete_secret(project_id: String, key: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    secrets::delete_secret(&conn, &project_id, &key)
}

#[tauri::command]
pub fn list_secret_keys(project_id: String, db: State<DbState>) -> CmdResult<Vec<String>> {
    let conn = db.0.lock();
    secrets::list_secret_keys(&conn, &project_id)
}

// ---- cost ----

#[tauri::command]
pub fn get_cost_events(session_id: Option<String>, db: State<DbState>) -> CmdResult<Vec<CostEvent>> {
    let conn = db.0.lock();
    db::get_cost_events(&conn, session_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_cost_rollups(db: State<DbState>) -> CmdResult<CostRollups> {
    let conn = db.0.lock();
    db::get_cost_rollups(&conn).map_err(|e| e.to_string())
}

// ---- export & file peek ----

/// Formats the pane's ANSI-stripped rolling transcript as markdown. The
/// transcript is code-fenced verbatim: reliably segmenting user turns from
/// agent output in raw scrollback is not feasible without parsing each
/// harness's TUI redraws, so per CONTRACT.md this is intentionally best
/// effort — the fence preserves content without inventing structure.
#[tauri::command]
pub fn export_session_markdown(pane_id: String, pty: State<PtyState>) -> CmdResult<String> {
    let transcript = pty
        .0
        .transcript(&pane_id)
        .ok_or_else(|| format!("no transcript for pane {pane_id}"))?;
    let mut md = String::from("# Conduit Session Transcript\n\n");
    md.push_str("```text\n");
    md.push_str(transcript.trim_end());
    md.push_str("\n```\n");
    Ok(md)
}

/// Read-only file peek (PRD §7.9): hard cap ~512KB, refuses binary-ish
/// content (NUL byte) rather than spewing garbage into the webview.
#[tauri::command]
pub fn read_file_text(path: String) -> CmdResult<String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    if meta.len() > READ_FILE_CAP {
        return Err(format!(
            "file too large for peek viewer ({} bytes > {} byte cap)",
            meta.len(),
            READ_FILE_CAP
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("cannot read file: {e}"))?;
    if bytes.contains(&0) {
        return Err("refusing to read binary file".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---- workspaces (pane layout save/restore) ----

#[tauri::command]
pub fn list_workspaces(project_id: String, db: State<DbState>) -> CmdResult<Vec<WorkspaceRecord>> {
    let conn = db.0.lock();
    db::list_workspaces(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_workspace(
    project_id: String,
    name: String,
    data: String,
    db: State<DbState>,
) -> CmdResult<WorkspaceRecord> {
    let conn = db.0.lock();
    // Upsert by (project_id, name): if a workspace with this name exists,
    // update it; otherwise create a new one.
    let existing = db::list_workspaces(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.name.eq_ignore_ascii_case(&name));

    if let Some(ws) = existing {
        db::update_workspace(&conn, &ws.id, &name, &data).map_err(|e| e.to_string())?;
        // Re-read so return value is accurate.
        db::get_workspace(&conn, &ws.id).map_err(|e| e.to_string())
    } else {
        let id = db::new_id();
        db::create_workspace(&conn, &id, &project_id, &name, &data)
            .map_err(|e| e.to_string())?;
        db::get_workspace(&conn, &id).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn delete_workspace(id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_workspace(&conn, &id).map_err(|e| e.to_string())
}
