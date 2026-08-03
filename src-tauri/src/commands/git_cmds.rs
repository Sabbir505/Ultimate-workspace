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

/// Returns the per-file change list for `path` (project root OR a worktree
/// path). Used by the per-pane diff side panel to render the live file list
/// without re-running the full `get_git_diff` (which can be 200KB+ and is
/// overkill when the panel only needs file names + status).
#[tauri::command]
pub fn get_changed_files(path: String) -> CmdResult<Vec<git::ChangedFile>> {
    Ok(git::get_changed_files(Path::new(&path)))
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

/// Per-file diff for a single path in `path`'s working tree. Used by the
/// per-pane Dev-tab diff side panel when the user clicks a file row — the
/// global `get_git_diff` returns the entire tree (200KB+ for a busy project),
/// which is too noisy when the user just wants to see the change to the
/// file they highlighted. Handles untracked files (synthesizes an
/// "all-added" diff via `git diff --no-index`).
#[tauri::command]
pub fn get_git_file_diff(path: String, file_path: String) -> CmdResult<String> {
    git::get_git_file_diff(Path::new(&path), &file_path)
}
