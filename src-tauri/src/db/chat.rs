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
        // NULL = inherit global setting; per-session values are "on" | "off".
        watch_mode: row.get::<_, Option<String>>("watch_mode")?,
        // NULL = no agent picked yet (fresh chat); otherwise "builtin" |
        // "local" | "harness:<id>".
        agent: row.get::<_, Option<String>>("agent")?,
        // NULL = unbound (shows in the flat "Chat History" list); otherwise the
        // chat is nested under this project's expandable sidebar row.
        project_id: row.get::<_, Option<String>>("project_id")?,
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
    project_id: Option<&str>,
) -> DbResult<ChatSession> {
    let now = now_ts();
    let id = new_id();
    conn.execute(
        "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, watch_mode, project_id)
         VALUES (?1, NULL, ?2, ?3, ?4, ?4, NULL, ?5)",
        params![id, provider, model, now, project_id],
    )?;
    conn.query_row(
        "SELECT * FROM chat_sessions WHERE id = ?1",
        params![id],
        map_chat_session,
    )
}

/// Bind (or unbind with `None`) a chat session to a project. Drives the chat's
/// nesting under the project's expandable sidebar row.
pub fn set_chat_session_project(
    conn: &Connection,
    chat_session_id: &str,
    project_id: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET project_id = ?2 WHERE id = ?1",
        params![chat_session_id, project_id],
    )?;
    Ok(())
}

/// Delete every chat session bound to a project (and, via FK cascade, its
/// messages). Used when a project is removed from the sidebar.
pub fn delete_chat_sessions_for_project(conn: &Connection, project_id: &str) -> DbResult<usize> {
    let n = conn.execute(
        "DELETE FROM chat_sessions WHERE project_id = ?1",
        params![project_id],
    )?;
    Ok(n)
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

/// Delete every session that has no messages — the empty "Untitled" rows left
/// behind when the app (or the user) closed a brand-new chat that was never
/// typed into. `keep` protects the session the caller is about to select;
/// starred sessions are never swept. Returns the number of rows deleted.
pub fn delete_empty_chat_sessions(conn: &Connection, keep: Option<&str>) -> DbResult<usize> {
    let n = conn.execute(
        "DELETE FROM chat_sessions
         WHERE starred = 0
           AND id NOT IN (SELECT DISTINCT chat_session_id FROM chat_messages)
           AND (?1 IS NULL OR id <> ?1)",
        params![keep],
    )?;
    Ok(n)
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

/// Update a session's agent selection (`"builtin"` | `"local"` |
/// `"harness:<id>"` | None). None clears the selection (fresh-chat locked
/// state); a value unlocks the model chip for that agent.
pub fn update_chat_session_agent(
    conn: &Connection,
    chat_session_id: &str,
    agent: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET agent = ?2 WHERE id = ?1",
        params![chat_session_id, agent],
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
///
/// Wrapped in a transaction so a crash between the DELETE and the INSERT
/// loop can't leave the session with zero connectors.
pub fn set_chat_session_connectors(
    conn: &Connection,
    chat_session_id: &str,
    connector_ids: &[String],
) -> DbResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM chat_session_connectors WHERE chat_session_id = ?1",
        params![chat_session_id],
    )?;
    for id in connector_ids {
        tx.execute(
            "INSERT OR IGNORE INTO chat_session_connectors (chat_session_id, connector_id)
             VALUES (?1, ?2)",
            params![chat_session_id, id],
        )?;
    }
    tx.commit()?;
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
        superseded_by: row.get("superseded_by")?,
        cache_creation_input_tokens: row.get("cache_creation_input_tokens")?,
        cache_read_input_tokens: row.get("cache_read_input_tokens")?,
        reasoning_output_tokens: row.get("reasoning_output_tokens")?,
        provider: row.get("provider")?,
        model_key: row.get("model_key")?,
        pricing_estimated_usd: row.get("pricing_estimated_usd")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        llm_time_ms: row.get("llm_time_ms")?,
        tool_time_ms: row.get("tool_time_ms")?,
        ttft_ms: row.get("ttft_ms")?,
        tokens_per_second: row.get("tokens_per_second")?,
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
    cache_creation_input_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
    reasoning_output_tokens: Option<i64>,
    provider: Option<&str>,
    model_key: Option<&str>,
    pricing_estimated_usd: Option<f64>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    llm_time_ms: Option<i64>,
    tool_time_ms: Option<i64>,
    ttft_ms: Option<i64>,
    tokens_per_second: Option<f64>,
) -> DbResult<ChatMessageRecord> {
    let now = now_ts();
    conn.execute(
        "INSERT INTO chat_messages (
            chat_session_id, role, content,
            input_tokens, output_tokens, cost_usd, created_at,
            cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
            provider, model_key, pricing_estimated_usd,
            started_at, completed_at,
            llm_time_ms, tool_time_ms, ttft_ms, tokens_per_second
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            chat_session_id, role, content,
            input_tokens, output_tokens, cost_usd, now,
            cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
            provider, model_key, pricing_estimated_usd,
            started_at, completed_at,
            llm_time_ms, tool_time_ms, ttft_ms, tokens_per_second,
        ],
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
        superseded_by: None,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        reasoning_output_tokens,
        provider: provider.map(String::from),
        model_key: model_key.map(String::from),
        pricing_estimated_usd,
        started_at,
        completed_at,
        llm_time_ms,
        tool_time_ms,
        ttft_ms,
        tokens_per_second,
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

/// Paged variant (M7): newest `limit` messages with id < `before_id`,
/// returned in chronological order. `None`/`None` = the latest page. Long
/// sessions used to deserialize their ENTIRE history on every open.
pub fn list_chat_messages_page(
    conn: &Connection,
    chat_session_id: &str,
    before_id: Option<i64>,
    limit: i64,
) -> DbResult<Vec<ChatMessageRecord>> {
    // Subquery picks the page newest-first, outer select re-orders it
    // chronologically for the timeline.
    let mut stmt = conn.prepare(
        "SELECT * FROM (
           SELECT * FROM chat_messages
             WHERE chat_session_id = ?1 AND (?2 IS NULL OR id < ?2)
             ORDER BY id DESC LIMIT ?3
         ) ORDER BY id",
    )?;
    let rows = stmt.query_map(params![chat_session_id, before_id, limit], map_chat_message)?;
    rows.collect()
}

/// The subset of messages the send path feeds to the model: every row NOT
/// folded into a `[compacted context]` summary (i.e. `superseded_by IS NULL`).
/// The compaction framework soft-deletes summarized turns by setting
/// `superseded_by`; the full `list_chat_messages` still returns them for the UI.
pub fn list_active_chat_messages(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Vec<ChatMessageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM chat_messages WHERE chat_session_id = ?1 AND superseded_by IS NULL ORDER BY id",
    )?;
    let rows = stmt.query_map(params![chat_session_id], map_chat_message)?;
    rows.collect()
}

