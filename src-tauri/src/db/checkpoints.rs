//! Chat checkpoint rows (per-turn git working-tree snapshots).
//!
//! Each row pairs a chat session (+ the assistant message it follows) with a
//! hidden git ref (`refs/conduit/checkpoints/<sid>/<rowid>`) holding the full
//! working-tree snapshot. `files` is a JSON array of `{path,status}` entries
//! (A/M/D) relative to the session's previous checkpoint — what the chip UI
//! lists. All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;
use super::{now_ts, DbResult};

fn map_checkpoint(row: &rusqlite::Row) -> rusqlite::Result<ChatCheckpoint> {
    let files_json: String = row.get("files")?;
    let files: Vec<CheckpointFile> = serde_json::from_str(&files_json).unwrap_or_default();
    Ok(ChatCheckpoint {
        id: row.get("id")?,
        chat_session_id: row.get("chat_session_id")?,
        message_id: row.get("message_id")?,
        ref_name: row.get("ref")?,
        tree_sha: row.get("tree_sha")?,
        repo_path: row.get("repo_path")?,
        files,
        created_at: row.get("created_at")?,
    })
}

/// Insert a checkpoint row with an empty ref; the caller creates the git ref
/// (needs the rowid for the ref name) and fills it via `set_checkpoint_ref`.
/// Returns the new row id.
pub fn insert_checkpoint(
    conn: &Connection,
    chat_session_id: &str,
    message_id: Option<i64>,
    tree_sha: &str,
    repo_path: &str,
    files_json: &str,
) -> DbResult<i64> {
    conn.execute(
        "INSERT INTO chat_checkpoints
            (chat_session_id, message_id, ref, tree_sha, repo_path, files, created_at)
         VALUES (?1, ?2, '', ?3, ?4, ?5, ?6)",
        params![chat_session_id, message_id, tree_sha, repo_path, files_json, now_ts()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Fill in the git ref once it exists (insert → rowid-based ref → update).
pub fn set_checkpoint_ref(conn: &Connection, id: i64, ref_name: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_checkpoints SET ref = ?2 WHERE id = ?1",
        params![id, ref_name],
    )?;
    Ok(())
}

/// All checkpoints for a session, oldest first (timeline order).
pub fn list_chat_checkpoints(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Vec<ChatCheckpoint>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM chat_checkpoints WHERE chat_session_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![chat_session_id], map_checkpoint)?;
    rows.collect()
}

pub fn count_chat_checkpoints(conn: &Connection, chat_session_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM chat_checkpoints WHERE chat_session_id = ?1",
        params![chat_session_id],
        |r| r.get(0),
    )
}

/// The session's most recent checkpoint (turn-end dedup compares tree shas).
pub fn latest_checkpoint(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Option<ChatCheckpoint>> {
    conn.query_row(
        "SELECT * FROM chat_checkpoints WHERE chat_session_id = ?1
         ORDER BY id DESC LIMIT 1",
        params![chat_session_id],
        map_checkpoint,
    )
    .optional()
}

pub fn get_checkpoint(conn: &Connection, id: i64) -> DbResult<Option<ChatCheckpoint>> {
    conn.query_row(
        "SELECT * FROM chat_checkpoints WHERE id = ?1",
        params![id],
        map_checkpoint,
    )
    .optional()
}

/// (ref, repo_path) pairs for a session — used by the delete-session command
/// to prune the hidden refs from each repo BEFORE the rows cascade away.
pub fn checkpoint_ref_paths(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT ref, repo_path FROM chat_checkpoints
         WHERE chat_session_id = ?1 AND ref != ''",
    )?;
    let rows = stmt.query_map(params![chat_session_id], |r| {
        Ok((r.get::<_, String>("ref")?, r.get::<_, String>("repo_path")?))
    })?;
    rows.collect()
}

