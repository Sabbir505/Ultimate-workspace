//! Git commands (CONTRACT.md "Git").

use std::path::Path;

use tauri::State;

use crate::db;
use crate::git;
use crate::types::GitStatusInfo;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn get_git_status(path: String) -> CmdResult<GitStatusInfo> {
    Ok(git::get_git_status(Path::new(&path)))
}

/// Creates `git worktree add <path> -b <branch>` at
/// `<project-parent>/<project-name>-<sanitized-branch>`; returns the path.
#[tauri::command]
pub fn create_worktree(
    project_id: String,
    branch_name: String,
    db: State<DbState>,
) -> CmdResult<String> {
    let project_path = {
        let conn = db.0.lock();
        db::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "project not found".to_string())?
            .path
    };
    git::create_worktree(Path::new(&project_path), &branch_name)
}

#[tauri::command]
pub fn get_git_diff(path: String) -> CmdResult<String> {
    git::get_git_diff(Path::new(&path))
}
