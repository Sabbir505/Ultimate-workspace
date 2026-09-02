//! Chat mode IPC command handlers (CONTRACT.md "Chat" section).

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::chat::providers::*;
use crate::chat::local_models;
use crate::db;
use crate::secrets;
use crate::types::*;
use crate::DbState;

pub(crate) type CmdResult<T> = Result<T, String>;

// ---- Chat session CRUD ----

/// Removes display-only process blocks — `<think>…</think>` reasoning and
/// `<tool>…</tool>` tool-call narration — from a message before it is sent
/// back to the API as conversation history. Also used by the harness context
/// primer (agent_sessions.rs) when handing a chat over to a fresh CLI session.
pub(crate) fn strip_think_blocks(content: &str) -> String {
    strip_tagged_blocks(&strip_tagged_blocks(content, "think"), "tool")
}

/// Strip every `<tag>…</tag>` span (and an unterminated trailing `<tag>…`).
fn strip_tagged_blocks(content: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        match rest[start..].find(&close) {
            Some(end) => rest = &rest[start + end + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

#[tauri::command]
pub fn list_chat_sessions(db: State<DbState>) -> CmdResult<Vec<ChatSession>> {
    let conn = db.0.lock();
    db::list_chat_sessions(&conn).map_err(|e| e.to_string())
}

/// Persist a command-only user message without starting an LLM turn.
///
/// Artifact commands are real timeline events, but they must not be sent
/// through `send_chat_message` (which would create an unwanted assistant
/// response). Returning the inserted row gives the frontend a stable message
/// id to anchor the proposal card to.
#[tauri::command]
pub fn persist_chat_command_message(
    chat_session_id: String,
    content: String,
    db: State<DbState>,
) -> CmdResult<ChatMessageRecord> {
    let conn = db.0.lock();
    db::add_chat_message(
        &conn,
        &chat_session_id,
        "user",
        &content,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())
}

/// Full-text search across chat message content + session titles (powers the
/// command palette "Chats" section).
#[tauri::command]
pub fn search_chat_messages(
    query: String,
    limit: Option<u32>,
    db: State<DbState>,
) -> CmdResult<Vec<ChatSearchResult>> {
    let conn = db.0.lock();
    db::search_chat_messages(&conn, &query, limit.unwrap_or(20)).map_err(|e| e.to_string())
}

// ---- Checkpoints (per-turn git working-tree snapshots) ----

/// All checkpoints for a chat session, oldest first (timeline order).
#[tauri::command]
pub fn list_chat_checkpoints(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<Vec<ChatCheckpoint>> {
    let conn = db.0.lock();
    db::list_chat_checkpoints(&conn, &chat_session_id).map_err(|e| e.to_string())
}

/// Roll the checkpoint's repo back to its snapshot. A safety checkpoint of
/// the CURRENT state is taken first and returned, so the restore itself is
/// one-click undoable. With `rollback_messages`, conversation messages after
/// the checkpointed turn are deleted too (the tree restore is primary; a
/// message-delete failure is logged and never fails the command). Emits
/// `checkpoint:created` for the safety snapshot.
#[tauri::command]
pub fn restore_chat_checkpoint(
    checkpoint_id: i64,
    rollback_messages: bool,
    app: AppHandle,
    db: State<DbState>,
) -> CmdResult<RestoreCheckpointResult> {
    let conn = db.0.lock();
    crate::checkpoints::restore(&app, &conn, checkpoint_id, rollback_messages)
        .map_err(|e| e.to_string())
}

// ---- Artifacts (30-day retention) ----

/// All persisted artifacts, most recent first.
#[tauri::command]
pub fn list_artifacts(db: State<DbState>) -> CmdResult<Vec<ArtifactRecord>> {
    let conn = db.0.lock();
    db::list_artifacts(&conn).map_err(|e| e.to_string())
}

/// Artifacts belonging to one chat session, oldest first, so a reopened chat
/// can restore its inline diagrams / file chips.
#[tauri::command]
pub fn list_chat_artifacts(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<Vec<ArtifactRecord>> {
    let conn = db.0.lock();
    db::list_artifacts_for_chat(&conn, &chat_session_id).map_err(|e| e.to_string())
}

/// Delete an artifact (DB row + on-disk file).
#[tauri::command]
pub fn delete_artifact(id: String, db: State<DbState>) -> CmdResult<()> {
    let path = {
        let conn = db.0.lock();
        db::delete_artifact(&conn, &id).map_err(|e| e.to_string())?
    };
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Delete every artifact: each DB row + its on-disk file (best-effort), then
/// sweep any leftover files inside the resolved artifacts dir that have no
/// row. Never touches anything outside the resolved artifacts dir. Returns
/// the number of files removed.
///
/// PERF (PERFORMANCE_AUDIT.md B4): the walkdir sweep + per-file deletes run
/// in `spawn_blocking` — for a large artifacts dir the inline version held
/// the IPC worker for 10–30 s.
#[tauri::command]
pub async fn delete_all_artifacts(app: AppHandle, db: State<'_, DbState>) -> CmdResult<usize> {
    let paths = {
        let conn = db.0.lock();
        let artifacts = db::list_artifacts(&conn).map_err(|e| e.to_string())?;
        let mut paths = Vec::with_capacity(artifacts.len());
        for a in &artifacts {
            if let Some(p) = db::delete_artifact(&conn, &a.id).map_err(|e| e.to_string())? {
                paths.push(p);
            }
        }
        paths
    };
    let dir = crate::chat::dispatch::artifacts_dir(&app);
    tokio::task::spawn_blocking(move || {
        let mut removed = 0usize;
        for p in &paths {
            if std::fs::remove_file(p).is_ok() {
                removed += 1;
            }
        }
        // Sweep leftover files (no DB row) — strictly inside the resolved
        // artifacts dir (the walk never escapes it).
        if let Ok(canon_dir) = dir.canonicalize() {
            for entry in walkdir::WalkDir::new(&canon_dir)
                .min_depth(1)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file() && std::fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sweep artifacts past their 30-day expiry, removing both rows and files.
/// Called on startup; returns the number of artifacts removed.
pub fn sweep_expired_artifacts(db: &Arc<parking_lot::Mutex<rusqlite::Connection>>) -> usize {
    let paths = {
        let conn = db.lock();
        db::delete_expired_artifacts(&conn).unwrap_or_default()
    };
    let n = paths.len();
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    n
}

#[tauri::command]
pub fn create_chat_session(
    provider: String,
    model: String,
    project_id: Option<String>,
    db: State<DbState>,
) -> CmdResult<ChatSession> {
    let conn = db.0.lock();
    db::create_chat_session(&conn, &provider, &model, project_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_session(
    chat_session_id: String,
    db: State<DbState>,
    agent_state: State<crate::agent_sessions::AgentSessionState>,
    chat_state: State<'_, crate::ChatState>,
    plan_state: State<'_, crate::chat::plan::PlanState>,
) -> CmdResult<()> {
    // Kill any harness process still backing this chat and drop its state,
    // including the persisted CLI session ids used for cross-turn resume.
    agent_state.0.remove_session(&chat_session_id);
    // Also abort an in-flight builtin-provider stream (SSE/tool loop): without
    // this, a chat deleted mid-turn keeps streaming tokens/cost for a session
    // whose rows no longer exist. cancel() also drops pending approval cards,
    // which releases a harness reader thread blocked on can_use_tool.
    chat_state.0.cancel(&chat_session_id);
    chat_state.0.invalidate_context_tokens(&chat_session_id);
    // Drop the session's plan state (todos, plan mode, pending feedback).
    plan_state.clear_session(&chat_session_id);
    let conn = db.0.lock();
    for harness in ["claude_code", "kimi_code", "opencode"] {
        let _ = db::delete_setting(
            &conn,
            &format!("agent.cli_session_id.{harness}.{chat_session_id}"),
        );
    }
    // Prune this session's git checkpoint refs before the rows cascade away.
    crate::checkpoints::prune_session_refs(&conn, &chat_session_id);
    // Best-effort remove the session's isolated worktree before its row is
    // deleted (roadmap P0 §3.1.1) — the `conduit/<id>` branch stays in the
    // repo, so committed work survives the delete.
    if let Ok(Some(sess)) = db::get_chat_session(&conn, &chat_session_id) {
        crate::commands::worktree_cmds::remove_worktree_for_session(&conn, &sess);
    }
    db::delete_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

/// Bind (or unbind with `None`) a chat session to a project. Drives the chat's
/// nesting under the project's expandable sidebar row.
///
/// When the binding actually changes, any worktree the chat had under the OLD
/// project is removed best-effort and its pointer cleared (roadmap P0 §3.1.1):
/// a worktree belongs to a specific project, so rebinding/unbinding orphans it
/// — the `conduit/<id>` branch stays in the repo, so nothing committed is lost.
#[tauri::command]
pub fn set_chat_session_project(
    chat_session_id: String,
    project_id: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    let before = db::get_chat_session(&conn, &chat_session_id)
        .map_err(|e| e.to_string())?;
    if let Some(sess) = &before {
        let changed = sess.project_id.as_deref() != project_id.as_deref();
        if changed && sess.worktree_path.is_some() {
            crate::commands::worktree_cmds::remove_worktree_for_session(&conn, sess);
        }
    }
    db::set_chat_session_project(&conn, &chat_session_id, project_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete every chat session that has no messages AND is not starred —
/// the empty "Untitled" rows left behind when a brand-new chat was closed
/// before the user typed anything. `keep` (when Some) protects a single
/// session from the sweep; useful when the caller is about to select it.
/// Returns the number of rows deleted.
#[tauri::command]
pub fn delete_empty_chat_sessions(
    keep: Option<String>,
    db: State<DbState>,
) -> CmdResult<usize> {
    let conn = db.0.lock();
    db::delete_empty_chat_sessions(&conn, keep.as_deref()).map_err(|e| e.to_string())
}

/// Delete every chat session and all of its messages — the bulk form of
/// `delete_chat_session`, applying the exact same per-session cleanup (kill
/// any backing harness process, drop the persisted CLI session ids, then the
/// row). Returns the number of sessions deleted.
#[tauri::command]
pub fn delete_all_chat_sessions(
    db: State<DbState>,
    agent_state: State<crate::agent_sessions::AgentSessionState>,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<usize> {
    let sessions = {
        let conn = db.0.lock();
        db::list_chat_sessions(&conn).map_err(|e| e.to_string())?
    };
    let count = sessions.len();
    let ids = sessions.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    // Phase 1 (no DB lock): kill harness processes, abort in-flight streams,
    // and drop memoized context-meter counts. These touch in-memory state
    // only, so they stay out of the DB critical section.
    for id in &ids {
        agent_state.0.remove_session(id);
        chat_state.0.cancel(id);
        chat_state.0.invalidate_context_tokens(id);
    }
    // Phase 2 (ONE lock for the whole batch — PERFORMANCE_AUDIT.md B14):
    // previously this loop re-acquired the DB mutex once per session to
    // delete 3 settings + the session row, serializing against every other
    // query in the app for O(sessions) lock cycles.
    let conn = db.0.lock();
    for sess in &sessions {
        let id = &sess.id;
        for harness in ["claude_code", "kimi_code", "opencode"] {
            let _ = db::delete_setting(
                &conn,
                &format!("agent.cli_session_id.{harness}.{id}"),
            );
        }
        // Prune git checkpoint refs before the rows cascade away.
        crate::checkpoints::prune_session_refs(&conn, id);
        // Best-effort remove each session's isolated worktree before its row
        // is deleted (roadmap P0 §3.1.1) — branches stay in the repos.
        crate::commands::worktree_cmds::remove_worktree_for_session(&conn, sess);
        db::delete_chat_session(&conn, id).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

/// Delete a single chat message (user or assistant). The optimistic
/// just-sent message in the UI has a negative id; the backend ignores it
/// because the SQL `DELETE` simply matches zero rows. No-op if the id is
/// unknown (the UI tolerates a stale id and removes the bubble locally
/// either way).
#[tauri::command]
pub async fn delete_chat_message(message_id: i64, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_chat_message(&conn, message_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Retire the conversation branch at `message_id` (edit-to-fork). Marks that
/// message and every later row of its session as superseded, so the model no
/// longer sees the old tail. Returns how many rows were retired. The user then
/// edits the fork-point message and re-sends to continue a fresh branch.
#[tauri::command]
pub fn supersede_chat_tail(message_id: i64, db: State<'_, DbState>) -> CmdResult<usize> {
    let conn = db.0.lock();
    let session_id: Option<String> = conn
        .query_row(
            "SELECT chat_session_id FROM chat_messages WHERE id = ?1",
            rusqlite::params![message_id],
            |r| r.get(0),
        )
        .ok();
    let Some(session_id) = session_id else {
        return Ok(0); // unknown message — nothing to retire
    };
    db::mark_branch_superseded(&conn, &session_id, message_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chat_session_model(
    chat_session_id: String,
    model: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_model(&conn, &chat_session_id, &model).map_err(|e| e.to_string())
}

/// Switch a chat session's provider (e.g. to `local_gguf` when the user picks
/// a local model from the selector in a cloud session, or back to a cloud
/// provider from a local one). The caller is expected to also set a model
/// valid for the new provider.
#[tauri::command]
pub fn update_chat_session_provider(
    chat_session_id: String,
    provider: String,
    db: State<DbState>,
) -> CmdResult<()> {
    // Validate against the known providers so a bogus value can't be persisted.
    let provider = match provider.as_str() {
        "anthropic" | "openai" | "anthropic_compatible" | "openai_compatible" | "openrouter"
        | "local_gguf" => provider,
        other => return Err(format!("unknown provider: {other}")),
    };
    let conn = db.0.lock();
    db::update_chat_session_provider(&conn, &chat_session_id, &provider).map_err(|e| e.to_string())
}

/// Update a chat session's permission posture. Per-session; new sessions
/// Update a chat session's dual sandbox + approval policies. `sandbox` is
/// `"read_only"` | `"workspace_write"`; `approval` is `"on_request"` |
/// `"auto_edit"` | `"full_access"`. The legacy `permission_mode` column is
/// also updated (derived from the dual policies) for backward compat.
#[tauri::command]
pub fn update_chat_session_policies(
    chat_session_id: String,
    sandbox: String,
    approval: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let sandbox = match sandbox.as_str() {
        "read_only" | "workspace_write" => sandbox,
        other => return Err(format!("unknown sandbox_policy: {other}")),
    };
    let approval = match approval.as_str() {
        "on_request" | "auto_edit" | "full_access" => approval,
        other => return Err(format!("unknown approval_policy: {other}")),
    };
    let conn = db.0.lock();
    db::update_chat_session_policies(&conn, &chat_session_id, &sandbox, &approval)
        .map_err(|e| e.to_string())
}

/// Update a chat session's watch-mode pacing override. Per-session; new sessions
/// start with no override (NULL = inherit global setting). Valid values:
/// `"on"` | `"off"` | null (clears the override, falls back to global).
#[tauri::command]
pub fn update_chat_session_watch_mode(
    chat_session_id: String,
    mode: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    // Validate against the known modes when a value is provided.
    if let Some(ref m) = mode {
        if m != "on" && m != "off" {
            return Err(format!("unknown watch_mode: {m} (expected 'on' or 'off')"));
        }
    }
    let conn = db.0.lock();
    db::update_chat_session_watch_mode(&conn, &chat_session_id, mode.as_deref()).map_err(|e| e.to_string())
}

/// Update a chat session's agent selection from the composer's
/// agent-then-model selector. Per-session; new sessions start with no
/// selection (NULL = locked model chip). Valid values: `"builtin"` |
/// `"local"` | `"harness:<id>"` where `<id>` is a registered harness adapter
/// (e.g. `"harness:claude_code"`) | `"acp:<id>"` where `<id>` is a registered
/// ACP agent (roadmap #20, e.g. `"acp:zed"`) | null (clears the selection).
/// Harness/ACP sessions route sends to the headless CLI chat path
/// (agent_sessions.rs), not the built-in provider path.
#[tauri::command]
pub fn update_chat_session_agent(
    chat_session_id: String,
    agent: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    if let Some(ref a) = agent {
        let valid = a == "builtin"
            || a == "local"
            || a
                .strip_prefix("harness:")
                .is_some_and(|id| crate::harness_adapters::get_adapter(id).is_some())
            || a
                .strip_prefix("acp:")
                .is_some_and(|id| {
                    let conn = db.0.lock();
                    crate::acp_agents::find_agent(&conn, id).is_some()
                });
        if !valid {
            return Err(format!(
                "unknown agent: {a} (expected 'builtin', 'local', 'harness:<id>', or 'acp:<id>')"
            ));
        }
    }
    let conn = db.0.lock();
    db::update_chat_session_agent(&conn, &chat_session_id, agent.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chat_session_title(
    chat_session_id: String,
    title: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_title(&conn, &chat_session_id, &title).map_err(|e| e.to_string())
}

/// Normalize a model-produced title: first non-empty line, quotes/`Title:`
/// prefix stripped, capped to a handful of words and characters, no trailing
/// punctuation.
fn clean_title(raw: &str) -> String {
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let mut t = line
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string();
    if let Some(stripped) = t.strip_prefix("Title:").or_else(|| t.strip_prefix("title:")) {
        t = stripped.trim().to_string();
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.len() > 8 {
        t = words[..8].join(" ");
    }
    if t.chars().count() > 60 {
        t = t.chars().take(60).collect::<String>().trim().to_string();
    }
    t.trim_end_matches(['.', ',', ';', ':']).trim().to_string()
}

/// Compact token-count formatter used in user-facing status lines (e.g.
/// "Compacted 8.2k → 1.1k tokens"). Mirrors the frontend's `formatTokens`
/// but is kept as a free function so the backend doesn't have to depend on
/// the lib crate. 0 returns "0".
pub(crate) fn format_compact_token_count(n: i64) -> String {
    let n = n.max(0) as u64;
    if n >= 1_000_000 {
        let v = n as f64 / 1_000_000.0;
        if v >= 10.0 {
            format!("{}M", v.round() as u64)
        } else {
            format!("{:.1}M", v)
        }
    } else if n >= 1000 {
        let v = n as f64 / 1000.0;
        if v >= 100.0 {
            format!("{}k", v.round() as u64)
        } else {
            format!("{:.1}k", v)
        }
    } else {
        n.to_string()
    }
}

/// One-shot (non-streaming) OpenAI-style completion returning the message text.
pub async fn openai_oneshot(
    client: &reqwest::Client,
    api_key: &str,
    base: &str,
    model: &str,
    system: &str,
    user: &str,
) -> CmdResult<String> {
    let url = format!("{base}/v1/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    // B-16: check the status BEFORE parsing — an error body has no `choices`,
    // so an unchecked 401/429/5xx used to come back as a silent "" (titles,
    // commit messages, automations all recorded blank successes).
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let snippet = crate::util::truncate_chars(body.trim(), 500);
        return Err(format!("HTTP {status}: {snippet}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

/// One-shot (non-streaming) Anthropic-style completion returning the text.
/// `max_tokens` is required by Anthropic's API; callers choose it (titles: 32,
/// commit messages: 200 for subject + body).
pub async fn anthropic_oneshot(
    client: &reqwest::Client,
    api_key: &str,
    base: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> CmdResult<String> {
    let url = format!("{base}/v1/messages");
    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": false,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    });
    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    // B-16: same as the OpenAI oneshot — surface HTTP errors instead of
    // silently returning "".
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let snippet = crate::util::truncate_chars(body.trim(), 500);
        return Err(format!("HTTP {status}: {snippet}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["content"][0]["text"].as_str().unwrap_or("").to_string())
}

/// Ask the session's model for a short (3–6 word) title summarizing the
/// conversation so far and persist it. Returns the new title, or `None` when
/// one couldn't be produced (missing key/model, empty transcript, API error) —
/// the caller keeps whatever title already exists.
#[tauri::command]
pub async fn generate_chat_title(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    // mi4: one lock acquisition for the whole read phase — session row, API
    // key, provider settings. Four separate locks serialized against every
    // other DB reader three extra times for no reason (all reads are
    // independent point lookups).
    let (provider_str, model_str, api_key, base_url, model_override) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        let key = secrets::get_chat_api_key(&conn, &cs.provider);
        let base = db::get_setting(&conn, &format!("chat.{}.base_url", cs.provider))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{}.model", cs.provider))
            .map_err(|e| e.to_string())?;
        (cs.provider, cs.model, key, base, mo)
    };

    // local_gguf is keyless (runs locally); skip the key check and pass
    // an empty string as the key (the sidecar ignores the auth header).
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();

    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return Ok(None),
        }
    } else {
        model_str
    };

    // Build a compact transcript from history (length-capped). Fetch rows
    // under the lock, format AFTER releasing it (strip + truncate are pure
    // CPU work — no reason to hold the DB mutex through them).
    let transcript = {
        let records = {
            let conn = db.0.lock();
            db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?
        };
        let mut t = String::new();
        for r in &records {
            let text = strip_think_blocks(&r.content);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let who = if r.role == "user" { "User" } else { "Assistant" };
            let snippet: String = text.chars().take(600).collect();
            t.push_str(who);
            t.push_str(": ");
            t.push_str(&snippet);
            t.push('\n');
            if t.len() > 4000 {
                break;
            }
        }
        t
    };
    if transcript.trim().is_empty() {
        return Ok(None);
    }

    let system = "You generate a very short chat title (3 to 6 words) summarizing \
        the conversation topic. Reply with ONLY the title text — no surrounding \
        quotes, no trailing punctuation, no 'Title:' prefix.";
    let user = format!("Conversation:\n{transcript}\nTitle:");

    let base_url = base_url.filter(|b| !b.trim().is_empty());
    // B-10: these are one-shot JSON calls — a total timeout is safe here and
    // bounds a wedged endpoint instead of hanging the async command forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let raw = match provider_str.as_str() {
        "openai" => {
            let base = base_url.as_deref().unwrap_or(OpenAIProvider::DEFAULT_BASE);
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "openrouter" => {
            let base = base_url.as_deref().unwrap_or(OpenRouterProvider::DEFAULT_BASE);
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "openai_compatible" | "local_gguf" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "anthropic" => {
            let base = base_url.as_deref().unwrap_or(AnthropicProvider::DEFAULT_BASE);
            anthropic_oneshot(&client, &api_key, base, &model, system, &user, 32).await?
        }
        "anthropic_compatible" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            anthropic_oneshot(&client, &api_key, base, &model, system, &user, 32).await?
        }
        _ => return Ok(None),
    };

    let title = clean_title(&raw);
    if title.is_empty() {
        return Ok(None);
    }
    {
        let conn = db.0.lock();
        db::update_chat_session_title(&conn, &chat_session_id, &title).map_err(|e| e.to_string())?;
    }
    Ok(Some(title))
}

/// Generate a Conventional-Commits-style commit message from the working-tree
/// diff, using the same provider/model/key resolution as `generate_chat_title`.
/// Returns None when there's no diff, no model configured, or generation fails
/// — callers fall back to an empty textarea the user fills in themselves.
#[tauri::command]
pub async fn generate_commit_message(
    path: String,
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    // Resolve provider + model. Prefer the dedicated commit-message settings
    // (commitMessage.provider + commitMessage.model) when the user has picked
    // a fast/utility model for this task; fall back to the active chat
    // session's provider/model. The pair is required because API keys and base
    // URLs are stored per-provider — a bare model string can't resolve them.
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cm_provider = db::get_setting(&conn, "commitMessage.provider")
            .ok()
            .flatten()
            .filter(|p| !p.trim().is_empty());
        let cm_model = db::get_setting(&conn, "commitMessage.model")
            .ok()
            .flatten()
            .filter(|m| !m.trim().is_empty());
        match (cm_provider, cm_model) {
            (Some(p), Some(m)) => (p, m),
            _ => {
                // Fall back to the session's configured provider + model.
                let cs = db::get_chat_session(&conn, &chat_session_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "chat session not found".to_string())?;
                (cs.provider, cs.model)
            }
        }
    };

    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();

    let (base_url, model_override) = {
        let conn = db.0.lock();
        let base = db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .map_err(|e| e.to_string())?;
        (base, mo)
    };
    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return Ok(None),
        }
    } else {
        model_str
    };

    // Fetch the working-tree diff (git diff HEAD, capped at 200KB by
    // get_git_diff). Truncate further to keep the prompt bounded.
    let diff = crate::git::get_git_diff(Path::new(&path))?;
    let diff: String = diff.chars().take(8000).collect();
    if diff.trim().is_empty() {
        return Ok(None);
    }

    let system = "You write a ONE-LINE Conventional Commits commit message from a \
        unified diff. Use imperative mood (e.g. 'add', 'fix', 'refactor'). The \
        message must be a single subject line of at most 80 characters, \
        prefixed with a type like feat:, fix:, refactor:, docs:, chore:, or \
        test:. NO body, NO bullet points, NO blank line — just the subject. \
        Reply with ONLY the subject line — no surrounding quotes, no \
        'Commit message:' prefix, no explanation.";
    let user = format!("Diff:\n{diff}\nCommit subject:");

    let base_url = base_url.filter(|b| !b.trim().is_empty());
    // B-10: these are one-shot JSON calls — a total timeout is safe here and
    // bounds a wedged endpoint instead of hanging the async command forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let raw = match provider_str.as_str() {
        "openai" => {
            let base = base_url.as_deref().unwrap_or(OpenAIProvider::DEFAULT_BASE);
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "openrouter" => {
            let base = base_url.as_deref().unwrap_or(OpenRouterProvider::DEFAULT_BASE);
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "openai_compatible" | "local_gguf" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "anthropic" => {
            let base = base_url.as_deref().unwrap_or(AnthropicProvider::DEFAULT_BASE);
            // 64 tokens is plenty for a single ≤80-char subject line and keeps
            // generation fast (latency scales with output tokens).
            anthropic_oneshot(&client, &api_key, base, &model, system, &user, 64).await?
        }
        "anthropic_compatible" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            anthropic_oneshot(&client, &api_key, base, &model, system, &user, 64).await?
        }
        _ => return Ok(None),
    };

    // Reasoning models (DeepSeek-R1, Qwen-QwQ, …) wrap chain-of-thought in
    // <think>…</think> before the answer — strip it so only the subject remains.
    let raw = strip_think_blocks(&raw);
    let msg = clean_commit_message(&raw);
    if msg.is_empty() {
        Ok(None)
    } else {
        Ok(Some(msg))
    }
}

/// Tidy a model-generated commit subject: take the first non-empty line,
/// strip stray quotes/labels, and cap at 80 chars (the subject-only budget).
fn clean_commit_message(raw: &str) -> String {
    // The prompt asks for one line; take the first non-empty one in case the
    // model added a blank line or trailing commentary.
    let mut t = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    // Strip surrounding quotes the model sometimes adds.
    t = t
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string();
    // Drop a leading "Commit message:" / "Subject:" label if present.
    for prefix in [
        "Commit message:",
        "Commit Message:",
        "Commit subject:",
        "Subject:",
        "Message:",
    ] {
        if let Some(stripped) = t.strip_prefix(prefix) {
            t = stripped.trim().to_string();
            break;
        }
    }
    // Enforce the 80-char subject cap.
    if t.chars().count() > 80 {
        t = t.chars().take(80).collect::<String>().trim_end().to_string();
    }
    t.trim().to_string()
}

/// Generate an automated, model-backed review of the working-tree diff
/// (§3.2.8 "Diff review" quick action). Reviews either the whole working
/// tree (`file_path` = None) or a single file (`file_path` = Some(path)).
///
/// Provider/model resolution mirrors `generate_commit_message`: a dedicated
/// `diffReview.provider` + `diffReview.model` pair is preferred, then the
/// active chat session's `(provider, model)`, then — when no chat session is
/// bound (the diff panel isn't tied to one chat) — the first provider with a
/// configured API key. Returns None when there's no diff or generation fails.
#[tauri::command]
pub async fn generate_diff_review(
    path: String,
    chat_session_id: Option<String>,
    file_path: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    // Resolve provider + model. Preference order: dedicated diffReview
    // settings, the bound chat session's provider/model, then the first
    // provider that has a usable API key (the panel isn't tied to a single
    // chat, so "whatever the app has configured" is the sane default).
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let dr_provider = db::get_setting(&conn, "diffReview.provider")
            .ok()
            .flatten()
            .filter(|p| !p.trim().is_empty());
        let dr_model = db::get_setting(&conn, "diffReview.model")
            .ok()
            .flatten()
            .filter(|m| !m.trim().is_empty());
        if let (Some(p), Some(m)) = (dr_provider, dr_model) {
            (p, m)
        } else if let Some(cs) = chat_session_id
            .as_deref()
            .and_then(|sid| db::get_chat_session(&conn, sid).ok().flatten())
        {
            (cs.provider, cs.model)
        } else {
            const PROVIDERS: [&str; 5] =
                ["openai", "openrouter", "anthropic", "openai_compatible", "anthropic_compatible"];
            let mut fallback = None;
            for p in PROVIDERS {
                if secrets::get_chat_api_key(&conn, p).is_some() {
                    fallback = Some(p.to_string());
                    break;
                }
            }
            let p = fallback.unwrap_or_else(|| "openai".to_string());
            let m = db::get_setting(&conn, &format!("chat.{p}.model"))
                .ok()
                .flatten()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "gpt-4o-mini".to_string());
            (p, m)
        }
    };

    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();

    let (base_url, model_override) = {
        let conn = db.0.lock();
        let base = db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .map_err(|e| e.to_string())?;
        (base, mo)
    };
    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return Ok(None),
        }
    } else {
        model_str
    };

    // Fetch the diff: whole working tree, or a single file. Reviews benefit
    // from more context than a one-line commit subject, so the cap is higher —
    // but still bounded so a giant diff can't blow the prompt window.
    let diff = match &file_path {
        Some(fp) => crate::git::get_git_file_diff(Path::new(&path), fp)?,
        None => crate::git::get_git_diff(Path::new(&path))?,
    };
    let diff: String = diff.chars().take(24000).collect();
    if diff.trim().is_empty() {
        return Ok(None);
    }

    let system = concat!(
        "You are a senior engineer doing a focused, high-signal code review. ",
        "Read the unified diff and write a concise review. Structure it with three short sections:\n",
        "## Summary — 2–3 sentences on what the change does and your overall take.\n",
        "## Issues — bullet list of concrete bugs, edge cases, or regressions, each ",
        "pointing at the relevant file/line and a one-line fix. Only list real problems; don't invent nitpicks.\n",
        "## Suggestions — optional: smaller improvements (naming, extraction, tests) worth doing, in a brief bullet list.\n",
        "Use `file +line: message` to reference exact spots. If the diff is ",
        "trivial (typos, docs, formatting), say so plainly instead of padding. ",
        "Keep the whole review under ~60 lines of Markdown. Do not restate the diff back."
    );
    let user = format!("Please review this diff:\n\n{diff}");

    let base_url = base_url.filter(|b| !b.trim().is_empty());
    // B-10: these are one-shot JSON calls — a total timeout is safe here and
    // bounds a wedged endpoint instead of hanging the async command forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let raw = match provider_str.as_str() {
        "openai" => {
            let base = base_url.as_deref().unwrap_or(OpenAIProvider::DEFAULT_BASE);
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "openrouter" => {
            let base = base_url.as_deref().unwrap_or(OpenRouterProvider::DEFAULT_BASE);
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "openai_compatible" | "local_gguf" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            openai_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "anthropic" => {
            let base = base_url.as_deref().unwrap_or(AnthropicProvider::DEFAULT_BASE);
            anthropic_oneshot(&client, &api_key, base, &model, system, &user, 2048).await?
        }
        "anthropic_compatible" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            anthropic_oneshot(&client, &api_key, base, &model, system, &user, 2048).await?
        }
        _ => return Ok(None),
    };

    let review = strip_think_blocks(&raw).trim().to_string();
    if review.is_empty() { Ok(None) } else { Ok(Some(review)) }
}

#[tauri::command]
pub fn set_chat_session_starred(
    chat_session_id: String,
    starred: bool,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_chat_session_starred(&conn, &chat_session_id, starred).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_chat_session_unread(
    chat_session_id: String,
    unread: bool,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_chat_session_unread(&conn, &chat_session_id, unread).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chat_messages(
    chat_session_id: String,
    // M7: keyset pagination. `None`/`None` keeps the legacy behavior of the
    // full history (some callers — e.g. export — need it all), but the chat
    // view now pages 200 at a time.
    before_id: Option<i64>,
    limit: Option<i64>,
    db: State<DbState>,
) -> CmdResult<Vec<ChatMessageRecord>> {
    let conn = db.0.lock();
    match (before_id, limit) {
        (None, None) => db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string()),
        (b, l) => db::list_chat_messages_page(&conn, &chat_session_id, b, l.unwrap_or(200))
            .map_err(|e| e.to_string()),
    }
}

/// Session-level aggregate perf metrics for the composer row. Sums / weighted-
/// averages the per-turn perf columns on `chat_messages` (assistant rows only
/// — those carry `started_at`/`completed_at`/perf). Legacy rows with `NULL`
/// perf fields contribute zero and don't weigh the averages.
#[tauri::command]
pub fn get_chat_session_metrics(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<ChatSessionMetricsPayload> {
    let conn = db.0.lock();
    let all = db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?;

    let mut llm_ms = 0i64;
    let mut tool_ms = 0i64;
    let mut ttft_sum = 0i64;
    let mut ttft_n = 0i64;
    let mut tok_wsum = 0.0; // Σ tok_s * output_tokens
    let mut tok_wout = 0i64; // Σ output_tokens over rows WITH tok/s — the weighted average's denominator (kept separate from the raw output total below)
    let mut output_sum = 0i64;
    let mut input_sum = 0i64;
    let mut cache_read_sum = 0i64;
    let mut total_prompt_sum = 0i64; // Σ per-row normalized total billed prompt
    let mut turn_count = 0i64;

    for m in &all {
        if m.role != "assistant" {
            continue;
        }
        turn_count += 1;
        if let Some(v) = m.llm_time_ms {
            llm_ms += v;
        }
        if let Some(v) = m.tool_time_ms {
            tool_ms += v;
        }
        if let Some(v) = m.ttft_ms {
            ttft_sum += v;
            ttft_n += 1;
        }
        if let (Some(ts), Some(out)) = (m.tokens_per_second, m.output_tokens) {
            if out > 0 {
                tok_wsum += ts * out as f64;
                tok_wout += out;
            }
        }
        input_sum += m.input_tokens.unwrap_or(0);
        output_sum += m.output_tokens.unwrap_or(0);

        // Cache-hit corpus: only rows whose provider actually reported cache
        // fields contribute. Providers split the prompt two ways —
        // OpenAI-style `prompt_tokens` is INCLUSIVE of cached tokens,
        // Anthropic reports uncached input with the cache fields separate —
        // so normalize per row to the total billed prompt before summing
        // (same math as `turn_perf::cache_hit_rate`, so a session's
        // aggregate converges on the per-turn values).
        let read = m.cache_read_input_tokens.unwrap_or(0);
        let creation = m.cache_creation_input_tokens.unwrap_or(0);
        if read > 0 || creation > 0 {
            let reported_input = m.input_tokens.unwrap_or(0);
            let uncached = if provider_input_includes_cache(m.provider.as_deref()) {
                (reported_input - read).max(0)
            } else {
                reported_input
            };
            cache_read_sum += read;
            total_prompt_sum += uncached + read + creation;
        }
    }

    let cache_hit = if cache_read_sum > 0 && total_prompt_sum > 0 {
        Some(cache_read_sum as f64 / total_prompt_sum as f64)
    } else {
        None
    };

    let tokens_per_second = if tok_wout > 0 {
        Some(tok_wsum / tok_wout as f64)
    } else {
        None
    };

    Ok(ChatSessionMetricsPayload {
        chat_session_id,
        llm_time_ms: (llm_ms > 0).then_some(llm_ms),
        tool_time_ms: (tool_ms > 0).then_some(tool_ms),
        // `then_some` evaluates eagerly — use `then` so the division only
        // happens when `ttft_n > 0` (avoids divide-by-zero on empty sessions).
        ttft_avg_ms: (ttft_n > 0).then(|| ttft_sum / ttft_n),
        tokens_per_second,
        cache_hit_rate: cache_hit.filter(|v| v.is_finite()),
        input_tokens: input_sum,
        output_tokens: output_sum,
        turn_count,
    })
}

/// True when the provider's persisted `input_tokens` already INCLUDES the
/// cached-prompt tokens (OpenAI-style: `prompt_tokens` ⊇
/// `prompt_tokens_details.cached_tokens`). Anthropic-style providers (and
/// unknown/harness labels, which follow the Claude Code convention) report
/// uncached input with cache fields billed separately.
fn provider_input_includes_cache(provider: Option<&str>) -> bool {
    matches!(
        provider,
        Some("openai") | Some("openai_compatible") | Some("openrouter") | Some("local_gguf")
    )
}

#[tauri::command]
pub fn touch_chat_session(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::touch_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

// ---- Send / cancel ----

/// Turn composer attachments into (extra message text, vision images). Text
/// files and extracted document text are appended to the message body so they
/// persist in history; images are collected separately to be sent as vision
/// content on the live turn (a short placeholder is added to the body text).
pub(crate) fn process_attachments(
    attachments: &[ChatAttachmentInput],
) -> (String, Vec<ChatImage>) {
    let mut extra = String::new();
    let mut images: Vec<ChatImage> = Vec::new();
    for a in attachments {
        match a.kind.as_str() {
            "image" => {
                if let (Some(data), Some(media_type)) = (&a.data, &a.media_type) {
                    images.push(ChatImage {
                        media_type: media_type.clone(),
                        data: data.clone(),
                    });
                    extra.push_str(&format!("\n\n[Attached image: {}]", a.name));
                }
            }
            "doc" => {
                let extracted = match (&a.data, &a.format) {
                    (Some(b64), Some(fmt)) => base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .ok()
                        .and_then(|bytes| {
                            crate::chat::office::doc_to_text(&fmt.to_ascii_lowercase(), &bytes)
                        }),
                    _ => None,
                };
                match extracted {
                    Some(text) => extra.push_str(&format!(
                        "\n\nAttached file: {}\n```\n{}\n```",
                        a.name, text
                    )),
                    None => extra.push_str(&format!(
                        "\n\n[Attached file {} could not be read as text.]",
                        a.name
                    )),
                }
            }
            _ => {
                // "text" (and unknown kinds): inline the provided decoded text.
                if let Some(text) = &a.text {
                    extra.push_str(&format!(
                        "\n\nAttached file: {}\n```\n{}\n```",
                        a.name, text
                    ));
                }
            }
        }
    }
    (extra, images)
}

/// Persists the user message, looks up provider/model/api_key/base_url for the
/// session, assembles messages from history, and kicks off streaming.
#[tauri::command]
pub async fn send_chat_message(
    chat_session_id: String,
    content: String,
    effort: Option<String>,
    tools_enabled: Option<bool>,
    code_exec_enabled: Option<bool>,
    attachments: Option<Vec<ChatAttachmentInput>>,
    // Explicitly force research mode for this turn (from the composer's
    // "+" → "Research" option), independent of the keyword heuristic. Only
    // takes effect when tools are enabled — the scaffolding references tools.
    force_research: Option<bool>,
    // Extended-thinking toggle from the composer "brain" button. None leaves
    // the model at its default; Some(true)/Some(false) explicitly enable or
    // disable thinking for this turn.
    thinking: Option<bool>,
    // Custom working folder chosen in the composer ("+" → folder icon) for
    // this chat session. Granted as an extra fs_root for the turn so mutating
    // tools may write inside it even though it isn't a registered project.
    extra_fs_root: Option<String>,
    chat_state: State<'_, crate::ChatState>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<()> {
    let (extra_text, images) = match &attachments {
        Some(list) => process_attachments(list),
        None => (String::new(), Vec::new()),
    };
    // Detect research-shaped requests on the *original* (pre-attachment)
    // message so attached prose doesn't false-trigger the research scaffolding.
    // Research mode applies when tools are enabled (the scaffolding references
    // web_search/browser_read/add_source_note/generate_file). The composer's
    // "Research" button forces it on regardless of the keyword heuristic.
    let research_mode = tools_enabled.unwrap_or(false)
        && (force_research.unwrap_or(false) || crate::chat::is_research_request(&content));
    let content = format!("{content}{extra_text}");
    let chat_mgr = &chat_state.0;
    // 1. Look up the session — provider/model/permission policies for this turn.
    let (provider_str, model_str, sandbox_str, approval_str, mode_label) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (
            cs.provider,
            cs.model,
            cs.sandbox_policy,
            cs.approval_policy,
            cs.permission_mode,
        )
    };
    let sandbox = crate::chat::permission::SandboxPolicy::from_db(&sandbox_str);
    let approval = crate::chat::permission::ApprovalPolicy::from_db(&approval_str);

    // Attach-on-demand: ONLY connectors / MCP-gallery servers attached to this
    // session ship their tool schemas — rows in `chat_session_connectors`
    // written by the composer's @-picker, the model-driven `attach_connector`
    // tool, or the keyword fast-path below. Everything else that is connected
    // stays reachable through the system-prompt manifest + attach meta-tools,
    // so a fresh turn sends only the system prompt + built-in tools.
    // MCP-gallery servers ride the same table under `mcp:<server_id>` keys.
    let tools_on = tools_enabled.unwrap_or(false);
    let (mut connector_ids, mcp_server_ids): (Vec<String>, Vec<String>) = {
        let conn = db.0.lock();
        let mut cs: Vec<String> = Vec::new();
        let mut ms: Vec<String> = Vec::new();
        for row in db::list_chat_session_connectors(&conn, &chat_session_id).unwrap_or_default() {
            if let Some(server_id) = row.strip_prefix("mcp:") {
                ms.push(server_id.to_string());
            } else {
                cs.push(row);
            }
        }
        (cs, ms)
    };
    // Keyword fast-path: an explicit "@gmail" token or a registry keyword
    // phrase ("my inbox", "google calendar") attaches the connector directly
    // this turn — no `attach_connector` round-trip, which small local models
    // struggle with. Like every attach path it persists for the session.
    if tools_on {
        let available: Vec<String> = {
            let conn = db.0.lock();
            db::list_connector_credential_rows(&conn)
                .unwrap_or_default()
                .into_iter()
                .map(|r| r.connector_id)
                .chain(
                    crate::connectors::CONNECTORS
                        .iter()
                        .filter(|c| c.is_public())
                        .map(|c| c.id.to_string()),
                )
                .collect()
        };
        let avail_refs: Vec<&str> = available.iter().map(|s| s.as_str()).collect();
        for id in crate::chat::prompts::detect_connector_mentions(&content, &avail_refs) {
            if !connector_ids.contains(&id) {
                connector_ids.push(id.clone());
            }
            let conn = db.0.lock();
            let _ = db::add_chat_session_connector(&conn, &chat_session_id, &id);
        }
    }
    // Manifest of still-attachable sources for the system prompt. Derived
    // AFTER the fast-path so just-attached connectors drop out of it.
    let manifest = {
        let (conns, mcp) = attach_availability(&app, &connector_ids, &mcp_server_ids);
        crate::chat::prompts::attach_manifest_segment(&conns, &mcp)
    };

    // 2. Persist the user message.
    {
        let conn = db.0.lock();
        db::add_chat_message(&conn, &chat_session_id, "user", &content, None, None, None, None, None, None, None, None, None, None, None, None, None, None, None)
            .map_err(|e| e.to_string())?;
        db::touch_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())?;
    }

    // 3. Resolve provider id.
    let provider_id: ChatProviderId = match provider_str.as_str() {
        "anthropic" => ChatProviderId::Anthropic,
        "openai" => ChatProviderId::OpenAI,
        "anthropic_compatible" => ChatProviderId::AnthropicCompatible,
        "openai_compatible" => ChatProviderId::OpenAICompatible,
        "openrouter" => ChatProviderId::OpenRouter,
        "local_gguf" => ChatProviderId::LocalGguf,
        other => return Err(format!("unknown provider: {other}")),
    };

    // 3b. Local model auto-warm on restart. After an app restart the
    // llama-server sidecar is gone, but the session still remembers the model
    // name and the stale chat.local_gguf.base_url — so the first send into a
    // local_gguf session would hit a dead endpoint ("error sending request for
    // URL …/v1/chat/completions"). When no sidecar is running, re-scan the GGUF
    // folders, find the file whose name/filename matches the session's model,
    // and (re)spawn llama-server so the send proceeds against a live endpoint.
    // A chat:status notice keeps the "Loading local model…" indicator up while
    // the sidecar warms; it clears on the first token / done / error.
    if provider_str == "local_gguf" {
        let local_state = app
            .try_state::<crate::chat::local_models::LocalModelState>()
            .map(|s| s.0.clone());
        let sidecar_running = local_state
            .as_ref()
            .map(|l| l.status().is_some())
            .unwrap_or(false);
        if !sidecar_running {
            let _ = app.emit(
                "chat:status",
                crate::types::ChatStatusPayload {
                    chat_session_id: chat_session_id.clone(),
                    reason: "local_model_loading".to_string(),
                    message: "Local model is starting up — this can take a moment before the first token arrives.".to_string(),
                },
            );
            if let Some(local) = local_state {
                // Resolve the GGUF file path from the session's stored model
                // name (scan default locations + user-added folders, matching
                // scan_local_models so the same models are reachable). Falls
                // through silently if the model file can't be found — the send
                // then surfaces the real connection error to the user.
                let want = model_str.trim();
                eprintln!("[local-warmup] provider=local_gguf, session model name = {:?}", want);
                if !want.is_empty() {
                    let mut files = crate::chat::local_models::scan_default_locations();
                    let seen: std::collections::HashSet<String> =
                        files.iter().map(|f| f.id.clone()).collect();
                    let stored_folders = {
                        let conn = db.0.lock();
                        db::get_setting(&conn, "localModels.folders")
                    };
                    if let Ok(Some(json)) = stored_folders {
                        if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
                            for f in list.into_iter().filter(|s| !s.trim().is_empty()) {
                                for file in crate::chat::local_models::scan_folder(
                                    std::path::Path::new(&f),
                                    "user",
                                ) {
                                    if seen.contains(&file.id) {
                                        continue;
                                    }
                                    files.push(file);
                                }
                            }
                        }
                    }
                    eprintln!(
                        "[local-warmup] scanned {} gguf files; candidates:",
                        files.len()
                    );
                    for f in &files {
                        eprintln!(
                            "  - name={:?} filename={:?} path={:?}",
                            f.meta.name, f.filename, f.path
                        );
                    }
                    // Match by exact name, exact filename, or quant-stripped
                    // name equality (the session may have stored a display name
                    // that omits the .gguf / quant tag, or vice-versa).
                    let want_lower = want.to_lowercase();
                    let strip = |s: &str| -> String {
                        s.trim_end_matches(".gguf")
                            .trim_end_matches(".GGUF")
                            .to_string()
                    };
                    let matched = files.into_iter().find(|f| {
                        let name = f.meta.name.as_deref().unwrap_or("");
                        // The session most often stores the full file path as
                        // the model name (start_local_model is called with the
                        // path), so compare against f.path / f.id first.
                        f.path == want
                            || f.id == want
                            || f.path.to_lowercase() == want_lower
                            || name == want
                            || f.filename == want
                            || name.to_lowercase() == want_lower
                            || f.filename.to_lowercase() == want_lower
                            || strip(name) == want
                            || strip(&f.filename) == want
                            || strip(name).to_lowercase() == want_lower
                            || strip(&f.filename).to_lowercase() == want_lower
                    });
                    if let Some(g) = matched {
                        eprintln!(
                            "[local-warmup] matched — starting sidecar for path={:?}",
                            g.path
                        );
                        // (Re)spawn the sidecar. start() health-checks and
                        // returns the fresh base_url + model. We must PERSIST
                        // them to settings ourselves — start() only inserts into
                        // the in-memory registry; the persistence is done by the
                        // start_local_model command wrapper, which we're not
                        // going through here. Without this write, step 5 below
                        // reads the stale chat.local_gguf.base_url (the dead port
                        // from before the restart) and the send fails. The
                        // user's persisted runtime overrides (incl. last-good
                        // ngl) load here too, so warm-up respawns honor them
                        // instead of re-probing from scratch.
                        let warm_model_id = g.meta.name.clone().unwrap_or_else(|| g.filename.clone());
                        let warm_overrides = {
                            let conn = db.0.lock();
                            local_models::load_overrides(&conn, &warm_model_id)
                        };
                        // Pre-read the llama-server path (must not hold the lock across await).
                        let warm_llama_path = {
                            let conn = db.0.lock();
                            crate::db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY)
                                .ok()
                                .flatten()
                        };
                        match local
                            .start(
                                warm_model_id,
                                &g.path,
                                g.mmproj_path.as_deref(),
                                Some(&warm_overrides),
                                warm_llama_path,
                            )
                            .await
                        {
                            Ok(started) => {
                                let conn = db.0.lock();
                                let _ = db::set_setting(
                                    &conn,
                                    "chat.local_gguf.base_url",
                                    &started.base_url,
                                );
                                let _ = db::set_setting(
                                    &conn,
                                    "chat.local_gguf.model",
                                    &started.model_id,
                                );
                                // No chat.active_provider write here either —
                                // same reasoning as start_local_model: a warm-up
                                // respawn must not re-point NEW chats at local.
                                local_models::save_last_good_ngl(
                                    &conn,
                                    &started.model_id,
                                    started.n_gpu_layers,
                                );
                                eprintln!(
                                    "[local-warmup] sidecar started OK, persisted base_url={:?}",
                                    started.base_url
                                );
                                // Same prompt-cache warmup as start_local_model —
                                // queued behind the in-flight send on
                                // llama-server, so it primes the NEXT turn.
                                // Mirrors this turn's toggles so turn 2's
                                // prefix matches.
                                spawn_prompt_warmup(
                                    app.clone(),
                                    started.base_url.clone(),
                                    started.model_id.clone(),
                                    chat_session_id.clone(),
                                    tools_on,
                                    code_exec_enabled.unwrap_or(false),
                                );
                            }
                            Err(e) => {
                                eprintln!("[local-warmup] start FAILED: {e}");
                                return Err(format!(
                                    "The local model \"{want}\" could not be started after restart: {e}"
                                ));
                            }
                        }
                    } else {
                        eprintln!("[local-warmup] NO MATCH for {:?} — send will hit the stale URL", want);
                    }
                }
            }
        }
    }

    // 4. Load API key from keychain. local_gguf is keyless — llama-server
    // ignores the Authorization header, so we use a dummy placeholder.
    let api_key = if provider_str == "local_gguf" {
        "no-key".to_string()
    } else {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
            .ok_or_else(|| format!("no API key configured for provider: {provider_str}"))?
    };

    // 5. Load optional base_url and model override from app_settings.
    let (base_url, model_override) = {
        let conn = db.0.lock();
        let base = db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .map_err(|e| e.to_string())?;
        (base, mo)
    };
    if provider_str == "local_gguf" {
        eprintln!(
            "[local-warmup] send using base_url={:?} model_override={:?}",
            base_url, model_override
        );
    }
    // Per-session model wins; the Settings model is only a default for
    // sessions created without one.
    //
    // SPECIAL CASE: local_gguf. The session's stored `model` field carries
    // the GGUF metadata *name* (e.g. "DeepSeek R1 0528 Qwen3 8B") because
    // that's what the dropdown shows — but llama-server was started against
    // `chat.local_gguf.model`, which is the file *path* (or the registry
    // id-slug the caller passed to start_local_model). Sending the metadata
    // name to llama-server makes it reject the request with HTTP 400, since
    // the running model doesn't match that string. For local_gguf we
    // therefore always prefer the sidecar's started-with model, which is the
    // model llama-server actually has loaded. The session's display name is
    // still used for the dropdown via the read path (list_chat_sessions),
    // just not for the request body.
    let model = if provider_str == "local_gguf" {
        model_override
            .filter(|m| !m.trim().is_empty())
            .or_else(|| {
                if model_str.trim().is_empty() {
                    None
                } else {
                    Some(model_str)
                }
            })
            .ok_or_else(|| "no model configured for this chat".to_string())?
    } else if model_str.trim().is_empty() {
        model_override.ok_or_else(|| "no model configured for this chat".to_string())?
    } else {
        model_str
    };
    let effort = effort.filter(|e| !e.trim().is_empty());

    // 5b. Assemble the system prompt: the CORE source-code prompt
    // (provider/model-aware, always included) comes first, then the user's
    // custom prompt + skills (global, provider-independent settings), plus
    // built-in tool guidance.
    // Plan mode seeds from the persisted row label ("plan" on permission_mode)
    // so it survives app restarts; the in-memory PlanState flag is what the
    // dispatch gate reads per tool call. set_plan_mode no-ops (and emits
    // nothing) when the flag already matches.
    let session_plan_mode = {
        let plan_state = app.state::<crate::chat::plan::PlanState>();
        let persisted = mode_label == "plan";
        plan_state.set_plan_mode(Some(&app), &chat_session_id, persisted, "restored from session", &mode_label);
        tools_on && plan_state.plan_mode(&chat_session_id)
    };
    let (mut system, prompt_audit) = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let skills = parse_invoked_skills(&content);
        let built = crate::chat::build_system_prompt(
            provider_id.clone(),
            &model,
            custom.as_deref(),
            &skills,
            tools_on,
            research_mode,
            session_plan_mode,
            manifest.as_deref(),
        );
        // [prompt-audit] inputs captured before `custom`/`skills` are consumed.
        let audit = (
            custom.as_deref().map(|c| c.trim().len()).unwrap_or(0),
            skills.iter().map(|(_, body)| body.len()).sum::<usize>(),
        );
        (built, audit)
    };
    // [prompt-audit]: attribute the system prompt's size on every send. The
    // catalog is re-derived (cheap dir scan) because build_system_prompt fuses
    // the parts; core + research segment is the unattributed remainder.
    {
        let (custom_chars, invoked_chars) = prompt_audit;
        let catalog_chars = crate::chat::prompts::available_skills_segment()
            .map(|s| s.len())
            .unwrap_or(0);
        let manifest_chars = manifest.map(|m| m.len()).unwrap_or(0);
        let total_chars = system.as_ref().map(|s| s.len()).unwrap_or(0);
        eprintln!(
            "[prompt-audit] system prompt: {total_chars} chars (tools_on={tools_on}, \
             research={research_mode}, skills_catalog={catalog_chars}, manifest={manifest_chars}, \
             custom={custom_chars}, invoked_skill_bodies={invoked_chars}, \
             attached_connectors={connector_ids:?}, attached_mcp={mcp_server_ids:?})"
        );
    }

    // 6. Build message history from DB.
    //
    // Only the *active* (non-superseded) rows feed the model — compaction
    // soft-deletes summarized turns via `superseded_by` for local models, and
    // the edit-to-fork flow (roadmap #9) retires a message's tail via the same
    // flag for every provider. Rows the user has forked away from are thus
    // never re-sent. We carry each row's DB id alongside so compaction can
    // mark the rows it folds into a summary.
    let mut messages: Vec<crate::chat::compaction::CompactionEntry> = {
        let conn = db.0.lock();
        let records = db::list_active_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?;
        records
            .into_iter()
            .map(|r| crate::chat::compaction::CompactionEntry {
                id: r.id,
                message: ChatMessage {
                    role: r.role,
                    // Thinking blocks are for display only — never re-sent.
                    content: strip_think_blocks(&r.content),
                    images: Vec::new(),
                },
            })
            .collect::<Vec<_>>()
    };
    // Attach this turn's images to the just-persisted user message so they are
    // sent as vision content. Images are not persisted, so they only apply to
    // the live turn (not to regenerated/older turns).
    if !images.is_empty() {
        if let Some(last) = messages.last_mut() {
            if last.message.role == "user" {
                last.message.images = images;
            }
        }
    }

    // 6b. Local-model context compaction. Before sending a turn to a
    // LocalGguf session with a running sidecar, check whether the assembled
    // history crosses the configured threshold of the model's context window.
    // If so, summarize the aged-out middle (pinning the most recent turns
    // verbatim), persist the summary as a `[compacted context]` system row,
    // soft-delete the folded turns, emit a low-weight `chat:status` marker so
    // the user understands why scrolling back shows condensed detail, and send
    // the compacted history instead. API providers are unaffected — the hook
    // is gated on `LocalGguf`, so it adds no overhead for non-local providers.
    let mut compacted_system_notice: Option<(String, String)> = None;
    let messages: Vec<ChatMessage> = if matches!(provider_id, ChatProviderId::LocalGguf) {
        if let Some(status) = app
            .try_state::<crate::chat::local_models::LocalModelState>()
            .and_then(|s| s.0.status())
        {
            let cfg = {
                let conn = db.0.lock();
                crate::chat::compaction::load_compaction_config(&conn)
            };

            // The send path adds the tool schema on top of system+history, so
            // reserve those tokens out of the compaction budget — otherwise the
            // window can "fit" by the count yet the real request 400s
            // (exceed_context_size_error). Connector tools are attached
            // per-turn inside the send task, so this estimate covers the
            // built-in set only; the slack is margin.
            let reserved_tokens: u32 = if tools_on {
                let json = builtin_tool_specs_json(&provider_id, &model, code_exec_enabled.unwrap_or(false));
                // Cached (B1): the schema JSON is constant until tool flags
                // change, so turns 2..N skip this /tokenize round-trip.
                let n = crate::chat::compaction::count_json_tokens_cached(
                    &chat_mgr.client,
                    &status.base_url,
                    &json,
                )
                .await
                .unwrap_or(0);
                eprintln!("[local-compaction] tool schema reserves {n} tokens");
                n
            } else {
                0
            };

            // Tell the user we're condensing earlier turns. The summarization
            // call against a small local model can take 5–30s and previously
            // looked identical to a frozen UI — a tiny spinner with this
            // message is enough to make the wait legible. We also capture the
            // pre-compaction token count here so the post-compaction notice
            // can show "Compacted 8.2k → 1.1k tokens" instead of a generic
            // "earlier context compacted".
            //
            // PERF (B1/B7): entry-based count (no ChatMessage/image clones),
            // and the successful count is handed to maybe_compact via
            // `pre_counted` so it isn't repeated there.
            let pre_count_result = crate::chat::compaction::count_entries_tokens(
                &chat_mgr.client,
                &status.base_url,
                &system,
                &messages,
            )
            .await;
            let pre_compact_tokens: u32 = pre_count_result.as_ref().copied().unwrap_or(0);
            let _ = app.emit(
                "chat:status",
                crate::types::ChatStatusPayload {
                    chat_session_id: chat_session_id.clone(),
                    reason: "context_compacting".to_string(),
                    message: "Compacting earlier context…".to_string(),
                },
            );

            // P4 summarizer override: `chat.local_gguf.compaction_summarizer =
            // "cloud"` routes the summary call through the first configured
            // cloud provider instead of the sidecar — summary quality no
            // longer scales with the weakest model on the path. Falls back
            // to the sidecar when nothing is configured.
            let route = {
                let wants_cloud = {
                    let conn = db.0.lock();
                    db::get_setting(&conn, "chat.local_gguf.compaction_summarizer")
                        .ok()
                        .flatten()
                        .map(|v| v.trim().eq_ignore_ascii_case("cloud"))
                        .unwrap_or(false)
                };
                if wants_cloud {
                    match {
                        let conn = db.0.lock();
                        resolve_cloud_summarizer(&conn)
                    } {
                        Some((provider_id, base, api_key, cloud_model)) => {
                            eprintln!(
                                "[local-compaction] summarizer override: cloud {} model={}",
                                provider_id.as_str(),
                                cloud_model
                            );
                            crate::chat::compaction::SummarizerRoute::Cloud {
                                provider_id,
                                base,
                                api_key,
                                model: cloud_model,
                            }
                        }
                        None => {
                            eprintln!(
                                "[local-compaction] summarizer override 'cloud' requested but no provider configured; using sidecar"
                            );
                            crate::chat::compaction::SummarizerRoute::Sidecar
                        }
                    }
                } else {
                    crate::chat::compaction::SummarizerRoute::Sidecar
                }
            };

            // P4 rebuild-from-raw: when the trigger has fired AND a prior
            // summary exists, re-feed its raw source rows (still in the DB)
            // into the compaction input so the new summary is re-derived from
            // the ORIGINAL turns instead of stacking summary-on-summary.
            // Injected ONLY into the compaction input — a passthrough turn
            // must never re-send superseded rows.
            let mut compact_entries = messages.clone();
            let mut injected_raw = false;
            if cfg.rebuild_from_raw
                && crate::chat::compaction::compaction_would_trigger(
                    status.n_ctx,
                    &cfg,
                    reserved_tokens,
                    pre_compact_tokens,
                )
            {
                let prior_id = messages
                    .iter()
                    .find(|e| crate::chat::compaction::is_compacted_summary(&e.message))
                    .map(|e| e.id)
                    .filter(|id| *id != 0);
                if let Some(pid) = prior_id {
                    let raw_rows = {
                        let conn = db.0.lock();
                        db::list_messages_superseded_by(&conn, pid).unwrap_or_default()
                    };
                    let mut raw_chars = 0usize;
                    let raw_entries: Vec<crate::chat::compaction::CompactionEntry> = raw_rows
                        .iter()
                        .map(|r| {
                            raw_chars += r.content.len();
                            crate::chat::compaction::CompactionEntry {
                                id: r.id,
                                message: ChatMessage {
                                    role: r.role.clone(),
                                    content: strip_think_blocks(&r.content),
                                    images: Vec::new(),
                                },
                            }
                        })
                        .collect();
                    if !raw_entries.is_empty() && raw_chars < 200_000 {
                        injected_raw = true;
                        eprintln!(
                            "[local-compaction] rebuild-from-raw: re-fed {} raw row(s) ({} chars)",
                            raw_entries.len(),
                            raw_chars
                        );
                        compact_entries.splice(0..0, raw_entries);
                    }
                }
            }

            let outcome = crate::chat::compaction::maybe_compact(
                &chat_mgr.client,
                &status.base_url,
                status.n_ctx,
                &model,
                &system,
                &compact_entries,
                &cfg,
                reserved_tokens,
                // Reuse the count above — identical assembly. When raw rows
                // were injected the assembly changed, so pass None and let
                // maybe_compact re-count.
                if injected_raw { None } else { pre_count_result.ok() },
                &route,
            )
            .await;
            match outcome {
                Ok(o) if o.did_compact => {
                    // Persist the summary as a real system row with the
                    // summarization call's token usage attributed to it (so
                    // the CostDashboard counts the compaction tokens), then
                    // soft-delete the folded turns + any prior summary.
                    let summary_content = format!(
                        "{}\n\n{}",
                        crate::chat::compaction::COMPACTED_PREFIX,
                        o.summary_text
                    );
                    let summary_id = {
                        let conn = db.0.lock();
                        let row = db::add_chat_message(
                            &conn,
                            &chat_session_id,
                            "system",
                            &summary_content,
                            Some(o.summary_input_tokens),
                            Some(o.summary_output_tokens),
                            None,
                            None, None, None, None, None, None,
                            // started_at, completed_at, llm, tool, ttft, tok_s
                            None, None, None, None, None, None,
                        )
                        .map_err(|e| e.to_string())?;
                        if !o.superseded_ids.is_empty() {
                            db::mark_superseded(&conn, &o.superseded_ids, row.id)
                                .map_err(|e| e.to_string())?;
                        }
                        row.id
                    };

                    // Count tokens against the REWRITTEN history so the
                    // "from→to" deltas in the user-facing message are real.
                    // If the post-count fails (sidecar hiccup), fall back to
                    // a coarse estimate from the pre-count minus the summary
                    // output tokens so the notice is never blank.
                    let post_compact_tokens: u32 =
                        crate::chat::compaction::count_tokens(
                            &chat_mgr.client,
                            &status.base_url,
                            &system,
                            &o.messages,
                        )
                        .await
                        .unwrap_or_else(|_| {
                            pre_compact_tokens.saturating_sub(
                                o.summary_input_tokens as u32,
                            )
                        });

                    eprintln!(
                        "[local-compaction] compacted {} exchange(s) into summary row {} ({}→{} tokens); {} messages now active",
                        o.compacted_exchange_count,
                        summary_id,
                        pre_compact_tokens,
                        post_compact_tokens,
                        o.messages.len()
                    );
                    let notice = format!(
                        "Compacted {} → {} tokens",
                        format_compact_token_count(pre_compact_tokens as i64),
                        format_compact_token_count(post_compact_tokens as i64),
                    );
                    compacted_system_notice =
                        Some(("context_compacted".to_string(), notice));
                    o.messages
                }
                // Below threshold, nothing aged out, or compaction failed and
                // fell back — maybe_compact already returned the original
                // history (as ChatMessages) in its passthrough outcome. We
                // also need to clear the "compacting…" spinner we emitted
                // above, since the no-op case never gets a follow-up
                // context_compacted event.
                Ok(_noop) => {
                    let _ = app.emit(
                        "chat:status",
                        crate::types::ChatStatusPayload {
                            chat_session_id: chat_session_id.clone(),
                            reason: "".to_string(),
                            message: String::new(),
                        },
                    );
                    _noop.messages
                }
                // Unreachable in practice (maybe_compact never returns Err),
                // but rebuild from the caller's messages if it ever does.
                Err(e) => {
                    eprintln!("[local-compaction] gave up, passing history through: {e}");
                    let _ = app.emit(
                        "chat:status",
                        crate::types::ChatStatusPayload {
                            chat_session_id: chat_session_id.clone(),
                            reason: "".to_string(),
                            message: String::new(),
                        },
                    );
                    messages.iter().map(|e| e.message.clone()).collect()
                }
            }
        } else {
            messages.iter().map(|e| e.message.clone()).collect()
        }
    } else {
        // 6c. Cloud pre-send compaction — the same pin+summarize engine the
        // local path uses, with two cloud substitutions: the trigger is an
        // ESTIMATED request size (cloud APIs have no /tokenize endpoint)
        // against the model-registry window, and the summarizer is the
        // session's OWN provider called non-streaming. Historically cloud
        // sessions shipped their full history every turn and an over-window
        // request died as a raw 400 with no recovery.
        let cfg = {
            let conn = db.0.lock();
            crate::chat::cloud_compact::load_cloud_compaction_config(&conn)
        };
        // Endpoint resolution mirrors the turn task's `tool_base`: a stored
        // base_url wins; native providers fall back to their default.
        // Compatible providers REQUIRE a stored base_url (no default exists)
        // — without one there is no endpoint to summarize against, so
        // compaction is skipped and the turn proceeds as before.
        let base = base_url
            .clone()
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| match provider_id {
                ChatProviderId::OpenRouter => OpenRouterProvider::DEFAULT_BASE.to_string(),
                ChatProviderId::Anthropic => AnthropicProvider::DEFAULT_BASE.to_string(),
                _ => OpenAIProvider::DEFAULT_BASE.to_string(),
            });
        let base_ready = !base_url.as_deref().unwrap_or("").trim().is_empty()
            || !matches!(
                provider_id,
                ChatProviderId::OpenAICompatible | ChatProviderId::AnthropicCompatible
            );
        let window = {
            let conn = db.0.lock();
            effective_session_window(&conn, &provider_str, &model)
        };
        let reserved_tokens: u32 = if tools_on {
            estimate_tokens(&builtin_tool_specs_json(
                &provider_id,
                &model,
                code_exec_enabled.unwrap_or(false),
            ))
        } else {
            0
        };
        let pre_tokens = crate::chat::cloud_compact::estimate_request_tokens(
            &system,
            &messages,
            reserved_tokens,
        )
        .saturating_add(crate::chat::compaction::RESPONSE_HEADROOM);
        let trigger = ((window as f64) * cfg.threshold) as u32;

        if cfg.enabled && base_ready && pre_tokens >= trigger {
            // Same spinner contract as the local path: the summarizer call
            // can take seconds and must not look like a frozen composer.
            let _ = app.emit(
                "chat:status",
                crate::types::ChatStatusPayload {
                    chat_session_id: chat_session_id.clone(),
                    reason: "context_compacting".to_string(),
                    message: "Compacting earlier context…".to_string(),
                },
            );
            // Rebuild-from-raw (same contract as the local path): when a
            // prior summary exists, re-feed its raw source rows into the
            // COMPACTION INPUT only — the passthrough arms below must never
            // re-send superseded rows.
            let mut compact_entries = messages.clone();
            if cfg.rebuild_from_raw {
                let prior_id = messages
                    .iter()
                    .find(|e| crate::chat::compaction::is_compacted_summary(&e.message))
                    .map(|e| e.id)
                    .filter(|id| *id != 0);
                if let Some(pid) = prior_id {
                    let raw_rows = {
                        let conn = db.0.lock();
                        db::list_messages_superseded_by(&conn, pid).unwrap_or_default()
                    };
                    let mut raw_chars = 0usize;
                    let raw_entries: Vec<crate::chat::compaction::CompactionEntry> = raw_rows
                        .iter()
                        .map(|r| {
                            raw_chars += r.content.len();
                            crate::chat::compaction::CompactionEntry {
                                id: r.id,
                                message: ChatMessage {
                                    role: r.role.clone(),
                                    content: strip_think_blocks(&r.content),
                                    images: Vec::new(),
                                },
                            }
                        })
                        .collect();
                    if !raw_entries.is_empty() && raw_chars < 200_000 {
                        eprintln!(
                            "[cloud-compaction] rebuild-from-raw: re-fed {} raw row(s) ({} chars)",
                            raw_entries.len(),
                            raw_chars
                        );
                        compact_entries.splice(0..0, raw_entries);
                    }
                }
            }
            let run = crate::chat::cloud_compact::run_cloud_compaction(
                &chat_mgr.client,
                provider_id,
                &base,
                &api_key,
                &model,
                &system,
                &compact_entries,
                cfg.pin_exchanges,
            )
            .await;
            match run {
                Ok(run) => {
                    let summary_id = {
                        let conn = db.0.lock();
                        crate::chat::cloud_compact::persist_summary_row(
                            &conn,
                            &chat_session_id,
                            &run,
                        )
                        .unwrap_or_else(|e| {
                            eprintln!("[cloud-compaction] persist failed: {e}");
                            0
                        })
                    };
                    eprintln!(
                        "[cloud-compaction] compacted {} exchange(s) into summary row {} (~{}→{} est. tokens)",
                        run.compacted_exchange_count,
                        summary_id,
                        run.pre_tokens,
                        run.post_tokens,
                    );
                    compacted_system_notice = Some((
                        "context_compacted".to_string(),
                        format!(
                            "Compacted {} → {} tokens (estimated)",
                            format_compact_token_count(run.pre_tokens as i64),
                            format_compact_token_count(run.post_tokens as i64),
                        ),
                    ));
                    run.messages
                }
                Err(e) => {
                    eprintln!(
                        "[cloud-compaction] failed ({e}); sending history unchanged"
                    );
                    let _ = app.emit(
                        "chat:status",
                        crate::types::ChatStatusPayload {
                            chat_session_id: chat_session_id.clone(),
                            reason: "".to_string(),
                            message: String::new(),
                        },
                    );
                    messages.into_iter().map(|e| e.message).collect()
                }
            }
        } else {
            messages.into_iter().map(|e| e.message).collect()
        }
    };

    // Emit the compaction marker (if any) before the stream starts so the
    // frontend shows it in the timeline. Reuses the existing chat:status
    // event + ChatStatusPayload the local-model-loading notice uses.
    if let Some((reason, message)) = compacted_system_notice {
        let _ = app.emit(
            "chat:status",
            crate::types::ChatStatusPayload {
                chat_session_id: chat_session_id.clone(),
                reason,
                message,
            },
        );
    }

    let shared_db = Arc::clone(&db.0);
    // Granted filesystem roots: every registered project path plus the
    // artifacts dir (Documents/Conduit). Mutating tool calls routed through
    // `dispatch::run_tool` are rejected by `permission::path_within_scope`
    // unless the path lies under one of these roots — so the agent can write
    // inside the user's projects and its own artifacts folder, while random
    // system paths stay hard-blocked regardless of the permission selector.
    let mut fs_roots: Vec<String> = {
        let conn = shared_db.lock();
        crate::db::list_projects(&conn)
            .map(|ps| ps.into_iter().map(|p| p.path).collect())
            .unwrap_or_default()
    };
    fs_roots.push(
        crate::chat::dispatch::artifacts_dir(&app)
            .to_string_lossy()
            .to_string(),
    );
    // Directories the user granted from an approval card ("always allow" on an
    // out-of-scope path — resolve_tool_action persists them). Without merging
    // these here, a remembered choice kept hitting the hard scope gate.
    {
        let granted: Vec<String> = {
            let conn = shared_db.lock();
            db::get_setting(&conn, "permissions.grantedRoots")
                .ok()
                .flatten()
                .and_then(|j| serde_json::from_str(&j).unwrap_or_default())
                .unwrap_or_default()
        };
        for root in granted {
            if !fs_roots.iter().any(|r| r.eq_ignore_ascii_case(&root)) {
                fs_roots.push(root);
            }
        }
    }
    // The chat's working folder — a custom folder from the composer picker,
    // or the selected project's path (the frontend sends both through this
    // param). Granted as an additional root for this turn (deduped against
    // the project roots) AND named in the system prompt: without that line
    // the model had no idea which directory the chat was scoped to and
    // answered that it wasn't working in any directory.
    if let Some(root) = extra_fs_root {
        let root = root.trim().to_string();
        if !root.is_empty() {
            if !fs_roots.iter().any(|r| r == &root) {
                fs_roots.push(root.clone());
            }
            let section = working_directory_section(&root);
            system = Some(system.unwrap_or_default() + &section);
            // Remember the root for the prompt warmup: the selected project /
            // custom folder live in frontend state the warmup can't see, and
            // a missing section here invalidates the entire cached prefix
            // (the section sits at the end of the system message, right
            // before the tools region).
            {
                let conn = db.0.lock();
                let _ = db::set_setting(&conn, "chat.local_gguf.last_working_dir", &root);
            }
        }
    }
    chat_state.0.send(
        chat_session_id,
        provider_id,
        model,
        api_key,
        base_url,
        effort,
        tools_on,
        code_exec_enabled.unwrap_or(false),
        sandbox,
        approval,
        fs_roots,
        connector_ids,
        mcp_server_ids,
        system,
        messages,
        shared_db,
        app,
        research_mode,
        thinking,
    );

    Ok(())
}

/// Which connectors and MCP-gallery servers are AVAILABLE but NOT yet
/// attached to the session — i.e. attachable on demand. "Available" =
/// a credential row exists (OAuth connectors) or the endpoint is public
/// (`is_public()`, e.g. Kiwi — never has a row); for gallery servers,
/// `enabled` in their def. Shared by the send path, the context meter, the
/// context breakdown, and the prompt warmup so all four agree on what the
/// model can attach.
pub(crate) fn attach_availability(
    app: &tauri::AppHandle,
    attached_connectors: &[String],
    attached_mcp: &[String],
) -> (
    Vec<crate::chat::prompts::ManifestEntry>,
    Vec<crate::chat::prompts::ManifestEntry>,
) {
    let credentialed: Vec<String> = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        db::list_connector_credential_rows(&conn)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.connector_id)
            .collect()
    };
    let connectors = crate::connectors::CONNECTORS
        .iter()
        .filter(|c| c.is_public() || credentialed.iter().any(|id| id == c.id))
        .filter(|c| !attached_connectors.iter().any(|id| id == c.id))
        .map(|c| crate::chat::prompts::ManifestEntry {
            id: c.id.to_string(),
            name: c.display_name.to_string(),
            description: c.description.to_string(),
        })
        .collect();
    let mcp = crate::mcp_gallery::load_defs(app)
        .into_iter()
        .filter(|d| d.enabled && !attached_mcp.iter().any(|id| *id == d.id))
        .map(|d| crate::chat::prompts::ManifestEntry {
            id: d.id,
            name: d.name,
            description: d.description,
        })
        .collect();
    (connectors, mcp)
}

/// The `## Working directory` system-prompt section the send path appends
/// when the chat has a working folder. Shared with the prompt warmup so the
/// cached prefix matches the real request byte-for-byte — the section sits at
/// the END of the system message, right before the tools region in the
/// rendered prompt, and a single divergent char there would invalidate the
/// whole cached prefix.
pub(crate) fn working_directory_section(root: &str) -> String {
    format!(
        "\n\n## Working directory\nThis chat's working directory is `{root}`. \
         Treat it as the current working directory: resolve RELATIVE paths against \
         it, and default `list_directory`/`search_files`/`search_content` calls to \
         it when the user hasn't said where. This is NOT a restriction: you may \
         `list_directory`, `read_file`, `search_files`, and `search_content` ANY \
         directory on the machine — pass an absolute path (e.g. \
         `search_content(path: \"C:/Users/me/Documents\", query: ...)`) whenever \
         the user asks about files outside the working directory. Only WRITES \
         (`write_file`/`edit_file`/`delete_file`/`move_file`/`copy_file`) are \
         limited to granted roots."
    )
}

/// Prompt-cache warmup for a freshly started local sidecar.
///
/// The first real message on a cold model pays three one-time costs: CUDA
/// kernel init on the first forward pass, chat-template compilation, and —
/// the big one — prompt-evaluating the multi-thousand-token system prompt
/// plus tool-schema JSON. llama.cpp caches the rendered prompt prefix across
/// requests, so one tiny completion built from the SAME parts the send path
/// assembles absorbs all of that. Best-effort: failures are logged and never
/// surfaced (the send works identically without the warmup). Capped at 90s —
/// a slow machine falls back to paying part of the cost on the first message
/// rather than hanging the load forever.
///
/// PREFIX FIDELITY IS THE WHOLE GAME: llama.cpp reuses the cached KV only up
/// to the first divergent byte, and the tools region renders AFTER the system
/// message — one different tool spec invalidates essentially the entire
/// prefill. The warmup therefore must mirror the real send's capability flags
/// exactly. It once hardcoded `web_search: false` while the send path (since
/// native web search landed for local models) always shipped the spec — every
/// warmup logged "ok" and saved nothing, and the first message still paid the
/// full ~1min prompt eval. Every flag below now comes from the same source
/// the send path uses:
/// - `web_search` — `provider_capabilities` (true for local models),
/// - `local_docs` — embedding sidecar up AND a searchable corpus indexed,
/// - `sandbox` — the chat session's persisted `sandbox_policy`,
/// - `code_exec` / `tools_on` — the composer toggles, passed by the frontend,
/// - attached connectors — the session's `chat_session_connectors` rows.
///
/// Two callers:
/// - `warmup_local_prompt` (frontend, right after `start_local_model`) — the
///   loading spinner covers it, so "loaded" means the first message answers
///   immediately.
/// - The send path's sidecar respawn fires it via [`spawn_prompt_warmup`] —
///   a turn is already in flight there, so it can't block; it primes turn 2.
pub(crate) async fn run_prompt_warmup(
    app: &tauri::AppHandle,
    base_url: &str,
    model_id: &str,
    working_dir: Option<&str>,
    chat_session_id: Option<&str>,
    tools_on: bool,
    code_exec: bool,
) {
    let started = std::time::Instant::now();
    // Mirror the send path's assembly: the session's persisted sandbox policy
    // and attached connectors (fresh sessions have none), db-stored approval
    // rules, and the user's custom prompt.
    let (custom, fs_rules, sandbox, attached_c) = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt").ok().flatten();
        let fs_rules: Vec<crate::chat::permission::ApprovalRule> = db::get_setting(
            &conn,
            "permissions.rules",
        )
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).unwrap_or_default())
        .unwrap_or_default();
        let (sandbox, attached_c) = chat_session_id
            .and_then(|sid| {
                db::get_chat_session(&conn, sid)
                    .ok()
                    .flatten()
                    .map(|cs| cs.sandbox_policy)
                    .map(|policy| {
                        (
                            crate::chat::permission::SandboxPolicy::from_db(&policy),
                            db::list_chat_session_connectors(&conn, sid)
                                .unwrap_or_default()
                                .into_iter()
                                .filter(|r| !r.starts_with("mcp:"))
                                .collect::<Vec<String>>(),
                        )
                    })
            })
            .unwrap_or((
                crate::chat::permission::SandboxPolicy::WorkspaceWrite,
                Vec::new(),
            ));
        (custom, fs_rules, sandbox, attached_c)
    };
    let (avail_c, avail_m) = attach_availability(app, &attached_c, &[]);
    let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
    let mut system = crate::chat::build_system_prompt(
        ChatProviderId::LocalGguf,
        model_id,
        custom.as_deref(),
        &[],
        tools_on,
        false,
        false,
        manifest.as_deref(),
    )
    .unwrap_or_default();
    // Replicate the send path's `## Working directory` tail — the section
    // sits at the end of the system message, right before the tools region,
    // and a single divergent char there invalidates the whole cached prefix
    // (this mismatch is why the first warmup attempt saved nothing: 7,139
    // warmup chars vs 7,819 real). The caller supplies the working dir its
    // next send would resolve to; None matches a send without one.
    if let Some(root) = working_dir
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
    {
        eprintln!("[prompt-warmup] matching working directory: {root:?}");
        system.push_str(&working_directory_section(&root));
    } else {
        eprintln!("[prompt-warmup] no working directory — warmup covers the core+skills+manifest prefix only");
    }
    // Capability flags mirror chat/mod.rs send() exactly (see doc above).
    let pcaps = crate::chat::prompts::provider_capabilities(
        ChatProviderId::LocalGguf,
        model_id,
    );
    let local_docs = {
        let sidecar_up = app
            .try_state::<local_models::LocalModelState>()
            .is_some_and(|s| s.0.embedding_status().is_some());
        sidecar_up && {
            let db_state = app.state::<crate::DbState>();
            let conn = db_state.0.lock();
            db::any_searchable_corpus(&conn)
        }
    };
    let caps = crate::chat::tools::ToolCaps {
        code_exec,
        fs_roots: Vec::new(),
        web_search: pcaps.native_web_search,
        requires_local_sandbox: pcaps.requires_local_sandbox,
        // A fresh session's first send has no LIVE connector sessions yet
        // (AttachedConnector needs a connected McpSession — not fabricatable
        // here). `attached_c` still matters: it's excluded from the
        // attachable manifest above, matching the send's manifest.
        attached_connectors: std::sync::Arc::new(Vec::new()),
        local_docs,
        mcp_tools: std::sync::Arc::new(Vec::new()),
        fs_rules,
        attachable_connectors: std::sync::Arc::new(
            avail_c.into_iter().map(|e| (e.id, e.name)).collect(),
        ),
        attachable_mcp: std::sync::Arc::new(
            avail_m.into_iter().map(|e| (e.id, e.name)).collect(),
        ),
        local_model: true,
    };
    let mut body = serde_json::json!({
        "model": model_id,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": "Warmup — reply with: ok" },
        ],
        "max_tokens": 1,
        "stream": false,
    });
    if tools_on {
        // Mirror the send's request shape: no `tools` key at all when the
        // composer toggle is off (an empty array renders differently).
        let specs = crate::chat::tools::openai_tool_specs(
            &caps,
            sandbox,
        );
        body["tools"] = serde_json::to_value(specs).unwrap_or_default();
    }
    // B-10: these are one-shot JSON calls — a total timeout is safe here and
    // bounds a wedged endpoint instead of hanging the async command forever.
    // (Builder failure falls back to the plain client — this fn returns ().)
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{base_url}/v1/chat/completions");
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        client.post(&url).json(&body).send(),
    )
    .await;
    match res {
        Ok(Ok(resp)) if resp.status().is_success() => {
            eprintln!(
                "[prompt-warmup] ok in {}ms — first user message skips CUDA init + \
                 prompt eval of system+tools",
                started.elapsed().as_millis()
            );
        }
        Ok(Ok(resp)) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            eprintln!(
                "[prompt-warmup] HTTP {status}: {}",
                crate::util::truncate_chars(&body, 300)
            );
        }
        Ok(Err(e)) => eprintln!("[prompt-warmup] request failed: {e}"),
        Err(_) => eprintln!("[prompt-warmup] timed out after 90s — continuing anyway"),
    }
}

/// Fire-and-forget variant for paths that can't block (the send path's
/// sidecar respawn — a turn is already streaming, so the warmup primes the
/// NEXT turn instead). Uses the working dir persisted by the last send and
/// the session's persisted policies so the primed prefix matches turn 2.
pub(crate) fn spawn_prompt_warmup(
    app: tauri::AppHandle,
    base_url: String,
    model_id: String,
    chat_session_id: String,
    tools_on: bool,
    code_exec: bool,
) {
    tokio::spawn(async move {
        let root = {
            let db_state = app.state::<crate::DbState>();
            let conn = db_state.0.lock();
            db::get_setting(&conn, "chat.local_gguf.last_working_dir")
                .ok()
                .flatten()
                .filter(|r| !r.trim().is_empty())
        };
        run_prompt_warmup(
            &app,
            &base_url,
            &model_id,
            root.as_deref(),
            Some(&chat_session_id),
            tools_on,
            code_exec,
        )
        .await;
    });
}

/// Warm the local model's prompt cache with the EXACT system+tools prefix
/// the next send from this chat will render. Called by the frontend right
/// after `start_local_model` resolves, with the same working-dir + composer
/// toggles `sendMessage` uses (working dir and toggles are frontend state —
/// selected project / custom folder / worktree, tools + code-exec switches —
/// so the backend can't guess them at load time). The session id resolves the
/// persisted sandbox policy + attached connectors. The frontend keeps its
/// loading spinner up until this resolves, so "loaded" means the first
/// message answers immediately. Capped at 90s; best-effort (errors are
/// logged, never surfaced).
#[tauri::command]
pub async fn warmup_local_prompt(
    working_dir: Option<String>,
    chat_session_id: Option<String>,
    tools_enabled: Option<bool>,
    code_exec_enabled: Option<bool>,
    local: State<'_, local_models::LocalModelState>,
    app: tauri::AppHandle,
) -> CmdResult<()> {
    let Some(status) = local.0.status() else {
        return Err("No local model is running.".to_string());
    };
    run_prompt_warmup(
        &app,
        &status.base_url,
        &status.model_id,
        working_dir.as_deref(),
        chat_session_id.as_deref(),
        tools_enabled.unwrap_or(true),
        code_exec_enabled.unwrap_or(false),
    )
    .await;
    Ok(())
}

/// Resolve which skills the user INVOKED in this message — `(name, body)`
/// pairs for every on-disk or built-in skill whose slash token (`/<slug>`)
/// appears as a standalone token in the message. The skill catalog lives on
/// disk (`~/.claude/skills/`, `~/.agents/skills/`) plus the built-in
/// doc/pptx/pdf/diagram skills; `installed_skills::cached_skills()` reads it
/// through a short-TTL cache invalidated on Skills Library edits. Invoked-only
/// injection keeps every other turn's system prompt lean.
fn parse_invoked_skills(message: &str) -> Vec<(String, String)> {
    crate::installed_skills::cached_skills()
        .into_iter()
        .filter(|s| message_has_slash_token(message, &s.slug))
        .map(|s| (s.name, s.body))
        .collect()
}

/// True when `/token` appears in the message as a standalone token: preceded
/// by start-of-string or whitespace, followed by whitespace or end.
/// Case-insensitive, so `/docx` never matches `/docx2` or `a/docx`.
fn message_has_slash_token(message: &str, token: &str) -> bool {
    let lower = message.to_lowercase();
    let needle = format!("/{token}");
    let mut start = 0;
    while let Some(idx) = lower[start..].find(&needle) {
        let abs = start + idx;
        let before_ok = abs == 0
            || lower[..abs]
                .chars()
                .last()
                .map(|c| c.is_whitespace())
                .unwrap_or(true);
        let after = &lower[abs + needle.len()..];
        let after_ok = after.is_empty()
            || after
                .chars()
                .next()
                .map(|c| c.is_whitespace())
                .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

#[tauri::command]
pub fn cancel_chat_message(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<()> {
    chat_state.0.cancel(&chat_session_id);
    Ok(())
}

/// Persist the PARTIAL assistant reply a cancelled stream had produced, so a
/// cancelled turn keeps the text the user already saw instead of vanishing.
/// The abort path discards the backend's accumulated buffer, so the frontend
/// ships the streamed text it already rendered here. Best-effort: a cancelled
/// turn with zero streamed tokens writes nothing meaningful, and failures are
/// swallowed (the cancel itself already happened).
#[tauri::command]
pub fn persist_partial_chat_message(
    chat_session_id: String,
    content: String,
    db: State<'_, crate::DbState>,
) -> CmdResult<()> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let conn = db.0.lock();
    // Mirror the assistant-insert metadata (provider/model_key) so the partial
    // row prices and groups like a completed turn would.
    let (provider, model, agent): (Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT provider, model, agent FROM chat_sessions WHERE id = ?1",
            rusqlite::params![chat_session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or((None, None, None));
    let provider_val = agent
        .as_deref()
        .filter(|a| a.starts_with("harness:"))
        .or(provider.as_deref());
    let model_key = model
        .as_deref()
        .and_then(crate::harness_adapters::canonical_model_key);
    let _ = db::add_chat_message(
        &conn,
        &chat_session_id,
        "assistant",
        trimmed,
        None,
        None,
        None,
        None,
        None,
        None,
        provider_val,
        model_key,
        None,
        // The abort command doesn't know the turn's start instant, so leave
        // started_at null (UI falls back to a generic label) but stamp
        // completed_at so the row still reads as finished.
        None,
        Some(db::now_ts()),
        None, // llm_time_ms
        None, // tool_time_ms
        None, // ttft_ms
        None, // tokens_per_second
    );
    let _ = db::touch_chat_session(&conn, &chat_session_id);
    Ok(())
}

// ---- Per-action tool approval ----

/// Resolve a pending filesystem-tool approval card. `approved = true` lets the
/// paused tool loop execute the action and feed its result back to the model;
/// `false` injects a "user denied" tool result instead. The tool loop itself
/// does the execution (it paused on the matching oneshot), so this command only
/// delivers the decision. Unknown / already-resolved `pending_id` is a no-op
/// (the card may have been auto-dismissed when the stream was cancelled).
/// Persist the target's parent directory as a user-granted root when an
/// approval is remembered ("always allow"). Without this, a remembered rule
/// auto-ran the NEXT call past the card — straight into the hard scope gate,
/// which refuses out-of-root writes: the remembered choice turned the write
/// into an error. Granting the directory makes the choice actually stick
/// (and gives Full Auto sessions a real root for out-of-project work).
fn grant_directory_for_approved_tool(
    conn: &rusqlite::Connection,
    tool: &str,
    args: &serde_json::Value,
) {
    use crate::chat::tools;
    let mutating = matches!(
        tool,
        tools::WRITE_FILE | tools::EDIT_FILE | tools::DELETE_FILE
            | tools::MOVE_FILE | tools::COPY_FILE | tools::DOWNLOAD_FILE
    );
    if !mutating {
        return;
    }
    let target = crate::chat::dispatch::fs_target_path(tool, args);
    if target.is_empty() {
        return;
    }
    let path = std::path::Path::new(&target);
    let Some(dir) = path.parent() else { return };
    let dir = dir.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
    // Only absolute paths have a stable root to grant.
    if dir.is_empty() || !path.is_absolute() {
        return;
    }
    let mut roots: Vec<String> = db::get_setting(conn, "permissions.grantedRoots")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).unwrap_or_default())
        .unwrap_or_default();
    if roots.iter().any(|r| r.eq_ignore_ascii_case(&dir)) {
        return;
    }
    roots.push(dir);
    let _ = db::set_setting(
        conn,
        "permissions.grantedRoots",
        &serde_json::to_string(&roots).unwrap_or_default(),
    );
}

#[tauri::command]
pub fn resolve_tool_action(
    pending_id: String,
    approved: bool,
    chat_state: State<'_, crate::ChatState>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    if let Some(pending) = chat_state.0.take_pending_approval(&pending_id) {
        if approved {
            // "Always allow" on an out-of-scope path can only ever work if the
            // directory itself becomes granted — persist it now.
            grant_directory_for_approved_tool(&db.0.lock(), &pending.tool, &pending.args);
        }
        // The receiver end lives in the paused tool loop. A send error means
        // the loop already ended (stream cancelled) — ignore it.
        let _ = pending.response_tx.send(approved);
    }
    Ok(())
}

/// Resolve a `present_plan` proposal card. Same pause/resume contract as
/// `resolve_tool_action`, plus the rejection feedback: the text is stored in
/// PlanState BEFORE the oneshot is released (store-then-send ordering), so
/// the paused `present_plan` handler reads it right after waking. Unknown /
/// already-resolved `pending_id` is a no-op (card auto-dismissed on cancel).
#[tauri::command]
pub fn resolve_plan_proposal(
    pending_id: String,
    approved: bool,
    feedback: Option<String>,
    chat_state: State<'_, crate::ChatState>,
    plan_state: State<'_, crate::chat::plan::PlanState>,
) -> CmdResult<()> {
    if let Some(pending) = chat_state.0.take_pending_approval(&pending_id) {
        if let Some(f) = feedback.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            plan_state.store_feedback(&pending_id, f);
        }
        let _ = pending.response_tx.send(approved);
    }
    Ok(())
}

/// Enter or exit plan mode for a chat session from the composer's mode menu.
/// Writes the persisted label ("plan" on permission_mode; the posture label
/// derived from the untouched dual policies on exit), syncs the in-memory
/// gate flag, and emits `chat:plan-mode` so every window's mode selector
/// agrees. Exiting restores the policies the session already had — plan mode
/// never modified them.
#[tauri::command]
pub fn set_chat_session_plan_mode(
    chat_session_id: String,
    active: bool,
    db: State<'_, DbState>,
    plan_state: State<'_, crate::chat::plan::PlanState>,
    app: AppHandle,
) -> CmdResult<()> {
    // Persist first so the emitted event's label matches the stored row.
    let label = {
        let conn = db.0.lock();
        crate::db::set_chat_session_plan(&conn, &chat_session_id, active).map_err(|e| e.to_string())?
    };
    plan_state.set_plan_mode(Some(&app), &chat_session_id, active, if active { "user enabled plan mode" } else { "user disabled plan mode" }, &label);
    Ok(())
}

/// Set a HARNESS session's native permission mode (the mode menu shows the
/// harness's own postures — e.g. OpenCode build/plan, Claude Code
/// default/acceptEdits/plan/bypassPermissions — instead of our built-in
/// ones). Persists the label on permission_mode; the harness spawn reads it
/// per turn and maps it to the CLI's own flags. Built-in sessions go through
/// `update_chat_session_policies` / `set_chat_session_plan_mode` instead.
///
/// claude_code is special: its CLI process is LONG-LIVED, so the label alone
/// would only apply on the next respawn. We also best-effort live-apply the
/// change through the control protocol (`set_permission_mode`) — mid-turn
/// switches then take effect immediately; the label-mismatch respawn on the
/// next send remains the deterministic backstop.
#[tauri::command]
pub fn set_chat_session_permission_mode(
    chat_session_id: String,
    mode: String,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<()> {
    db::update_chat_session_permission_mode(&db.0.lock(), &chat_session_id, &mode)
        .map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<crate::agent_sessions::AgentSessionState>() {
        let _ = state.0.apply_claude_permission_mode(&chat_session_id, &mode);
    }
    Ok(())
}

/// Answer a pending harness question (a Claude Code `AskUserQuestion` that
/// arrived over the can_use_tool control protocol). `answers` maps question
/// text → chosen option label (string, or an array for multiSelect);
/// `response` is an optional free-text reply that replaces the structured
/// answers. Same pause/resume contract as `resolve_tool_action` — unknown /
/// already-resolved ids are a no-op.
#[tauri::command]
pub fn resolve_agent_question(
    chat_session_id: String,
    pending_id: String,
    answers: serde_json::Value,
    response: Option<String>,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<()> {
    let _ = &chat_session_id; // registry is keyed by pending id; kept for UI symmetry
    if let Some(pending) = chat_state.0.take_pending_question(&pending_id) {
        let answers = if answers.is_object() { answers } else { serde_json::json!({}) };
        let _ = pending.response_tx.send(crate::chat::QuestionReply {
            answers,
            response: response.filter(|s| !s.trim().is_empty()),
        });
    }
    Ok(())
}

/// The model id the session's harness LAST actually ran, straight from the
/// harness's own stream (claude `message.model`, opencode `info.modelID`).
/// Custom/remapped harness setups make the session's stored catalog id
/// (`claude-opus-4-8`, …) a lie — the composer's context meter and window
/// math should reflect the real model. `None` for built-in/local sessions or
/// before the first harness turn completes.
#[tauri::command]
pub fn get_agent_actual_model(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    let agent = {
        let conn = db.0.lock();
        db::get_chat_session(&conn, &chat_session_id)
            .ok()
            .flatten()
            .and_then(|cs| cs.agent)
    };
    let Some(agent) = agent else { return Ok(None) };
    let Some(harness) = agent.strip_prefix("harness:") else {
        return Ok(None);
    };
    let conn = db.0.lock();
    Ok(db::get_setting(
        &conn,
        &crate::agent_sessions::actual_model_key(harness, &chat_session_id),
    )
    .ok()
    .flatten()
    .filter(|m| !m.trim().is_empty()))
}

// ---- Artifact preview ----

/// Standard base64 encode (no external crate). `pub` so
/// `browser_mcp.rs:391` can call it for the screenshot-encoding path —
/// kept module-private in the past, but `browser_mcp` is the legitimate
/// external consumer (it builds the data URI for the
/// `browser_screenshot` tool's return payload).
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}


/// Read a generated artifact for in-app preview. Text-like files return their
/// decoded (and length-capped) text; images and PDFs return a `data:` URI;
/// Office documents are rendered as: docx → raw bytes for client-side
/// docx-preview rendering (kind = `office`, original_bytes = true); pptx →
/// converted to PDF via headless LibreOffice when available (kind = `pdf`),
/// else the hand-rolled HTML converter (kind = `office`); xlsx → HTML
/// (kind = `office`). Anything else returns metadata only (rendered as a
/// file card).
///
/// `async` because pptx→pdf shells out to LibreOffice for several seconds —
/// that work runs on `spawn_blocking` so the IPC handler isn't stalled.
#[tauri::command]
pub async fn read_artifact_preview(path: String) -> CmdResult<ArtifactPreview> {
    use std::path::Path;

    let p = Path::new(&path);
    let filename = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let meta = std::fs::metadata(p).map_err(|e| format!("cannot stat file: {e}"))?;
    let size = meta.len();

    // Classify by extension.
    let text_kind = classify_text_ext(&ext);
    let is_image = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
    );
    let is_pdf = ext == "pdf";

    const MAX_TEXT: usize = 400_000; // ~400 KB of text
    const MAX_MEDIA: u64 = 25 * 1024 * 1024; // 25 MB

    if let Some(kind) = text_kind {
        // spawn_blocking (B2): a 400 KB read on the async IPC context stalls
        // every other in-flight command on this runtime thread.
        let path_for_read = path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(Path::new(&path_for_read)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("cannot read file: {e}"))?;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        let truncated = text.len() > MAX_TEXT;
        if truncated {
            let mut cut = MAX_TEXT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        // A .html file produced by the `generate_diagram` tool carries the
        // diagram sentinel marker at the top. Route it as `kind: "diagram"`
        // (same srcDoc-iframe rendering as html, but diagram-specific export
        // chrome — PNG export enabled, SVG greyed out).
        let final_kind = if kind == "html" && text.starts_with(crate::chat::tools::DIAGRAM_MARKER) {
            "diagram"
        } else {
            kind
        };
        return Ok(ArtifactPreview {
            path,
            filename,
            ext,
            kind: final_kind.to_string(),
            text: Some(text),
            data_uri: None,
            original_bytes: None,
            size,
            truncated,
        });
    }

    if (is_image || is_pdf) && size <= MAX_MEDIA {
        // spawn_blocking (B2): up to 25 MB read + base64 on the hot path.
        let path_for_read = path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(Path::new(&path_for_read)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("cannot read file: {e}"))?;
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        };
        let data_uri = format!("data:{mime};base64,{}", base64_encode(&bytes));
        return Ok(ArtifactPreview {
            path,
            filename,
            ext,
            kind: if is_pdf { "pdf" } else { "image" }.to_string(),
            text: None,
            data_uri: Some(data_uri),
            original_bytes: None,
            size,
            truncated: false,
        });
    }

    // PPTX: convert the original deck to PDF with headless LibreOffice so the
    // preview is the *original* file (fonts/images/layout intact), rendered by
    // the native PDF viewer. On any conversion failure (LibreOffice missing,
    // timeout, corrupt file) fall through to the office→HTML preview below.
    if ext == "pptx" && size <= MAX_MEDIA {
        let path_for_convert = path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
            crate::chat::office::office_to_pdf(Path::new(&path_for_convert))
        })
        .await
        .ok()
        .flatten();
        if let Some(pdf_bytes) = pdf_bytes {
            let data_uri = format!("data:application/pdf;base64,{}", base64_encode(&pdf_bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "pdf".to_string(),
                text: None,
                data_uri: Some(data_uri),
                original_bytes: Some(true),
                size,
                truncated: false,
            });
        }
    }

    // Office documents: render to faithful, self-contained HTML (colours,
    // fonts, tables, slide layouts) shown in a sandboxed iframe (kind = office).
    // For docx/pptx, also return the raw bytes as data_uri for client-side
    // rendering (docx-preview for docx; pptx raw bytes back the fallback when
    // LibreOffice conversion failed).
    if matches!(ext.as_str(), "docx" | "pptx" | "xlsx") && size <= MAX_MEDIA {
        // spawn_blocking (B2 + B13): the read AND the Office→HTML renderers
        // (multi-pass string scans, worst-case quadratic on pathological
        // documents) both run off the async IPC context now.
        let path_for_read = path.clone();
        let ext_for_render = ext.clone();
        let rendered = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(Path::new(&path_for_read)).ok()?;
            let html = match ext_for_render.as_str() {
                "docx" => crate::chat::office::docx_to_html(&bytes),
                "pptx" => crate::chat::office::pptx_to_html(&bytes),
                "xlsx" => crate::chat::office::xlsx_to_html(&bytes),
                _ => None,
            };
            html.map(|h| (bytes, h))
        })
        .await
        .ok()
        .flatten();
        if let Some((bytes, html)) = rendered {
            // Encode raw file bytes for client-side rendering.
            let mime = match ext.as_str() {
                "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                _ => "application/octet-stream",
            };
            let data_uri = format!("data:{mime};base64,{}", base64_encode(&bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "office".to_string(),
                text: Some(html),
                data_uri: Some(data_uri),
                original_bytes: Some(true),
                size,
                truncated: false,
            });
        }
    }

    // Anything else (unsupported/oversized/unparseable): metadata only.
    Ok(ArtifactPreview {
        path,
        filename,
        ext,
        kind: "binary".to_string(),
        text: None,
        data_uri: None,
        original_bytes: None,
        size,
        truncated: false,
    })
}

/// Extension → preview `kind` for text-like artifacts. Extracted from
/// `read_artifact_preview` so the routing table is unit-testable.
pub(crate) fn classify_text_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "md" | "markdown" => Some("markdown"),
        "csv" => Some("csv"),
        "json" => Some("json"),
        "html" | "htm" => Some("html"),
        // Mermaid sources render as diagrams (MermaidDiagram), not code text.
        "mmd" | "mermaid" => Some("mermaid"),
        "txt" | "log" | "text" => Some("text"),
        "tsx" | "jsx" => Some("jsx"),
        "js" | "ts" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h" | "hpp"
        | "sh" | "bash" | "yaml" | "yml" | "toml" | "xml" | "sql" | "rb" | "php" | "css" => {
            Some("code")
        }
        _ => None,
    }
}

#[cfg(test)]
mod preview_tests {
    use super::{classify_text_ext, find_by_basename_walk, get_file_mtime};

    #[test]
    fn mermaid_sources_classify_as_mermaid_kind() {
        assert_eq!(classify_text_ext("mmd"), Some("mermaid"));
        assert_eq!(classify_text_ext("mermaid"), Some("mermaid"));
        // Case-insensitivity is handled upstream (ext is lowercased), but the
        // table itself must only hold lowercase entries.
        assert_eq!(classify_text_ext("MMD"), None, "caller lowercases the ext");
    }

    #[test]
    fn existing_kinds_unchanged() {
        assert_eq!(classify_text_ext("md"), Some("markdown"));
        assert_eq!(classify_text_ext("html"), Some("html"));
        assert_eq!(classify_text_ext("tsx"), Some("jsx"));
        assert_eq!(classify_text_ext("py"), Some("code"));
        assert_eq!(classify_text_ext("exe"), None);
    }

    #[test]
    fn get_file_mtime_reports_secs_and_missing_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("artifact.html");
        std::fs::write(&file, "<html></html>").expect("write");

        let mtime = get_file_mtime(file.to_string_lossy().into_owned())
            .expect("ipc ok")
            .expect("existing file has an mtime");
        assert!(mtime > 0, "mtime is secs-since-epoch, got {mtime}");

        // A file written later has a >= mtime (same-second writes allowed).
        std::fs::write(&file, "<html>v2</html>").expect("rewrite");
        let mtime2 = get_file_mtime(file.to_string_lossy().into_owned())
            .expect("ipc ok")
            .expect("still exists");
        assert!(mtime2 >= mtime);

        assert_eq!(
            get_file_mtime(dir.path().join("gone.html").to_string_lossy().into_owned())
                .expect("ipc ok"),
            None,
            "missing file → None, not an error (preview keeps last render)"
        );
    }

    #[test]
    fn basename_walk_prefers_newest_match_and_skips_vendor_dirs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).expect("dirs");
        // Two copies: the deeper one is written LAST (newer mtime) — it must
        // win over the shallower older copy. The sleep keeps the two mtimes
        // out of the same filesystem timestamp bucket (NTFS granularity made
        // a plain back-to-back write pair flaky).
        std::fs::write(root.join("traffic.mmd"), "older-shallow").expect("write shallow");
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(root.join("a/b/traffic.mmd"), "newer-deep").expect("write deep");
        let hit = find_by_basename_walk(root, "traffic.mmd").expect("found");
        assert_eq!(std::fs::read_to_string(&hit).unwrap(), "newer-deep");

        // Case-insensitive.
        assert!(find_by_basename_walk(root, "TRAFFIC.MMD").is_some());

        // Missing basename → None.
        assert_eq!(find_by_basename_walk(root, "absent.txt"), None);

        // Vendor dirs are skipped — the only copy lives under node_modules.
        let dir2 = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir2.path().join("node_modules/pkg")).expect("dirs");
        std::fs::write(dir2.path().join("node_modules/pkg/only.txt"), "x").expect("write");
        assert_eq!(find_by_basename_walk(dir2.path(), "only.txt"), None);
    }
}

/// True when a LibreOffice `soffice` binary is reachable, which is what the
/// pptx→pdf preview path needs. The frontend uses this to show a one-line
/// install hint above pptx previews that fell back to the HTML converter.
#[tauri::command]
pub fn is_libreoffice_available() -> bool {
    crate::chat::office::libreoffice_available()
}

/// "Accurate view" for Office artifact previews: convert the original
/// docx/pptx/xlsx (and legacy .doc/.ppt) to PDF with headless LibreOffice and
/// return a `data:application/pdf;base64,…` URI for the in-app PDF viewer.
/// Results come from the same (path,len,mtime)-keyed cache as the pptx
/// preview path, so toggling is cheap after the first conversion. `None`
/// means LibreOffice isn't available or the conversion failed — the caller
/// keeps showing the fast preview.
#[tauri::command]
pub async fn office_accurate_pdf(path: String) -> CmdResult<Option<String>> {
    const MAX_MEDIA: u64 = 25 * 1024 * 1024;
    let p = Path::new(&path);
    let ext_ok = p
        .extension()
        .map(|e| {
            matches!(
                e.to_string_lossy().to_ascii_lowercase().as_str(),
                "docx" | "pptx" | "xlsx" | "doc" | "ppt"
            )
        })
        .unwrap_or(false);
    let size_ok = std::fs::metadata(p).map(|m| m.len() <= MAX_MEDIA).unwrap_or(false);
    if !ext_ok || !size_ok {
        return Ok(None);
    }
    let path_for_convert = path.clone();
    let pdf_bytes = tokio::task::spawn_blocking(move || {
        crate::chat::office::office_to_pdf(Path::new(&path_for_convert))
    })
    .await
    .ok()
    .flatten();
    Ok(pdf_bytes.map(|b| format!("data:application/pdf;base64,{}", base64_encode(&b))))
}

/// Completion callback for the JavaScript document engine (`jsdocgen`). The
/// frontend `DocCodeRunner` executes the model's program in a sandboxed
/// iframe and posts the produced file back as base64 (or an error message).
/// Resolves the async waiter parked in `chat::jsdocgen::generate`.
#[tauri::command]
pub fn docgen_complete(request_id: String, data_b64: Option<String>, error: Option<String>) -> CmdResult<()> {
    let result = match (data_b64, error) {
        (Some(b64), _) => crate::chat::jsdocgen::decode_base64(&b64),
        (None, Some(e)) => Err(e),
        (None, None) => Err(
            "the document runner returned neither file data nor an error".to_string(),
        ),
    };
    crate::chat::jsdocgen::complete(&request_id, result);
    Ok(())
}

/// Last-modified time of a file, in seconds since the Unix epoch. The
/// artifact preview panes poll this (cheap stat) to hot-reload when the model
/// edits an open artifact file. `None` when the file is gone (deleted while
/// previewed) — the caller keeps showing the last good preview.
#[tauri::command]
pub fn get_file_mtime(path: String) -> CmdResult<Option<u64>> {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok(secs)
}

/// Find a file by basename under `dir` (breadth-first, bounded depth and
/// scan budget; vendor/heavy/hidden dirs are skipped). Returns the most
/// recently modified match, or `None`.
///
/// Recovers preview targets for chat file-change rows whose recorded path no
/// longer exists — models sometimes state a destination they didn't actually
/// write to, and files can move between the turn and the click.
#[tauri::command]
pub async fn find_file_by_basename(dir: String, basename: String) -> CmdResult<Option<String>> {
    if basename.trim().is_empty() {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&dir);
        Ok(find_by_basename_walk(&root, &basename))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sync core of `find_file_by_basename` — separated so it's unit-testable
/// without a tokio runtime. `basename` is matched case-insensitively.
fn find_by_basename_walk(root: &std::path::Path, basename: &str) -> Option<String> {
    let needle = basename.to_lowercase();
    const SKIP_DIRS: [&str; 8] = [
        "node_modules", ".git", "target", "dist", "build", ".next", ".venv", "__pycache__",
    ];
    const MAX_DEPTH: u8 = 6;
    const MAX_SCANNED: usize = 20_000;
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0u8)]);
    let mut scanned = 0usize;
    // Several files can share the name (an old copy in a sibling folder, a
    // rebuilt copy in the current one) — the MOST RECENTLY MODIFIED match
    // wins, since the user almost always means the freshest file.
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    while let Some((cur, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&cur) else {
            continue;
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > MAX_SCANNED {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let lower = name.to_string_lossy().to_lowercase();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir && lower == needle {
                let mtime = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                let replace = match &best {
                    None => true,
                    Some((best_time, _)) => mtime > *best_time,
                };
                if replace {
                    best = Some((mtime, path.clone()));
                }
            }
            if is_dir && depth < MAX_DEPTH && !SKIP_DIRS.contains(&lower.as_str()) {
                queue.push_back((path, depth + 1));
            }
        }
    }
    best.map(|(_, p)| p.to_string_lossy().into_owned())
}