/// The git repo directory a chat session's checkpoints live against.
/// Worktree-isolated sessions snapshot the WORKTREE (their agent edits land
/// there); everything else resolves `chat_sessions.project_id →
/// projects.path`. None for unbound chats (or a missing project row). A
/// stale worktree path (dir removed) is still returned — the caller's
/// `checkpointable` git-repo gate skips it silently.
pub fn chat_session_repo_path(conn: &Connection, chat_session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT COALESCE(NULLIF(s.worktree_path, ''), p.path) FROM chat_sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?1",
        params![chat_session_id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, chat};

    fn files_json(entries: &[(&str, &str)]) -> String {
        serde_json::json!(entries
            .iter()
            .map(|(path, status)| CheckpointFile { path: path.to_string(), status: status.to_string() })
            .collect::<Vec<_>>())
        .to_string()
    }

    #[test]
    fn checkpoints_crud_and_latest() {
        let conn = db::mem();
        let cs = chat::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();

        assert_eq!(count_chat_checkpoints(&conn, &cs.id).unwrap(), 0);
        assert!(latest_checkpoint(&conn, &cs.id).unwrap().is_none());

        // Baseline (no message), then post-turn (message 7).
        let id1 = insert_checkpoint(&conn, &cs.id, None, "tree1", "D:/repo", "[]").unwrap();
        set_checkpoint_ref(&conn, id1, "refs/conduit/checkpoints/s/1").unwrap();
        let id2 = insert_checkpoint(&conn, &cs.id, Some(7), "tree2", "D:/repo", &files_json(&[("a.rs", "M"), ("b.txt", "A")]))
            .unwrap();
        set_checkpoint_ref(&conn, id2, "refs/conduit/checkpoints/s/2").unwrap();

        let all = list_chat_checkpoints(&conn, &cs.id).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, id1);
        assert!(all[0].message_id.is_none());
        assert_eq!(all[0].ref_name, "refs/conduit/checkpoints/s/1");
        assert_eq!(all[1].message_id, Some(7));
        assert_eq!(all[1].files.len(), 2);
        assert_eq!(all[1].files[0].path, "a.rs");
        assert_eq!(all[1].files[0].status, "M");

        let latest = latest_checkpoint(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(latest.id, id2);
        assert_eq!(latest.tree_sha, "tree2");

        assert_eq!(get_checkpoint(&conn, id1).unwrap().unwrap().tree_sha, "tree1");
        assert!(get_checkpoint(&conn, 9999).unwrap().is_none());

        // Ref paths for delete-time pruning.
        let refs = checkpoint_ref_paths(&conn, &cs.id).unwrap();
        assert_eq!(refs.len(), 2);
        assert!(refs.contains(&("refs/conduit/checkpoints/s/2".to_string(), "D:/repo".to_string())));

        // Corrupt JSON files column degrades to empty, never panics.
        conn.execute("UPDATE chat_checkpoints SET files = 'not json' WHERE id = ?1", rusqlite::params![id2])
            .unwrap();
        let reloaded = get_checkpoint(&conn, id2).unwrap().unwrap();
        assert!(reloaded.files.is_empty());
    }

    #[test]
    fn checkpoints_cascade_on_session_delete_and_repo_lookup() {
        let conn = db::mem();
        // A project-bound session checkpoints against the project path.
        let pid = db::new_id();
        conn.execute(
            "INSERT INTO projects (id, path, name, created_at) VALUES (?1, 'D:/proj', 'proj', 0)",
            rusqlite::params![pid],
        )
        .unwrap();
        let bound = chat::create_chat_session(&conn, "anthropic", "m", Some(&pid)).unwrap();
        let loose = chat::create_chat_session(&conn, "anthropic", "m", None).unwrap();
        assert_eq!(
            chat_session_repo_path(&conn, &bound.id).as_deref(),
            Some("D:/proj")
        );
        assert!(chat_session_repo_path(&conn, &loose.id).is_none());

        insert_checkpoint(&conn, &bound.id, None, "t", "D:/proj", "[]").unwrap();
        insert_checkpoint(&conn, &loose.id, None, "t", "D:/elsewhere", "[]").unwrap();
        assert_eq!(count_chat_checkpoints(&conn, &bound.id).unwrap(), 1);

        // Deleting the session cascades the checkpoint rows away.
        chat::delete_chat_session(&conn, &bound.id).unwrap();
        assert_eq!(count_chat_checkpoints(&conn, &bound.id).unwrap(), 0);
        assert_eq!(count_chat_checkpoints(&conn, &loose.id).unwrap(), 1);
    }

    #[test]
    fn repo_lookup_prefers_worktree_path_over_project_path() {
        let conn = db::mem();
        let pid = db::new_id();
        conn.execute(
            "INSERT INTO projects (id, path, name, created_at) VALUES (?1, 'D:/proj', 'proj', 0)",
            rusqlite::params![pid],
        )
        .unwrap();
        // Worktree-isolated session: the agent edits land in the worktree, so
        // checkpoints must snapshot/restore there, not the project root.
        let isolated = chat::create_chat_session(&conn, "anthropic", "m", Some(&pid)).unwrap();
        conn.execute(
            "UPDATE chat_sessions SET worktree_path = 'D:/proj-conduit-abc' WHERE id = ?1",
            rusqlite::params![isolated.id],
        )
        .unwrap();
        assert_eq!(
            chat_session_repo_path(&conn, &isolated.id).as_deref(),
            Some("D:/proj-conduit-abc")
        );
        // Empty-string worktree path (stale/migrated row) degrades to project.
        let blank = chat::create_chat_session(&conn, "anthropic", "m", Some(&pid)).unwrap();
        conn.execute(
            "UPDATE chat_sessions SET worktree_path = '' WHERE id = ?1",
            rusqlite::params![blank.id],
        )
        .unwrap();
        assert_eq!(chat_session_repo_path(&conn, &blank.id).as_deref(), Some("D:/proj"));
        // Unbound chats still resolve to None.
        let loose = chat::create_chat_session(&conn, "anthropic", "m", None).unwrap();
        assert!(chat_session_repo_path(&conn, &loose.id).is_none());
    }
}
