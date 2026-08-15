//! Per-turn git checkpoint orchestration.
//!
//! Wires the plumbing in `git.rs` (snapshot / diff / restore via hidden refs
//! under `refs/conduit/checkpoints/<session>/<rowid>`) to the DB rows in
//! `db::checkpoints` and the two chat turn-finalize points:
//!
//! - builtin/API chats — `chat::mod`'s spawned turn task (baseline at start,
//!   checkpoint in the Ok-arm finalize)
//! - harness/CLI chats — `agent_sessions::send` (baseline) and `finish_turn`
//!
//! Everything here is best-effort: a checkpoint failure logs and moves on —
//! it must NEVER fail or delay a chat turn. Snapshots are taken against the
//! session's project path (builtin) or spawn dir (harness); non-repo dirs
//! (artifacts folder, unbound chats) are skipped silently.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::git;
use crate::types::ChatCheckpoint;

/// Hidden-ref namespace for all checkpoints.
pub const REFS_PREFIX: &str = "refs/conduit/checkpoints";

/// `checkpoints.enabled` app setting — "false" disables the whole feature
/// (snapshots, baselines, restores). Anything else (or missing) = enabled.
fn enabled(conn: &Connection) -> bool {
    !matches!(
        db::get_setting(conn, "checkpoints.enabled").ok().flatten().as_deref(),
        Some("false")
    )
}

/// The dir is checkpoint-able when the feature is on and the dir is a git
/// work tree. Returns the dir unchanged (PathBuf for call-site ergonomics).
fn checkpointable(conn: &Connection, dir: &Path) -> Option<PathBuf> {
    if !enabled(conn) || !git::is_git_repo(dir) {
        return None;
    }
    Some(dir.to_path_buf())
}

/// Take a full snapshot of `dir`'s working tree and record it as the
/// session's newest checkpoint row + hidden ref. `message_id` ties the
/// checkpoint to the assistant message it follows (None = baseline / safety).
fn create_checkpoint(
    conn: &Connection,
    app: Option<&AppHandle>,
    chat_session_id: &str,
    message_id: Option<i64>,
    dir: &Path,
    snapshot: git::CheckpointSnapshot,
) -> db::DbResult<ChatCheckpoint> {
    // Files changed vs the previous checkpoint (empty-tree base for the
    // baseline). Diff failure is non-fatal — restore only needs tree_sha.
    let prev_tree = db::latest_checkpoint(conn, chat_session_id)?
        .map(|c| c.tree_sha)
        .unwrap_or_else(|| git::empty_tree_sha().to_string());
    let files = git::checkpoint_files_diff(dir, &prev_tree, &snapshot.tree_sha).unwrap_or_default();
    let files_json = serde_json::to_string(
        &files
            .iter()
            .map(|f| crate::types::CheckpointFile { path: f.path.clone(), status: f.status.clone() })
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    let id = db::insert_checkpoint(
        conn,
        chat_session_id,
        message_id,
        &snapshot.tree_sha,
        &dir.to_string_lossy(),
        &files_json,
    )?;
    // Ref name needs the rowid; on ref-creation failure the row keeps an
    // empty ref and restore-by-tree-sha still works.
    if let Some(commit) = &snapshot.commit_sha {
        let ref_name = format!("{REFS_PREFIX}/{chat_session_id}/{id}");
        if git::update_checkpoint_ref(dir, &ref_name, commit).is_ok() {
            let _ = db::set_checkpoint_ref(conn, id, &ref_name);
        }
    }
    let ckpt = db::get_checkpoint(conn, id)?.expect("row just inserted");
    if let Some(app) = app {
        let _ = app.emit("checkpoint:created", &ckpt);
    }
    Ok(ckpt)
}

/// Turn-START baseline: only when the session has NO checkpoints yet, so
/// checkpoint 0 = pre-chat state and even the first turn is undoable.
pub fn maybe_baseline(
    app: Option<&AppHandle>,
    conn: &Connection,
    chat_session_id: &str,
    dir: &Path,
) {
    let Some(dir) = checkpointable(conn, dir) else { return };
    if db::count_chat_checkpoints(conn, chat_session_id).unwrap_or(0) > 0 {
        return;
    }
    match git::snapshot_working_tree(&dir) {
        Ok(snap) => {
            if let Err(e) = create_checkpoint(conn, app, chat_session_id, None, &dir, snap) {
                eprintln!("[checkpoints] baseline failed for {chat_session_id}: {e:?}");
            }
        }
        Err(e) => eprintln!("[checkpoints] baseline snapshot failed for {chat_session_id}: {e}"),
    }
}

/// Turn-END checkpoint: skipped when the working tree is identical to the
/// session's last checkpoint (the turn changed no files).
pub fn after_turn(
    app: Option<&AppHandle>,
    conn: &Connection,
    chat_session_id: &str,
    message_id: Option<i64>,
    dir: &Path,
) {
    let Some(dir) = checkpointable(conn, dir) else { return };
    let snap = match git::snapshot_working_tree(&dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[checkpoints] turn snapshot failed for {chat_session_id}: {e}");
            return;
        }
    };
    if let Some(last) = db::latest_checkpoint(conn, chat_session_id).ok().flatten() {
        if last.tree_sha == snap.tree_sha {
            return; // nothing changed this turn
        }
    }
    if let Err(e) = create_checkpoint(conn, app, chat_session_id, message_id, &dir, snap) {
        eprintln!("[checkpoints] turn checkpoint failed for {chat_session_id}: {e:?}");
    }
}