/// Delete a single chat message row by id. Returns `true` if a row was
/// removed, `false` if the id was unknown. Artifacts attributed to this
/// message are detached (their `chat_message_id` is nulled) rather than
/// deleted — the file artifacts themselves stay around and can be re-attributed
/// or expired on the normal 30-day sweep, so a user who deletes the last
/// assistant message of a turn doesn't lose generated files.
pub fn delete_chat_message(conn: &Connection, message_id: i64) -> DbResult<bool> {
    let changed = conn.execute(
        "DELETE FROM chat_messages WHERE id = ?1",
        params![message_id],
    )?;
    if changed > 0 {
        // Drop any FK-style link to this message; the artifact row/file
        // itself stays (see doc comment above).
        let _ = conn.execute(
            "UPDATE artifacts SET chat_message_id = NULL WHERE chat_message_id = ?1",
            params![message_id],
        );
    }
    Ok(changed > 0)
}

/// Mark the given message rows as superseded by `summary_id` (the id of the
/// `[compacted context]` summary row that folded them in). Used both for the
/// aged-out real turns AND any prior summary row, so re-compaction collapses
/// everything into a single running summary instead of stacking blocks.
/// No-op for an empty id list.
pub fn mark_superseded(conn: &Connection, ids: &[i64], summary_id: i64) -> DbResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    // Build a positional placeholder list (?, ?, …) and bind ids + summary_id.
    // mi3: params_from_iter borrows the ids directly — no Box<dyn ToSql> per id.
    let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
    let sql = format!(
        "UPDATE chat_messages SET superseded_by = ? WHERE id IN ({})",
        placeholders.join(", ")
    );
    let params = rusqlite::params_from_iter(std::iter::once(summary_id).chain(ids.iter().copied()));
    conn.execute(&sql, params)?;
    Ok(())
}

// ---- full-text search ----

