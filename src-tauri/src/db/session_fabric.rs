//! Session Mesh persistence (SESSION_MESH_DESIGN_ARCHITECTURE.md §4-§6).
//!
//! Two stores plus thin accessors over existing tables:
//! - `session_summaries` — the distillation layer (one abstract per chat).
//! - `session_mail` — the point-to-point agent mailbox; every agent-to-agent
//!   exchange is a row, so the mesh's audit trail is plain data.
//! Registry/origin guards read `chat_sessions` directly. Peer transcripts are
//! read through the existing `chat_messages` helpers — never duplicated.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

// ── Mail ──────────────────────────────────────────────────────────────────

pub const MAIL_QUEUED: &str = "queued";
pub const MAIL_DELIVERED: &str = "delivered";
pub const MAIL_ANSWERED: &str = "answered";
pub const MAIL_EXPIRED: &str = "expired";
pub const MAIL_REJECTED: &str = "rejected";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailRow {
    pub id: String,
    pub from_session: String,
    pub to_session: String,
    /// "question" | "notify"
    pub mode: String,
    pub body: String,
    /// queued | delivered | answered | expired | rejected
    pub status: String,
    pub answer: Option<String>,
    pub depth: i64,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
    pub answered_at: Option<i64>,
}

fn map_mail(row: &Row) -> rusqlite::Result<MailRow> {
    Ok(MailRow {
        id: row.get("id")?,
        from_session: row.get("from_session")?,
        to_session: row.get("to_session")?,
        mode: row.get("mode")?,
        body: row.get("body")?,
        status: row.get("status")?,
        answer: row.get("answer")?,
        depth: row.get("depth")?,
        created_at: row.get("created_at")?,
        delivered_at: row.get("delivered_at")?,
        answered_at: row.get("answered_at")?,
    })
}

pub fn insert_mail(
    conn: &Connection,
    from_session: &str,
    to_session: &str,
    mode: &str,
    body: &str,
    depth: i64,
) -> DbResult<MailRow> {
    let row = MailRow {
        id: new_id(),
        from_session: from_session.to_string(),
        to_session: to_session.to_string(),
        mode: mode.to_string(),
        body: body.to_string(),
        status: MAIL_QUEUED.to_string(),
        answer: None,
        depth,
        created_at: now_ts(),
        delivered_at: None,
        answered_at: None,
    };
    conn.execute(
        "INSERT INTO session_mail (id, from_session, to_session, mode, body, status, answer, depth, created_at, delivered_at, answered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, NULL, NULL)",
        params![
            row.id,
            row.from_session,
            row.to_session,
            row.mode,
            row.body,
            row.status,
            row.depth,
            row.created_at
        ],
    )?;
    Ok(row)
}

/// Mail lookup — used by tests today; kept pub(crate) as the accessor for
/// future DB-backed mail history surfaces.
#[cfg_attr(not(test), allow(dead_code))]
pub fn get_mail(conn: &Connection, mail_id: &str) -> DbResult<Option<MailRow>> {
    let mut stmt = conn.prepare("SELECT * FROM session_mail WHERE id = ?1")?;
    stmt.query_row(params![mail_id], map_mail).optional()
}

pub fn set_mail_status(
    conn: &Connection,
    mail_id: &str,
    status: &str,
    answer: Option<&str>,
) -> DbResult<()> {
    let now = now_ts();
    conn.execute(
        "UPDATE session_mail SET status = ?2,
           answer = COALESCE(?3, answer),
           delivered_at = CASE WHEN ?2 = 'delivered' THEN ?4 ELSE delivered_at END,
           answered_at = CASE WHEN ?2 = 'answered' THEN ?4 ELSE answered_at END
         WHERE id = ?1",
        params![mail_id, status, answer, now],
    )?;
    Ok(())
}

/// FIFO queue for a target session — what the mail pump drains once the
/// target goes idle. Cap applied by the caller (guards).
pub fn queued_mail_for(conn: &Connection, to_session: &str) -> DbResult<Vec<MailRow>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM session_mail
          WHERE to_session = ?1 AND status = 'queued'
          ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![to_session], map_mail)?;
    rows.collect()
}

/// Rate-guard input: mails this session sent since `since`.
pub fn count_mail_from_since(conn: &Connection, from_session: &str, since: i64) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM session_mail WHERE from_session = ?1 AND created_at >= ?2",
        params![from_session, since],
        |r| r.get(0),
    )
}

// ── Summaries ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub chat_session_id: String,
    pub summary: String,
    pub topics: String,
    pub model: Option<String>,
    pub updated_at: i64,
}