// ---- Artifact download ----

/// Copy a generated artifact to a user-chosen destination path (the frontend
/// gets `dest` from a save dialog).
#[tauri::command]
pub async fn download_artifact(src: String, dest: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || {
        std::fs::copy(&src, &dest).map_err(|e| format!("could not save file: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Zip several artifacts into a user-chosen destination `.zip` path. Duplicate
/// filenames are disambiguated with a numeric suffix.
///
/// PERF (PERFORMANCE_AUDIT.md B3): the per-file reads + deflate run in
/// `spawn_blocking` — the sync version blocked the IPC worker for every byte
/// read and compressed.
#[tauri::command]
pub async fn download_artifacts_zip(paths: Vec<String>, dest: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use std::path::Path;
        use zip::write::SimpleFileOptions;

        let file = std::fs::File::create(&dest).map_err(|e| format!("could not create zip: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        for src in &paths {
            let data = match std::fs::read(src) {
                Ok(d) => d,
                Err(_) => continue, // skip missing files rather than aborting the whole zip
            };
            let base = Path::new(src)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let mut name = base.clone();
            let mut n = 1;
            while used.contains(&name) {
                let (stem, ext) = match base.rsplit_once('.') {
                    Some((s, e)) => (s.to_string(), format!(".{e}")),
                    None => (base.clone(), String::new()),
                };
                name = format!("{stem} ({n}){ext}");
                n += 1;
            }
            used.insert(name.clone());
            zip.start_file(name, opts)
                .map_err(|e| format!("zip error: {e}"))?;
            zip.write_all(&data).map_err(|e| format!("zip error: {e}"))?;
        }
        zip.finish().map_err(|e| format!("zip error: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- API key management ----

/// Store the chat API key in the OS keychain, and provider config in app_settings.
/// The key value is NEVER returnable via any IPC command.
///
/// When `key` is empty but the provider already has a stored key, the keychain
/// entry is left untouched — only settings (base_url, model) are updated. This
/// allows model-only / baseUrl-only changes without re-entering the key. When
/// `key` is non-empty, it replaces the stored keychain entry. When both `key`
/// is empty AND no key exists for this provider, we reject (nothing to save).
#[tauri::command]
pub fn set_chat_api_key(
    provider: String,
    key: String,
    base_url: Option<String>,
    model: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    if provider.trim().is_empty() {
        return Err("provider must not be empty".to_string());
    }

    let conn = db.0.lock();
    // local_gguf has no API key (llama-server is keyless). Skip the keychain
    // entirely — only persist base_url/model/active_provider.
    if provider != "local_gguf" {
        if !key.trim().is_empty() {
            // User provided a new key — store it in the OS keychain.
            secrets::set_chat_api_key(&conn, &provider, &key)?;
        }
        // If key is empty and no existing key, we still allow saving base_url/model
        // so the user can set up the config before entering the key.
        // The key can be added later.
    }

    if let Some(url) = base_url {
        db::set_setting(&conn, &format!("chat.{provider}.base_url"), &url)
            .map_err(|e| e.to_string())?;
    }
    if let Some(m) = model {
        db::set_setting(&conn, &format!("chat.{provider}.model"), &m)
            .map_err(|e| e.to_string())?;
    }
    // Remember the provider the user last configured so the app reopens on it
    // instead of falling back to the hardcoded priority order. See get_chat_config.
    db::set_setting(&conn, "chat.active_provider", &provider).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_chat_api_key(provider: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    secrets::delete_chat_api_key(&conn, &provider)?;
    // Clearing a provider removes its whole configuration, not just the key.
    conn.execute(
        "DELETE FROM app_settings WHERE key IN (?1, ?2)",
        rusqlite::params![
            format!("chat.{provider}.base_url"),
            format!("chat.{provider}.model"),
        ],
    )
    .map_err(|e| e.to_string())?;
    // If the deleted provider was the remembered active one, drop the marker so
    // get_chat_config falls back to the priority scan instead of a dead provider.
    let active = db::get_setting(&conn, "chat.active_provider").map_err(|e| e.to_string())?;
    if active.as_deref() == Some(provider.as_str()) {
        conn.execute(
            "DELETE FROM app_settings WHERE key = 'chat.active_provider'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Persist ONLY the per-provider default model (`chat.<provider>.model`) —
/// no keychain write, no base_url touch, no `chat.active_provider` flip.
///
/// Called when the user picks a model in the composer so freshly created
/// chats seed with that model (the auto-start path reads get_chat_config →
/// chat.<provider>.model) instead of a long-stale Settings-era default.
/// Harness/ACP picks never reach this from the frontend: their model ids are
/// CLI-specific and meaningless as provider defaults. local_gguf is also not
/// written here — its default is owned by start_local_model (the id must
/// match what llama-server was actually started with, or sends would 400).
#[tauri::command]
pub fn set_chat_default_model(
    provider: String,
    model: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("provider must not be empty".to_string());
    }
    let conn = db.0.lock();
    db::set_setting(&conn, &format!("chat.{provider}.model"), &model)
        .map_err(|e| e.to_string())
}

/// Returns non-secret config only — the API key value is NEVER returned.
///
/// When `provider` is None, returns config for the **last-configured** provider
/// (the one most recently saved via `set_chat_api_key`, stored as the
/// `chat.active_provider` setting) — so reopening the app lands on the provider
/// the user was actually using. Falls back to a priority scan
/// (anthropic → openai → openrouter → anthropic_compatible → openai_compatible)
/// only when no active provider is remembered or its key was since removed. The
/// `has_key` field tells the API Keys panel whether Save is allowed without
/// re-entering the key.
#[tauri::command]
pub fn get_chat_config(provider: Option<String>, db: State<DbState>) -> CmdResult<ChatConfigPayload> {
    let conn = db.0.lock();
    match provider {
        Some(p) => {
            let base_url = db::get_setting(&conn, &format!("chat.{p}.base_url"))
                .map_err(|e| e.to_string())?;
            let model = db::get_setting(&conn, &format!("chat.{p}.model"))
                .map_err(|e| e.to_string())?;
            // local_gguf is keyless — always treat as having a "key" so the
            // frontend doesn't block on a missing API key.
            let has_key = if p == "local_gguf" {
                true
            } else {
                secrets::has_chat_api_key(&conn, &p)
            };
            Ok(ChatConfigPayload {
                provider: Some(p),
                base_url,
                model,
                has_key,
            })
        }
        None => {
            // Prefer the provider the user last configured (saved a key/config
            // for) — so reopening the app lands on the provider they were
            // actually using, not whichever happens to come first in the
            // priority list below. Falls back to that priority scan only when no
            // active provider is remembered or its key was since removed.
            if let Some(active) = db::get_setting(&conn, "chat.active_provider")
                .map_err(|e| e.to_string())?
            {
                // local_gguf is never honored as the reopen-on provider: the
                // llama-server sidecar dies with the app, so by the time the
                // app relaunches that provider is always a dead endpoint —
                // seeding fresh chats with its last model name manufactured
                // stale context meters (16K default cap, no live sidecar,
                // "Model: <gguf>" the user never picked for THIS chat). Local
                // models stay reachable via the composer picker and Settings
                // → "Use this model"; they're just never the AUTO default.
                // This also neutralizes markers written by older builds.
                if !active.is_empty()
                    && active != "local_gguf"
                    && secrets::has_chat_api_key(&conn, &active)
                {
                    let base_url = db::get_setting(&conn, &format!("chat.{active}.base_url"))
                        .map_err(|e| e.to_string())?;
                    let model = db::get_setting(&conn, &format!("chat.{active}.model"))
                        .map_err(|e| e.to_string())?;
                    return Ok(ChatConfigPayload {
                        provider: Some(active),
                        base_url,
                        model,
                        has_key: true,
                    });
                }
            }
            for p in [
                "anthropic",
                "openai",
                "openrouter",
                "anthropic_compatible",
                "openai_compatible",
            ] {
                if secrets::has_chat_api_key(&conn, p) {
                    let base_url = db::get_setting(&conn, &format!("chat.{p}.base_url"))
                        .map_err(|e| e.to_string())?;
                    let model = db::get_setting(&conn, &format!("chat.{p}.model"))
                        .map_err(|e| e.to_string())?;
                    return Ok(ChatConfigPayload {
                        provider: Some(p.to_string()),
                        base_url,
                        model,
                        has_key: true,
                    });
                }
            }
            // No provider has a stored key yet.
            Ok(ChatConfigPayload {
                provider: None,
                base_url: None,
                model: None,
                has_key: false,
            })
        }
    }
}

/// List available models from a compatible provider by querying its `/v1/models` endpoint.
/// Supports both Anthropic-compatible (`x-api-key` header) and OpenAI-compatible
/// (`Authorization: Bearer` header) providers.
#[tauri::command]
pub async fn list_chat_models(
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<crate::types::ChatModel>> {
    // local_gguf models come from the scanned GGUF list, not a /v1/models
    // endpoint. The frontend is told not to call this for local_gguf;
    // return an empty vec as a safe no-op.
    if provider == "local_gguf" {
        return Ok(Vec::new());
    }

    use reqwest;

    // Resolve base_url: prefer the passed argument, then the stored setting.
    // The fixed-endpoint providers (native anthropic/openai, OpenRouter) fall
    // back to their default bases so the agent picker can list their models
    // without a stored base_url.
    let base = match base_url {
        Some(url) if !url.trim().is_empty() => url,
        _ => {
            let conn = db.0.lock();
            db::get_setting(&conn, &format!("chat.{provider}.base_url"))
                .map_err(|e| e.to_string())?
                .or_else(|| match provider.as_str() {
                    "openrouter" => Some(OpenRouterProvider::DEFAULT_BASE.to_string()),
                    "anthropic" => Some(AnthropicProvider::DEFAULT_BASE.to_string()),
                    "openai" => Some(OpenAIProvider::DEFAULT_BASE.to_string()),
                    _ => None,
                })
                .ok_or_else(|| "base_url is required for compatible providers".to_string())?
        }
    };

    // Resolve API key: prefer the passed argument, then the keychain.
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            let conn = db.0.lock();
            secrets::get_chat_api_key(&conn, &provider)
                .ok_or_else(|| format!("no API key configured for provider: {provider}"))?
        }
    };

    let url = format!("{base}/v1/models");

    // B-10: these are one-shot JSON calls — a total timeout is safe here and
    // bounds a wedged endpoint instead of hanging the async command forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let req = client.get(&url);

    let req = match provider.as_str() {
        "anthropic" | "anthropic_compatible" => req
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01"),
        "openai" | "openai_compatible" | "openrouter" => {
            req.header("Authorization", format!("Bearer {key}"))
        }
        _ => return Err("list_chat_models only supports compatible providers".to_string()),
    };

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body_text = resp.text().await.map_err(|e| e.to_string())?;

    if status == 404 {
        return Ok(vec![]);
    }

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body_text}"));
    }

    // Try to parse as JSON
    let json: serde_json::Value = match serde_json::from_str(&body_text) {
        Ok(v) => v,
        Err(e) => {
            // Log the raw response for debugging
            eprintln!("[list_chat_models] Failed to parse JSON: {e}");
            eprintln!("[list_chat_models] Raw response (first 500 chars): {}", &body_text.chars().take(500).collect::<String>());
            return Err(format!("error decoding response body: {e}"));
        }
    };

    // Try standard OpenAI shape first ({ data: [...] }). Only `id` is
    // required — many compatible providers omit object/created/owned_by.
    // Per-model context window: Anthropic publishes `context_window`,
    // OpenRouter `context_length` — accept either. Absent → None (the
    // frontend's registry fallback stands).
    let model_window = |v: &serde_json::Value| -> Option<u64> {
        v.get("context_window")
            .and_then(|w| w.as_u64())
            .or_else(|| v.get("context_length").and_then(|w| w.as_u64()))
            .filter(|w| *w > 0)
    };
    let models: Vec<crate::types::ChatModel> = if let Some(data) = json.get("data").and_then(|v| v.as_array()) {
        data.iter()
            .filter_map(|v| {
                let id = v.get("id")?.as_str()?.to_string();
                let object = v
                    .get("object")
                    .and_then(|o| o.as_str())
                    .unwrap_or("model")
                    .to_string();
                let created = v.get("created").and_then(|c| c.as_i64()).unwrap_or(0);
                let owned_by = v
                    .get("owned_by")
                    .and_then(|o| o.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(crate::types::ChatModel {
                    id,
                    object,
                    created,
                    owned_by,
                    context_window: model_window(v),
                })
            })
            .collect()
    } else if let Some(arr) = json.as_array() {
        // Fallback: plain array of model IDs.
        arr.iter()
            .filter_map(|v| {
                let id = v.as_str()?.to_string();
                Some(crate::types::ChatModel {
                    id,
                    object: "model".to_string(),
                    created: 0,
                    owned_by: "".to_string(),
                    context_window: None,
                })
            })
            .collect()
    } else {
        return Err("unexpected /v1/models response shape".to_string());
    };

    Ok(models)
}

// ---- Local models (GGUF scan / llama-server sidecar) ----

/// Scan a folder (or default locations) for `.gguf` files, returning their
/// metadata and a memory-sanity indicator.
#[tauri::command]
pub fn scan_local_models(
    folder: Option<String>,
    db: State<DbState>,
) -> CmdResult<Vec<GgufModel>> {
    use crate::chat::local_models::{memory_class, GgufFile};

    // When a specific folder is given, scan just that one. Otherwise scan the
    // default locations AND any user-added folders persisted via Settings
    // (the `localModels.folders` setting) — so both the Settings panel and the
    // Chat dropdown see the same full set of models from a bare scan_local_models().
    let files: Vec<GgufFile> = if let Some(dir) = folder {
        local_models::scan_folder(Path::new(&dir), "user")
    } else {
        let mut files = local_models::scan_default_locations();
        let mut seen: std::collections::HashSet<String> =
            files.iter().map(|f| f.id.clone()).collect();
        // Also scan the Model Market's download dir — both the user-picked
        // override (`local_models.dir`) and its ~/Conduit/models default —
        // otherwise market downloads never show up in the local list.
        {
            let conn = db.0.lock();
            if let Ok(Some(dir)) = db::get_setting(&conn, "local_models.dir") {
                if !dir.trim().is_empty() {
                    for file in local_models::scan_folder(Path::new(&dir), "market") {
                        if seen.insert(file.id.clone()) {
                            files.push(file);
                        }
                    }
                }
            }
        }
        if let Some(home) = dirs::home_dir() {
            let market_default = home.join("Conduit").join("models");
            for file in local_models::scan_folder(&market_default, "market") {
                if seen.insert(file.id.clone()) {
                    files.push(file);
                }
            }
        }
        // Load persisted user-added folders and scan each, deduping by file id.
        let stored = {
            let conn = db.0.lock();
            db::get_setting(&conn, "localModels.folders")
        };
        if let Ok(Some(json)) = stored {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
                for f in list.into_iter().filter(|s| !s.trim().is_empty()) {
                    for file in local_models::scan_folder(Path::new(&f), "user") {
                        if seen.insert(file.id.clone()) {
                            files.push(file);
                        }
                    }
                }
            }
        }
        files
    };

    // Total system RAM for the memory-class indicator.
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    let total_ram = sys.total_memory();

    let models: Vec<GgufModel> = files
        .into_iter()
        .map(|f| {
            let mc = memory_class(f.size_bytes, total_ram);
            GgufModel {
                id: f.id,
                path: f.path,
                filename: f.filename,
                size_bytes: f.size_bytes,
                name: f.meta.name,
                architecture: f.meta.architecture,
                param_count_label: f.meta.param_count_label,
                quantization: f.meta.quantization,
                memory_class: mc.as_str().to_string(),
                source: f.source,
                has_vision: f.has_vision,
                mmproj_path: f.mmproj_path,
            }
        })
        .collect();

    Ok(models)
}

/// Start a llama-server sidecar, health-check it, and persist the base_url +
/// model so `send_chat_message` picks it up immediately. `overrides` carries
/// live-edited runtime tweaks; when None the persisted per-model blob is
/// loaded (`localModels.overrides`), so every spawn path shares one source of
/// truth. The last-good GPU-layer count is recorded back into the blob so
/// restarts skip the probe ladder.
#[tauri::command]
pub async fn start_local_model(
    model_id: String,
    path: String,
    mmproj_path: Option<String>,
    overrides: Option<local_models::LlamaOverrides>,
    db: State<'_, DbState>,
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<StartedModel> {
    let ovr = match overrides {
        Some(o) => o,
        None => {
            let conn = db.0.lock();
            local_models::load_overrides(&conn, &model_id)
        }
    };
    // Pre-read the llama-server path (must not hold the lock across await).
    let user_llama_path = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY)
            .ok()
            .flatten()
    };
    let started = local
        .0
        .start(model_id, &path, mmproj_path.as_deref(), Some(&ovr), user_llama_path)
        .await?;

    // Persist the base_url + model for the send path (chat.local_gguf.*).
    //
    // Deliberately does NOT touch `chat.active_provider`: that setting means
    // "the provider the user configured in Settings" and drives which
    // provider NEW chats are seeded with (get_chat_config → newChat). Letting
    // a sidecar spawn flip it globally made every fresh chat come up as
    // local_gguf with a stale model name — even sessions the user never
    // pointed at a local model. After an app restart the sidecar is gone
    // anyway, so seeding local by default was never useful; the send path
    // re-spawns on demand via the warm-up branch below.
    {
        let conn = db.0.lock();
        db::set_setting(&conn, "chat.local_gguf.base_url", &started.base_url)
            .map_err(|e| e.to_string())?;
        db::set_setting(&conn, "chat.local_gguf.model", &started.model_id)
            .map_err(|e| e.to_string())?;
        local_models::save_last_good_ngl(&conn, &started.model_id, started.n_gpu_layers);
    }

    // The frontend runs `warmup_local_prompt` right after this resolves,
    // passing the working dir only it knows (selected project / custom
    // folder / worktree) and keeping its loading spinner up until the
    // warmup completes — "loaded" then means the first message answers
    // immediately.

    // The frontend expects these exact camelCase fields (mirrors types.rs).
    Ok(StartedModel {
        model_id: started.model_id,
        port: started.port,
        n_ctx: started.n_ctx,
        n_gpu_layers: started.n_gpu_layers,
        base_url: started.base_url,
    })
}

#[tauri::command]
pub async fn stop_local_model(
    model_id: String,
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<()> {
    local.0.stop(&model_id).await;
    Ok(())
}

#[tauri::command]
pub fn local_model_status(
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<Option<ActiveLocalModel>> {
    Ok(local.0.status().map(|a| ActiveLocalModel {
        model_id: a.model_id,
        port: a.port,
        n_ctx: a.n_ctx,
        n_gpu_layers: a.n_gpu_layers,
        base_url: a.base_url,
    }))
}

/// Get the user-configured llama-server path (if any). Written by the
/// "One-click path setup" button in the Local Models settings panel.
#[tauri::command]
pub fn get_llama_server_path(db: State<'_, DbState>) -> CmdResult<LlamaServerPathResult> {
    let conn = db.0.lock();
    let path_opt = db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY).unwrap_or(None);
    Ok(LlamaServerPathResult { path: path_opt })
}

/// Result wrapper for llama-server path queries
#[derive(Debug, serde::Serialize)]
pub struct LlamaServerPathResult {
    pub path: Option<String>,
}

/// Set the user-configured llama-server path. Returns success with the
/// new path, or an error if the path is invalid (binary not found).
#[tauri::command]
pub async fn set_llama_server_path(
    path: String,
    db: State<'_, DbState>,
) -> CmdResult<String> {
    // Validate: check if the path is a file or a directory with llama-server inside.
    let p = std::path::Path::new(&path);
    let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let valid = if p.is_file() {
        true
    } else if cfg!(windows) && p.with_extension("exe").is_file() {
        // On Windows, try adding .exe extension
        true
    } else if p.is_dir() && p.join(bin_name).is_file() {
        // Directory containing the binary
        true
    } else {
        false
    };
    if !valid {
        return Err(format!(
            "Path '{}' is not a valid llama-server binary or directory containing it. \
             On Windows, try '{}llama-server.exe' or '{}'\\llama.cpp\\build\\bin\\llama-server.exe",
            path.trim_end_matches("/\\"),
            path.trim_end_matches("/\\"),
            path.trim_end_matches("/\\")
        ));
    }

    // Store the path as-is (could be a file or directory).
    let conn = db.0.lock();
    db::set_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY, &path)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Detect and set common llama-server installation paths. Returns the
/// detected path or null if none found. Used by "one-click setup".
#[tauri::command]
pub fn detect_llama_server_path(db: State<'_, DbState>) -> CmdResult<LlamaServerPathResult> {
    // Check if already configured via the UI
    let conn = db.0.lock();
    if let Some(path) = db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY).unwrap_or(None) {
        if !path.is_empty() {
            return Ok(LlamaServerPathResult { path: Some(path) });
        }
    }

    let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };

    // 1. Check LLAMA_SERVER_PATH environment variable (highest priority)
    if let Ok(env_path) = std::env::var("LLAMA_SERVER_PATH") {
        let p = std::path::Path::new(&env_path);
        if p.is_file() || p.with_extension("exe").is_file() || p.is_dir() && p.join(bin_name).is_file() {
            return Ok(LlamaServerPathResult { path: Some(env_path) });
        }
    }

if cfg!(windows) {
        // On Windows, scan all drive letters (A-Z) for the source build.
        // Check both the MSVC multi-config layout and the single-config one,
        // plus common flat-drop layouts like legacy CUDA builds (llama-cuda).
        for drive_letter in b'A'..=b'Z' {
            let drive = drive_letter as char;
            // Source builds (MSVC config)
            for rel in [r"\llama.cpp\build\bin\Release", r"\llama.cpp\build\bin"] {
                let candidate = format!("{drive}:{rel}\\{bin_name}");
                if std::path::Path::new(&candidate).is_file() {
                    return Ok(LlamaServerPathResult { path: Some(candidate) });
                }
            }
            // Legacy CUDA drop / flat layouts
            for folder in ["llama-cuda", "llamacpp", "llama.cpp", "llama"] {
                let candidate = format!("{drive}:\\{folder}\\{bin_name}");
                if std::path::Path::new(&candidate).is_file() {
                    return Ok(LlamaServerPathResult { path: Some(candidate)});
                }
            }
        }
        // Also check common alternative locations
        for alt in [
            r"C:\Program Files\llama.cpp\bin\llama-server.exe",
        ] {
            if std::path::Path::new(alt).is_file() {
                return Ok(LlamaServerPathResult { path: Some(alt.to_string()) });
            }
        }
        // Check if llama-server is on PATH (Windows)
        let output = std::process::Command::new(bin_name)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                return Ok(LlamaServerPathResult { path: Some(bin_name.to_string()) });
            }
        }
    } else {
        // Unix: similar check for common locations
        let path_output = if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(':') {
                let candidate = format!("{}/{}", dir, bin_name);
                if std::path::Path::new(&candidate).is_file() {
                    return Ok(LlamaServerPathResult { path: Some(bin_name.to_string()) });
                }
            }
            None
        } else {
            None
        };

        for candidate in [
            "/usr/local/bin/llama-server",
            "/opt/llama.cpp/build/bin/llama-server",
            "/usr/bin/llama-server",
            "/opt/homebrew/bin/llama-server",
            "/usr/local/opt/llama.cpp/bin/llama-server",
        ] {
            let p = std::path::Path::new(candidate);
            if p.is_file() {
                return Ok(LlamaServerPathResult { path: Some(candidate.to_string()) });
            }
            if p.is_dir() && p.join(bin_name).is_file() {
                return Ok(LlamaServerPathResult { path: Some(candidate.to_string()) });
            }
        }
        // If PATH lookup succeeded, return the binary name
        if let Some(()) = path_output {
            return Ok(LlamaServerPathResult { path: Some(bin_name.to_string()) });
        }
    }

    Ok(LlamaServerPathResult { path: None })
}

/// Live context-window usage for the active local-model session. Asks the
/// running llama-server to tokenize the assembled (system + active history)
/// conversation and returns the count alongside the sidecar's `-c` cap. The
/// composer polls this so the circular context meter is always current — the
/// stale `inputTokens` of the last persisted assistant turn is the previous
/// fallback, which only updated on a chat:done and never reflected compaction.
///
/// Non-local sessions return a zero-cap payload (the meter falls back to its
/// API flat-256K behaviour). No-sidecar / errored-tokenize returns
/// `used_tokens: null` so the meter keeps showing whatever the last known
/// value was instead of snapping to 0.
/// In-memory cache for `fetch_provider_model_windows`: provider → (fetched_at,
/// id → context_window). 24h TTL — model catalogs change slowly, and the
/// meter re-reads this on every resolve.
static MODEL_WINDOWS_CACHE: std::sync::OnceLock<
    parking_lot::Mutex<std::collections::HashMap<String, (std::time::Instant, std::collections::HashMap<String, u32>)>>,
> = std::sync::OnceLock::new();

const MODEL_WINDOWS_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Live per-model context windows for a cloud provider, straight from the
/// provider's own models API — the dynamic half of the window registry (the
/// static table in `context_windows.rs` is only the fallback). Anthropic's
/// `/v1/models` publishes `context_window` per model id and the backend
/// holds the API key, so the fetch happens here, not in the webview.
/// OpenRouter's public endpoint is fetched by the frontend directly (no
/// key needed); OpenAI publishes no window data on any keyed API, so an
/// empty map is returned and the registry fallback stands.
///
/// Results are cached in memory for 24h; a failed fetch returns the stale
/// cache when present, else an empty map (callers treat that as "no dynamic
/// data, registry wins").
#[tauri::command]
pub async fn fetch_provider_model_windows(
    provider: String,
    db: State<'_, DbState>,
) -> CmdResult<std::collections::HashMap<String, u32>> {
    let cache = MODEL_WINDOWS_CACHE.get_or_init(|| {
        parking_lot::Mutex::new(std::collections::HashMap::new())
    });
    if let Some((at, table)) = cache.lock().get(&provider) {
        if at.elapsed() < MODEL_WINDOWS_TTL {
            return Ok(table.clone());
        }
    }

    let table: std::collections::HashMap<String, u32> = match provider.as_str() {
        "anthropic" => {
            let (api_key, base) = {
                let conn = db.0.lock();
                let key = crate::secrets::get_chat_api_key(&conn, "anthropic");
                let base = db::get_setting(&conn, "chat.anthropic.base_url")
                    .ok()
                    .flatten()
                    .filter(|b| !b.trim().is_empty())
                    .unwrap_or_else(|| {
                        crate::chat::providers::AnthropicProvider::DEFAULT_BASE.to_string()
                    });
                (key, base)
            };
            let Some(api_key) = api_key else {
                return Ok(std::collections::HashMap::new());
            };
            let client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .get(format!("{base}/v1/models?limit=1000"))
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                // Stale cache beats a live failure.
                if let Some((_, table)) = cache.lock().get(&provider) {
                    eprintln!("[context-windows] anthropic fetch failed ({status}); using stale cache");
                    return Ok(table.clone());
                }
                return Err(format!("models fetch returned {status}: {}", crate::util::truncate_chars(body.trim(), 300)));
            }
            let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let mut table = std::collections::HashMap::new();
            for m in v
                .get("data")
                .and_then(|d| d.as_array())
                .into_iter().flatten()
            {
                let Some(id) = m.get("id").and_then(|i| i.as_str()) else { continue };
                let Some(w) = m.get("context_window").and_then(|w| w.as_u64()) else { continue };
                if w > 0 {
                    table.insert(id.to_ascii_lowercase(), w as u32);
                }
            }
            eprintln!(
                "[context-windows] anthropic live table: {} model(s) with context_window",
                table.len()
            );
            table
        }
        // OpenRouter: the frontend fetches the public endpoint directly (no
        // key). OpenAI: no window data on any keyed API. Both keep the
        // registry fallback.
        _ => std::collections::HashMap::new(),
    };

    cache.lock().insert(provider.clone(), (std::time::Instant::now(), table.clone()));
    Ok(table)
}

/// One entry of a provider's curated model list (`chat.<provider>.
/// selected_models`). `context_window` is the per-model window the user
/// pinned in Settings (0/None = auto — live API figure, else the static
/// registry). When the list is non-empty it IS the provider's model picker
/// content; empty/absent = show everything the /v1/models fetch returns.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModel {
    pub id: String,
    #[serde(default)]
    pub context_window: u64,
}

fn selected_models_key(provider: &str) -> String {
    format!("chat.{provider}.selected_models")
}

/// Load a provider's curated model list. `None` = nothing curated (the
/// picker shows every model the /v1/models fetch returns).
pub(crate) fn load_selected_models(
    conn: &rusqlite::Connection,
    provider: &str,
) -> Option<Vec<SelectedModel>> {
    let raw = crate::db::get_setting(conn, &selected_models_key(provider))
        .ok()
        .flatten()?;
    let list: Vec<SelectedModel> = serde_json::from_str(&raw).ok()?;
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

/// Persist a provider's curated model list (Settings → API provider →
/// Model list). An empty list clears the curation.
#[tauri::command]
pub fn set_selected_models(
    provider: String,
    models: Vec<SelectedModel>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    if models.is_empty() {
        crate::db::delete_setting(&conn, &selected_models_key(&provider))
            .map_err(|e| e.to_string())?;
    } else {
        let json = serde_json::to_string(&models).map_err(|e| e.to_string())?;
        crate::db::set_setting(&conn, &selected_models_key(&provider), &json)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The per-model window override for a specific model id — the value the
/// user pinned on its row in the provider's Model list. This is the
/// AUTHORITATIVE figure when set (the user's explicit choice for that
/// model, e.g. a remapped backend serving a different window than the id
/// suggests); it wins over both the live API figure and the registry.
/// Returns None when the model has no pinned window.
pub(crate) fn load_model_window_override(
    conn: &rusqlite::Connection,
    provider: &str,
    model: &str,
) -> Option<u32> {
    let list = load_selected_models(conn, provider)?;
    let m = model.trim().to_ascii_lowercase();
    list.iter()
        .find(|e| e.id.trim().to_ascii_lowercase() == m)
        .and_then(|e| {
            if e.context_window > 0 {
                u32::try_from(e.context_window).ok()
            } else {
                None
            }
        })
}

/// The effective window for a cloud/harness session model, resolving in
/// order: per-model pinned window (authoritative) → registry/dynamic
/// window capped by the global context-limit override. Shared by the meter
/// paths and the compaction trigger so they can never disagree.
pub(crate) fn effective_session_window(
    conn: &rusqlite::Connection,
    provider_str: &str,
    model: &str,
) -> u32 {
    if let Some(pinned) = load_model_window_override(conn, provider_str, model) {
        return pinned;
    }
    let global_cap = crate::chat::context_windows::load_context_limit_override(conn);
    crate::chat::context_windows::effective_cloud_window(model, global_cap)
}

/// Parse a chat_sessions.provider string into the provider enum. The send
/// path matches inline (it must hard-fail on unknown providers); the meter
/// paths need the tolerant variant — they render for whatever the session
/// store holds, including harness ids.
pub(crate) fn parse_provider_id(s: &str) -> Option<ChatProviderId> {
    match s {
        "anthropic" => Some(ChatProviderId::Anthropic),
        "openai" => Some(ChatProviderId::OpenAI),
        "anthropic_compatible" => Some(ChatProviderId::AnthropicCompatible),
        "openai_compatible" => Some(ChatProviderId::OpenAICompatible),
        "openrouter" => Some(ChatProviderId::OpenRouter),
        "local_gguf" => Some(ChatProviderId::LocalGguf),
        _ => None,
    }
}

/// True for CLI-harness session providers ("harness:claude_code", "acp:<id>").
/// Relay sends these sessions one content string per turn — no Relay-built
/// system prompt, no tool-schema JSON — so their context estimates count DB
/// history only.
fn is_harness_provider(provider_str: &str) -> bool {
    provider_str.starts_with("harness:") || provider_str.starts_with("acp:")
}

/// Serialize the BUILT-IN tool schema — the reserve basis for every
/// compaction budget (local `/tokenize`d, cloud char-estimated). Connector
/// and MCP tools attach per-turn inside the send task and are covered by the
/// threshold's margin, exactly as the local block documented.
fn builtin_tool_specs_json(provider_id: &ChatProviderId, model: &str, code_exec: bool) -> String {
    let pcaps = crate::chat::prompts::provider_capabilities(provider_id.clone(), model);
    let caps = crate::chat::tools::ToolCaps {
        code_exec: code_exec,
        fs_roots: Vec::new(),
        web_search: pcaps.native_web_search,
        requires_local_sandbox: pcaps.requires_local_sandbox,
        attached_connectors: std::sync::Arc::new(Vec::new()),
        local_docs: false,
        mcp_tools: std::sync::Arc::new(Vec::new()),
        attachable_connectors: std::sync::Arc::new(Vec::new()),
        attachable_mcp: std::sync::Arc::new(Vec::new()),
        local_model: false,
        fs_rules: Vec::new(),
    };
    serde_json::to_string(&crate::chat::tools::openai_tool_specs(
        &caps,
        crate::chat::permission::SandboxPolicy::WorkspaceWrite,
    ))
    .unwrap_or_default()
}

/// Resolve the CLOUD SUMMARIZER: the first configured cloud provider
/// (anthropic → openai → openrouter), its endpoint, API key, and model
/// (the provider's configured model, else its catalog default). Shared by
/// the compaction summarizer-override, the harness primer summary, and the
/// manual compact — one place decides "which cloud brain summarizes".
pub(crate) fn resolve_cloud_summarizer(
    conn: &rusqlite::Connection,
) -> Option<(ChatProviderId, String, String, String)> {
    for (p, default_base) in [
        ("anthropic", crate::chat::providers::AnthropicProvider::DEFAULT_BASE),
        ("openai", crate::chat::providers::OpenAIProvider::DEFAULT_BASE),
        ("openrouter", crate::chat::providers::OpenRouterProvider::DEFAULT_BASE),
    ] {
        if crate::secrets::get_chat_api_key(conn, p).is_none() {
            continue;
        }
        let base = db::get_setting(conn, &format!("chat.{p}.base_url"))
            .ok()
            .flatten()
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| default_base.to_string());
        let model = db::get_setting(conn, &format!("chat.{p}.model"))
            .ok()
            .flatten()
            .filter(|m| !m.trim().is_empty());
        let provider_id = parse_provider_id(p)?;
        let model = match model {
            Some(m) => m,
            None => provider_id.default_model_id().to_string(),
        };
        let api_key = crate::secrets::get_chat_api_key(conn, p)?;
        return Some((provider_id, base, api_key, model));
    }
    None
}

/// Rough char-based token estimate (~4 chars/token, rounded up) for providers
/// with no tokenizer endpoint Relay can call. Mirrors the frontend's
/// `charsToTokens` so both sides agree on what an estimate means.
pub(crate) fn estimate_tokens(text: &str) -> u32 {
    (text.chars().count() as u32 + 3) / 4
}

/// Category totals (in estimated tokens) for the cloud/harness context
/// breakdown. `total` = system + messages (same shape as the local
/// breakdown's total); the tool schema is reported separately because the
/// request carries it as its own field. Pure so the tests can pin the math.
fn estimate_usage_parts(
    system: &str,
    messages: &[ChatMessage],
    tool_specs: &str,
) -> (u32, u32, u32, u32) {
    let system_tokens = estimate_tokens(system);
    let messages_tokens: u32 = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
    let tools_tokens = estimate_tokens(tool_specs);
    (
        system_tokens + messages_tokens,
        system_tokens,
        messages_tokens,
        tools_tokens,
    )
}

/// The model id whose window a cloud/harness session's meter should use.
/// Harness sessions report the model their CLI LAST actually ran (persisted
/// as `agent.actual_model.<harness>.<sid>`); falling back to the session's
/// stored id keeps the window resolvable before the first harness turn.
fn meter_model_for_session(conn: &rusqlite::Connection, provider_str: &str, model_str: &str, sid: &str) -> String {
    if let Some(harness) = provider_str.strip_prefix("harness:") {
        let key = crate::agent_sessions::actual_model_key(harness, sid);
        if let Ok(Some(actual)) = crate::db::get_setting(conn, &key) {
            if !actual.trim().is_empty() {
                return actual;
            }
        }
    }
    model_str.to_string()
}

/// Live context-window usage for the active chat session. Local sessions ask
/// the running llama-server to tokenize the assembled (system + active
/// history) conversation and return the count alongside the sidecar's `-c`
/// cap. Cloud and harness sessions return a char-based estimate of what the
/// send path would assemble (system + history + tool schema) against the
/// model registry's window — live figures the meter can warn with before an
/// overflow, instead of waiting for the next chat:done.
///
/// No-sidecar / errored-tokenize returns `used_tokens: null` so the meter
/// keeps showing whatever the last known value was instead of snapping to 0.
#[tauri::command]
pub async fn count_context_tokens(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
    local: State<'_, local_models::LocalModelState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> CmdResult<crate::types::ContextUsagePayload> {
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };

    // Cloud and harness sessions have no sidecar to /tokenize — estimate
    // from char counts (~4 chars/token) so their meter is live too. The
    // estimate is fresher than the last assistant turn's input_tokens (it
    // includes the just-sent user message and any compaction immediately),
    // and ChatView takes the max of the two so a provider-counted prompt
    // always wins when it is larger.
    if provider_str != "local_gguf" {
        let records = {
            let conn = db.0.lock();
            db::list_active_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?
        };
        let last_id = records.last().map(|r| r.id).unwrap_or(0);
        let n_records = records.len();
        let messages: Vec<ChatMessage> = records
            .into_iter()
            .map(|r| ChatMessage {
                role: r.role,
                content: strip_think_blocks(&r.content),
                images: Vec::new(),
            })
            .collect();

        let (system_str, tool_specs_json) = if is_harness_provider(&provider_str) {
            // Harness turns carry no Relay-built system prompt or tool schema.
            (String::new(), String::new())
        } else {
            // Same builders as the local breakdown, but with the session's
            // own provider so the estimate mirrors what the send path would
            // assemble. LOCKING: attach_availability re-locks DbState — same
            // rule as the local path, never while `conn` is held.
            let (custom, attached_c, attached_m): (Option<String>, Vec<String>, Vec<String>) = {
                let conn = db.0.lock();
                let custom = db::get_setting(&conn, "assistant.systemPrompt")
                    .map_err(|e| e.to_string())?;
                let (c, m): (Vec<String>, Vec<String>) =
                    db::list_chat_session_connectors(&conn, &chat_session_id)
                        .unwrap_or_default()
                        .into_iter()
                        .partition(|r| !r.starts_with("mcp:"));
                (custom, c, m)
            };
            let attached_m: Vec<String> = attached_m
                .iter()
                .filter_map(|r| r.strip_prefix("mcp:").map(|s| s.to_string()))
                .collect();
            let system_str: String = {
                let provider_id = parse_provider_id(&provider_str).unwrap_or(ChatProviderId::OpenAI);
                let (avail_c, avail_m) = attach_availability(&app, &attached_c, &attached_m);
                let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
                crate::chat::build_system_prompt(
                    provider_id,
                    &model_str,
                    custom.as_deref(),
                    &[],
                    true,
                    false,
                    false,
                    manifest.as_deref(),
                )
                .unwrap_or_default()
            };
            let caps = crate::chat::tools::ToolCaps {
                code_exec: true,
                fs_roots: Vec::new(),
                web_search: false,
                requires_local_sandbox: false,
                attached_connectors: std::sync::Arc::new(Vec::new()),
                local_docs: false,
                mcp_tools: std::sync::Arc::new(Vec::new()),
                attachable_connectors: std::sync::Arc::new(Vec::new()),
                attachable_mcp: std::sync::Arc::new(Vec::new()),
                local_model: false,
                fs_rules: Vec::new(),
            };
            let tool_specs_json = serde_json::to_string(
                &crate::chat::tools::openai_tool_specs(
                    &caps,
                    crate::chat::permission::SandboxPolicy::WorkspaceWrite,
                ),
            )
            .unwrap_or_default();
            (system_str, tool_specs_json)
        };

        let max_tokens = {
            let conn = db.0.lock();
            let meter_model =
                meter_model_for_session(&conn, &provider_str, &model_str, &chat_session_id);
            effective_session_window(&conn, &provider_str, &meter_model)
        };

        // Cache hit: same transcript + prompt + model → same estimate. The
        // estimate itself is cheap, but the system-prompt build above scans
        // the skills directory — not something the 2s meter poll should do
        // forever while idle (same rationale as the local path's PERF B11).
        let fingerprint = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            system_str.hash(&mut h);
            provider_str.hash(&mut h);
            model_str.hash(&mut h);
            format!("{:x}:{last_id}:{n_records}", h.finish())
        };
        if let Some(tokens) = chat_state.0.cached_context_tokens(&chat_session_id, &fingerprint) {
            return Ok(crate::types::ContextUsagePayload {
                used_tokens: if tokens > 0 || n_records > 0 { Some(tokens) } else { None },
                max_tokens,
            });
        }

        let (total, _sys, _msgs, tools) =
            estimate_usage_parts(&system_str, &messages, &tool_specs_json);
        chat_state.0.store_context_tokens(&chat_session_id, fingerprint, total + tools);
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: Some(total + tools),
            max_tokens,
        });
    }

    let Some(status) = local.0.status() else {
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: None,
            max_tokens: 0,
        });
    };

    // Build the system + active-history exactly the way send_chat_message
    // does, so the count matches what the model would actually see. Only
    // active (non-superseded) rows feed the local model — compaction has
    // already soft-deleted summarized turns, so a stale `[compacted context]`
    // is never re-tokenized.
    //
    // PERF (B11): capture (last active id, count) alongside the rows so the
    // tokenize round-trip below can be skipped entirely when the transcript,
    // system prompt, and model are unchanged since the last poll — the common
    // case for the frontend's 2 s idle poll.
    let records = {
        let conn = db.0.lock();
        db::list_active_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
    };

    // Use the same system-prompt builder as the send path so the meter's
    // percentage matches the model's view: tools on (the composer default),
    // skills catalog included, plus the attach-on-demand manifest derived
    // from the session's attachment rows. Invoked-skill bodies depend on the
    // next user message and stay omitted — the small delta is well within the
    // 5% slack the threshold check already has.
    //
    // LOCKING: attach_availability re-locks DbState internally, so it must
    // run AFTER `conn` is dropped — this command is the first thing the
    // frontend polls once a local sidecar is up, and a nested lock here
    // deadlocked the whole app on model load.
    let (custom, attached_c, attached_m): (Option<String>, Vec<String>, Vec<String>) = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let (c, m): (Vec<String>, Vec<String>) =
            db::list_chat_session_connectors(&conn, &chat_session_id)
                .unwrap_or_default()
                .into_iter()
                .partition(|r| !r.starts_with("mcp:"));
        (custom, c, m)
    };
    let attached_m: Vec<String> = attached_m
        .iter()
        .filter_map(|r| r.strip_prefix("mcp:").map(|s| s.to_string()))
        .collect();
    let system_str: String = {
        let (avail_c, avail_m) = attach_availability(&app, &attached_c, &attached_m);
        let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
        crate::chat::build_system_prompt(
            ChatProviderId::LocalGguf,
            &model_str,
            custom.as_deref(),
            &[],
            true,
            false,
            false,
            manifest.as_deref(),
        )
        .unwrap_or_default()
    };

    let last_id = records.last().map(|r| r.id).unwrap_or(0);
    let has_messages = !records.is_empty();
    let fingerprint = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        system_str.hash(&mut h);
        model_str.hash(&mut h);
        format!("{:x}:{last_id}:{}", h.finish(), records.len())
    };

    // Cache hit: same transcript + prompt + model → same count. Skip the
    // /tokenize HTTP round-trip (and the message-vec build) entirely.
    if let Some(tokens) = chat_state.0.cached_context_tokens(&chat_session_id, &fingerprint) {
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: if tokens > 0 || has_messages { Some(tokens) } else { None },
            max_tokens: status.n_ctx,
        });
    }

    let messages: Vec<ChatMessage> = records
        .into_iter()
        .map(|r| ChatMessage {
            role: r.role,
            content: strip_think_blocks(&r.content),
            images: Vec::new(),
        })
        .collect();

    let system = if system_str.trim().is_empty() {
        None
    } else {
        Some(system_str)
    };

    let tokens = match crate::chat::compaction::count_tokens(
        &chat_state.0.client,
        &status.base_url,
        &system,
        &messages,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            // A failed tokenize is "no data", NOT zero: reporting Some(0)
            // snapped the context ring to 0% exactly when the number was
            // untrustworthy (tokenizer down / model unloaded). Contract:
            // report null and let the UI keep the last known value.
            eprintln!("[context-meter] /tokenize failed: {e}");
            return Ok(crate::types::ContextUsagePayload {
                used_tokens: None,
                max_tokens: status.n_ctx,
            });
        }
    };

    chat_state.0.store_context_tokens(&chat_session_id, fingerprint, tokens);

    // 0 with no messages is a genuinely empty transcript → null; 0 WITH
    // messages on a SUCCESSFUL tokenize is real data (empty system + no
    // active rows) and stays Some(0).
    Ok(crate::types::ContextUsagePayload {
        used_tokens: if tokens > 0 || has_messages { Some(tokens) } else { None },
        max_tokens: status.n_ctx,
    })
}

