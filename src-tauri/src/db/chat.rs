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
        // NULL = work in the bound project's working tree; a path = the chat's
        // isolated git worktree (roadmap P0 §3.1.1, branch `relay/<id>`).
        worktree_path: row.get::<_, Option<String>>("worktree_path")?,
        // Falls back to "manual" for rows written before the column existed
        // (the migration adds it nullable); unknown values also read as manual.
        permission_mode: row
            .get::<_, Option<String>>("permission_mode")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "manual".to_string()),
        // New dual-policy columns. Falls back to the legacy-mode-derived
        // preset when the column is absent (old DB rows pre-migration).
        sandbox_policy: row
            .get::<_, Option<String>>("sandbox_policy")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "workspace_write".to_string()),
        approval_policy: row
            .get::<_, Option<String>>("approval_policy")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "on_request".to_string()),
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
    // Default posture is FULL-AUTO (workspace_write + full_access): the
    // built-in/local agent runs tools without per-action approval cards,
    // matching the harness CLIs, which all run headless turns unrestricted
    // (--dangerously-skip-permissions / prompt auto-approve / --auto /
    // --yolo). read_only / plan / auto_edit remain one switch away in the
    // mode menu.
    let now = now_ts();
    let id = new_id();
    conn.execute(
        "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, watch_mode, project_id, permission_mode, sandbox_policy, approval_policy)
         VALUES (?1, NULL, ?2, ?3, ?4, ?4, NULL, ?5, 'full_auto', 'workspace_write', 'full_access')",
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

/// Point a chat at its isolated git worktree (or clear the pointer with
/// `None`). The on-disk worktree itself is created/removed by the command
/// layer (`ensure_chat_session_worktree` / `set_chat_session_worktree`); this
/// function only persists the association.
pub fn set_chat_session_worktree(
    conn: &Connection,
    chat_session_id: &str,
    worktree_path: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET worktree_path = ?2 WHERE id = ?1",
        params![chat_session_id, worktree_path],
    )?;
    Ok(())
}