pub fn get_session_summary(conn: &Connection, sid: &str) -> DbResult<Option<SessionSummary>> {
    let mut stmt = conn
        .prepare("SELECT * FROM session_summaries WHERE chat_session_id = ?1")?;
    stmt.query_row(params![sid], |row| {
        Ok(SessionSummary {
            chat_session_id: row.get("chat_session_id")?,
            summary: row.get("summary")?,
            topics: row.get("topics")?,
            model: row.get("model")?,
            updated_at: row.get("updated_at")?,
        })
    })
    .optional()
}

pub fn upsert_session_summary(
    conn: &Connection,
    sid: &str,
    summary: &str,
    topics: &str,
    model: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO session_summaries (chat_session_id, summary, topics, model, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(chat_session_id) DO UPDATE SET
           summary = excluded.summary, topics = excluded.topics,
           model = excluded.model, updated_at = excluded.updated_at",
        params![sid, summary, topics, model, now_ts()],
    )?;
    Ok(())
}

/// Batch lookup for the registry block: summaries for many sessions at once.
/// One `IN` query (chunked for SQLite's variable limit) instead of a SELECT
/// per peer — the registry rendered up to 50 sequential statements per build
/// (audit L-3).
pub fn summaries_for(conn: &Connection, sids: &[String]) -> DbResult<Vec<SessionSummary>> {
    let mut out = Vec::new();
    for chunk in sids.chunks(50) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT chat_session_id, summary, topics, model, updated_at
               FROM session_summaries WHERE chat_session_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), |r| {
            Ok(SessionSummary {
                chat_session_id: r.get("chat_session_id")?,
                summary: r.get("summary")?,
                topics: r.get("topics")?,
                model: r.get("model")?,
                updated_at: r.get("updated_at")?,
            })
        })?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// Unix timestamp of the session's newest message (0 = no messages yet). The
/// workspace update's "since your last turn" filter compares peer activity
/// against this — messages persist at turn END, so a peer whose
/// `last_active_at` is newer genuinely moved after this session's last
/// completed turn.
pub fn last_message_created_at(conn: &Connection, sid: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(created_at), 0) FROM chat_messages WHERE chat_session_id = ?1",
        params![sid],
        |r| r.get(0),
    )
}

/// Same-workspace sessions (same project — NULL matches NULL, so unbound
/// chats form their own workspace) whose last activity is NEWER than
/// `since`, most recent first. Self excluded by the query. This is the
/// "moved while you were away" set behind the workspace update block.
pub fn peers_active_since(
    conn: &Connection,
    self_sid: &str,
    project_id: Option<&str>,
    since: i64,
    limit: u32,
) -> DbResult<Vec<PeerSessionRow>> {
    let limit = limit.clamp(1, 20) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, title, agent, model, project_id, last_active_at, starred, origin
           FROM chat_sessions
          WHERE id != ?1 AND last_active_at > ?2 AND project_id IS ?3
          ORDER BY last_active_at DESC LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![self_sid, since, project_id, limit], |row| {
        Ok(PeerSessionRow {
            id: row.get("id")?,
            title: row.get("title")?,
            agent: row.get("agent")?,
            model: row.get("model")?,
            project_id: row.get("project_id")?,
            last_active_at: row.get("last_active_at")?,
            starred: row.get::<_, i64>("starred")? != 0,
            origin: row.get("origin")?,
        })
    })?;
    rows.collect()
}

// ── Registry / origin guards ──────────────────────────────────────────────

/// One row of the peer registry — metadata only, no transcripts.
#[derive(Debug, Clone, Serialize)]
pub struct PeerSessionRow {
    pub id: String,
    pub title: Option<String>,
    pub agent: Option<String>,
    pub model: String,
    pub project_id: Option<String>,
    pub last_active_at: i64,
    pub starred: bool,
    pub origin: Option<String>,
}

/// Peers for the registry block and `list_sessions`. Same-project sessions
/// rank first (the awareness default is the session's own project), then
/// starred, then recency. Self is excluded by the caller's WHERE clause.
pub fn list_peer_sessions(
    conn: &Connection,
    self_sid: &str,
    limit: u32,
) -> DbResult<Vec<PeerSessionRow>> {
    let limit = limit.clamp(1, 50) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, title, agent, model, project_id, last_active_at, starred, origin
           FROM chat_sessions
          WHERE id != ?1
          ORDER BY starred DESC, last_active_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![self_sid, limit], |row| {
        Ok(PeerSessionRow {
            id: row.get("id")?,
            title: row.get("title")?,
            agent: row.get("agent")?,
            model: row.get("model")?,
            project_id: row.get("project_id")?,
            last_active_at: row.get("last_active_at")?,
            starred: row.get::<_, i64>("starred")? != 0,
            origin: row.get("origin")?,
        })
    })?;
    rows.collect()
}

/// Abridged session count for the registry block's "one of N" line.
pub fn count_other_sessions(conn: &Connection, self_sid: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM chat_sessions WHERE id != ?1",
        params![self_sid],
        |r| r.get(0),
    )
}

