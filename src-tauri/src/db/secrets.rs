//! Secrets table group (rows hold key names + a marker blob; values live
//! in the OS keychain — see secrets.rs).
//!
//! All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection, OptionalExtension};

use super::DbResult;

pub fn upsert_secret_row(conn: &Connection, project_id: &str, key: &str, blob: &[u8]) -> DbResult<()> {
    conn.execute(
        "INSERT INTO project_secrets (project_id, key, value_encrypted) VALUES (?1, ?2, ?3)
         ON CONFLICT(project_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted",
        params![project_id, key, blob],
    )?;
    Ok(())
}

pub fn delete_secret_row(conn: &Connection, project_id: &str, key: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM project_secrets WHERE project_id = ?1 AND key = ?2",
        params![project_id, key],
    )?;
    Ok(())
}

pub fn list_secret_keys(conn: &Connection, project_id: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT key FROM project_secrets WHERE project_id = ?1 ORDER BY key",
    )?;
    let rows = stmt.query_map(params![project_id], |r| r.get(0))?;
    rows.collect()
}

// Used by the Linux (non-keyring) secrets fallback and by db tests; on
// keychain platforms the value never lives in the table, hence allow(dead_code).
#[allow(dead_code)]
pub fn get_secret_blob(conn: &Connection, project_id: &str, key: &str) -> DbResult<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT value_encrypted FROM project_secrets WHERE project_id = ?1 AND key = ?2",
        params![project_id, key],
        |r| r.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use super::*;

    #[test]
    fn secret_key_rows() {
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        upsert_secret_row(&conn, &p.id, "B_KEY", b"m").unwrap();
        upsert_secret_row(&conn, &p.id, "A_KEY", b"m").unwrap();
        upsert_secret_row(&conn, &p.id, "A_KEY", b"m2").unwrap(); // upsert
        assert_eq!(list_secret_keys(&conn, &p.id).unwrap(), vec!["A_KEY", "B_KEY"]);
        assert_eq!(get_secret_blob(&conn, &p.id, "A_KEY").unwrap(), Some(b"m2".to_vec()));
        delete_secret_row(&conn, &p.id, "A_KEY").unwrap();
        assert_eq!(list_secret_keys(&conn, &p.id).unwrap(), vec!["B_KEY"]);
    }
}