//! Session Mesh runtime (SESSION_MESH_DESIGN_ARCHITECTURE.md).
//!
//! Cross-session awareness, messaging, and spawning for Relay chats. One
//! dispatcher serves both agent families: the built-in loop routes through
//! `chat::dispatch::run_tool`, and harness CLIs reach the same function via
//! the `relay-tools` MCP bridge (`mcp_tools_bridge::execute_relay_tool`) —
//! identical to how the automation family works.
//!
//! Mechanics worth knowing before editing:
//! - **No turn-end hooks.** Drain (queued mail) and answer capture poll the
//!   session's busy state (`ChatManager` stream map / `AgentSessionManager`
//!   `turn_in_flight`) instead of instrumenting the five different turn-end
//!   sites across harness readers. One pump per target, one watcher per
//!   delivered question.
//! - **Delivery reuses the target's own send path** (`AgentSessionManager::
//!   send` for harness, `send_chat_message` for built-in), so persistence,
//!   streaming, worktrees, and approvals all come free.
//! - **Every exchange is a `session_mail` row** — the audit trail is plain
//!   data, and the UI renders both sides from the same row.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::session_fabric as store;
use crate::DbState;
use crate::types::{SessionMailPayload, SessionSpawnPayload};

/// Guard caps (SESSION_MESH_DESIGN_ARCHITECTURE.md §5.2/§6.1). Deliberately
/// small: a runaway mesh must hit a cap within seconds, and the mail table
/// shows exactly where it went.
const MAX_MAIL_CHARS: usize = 8_000;
const MAX_MAIL_PER_HOUR: i64 = 10;
const MAX_QUEUE_DEPTH: usize = 5;
const MAX_SPAWN_DEPTH: i64 = 2;
const MAX_CHILDREN_PER_PARENT: i64 = 3;
const CHILDREN_WINDOW_SECS: i64 = 24 * 3600;
const MAX_ACTIVE_SPAWNED: i64 = 8;
const QUESTION_TIMEOUT_DEFAULT: u64 = 25;
const QUESTION_TIMEOUT_MAX: u64 = 120;
/// Hard watcher ceiling: a question whose answer never arrives stops
/// occupying a watcher (the mail row expires; the asker sees that in
/// list/read output).
const WATCHER_CEILING_SECS: u64 = 15 * 60;
const PUMP_CEILING_SECS: u64 = 30 * 60;
const POLL_MS: u64 = 400;

// ── Settings ──────────────────────────────────────────────────────────────

/// Master switch. Default ON: awareness is read-only and messaging/spawning
/// are capped + fully visible; the Settings toggle exists to turn the whole
/// surface off in one place.
pub fn mesh_enabled(conn: &Connection) -> bool {
    crate::db::get_setting(conn, "sessionMesh.enabled")
        .ok()
        .flatten()
        .map(|v| !matches!(v.trim(), "false" | "0" | "off"))
        .unwrap_or(true)
}

fn mesh_disabled_note() -> String {
    "Session Mesh is disabled in Settings — tell the user; don't retry."
        .to_string()
}

/// Harness families that carry the relay-tools MCP server through per-turn
/// Relay-owned config files (claude/kimi/opencode). commandcode carries it
/// too — but via a registration in its OWN config (`ensure_commandcode_
/// bridge`, verified dynamically per turn since there is no per-turn config
/// flag), and pi/omp have no MCP support at all, so every prompt that
/// advertises message_session/spawn_session must be gated on what the
/// caller actually verified. Advertising the tools to a CLI that doesn't
/// have them produced exactly that: the model correctly reporting
/// "I have no relay-tools session spawn".
pub fn harness_has_relay_tools(harness: &str) -> bool {
    matches!(harness, "claude_code" | "kimi_code" | "opencode")
}

// ── Runtime state ─────────────────────────────────────────────────────────

/// Tauri-managed mesh runtime. Everything here is process-local bookkeeping;
/// durable state lives in SQLite.
pub struct FabricRuntime {
    /// mail_id → resolver. A `question`-mode tool call parks its sender here;
    /// the delivery watcher resolves it when the target's answer lands.
    answer_waiters: Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>,
    /// Target session ids with a live drain pump (never two pumps for one
    /// session).
    pumps: Mutex<HashSet<String>>,
}

impl Default for FabricRuntime {
    fn default() -> Self {
        Self {
            answer_waiters: Mutex::new(HashMap::new()),
            pumps: Mutex::new(HashSet::new()),
        }
    }
}

#[derive(Clone)]
pub struct FabricState(pub Arc<FabricRuntime>);

// ── Registry block (standing awareness injection) ─────────────────────────

/// Compact peer registry for the system prompt / harness bundle. Same-project
/// sessions rank first, then starred, then recency (mirrors `list_sessions`).
/// Budget: ~600 tokens — one line per peer, capped at 8, summaries truncated.
/// `self_sid` states the caller's identity so harness CLIs can address mesh
/// calls — the per-chat built-in prompt passes Some(id); the SHARED
/// per-project harness bundle passes None and the per-turn assembly adds the
/// identity line instead. Returns None when disabled or this is the only
/// session.
pub fn registry_block(conn: &Connection, self_sid: Option<&str>) -> Option<String> {
    if !mesh_enabled(conn) {
        return None;
    }
    let total = store::count_other_sessions(conn, self_sid.unwrap_or("")).ok()?;
    if total == 0 {
        return None;
    }
    let peers = store::list_peer_sessions(conn, self_sid.unwrap_or(""), 24).ok()?;
    if peers.is_empty() {
        return None;
    }
    let self_project = self_sid
        .and_then(|sid| crate::db::get_chat_session(conn, sid).ok().flatten())
        .and_then(|s| s.project_id);
    let summaries = {
        let ids: Vec<String> = peers.iter().map(|p| p.id.clone()).collect();
        store::summaries_for(conn, &ids).unwrap_or_default()
    };
    let summary_of = |sid: &str| -> Option<String> {
        summaries
            .iter()
            .find(|s| s.chat_session_id == sid)
            .map(|s| s.summary.clone())
    };

    let same_project: Vec<_> = peers
        .iter()
        .filter(|p| self_project.is_some() && p.project_id == self_project)
        .collect();
    let others: Vec<_> = peers
        .iter()
        .filter(|p| !(self_project.is_some() && p.project_id == self_project))
        .collect();

    let mut lines = Vec::new();
    for p in same_project.iter().chain(others.iter()).take(8) {
        let title = p
            .title
            .clone()
            .unwrap_or_else(|| format!("session {}", &p.id[..p.id.len().min(8)]));
        let agent = p
            .agent
            .as_deref()
            .map(|a| a.trim_start_matches("harness:").trim_start_matches("acp:").to_string())
            .unwrap_or_else(|| "builtin".to_string());
        let proj = p
            .project_id
            .as_deref()
            .map(|pid| project_label(conn, pid))
            .unwrap_or_else(|| "no project".to_string());
        let sum = summary_of(&p.id)
            .map(|s| crate::util::truncate_chars(&s, 110))
            .unwrap_or_else(|| "no summary yet".to_string());
        lines.push(format!(
            "- \"{}\" (id {}…, {}, {}, idle {}) — {}",
            title,
            &p.id[..p.id.len().min(8)],
            agent,
            proj,
            age_str(p.last_active_at),
            sum
        ));
    }

    let identity = match self_sid {
        Some(sid) => format!(
            " Your session id: {sid} — pass it as `caller_session_id` in \
             message_session and spawn_session calls (the `session_id` field \
             there is the PEER you are addressing)."
        ),
        None => String::new(),
    };
    Some(format!(
        "## Relay sessions (Session Mesh)\n\
         You are one of {total} Relay chat sessions.{identity}\n\
         Nearby peers (same project first; `list_sessions` for the full index, \
         `read_session`/`search_sessions` for depth):\n{}\n\
         Peers are separate conversations with the same user. Consult them instead of \
         guessing what happened elsewhere; ask before duplicating in-progress work. \
         spawn_session accepts `model` (bare id, \"provider::model\", or an engine \
         pair like \"claude_code::sonnet\") — delegate to a different model or CLI \
         engine than yours when the task warrants it (cheap models for mechanical \
         sub-work); the app-wide default is Settings → Subagent model.",
        lines.join("\n")
    ))
}