/// Resolve a session id that may be a PREFIX: models copy ids from
/// `list_sessions` output and the registry block, which truncate for token
/// economy — an exact-match-only lookup then fails with "no session" even
/// though the model did everything right. Exact match wins; otherwise a
/// UNIQUE prefix resolves, and an ambiguous prefix names the candidates.
pub fn resolve_session_id(conn: &Connection, input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty session id".to_string());
    }
    let exact = conn
        .query_row(
            "SELECT id FROM chat_sessions WHERE id = ?1",
            params![trimmed],
            |r| r.get::<_, String>(0),
        )
        .ok();
    if let Some(id) = exact {
        return Ok(id);
    }
    // Escape LIKE wildcards in the (model-supplied) input so `%` and `_`
    // match literally — same contract as `search_chat_messages`. Unescaped,
    // a "%%"-bearing probe would sweep every session into the candidate list
    // instead of resolving a real prefix.
    let like = format!(
        "{}%",
        trimmed
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt = conn
        .prepare("SELECT id FROM chat_sessions WHERE id LIKE ?1 ESCAPE '\\' ORDER BY last_active_at DESC")
        .map_err(|e| e.to_string())?;
    let rows: Vec<String> = stmt
        .query_map(params![like], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    match rows.len() {
        0 => Err(format!("no session matches \"{trimmed}\" — call list_sessions for valid ids")),
        1 => Ok(rows[0].clone()),
        _ => Err(format!(
            "\"{trimmed}\" matches {} sessions (e.g. {}, {}) — use a longer prefix or the full id",
            rows.len(),
            &rows[0][..rows[0].len().min(12)],
            &rows[1][..rows[1].len().min(12)],
        )),
    }
}

/// Session title (or a truncated id fallback) for envelopes and events.
pub fn chat_title(conn: &Connection, sid: &str) -> Option<String> {
    conn.query_row(
        "SELECT title FROM chat_sessions WHERE id = ?1",
        params![sid],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .or_else(|| Some(format!("session {}", &sid[..sid.len().min(8)])))
}

pub fn set_chat_session_origin(conn: &Connection, sid: &str, origin: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET origin = ?2 WHERE id = ?1",
        params![sid, origin],
    )?;
    Ok(())
}

/// Spawn-tree depth: walk the `spawned_by:` chain. A human-created session is
/// depth 0; its spawned child 1; a grandchild 2. Guards cap spawning at
/// depth < MESH_MAX_SPAWN_DEPTH so chains can't grow unbounded.
pub fn spawn_depth(conn: &Connection, sid: &str) -> DbResult<i64> {
    let mut depth: i64 = 0;
    let mut current = sid.to_string();
    for _ in 0..8 {
        let origin: Option<String> = conn
            .query_row(
                "SELECT origin FROM chat_sessions WHERE id = ?1",
                params![current],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        match origin {
            Some(o) if o.starts_with("spawned_by:") => {
                depth += 1;
                current = o["spawned_by:".len()..].to_string();
            }
            _ => break,
        }
    }
    Ok(depth)
}

/// Live spawned children of `parent` — sessions it spawned whose last turn
/// is inside `within_secs` (a mesh that finished days ago must not count
/// against today's cap).
pub fn count_recent_spawned_children(
    conn: &Connection,
    parent: &str,
    within_secs: i64,
) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM chat_sessions
          WHERE origin = ?1 AND last_active_at >= ?2",
        params![format!("spawned_by:{parent}"), now_ts() - within_secs],
        |r| r.get(0),
    )
}

/// Global cap input: mesh-spawned sessions active in the last day.
pub fn count_active_spawned(conn: &Connection, within_secs: i64) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM chat_sessions
          WHERE origin LIKE 'spawned_by:%' AND last_active_at >= ?1",
        params![now_ts() - within_secs],
        |r| r.get(0),
    )
}

// ── Transcript access ─────────────────────────────────────────────────────

/// The newest assistant message written after `after_id` — the answer to a
/// delivered mail/question (the delivery records the watermark before the
/// envelope turn starts).
pub fn last_assistant_message_after(
    conn: &Connection,
    sid: &str,
    after_id: i64,
) -> DbResult<Option<String>> {
    conn.query_row(
        "SELECT content FROM chat_messages
          WHERE chat_session_id = ?1 AND role = 'assistant' AND id > ?2
          ORDER BY id DESC LIMIT 1",
        params![sid, after_id],
        |r| r.get(0),
    )
    .optional()
}

/// Highest message id in a session — the delivery watermark.
pub fn max_message_id(conn: &Connection, sid: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE chat_session_id = ?1",
        params![sid],
        |r| r.get(0),
    )
}

