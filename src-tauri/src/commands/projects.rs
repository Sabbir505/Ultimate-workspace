//! Project and session CRUD commands (CONTRACT.md "Projects / sessions").

use std::path::Path;

use tauri::State;

use crate::db;
use crate::git;
use crate::types::{Project, SessionRecord};
use crate::DbState;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn list_projects(db: State<DbState>) -> CmdResult<Vec<Project>> {
    let conn = db.0.lock();
    db::list_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_project(path: String, db: State<DbState>) -> CmdResult<Project> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    // Canonicalize so the UNIQUE(path) constraint actually dedupes.
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    // canonicalize() emits \\?\ extended-length paths on Windows, which
    // cmd.exe rejects as "UNC" when used as a pty cwd — strip the prefix.
    let path_str = crate::util::strip_unc_prefix(&canonical.to_string_lossy());
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_str.clone());
    // Git detection shells out first, but a bare `.git` entry is proof even
    // when the git binary is missing (PRD §4.1 needs the flag regardless).
    let is_git = git::is_git_repo(&canonical) || canonical.join(".git").exists();
    let conn = db.0.lock();
    db::add_project(&conn, &path_str, &name, is_git).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_project(project_id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::remove_project(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_project(project_id: String, name: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::rename_project(&conn, &project_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn init_git_repo(project_id: String, db: State<DbState>) -> CmdResult<()> {
    let path = {
        let conn = db.0.lock();
        db::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "project not found".to_string())?
            .path
    };
    let out = std::process::Command::new("git")
        .arg("init")
        .current_dir(&path)
        .output()
        .map_err(|e| format!("failed to run git init: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let conn = db.0.lock();
    db::set_git_repo(&conn, &project_id, true).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_sessions(project_id: Option<String>, db: State<DbState>) -> CmdResult<Vec<SessionRecord>> {
    let conn = db.0.lock();
    db::list_sessions(&conn, project_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_session(
    project_id: String,
    harness: String,
    db: State<DbState>,
) -> CmdResult<SessionRecord> {
    let conn = db.0.lock();
    if db::get_project(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("project not found".to_string());
    }
    if crate::harness_adapters::get_adapter(&harness).is_none() {
        return Err(format!("unknown harness: {harness}"));
    }
    db::create_session(&conn, &project_id, &harness).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_session_title(session_id: String, title: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_session_title(&conn, &session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_session(session_id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_session(&conn, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn touch_session(session_id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::touch_session(&conn, &session_id).map_err(|e| e.to_string())
}
