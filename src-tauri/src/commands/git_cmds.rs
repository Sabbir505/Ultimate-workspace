//! Git commands (CONTRACT.md "Git").

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

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
    // Chat-session worktrees (roadmap P0 §3.1.1) live in the same sibling
    // layout; allowlist the exact recorded paths the same way.
    let chat_worktrees = db::chat_worktree_paths(&conn, None).map_err(|e| e.to_string())?;
    for wt in chat_worktrees {
        if let Ok(wt_canon) = Path::new(&wt).canonicalize() {
            if crate::util::path_starts_with_ci(&canon, &wt_canon) {
                return Ok(());
            }
        }
    }
    Err("path is outside allowed project roots".to_string())
}

// Every git command below that spawns subprocesses is `async` +
// `spawn_blocking`. Tauri 2 runs SYNCHRONOUS commands on the main thread, so a
// sync `git status` here blocked the Windows message pump whenever the repo
// was slow (big tree, Defender scan, cold cache). The OS then flags the window
// as unresponsive and the taskbar icon swaps to the ghost/"not responding"
// (crashed-app-looking) icon. This is the hot path while agents work: every
// fs-change burst triggers refreshGitStatus → get_git_status. Offloading keeps
// the event loop pumping so the taskbar icon never ghosts.

#[tauri::command]
pub async fn get_git_status(path: String, db: State<'_, DbState>) -> CmdResult<GitStatusInfo> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    let info = tokio::task::spawn_blocking(move || git::get_git_status(&path))
        .await
        .map_err(|e| e.to_string())?;
    Ok(info)
}

/// Returns the per-file change list for `path` (project root OR a worktree
/// path). Used by the per-pane diff side panel to render the live file list
/// without re-running the full `get_git_diff` (which can be 200KB+ and is
/// overkill when the panel only needs file names + status).
#[tauri::command]
pub async fn get_changed_files(path: String, db: State<'_, DbState>) -> CmdResult<Vec<git::ChangedFile>> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    let files = tokio::task::spawn_blocking(move || git::get_changed_files(&path))
        .await
        .map_err(|e| e.to_string())?;
    Ok(files)
}

/// Creates `git worktree add <path> -b <branch>` at
/// `<project-parent>/<project-name>-<sanitized-branch>`; returns the path.
///
/// SECURITY: `branch_name` starting with `-` is rejected to prevent git
/// flag injection (e.g. `-D` being interpreted as a delete flag).
#[tauri::command]
pub async fn create_worktree(
    project_id: String,
    branch_name: String,
    db: State<'_, DbState>,
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
    tokio::task::spawn_blocking(move || git::create_worktree(Path::new(&project_path), &branch_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_git_diff(path: String, db: State<'_, DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::get_git_diff(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Per-file diff for a single path in `path`'s working tree. Used by the
/// per-pane Dev-tab diff side panel when the user clicks a file row — the
/// global `get_git_diff` returns the entire tree (200KB+ for a busy project),
/// which is too noisy when the user just wants to see the change to the
/// file they highlighted. Handles untracked files (synthesizes an
/// "all-added" diff via `git diff --no-index`).
#[tauri::command]
pub async fn get_git_file_diff(
    path: String,
    file_path: String,
    db: State<'_, DbState>,
) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::get_git_file_diff(&path, &file_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Per-file diff against a chosen base — backs the Changes panel's filters:
/// "worktree" (default per-file diff), "staged" (HEAD vs index), and
/// "base:<tree-sha>" (<sha> vs worktree; "base:empty" = the empty tree).
#[tauri::command]
pub async fn get_git_file_diff_scoped(
    path: String,
    file_path: String,
    scope: String,
    db: State<'_, DbState>,
) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::get_git_file_diff_scoped(&path, &file_path, &scope))
        .await
        .map_err(|e| e.to_string())?
}

/// Every change on the current branch vs its base (merge-base vs working
/// tree + untracked), with line counts and the merge-base sha the UI can
/// expand individual files against.
#[tauri::command]
pub async fn get_branch_changed_files(
    path: String,
    db: State<'_, DbState>,
) -> CmdResult<git::BranchChanges> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::get_branch_changed_files(&path))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Branch management ----

#[tauri::command]
pub async fn list_git_branches(path: String, db: State<'_, DbState>) -> CmdResult<Vec<git::BranchInfo>> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::list_branches(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_git_branch(path: String, name: String, db: State<'_, DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::create_branch(&path, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn checkout_git_branch(path: String, name: String, db: State<'_, DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::checkout_branch(&path, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_git_branch(path: String, name: String, db: State<'_, DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::delete_branch(&path, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_git_log(path: String, db: State<'_, DbState>) -> CmdResult<Vec<git::GitLogEntry>> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::get_git_log(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_remote_url(path: String, db: State<'_, DbState>) -> CmdResult<Option<String>> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    let url = tokio::task::spawn_blocking(move || git::get_remote_url(&path))
        .await
        .map_err(|e| e.to_string())?;
    Ok(url)
}

/// Stage all changes and commit with the given message. Returns the short SHA.
//
// Async + spawn_blocking: git_commit spawns multiple subprocesses (git add .,
// git commit, git rev-parse) which can take seconds on a large tree. As a
// synchronous command this blocked the Tauri main thread and froze/crashed
// WebView2. Offloading to a blocking thread keeps the UI responsive.
#[tauri::command]
pub async fn git_commit(path: String, message: String, db: State<'_, DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::git_commit(&path, &message))
        .await
        .map_err(|e| e.to_string())?
}

/// Push the current branch to origin.
//
// Async + spawn_blocking: git_push is a network round-trip (often seconds,
// longer during credential negotiation). As a synchronous command it froze
// the main thread and crashed WebView2; offloading prevents that.
#[tauri::command]
pub async fn git_push(path: String, db: State<'_, DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::git_push(&path))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Filesystem watcher (drives project:fs-changed) ----
//
// These three commands replace the 4-8s polling loops in the frontend
// (useGitStatusPolling, DevDiffPanel, BranchDropdown, GitToolsSidebar).
// The OS tells us when something changed; the watcher debounces; the
// frontend reacts. See src-tauri/src/git_watcher.rs.

/// Install a watcher for `path` (a project root or worktree path).
/// Idempotent — re-installing an already-watched path is a no-op.
#[tauri::command]
pub fn install_git_watcher(path: String, app: AppHandle, db: State<DbState>) -> CmdResult<()> {
    verify_project_path(Path::new(&path), &db)?;
    crate::git_watcher::install(&app, &db, Path::new(&path));
    Ok(())
}

/// Drop the watcher for `path`. No-op if the path isn't being watched.
#[tauri::command]
pub fn uninstall_git_watcher(path: String, app: AppHandle) -> CmdResult<()> {
    let state = app.state::<crate::git_watcher::WatcherState>();
    crate::git_watcher::uninstall(&state, Path::new(&path));
    Ok(())
}

/// Re-scan the projects + worktrees tables and install watchers for any
/// paths that don't have one yet. Called by the frontend after project
/// add/remove and after the projects store reloads.
#[tauri::command]
pub fn refresh_git_watchers(app: AppHandle, db: State<DbState>) -> CmdResult<()> {
    crate::git_watcher::install_all_known(&app, &db);
    Ok(())
}