/// Role-tagged, char-capped recent transcript for `read_session`.
pub fn transcript_excerpt(
    conn: &Connection,
    sid: &str,
    max_messages: u32,
    max_chars: usize,
) -> DbResult<String> {
    let mut stmt = conn.prepare(
        "SELECT role, content FROM chat_messages
          WHERE chat_session_id = ?1 AND superseded_by IS NULL
          ORDER BY id DESC LIMIT ?2",
    )?;
    let mut lines: Vec<String> = Vec::new();
    let rows = stmt.query_map(params![sid, max_messages.clamp(1, 100) as i64], |r| {
        let role: String = r.get(0)?;
        let content: String = r.get(1)?;
        Ok((role, content))
    })?;
    for row in rows {
        let (role, content) = row?;
        let trimmed = crate::util::truncate_chars(content.trim(), 1200);
        lines.push(format!("[{role}] {trimmed}"));
    }
    lines.reverse();
    let mut out = lines.join("\n\n");
    if out.chars().count() > max_chars {
        out = crate::util::truncate_chars(&out, max_chars);
    }
    Ok(out)
}

/// User-turn count — the summary worker skips sessions with fewer than two
/// (a one-line chat needs no abstract).
pub fn count_user_messages(conn: &Connection, sid: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM chat_messages
          WHERE chat_session_id = ?1 AND role = 'user' AND superseded_by IS NULL",
        params![sid],
        |r| r.get(0),
    )
}

/// Recent turns for the summarizer prompt (oldest → newest, capped).
pub fn transcript_for_summary(conn: &Connection, sid: &str) -> DbResult<String> {
    transcript_excerpt(conn, sid, 24, 12_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE chat_sessions (
               id TEXT PRIMARY KEY, title TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
               created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
               starred INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
               watch_mode TEXT, agent TEXT, project_id TEXT, permission_mode TEXT,
               worktree_path TEXT, sandbox_policy TEXT, approval_policy TEXT,
               auto_model INTEGER NOT NULL DEFAULT 0, effort_level TEXT, origin TEXT);",
        )
        .unwrap();
        c
    }

    fn seed(c: &Connection, id: &str) {
        c.execute(
            "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at)
             VALUES (?1, 't', 'anthropic', 'm', 1, 2)",
            params![id],
        )
        .unwrap();
    }

    #[test]
    fn resolve_session_id_exact_prefix_and_errors() {
        let c = conn();
        let full = "d003e42a-1962-4a11-9f0e-abcdef000001";
        let other = "d003e42a-9999-4a11-9f0e-abcdef000002";
        let unrelated = "aaaa1111-0000-4a11-9f0e-abcdef000003";
        seed(&c, full);
        seed(&c, other);
        seed(&c, unrelated);

        // Exact id wins even though prefixes collide.
        assert_eq!(resolve_session_id(&c, full).unwrap(), full);
        // Ambiguous prefix → named error, not a wrong session.
        let err = resolve_session_id(&c, "d003e42a").err().unwrap();
        assert!(err.contains("matches 2 sessions"), "{err}");
        // Disambiguated prefix resolves.
        assert_eq!(resolve_session_id(&c, "d003e42a-9999").unwrap(), other);
        // The ambiguous-looking list truncation of `full` is actually unique.
        assert_eq!(resolve_session_id(&c, "d003e42a-196").unwrap(), full);
        // Unique short prefix resolves (the list_sessions truncation case).
        assert_eq!(resolve_session_id(&c, "aaaa1111").unwrap(), unrelated);
        // No match → actionable error.
        assert!(resolve_session_id(&c, "zzzz").err().unwrap().contains("list_sessions"));
        assert!(resolve_session_id(&c, "  ").is_err());
    }

    #[test]
    fn resolve_session_id_escapes_like_wildcards() {
        let c = conn();
        // "abc%wild" starts with a literal `%`, "abcxplain" differs after the
        // prefix letters — unescaped, "abc%" and "abc_" would each wildcard-
        // match BOTH rows and report a bogus ambiguity.
        seed(&c, "abc%wild");
        seed(&c, "abcxplain");

        // A literal `%` in the input matches only the row that actually has
        // one at that position.
        assert_eq!(resolve_session_id(&c, "abc%").unwrap(), "abc%wild");
        // A literal `_` matches nothing here (the old pattern treated it as a
        // one-char wildcard and "resolved" the wrong row / a false ambiguity).
        assert!(resolve_session_id(&c, "abc_").is_err());
        // Escaping must not break ordinary prefix resolution.
        assert_eq!(resolve_session_id(&c, "abcx").unwrap(), "abcxplain");
        // A backslash in the input is itself escaped, not an escape char.
        seed(&c, "bs\\id");
        assert_eq!(resolve_session_id(&c, "bs\\").unwrap(), "bs\\id");
    }
}
