//! Git commands (CONTRACT.md "Git").

use std::path::Path;

use tauri::State;

use crate::db;
use crate::git;
use crate::types::GitStatusInfo;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Verify that `path` lies under a registered project root.
/// Returns an error if it doesn't, preventing a compromised renderer
/// from scanning arbitrary directories via git commands.
fn verify_project_path(path: &Path, db: &DbState) -> CmdResult<()> {
    let canon = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    let conn = db.0.lock();
    let projects = db::list_projects(&conn).map_err(|e| e.to_string())?;
    for proj in &projects {
        if let Ok(proj_canon) = Path::new(&proj.path).canonicalize() {
            if crate::util::path_starts_with_ci(&canon, &proj_canon) {
                return Ok(());
            }
        }
    }
    // Worktrees are SIBLINGS of the project root (`<parent>/<name>-<branch>`),
    // so they legitimately sit outside every project prefix — allowlist the
    // exact paths recorded on sessions rather than loosening the prefix check
    // (a raw prefix match is what let any same-prefix sibling dir pass).
    let sessions = db::list_sessions(&conn, None).map_err(|e| e.to_string())?;
    for sess in &sessions {
        if let Some(wt) = &sess.worktree_path {
            if let Ok(wt_canon) = Path::new(wt).canonicalize() {
                if crate::util::path_starts_with_ci(&canon, &wt_canon) {
                    return Ok(());
                }
            }
        }
    }
    Err("path is outside allowed project roots".to_string())
}

#[tauri::command]
pub fn get_git_status(path: String, db: State<DbState>) -> CmdResult<GitStatusInfo> {
    verify_project_path(Path::new(&path), &db)?;
    Ok(git::get_git_status(Path::new(&path)))
}

/// Returns the per-file change list for `path` (project root OR a worktree
/// path). Used by the per-pane diff side panel to render the live file list
/// without re-running the full `get_git_diff` (which can be 200KB+ and is
/// overkill when the panel only needs file names + status).
#[tauri::command]
pub fn get_changed_files(path: String, db: State<DbState>) -> CmdResult<Vec<git::ChangedFile>> {
    verify_project_path(Path::new(&path), &db)?;
    Ok(git::get_changed_files(Path::new(&path)))
}

/// Creates `git worktree add <path> -b <branch>` at
/// `<project-parent>/<project-name>-<sanitized-branch>`; returns the path.
///
/// SECURITY: `branch_name` starting with `-` is rejected to prevent git
/// flag injection (e.g. `-D` being interpreted as a delete flag).
#[tauri::command]
pub fn create_worktree(
    project_id: String,
    branch_name: String,
    db: State<DbState>,
) -> CmdResult<String> {
    // Reject branch names that git would interpret as flags.
    if branch_name.starts_with('-') {
        return Err("branch name must not start with '-'".to_string());
    }
    // Also reject names containing `..` (git ref traversal) or control chars.
    if branch_name.contains("..") || branch_name.chars().any(|c| (c as u32) < 0x20) {
        return Err("branch name contains invalid characters".to_string());
    }
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
pub fn get_git_diff(path: String, db: State<DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    git::get_git_diff(Path::new(&path))
}

/// Per-file diff for a single path in `path`'s working tree. Used by the
/// per-pane Dev-tab diff side panel when the user clicks a file row — the
/// global `get_git_diff` returns the entire tree (200KB+ for a busy project),
/// which is too noisy when the user just wants to see the change to the
/// file they highlighted. Handles untracked files (synthesizes an
/// "all-added" diff via `git diff --no-index`).
#[tauri::command]
pub fn get_git_file_diff(path: String, file_path: String, db: State<DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    git::get_git_file_diff(Path::new(&path), &file_path)
}