/// Per-category token breakdown for the context-meter tooltip. Called lazily
/// on hover (not polled) because it runs more tokenize round-trips.
/// Returns null for non-local_gguf sessions — the frontend falls back to
/// showing total only.
#[tauri::command]
pub async fn count_context_breakdown(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
    local: State<'_, local_models::LocalModelState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> CmdResult<Option<crate::types::ContextBreakdownPayload>> {
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };

    // Cloud/harness sessions have no sidecar — estimate per category from
    // char counts so the tooltip shows real proportions (derived from the
    // actual content) instead of the hardcoded 15/70/10/5 split it used to
    // fabricate.
    if provider_str != "local_gguf" {
        let (messages, meta_tokens) = {
            let conn = db.0.lock();
            let rows = db::list_active_chat_messages(&conn, &chat_session_id)
                .map_err(|e| e.to_string())?;
            let meta: u32 = rows
                .iter()
                .filter(|r| {
                    r.role == "system"
                        && r.content
                            .trim_start()
                            .starts_with(crate::chat::compaction::COMPACTED_PREFIX)
                })
                .map(|r| estimate_tokens(&strip_think_blocks(&r.content)))
                .sum();
            let messages: Vec<ChatMessage> = rows
                .into_iter()
                .map(|r| ChatMessage {
                    role: r.role,
                    content: strip_think_blocks(&r.content),
                    images: Vec::new(),
                })
                .collect();
            (messages, meta)
        };
        let (system_str, tool_specs_json) = if is_harness_provider(&provider_str) {
            (String::new(), String::new())
        } else {
            // Mirrors count_context_tokens' cloud branch (same builders, same
            // locking rule).
            let (custom, attached_c, attached_m): (Option<String>, Vec<String>, Vec<String>) = {
                let conn = db.0.lock();
                let custom = db::get_setting(&conn, "assistant.systemPrompt")
                    .map_err(|e| e.to_string())?;
                let (c, m): (Vec<String>, Vec<String>) =
                    db::list_chat_session_connectors(&conn, &chat_session_id)
                        .unwrap_or_default()
                        .into_iter()
                        .partition(|r| !r.starts_with("mcp:"));
                (custom, c, m)
            };
            let attached_m: Vec<String> = attached_m
                .iter()
                .filter_map(|r| r.strip_prefix("mcp:").map(|s| s.to_string()))
                .collect();
            let system_str: String = {
                let provider_id = parse_provider_id(&provider_str).unwrap_or(ChatProviderId::OpenAI);
                let (avail_c, avail_m) = attach_availability(&app, &attached_c, &attached_m);
                let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
                crate::chat::build_system_prompt(
                    provider_id,
                    &model_str,
                    custom.as_deref(),
                    &[],
                    true,
                    false,
                    false,
                    manifest.as_deref(),
                )
                .unwrap_or_default()
            };
            let caps = crate::chat::tools::ToolCaps {
                code_exec: true,
                fs_roots: Vec::new(),
                web_search: false,
                requires_local_sandbox: false,
                attached_connectors: std::sync::Arc::new(Vec::new()),
                local_docs: false,
                mcp_tools: std::sync::Arc::new(Vec::new()),
                attachable_connectors: std::sync::Arc::new(Vec::new()),
                attachable_mcp: std::sync::Arc::new(Vec::new()),
                local_model: false,
                fs_rules: Vec::new(),
            };
            let tool_specs_json = serde_json::to_string(
                &crate::chat::tools::openai_tool_specs(
                    &caps,
                    crate::chat::permission::SandboxPolicy::WorkspaceWrite,
                ),
            )
            .unwrap_or_default();
            (system_str, tool_specs_json)
        };
        let (total, system_prompt_tokens, messages_tokens, tool_specs_tokens) =
            estimate_usage_parts(&system_str, &messages, &tool_specs_json);
        let max_tokens = {
            let conn = db.0.lock();
            let meter_model =
                meter_model_for_session(&conn, &provider_str, &model_str, &chat_session_id);
            effective_session_window(&conn, &provider_str, &meter_model)
        };
        return Ok(Some(crate::types::ContextBreakdownPayload {
            total_tokens: total,
            max_tokens,
            system_prompt_tokens,
            messages_tokens,
            tool_specs_tokens,
            // Live connector sessions are per-turn; nothing persisted to
            // estimate here (same as the local path).
            connector_tools_tokens: 0,
            skills_tokens: 0,
            metacontext_tokens: meta_tokens,
        }));
    }

    let Some(status) = local.0.status() else {
        return Ok(None);
    };
    let client = chat_state.0.client.clone();
    let base_url = &status.base_url;

    // 1. System prompt — same builder as the send path (tools on, manifest
    //    included). Invoked-skill bodies depend on the current user message;
    //    we capture them separately below so their token counts stay distinct.
    //    LOCKING: attach_availability re-locks DbState — same rule as
    //    count_context_tokens: never call it while `conn` is held.
    let (custom, attached_c, attached_m): (Option<String>, Vec<String>, Vec<String>) = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let (c, m): (Vec<String>, Vec<String>) =
            db::list_chat_session_connectors(&conn, &chat_session_id)
                .unwrap_or_default()
                .into_iter()
                .partition(|r| !r.starts_with("mcp:"));
        (custom, c, m)
    };
    let attached_m: Vec<String> = attached_m
        .iter()
        .filter_map(|r| r.strip_prefix("mcp:").map(|s| s.to_string()))
        .collect();
    let system_str: String = {
        let (avail_c, avail_m) = attach_availability(&app, &attached_c, &attached_m);
        let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
        crate::chat::build_system_prompt(
            ChatProviderId::LocalGguf,
            &model_str,
            custom.as_deref(),
            &[],
            true,
            false,
            false,
            manifest.as_deref(),
        )
        .unwrap_or_default()
    };
    let system_prompt_tokens = crate::chat::compaction::count_json_tokens(&client, base_url, &system_str)
        .await
        .unwrap_or(0);

    // 2. Messages — assemble active history the same way count_context_tokens does.
    let messages: Vec<ChatMessage> = {
        let conn = db.0.lock();
        db::list_active_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| ChatMessage {
                role: r.role,
                content: strip_think_blocks(&r.content),
                images: Vec::new(),
            })
            .collect()
    };
    // Total = system + messages (what the model actually sees).
    let total_tokens = crate::chat::compaction::count_tokens(&client, base_url, &Some(system_str.clone()), &messages)
        .await
        .unwrap_or(0);
    // Messages-only = total - system (approximate; tokenizer boundary is small).
    let messages_tokens = total_tokens.saturating_sub(system_prompt_tokens);

    // 3. Tool specs — assembled OpenAI-format tool definitions.
    let caps = crate::chat::tools::ToolCaps {
        code_exec: true,
        fs_roots: Vec::new(),
        web_search: false,
        requires_local_sandbox: false,
        attached_connectors: std::sync::Arc::new(Vec::new()),
        // Pure-schema preview used by the settings UI — never saw a turn, so
        // local-docs capability is off here even if a sidecar happens to be up.
        local_docs: false,
        mcp_tools: std::sync::Arc::new(Vec::new()),
        attachable_connectors: std::sync::Arc::new(Vec::new()),
        attachable_mcp: std::sync::Arc::new(Vec::new()),
        local_model: false,
        fs_rules: Vec::new(),
    };
    let tool_specs_json = serde_json::to_string(&crate::chat::tools::openai_tool_specs(&caps, crate::chat::permission::SandboxPolicy::WorkspaceWrite))
        .unwrap_or_default();
    let tool_specs_tokens = crate::chat::compaction::count_json_tokens(&client, base_url, &tool_specs_json).await.unwrap_or(0);

    // 4. Connector/MCP tools — we don't have live connector sessions here
    //    (they're per-turn); estimate from the DB's connector credential rows.
    let connector_tools_tokens: u32 = 0u32;

    // 5. Skills — invoke the same skill resolver the send path uses for the
    //    last user message (best effort: the breakdown fires on hover which is
    //    not message-aware, so we sample the latest user turn from history).
    let skills_tokens: u32 = {
        let last_user_content = messages.iter().rev().find(|m| m.role == "user").map(|m| m.content.as_str());
        if let Some(content) = last_user_content {
            let invoked = parse_invoked_skills(content);
            if !invoked.is_empty() {
                let merged: String = invoked.iter().map(|(_, body)| body.as_str()).collect::<Vec<_>>().join("\n\n");
                crate::chat::compaction::count_json_tokens(&client, base_url, &merged).await.unwrap_or(0)
            } else {
                0
            }
        } else {
            0
        }
    };

    // 6. Metacontext — compacted-system summary row, if any.
    let metacontext_tokens: u32 = {
        let mut total = 0u32;
        for m in messages.iter().filter(|m| m.role == "system" && m.content.trim_start().starts_with(crate::chat::compaction::COMPACTED_PREFIX)) {
            total += crate::chat::compaction::count_json_tokens(&client, base_url, &m.content).await.unwrap_or(0);
        }
        total
    };

    // Total is computed above (system + messages); reuse it for the payload.
    Ok(Some(crate::types::ContextBreakdownPayload {
        total_tokens,
        max_tokens: status.n_ctx,
        system_prompt_tokens,
        messages_tokens,
        tool_specs_tokens,
        connector_tools_tokens,
        skills_tokens,
        metacontext_tokens,
    }))
}