/// Every recorded chat worktree path for `project_id` (or for all chats when
/// `None`). Used by the command layer to best-effort remove worktree dirs
/// BEFORE the owning rows are deleted (delete paths), so no orphaned linked
/// working trees accumulate on disk.
pub fn chat_worktree_paths(conn: &Connection, project_id: Option<&str>) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT worktree_path FROM chat_sessions
         WHERE worktree_path IS NOT NULL AND worktree_path <> ''
           AND (?1 IS NULL OR project_id = ?1)",
    )?;
    let rows = stmt.query_map(params![project_id], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Delete every chat session bound to a project (and, via FK cascade, its
/// messages). Used when a project is removed from the sidebar. Automation
/// run-log pointers into those sessions are unbound first so no dangling
/// `automations.chat_session_id` survives the bulk delete.
pub fn delete_chat_sessions_for_project(conn: &Connection, project_id: &str) -> DbResult<usize> {
    conn.execute(
        "UPDATE automations SET chat_session_id = NULL
          WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?1)",
        params![project_id],
    )?;
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
    // If this session is an automation's run log, unbind it so the next run
    // recreates a fresh session instead of dying on the chat_messages FK.
    conn.execute(
        "UPDATE automations SET chat_session_id = NULL WHERE chat_session_id = ?1",
        params![chat_session_id],
    )?;
    // Memory evidence for this session (§13.5) — gone with the transcript.
    let _ = conn.execute(
        "DELETE FROM memory_evidence WHERE chat_session_id = ?1",
        params![chat_session_id],
    );
    let _ = crate::db::memory::flag_unbacked_memories(conn);
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
/// starred sessions and sessions bound as an automation's run log are never
/// swept (an automation's log is empty until its first turn writes to it, so
/// sweeping it would leave a dangling `automations.chat_session_id` that
/// fails the next run with "FOREIGN KEY constraint failed").
/// Returns the number of rows deleted.
pub fn delete_empty_chat_sessions(conn: &Connection, keep: Option<&str>) -> DbResult<usize> {
    let n = conn.execute(
        "DELETE FROM chat_sessions
         WHERE starred = 0
           AND id NOT IN (SELECT DISTINCT chat_session_id FROM chat_messages)
           AND id NOT IN (SELECT chat_session_id FROM automations WHERE chat_session_id IS NOT NULL)
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
/// Update a session's legacy permission posture
/// (`read_only` | `manual` | `auto_edit` | `full_auto`). Superseded by
/// `update_chat_session_policies`; retained for export/import compat.
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

/// Update a session's dual sandbox + approval policies atomically.
/// `sandbox` is `read_only` | `workspace_write`; `approval` is `on_request`
/// | `auto_edit` | `full_access`. Also writes the legacy `permission_mode`
/// column for backward compat (derived from the dual policies).
pub fn update_chat_session_policies(
    conn: &Connection,
    chat_session_id: &str,
    sandbox: &str,
    approval: &str,
) -> DbResult<()> {
    let legacy = permission_label_from_policies(sandbox, approval);
    conn.execute(
        "UPDATE chat_sessions SET sandbox_policy = ?2, approval_policy = ?3, permission_mode = ?4 WHERE id = ?1",
        params![chat_session_id, sandbox, approval, legacy],
    )?;
    Ok(())
}

/// The `permission_mode` label that corresponds to a dual-policy pair. Used
/// both by `update_chat_session_policies` (policies changed → label follows)
/// and by `set_chat_session_plan` (plan mode exited → restore the label that
/// matches the policies that were preserved underneath the whole time).
pub fn permission_label_from_policies(sandbox: &str, approval: &str) -> &'static str {
    match (sandbox, approval) {
        ("read_only", _) => "read_only",
        ("workspace_write", "on_request") => "manual",
        ("workspace_write", "auto_edit") => "auto_edit",
        ("workspace_write", "full_access") => "full_auto",
        _ => "manual",
    }
}

/// Enter (`plan = true`) or exit (`plan = false`) plan mode for a session.
/// Plan mode is a LABEL on the legacy `permission_mode` column — the
/// dual-policy columns are intentionally untouched, so the posture the user
/// had before planning (manual / auto_edit / full_auto) is what governs tool
/// calls the moment the plan is approved, with zero restore bookkeeping.
/// Returns the label now stored (the caller emits it to the UI).
pub fn set_chat_session_plan(conn: &Connection, chat_session_id: &str, plan: bool) -> DbResult<String> {
    let label: String = if plan {
        "plan".to_string()
    } else {
        let (sandbox, approval): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT sandbox_policy, approval_policy FROM chat_sessions WHERE id = ?1",
                params![chat_session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((None, None));
        permission_label_from_policies(
            sandbox.as_deref().unwrap_or("workspace_write"),
            approval.as_deref().unwrap_or("on_request"),
        )
        .to_string()
    };
    conn.execute(
        "UPDATE chat_sessions SET permission_mode = ?2 WHERE id = ?1",
        params![chat_session_id, label],
    )?;
    Ok(label)
}

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

/// Attach one connector (or `mcp:<server_id>` gallery server) to a session.
/// Used by the incremental attach paths — the composer's @-mention picker,
/// the send-time keyword fast-path, and the model-driven `attach_connector`
/// tool — where replacing the whole set would drop other attachments.
pub fn add_chat_session_connector(
    conn: &Connection,
    chat_session_id: &str,
    connector_id: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO chat_session_connectors (chat_session_id, connector_id)
         VALUES (?1, ?2)",
        params![chat_session_id, connector_id],
    )?;
    Ok(())
}

/// Detach one connector from a session (the × on a composer attachment chip).
/// Removing an id that isn't attached is a no-op.
pub fn remove_chat_session_connector(
    conn: &Connection,
    chat_session_id: &str,
    connector_id: &str,
) -> DbResult<()> {
    conn.execute(
        "DELETE FROM chat_session_connectors
         WHERE chat_session_id = ?1 AND connector_id = ?2",
        params![chat_session_id, connector_id],
    )?;
    Ok(())
}

/// The working directory the most-recently-active local_gguf session's next
/// send would resolve to (worktree path, else its bound project's path) —
/// used by the prompt warmup to replicate the send path's `## Working
/// directory` system-prompt tail so the cached prefix matches. Returns None
/// when no local session exists or none of the resolution steps yield a path
/// (the warmup then omits the section, matching a send without a working
/// folder). The composer's custom-folder override is frontend-only state and
/// can't be known here; in that case the first send falls back to paying the
/// extra prompt eval.
pub fn latest_local_session_working_root(conn: &Connection) -> DbResult<Option<String>> {
    let row = conn
        .query_row(
            "SELECT cs.worktree_path, cs.project_id
             FROM chat_sessions cs
             WHERE cs.provider = 'local_gguf'
             ORDER BY cs.last_active_at DESC
             LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((worktree_path, project_id)) = row else {
        return Ok(None);
    };
    if let Some(wt) = worktree_path.filter(|p| !p.trim().is_empty()) {
        return Ok(Some(wt));
    }
    if let Some(pid) = project_id.filter(|p| !p.trim().is_empty()) {
        let path = conn
            .query_row(
                "SELECT path FROM projects WHERE id = ?1",
                params![pid],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
            return Ok(Some(p));
        }
    }
    Ok(None)
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

/// The turns a compaction summary folded away — every row superseded BY the
/// given summary row. Backs the context-recovery affordance on the
/// `[compacted context]` marker: the summary is lossy by design, but the raw
/// turns stay in the DB and must stay reachable ("restorable compression").
pub fn list_messages_superseded_by(
    conn: &Connection,
    summary_id: i64,
) -> DbResult<Vec<ChatMessageRecord>> {
    let mut stmt = conn
        .prepare("SELECT * FROM chat_messages WHERE superseded_by = ?1 ORDER BY id")?;
    let rows = stmt.query_map(params![summary_id], map_chat_message)?;
    rows.collect()
}

/// Delete a single chat message row by id. Returns `true` if a row was
/// removed, `false` if the id was unknown. Artifacts attributed to this
/// message are detached (their `chat_message_id` is nulled) rather than
/// deleted — the file artifacts themselves stay around and can be re-attributed
/// or expired on the normal 30-day sweep, so a user who deletes the last
/// assistant message of a turn doesn't lose generated files.
pub fn delete_chat_message(conn: &Connection, message_id: i64) -> DbResult<bool> {
    // B-29/B-31: one transaction — delete the row, detach artifact links, AND
    // release any compaction fold pointing at it. `superseded_by` has no FK,
    // so deleting the summary row used to leave the folded messages pointing
    // at a ghost id — permanently excluded from `list_active_chat_messages`
    // (the model's context) while still rendering in the timeline.
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "DELETE FROM chat_messages WHERE id = ?1",
        params![message_id],
    )?;
    if changed > 0 {
        // Memory evidence (MEMORY_DESIGN_ARCHITECTURE.md §13.5): the deleted
        // message can no longer back a memory — drop its evidence rows and
        // flag memories left with none (excluded from injection until the
        // user reviews them in Settings → Memory).
        tx.execute(
            "DELETE FROM memory_evidence WHERE chat_message_id = ?1",
            params![message_id],
        )?;
        crate::db::memory::flag_unbacked_memories(&tx)?;
        // Drop any FK-style link to this message; the artifact row/file
        // itself stays (see doc comment above).
        let _ = tx.execute(
            "UPDATE artifacts SET chat_message_id = NULL WHERE chat_message_id = ?1",
            params![message_id],
        );
        // B-31: un-fold messages whose anchor was this (summary) row.
        tx.execute(
            "UPDATE chat_messages SET superseded_by = NULL WHERE superseded_by = ?1",
            params![message_id],
        )?;
    }
    tx.commit()?;
    Ok(changed > 0)
}

/// Delete every message with id strictly greater than `after_id` in a
/// session — the conversation-rollback half of checkpoint restore (undo
/// turns N+1.., keep the checkpointed turn and everything before it).
/// `None` deletes the session's whole conversation (restore to the pre-chat
/// baseline). Artifacts attributed to the removed messages are detached
/// (not deleted — same policy as `delete_chat_message`). Returns the number
/// of rows deleted.
pub fn delete_chat_messages_after(
    conn: &Connection,
    chat_session_id: &str,
    after_id: Option<i64>,
) -> DbResult<i64> {
    // Detach artifacts BEFORE deleting so the subquery still sees the rows.
    let _ = conn.execute(
        "UPDATE artifacts SET chat_message_id = NULL
         WHERE chat_message_id IN (
             SELECT id FROM chat_messages
             WHERE chat_session_id = ?1 AND (?2 IS NULL OR id > ?2)
         )",
        params![chat_session_id, after_id],
    );
    // Memory evidence for the doomed messages (§13.5) — same subquery.
    let _ = conn.execute(
        "DELETE FROM memory_evidence
         WHERE chat_session_id = ?1 AND chat_message_id IN (
             SELECT id FROM chat_messages
             WHERE chat_session_id = ?1 AND (?2 IS NULL OR id > ?2)
         )",
        params![chat_session_id, after_id],
    );
    let _ = crate::db::memory::flag_unbacked_memories(conn);
    let changed = match after_id {
        Some(after) => conn.execute(
            "DELETE FROM chat_messages WHERE chat_session_id = ?1 AND id > ?2",
            params![chat_session_id, after],
        )?,
        None => conn.execute(
            "DELETE FROM chat_messages WHERE chat_session_id = ?1",
            params![chat_session_id],
        )?,
    };
    Ok(changed as i64)
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

/// Retire a conversation branch: mark `from_message_id` AND every later row of
/// the session as superseded (edit-to-fork branching, roadmap #9). Unlike
/// [`mark_superseded`] (which points at a compaction summary), `superseded_by`
/// here points at the fork-point row itself — the first row of the retired
/// branch — so the UI can find where an old version diverged. Rows already
/// superseded (e.g. compaction-folded) are left untouched, keeping the
/// original fold reference intact. Returns how many rows were retired.
pub fn mark_branch_superseded(
    conn: &Connection,
    chat_session_id: &str,
    from_message_id: i64,
) -> DbResult<usize> {
    let n = conn.execute(
        "UPDATE chat_messages SET superseded_by = ?3
          WHERE chat_session_id = ?1 AND id >= ?2 AND superseded_by IS NULL",
        params![chat_session_id, from_message_id, from_message_id],
    )?;
    // Edit-to-fork is a user correction: close the session's open artifact
    // runs as 'corrected' (SELF_IMPROVING_ARTIFACTS.md §5.3). Best-effort —
    // telemetry must never fail the branch operation.
    if n > 0 {
        let _ = super::improve::finish_session_runs(conn, chat_session_id, "corrected", None);
    }
    Ok(n)
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
    fn sweeper_skips_run_logs_and_delete_unbinds_automation_pointer() {
        let conn = super::super::mem();

        let automation = crate::db::create_automation(
            &conn,
            &crate::db::AutomationInput {
                name: "nightly".into(),
                prompt: "p".into(),
                harness: "claude_code".into(),
                model: None,
                cwd: None,
                schedule: "* * * * *".into(),
                enabled: Some(true),
            },
        )
        .unwrap();
        // Bind a still-EMPTY session as the automation's run log.
        let run_log = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        crate::db::set_automation_chat_session(&conn, &automation.id, Some(&run_log.id)).unwrap();
        // A plain empty session beside it.
        let plain = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();

        // The sweep removes the plain empty chat but never the run log (it
        // stays message-less until its first turn writes to it).
        assert_eq!(delete_empty_chat_sessions(&conn, None).unwrap(), 1);
        assert!(get_chat_session(&conn, &plain.id).unwrap().is_none());
        assert!(get_chat_session(&conn, &run_log.id).unwrap().is_some());

        // Deleting the run-log chat by hand unbinds the pointer instead of
        // leaving automations.chat_session_id dangling.
        delete_chat_session(&conn, &run_log.id).unwrap();
        let reloaded = crate::db::get_automation(&conn, &automation.id).unwrap().unwrap();
        assert_eq!(reloaded.chat_session_id, None);
    }

    #[test]
    fn plan_mode_label_round_trips_and_restores_posture() {
        let conn = super::super::mem();
        // Fresh sessions start full-auto (workspace_write + full_access).
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        assert_eq!(cs.permission_mode, "full_auto");

        // Entering plan flips the label to "plan"; the dual-policy columns
        // are untouched (that's the whole point — approval resumes them).
        let label = set_chat_session_plan(&conn, &cs.id, true).unwrap();
        assert_eq!(label, "plan");
        let read = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(read.permission_mode, "plan");
        assert_eq!(read.sandbox_policy, "workspace_write");
        assert_eq!(read.approval_policy, "full_access");

        // Exiting restores the label derived from the preserved policies.
        let label = set_chat_session_plan(&conn, &cs.id, false).unwrap();
        assert_eq!(label, "full_auto");
        let read = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(read.permission_mode, "full_auto");

        // A session whose real posture is auto_edit restores to auto_edit,
        // not manual.
        update_chat_session_policies(&conn, &cs.id, "workspace_write", "auto_edit").unwrap();
        set_chat_session_plan(&conn, &cs.id, true).unwrap();
        let label = set_chat_session_plan(&conn, &cs.id, false).unwrap();
        assert_eq!(label, "auto_edit");
    }

    #[test]
    fn worktree_path_defaults_null_and_round_trips() {
        let conn = super::super::mem();
        // Fresh sessions have no worktree pointer.
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        assert_eq!(cs.worktree_path, None);

        // Set persists and reads back through the mapper (the migration that
        // adds the column runs inside mem(), so this also covers the schema).
        set_chat_session_worktree(&conn, &cs.id, Some("D:/proj/relay-abc12345")).unwrap();
        let read = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(read.worktree_path.as_deref(), Some("D:/proj/relay-abc12345"));

        // Clear reads back as None.
        set_chat_session_worktree(&conn, &cs.id, None).unwrap();
        let read = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(read.worktree_path, None);

        // chat_worktree_paths only surfaces non-null values.
        assert!(chat_worktree_paths(&conn, None).unwrap().is_empty());
        set_chat_session_worktree(&conn, &cs.id, Some("D:/proj/relay-abc12345")).unwrap();
        assert_eq!(chat_worktree_paths(&conn, None).unwrap(), vec!["D:/proj/relay-abc12345"]);
    }

    #[test]
    fn permission_mode_defaults_full_auto_and_updates() {
        let conn = super::super::mem();
        // New sessions start full-auto.
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        assert_eq!(cs.permission_mode, "full_auto");
        assert_eq!(cs.sandbox_policy, "workspace_write");
        assert_eq!(cs.approval_policy, "full_access");

        // Update persists and reads back through the mapper.
        update_chat_session_permission_mode(&conn, &cs.id, "full_auto").unwrap();
        let cs2 = get_chat_session(&conn, &cs.id).unwrap().unwrap();
        assert_eq!(cs2.permission_mode, "full_auto");

        // Legacy/unknown values fail closed to manual.
        conn.execute("UPDATE chat_sessions SET permission_mode = NULL WHERE id = ?1", params![cs.id]).unwrap();
        assert_eq!(get_chat_session(&conn, &cs.id).unwrap().unwrap().permission_mode, "manual");
        conn.execute("UPDATE chat_sessions SET permission_mode = 'bogus' WHERE id = ?1", params![cs.id]).unwrap();
        assert_eq!(get_chat_session(&conn, &cs.id).unwrap().unwrap().permission_mode, "bogus");
        // ("bogus" survives the mapping — the fail-closed parse lives in
        // PermissionMode::from_db at the send site.)
    }

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

    #[test]
    fn delete_chat_messages_after_trims_later_turns_and_detaches_artifacts() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let m1 = add_chat_message(&conn, &cs.id, "user", "hi", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let m2 = add_chat_message(&conn, &cs.id, "assistant", "hello", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let m3 = add_chat_message(&conn, &cs.id, "user", "do it", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();
        let m4 = add_chat_message(&conn, &cs.id, "assistant", "done", None, None, None, None, None, None, None, None, None, None, None, None, None, None, None).unwrap();

        // Artifact attributed to a message the rollback will remove.
        let art = super::super::insert_artifact(
            &conn,
            Some(&cs.id),
            "report.docx",
            "/tmp/report.docx",
            "docx",
        )
        .unwrap();
        super::super::attach_artifacts_to_message(&conn, &cs.id, m4.id).unwrap();

        // Roll back to the m2 turn: strictly-greater ids are removed, the
        // checkpointed turn and everything before it stay.
        assert_eq!(delete_chat_messages_after(&conn, &cs.id, Some(m2.id)).unwrap(), 2);
        let rest = list_chat_messages(&conn, &cs.id).unwrap();
        assert_eq!(rest.len(), 2);
        assert_eq!(rest[0].id, m1.id);
        assert_eq!(rest[1].id, m2.id);
        // Artifact row survives, unlinked (same policy as single delete).
        let linked: Option<i64> = conn
            .query_row(
                "SELECT chat_message_id FROM artifacts WHERE id = ?1",
                rusqlite::params![art.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, None);

        // None wipes the whole conversation (restore to the pre-chat baseline).
        assert_eq!(delete_chat_messages_after(&conn, &cs.id, None).unwrap(), 2);
        assert!(list_chat_messages(&conn, &cs.id).unwrap().is_empty());
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

    #[test]
    fn branch_supersede_retires_fork_point_and_tail_only() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let m1 = add_msg(&conn, &cs.id, "user", "first question");
        let m2 = add_msg(&conn, &cs.id, "assistant", "first answer");
        let m3 = add_msg(&conn, &cs.id, "user", "second question");
        let m4 = add_msg(&conn, &cs.id, "assistant", "second answer");

        // Edit-to-fork from m3: m3 + m4 retire; m1/m2 stay active.
        let n = mark_branch_superseded(&conn, &cs.id, m3.id).unwrap();
        assert_eq!(n, 2);
        let active = list_active_chat_messages(&conn, &cs.id).unwrap();
        assert_eq!(active.len(), 2);
        assert_eq!(active[0].id, m1.id);
        assert_eq!(active[1].id, m2.id);
        // superseded_by points at the fork-point row (m3 itself).
        let all = list_chat_messages(&conn, &cs.id).unwrap();
        assert_eq!(all[2].superseded_by, Some(m3.id));
        assert_eq!(all[3].superseded_by, Some(m3.id));
        assert_eq!(all[0].superseded_by, None);
        assert_eq!(all[1].superseded_by, None);
    }

    #[test]
    fn branch_supersede_is_session_scoped() {
        let conn = super::super::mem();
        let a = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let b = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let a1 = add_msg(&conn, &a.id, "user", "a1");
        let b1 = add_msg(&conn, &b.id, "user", "b1");

        // Superseding session a's tail must not touch session b (ids are
        // global autoincrement, so the id >= guard alone would catch b1).
        let n = mark_branch_superseded(&conn, &a.id, a1.id).unwrap();
        assert_eq!(n, 1);
        assert_eq!(list_active_chat_messages(&conn, &b.id).unwrap().len(), 1);
    }

    #[test]
    fn branch_supersede_keeps_compaction_folds_intact() {
        let conn = super::super::mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let m1 = add_msg(&conn, &cs.id, "user", "old turn");
        let summary = add_msg(&conn, &cs.id, "system", "[compacted context]

summary");
        // Compaction folded m1 into the summary row.
        mark_superseded(&conn, &[m1.id], summary.id).unwrap();
        let m3 = add_msg(&conn, &cs.id, "user", "after compaction");

        // Branch-fork from m3: m1 must KEEP pointing at the summary (not be
        // re-pointed at the fork row); only m3 retires.
        let n = mark_branch_superseded(&conn, &cs.id, m3.id).unwrap();
        assert_eq!(n, 1);
        let all = list_chat_messages(&conn, &cs.id).unwrap();
        assert_eq!(all[0].superseded_by, Some(summary.id));
        assert_eq!(all[1].superseded_by, None); // summary stays active
        assert_eq!(all[2].superseded_by, Some(m3.id));
    }
}