/// Roll the checkpoint's repo back to its snapshot. Destructive by design —
/// a SAFETY checkpoint of the current state is taken first and returned, so
/// the restore itself is one-click undoable ("restore the safety snapshot").
pub fn restore(
    app: &AppHandle,
    conn: &Connection,
    checkpoint_id: i64,
) -> Result<ChatCheckpoint, String> {
    let ckpt = db::get_checkpoint(conn, checkpoint_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "checkpoint not found".to_string())?;
    let dir = PathBuf::from(&ckpt.repo_path);
    if !git::is_git_repo(&dir) {
        return Err(format!("checkpoint repo is gone: {}", ckpt.repo_path));
    }
    // Safety net first — if the restore itself is a mistake, this snapshot
    // brings the pre-restore state back.
    let snap = git::snapshot_working_tree(&dir)
        .map_err(|e| format!("failed to snapshot current state before restore: {e}"))?;
    let safety = create_checkpoint(conn, Some(app), &ckpt.chat_session_id, None, &dir, snap)
        .map_err(|e| format!("failed to record safety checkpoint: {e:?}"))?;
    git::restore_checkpoint_tree(&dir, &ckpt.tree_sha)
        .map_err(|e| format!("restore failed: {e}"))?;
    Ok(safety)
}

/// Best-effort prune of a session's checkpoint refs from their repos — call
/// BEFORE the DB rows cascade away on session delete. Refs are grouped by
/// repo so each repo is hit once; the commit objects stay until gc (harmless).
pub fn prune_session_refs(conn: &Connection, chat_session_id: &str) {
    let mut by_repo: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    if let Ok(pairs) = db::checkpoint_ref_paths(conn, chat_session_id) {
        for (r, repo) in pairs {
            by_repo.entry(repo).or_default().push(r);
        }
    }
    for (repo, refs) in by_repo {
        let dir = PathBuf::from(&repo);
        if !git::is_git_repo(&dir) {
            continue;
        }
        for r in refs {
            if let Err(e) = git::delete_checkpoint_ref(&dir, &r) {
                eprintln!("[checkpoints] prune {r} in {repo} failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db as chat_db;

    // Full integration against a real temp git repo + in-memory DB: baseline
    // → turn (changed) → turn (unchanged, dedup-skipped) → restore.
    #[test]
    fn baseline_turn_dedup_and_restore_flow() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        git::init_test_repo(path);

        let conn = db::mem();
        // Project-bound session so chat_session_repo_path resolves.
        let pid = db::new_id();
        conn.execute(
            "INSERT INTO projects (id, path, name, created_at) VALUES (?1, ?2, 'p', 0)",
            rusqlite::params![pid, path.to_string_lossy().to_string()],
        )
        .unwrap();
        let cs = chat_db::create_chat_session(&conn, "anthropic", "m", Some(&pid)).unwrap();

        // Baseline at turn start — every file diffs as A vs the empty tree.
        maybe_baseline(None, &conn, &cs.id, path);
        let all = db::list_chat_checkpoints(&conn, &cs.id).unwrap();
        assert_eq!(all.len(), 1, "baseline checkpoint recorded");
        assert!(all[0].message_id.is_none());
        assert!(
            all[0].files.iter().any(|f| f.path == "seed.txt" && f.status == "A"),
            "baseline lists the working tree vs empty tree: {:?}",
            all[0].files
        );

        // Turn 1 changes files.
        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        after_turn(None, &conn, &cs.id, Some(1), path);
        let all = db::list_chat_checkpoints(&conn, &cs.id).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].message_id, Some(1));
        assert!(all[1].files.iter().any(|f| f.path == "a.txt"));

        // Turn 2 changes nothing → dedup-skipped.
        after_turn(None, &conn, &cs.id, Some(2), path);
        let all = db::list_chat_checkpoints(&conn, &cs.id).unwrap();
        assert_eq!(all.len(), 2, "unchanged turn must not add a checkpoint");

        // Restore to the baseline: a.txt must disappear again.
        let base = db::get_checkpoint(&conn, all[0].id).unwrap().unwrap();
        // restore() needs an AppHandle for the emit; test the tree path only.
        git::restore_checkpoint_tree(path, &base.tree_sha).unwrap();
        assert!(!path.join("a.txt").exists(), "restore rolled the turn back");
    }

    #[test]
    fn disabled_setting_and_non_repo_dirs_skip_everything() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = db::mem();
        let cs = chat_db::create_chat_session(&conn, "anthropic", "m", None).unwrap();

        // Non-repo dir: no-op, no rows.
        maybe_baseline(None, &conn, &cs.id, dir.path());
        after_turn(None, &conn, &cs.id, Some(1), dir.path());
        assert_eq!(db::count_chat_checkpoints(&conn, &cs.id).unwrap(), 0);

        // Feature disabled: even a real repo is skipped.
        let repo = tempfile::tempdir().expect("tempdir");
        git::init_test_repo(repo.path());
        db::set_setting(&conn, "checkpoints.enabled", "false").unwrap();
        maybe_baseline(None, &conn, &cs.id, repo.path());
        assert_eq!(db::count_chat_checkpoints(&conn, &cs.id).unwrap(), 0);
    }
}