/// Context recovery for the `[compacted context]` marker: returns the raw
/// turns a summary row folded away (they stay in the DB forever — the
/// summary is lossy, the rows are the restorable source). The summary row
/// must belong to the given session; think/tool display blocks are stripped
/// so the folded turns read like the rest of the timeline.
#[tauri::command]
pub fn list_compacted_messages(
    chat_session_id: String,
    summary_id: i64,
    db: State<'_, DbState>,
) -> CmdResult<Vec<crate::types::ChatMessageRecord>> {
    let conn = db.0.lock();
    let rows = db::list_messages_superseded_by(&conn, summary_id).map_err(|e| e.to_string())?;
    // Keep only rows belonging to the requested session — a mismatched
    // session/summary pair returns empty rather than another chat's history.
    let owned: Vec<crate::types::ChatMessageRecord> = rows
        .into_iter()
        .filter(|r| r.chat_session_id == chat_session_id)
        .map(|mut r| {
            r.content = strip_think_blocks(&r.content);
            r
        })
        .collect();
    Ok(owned)
}

/// Manual compaction ("Compact now" in the context-meter panel). Forces a
/// compaction pass for the session regardless of the configured threshold —
/// cloud sessions summarize via their own provider, local sessions via the
/// running sidecar. Emits the same status events as the automatic paths so
/// the meter and timeline refresh. Errors when there is nothing to compact.
#[tauri::command]
pub async fn chat_compact_now(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
    local: State<'_, local_models::LocalModelState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> CmdResult<String> {
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };
    let entries: Vec<crate::chat::compaction::CompactionEntry> = {
        let conn = db.0.lock();
        db::list_active_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| crate::chat::compaction::CompactionEntry {
                id: r.id,
                message: ChatMessage {
                    role: r.role,
                    content: strip_think_blocks(&r.content),
                    images: Vec::new(),
                },
            })
            .collect()
    };
    let (custom, attached_c, attached_m): (Option<String>, Vec<String>, Vec<String>) = {
        let conn = db.0.lock();
        let custom =
            db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?;
        let (c, m): (Vec<String>, Vec<String>) =
            db::list_chat_session_connectors(&conn, &chat_session_id)
                .unwrap_or_default()
                .into_iter()
                .partition(|r| !r.starts_with("mcp:"));
        (custom, c, m)
    };
    let attached_m: Vec<String> = attached_m
        .iter()
        .filter_map(|r| r.strip_prefix("mcp:").map(|s| s.to_string()))
        .collect();

    let _ = app.emit(
        "chat:status",
        crate::types::ChatStatusPayload {
            chat_session_id: chat_session_id.clone(),
            reason: "context_compacting".to_string(),
            message: "Compacting earlier context…".to_string(),
        },
    );

    let run = if provider_str == "local_gguf" {
        let Some(status) = local.0.status() else {
            return Err("local model is not running".to_string());
        };
        // Force: a threshold of 0 makes the trigger comparison always fire.
        let mut cfg = {
            let conn = db.0.lock();
            crate::chat::compaction::load_compaction_config(&conn)
        };
        cfg.threshold = 0.0;
        let system = {
            let (avail_c, avail_m) = attach_availability(&app, &attached_c, &attached_m);
            let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
            crate::chat::build_system_prompt(
                ChatProviderId::LocalGguf,
                &model_str,
                custom.as_deref(),
                &[],
                true,
                false,
                false,
                manifest.as_deref(),
            )
            .unwrap_or_default()
        };
        let system = if system.trim().is_empty() { None } else { Some(system) };
        // Honor the summarizer override here too — "Compact now" should
        // produce the same quality the automatic path would.
        let route = match {
            let conn = db.0.lock();
            resolve_cloud_summarizer(&conn)
        } {
            Some((provider_id, base, api_key, cloud_model))
                if {
                    let conn = db.0.lock();
                    db::get_setting(&conn, "chat.local_gguf.compaction_summarizer")
                        .ok()
                        .flatten()
                        .map(|v| v.trim().eq_ignore_ascii_case("cloud"))
                        .unwrap_or(false)
                } =>
            {
                crate::chat::compaction::SummarizerRoute::Cloud {
                    provider_id,
                    base,
                    api_key,
                    model: cloud_model,
                }
            }
            _ => crate::chat::compaction::SummarizerRoute::Sidecar,
        };
        let outcome = crate::chat::compaction::maybe_compact(
            &chat_state.0.client,
            &status.base_url,
            status.n_ctx,
            &model_str,
            &system,
            &entries,
            &cfg,
            0,
            None,
            &route,
        )
        .await?;
        if !outcome.did_compact {
            return Err("nothing to compact yet".to_string());
        }
        crate::chat::cloud_compact::CloudCompactionRun {
            messages: outcome.messages,
            summary_text: outcome.summary_text,
            summary_input_tokens: outcome.summary_input_tokens,
            summary_output_tokens: outcome.summary_output_tokens,
            superseded_ids: outcome.superseded_ids,
            compacted_exchange_count: outcome.compacted_exchange_count,
            pre_tokens: 0,
            post_tokens: 0,
        }
    } else {
        let provider_id = parse_provider_id(&provider_str)
            .ok_or_else(|| format!("unknown provider: {provider_str}"))?;
        let cfg = {
            let conn = db.0.lock();
            crate::chat::cloud_compact::load_cloud_compaction_config(&conn)
        };
        let api_key = {
            let conn = db.0.lock();
            secrets::get_chat_api_key(&conn, &provider_str)
                .ok_or_else(|| format!("no API key configured for provider: {provider_str}"))?
        };
        let base_url = {
            let conn = db.0.lock();
            db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
                .map_err(|e| e.to_string())?
        };
        let base = base_url
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| match provider_id {
                ChatProviderId::OpenRouter => OpenRouterProvider::DEFAULT_BASE.to_string(),
                ChatProviderId::Anthropic => AnthropicProvider::DEFAULT_BASE.to_string(),
                _ => OpenAIProvider::DEFAULT_BASE.to_string(),
            });
        let system = {
            let (avail_c, avail_m) = attach_availability(&app, &attached_c, &attached_m);
            let manifest = crate::chat::prompts::attach_manifest_segment(&avail_c, &avail_m);
            crate::chat::build_system_prompt(
                provider_id,
                &model_str,
                custom.as_deref(),
                &[],
                true,
                false,
                false,
                manifest.as_deref(),
            )
            .unwrap_or_default()
        };
        let system = if system.trim().is_empty() { None } else { Some(system) };
        crate::chat::cloud_compact::run_cloud_compaction(
            &chat_state.0.client,
            provider_id,
            &base,
            &api_key,
            &model_str,
            &system,
            &entries,
            cfg.pin_exchanges,
        )
        .await?
    };

    let summary_id = {
        let conn = db.0.lock();
        crate::chat::cloud_compact::persist_summary_row(&conn, &chat_session_id, &run)
            .map_err(|e| e.to_string())?
    };
    eprintln!(
        "[compact-now] compacted {} exchange(s) into summary row {}",
        run.compacted_exchange_count, summary_id,
    );
    let _ = app.emit(
        "chat:status",
        crate::types::ChatStatusPayload {
            chat_session_id: chat_session_id.clone(),
            reason: "context_compacted".to_string(),
            message: format!(
                "Compacted {} exchange(s) — {} messages now active",
                run.compacted_exchange_count,
                run.messages.len(),
            ),
        },
    );
    Ok(format!(
        "Compacted {} exchange(s)",
        run.compacted_exchange_count
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_think_blocks_removes_think_and_tool_markup() {
        let raw = "<think>reasoning</think>Here is the answer.";
        assert_eq!(strip_think_blocks(raw), "Here is the answer.");

        let with_tool = "<tool>{\"title\":\"Running python code\"}</tool>The result is 42.";
        assert_eq!(strip_think_blocks(with_tool), "The result is 42.");

        let mixed = "<think>plan</think><tool>{\"title\":\"x\"}</tool>Done.<tool>{\"title\":\"y\"}</tool>";
        assert_eq!(strip_think_blocks(mixed), "Done.");

        // Unterminated trailing block (mid-stream) is dropped entirely.
        assert_eq!(strip_think_blocks("Answer.<tool>{\"title\":\"partial"), "Answer.");

        // Plain content is untouched (aside from trimming).
        assert_eq!(strip_think_blocks("  just text  "), "just text");
    }

    #[test]
    fn estimate_tokens_is_chars_over_four_rounded_up() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2); // 5 chars → ceil(1.25) = 2
        assert_eq!(estimate_tokens("    "), 1); // trimmed whitespace still counts
        // Unicode counts by chars, not bytes (10 chars → ceil(2.5) = 3).
        assert_eq!(estimate_tokens("你好你你好你好你好"), 3);
    }

    #[test]
    fn estimate_usage_parts_sums_categories() {
        let msgs = vec![
            ChatMessage { role: "user".into(), content: "abcd".into(), images: Vec::new() },      // 1
            ChatMessage { role: "assistant".into(), content: "abcd".repeat(4).into(), images: Vec::new() }, // 4
        ];
        let (total, sys, msgs_tok, tools) = estimate_usage_parts("abcdabcd", &msgs, "abcd"); // 2 + 1
        assert_eq!(sys, 2);
        assert_eq!(msgs_tok, 5);
        assert_eq!(tools, 1);
        assert_eq!(total, 7);
    }

    #[test]
    fn harness_provider_detection() {
        assert!(is_harness_provider("harness:claude_code"));
        assert!(is_harness_provider("harness:opencode"));
        assert!(is_harness_provider("acp:some-agent"));
        assert!(!is_harness_provider("anthropic"));
        assert!(!is_harness_provider("local_gguf"));
        assert!(!is_harness_provider("harness")); // bare prefix — not a harness id
    }

    #[test]
    fn parse_provider_id_round_trips_known_ids() {
        for s in [
            "anthropic",
            "openai",
            "anthropic_compatible",
            "openai_compatible",
            "openrouter",
            "local_gguf",
        ] {
            assert_eq!(parse_provider_id(s).map(|p| p.as_str()), Some(s));
        }
        assert!(parse_provider_id("harness:claude_code").is_none());
        assert!(parse_provider_id("acp:x").is_none());
    }

    #[test]
    fn meter_model_prefers_harness_actual_model() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        crate::db::set_setting(&conn, "agent.actual_model.claude_code.s1", "claude-opus-4-8")
            .unwrap();
        assert_eq!(
            meter_model_for_session(&conn, "harness:claude_code", "claude-sonnet-4-5", "s1"),
            "claude-opus-4-8"
        );
        // Cloud sessions (and harnesses with no recorded model) use the
        // session's stored id.
        assert_eq!(
            meter_model_for_session(&conn, "anthropic", "claude-sonnet-4-5", "s2"),
            "claude-sonnet-4-5"
        );
        assert_eq!(
            meter_model_for_session(&conn, "harness:claude_code", "claude-sonnet-4-5", "s3"),
            "claude-sonnet-4-5"
        );
    }

    #[test]
    fn meter_model_resolves_through_the_window_registry() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let model = meter_model_for_session(&conn, "harness:claude_code", "claude-sonnet-4-5", "s9");
        let window = crate::chat::context_windows::cloud_window_for_model(&model);
        assert_eq!(window, 200_000);
    }

    #[test]
    fn slugify_command_matches_frontend_rules() {
        // The function lives in `installed_skills`; verify it produces the
        // same slugged names the frontend uses for slash-token matching.
        assert_eq!(crate::installed_skills::slugify("Word documents (.docx)"), "word-documents-docx");
        assert_eq!(crate::installed_skills::slugify("Slide decks (.pptx)"), "slide-decks-pptx");
        assert_eq!(crate::installed_skills::slugify("PDF documents"), "pdf-documents");
        assert_eq!(crate::installed_skills::slugify("  Report — Style!! "), "report-style");
        assert_eq!(crate::installed_skills::slugify("..."), "");
    }

    #[test]
    fn slash_token_matching_is_token_aware() {
        assert!(message_has_slash_token("/docx write a report", "docx"));
        assert!(message_has_slash_token("please /docx this", "docx"));
        assert!(message_has_slash_token("/DOCX", "docx")); // case-insensitive
        assert!(message_has_slash_token("/docx", "docx")); // end of string
        // Must not match as a prefix of a longer token or mid-word.
        assert!(!message_has_slash_token("/docx2 please", "docx"));
        assert!(!message_has_slash_token("see a/docx file", "docx"));
        assert!(!message_has_slash_token("no command here", "docx"));
    }

    #[test]
    fn parse_skills_includes_only_invoked_enabled_skills() {
        // Verify `parse_invoked_skills` correctly applies slash-token
        // matching against the live built-in skill catalog. The four
        // built-in skills (docx, pptx, pdf, diagram) are bundled at compile
        // time, so they always exist regardless of what's on disk.
        //
        // The SkillSnapshot uses the skill's slug as the name (not the
        // human-friendly "Word documents (.docx)" label) because the
        // snapshot schema is the lightweight `(slug, name, body)` triple
        // used for prompt injection.
        let got = parse_invoked_skills("/docx write the report");
        assert_eq!(got.len(), 1, "expected exactly 1 docx skill match, got: {got:?}");
        assert_eq!(got[0].0, "docx", "expected the docx slug, got: {got:?}");

        // No invocation → nothing, even though skills are present.
        assert!(parse_invoked_skills("just a normal question").is_empty());

        // Multiple invocations in one message inject multiple skills.
        let got = parse_invoked_skills("/docx /pdf compare these");
        assert_eq!(got.len(), 2, "expected 2 skills, got: {got:?}");
        let slugs: std::collections::HashSet<&str> = got.iter().map(|(s, _)| s.as_str()).collect();
        assert!(slugs.contains("docx"), "expected docx slug, got: {got:?}");
        assert!(slugs.contains("pdf"), "expected pdf slug, got: {got:?}");
    }

    #[test]
    fn parse_goal_and_loop_builtins_inject_loop_body() {
        // /goal and /loop are built-ins backing the autonomous goal loop. Both
        // must resolve from `parse_invoked_skills` so the model receives the
        // sentinel protocol when the user starts a loop. Either token is enough
        // to inject the body (its "name" is the human-facing label, not the
        // slug), so we assert on the body's content and the match count.
        for slug in ["goal", "loop"] {
            let msg = format!("/{slug} refactor the auth module");
            let got = parse_invoked_skills(&msg);
            assert_eq!(got.len(), 1, "expected 1 {slug} skill, got: {got:?}");
            assert!(
                got[0].1.contains("LOOP_STATUS"),
                "{slug} body should teach the LOOP_STATUS sentinel protocol, got: {:?}",
                got[0].1,
            );
        }
        // Both tokens resolve to the same shared body.
        let g = parse_invoked_skills("/goal");
        let l = parse_invoked_skills("/loop");
        assert_eq!(g.len(), 1);
        assert_eq!(l.len(), 1);
        assert_eq!(g[0].1, l[0].1, "/goal and /loop should share the same skill body");
        // The whole goal text is never required to include the token again —
        // a bare /goal alone also injects.
        assert_eq!(parse_invoked_skills("/goal").len(), 1);
    }
}