/// Build a safe FTS5 MATCH expression from free-form user input. FTS5 has its
/// own query language (AND/OR/NOT, phrases, column filters), so each term is
/// stripped to alphanumeric/underscore, double-quoted (quoted strings are
/// never parsed as operators), and given a trailing `*` prefix marker —
/// "stream" also hits "streaming". Returns None when nothing searchable
/// remains.
fn fts_match_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter_map(|t| {
            let clean: String = t
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if clean.is_empty() {
                None
            } else {
                Some(format!("\"{clean}\"*"))
            }
        })
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// Full-text search across chat message content (FTS5) plus session titles
/// (LIKE). Title hits come first (strong signal), then content hits ordered
/// by FTS rank. Superseded messages (folded into a compaction summary) are
/// excluded.
pub fn search_chat_messages(
    conn: &Connection,
    query: &str,
    limit: u32,
) -> DbResult<Vec<ChatSearchResult>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 100) as i64;
    let mut out: Vec<ChatSearchResult> = Vec::new();

    // Pass 1: session titles. LIKE with escaped wildcards; no FTS needed for
    // a single short column.
    let like = format!(
        "%{}%",
        trimmed.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, last_active_at FROM chat_sessions
             WHERE title IS NOT NULL AND title LIKE ?1 ESCAPE '\\'
             ORDER BY last_active_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![like, limit], |row| {
            Ok(ChatSearchResult {
                chat_session_id: row.get("id")?,
                session_title: row.get("title")?,
                message_id: None,
                snippet: None,
                role: None,
                created_at: row.get("last_active_at")?,
                last_active_at: row.get("last_active_at")?,
            })
        })?;
        for r in rows {
            out.push(r?);
        }
    }

    // Pass 2: message content via the FTS5 external-content index.
    if let Some(fts_query) = fts_match_query(trimmed) {
        let remaining = limit - out.len() as i64;
        if remaining > 0 {
            let mut stmt = conn.prepare(
                "SELECT m.chat_session_id, s.title, m.id,
                        snippet(chat_messages_fts, 0, '', '', '…', 24) AS snip,
                        m.role, m.created_at, s.last_active_at
                 FROM chat_messages_fts
                 JOIN chat_messages m ON m.id = chat_messages_fts.rowid
                 JOIN chat_sessions s ON s.id = m.chat_session_id
                 WHERE chat_messages_fts MATCH ?1 AND m.superseded_by IS NULL
                 ORDER BY rank
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![fts_query, remaining], |row| {
                Ok(ChatSearchResult {
                    chat_session_id: row.get("chat_session_id")?,
                    session_title: row.get("title")?,
                    message_id: Some(row.get("id")?),
                    snippet: row.get("snip")?,
                    role: row.get("role")?,
                    created_at: row.get("created_at")?,
                    last_active_at: row.get("last_active_at")?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use super::*;

    #[test]
    fn chat_session_and_messages_round_trip() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        assert_eq!(cs.provider, "anthropic");
        assert_eq!(cs.model, "claude-sonnet-4-5");
        assert!(cs.title.is_none());

        update_chat_session_title(&conn, &cs.id, "my chat").unwrap();
        touch_chat_session(&conn, &cs.id).unwrap();
        let cs2 = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(cs2.title.as_deref(), Some("my chat"));
        assert!(cs2.last_active_at >= cs.last_active_at);

        let m1 = add_chat_message(&conn, &cs.id, "user", "hello", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();
        assert_eq!(m1.role, "user");
        let m2 = add_chat_message(&conn, &cs.id, "assistant", "hi there", Some(100), Some(50), Some(0.0015), None, None, None, None, None, None, Some(100), Some(130), None, None, None, None).unwrap();
        assert_eq!(m2.input_tokens, Some(100));
        assert_eq!(m2.output_tokens, Some(50));
        assert!((m2.cost_usd.unwrap() - 0.0015).abs() < 1e-9);
        assert_eq!(m2.started_at, Some(100));
        assert_eq!(m2.completed_at, Some(130));

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
    fn delete_empty_sessions_sweeps_only_messageless_unstarred() {
        let conn = super::super::mem();
        let empty_a = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        let empty_b = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        let empty_starred = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        set_chat_session_starred(&conn, &empty_starred.id, true).unwrap();
        let with_msgs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        add_chat_message(&conn, &with_msgs.id, "user", "hello", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();

        // Keep empty_a (the one being restored) — sweep the rest.
        let n = delete_empty_chat_sessions(&conn, Some(&empty_a.id)).unwrap();
        assert_eq!(n, 1, "only empty_b should be swept");
        assert!(get_chat_session(&conn, &empty_a.id).unwrap().is_some());
        assert!(get_chat_session(&conn, &empty_b.id).unwrap().is_none());
        assert!(get_chat_session(&conn, &empty_starred.id).unwrap().is_some());
        assert!(get_chat_session(&conn, &with_msgs.id).unwrap().is_some());

        // With no keep, remaining empties (except starred) go too.
        let n = delete_empty_chat_sessions(&conn, None).unwrap();
        assert_eq!(n, 1);
        assert!(get_chat_session(&conn, &empty_a.id).unwrap().is_none());
        assert!(get_chat_session(&conn, &empty_starred.id).unwrap().is_some());
        assert!(get_chat_session(&conn, &with_msgs.id).unwrap().is_some());
    }

    #[test]
    fn watch_mode_persists_and_restores() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
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

    #[test]
    fn agent_persists_and_restores() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        // New sessions start unselected (None = locked model chip).
        assert!(cs.agent.is_none());

        // Selecting a CLI agent persists and round-trips through both reads.
        update_chat_session_agent(&conn, &cs.id, Some("harness:claude_code")).unwrap();
        let reloaded = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(reloaded.agent.as_deref(), Some("harness:claude_code"));
        let listed = list_chat_sessions(&conn).unwrap();
        assert_eq!(listed[0].agent.as_deref(), Some("harness:claude_code"));

        // Built-in / local selections persist too.
        update_chat_session_agent(&conn, &cs.id, Some("builtin")).unwrap();
        assert_eq!(
            get_chat_session(&conn, &cs.id).unwrap().unwrap().agent.as_deref(),
            Some("builtin")
        );
        update_chat_session_agent(&conn, &cs.id, Some("local")).unwrap();
        assert_eq!(
            get_chat_session(&conn, &cs.id).unwrap().unwrap().agent.as_deref(),
            Some("local")
        );

        // Clearing (None) returns the session to the unselected state.
        update_chat_session_agent(&conn, &cs.id, None).unwrap();
        assert!(get_chat_session(&conn, &cs.id).unwrap().unwrap().agent.is_none());
    }

    #[test]
    fn delete_chat_message_removes_row_and_detaches_artifacts() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let m1 = add_chat_message(&conn, &cs.id, "user", "hi", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let m2 =
            add_chat_message(&conn, &cs.id, "assistant", "hello", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();

        // Attach an artifact to the assistant message we'll delete.
        let art = super::super::insert_artifact(
            &conn,
            Some(&cs.id),
            "report.docx",
            "/tmp/report.docx",
            "docx",
        )
        .unwrap();
        super::super::attach_artifacts_to_message(&conn, &cs.id, m2.id).unwrap();
        let linked: Option<i64> = conn
            .query_row(
                "SELECT chat_message_id FROM artifacts WHERE id = ?1",
                rusqlite::params![art.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, Some(m2.id));

        // Delete m2 — row gone, artifact row+file preserved but unlinked.
        assert!(delete_chat_message(&conn, m2.id).unwrap());
        assert!(list_chat_messages(&conn, &cs.id)
            .unwrap()
            .iter()
            .all(|m| m.id != m2.id));
        let after: Option<i64> = conn
            .query_row(
                "SELECT chat_message_id FROM artifacts WHERE id = ?1",
                rusqlite::params![art.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, None);
        // Artifact file path still in the table.
        let still_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM artifacts WHERE id = ?1",
                rusqlite::params![art.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still_present, 1);

        // m1 is untouched.
        let remaining = list_chat_messages(&conn, &cs.id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, m1.id);

        // Unknown id is a no-op, not an error.
        assert!(!delete_chat_message(&conn, 9999).unwrap());
    }

    // Insert a plain message with only the fields FTS tests care about.
    fn add_msg(conn: &Connection, session: &str, role: &str, content: &str) -> ChatMessageRecord {
        add_chat_message(
            conn, session, role, content, None, None, None, None, None, None, None, None, None,
            None, None, None, None, None, None,
        )
        .unwrap()
    }

    #[test]
    fn fts_finds_content_across_sessions_with_prefix_match() {
        let conn = super::super::mem();
        let a = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let b = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        update_chat_session_title(&conn, &a.id, "rust work").unwrap();
        add_msg(&conn, &a.id, "user", "how do I stream tokens from the API?");
        add_msg(&conn, &b.id, "user", "unrelated cooking question");

        // Prefix query: "stream" must hit "streaming".
        add_msg(&conn, &b.id, "assistant", "streaming responses use SSE");
        let hits = search_chat_messages(&conn, "stream", 10).unwrap();
        assert_eq!(hits.len(), 2, "both streaming messages should match");
        assert!(hits.iter().all(|h| h.message_id.is_some()));
        assert!(hits.iter().any(|h| h.chat_session_id == a.id));
        assert!(hits.iter().any(|h| h.chat_session_id == b.id));
        let snippet = hits[0].snippet.as_deref().unwrap_or("");
        assert!(snippet.contains("stream"), "snippet should carry context: {snippet}");

        // No match anywhere → empty, not an error.
        assert!(search_chat_messages(&conn, "zzzznothing", 10).unwrap().is_empty());
        // Empty/whitespace query short-circuits.
        assert!(search_chat_messages(&conn, "   ", 10).unwrap().is_empty());
    }

    #[test]
    fn fts_matches_session_titles_without_message_hit() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        update_chat_session_title(&conn, &cs.id, "Deploy the relay server").unwrap();
        add_msg(&conn, &cs.id, "user", "ok");

        let hits = search_chat_messages(&conn, "relay", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chat_session_id, cs.id);
        assert!(hits[0].message_id.is_none(), "title-only hit has no message");
        assert_eq!(hits[0].session_title.as_deref(), Some("Deploy the relay server"));

        // LIKE wildcards in the query must be literal, not pattern syntax.
        assert!(search_chat_messages(&conn, "100%", 10).unwrap().is_empty());
    }

    #[test]
    fn fts_excludes_superseded_and_tracks_edits_and_deletes() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let m1 = add_msg(&conn, &cs.id, "user", "the quixotic buffer overflowed");
        let m2 = add_msg(&conn, &cs.id, "assistant", "quixotic indeed, retrying");
        mark_superseded(&conn, &[m1.id], m2.id).unwrap();

        // Superseded rows are folded into a summary — not searchable.
        let hits = search_chat_messages(&conn, "quixotic", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, Some(m2.id));

        // Content edits re-index via the UPDATE trigger.
        conn.execute(
            "UPDATE chat_messages SET content = 'patched answer' WHERE id = ?1",
            rusqlite::params![m2.id],
        )
        .unwrap();
        assert!(search_chat_messages(&conn, "quixotic", 10).unwrap().is_empty());
        assert_eq!(search_chat_messages(&conn, "patched", 10).unwrap().len(), 1);

        // Deletes drop the row from the index.
        delete_chat_message(&conn, m2.id).unwrap();
        assert!(search_chat_messages(&conn, "patched", 10).unwrap().is_empty());
    }

    #[test]
    fn fts_query_syntax_junk_is_sanitized() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        add_msg(&conn, &cs.id, "user", "plain message about anchors");

        // FTS5 operators / punctuation must not parse as query syntax.
        for junk in [
            "\"unclosed",
            "AND OR NOT NEAR",
            "content:foo",
            "anchors)",
            "*",
            "!!! ---",
            "anchors AND \"",
        ] {
            let _ = search_chat_messages(&conn, junk, 10).unwrap();
        }
        // A real term buried in junk still matches.
        let hits = search_chat_messages(&conn, "\"anchors\" (", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn fts_backfill_migration_indexes_preexisting_rows() {
        // Simulate a pre-FTS database: build the schema, drop the FTS objects,
        // insert rows directly, then re-run configure() and confirm the
        // rebuild backfilled the index.
        let conn = super::super::mem();
        conn.execute_batch(
            "DROP TRIGGER chat_messages_fts_ai;
             DROP TRIGGER chat_messages_fts_ad;
             DROP TRIGGER chat_messages_fts_au;
             DROP TABLE chat_messages_fts;",
        )
        .unwrap();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at)
             VALUES (?1, 'user', 'legacy message about flux capacitors', 1)",
            rusqlite::params![cs.id],
        )
        .unwrap();

        super::super::configure(&conn).unwrap();
        let hits = search_chat_messages(&conn, "flux", 10).unwrap();
        assert_eq!(hits.len(), 1, "backfill should index pre-existing rows");
        assert_eq!(hits[0].chat_session_id, cs.id);
    }
}