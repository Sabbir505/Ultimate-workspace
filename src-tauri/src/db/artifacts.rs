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
        filename: row.get("filename")?,
        path: row.get("path")?,
        kind: row.get("kind")?,
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
    })
}

/// Record a generated artifact. `kind` is the lowercase file extension.
pub fn insert_artifact(
    conn: &Connection,
    chat_session_id: Option<&str>,
    filename: &str,
    path: &str,
    kind: &str,
) -> DbResult<ArtifactRecord> {
    let now = now_ts();
    let expires_at = now + RETENTION_SECS;
    let id = new_id();
    conn.execute(
        "INSERT INTO artifacts (id, chat_session_id, filename, path, kind, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, chat_session_id, filename, path, kind, now, expires_at],
    )?;
    Ok(ArtifactRecord {
        id,
        chat_session_id: chat_session_id.map(str::to_string),
        filename: filename.to_string(),
        path: path.to_string(),
        kind: kind.to_string(),
        created_at: now,
        expires_at,
    })
}

/// Most recent first.
pub fn list_artifacts(conn: &Connection) -> DbResult<Vec<ArtifactRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM artifacts ORDER BY created_at DESC")?;
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
        let a = insert_artifact(&conn, Some("sess1"), "report.docx", "/tmp/report.docx", "docx")
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
}
