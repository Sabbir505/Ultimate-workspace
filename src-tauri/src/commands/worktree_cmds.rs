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
//! - `remove_worktree_for_session` — the shared best-effort teardown the
//!   delete / unbind / project-removal paths call so no orphaned linked
//!   working trees accumulate on disk.
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
pub fn ensure_chat_session_worktree(
    session_id: String,
    app: AppHandle,
    db: State<DbState>,
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
    let short = session_id.get(..8).unwrap_or(&session_id);
    let path = match git::create_worktree(Path::new(&project.path), &format!("relay/{short}")) {
        Ok(p) => p,
        Err(first_err) => {
            let full = format!("relay/{session_id}");
            match git::create_worktree(Path::new(&project.path), &full) {
                Ok(p) => p,
                Err(_) => return Err(first_err),
            }
        }
    };
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
#[tauri::command]
pub fn set_chat_session_worktree(
    session_id: String,
    worktree_path: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    let before = db::get_chat_session(&conn, &session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat session not found".to_string())?;
    if let Some(old) = &before.worktree_path {
        if worktree_path.as_deref() != Some(old.as_str()) {
            remove_worktree_for_session(&conn, &before);
        }
    }
    db::set_chat_session_worktree(&conn, &session_id, worktree_path.as_deref())
        .map_err(|e| e.to_string())
}

/// Best-effort teardown of a chat's worktree: `git worktree remove --force`
/// from the owning project root, then clear the pointer. Swallows every error
/// on purpose — cleanup must never block a delete/unbind. If git can't remove
/// it (unknown worktree, missing git), the dir is left in place rather than
/// fs-removed: the path is chat-owned, but a conservative miss beats deleting
/// a directory the user may have repurposed.
pub(crate) fn remove_worktree_for_session(conn: &rusqlite::Connection, sess: &ChatSession) {
    let Some(wt) = &sess.worktree_path else { return };
    if let Some(pid) = &sess.project_id {
        if let Ok(Some(proj)) = db::get_project(conn, pid) {
            let _ = git::remove_worktree(Path::new(&proj.path), Path::new(wt));
        }
    }
    let _ = db::set_chat_session_worktree(conn, &sess.id, None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem() -> rusqlite::Connection {
        db::mem()
    }

    #[test]
    fn remove_worktree_for_session_clears_pointer_without_project() {
        // A chat whose worktree pointer exists but whose project is gone (e.g.
        // project removed while the chat row survived) must still get the
        // pointer cleared — and must not panic on the missing project lookup.
        let conn = mem();
        let sess = db::create_chat_session(&conn, "openai", "m", None).unwrap();
        let unbound = db::get_chat_session(&conn, &sess.id).unwrap().unwrap();
        assert!(unbound.worktree_path.is_none());

        // Simulate a pointer that references a now-missing project.
        let mut ghost = unbound.clone();
        ghost.project_id = Some("gone-project".into());
        ghost.worktree_path = Some("D:/nowhere/relay-123".into());
        remove_worktree_for_session(&conn, &ghost);
        let after = db::get_chat_session(&conn, &sess.id).unwrap().unwrap();
        assert!(after.worktree_path.is_none());
    }
}