fn project_label(conn: &Connection, project_id: &str) -> String {
    conn.query_row(
        "SELECT name FROM projects WHERE id = ?1",
        [project_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .unwrap_or_else(|| format!("project {}", &project_id[..project_id.len().min(8)]))
}

/// Compact PER-TURN mesh hint for RESUMED harness CLI sessions. The full
/// registry rides a fresh session's first-turn instructions only, and a
/// resumed chat (app restarted, days later) then had the mesh TOOLS but no
/// prompting connecting "what did we do last session" to them — it answered
/// from its own CLI's session data instead. Cheap (one line), rides every
/// turn like RELAY_ASK_DIRECTIVE. None when the mesh is disabled or the
/// caller reports no relay-tools for this harness (prompt-only CLIs have no
/// mesh tools to steer into).
pub fn resumed_turn_hint(conn: &Connection, has_relay_tools: bool, self_sid: &str) -> Option<String> {
    if !mesh_enabled(conn) || !has_relay_tools {
        return None;
    }
    Some(format!(
        "[Relay Session Mesh] Your Relay session id is {self_sid} (pass it as \
         caller_session_id in message_session / spawn_session). Questions about \
         OTHER chats or past sessions — \"what did we do last time\", \"the other \
         conversation\" — use the relay-tools list_sessions / read_session / \
         search_sessions tools; they cover every Relay chat session. Never answer \
         those from this conversation alone.]"
    ))
}

/// "idle 3h"-style relative age for registry/list lines.
fn age_str(ts: i64) -> String {
    let secs = (crate::db::now_ts() - ts).max(0);
    if secs < 60 {
        "just now".to_string()
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86_400 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86_400)
    }
}

// ── Summary worker (lazy distillation) ────────────────────────────────────

/// Spawn a background summarizer when this session's abstract is missing or
/// stale and the session has enough content to be worth one. Called lazily
/// from the registry block / `list_sessions` / after mesh-triggered turns —
/// never from a turn's critical path.
pub fn maybe_spawn_summary(db: &DbState, sid: &str) {
    let should = {
        let conn = db.0.lock();
        if !mesh_enabled(&conn) {
            return;
        }
        let user_turns = store::count_user_messages(&conn, sid).unwrap_or(0);
        if user_turns < 2 {
            false
        } else {
            match (
                store::get_session_summary(&conn, sid),
                crate::db::get_chat_session(&conn, sid),
            ) {
                (Ok(None), _) => true,
                (Ok(Some(s)), Ok(Some(session))) => s.updated_at < session.last_active_at,
                _ => false,
            }
        }
    };
    if !should {
        return;
    }
    let db = DbState(Arc::clone(&db.0));
    let sid = sid.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = summarize_session(&db, &sid).await;
    });
}

/// Build and store the abstract for one session. Best-effort: every failure
/// is silent (the next lazy trigger retries).
async fn summarize_session(db: &DbState, sid: &str) -> Result<(), String> {
    let transcript = {
        let conn = db.0.lock();
        store::transcript_for_summary(&conn, sid).map_err(|e| e.to_string())?
    };
    if transcript.trim().is_empty() {
        return Err("nothing to summarize".into());
    }
    let (provider_id, base, api_key, model) = {
        let conn = db.0.lock();
        crate::chat::commands::resolve_cloud_summarizer(&conn)
            .ok_or_else(|| "no cloud provider configured for summarization".to_string())?
    };
    let entry = crate::chat::compaction::CompactionEntry {
        id: 0,
        message: crate::chat::providers::ChatMessage {
            role: "user".to_string(),
            content: format!(
                "Summarize what this Relay chat session did and decided in at most \
                 two sentences, third person, present tense. Reply with the summary \
                 only — no preamble.\n\n{transcript}"
            ),
            images: Vec::new(),
        },
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let (summary, _, _) = crate::chat::cloud_compact::summarize_via_provider(
        &client,
        provider_id,
        &base,
        &api_key,
        &model,
        &std::iter::once(&entry).collect::<Vec<_>>(),
        None,
    )
    .await?;
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err("empty summary".into());
    }
    let conn = db.0.lock();
    store::upsert_session_summary(&conn, sid, &summary, "", Some(&model))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Dispatcher ────────────────────────────────────────────────────────────

/// Caller identity: `run_tool` (built-in loop) always passes Some(sid); the
/// relay-tools bridge passes None and the model supplies its own
/// `caller_session_id` argument (stated in the first-turn mesh line).
/// Deliberately a DIFFERENT field from `session_id`, which is the TARGET in
/// message_session/read_session — falling back to `session_id` here made the
/// caller resolve to the target and every harness question die on the
/// self-mail guard.
fn resolve_caller<'a>(caller_sid: Option<&'a str>, args: &'a Value) -> Option<&'a str> {
    caller_sid.or_else(|| {
        args.get("caller_session_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    })
}

pub async fn execute_mesh_tool(
    app: &AppHandle,
    caller_sid: Option<&str>,
    name: &str,
    args: &Value,
) -> String {
    let enabled = {
        let db = app.state::<DbState>();
        let conn = db.0.lock();
        mesh_enabled(&conn)
    };
    if !enabled {
        return mesh_disabled_note();
    }
    match name {
        crate::chat::tools::LIST_SESSIONS => mesh_list_sessions(app, caller_sid, args).await,
        crate::chat::tools::READ_SESSION => mesh_read_session(app, caller_sid, args).await,
        crate::chat::tools::SEARCH_SESSIONS => mesh_search_sessions(app, caller_sid, args).await,
        crate::chat::tools::MESSAGE_SESSION => mesh_message_session(app, caller_sid, args).await,
        crate::chat::tools::SPAWN_SESSION => mesh_spawn_session(app, caller_sid, args).await,
        other => format!("Error: unknown session-mesh tool \"{other}\"."),
    }
}

// ── list_sessions ─────────────────────────────────────────────────────────

async fn mesh_list_sessions(app: &AppHandle, caller_sid: Option<&str>, args: &Value) -> String {
    let db = app.state::<DbState>();
    let self_sid = resolve_caller(caller_sid, args);
    let scope_all = args
        .get("scope")
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("all"))
        .unwrap_or(false);
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 24) as usize)
        .unwrap_or(12);

    let (rows, summaries, self_project) = {
        let conn = db.0.lock();
        let rows = match store::list_peer_sessions(&conn, self_sid.unwrap_or(""), 24) {
            Ok(r) => r,
            Err(e) => return format!("Error: list_sessions failed: {e}"),
        };
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let summaries = store::summaries_for(&conn, &ids).unwrap_or_default();
        let self_project = self_sid
            .and_then(|sid| crate::db::get_chat_session(&conn, sid).ok().flatten())
            .and_then(|s| s.project_id);
        (rows, summaries, self_project)
    };

    let mut filtered: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            scope_all
                || self_project.is_none()
                || r.project_id.is_none()
                || r.project_id == self_project
        })
        .collect();
    // Same project first, then starred, then recency (the SQL already orders
    // by starred/recency; project grouping re-ranks the front).
    filtered.sort_by_key(|r| {
        (
            !(r.project_id.is_some() && r.project_id == self_project),
            !r.starred,
        )
    });
    filtered.truncate(limit);

    if filtered.is_empty() {
        return "No other chat sessions found. Spawn one with spawn_session if this \
                task needs a dedicated worker."
            .to_string();
    }

    let mut out = String::from("Other Relay chat sessions (id — status — details):\n");
    for p in &filtered {
        let summary = summaries
            .iter()
            .find(|s| s.chat_session_id == p.id)
            .map(|s| crate::util::truncate_chars(s.summary.as_str(), 160));
        // Lazy distillation: keep the index fresh without a turn-end hook.
        if summary.is_none() {
            maybe_spawn_summary(&db, &p.id);
        }
        let title = p
            .title
            .clone()
            .unwrap_or_else(|| format!("(untitled)"));
        let agent = p
            .agent
            .as_deref()
            .map(|a| a.trim_start_matches("harness:").trim_start_matches("acp:").to_string())
            .unwrap_or_else(|| "builtin".to_string());
        let proj = p
            .project_id
            .as_deref()
            .map(|pid| project_label(&db.0.lock(), pid))
            .unwrap_or_else(|| "no project".to_string());
        let status = if session_busy(app, &p.id) {
            "ACTIVE_TURN"
        } else {
            "idle"
        };
        out.push_str(&format!(
            "- {} | {} | {} | {} | {} | spawned: {}\n",
            p.id,
            title,
            status,
            agent,
            proj,
            p.origin
                .as_deref()
                .map(|o| o.starts_with("spawned_by:").then(|| "yes").unwrap_or("no"))
                .unwrap_or("no"),
        ));
        if let Some(s) = summary {
            out.push_str(&format!("  summary: {s}\n"));
        }
    }
    out.push_str(
        "\nUse read_session for a peer's summary/recent turns, search_sessions to find \
         which session covered a topic, message_session to ask one a question, and \
         spawn_session to delegate new work.",
    );
    out
}

