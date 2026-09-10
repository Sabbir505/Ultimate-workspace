//! Artifacts table: generated files/diagrams surfaced in the sidebar, with a
//! 30-day retention window. All query functions take `&Connection` for
//! in-memory testability.

use rusqlite::{params, Connection};

use super::{new_id, now_ts, DbResult};
use crate::types::ArtifactRecord;

/// Artifacts are retained for 30 days after creation, then swept.
pub const RETENTION_SECS: i64 = 30 * 24 * 60 * 60;

fn map_artifact(row: &rusqlite::Row) -> rusqlite::Result<ArtifactRecord> {
    Ok(ArtifactRecord {
        id: row.get("id")?,
        chat_session_id: row.get("chat_session_id")?,
        chat_message_id: row.get("chat_message_id")?,
        filename: row.get("filename")?,
        path: row.get("path")?,
        kind: row.get("kind")?,
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
    })
}

/// Record a generated artifact. `kind` is the lowercase file extension.
///
/// One gallery card per FILE, not per write: re-recording a path that already
/// has a row bumps that row to the top (fresh `created_at`/`expires_at`, and
/// the newest session/kind) instead of inserting a duplicate — writing or
/// editing the same file used to list every update as a separate artifact.
pub fn insert_artifact(
    conn: &Connection,
    chat_session_id: Option<&str>,
    filename: &str,
    path: &str,
    kind: &str,
) -> DbResult<ArtifactRecord> {
    let now = now_ts();
    let expires_at = now + RETENTION_SECS;
    let updated = conn.execute(
        "UPDATE artifacts
          SET chat_session_id = ?2, filename = ?3, kind = ?4, created_at = ?5, expires_at = ?6
          WHERE path = ?1",
        params![path, chat_session_id, filename, kind, now, expires_at],
    )?;
    if updated > 0 {
        let id: String = conn.query_row(
            "SELECT id FROM artifacts WHERE path = ?1 ORDER BY created_at DESC LIMIT 1",
            params![path],
            |r| r.get(0),
        )?;
        return Ok(ArtifactRecord {
            id,
            chat_session_id: chat_session_id.map(str::to_string),
            chat_message_id: None,
            filename: filename.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            created_at: now,
            expires_at,
        });
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO artifacts (id, chat_session_id, filename, path, kind, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, chat_session_id, filename, path, kind, now, expires_at],
    )?;
    Ok(ArtifactRecord {
        id,
        chat_session_id: chat_session_id.map(str::to_string),
        chat_message_id: None,
        filename: filename.to_string(),
        path: path.to_string(),
        kind: kind.to_string(),
        created_at: now,
        expires_at,
    })
}

/// Artifacts for one chat session, oldest first (chat timeline order).
pub fn list_artifacts_for_chat(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Vec<ArtifactRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM artifacts WHERE chat_session_id = ?1 ORDER BY created_at ASC")?;
    let rows = stmt.query_map(params![chat_session_id], map_artifact)?;
    rows.collect()
}

/// Artifacts attributed to one assistant message (timeline order).
pub fn list_artifacts_for_message(
    conn: &Connection,
    chat_session_id: &str,
    chat_message_id: i64,
) -> DbResult<Vec<ArtifactRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM artifacts \
          WHERE chat_session_id = ?1 AND chat_message_id = ?2 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![chat_session_id, chat_message_id], map_artifact)?;
    rows.collect()
}

/// Attribute a session's not-yet-attributed artifacts to the assistant message
/// that just completed, so reopening the chat can render them on that bubble.
pub fn attach_artifacts_to_message(
    conn: &Connection,
    chat_session_id: &str,
    chat_message_id: i64,
) -> DbResult<()> {
    conn.execute(
        "UPDATE artifacts SET chat_message_id = ?2
         WHERE chat_session_id = ?1 AND chat_message_id IS NULL",
        params![chat_session_id, chat_message_id],
    )?;
    Ok(())
}

/// Most recent first. One row per FILE: the library view is a document list,
/// not a write log, so rows that share a path collapse to their newest
/// (pre-upsert duplicates age out instead of cluttering the gallery).
pub fn list_artifacts(conn: &Connection) -> DbResult<Vec<ArtifactRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM artifacts a
          WHERE NOT EXISTS (SELECT 1 FROM artifacts newer
                             WHERE newer.path = a.path
                               AND (newer.created_at > a.created_at
                                 OR (newer.created_at = a.created_at AND newer.rowid > a.rowid)))
          ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], map_artifact)?;
    rows.collect()
}

/// Delete one artifact row, returning its on-disk path so the caller can remove
/// the file. Returns `None` if the id was unknown.
pub fn delete_artifact(conn: &Connection, id: &str) -> DbResult<Option<String>> {
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM artifacts WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    conn.execute("DELETE FROM artifacts WHERE id = ?1", params![id])?;
    Ok(path)
}

/// Delete all artifacts whose `expires_at` is in the past, returning their
/// on-disk paths so the caller can remove the files.
pub fn delete_expired_artifacts(conn: &Connection) -> DbResult<Vec<String>> {
    let now = now_ts();
    let paths: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM artifacts WHERE expires_at <= ?1")?;
        let rows = stmt.query_map(params![now], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    conn.execute("DELETE FROM artifacts WHERE expires_at <= ?1", params![now])?;
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_round_trip_and_expiry() {
        let conn = super::super::mem();
        let a = insert_artifact(
            &conn,
            Some("sess1"),
            "report.docx",
            "/tmp/report.docx",
            "docx",
        )
        .unwrap();
        assert_eq!(a.kind, "docx");
        assert_eq!(a.expires_at - a.created_at, RETENTION_SECS);

        let list = list_artifacts(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].filename, "report.docx");

        // Force an already-expired row and confirm the sweep removes only it.
        conn.execute(
            "INSERT INTO artifacts (id, chat_session_id, filename, path, kind, created_at, expires_at)
             VALUES ('old', NULL, 'old.pdf', '/tmp/old.pdf', 'pdf', 0, 1)",
            [],
        )
        .unwrap();
        let removed = delete_expired_artifacts(&conn).unwrap();
        assert_eq!(removed, vec!["/tmp/old.pdf".to_string()]);
        assert_eq!(list_artifacts(&conn).unwrap().len(), 1);

        let path = delete_artifact(&conn, &a.id).unwrap();
        assert_eq!(path.as_deref(), Some("/tmp/report.docx"));
        assert!(list_artifacts(&conn).unwrap().is_empty());
    }

    #[test]
    fn reinserting_a_path_updates_instead_of_duplicating() {
        let conn = super::super::mem();
        let first =
            insert_artifact(&conn, Some("s1"), "draft.md", "/tmp/draft.md", "markdown").unwrap();
        // Simulate the model editing the same file later in another session.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second =
            insert_artifact(&conn, Some("s2"), "draft.md", "/tmp/draft.md", "markdown").unwrap();

        // Same row, bumped — not a second card.
        assert_eq!(list_artifacts(&conn).unwrap().len(), 1);
        assert_eq!(second.id, first.id);
        assert!(second.created_at > first.created_at);
        assert_eq!(second.chat_session_id.as_deref(), Some("s2"));

        // A genuinely different file still inserts normally.
        insert_artifact(&conn, Some("s2"), "other.md", "/tmp/other.md", "markdown").unwrap();
        assert_eq!(list_artifacts(&conn).unwrap().len(), 2);
    }
}
