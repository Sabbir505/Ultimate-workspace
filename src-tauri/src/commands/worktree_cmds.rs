//! Chat-session worktree commands (roadmap P0 §3.1.1).
//!
//! Every new chat bound to a git project gets its own isolated git worktree
//! (`<project-parent>/<project-name>-relay-<id8>`, branch `relay/<id8>`).
//! This module owns the lifecycle:
//!
//! - `ensure_chat_session_worktree` — create + persist + watch (idempotent).
//!   Called async from the frontend when a chat is created on a git project;
//!   failures are surfaced as errors but NEVER block a send (the chat falls
//!   back to the project root as its cwd).
//! - `set_chat_session_worktree` — "Join main working tree": remove the
//!   on-disk worktree best-effort and clear the pointer.
//! - `worktree_teardown_target` + `remove_worktree_blocking` — the shared
//!   teardown pair the delete / unbind / project-removal paths call so no
//!   orphaned linked working trees accumulate on disk. Deliberately split:
//!   the read collects paths under the DB lock, the removal runs after the
//!   lock drops and in `spawn_blocking` (a worktree removal deletes a whole
//!   tree — it must never run on the UI thread or under the shared mutex).
//!
//! All removal is best-effort by design: the worktree's branch (`relay/<id>`)
//! stays in the repo, so committed work is never lost — only uncommitted
//! changes inside a deleted chat go away.

use std::path::Path;

use tauri::{AppHandle, State};