// ── read_session ──────────────────────────────────────────────────────────

async fn mesh_read_session(app: &AppHandle, caller_sid: Option<&str>, args: &Value) -> String {
    let raw_target = match args.get("session_id").and_then(|v| v.as_str()).map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return "Error: read_session requires a non-empty \"session_id\" (from list_sessions).".into(),
    };
    // Prefix-tolerant: list/search output and the registry block truncate ids
    // for token economy, and an exact-only lookup failed every follow-up call
    // the model made ("no session" despite doing everything right).
    let db = app.state::<DbState>();
    let target = {
        let conn = db.0.lock();
        match store::resolve_session_id(&conn, &raw_target) {
            Ok(id) => id,
            Err(e) => return format!("Error: read_session: {e}"),
        }
    };
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("summary")
        .to_string();
    // Read-only: the caller identity only affects list-level self-exclusion.
    let _ = caller_sid;

    let db = app.state::<DbState>();
    let conn = db.0.lock();
    let session = match crate::db::get_chat_session(&conn, &target) {
        Ok(Some(s)) => s,
        Ok(None) => return format!("Error: no session \"{target}\" — call list_sessions for valid ids."),
        Err(e) => return format!("Error: read_session failed: {e}"),
    };
    let title = session
        .title
        .clone()
        .unwrap_or_else(|| format!("session {}", &target[..target.len().min(8)]));

    match mode.as_str() {
        "summary" => {
            let s = store::get_session_summary(&conn, &target).ok().flatten();
            drop(conn);
            if let Some(s) = s {
                if s.updated_at < session.last_active_at {
                    maybe_spawn_summary(&db, &target);
                }
                format!(
                    "[{title}] {}\n(recent turns may be newer than this summary — use mode=\"recent_turns\" for the latest)",
                    s.summary
                )
            } else {
                maybe_spawn_summary(&db, &target);
                format!(
                    "[{title}] No summary yet (generation queued). Use mode=\"recent_turns\" \
                     to read the latest messages directly."
                )
            }
        }
        "recent_turns" | "transcript" => {
            let max_chars = if mode == "transcript" { 24_000 } else { 8_000 };
            match store::transcript_excerpt(&conn, &target, 30, max_chars) {
                Ok(t) if t.trim().is_empty() => format!("[{title}] No messages yet."),
                Ok(t) => {
                    drop(conn);
                    if session_busy(app, &target) {
                        format!("[{title}] NOTE: this session is streaming right now; the transcript below may not include its current turn.\n\n{t}")
                    } else {
                        t
                    }
                }
                Err(e) => format!("Error: read_session failed: {e}"),
            }
        }
        other => format!("Error: read_session mode must be \"summary\", \"recent_turns\", or \"transcript\" (got \"{other}\")."),
    }
}

// ── search_sessions ───────────────────────────────────────────────────────

async fn mesh_search_sessions(app: &AppHandle, _caller: Option<&str>, args: &Value) -> String {
    let query = match args.get("query").and_then(|v| v.as_str()).map(str::trim) {
        Some(q) if !q.is_empty() => q.to_string(),
        _ => return "Error: search_sessions requires a non-empty \"query\".".into(),
    };
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 10) as u32)
        .unwrap_or(5);
    let db = app.state::<DbState>();
    let conn = db.0.lock();
    // Reuse the command-palette FTS (titles + message bodies) verbatim.
    let hits = match crate::db::search_chat_messages(&conn, &query, limit * 6) {
        Ok(h) => h,
        Err(e) => return format!("Error: search_sessions failed: {e}"),
    };
    if hits.is_empty() {
        return format!("No sessions match \"{query}\".");
    }
    // Group by session (FTS returns per-message hits; the tool reports
    // session-level knowledge with the best excerpt each).
    let mut seen: Vec<(String, Option<String>, String)> = Vec::new(); // sid, title, snippet
    for h in hits {
        if seen.iter().any(|(sid, _, _)| *sid == h.chat_session_id) {
            continue;
        }
        let title = crate::db::get_chat_session(&conn, &h.chat_session_id)
            .ok()
            .flatten()
            .and_then(|s| s.title);
        seen.push((
            h.chat_session_id.clone(),
            title,
            h.snippet.clone().unwrap_or_default(),
        ));
        if seen.len() >= limit as usize {
            break;
        }
    }
    drop(conn);
    let mut out = format!("Sessions matching \"{query}\":\n");
    for (sid, title, snippet) in &seen {
        let label = title
            .clone()
            .unwrap_or_else(|| format!("session {}", &sid[..sid.len().min(8)]));
        let excerpt = crate::util::truncate_chars(snippet.replace('\n', " ").trim(), 200);
        out.push_str(&format!(
            "- {} | {}\n  excerpt: {excerpt}\n",
            sid,
            label
        ));
    }
    out.push_str("Use read_session(session_id=…) for depth, or message_session(session_id=…) to consult a peer.");
    out
}

// ── message_session ───────────────────────────────────────────────────────

