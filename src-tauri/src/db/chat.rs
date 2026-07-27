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
        // Falls back to "manual" for rows written before the column existed
        // (the migration adds it nullable); the app treats unknown as manual.
        permission_mode: row
            .get::<_, Option<String>>("permission_mode")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "manual".to_string()),
        // NULL = inherit global setting; per-session values are "on" | "off".
        watch_mode: row.get::<_, Option<String>>("watch_mode")?,
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
        "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, permission_mode, watch_mode)
         VALUES (?1, NULL, ?2, ?3, ?4, ?4, 'manual', NULL)",
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

/// Switch a session's provider (e.g. to `local_gguf` when a local model is
/// picked from the selector in a cloud session, or back again). The caller is
/// expected to also set a model valid for the new provider.
pub fn update_chat_session_provider(
    conn: &Connection,
    chat_session_id: &str,
    provider: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET provider = ?2 WHERE id = ?1",
        params![chat_session_id, provider],
    )?;
    Ok(())
}

/// Update a session's permission posture
/// (`read_only` | `manual` | `auto_edit` | `full_auto`). Persisted per-session
/// so reopening a chat restores its last mode; new sessions start at `manual`.
pub fn update_chat_session_permission_mode(
    conn: &Connection,
    chat_session_id: &str,
    mode: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET permission_mode = ?2 WHERE id = ?1",
        params![chat_session_id, mode],
    )?;
    Ok(())
}

/// Update a session's watch-mode pacing override (`"on"` | `"off"` | None).
/// None clears the override so the session falls back to the global setting.
pub fn update_chat_session_watch_mode(
    conn: &Connection,
    chat_session_id: &str,
    mode: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET watch_mode = ?2 WHERE id = ?1",
        params![chat_session_id, mode],
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

// ---- per-conversation connector opt-in ----

/// Replace the set of connectors attached to a chat session. A connected
/// connector is not globally available — it must be attached to the session
/// here for its tools to be registered into that conversation's tool loop.
pub fn set_chat_session_connectors(
    conn: &Connection,
    chat_session_id: &str,
    connector_ids: &[String],
) -> DbResult<()> {
    conn.execute(
        "DELETE FROM chat_session_connectors WHERE chat_session_id = ?1",
        params![chat_session_id],
    )?;
    for id in connector_ids {
        conn.execute(
            "INSERT OR IGNORE INTO chat_session_connectors (chat_session_id, connector_id)
             VALUES (?1, ?2)",
            params![chat_session_id, id],
        )?;
    }
    Ok(())
}

/// The connector ids attached to a session, ordered for stable display.
pub fn list_chat_session_connectors(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT connector_id FROM chat_session_connectors
         WHERE chat_session_id = ?1 ORDER BY connector_id",
    )?;
    let rows = stmt.query_map(params![chat_session_id], |r| r.get::<_, String>(0))?;
    rows.collect()
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
        // New sessions always start at the manual permission posture.
        assert_eq!(cs.permission_mode, "manual");

        update_chat_session_title(&conn, &cs.id, "my chat").unwrap();
        touch_chat_session(&conn, &cs.id).unwrap();
        let cs2 = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(cs2.title.as_deref(), Some("my chat"));
        assert_eq!(cs2.permission_mode, "manual");
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

    #[test]
    fn permission_mode_persists_and_restores() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "openai", "gpt-4o").unwrap();
        // Starts at manual.
        assert_eq!(cs.permission_mode, "manual");

        // Switch to full_auto and re-read — persists.
        update_chat_session_permission_mode(&conn, &cs.id, "full_auto").unwrap();
        let reloaded = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(reloaded.permission_mode, "full_auto");

        // list_chat_sessions also surfaces the persisted mode.
        let listed = list_chat_sessions(&conn).unwrap();
        assert_eq!(listed[0].permission_mode, "full_auto");

        // Switch to read_only and confirm it sticks too.
        update_chat_session_permission_mode(&conn, &cs.id, "read_only").unwrap();
        assert_eq!(
            get_chat_session(&conn, &cs.id).unwrap().unwrap().permission_mode,
            "read_only"
        );
    }

    #[test]
    fn watch_mode_persists_and_restores() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "openai", "gpt-4o").unwrap();
        // Starts at None (inherit global).
        assert!(cs.watch_mode.is_none());

        // Set to "on" and re-read — persists.
        update_chat_session_watch_mode(&conn, &cs.id, Some("on")).unwrap();
        let reloaded = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(reloaded.watch_mode.as_deref(), Some("on"));

        // list_chat_sessions also surfaces the persisted mode.
        let listed = list_chat_sessions(&conn).unwrap();
        assert_eq!(listed[0].watch_mode.as_deref(), Some("on"));

        // Clear override (None) and confirm it falls back to NULL.
        update_chat_session_watch_mode(&conn, &cs.id, None).unwrap();
        assert!(get_chat_session(&conn, &cs.id).unwrap().unwrap().watch_mode.is_none());

        // Switch to "off" and confirm it sticks.
        update_chat_session_watch_mode(&conn, &cs.id, Some("off")).unwrap();
        assert_eq!(
            get_chat_session(&conn, &cs.id).unwrap().unwrap().watch_mode.as_deref(),
            Some("off")
        );
    }
}