use crate::db;
use crate::git;
use crate::types::ChatSession;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Make sure `session_id` has an isolated git worktree and point the session
/// at it. Returns `Some(path)` when the chat now has a worktree, `None` when
/// it can't (unbound chat or the bound project isn't a git repo — nothing to
/// isolate).
///
/// Idempotent: a session that already points at a live worktree dir returns
/// that path unchanged. A stale pointer (dir deleted out from under us) is
/// cleared and the worktree re-created. Branch creation prefers
/// `relay/<first-8-of-id>` and falls back to the full id on a collision
/// (e.g. a leftover worktree from a deleted chat with the same id prefix).
#[tauri::command]
pub async fn ensure_chat_session_worktree(
    session_id: String,
    app: AppHandle,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    let row = {
        let conn = db.0.lock();
        db::get_chat_session(&conn, &session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?
    };
    // Already isolated and the dir still exists — nothing to do.
    if let Some(wt) = &row.worktree_path {
        if git::worktree_dir_exists(Path::new(wt)) {
            return Ok(Some(wt.clone()));
        }
        // Dir vanished: drop the stale pointer and re-create below.
        let conn = db.0.lock();
        let _ = db::set_chat_session_worktree(&conn, &session_id, None);
    }
    let Some(project_id) = &row.project_id else {
        return Ok(None); // unbound chat — no workspace to isolate.
    };
    let project = {
        let conn = db.0.lock();
        db::get_project(&conn, project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "project not found".to_string())?
    };
    if !project.is_git_repo {
        return Ok(None);
    }
    // Branch: `relay/<first 8 of the uuid>`. UUIDs are ASCII so a byte slice
    // is safe; `relay/` groups all chat worktrees in `git branch`/`git log`.
    let short = session_id.get(..8).unwrap_or(&session_id).to_string();
    let full = format!("relay/{session_id}");
    let project_root = project.path;
    // `git worktree add` checks out a whole tree — seconds on a real repo. It
    // runs in `spawn_blocking` (never on the runtime worker, never on the UI
    // thread, and with no DB guard held: the lock above is scoped away).
    let path = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let root = Path::new(&project_root);
        match git::create_worktree(root, &format!("relay/{short}")) {
            Ok(p) => Ok(p),
            Err(first_err) => match git::create_worktree(root, &full) {
                Ok(p) => Ok(p),
                Err(_) => Err(first_err),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    {
        let conn = db.0.lock();
        db::set_chat_session_worktree(&conn, &session_id, Some(&path))
            .map_err(|e| e.to_string())?;
    }
    // Watch the worktree so diff/status refresh when the agent edits there
    // (git_watcher installs per-path watchers; worktree siblings of a project
    // are not covered by the project-root watcher).
    crate::git_watcher::install(&app, &db, Path::new(&path));
    Ok(Some(path))
}

/// Point a chat at a worktree path (rare direct-set) or — the common case,
/// "Join main working tree" — remove the existing worktree and clear the
/// pointer. When the pointer changes, the previous on-disk worktree is removed
/// best-effort first so we never leak a linked working tree the chat stopped
/// using.
///
/// `async` + a scoped guard: the removal is `git worktree remove --force` on a
/// whole tree, and it used to run on the IPC thread while HOLDING the shared
/// DB mutex — a several-second window that froze the window and serialized
/// every other DB consumer behind it.
#[tauri::command]
pub async fn set_chat_session_worktree(
    session_id: String,
    worktree_path: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    // Phase 1 (locked): decide what needs tearing down; collect the paths only.
    let teardown = {
        let conn = db.0.lock();
        let before = db::get_chat_session(&conn, &session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        if worktree_path.as_deref() != before.worktree_path.as_deref() {
            worktree_teardown_target(&conn, &before)
        } else {
            None
        }
    };
    // Phase 2 (no lock): the slow git removal, off the async runtime.
    if let Some((root, wt)) = teardown {
        let _ = tokio::task::spawn_blocking(move || remove_worktree_blocking(root, wt)).await;
    }
    // Phase 3 (locked): commit the pointer. A missing project root skips the
    // git removal but still lands the same end state — the pointer is written
    // here either way.
    let conn = db.0.lock();
    db::set_chat_session_worktree(&conn, &session_id, worktree_path.as_deref())
        .map_err(|e| e.to_string())
}

/// The teardown TARGET of a chat's worktree: `(project root, worktree path)`,
/// or `None` when the session has no worktree pointer. Read-only by design.
///
/// The caller splits this from the removal itself: collect paths under the DB
/// lock, drop it, then run `git worktree remove --force` in `spawn_blocking`.
/// The old shape (removal + pointer clear inside one `&Connection` helper) had
/// to run on the IPC thread with the lock held, which is what made deleting a
/// chat or rebinding it freeze the window for the length of a tree removal.
///
/// `project root` is `None` when the owning project row is gone — the removal
/// is skipped then, matching the old behavior, and the caller still clears the
/// pointer.
pub(crate) fn worktree_teardown_target(
    conn: &rusqlite::Connection,
    sess: &ChatSession,
) -> Option<(Option<String>, String)> {
    let wt = sess.worktree_path.clone()?;
    let project_root = sess
        .project_id
        .as_deref()
        .and_then(|pid| db::get_project(conn, pid).ok().flatten())
        .map(|p| p.path);
    Some((project_root, wt))
}

/// Best-effort removal of one worktree, for callers that already collected
/// their targets: `git worktree remove --force` from the project root.
/// Swallows every error on purpose — cleanup must never block a delete/unbind.
/// If git can't remove it (unknown worktree, missing git), the dir is left in
/// place rather than fs-removed: the path is chat-owned, but a conservative
/// miss beats deleting a directory the user may have repurposed.
pub(crate) fn remove_worktree_blocking(project_root: Option<String>, worktree_path: String) {
    if let Some(root) = project_root {
        let _ = git::remove_worktree(Path::new(&root), Path::new(&worktree_path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem() -> rusqlite::Connection {
        db::mem()
    }

    #[test]
    fn teardown_target_survives_a_missing_project_row() {
        // A chat whose worktree pointer references a project that is gone
        // (project removed while the chat row survived) must still yield a
        // teardown target — with a `None` root, so the caller skips the git
        // removal but still clears the pointer. Regression: the old shared
        // helper resolved the project itself and silently did nothing here.
        let conn = mem();
        let sess = db::create_chat_session(&conn, "openai", "m", None).unwrap();
        let unbound = db::get_chat_session(&conn, &sess.id).unwrap().unwrap();
        assert!(unbound.worktree_path.is_none());
        // No pointer → nothing to tear down.
        assert!(worktree_teardown_target(&conn, &unbound).is_none());

        // Simulate a pointer that references a now-missing project.
        let mut ghost = unbound.clone();
        ghost.project_id = Some("gone-project".into());
        ghost.worktree_path = Some("D:/nowhere/relay-123".into());
        assert_eq!(
            worktree_teardown_target(&conn, &ghost),
            Some((None, "D:/nowhere/relay-123".to_string()))
        );
    }
}