async fn mesh_message_session(app: &AppHandle, caller_sid: Option<&str>, args: &Value) -> String {
    let db = app.state::<DbState>();
    let from = match resolve_caller(caller_sid, args) {
        Some(s) => s.to_string(),
        None => {
            return "Error: message_session needs to know which session is asking — pass \
                    your own session id as `caller_session_id` (it is stated in your \
                    Session Mesh context block)."
                .into()
        }
    };
    let raw_target = match args.get("session_id").and_then(|v| v.as_str()).map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return "Error: message_session requires a non-empty \"session_id\" (from list_sessions).".into(),
    };
    // Prefix-tolerant, same reason as read_session.
    let target = {
        let conn = db.0.lock();
        match store::resolve_session_id(&conn, &raw_target) {
            Ok(id) => id,
            Err(e) => return format!("Error: message_session: {e}"),
        }
    };
    let body = match args.get("body").or_else(|| args.get("message")).and_then(|v| v.as_str()) {
        Some(b) => crate::util::truncate_chars(b.trim(), MAX_MAIL_CHARS).to_string(),
        None => return "Error: message_session requires a non-empty \"body\".".into(),
    };
    if body.is_empty() {
        return "Error: message_session requires a non-empty \"body\".".into();
    }
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("question")
        .to_string();
    if !matches!(mode.as_str(), "question" | "notify") {
        return "Error: message_session mode must be \"question\" or \"notify\".".into();
    }
    let timeout = args
        .get("timeout_s")
        .and_then(|v| v.as_u64())
        .unwrap_or(QUESTION_TIMEOUT_DEFAULT)
        .clamp(5, QUESTION_TIMEOUT_MAX);

    if from == target {
        return "Error: message_session cannot target the session that is calling it. \
                If you passed the PEER's id as your own identity, retry with your own \
                session id in `caller_session_id` (it is stated in your Session Mesh \
                context) and the peer's id in `session_id`."
            .into();
    }

    // Guards: rate limit, target existence, depth chain.
    let (target_exists, depth) = {
        let conn = db.0.lock();
        let sent = store::count_mail_from_since(&conn, &from, crate::db::now_ts() - 3600)
            .unwrap_or(MAX_MAIL_PER_HOUR);
        if sent >= MAX_MAIL_PER_HOUR {
            return format!(
                "Error: mail rate limit reached ({MAX_MAIL_PER_HOUR} messages/hour). \
                 Wait and retry, or ask the user to raise the cap."
            );
        }
        let depth = store::spawn_depth(&conn, &from).unwrap_or(0);
        (
            crate::db::get_chat_session(&conn, &target).map(|s| s.is_some()).unwrap_or(false),
            depth,
        )
    };
    if !target_exists {
        return format!("Error: no session \"{target}\" — call list_sessions for valid ids.");
    }
    if depth >= 2 {
        return "Error: this question has already been forwarded through a spawn chain \
                (depth cap 2) — answer from what you have, or ask the user."
            .into();
    }

    // Insert the mail (status queued), then deliver or queue.
    let mail = {
        let conn = db.0.lock();
        match store::insert_mail(&conn, &from, &target, &mode, &body, depth) {
            Ok(m) => m,
            Err(e) => return format!("Error: message_session failed: {e}"),
        }
    };
    emit_mail(app, &mail);

    // Question mode: park a waiter that the delivery watcher resolves. The
    // tool call returns when the answer lands (default 25s) or times over —
    // in which case the answer still arrives later as a follow-up turn.
    let (wait_tx, mut wait_rx) = tokio::sync::oneshot::channel::<String>();
    let rt = app.state::<FabricState>().0.clone();
    let watch_enabled = mode == "question";
    if watch_enabled {
        rt.answer_waiters.lock().unwrap_or_else(|e| e.into_inner()).insert(mail.id.clone(), wait_tx);
    }

    let queued = deliver_or_queue(app, &mail).await;
    match queued {
        Err(e) => {
            // MED-11: a busy-race rejection requeues the mail for the pump
            // instead of rejecting it — and KEEPS the parked answer waiter
            // (the delivery watcher resolves it once the turn answers).
            if is_busy_race_error(&e) {
                {
                    let conn = db.0.lock();
                    let _ = store::set_mail_status(&conn, &mail.id, store::MAIL_QUEUED, None);
                }
                emit_mail_status(app, &mail, store::MAIL_QUEUED, None);
                pump_kick(app, mail.to_session.clone());
                return format!(
                    "Session \"{target}\" is mid-turn — the message is QUEUED and will be \
                     delivered when its current turn completes. It will arrive as a \
                     follow-up turn in your session (question mode) — do not poll; keep \
                     working and the answer reaches you."
                );
            }
            if watch_enabled {
                rt.answer_waiters
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&mail.id);
            }
            {
                let conn = db.0.lock();
                let _ = store::set_mail_status(&conn, &mail.id, store::MAIL_REJECTED, None);
            }
            emit_mail_status(app, &mail, store::MAIL_REJECTED, None);
            return format!("Error: message could not be delivered: {e}");
        }
        Ok(true) => {}
        Ok(false) => {
            // Busy target: the pump will deliver when its current turn ends.
            return format!(
                "Session \"{target}\" is mid-turn — the message is QUEUED and will be \
                 delivered when its current turn completes. It will arrive as a \
                 follow-up turn in your session (question mode) — do not poll; keep \
                 working and the answer reaches you."
            );
        }
    }

    if !watch_enabled {
        return "Message delivered.".to_string();
    }

    // Park until the watcher resolves or the timeout elapses.
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        &mut wait_rx,
    )
    .await
    .ok()
    .and_then(|r| r.ok());

    match answer {
        Some(a) => format!("Reply from session \"{target}\":\n{a}"),
        None => format!(
            "No answer within {timeout}s — the question stays open; when session \
             \"{target}\" answers, the reply arrives as a follow-up turn in your \
             session. Keep working; don't poll."
        ),
    }
}

/// MED-11: true when the error is `AgentSessionManager::send`'s busy
/// rejection ("a turn is already running for this chat") — i.e. the target
/// went busy between our `session_busy` check and the actual send. Such a
/// mail is requeued for the pump instead of rejected permanently.
fn is_busy_race_error(e: &str) -> bool {
    e.contains("a turn is already running")
}

/// Deliver now, or (busy target) enqueue for the pump. `Ok(true)` = delivered,
/// `Ok(false)` = queued, `Err` = could not (rejected).
async fn deliver_or_queue(app: &AppHandle, mail: &store::MailRow) -> Result<bool, String> {
    if session_busy(app, &mail.to_session) {
        {
            let db = app.state::<DbState>();
            let conn = db.0.lock();
            let backlog = store::queued_mail_for(&conn, &mail.to_session)
                .map(|v| v.len())
                .unwrap_or(0);
            if backlog >= MAX_QUEUE_DEPTH {
                return Err(format!(
                    "target mailbox full ({MAX_QUEUE_DEPTH} queued) — try again after its current turn"
                ));
            }
        }
        pump_kick(app, mail.to_session.clone());
        return Ok(false);
    }
    deliver_mail(app, mail.clone()).await?;
    Ok(true)
}

/// Send one envelope turn into the target and spawn its answer watcher.
async fn deliver_mail(app: &AppHandle, mail: store::MailRow) -> Result<(), String> {
    let db = app.state::<DbState>();
    let envelope = {
        let conn = db.0.lock();
        mail_envelope(&conn, &mail)
    };
    let target = session_row(&db, &mail.to_session)
        .await
        .ok_or_else(|| "target session vanished".to_string())?;

    // Watermark BEFORE the send: the answer is the first assistant row after it.
    let watermark = {
        let conn = db.0.lock();
        store::max_message_id(&conn, &mail.to_session).unwrap_or(0)
    };

    {
        let conn = db.0.lock();
        store::set_mail_status(&conn, &mail.id, store::MAIL_DELIVERED, None)
            .map_err(|e| e.to_string())?;
    }
    emit_mail_status(app, &mail, store::MAIL_DELIVERED, None);

    run_turn(app, &target, &envelope).await?;

    // Watcher: wait for the turn to end, then capture the answer. Spawned
    // from a NON-async helper: an inline spawn here would make deliver_mail's
    // future type recursive (watch_answer's late-answer path awaits
    // deliver_mail again via push_follow_up_answer) and Send-checking would
    // never terminate.
    spawn_answer_watcher(app.clone(), mail, watermark);
    Ok(())
}

/// Spawn the answer watcher for one delivered mail (see deliver_mail).
fn spawn_answer_watcher(app: AppHandle, mail: store::MailRow, watermark: i64) {
    tauri::async_runtime::spawn(async move {
        watch_answer(app, mail, watermark).await;
    });
}

/// Watch a delivered question's turn: when the target goes idle, take the
/// newest assistant row after the watermark as the answer, store it, resolve
/// a parked tool call, and (for an already-timed-out asker) push the answer
/// back as a follow-up turn.
async fn watch_answer(app: AppHandle, mail: store::MailRow, watermark: i64) {
    let mut deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(WATCHER_CEILING_SECS);
    // Wait for the turn to actually start (send() may still be setting up).
    tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
    // LOW-18: re-arm ONCE when the ceiling elapses while the target is STILL
    // mid-turn — a long coding turn legitimately outlives the first window,
    // and expiring then lost an answer that was on its way. A second expiry
    // (or an already-idle target) takes the normal expiry path.
    let mut rearmed = false;
    loop {
        if std::time::Instant::now() >= deadline {
            if !rearmed && session_busy(&app, &mail.to_session) {
                rearmed = true;
                deadline = std::time::Instant::now()
                    + std::time::Duration::from_secs(WATCHER_CEILING_SECS);
            } else {
                let db = app.state::<DbState>();
                let conn = db.0.lock();
                let _ = store::set_mail_status(&conn, &mail.id, store::MAIL_EXPIRED, None);
                drop(conn);
                emit_mail_status(&app, &mail, store::MAIL_EXPIRED, None);
                resolve_waiter(&app, &mail.id, None);
                return;
            }
        }
        if !session_busy(&app, &mail.to_session) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
    }
    // Turn ended — small grace for the final message row to persist.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;

    let db = app.state::<DbState>();
    let answer = {
        let conn = db.0.lock();
        store::last_assistant_message_after(&conn, &mail.to_session, watermark)
            .ok()
            .flatten()
    };
    match answer {
        Some(a) if !a.trim().is_empty() => {
            {
                let conn = db.0.lock();
                let _ = store::set_mail_status(&conn, &mail.id, store::MAIL_ANSWERED, Some(&a));
            }
            drop(db);
            emit_mail_status(&app, &mail, store::MAIL_ANSWERED, Some(&a));
            // Resolved waiter = the asker's tool call is still parked and
            // gets the answer as its result. A FAILED send means the tool
            // call already returned (timeout / queued path) — push the
            // answer to the asker as a follow-up turn instead, so it is
            // never lost between sessions.
            let delivered = resolve_waiter(&app, &mail.id, Some(a.clone()));
            if !delivered {
                push_follow_up_answer(&app, &mail, &a).await;
            }
        }
        _ => {
            let conn = db.0.lock();
            let _ = store::set_mail_status(&conn, &mail.id, store::MAIL_EXPIRED, None);
            drop(conn);
            emit_mail_status(&app, &mail, store::MAIL_EXPIRED, None);
            resolve_waiter(&app, &mail.id, None);
        }
    }
}

