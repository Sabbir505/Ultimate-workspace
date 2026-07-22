//! Chat sessions + chat messages table groups.
//!
//! All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;
use super::{new_id, now_ts, DbResult};

// ---- chat sessions ----

fn map_chat_session(row: &rusqlite::Row) -> rusqlite::Result<ChatSession> {
    Ok(ChatSession {
        id: row.get("id")?,
        title: row.get("title")?,
        provider: row.get("provider")?,
        model: row.get("model")?,
        created_at: row.get("created_at")?,
        last_active_at: row.get("last_active_at")?,
        starred: row.get::<_, i64>("starred")? != 0,
        unread: row.get::<_, i64>("unread")? != 0,
    })
}

/// Starred chats first, then most recent (last_active_at desc).
pub fn list_chat_sessions(conn: &Connection) -> DbResult<Vec<ChatSession>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM chat_sessions ORDER BY starred DESC, last_active_at DESC",
    )?;
    let rows = stmt.query_map([], map_chat_session)?;
    rows.collect()
}

/// Pin (or unpin) a chat to the top of the sidebar list.
pub fn set_chat_session_starred(
    conn: &Connection,
    chat_session_id: &str,
    starred: bool,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET starred = ?2 WHERE id = ?1",
        params![chat_session_id, starred as i64],
    )?;
    Ok(())
}

/// Mark a chat as read/unread (shows an unread dot in the sidebar).
pub fn set_chat_session_unread(
    conn: &Connection,
    chat_session_id: &str,
    unread: bool,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET unread = ?2 WHERE id = ?1",
        params![chat_session_id, unread as i64],
    )?;
    Ok(())
}

pub fn create_chat_session(
    conn: &Connection,
    provider: &str,
    model: &str,
) -> DbResult<ChatSession> {
    let now = now_ts();
    let id = new_id();
    conn.execute(
        "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at)
         VALUES (?1, NULL, ?2, ?3, ?4, ?4)",
        params![id, provider, model, now],
    )?;
    conn.query_row(
        "SELECT * FROM chat_sessions WHERE id = ?1",
        params![id],
        map_chat_session,
    )
}

pub fn get_chat_session(conn: &Connection, chat_session_id: &str) -> DbResult<Option<ChatSession>> {
    conn.query_row(
        "SELECT * FROM chat_sessions WHERE id = ?1",
        params![chat_session_id],
        map_chat_session,
    )
    .optional()
}

pub fn delete_chat_session(conn: &Connection, chat_session_id: &str) -> DbResult<()> {
    // FK cascade handles chat_messages.
    conn.execute(
        "DELETE FROM chat_sessions WHERE id = ?1",
        params![chat_session_id],
    )?;
    Ok(())
}

pub fn update_chat_session_title(
    conn: &Connection,
    chat_session_id: &str,
    title: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET title = ?2 WHERE id = ?1",
        params![chat_session_id, title],
    )?;
    Ok(())
}

pub fn update_chat_session_model(
    conn: &Connection,
    chat_session_id: &str,
    model: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET model = ?2 WHERE id = ?1",
        params![chat_session_id, model],
    )?;
    Ok(())
}

pub fn touch_chat_session(conn: &Connection, chat_session_id: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET last_active_at = ?2 WHERE id = ?1",
        params![chat_session_id, now_ts()],
    )?;
    Ok(())
}

// ---- chat messages ----

fn map_chat_message(row: &rusqlite::Row) -> rusqlite::Result<ChatMessageRecord> {
    Ok(ChatMessageRecord {
        id: row.get("id")?,
        chat_session_id: row.get("chat_session_id")?,
        role: row.get("role")?,
        content: row.get("content")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        cost_usd: row.get("cost_usd")?,
        created_at: row.get("created_at")?,
    })
}

pub fn add_chat_message(
    conn: &Connection,
    chat_session_id: &str,
    role: &str,
    content: &str,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cost_usd: Option<f64>,
) -> DbResult<ChatMessageRecord> {
    let now = now_ts();
    conn.execute(
        "INSERT INTO chat_messages (chat_session_id, role, content, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![chat_session_id, role, content, input_tokens, output_tokens, cost_usd, now],
    )?;
    let id = conn.last_insert_rowid();
    Ok(ChatMessageRecord {
        id,
        chat_session_id: chat_session_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        input_tokens,
        output_tokens,
        cost_usd,
        created_at: now,
    })
}

/// Ordered by insertion id so the chat timeline is chronological.
pub fn list_chat_messages(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Vec<ChatMessageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM chat_messages WHERE chat_session_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![chat_session_id], map_chat_message)?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use super::*;

    #[test]
    fn chat_session_and_messages_round_trip() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5").unwrap();
        assert_eq!(cs.provider, "anthropic");
        assert_eq!(cs.model, "claude-sonnet-4-5");
        assert!(cs.title.is_none());

        update_chat_session_title(&conn, &cs.id, "my chat").unwrap();
        touch_chat_session(&conn, &cs.id).unwrap();
        let cs2 = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(cs2.title.as_deref(), Some("my chat"));
        assert!(cs2.last_active_at >= cs.last_active_at);

        let m1 = add_chat_message(&conn, &cs.id, "user", "hello", None, None, None).unwrap();
        assert_eq!(m1.role, "user");
        let m2 = add_chat_message(&conn, &cs.id, "assistant", "hi there", Some(100), Some(50), Some(0.0015)).unwrap();
        assert_eq!(m2.input_tokens, Some(100));
        assert_eq!(m2.output_tokens, Some(50));
        assert!((m2.cost_usd.unwrap() - 0.0015).abs() < 1e-9);

        let msgs = list_chat_messages(&conn, &cs.id).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, m1.id);
        assert_eq!(msgs[1].id, m2.id);

        // List sessions
        let sessions = list_chat_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 1);

        // Delete cascades messages
        delete_chat_session(&conn, &cs.id).unwrap();
        assert!(get_chat_session(&conn, &cs.id).unwrap().is_none());
        assert!(list_chat_messages(&conn, &cs.id).unwrap().is_empty());
    }
}