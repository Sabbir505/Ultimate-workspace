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

/// List the local git branches in the repo at `path`, most recent first.
#[tauri::command]
pub fn list_git_branches(path: String, db: State<DbState>) -> CmdResult<Vec<String>> {
    verify_project_path(Path::new(&path), &db)?;
    git::list_branches(Path::new(&path)).map_err(|e| e.to_string())
}

/// Create a new branch at the current HEAD of the repo at `path`.
#[tauri::command]
pub fn create_git_branch(path: String, name: String, db: State<DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    git::create_branch(Path::new(&path), &name).map_err(|e| e.to_string())
}

/// Switch the repo at `path` to the named branch.
#[tauri::command]
pub fn checkout_git_branch(path: String, name: String, db: State<DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    git::checkout_branch(Path::new(&path), &name).map_err(|e| e.to_string())
}

/// Delete the named branch in the repo at `path`.
#[tauri::command]
pub fn delete_git_branch(path: String, name: String, db: State<DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    git::delete_branch(Path::new(&path), &name).map_err(|e| e.to_string())
}

/// Last `n` commits (default 30) for the repo at `path`, oldest first
/// within the returned window. Used by the Dev tab's history view.
#[tauri::command]
pub fn get_git_log(path: String, limit: Option<usize>, db: State<DbState>) -> CmdResult<Vec<git::CommitEntry>> {
    verify_project_path(Path::new(&path), &db)?;
    git::log(Path::new(&path), limit.unwrap_or(30)).map_err(|e| e.to_string())
}

/// Remote URL for the repo at `path` (the `origin` fetch URL, or empty
/// when the repo has no remote).
#[tauri::command]
pub fn get_remote_url(path: String, db: State<DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    git::remote_url(Path::new(&path)).map_err(|e| e.to_string())
}

/// Stage the listed files (empty = all) and create a commit with the
/// given message. Returns the new commit hash. Must be called on a
/// verified-project path.
#[tauri::command]
pub fn git_commit(
    path: String,
    message: String,
    files: Option<Vec<String>>,
    db: State<DbState>,
) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    git::commit(Path::new(&path), &message, files.as_deref()).map_err(|e| e.to_string())
}

/// Push the current branch to `origin`. No-op when the branch has no
/// upstream.
#[tauri::command]
pub fn git_push(path: String, db: State<DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    git::push(Path::new(&path)).map_err(|e| e.to_string())
}

/// Install a `notify` filesystem watcher for the given project. The
/// watcher fires `project:fs-changed` events that the frontend uses to
/// refresh git badges and changed-files panels without polling.
#[tauri::command]
pub fn install_git_watcher(
    project_id: String,
    app: tauri::AppHandle,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    let projects = db::list_projects(&conn).map_err(|e| e.to_string())?;
    let project = projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    drop(conn);
    crate::git_watcher::install(&app, &project_id, Path::new(&project.path));
    Ok(())
}

/// Stop watching the given project's filesystem.
#[tauri::command]
pub fn uninstall_git_watcher(project_id: String, app: tauri::AppHandle) -> CmdResult<()> {
    crate::git_watcher::uninstall(&app, &project_id);
    Ok(())
}

/// Re-scan every registered watcher (call after a window regains focus
/// to pick up filesystem changes that fired while the app was idle).
#[tauri::command]
pub fn refresh_git_watchers(app: tauri::AppHandle) -> CmdResult<()> {
    crate::git_watcher::refresh_all(&app);
    Ok(())
}