/// Late answer delivery (design §5.2): when the asker's tool call is gone,
/// the answer rides a notify mail back into the asker's session as a turn.
async fn push_follow_up_answer(app: &AppHandle, mail: &store::MailRow, answer: &str) {
    let db = app.state::<DbState>();
    let fwd = {
        let conn = db.0.lock();
        store::insert_mail(
            &conn,
            &mail.to_session,
            &mail.from_session,
            "notify",
            &format!(
                "Answer to your earlier question to this session:\n\n{}",
                crate::util::truncate_chars(answer, MAX_MAIL_CHARS)
            ),
            mail.depth + 1,
        )
    };
    match fwd {
        Ok(m) => {
            emit_mail(app, &m);
            let _ = deliver_or_queue(app, &m).await;
        }
        Err(_) => {} // audit row lost — the answer still sits in the original mail
    }
}

/// Resolve a parked question tool call. Returns true when a live receiver
/// took the answer; false means the asker's call is gone (timeout or the
/// queued path) and the caller must deliver the answer another way.
fn resolve_waiter(app: &AppHandle, mail_id: &str, answer: Option<String>) -> bool {
    let rt = {
        let state = app.state::<FabricState>();
        Arc::clone(&state.0)
    };
    let removed = rt
        .answer_waiters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(mail_id);
    match removed {
        Some(tx) => tx
            .send(answer.unwrap_or_else(|| {
                "(no reply — the session finished its turn without an answer)".to_string()
            }))
            .is_ok(),
        None => false,
    }
}

/// Drain pump: one per target, serially delivers queued mails while the
/// target is idle. Triggered whenever a mail lands on a busy target; exits
/// when the queue empties or the ceiling elapses.
fn pump_kick(app: &AppHandle, target: String) {
    let rt = app.state::<FabricState>().0.clone();
    {
        let mut pumps = rt.pumps.lock().unwrap_or_else(|e| e.into_inner());
        if !pumps.insert(target.clone()) {
            return; // already pumping
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(PUMP_CEILING_SECS);
        loop {
            let next = {
                let db = app.state::<DbState>();
                let conn = db.0.lock();
                store::queued_mail_for(&conn, &target)
                    .ok()
                    .and_then(|q| q.into_iter().next())
            };
            let Some(mail) = next else { break };
            if std::time::Instant::now() >= deadline {
                let db = app.state::<DbState>();
                let conn = db.0.lock();
                let _ = store::set_mail_status(&conn, &mail.id, store::MAIL_EXPIRED, None);
                drop(conn);
                emit_mail_status(&app, &mail, store::MAIL_EXPIRED, None);
                // Never-delivered mail: the parked asker must not hang on a
                // waiter that will now never be resolved by a watcher.
                resolve_waiter(&app, &mail.id, None);
                continue;
            }
            if session_busy(&app, &target) {
                tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
                continue;
            }
            // Deliver inline: the pump IS the watcher for this mail's turn —
            // wait for it to finish before considering the next queued mail,
            // so two envelopes never interleave inside one target turn.
            match deliver_mail(&app, mail.clone()).await {
                Ok(()) => {
                    let turn_deadline = std::time::Instant::now()
                        + std::time::Duration::from_secs(WATCHER_CEILING_SECS);
                    while session_busy(&app, &target) && std::time::Instant::now() < turn_deadline
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
                    }
                }
                Err(e) => {
                    // MED-11: a busy-race rejection (target went busy between
                    // the check above and the send) requeues the mail — the
                    // loop re-picks it once the target idles. MED-6: every
                    // terminal path here must also resolve the parked answer
                    // waiter, or the asker's tool call hangs forever.
                    let busy_race = is_busy_race_error(&e);
                    let status = if busy_race {
                        store::MAIL_QUEUED
                    } else {
                        store::MAIL_REJECTED
                    };
                    {
                        let db = app.state::<DbState>();
                        let conn = db.0.lock();
                        let _ = store::set_mail_status(&conn, &mail.id, status, None);
                    }
                    emit_mail_status(&app, &mail, status, None);
                    if !busy_race {
                        resolve_waiter(&app, &mail.id, None);
                    }
                }
            }
        }
        rt.pumps.lock().unwrap_or_else(|e| e.into_inner()).remove(&target);
    });
}

// ── spawn_session ─────────────────────────────────────────────────────────

