//! Source ledger for research-mode turns: per-source facts the model records
//! during the Execute phase and reads back during Synthesis. Scoped to a chat
//! session and cleared (`reset_source_ledger`) at the start of each new
//! research task. All query functions take `&Connection` for in-memory
//! testability, matching the rest of the DB layer.

use rusqlite::{params, Connection};

use super::{now_ts, DbResult};
use crate::types::SourceNote;

fn map_source_note(row: &rusqlite::Row) -> rusqlite::Result<SourceNote> {
    Ok(SourceNote {
        id: row.get("id")?,
        chat_session_id: row.get("chat_session_id")?,
        url: row.get("url")?,
        title: row.get("title")?,
        fact: row.get("fact")?,
        excerpt: row.get("excerpt")?,
        unavailable: row.get("unavailable")?,
        created_at: row.get("created_at")?,
    })
}

/// Record one source note for a chat session. `unavailable` carries the
/// `browser_read` failure reason when the source could not be read; pass `None`
/// for a usable source. Returns the inserted note (its assigned row id).
/// Uses INSERT OR IGNORE to skip duplicates (same session + url + fact).
pub fn add_source_note(
    conn: &Connection,
    chat_session_id: &str,
    url: &str,
    title: &str,
    fact: &str,
    excerpt: &str,
    unavailable: Option<&str>,
) -> DbResult<SourceNote> {
    let now = now_ts();
    conn.execute(
        "INSERT OR IGNORE INTO chat_source_notes
           (chat_session_id, url, title, fact, excerpt, unavailable, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![chat_session_id, url, title, fact, excerpt, unavailable, now],
    )?;
    let id = conn.last_insert_rowid();
    // If last_insert_rowid() is 0, the row was ignored (duplicate);
    // fetch the existing row so the caller always gets a valid record.
    if id == 0 {
        return conn
            .query_row(
                "SELECT * FROM chat_source_notes WHERE chat_session_id = ?1 AND url = ?2 AND fact = ?3 ORDER BY id ASC LIMIT 1",
                params![chat_session_id, url, fact],
                map_source_note,
            )
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()));
    }
    Ok(SourceNote {
        id,
        chat_session_id: chat_session_id.to_string(),
        url: url.to_string(),
        title: title.to_string(),
        fact: fact.to_string(),
        excerpt: excerpt.to_string(),
        unavailable: unavailable.map(str::to_string),
        created_at: now,
    })
}

/// All source notes for a chat session, in insertion (chronological) order so
/// the model can re-read what it found in the order it found it. Capped at the
/// most recent 50 to keep the context window manageable.
pub fn list_source_notes(conn: &Connection, chat_session_id: &str) -> DbResult<Vec<SourceNote>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM chat_source_notes WHERE chat_session_id = ?1 ORDER BY id ASC LIMIT 50",
    )?;
    let rows = stmt.query_map(params![chat_session_id], map_source_note)?;
    rows.collect()
}

/// Drop every source note for a chat session — called at the start of each new
/// research task so a fresh question starts from a clean ledger.
pub fn clear_source_notes(conn: &Connection, chat_session_id: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM chat_source_notes WHERE chat_session_id = ?1",
        params![chat_session_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::chat::create_chat_session;
    use super::super::{delete_chat_session, mem};
    use super::*;

    #[test]
    fn add_list_clear_round_trip() {
        let conn = mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-5").unwrap();
        let n1 = add_source_note(
            &conn,
            &cs.id,
            "https://example.com/a",
            "Page A",
            "A is the first fact.",
            "\"A is the first fact.\"",
            None,
        )
        .unwrap();
        add_source_note(
            &conn,
            &cs.id,
            "https://example.com/b",
            "Page B",
            "B is the second fact.",
            "\"B is the second fact.\"",
            Some("paywalled"),
        )
        .unwrap();

        let notes = list_source_notes(&conn, &cs.id).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, n1.id);
        assert_eq!(notes[0].url, "https://example.com/a");
        assert!(notes[0].unavailable.is_none());
        assert_eq!(notes[1].unavailable.as_deref(), Some("paywalled"));
        // Insertion order preserved (id ASC).
        assert!(notes[0].id < notes[1].id);

        // clear_source_notes wipes only this session.
        clear_source_notes(&conn, &cs.id).unwrap();
        assert!(list_source_notes(&conn, &cs.id).unwrap().is_empty());
    }

    #[test]
    fn notes_are_scoped_per_session() {
        let conn = mem();
        let a = create_chat_session(&conn, "openai", "gpt-4o").unwrap();
        let b = create_chat_session(&conn, "openai", "gpt-4o").unwrap();
        add_source_note(&conn, &a.id, "https://a", "A", "a", "a", None).unwrap();
        add_source_note(&conn, &b.id, "https://b", "B", "b", "b", None).unwrap();
        assert_eq!(list_source_notes(&conn, &a.id).unwrap().len(), 1);
        assert_eq!(list_source_notes(&conn, &b.id).unwrap().len(), 1);
        // Clearing one session leaves the other intact.
        clear_source_notes(&conn, &a.id).unwrap();
        assert!(list_source_notes(&conn, &a.id).unwrap().is_empty());
        assert_eq!(list_source_notes(&conn, &b.id).unwrap().len(), 1);
    }

    #[test]
    fn cascade_on_session_delete() {
        // FK cascade: deleting a chat session must remove its source notes.
        // Requires foreign_keys = ON (the `mem()` helper sets it).
        let conn = mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-5").unwrap();
        add_source_note(&conn, &cs.id, "https://x", "X", "x", "x", None).unwrap();
        assert_eq!(list_source_notes(&conn, &cs.id).unwrap().len(), 1);

        delete_chat_session(&conn, &cs.id).unwrap();
        assert!(list_source_notes(&conn, &cs.id).unwrap().is_empty());
    }
}