async fn mesh_spawn_session(app: &AppHandle, caller_sid: Option<&str>, args: &Value) -> String {
    let parent = match resolve_caller(caller_sid, args) {
        Some(s) => s.to_string(),
        None => {
            return "Error: spawn_session needs to know which session is spawning — pass \
                    your own session id as `caller_session_id` (it is stated in your \
                    Session Mesh context block)."
                .into()
        }
    };
    let task = match args.get("task").and_then(|v| v.as_str()).map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => return "Error: spawn_session requires a non-empty \"task\" (the new session's first instruction).".into(),
    };
    let agent_arg = args
        .get("agent")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let title_arg = args
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| crate::util::truncate_chars(s, 80).to_string());
    let wait = args
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|m| m.eq_ignore_ascii_case("wait"))
        .unwrap_or(false);

    let db = app.state::<DbState>();

    // Guards: spawn-tree depth, per-parent and global caps.
    {
        let conn = db.0.lock();
        let depth = store::spawn_depth(&conn, &parent).unwrap_or(0);
        if depth + 1 >= MAX_SPAWN_DEPTH {
            return format!(
                "Error: spawn depth cap ({MAX_SPAWN_DEPTH}) — this session is already \
                 part of a spawn chain at the limit. Do the work directly or ask the user."
            );
        }
        let children = store::count_recent_spawned_children(&conn, &parent, CHILDREN_WINDOW_SECS)
            .unwrap_or(MAX_CHILDREN_PER_PARENT);
        if children >= MAX_CHILDREN_PER_PARENT {
            return format!(
                "Error: you already have {children} spawned sessions in the last 24h \
                 (cap {MAX_CHILDREN_PER_PARENT}). Message an existing one instead, or \
                 finish it first."
            );
        }
        let active = store::count_active_spawned(&conn, CHILDREN_WINDOW_SECS)
            .unwrap_or(MAX_ACTIVE_SPAWNED);
        if active >= MAX_ACTIVE_SPAWNED {
            return format!(
                "Error: {active} mesh-spawned sessions are active app-wide (cap \
                 {MAX_ACTIVE_SPAWNED}) — wait for one to settle or ask the user."
            );
        }
    }

    let parent_row = match {
        let conn = db.0.lock();
        crate::db::get_chat_session(&conn, &parent)
    } {
        Ok(Some(r)) => r,
        _ => return "Error: parent session not found.".into(),
    };
    // Subagent-model orchestration: an explicit `model` tool arg wins, then
    // the Settings pick (`chat.subagentModel`), then the parent's model.
    // A pick naming a CLI engine (`claude_code::sonnet`) re-homes the child
    // onto that engine unless the caller named one explicitly — cross-engine
    // delegation via `agent` always wins, and a mismatched pick's model is
    // dropped (its model ids belong to its own engine).
    let model_pick = {
        let conn = db.0.lock();
        crate::chat::subagent_model::pick_for_call(&conn, args)
    };
    // A local_gguf pick only holds while the sidecar is actually serving
    // that model — otherwise the child's first turn would die on a dead
    // base URL. Drop to the parent's resolution (logged).
    let model_pick = model_pick.and_then(|p| {
        if p.provider.as_deref() != Some("local_gguf") {
            return Some(p);
        }
        let running = app
            .try_state::<crate::chat::local_models::LocalModelState>()
            .and_then(|s| s.0.status())
            .map_or(false, |a| a.model_id == p.model);
        if running {
            Some(p)
        } else {
            eprintln!(
                "[subagent-model] local_gguf::{} ignored — sidecar not running it",
                p.model
            );
            None
        }
    });
    let pick_engine_id = model_pick
        .as_ref()
        .and_then(crate::chat::subagent_model::pick_engine);
    let normalize_agent = |a: String| -> String {
        if a.contains(':') || a == "builtin" || a == "local" {
            a
        } else {
            format!("harness:{a}")
        }
    };
    let agent = match agent_arg {
        Some(a) => normalize_agent(a),
        None => match pick_engine_id {
            Some(e) => e,
            None => normalize_agent(
                parent_row
                    .agent
                    .clone()
                    .unwrap_or_else(|| "builtin".to_string()),
            ),
        },
    };
    let model_pick_for_child = model_pick.filter(|p| {
        crate::chat::subagent_model::pick_engine(p).map_or(true, |e| e == agent)
    });
    let harness_child = agent.starts_with("harness:") || agent.starts_with("acp:");
    let (provider, model) = {
        let conn = db.0.lock();
        crate::chat::subagent_model::resolve_spawn_model(
            &conn,
            &parent_row.provider,
            &parent_row.model,
            harness_child,
            model_pick_for_child,
        )
    };

    let child = {
        let conn = db.0.lock();
        // `create_chat_session` writes full-auto defaults, matching how the
        // composer creates chats.
        let row = crate::db::create_chat_session(&conn, &provider, &model, parent_row.project_id.as_deref());
        match row {
            Ok(mut r) => {
                r.agent = Some(agent.clone());
                let _ = crate::db::update_chat_session_agent(&conn, &r.id, Some(agent.as_str()));
                let title = title_arg.clone().unwrap_or_else(|| {
                    crate::util::truncate_chars(task.split_whitespace().collect::<Vec<_>>().join(" ").as_str(), 60)
                });
                let _ = crate::db::update_chat_session_title(&conn, &r.id, &title);
                let _ = store::set_chat_session_origin(&conn, &r.id, &format!("spawned_by:{parent}"));
                r.title = Some(title);
                r
            }
            Err(e) => return format!("Error: spawn_session could not create the session: {e}"),
        }
    };

    let _ = app.emit(
        "chat:session-spawn",
        SessionSpawnPayload {
            parent_session_id: parent.clone(),
            child_session_id: child.id.clone(),
            title: child.title.clone().unwrap_or_else(|| "spawned session".into()),
            agent: agent.clone(),
            model: child.model.clone(),
        },
    );

    // First turn: the task envelope (the child's bundle/primer machinery
    // handles the fresh-CLI instructions, which include mesh awareness).
    let envelope = spawn_envelope(&db, &parent, &child.id, &task);
    let target = SessionRowLite {
        id: child.id.clone(),
        agent: Some(agent.clone()),
        model: child.model.clone(),
        project_id: child.project_id.clone(),
        worktree_path: child.worktree_path.clone(),
    };
    let run = run_turn(app, &target, &envelope).await;
    if let Err(e) = run {
        return format!(
            "Session {} created (id {}) but its first turn failed to start: {e}. \
             The user can open it in the sidebar and send the task manually.",
            child.title.clone().unwrap_or_default(),
            child.id
        );
    }

    if !wait {
        return format!(
            "Spawned session \"{}\" (id {}, engine {}, model {}). It received the task \
             as its first turn and is running — the user can watch it in the sidebar. \
             Message it with message_session(session_id=\"{}\") or read its output \
             with read_session(session_id=\"{}\", mode=\"recent_turns\").",
            child.title.clone().unwrap_or_default(),
            child.id,
            agent,
            child.model,
            child.id,
            child.id,
        );
    }

    // wait mode: join the first turn (bounded) and return its final text —
    // the Task tool's foreground mode, but the artifact is a real session.
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(QUESTION_TIMEOUT_MAX);
    // Give the turn time to start before polling for its end.
    tokio::time::sleep(std::time::Duration::from_millis(POLL_MS * 2)).await;
    while session_busy(app, &child.id) && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
    }
    // A fresh session's first turn has exactly one assistant row — take it.
    let result = {
        let conn = db.0.lock();
        store::last_assistant_message_after(&conn, &child.id, 0).ok().flatten()
    };
    match result {
        Some(r) => format!(
            "Spawned session \"{}\" (id {}) finished its first turn:\n{}",
            child.title.clone().unwrap_or_default(),
            child.id,
            crate::util::truncate_chars(&r, 6_000)
        ),
        None => format!(
            "Spawned session \"{}\" (id {}) started; no output captured yet — read it \
             later with read_session(session_id=\"{}\").",
            child.title.clone().unwrap_or_default(),
            child.id,
            child.id
        ),
    }
}

fn spawn_envelope(db: &DbState, parent: &str, child: &str, task: &str) -> String {
    let parent_title = {
        let conn = db.0.lock();
        store::chat_title(&conn, parent)
    }
    .unwrap_or_else(|| parent.to_string());
    format!(
        "[Task from parent Relay session \"{parent_title}\" (id {parent}). You are a \
         dedicated session spawned for this task — work on it with your tools. Your \
         Relay session id is {child} (pass it as caller_session_id in message_session / \
         spawn_session calls). The parent can be reached with \
         message_session(session_id=\"{parent}\", caller_session_id=\"{child}\").]\n\n{task}"
    )
}

// ── Target plumbing ───────────────────────────────────────────────────────

/// The fields of a chat_sessions row needed to run a turn in it.
#[derive(Debug, Clone)]
pub struct SessionRowLite {
    pub id: String,
    pub agent: Option<String>,
    pub model: String,
    pub project_id: Option<String>,
    pub worktree_path: Option<String>,
}

async fn session_row(db: &DbState, sid: &str) -> Option<SessionRowLite> {
    let row = {
        let conn = db.0.lock();
        crate::db::get_chat_session(&conn, sid).ok().flatten()?
    };
    Some(SessionRowLite {
        id: row.id,
        agent: row.agent,
        model: row.model,
        project_id: row.project_id,
        worktree_path: row.worktree_path,
    })
}

/// Builtin | Harness — `agent` is `"builtin"`, `"local"`, or `"harness:<id>"`/
/// `"acp:<id>"`. ACP keeps its prefix: that's what `AgentSessionManager`
/// dispatches on.
fn target_kind(agent: &Option<String>) -> TargetKind {
    match agent.as_deref() {
        Some(a) if a.starts_with("harness:") => {
            TargetKind::Harness(a["harness:".len()..].to_string())
        }
        Some(a) if a.starts_with("acp:") => TargetKind::Harness(a.to_string()),
        _ => TargetKind::Builtin,
    }
}

enum TargetKind {
    Builtin,
    Harness(String),
}

/// Live busy check across both agent families: the built-in stream map, or
/// the harness child's `turn_in_flight` flag.
fn session_busy(app: &AppHandle, sid: &str) -> bool {
    if let Some(chat) = app.try_state::<crate::ChatState>() {
        if chat.0.has_active_stream(sid) {
            return true;
        }
    }
    if let Some(state) = app.try_state::<crate::agent_sessions::AgentSessionState>() {
        if state.0.is_turn_in_flight(sid) {
            return true;
        }
    }
    false
}

/// Run one turn in a session through its own send path. Blocking harness
/// setup (server spawn, wait-ready) runs on the blocking pool — mirroring
/// what `send_agent_chat_message` does on the command thread.
async fn run_turn(app: &AppHandle, target: &SessionRowLite, content: &str) -> Result<(), String> {
    match target_kind(&target.agent) {
        TargetKind::Harness(harness) => {
            let connectors = crate::connectors::harness_mcp_servers(app, &target.id).await;
            let db = app.state::<DbState>();
            let cwd = {
                let conn = db.0.lock();
                cwd_for(&conn, target)
            };
            let mgr = Arc::clone(&app.state::<crate::agent_sessions::AgentSessionState>().0);
            let app_for_task = app.clone();
            let content = content.to_string();
            let sid = target.id.clone();
            let model = target.model.clone();
            let project_id = target.project_id.clone();
            // 'static for spawn_blocking: the AppHandle clone + Arc carry
            // everything; nothing borrows this frame.
            let res = tauri::async_runtime::spawn_blocking(move || {
                let db = app_for_task.state::<DbState>();
                mgr.send(
                    &app_for_task,
                    &db,
                    &sid,
                    &content,
                    "",
                    &harness,
                    &model,
                    cwd.as_deref(),
                    project_id.as_deref(),
                    &connectors,
                    None,
                )
            })
            .await
            .map_err(|e| format!("turn task panicked: {e}"))?;
            res
        }
        TargetKind::Builtin => {
            // `send_chat_message`'s future is not Send (it holds sqlite
            // guards across awaits internally), so it can't ride a spawned
            // task. Running it under block_on INSIDE spawn_blocking keeps
            // the future on one thread; the command itself returns after
            // spawning the stream task, so the blocking pool is held only
            // for setup (prompt build, provider resolution), not decoding.
            let app_for_task = app.clone();
            let sid = target.id.clone();
            let content = content.to_string();
            let res = tauri::async_runtime::spawn_blocking(move || {
                tauri::async_runtime::block_on(async {
                    crate::chat::commands::send::send_chat_message(
                        sid,
                        content,
                        None,
                        Some(true),
                        None,
                        None,
                        None,
                        None,
                        None,
                        app_for_task.state::<crate::ChatState>(),
                        app_for_task.state::<DbState>(),
                        app_for_task.clone(),
                    )
                    .await
                })
            })
            .await
            .map_err(|e| format!("turn task panicked: {e}"))?;
            res
        }
    }
}

/// Working dir for a session's turn: explicit worktree, else the bound
/// project's path (same resolution the frontend composer uses).
fn cwd_for(conn: &Connection, row: &SessionRowLite) -> Option<String> {
    if let Some(wt) = row.worktree_path.clone() {
        return Some(wt);
    }
    row.project_id.as_deref().and_then(|pid| {
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?1",
            [pid],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    })
}

// ── Envelope + events ─────────────────────────────────────────────────────

/// The user-role turn a delivered mail becomes. Explicitly NOT-from-human so
/// neither the model nor the transcript can mistake it for the user typing.
fn mail_envelope(conn: &Connection, mail: &store::MailRow) -> String {
    let from_title = store::chat_title(conn, &mail.from_session);
    let agent = crate::db::get_chat_session(conn, &mail.from_session)
        .ok()
        .flatten()
        .and_then(|s| s.agent)
        .map(|a| a.trim_start_matches("harness:").trim_start_matches("acp:").to_string())
        .unwrap_or_else(|| "builtin".to_string());
    let reply_line = if mail.mode == "question" {
        "Your final message this turn is delivered back to the asking session as the \
         answer — answer the question directly and completely."
    } else {
        "This is a notice; no reply is expected unless it changes your current work."
    };
    format!(
        "[Relay inter-session mail — NOT typed by the user]\n\
         From: session \"{}\" (id {}, agent {}, forwarded-depth {})\n\
         {}\n\
         Body:\n{}",
        from_title.unwrap_or_else(|| mail.from_session.clone()),
        mail.from_session,
        agent,
        mail.depth,
        reply_line,
        mail.body
    )
}

fn emit_mail(app: &AppHandle, mail: &store::MailRow) {
    emit_mail_status(app, mail, &mail.status, None);
}

fn emit_mail_status(app: &AppHandle, mail: &store::MailRow, status: &str, answer: Option<&str>) {
    let db = app.state::<DbState>();
    let (from_title, to_title) = {
        let conn = db.0.lock();
        (
            store::chat_title(&conn, &mail.from_session),
            store::chat_title(&conn, &mail.to_session),
        )
    };
    let _ = app.emit(
        "chat:session-mail",
        SessionMailPayload {
            mail_id: mail.id.clone(),
            from_session: mail.from_session.clone(),
            from_title: from_title.unwrap_or_else(|| mail.from_session.clone()),
            to_session: mail.to_session.clone(),
            to_title: to_title.unwrap_or_else(|| mail.to_session.clone()),
            mode: mail.mode.clone(),
            status: status.to_string(),
            body_excerpt: crate::util::truncate_chars(mail.body.trim(), 160),
            answer_excerpt: answer.map(|a| crate::util::truncate_chars(a.trim(), 200)),
            depth: mail.depth,
        },
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::session_fabric as store;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_sessions (
               id TEXT PRIMARY KEY, title TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
               created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
               starred INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
               watch_mode TEXT, agent TEXT, project_id TEXT, permission_mode TEXT,
               worktree_path TEXT, sandbox_policy TEXT, approval_policy TEXT,
               auto_model INTEGER NOT NULL DEFAULT 0, effort_level TEXT, origin TEXT);
             CREATE TABLE chat_messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT, chat_session_id TEXT NOT NULL,
               role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
               superseded_by INTEGER);
             CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE session_summaries (
               chat_session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
               summary TEXT NOT NULL, topics TEXT NOT NULL DEFAULT '', model TEXT,
               updated_at INTEGER NOT NULL);
             CREATE TABLE app_settings (
               key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE session_mail (
               id TEXT PRIMARY KEY, from_session TEXT NOT NULL, to_session TEXT NOT NULL,
               mode TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, answer TEXT,
               depth INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
               delivered_at INTEGER, answered_at INTEGER);",
        )
        .unwrap();
        conn
    }

    fn seed(conn: &Connection, id: &str, title: &str, project: Option<&str>, agent: Option<&str>) {
        conn.execute(
            "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, agent, project_id)
             VALUES (?1, ?2, 'anthropic', 'm', 1, 2, ?3, ?4)",
            rusqlite::params![id, title, agent, project],
        )
        .unwrap();
    }

    #[test]
    fn mesh_enabled_defaults_on_and_reads_toggle() {
        let conn = mem_conn();
        assert!(mesh_enabled(&conn));
        crate::db::set_setting(&conn, "sessionMesh.enabled", "off").unwrap();
        assert!(!mesh_enabled(&conn));
    }

    #[test]
    fn registry_block_hidden_for_lone_session_and_disabled_mesh() {
        let conn = mem_conn();
        seed(&conn, "a", "only", None, None);
        assert!(registry_block(&conn, Some("a")).is_none(), "single session → no block");
        crate::db::set_setting(&conn, "sessionMesh.enabled", "off").unwrap();
        seed(&conn, "b", "peer", None, None);
        assert!(registry_block(&conn, Some("a")).is_none());
    }

    #[test]
    fn registry_block_lists_peers_with_self_id_and_groups_project_first() {
        let conn = mem_conn();
        seed(&conn, "selfsession", "Me", Some("p1"), None);
        seed(&conn, "peerproject", "Peer same project", Some("p1"), Some("harness:opencode"));
        seed(&conn, "peerother", "Peer elsewhere", Some("p2"), None);
        conn.execute("INSERT INTO projects (id, name) VALUES ('p1', 'relay')", []).unwrap();
        store::upsert_session_summary(&conn, "peerproject", "Wrote the auth doc.", "", None)
            .unwrap();
        let block = registry_block(&conn, Some("selfsession")).unwrap();
        assert!(block.contains("Your session id: selfsession"));
        assert!(block.contains("caller_session_id"), "identity line must name the caller field");
        assert!(block.contains("2 Relay chat sessions"));
        assert!(block.contains("Wrote the auth doc."));
        assert!(block.contains("opencode"));
        // Same-project peer appears before the other-project peer.
        let same = block.find("Peer same project").unwrap();
        let other = block.find("Peer elsewhere").unwrap();
        assert!(same < other);
    }

    #[test]
    fn registry_block_without_self_id_omits_identity_line() {
        // Shared per-project harness bundle: no per-chat identity line (the
        // per-turn first-turn assembly adds it), but peers still listed.
        let conn = mem_conn();
        seed(&conn, "a", "One", None, None);
        seed(&conn, "b", "Two", None, None);
        let block = registry_block(&conn, None).unwrap();
        assert!(!block.contains("Your session id"));
        assert!(block.contains("Two"));
    }

    #[test]
    fn mail_envelope_marks_nonhuman_and_carries_reply_contract() {
        let conn = mem_conn();
        seed(&conn, "asker", "Asking session", None, Some("harness:claude_code"));
        seed(&conn, "target", "Target", None, None);
        let mail = store::insert_mail(&conn, "asker", "target", "question", "What did we decide about X?", 1)
            .unwrap();
        let env = mail_envelope(&conn, &mail);
        assert!(env.contains("NOT typed by the user"));
        assert!(env.contains("Asking session"));
        assert!(env.contains("claude_code"));
        assert!(env.contains("forwarded-depth 1"));
        assert!(env.contains("final message this turn"));
        assert!(env.contains("What did we decide about X?"));
        let notify = store::insert_mail(&conn, "asker", "target", "notify", "FYI", 0).unwrap();
        let env2 = mail_envelope(&conn, &notify);
        assert!(env2.contains("no reply is expected"));
    }

    #[test]
    fn mail_lifecycle_status_transitions_persist() {
        let conn = mem_conn();
        let mail = store::insert_mail(&conn, "a", "b", "question", "hi", 0).unwrap();
        assert_eq!(mail.status, store::MAIL_QUEUED);
        store::set_mail_status(&conn, &mail.id, store::MAIL_DELIVERED, None).unwrap();
        store::set_mail_status(&conn, &mail.id, store::MAIL_ANSWERED, Some("42")).unwrap();
        let got = store::get_mail(&conn, &mail.id).unwrap().unwrap();
        assert_eq!(got.status, store::MAIL_ANSWERED);
        assert_eq!(got.answer.as_deref(), Some("42"));
        assert!(got.answered_at.is_some());
        assert!(got.delivered_at.is_some());
    }

    #[test]
    fn queued_mail_fifo_and_rate_count() {
        let conn = mem_conn();
        for i in 0..3 {
            store::insert_mail(&conn, "a", "target", "notify", &format!("m{i}"), 0).unwrap();
        }
        let q = store::queued_mail_for(&conn, "target").unwrap();
        assert_eq!(q.len(), 3);
        assert_eq!(q[0].body, "m0", "FIFO by created_at");
        let n = store::count_mail_from_since(&conn, "a", crate::db::now_ts() - 3600).unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn spawn_depth_walks_origin_chain() {
        let conn = mem_conn();
        seed(&conn, "root", "Root", None, None);
        seed(&conn, "child", "Child", None, None);
        seed(&conn, "grand", "Grand", None, None);
        store::set_chat_session_origin(&conn, "child", "spawned_by:root").unwrap();
        store::set_chat_session_origin(&conn, "grand", "spawned_by:child").unwrap();
        assert_eq!(store::spawn_depth(&conn, "root").unwrap(), 0);
        assert_eq!(store::spawn_depth(&conn, "child").unwrap(), 1);
        assert_eq!(store::spawn_depth(&conn, "grand").unwrap(), 2);
    }

    #[test]
    fn recent_spawned_children_and_active_counts() {
        let conn = mem_conn();
        seed(&conn, "parent", "P", None, None);
        seed(&conn, "kid", "K", None, None);
        store::set_chat_session_origin(&conn, "kid", "spawned_by:parent").unwrap();
        // The "recent" guards compare against now; seed wrote last_active_at=2.
        conn.execute("UPDATE chat_sessions SET last_active_at = ?1 WHERE id = 'kid'",
                     rusqlite::params![crate::db::now_ts()])
            .unwrap();
        assert_eq!(store::count_recent_spawned_children(&conn, "parent", 86_400).unwrap(), 1);
        assert_eq!(store::count_recent_spawned_children(&conn, "kid", 86_400).unwrap(), 0);
        assert_eq!(store::count_active_spawned(&conn, 86_400).unwrap(), 1);
    }

    #[test]
    fn transcript_excerpt_skips_superseded_and_is_role_tagged() {
        let conn = mem_conn();
        seed(&conn, "s", "S", None, None);
        for (role, content) in [
            ("user", "hello"),
            ("assistant", "hi there"),
            ("assistant", "superseded draft"),
        ] {
            conn.execute(
                "INSERT INTO chat_messages (chat_session_id, role, content, created_at) VALUES ('s', ?1, ?2, 1)",
                rusqlite::params![role, content],
            )
            .unwrap();
        }
        conn.execute("UPDATE chat_messages SET superseded_by = 99 WHERE id = 3", []).unwrap();
        let t = store::transcript_excerpt(&conn, "s", 10, 4000).unwrap();
        assert!(t.contains("[user] hello"));
        assert!(t.contains("[assistant] hi there"));
        assert!(!t.contains("superseded draft"));
    }

    #[test]
    fn answer_watermark_only_sees_later_rows() {
        let conn = mem_conn();
        seed(&conn, "s", "S", None, None);
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at) VALUES ('s', 'assistant', 'before', 1)",
            [],
        )
        .unwrap();
        let wm = store::max_message_id(&conn, "s").unwrap();
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at) VALUES ('s', 'assistant', 'the answer', 2)",
            [],
        )
        .unwrap();
        let a = store::last_assistant_message_after(&conn, "s", wm).unwrap().unwrap();
        assert_eq!(a, "the answer");
        assert!(store::last_assistant_message_after(&conn, "s", 10_000).unwrap().is_none());
    }

    #[test]
    fn resolve_caller_uses_dedicated_field_not_target() {
        // The bridge path (caller_sid None): `session_id` is the TARGET and
        // must never be mistaken for the caller — that collision made every
        // harness message_session die on the self-mail guard.
        let args = serde_json::json!({ "session_id": "target-session" });
        assert_eq!(resolve_caller(None, &args), None);
        let args = serde_json::json!({ "session_id": "target-session", "caller_session_id": "me" });
        assert_eq!(resolve_caller(None, &args), Some("me"));
        // The built-in path: dispatch-provided identity always wins.
        assert_eq!(resolve_caller(Some("dispatch-sid"), &args), Some("dispatch-sid"));
    }

    #[test]
    fn target_kind_parses_all_agent_shapes() {
        assert!(matches!(target_kind(&None), TargetKind::Builtin));
        assert!(matches!(target_kind(&Some("builtin".into())), TargetKind::Builtin));
        assert!(matches!(target_kind(&Some("local".into())), TargetKind::Builtin));
        match target_kind(&Some("harness:opencode".into())) {
            TargetKind::Harness(h) => assert_eq!(h, "opencode"),
            _ => panic!("expected harness"),
        }
        match target_kind(&Some("acp:zed-agent".into())) {
            TargetKind::Harness(h) => assert_eq!(h, "acp:zed-agent", "ACP keeps its prefix"),
            _ => panic!("expected harness"),
        }
    }

    #[test]
    fn age_str_buckets() {
        let now = crate::db::now_ts();
        assert_eq!(age_str(now - 5), "just now");
        assert_eq!(age_str(now - 300), "5m ago");
        assert_eq!(age_str(now - 7_200), "2h ago");
        assert_eq!(age_str(now - 3 * 86_400), "3d ago");
    }

    /// MED-11: exactly `AgentSessionManager::send`'s busy rejection counts as
    /// a busy-race (→ requeue); every other send failure is terminal.
    #[test]
    fn busy_race_error_classifier() {
        assert!(is_busy_race_error("a turn is already running for this chat"));
        assert!(!is_busy_race_error("failed to spawn claude CLI: not found"));
        assert!(!is_busy_race_error("target session vanished"));
        assert!(!is_busy_race_error(""));
    }
}
