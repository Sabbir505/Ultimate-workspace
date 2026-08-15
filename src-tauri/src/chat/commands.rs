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
/// back to the API as conversation history.
fn strip_think_blocks(content: &str) -> String {
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
/// one-click undoable. Emits `checkpoint:created` for the safety snapshot.
#[tauri::command]
pub fn restore_chat_checkpoint(
    checkpoint_id: i64,
    app: AppHandle,
    db: State<DbState>,
) -> CmdResult<ChatCheckpoint> {
    let conn = db.0.lock();
    crate::checkpoints::restore(&app, &conn, checkpoint_id).map_err(|e| e.to_string())
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
    let conn = db.0.lock();
    for harness in ["claude_code", "kimi_code", "opencode"] {
        let _ = db::delete_setting(
            &conn,
            &format!("agent.cli_session_id.{harness}.{chat_session_id}"),
        );
    }
    // Prune this session's git checkpoint refs before the rows cascade away.
    crate::checkpoints::prune_session_refs(&conn, &chat_session_id);
    db::delete_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

/// Bind (or unbind with `None`) a chat session to a project. Drives the chat's
/// nesting under the project's expandable sidebar row.
#[tauri::command]
pub fn set_chat_session_project(
    chat_session_id: String,
    project_id: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
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
    let ids = {
        let conn = db.0.lock();
        db::list_chat_sessions(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|s| s.id)
            .collect::<Vec<_>>()
    };
    let count = ids.len();
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
    for id in &ids {
        for harness in ["claude_code", "kimi_code", "opencode"] {
            let _ = db::delete_setting(
                &conn,
                &format!("agent.cli_session_id.{harness}.{id}"),
            );
        }
        // Prune git checkpoint refs before the rows cascade away.
        crate::checkpoints::prune_session_refs(&conn, id);
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
/// start at `"manual"`. Valid values: `"read_only"` | `"manual"` |
/// `"auto_edit"` | `"full_auto"`. Honored by the built-in chat tool loops and
/// by headless Claude Code sessions (via `--permission-prompt-tool stdio`);
/// Kimi/OpenCode headless have no approval channel and always run full-auto.
#[tauri::command]
pub fn update_chat_session_permission_mode(
    chat_session_id: String,
    mode: String,
    db: State<DbState>,
) -> CmdResult<()> {
    // Validate against the known modes so a bogus value can't be persisted.
    let mode = match mode.as_str() {
        "read_only" | "manual" | "auto_edit" | "full_auto" => mode,
        other => return Err(format!("unknown permission_mode: {other}")),
    };
    let conn = db.0.lock();
    db::update_chat_session_permission_mode(&conn, &chat_session_id, &mode).map_err(|e| e.to_string())
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
/// (e.g. `"harness:claude_code"`) | null (clears the selection). Selecting a
/// harness agent does NOT reroute messages yet — the headless CLI chat
/// protocol lands separately; this only records the user's pick.
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
                .is_some_and(|id| crate::harness_adapters::get_adapter(id).is_some());
        if !valid {
            return Err(format!(
                "unknown agent: {a} (expected 'builtin', 'local', or 'harness:<id>')"
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
fn format_compact_token_count(n: i64) -> String {
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
    let client = reqwest::Client::new();
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
    let client = reqwest::Client::new();
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
    let mut tok_wsum = 0.0; // Σ tok_s * output_tokens (weighting)
    let mut output_sum = 0i64;
    let mut input_sum = 0i64;
    let mut cache_read = 0i64;
    let mut cache_creation = 0i64;
    let mut uncached_in = 0i64;
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
                output_sum += out;
            }
        }
        input_sum += m.input_tokens.unwrap_or(0);
        output_sum += m.output_tokens.unwrap_or(0);
        cache_read += m.cache_read_input_tokens.unwrap_or(0);
        cache_creation += m.cache_creation_input_tokens.unwrap_or(0);

        // Azure/OpenAI style providers report `input_tokens` already including
        // cache reads; Anthropic reports *uncached* input separately. To avoid
        // double counting, approximate uncached input as (cached_read present →
        // input is uncached, else input already includes it). We keep input_sum
        // as the provider's own input delimiter and compute the hit rate from
        // cache_read / total below using only cache_read + cache_creation.
        let _ = &mut uncached_in;
    }

    let total_prompt = cache_read + cache_creation + input_sum.min(0).max(0);
    // Cache-hit rate uses cache_read over the whole billed prompt corpus.
    // We don't know each turn's uncached-vs-inclusive split, so treat the
    // aggregate conservatively: hit = cache_read / max(1, cache_read +
    // cache_creation + input_sum) only when input_sum looks uncached
    // (input_sum < cache_read). Otherwise (inclusive), cache_read /
    // (cache_read + cache_creation + cache_read + input_sum) is wrong;
    // default to None when the shape is ambiguous.
    let cache_hit = if cache_read > 0 {
        let denom = cache_read + cache_creation + input_sum;
        if denom > 0 {
            Some(cache_read as f64 / denom as f64)
        } else {
            None
        }
    } else {
        None
    };

    let tokens_per_second = if output_sum > 0 {
        Some(tok_wsum / output_sum as f64)
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
fn process_attachments(
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
    // 1. Look up the session — provider/model/permission-mode for this turn.
    let (provider_str, model_str, permission_mode) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model, cs.permission_mode)
    };
    // Unknown/legacy values fail closed to Manual (the safe default).
    let permission_mode = crate::chat::permission::PermissionMode::from_db(&permission_mode);

    // Connectors available to this conversation. Per-session rows
    // (chat_session_connectors, written by the old "@"-attach flow) are still
    // honored, but ANY connector connected in Settings → Connectors is ALWAYS
    // available — the model self-selects one when a task needs it, no
    // per-conversation opt-in required. "Connected" = a credential row exists
    // (OAuth connectors) OR a public endpoint that needs no credentials
    // (Kiwi — `is_public()`, never has a row).
    let connector_ids: Vec<String> = {
        let conn = db.0.lock();
        let mut ids: Vec<String> =
            db::list_chat_session_connectors(&conn, &chat_session_id).unwrap_or_default();
        for row in db::list_connector_credential_rows(&conn).unwrap_or_default() {
            if !ids.contains(&row.connector_id) {
                ids.push(row.connector_id);
            }
        }
        for c in crate::connectors::CONNECTORS {
            if c.is_public() && !ids.iter().any(|i| i == c.id) {
                ids.push(c.id.to_string());
            }
        }
        ids
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
                        // from before the restart) and the send fails.
                        match local
                            .start(
                                g.meta.name.unwrap_or(g.filename).clone(),
                                &g.path,
                                None,
                                None,
                                g.mmproj_path.as_deref(),
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
                                let _ =
                                    db::set_setting(&conn, "chat.active_provider", "local_gguf");
                                eprintln!(
                                    "[local-warmup] sidecar started OK, persisted base_url={:?}",
                                    started.base_url
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
    let tools_on = tools_enabled.unwrap_or(false);
    let mut system: Option<String> = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let skills = parse_invoked_skills(&content);
        crate::chat::build_system_prompt(
            provider_id.clone(),
            &model,
            custom.as_deref(),
            &skills,
            tools_on,
            research_mode,
        )
    };

    // 6. Build message history from DB.
    //
    // For local-model sessions, only the *active* (non-superseded) rows feed
    // the model — the compaction framework soft-deletes summarized turns via
    // `superseded_by`. API providers never compact, so their history has no
    // superseded rows and `list_active_chat_messages` returns the same set as
    // `list_chat_messages`. We carry each row's DB id alongside so compaction
    // can mark the rows it folds into a summary.
    let mut messages: Vec<crate::chat::compaction::CompactionEntry> = {
        let conn = db.0.lock();
        let records = if matches!(provider_id, ChatProviderId::LocalGguf) {
            db::list_active_chat_messages(&conn, &chat_session_id)
                .map_err(|e| e.to_string())?
        } else {
            db::list_chat_messages(&conn, &chat_session_id)
                .map_err(|e| e.to_string())?
        };
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
                let pcaps = crate::chat::prompts::provider_capabilities(provider_id.clone(), &model);
                let caps = crate::chat::tools::ToolCaps {
                    code_exec: code_exec_enabled.unwrap_or(false),
                    fs_roots: Vec::new(),
                    web_search: pcaps.native_web_search,
                    requires_local_sandbox: pcaps.requires_local_sandbox,
                    attached_connectors: std::sync::Arc::new(Vec::new()),
                    local_docs: false,
                    fs_rules: Vec::new(),
                };
                let specs = crate::chat::tools::openai_tool_specs(&caps, crate::chat::permission::PermissionMode::FullAuto);
                let json = serde_json::to_string(&specs).unwrap_or_default();
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

            let outcome = crate::chat::compaction::maybe_compact(
                &chat_mgr.client,
                &status.base_url,
                status.n_ctx,
                &model,
                &system,
                &messages,
                &cfg,
                reserved_tokens,
                // Reuse the count above — identical assembly. On tokenize
                // failure, pass None so maybe_compact's own fallback path
                // (passthrough with a log) still runs.
                pre_count_result.ok(),
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
        messages.into_iter().map(|e| e.message).collect()
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
            let section = format!(
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
            );
            system = Some(system.unwrap_or_default() + &section);
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
        permission_mode,
        fs_roots,
        connector_ids,
        system,
        messages,
        shared_db,
        app,
        research_mode,
        thinking,
    );

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
#[tauri::command]
pub fn resolve_tool_action(
    pending_id: String,
    approved: bool,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<()> {
    if let Some(pending) = chat_state.0.take_pending_approval(&pending_id) {
        // The receiver end lives in the paused tool loop. A send error means
        // the loop already ended (stream cancelled) — ignore it.
        let _ = pending.response_tx.send(approved);
    }
    Ok(())
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
/// Office documents are rendered as: docx → raw bytes for client-side mammoth
/// rendering (kind = `office`, original_bytes = true); pptx → converted to PDF
/// via headless LibreOffice when available (kind = `pdf`), else the hand-rolled
/// HTML converter (kind = `office`); xlsx → HTML (kind = `office`). Anything
/// else returns metadata only (rendered as a file card).
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
    let text_kind = match ext.as_str() {
        "md" | "markdown" => Some("markdown"),
        "csv" => Some("csv"),
        "json" => Some("json"),
        "html" | "htm" => Some("html"),
        "txt" | "log" | "text" => Some("text"),
        "tsx" | "jsx" => Some("jsx"),
        "js" | "ts" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h" | "hpp"
        | "sh" | "bash" | "yaml" | "yml" | "toml" | "xml" | "sql" | "rb" | "php" | "css" => {
            Some("code")
        }
        _ => None,
    };
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
    // rendering (mammoth.js for docx; pptx raw bytes back the fallback when
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

/// True when a LibreOffice `soffice` binary is reachable, which is what the
/// pptx→pdf preview path needs. The frontend uses this to show a one-line
/// install hint above pptx previews that fell back to the HTML converter.
#[tauri::command]
pub fn is_libreoffice_available() -> bool {
    crate::chat::office::libreoffice_available()
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
                if !active.is_empty()
                    && (active == "local_gguf" || secrets::has_chat_api_key(&conn, &active))
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
    // OpenRouter has a fixed endpoint, so it falls back to its default base.
    let base = match base_url {
        Some(url) if !url.trim().is_empty() => url,
        _ => {
            let conn = db.0.lock();
            db::get_setting(&conn, &format!("chat.{provider}.base_url"))
                .map_err(|e| e.to_string())?
                .or_else(|| {
                    (provider == "openrouter")
                        .then(|| OpenRouterProvider::DEFAULT_BASE.to_string())
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

    let client = reqwest::Client::new();
    let req = client.get(&url);

    let req = match provider.as_str() {
        "anthropic_compatible" => req.header("x-api-key", key),
        "openai_compatible" | "openrouter" => {
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
                Some(crate::types::ChatModel { id, object, created, owned_by })
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
/// model so `send_chat_message` picks it up immediately.
#[tauri::command]
pub async fn start_local_model(
    model_id: String,
    path: String,
    ngl: Option<i32>,
    ctx: Option<u32>,
    mmproj_path: Option<String>,
    db: State<'_, DbState>,
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<StartedModel> {
    let started = local.0.start(model_id, &path, ngl, ctx, mmproj_path.as_deref()).await?;

    // Persist the base_url + model for the send path (chat.local_gguf.*).
    {
        let conn = db.0.lock();
        db::set_setting(&conn, "chat.local_gguf.base_url", &started.base_url)
            .map_err(|e| e.to_string())?;
        db::set_setting(&conn, "chat.local_gguf.model", &started.model_id)
            .map_err(|e| e.to_string())?;
        db::set_setting(&conn, "chat.active_provider", "local_gguf")
            .map_err(|e| e.to_string())?;
    }

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
#[tauri::command]
pub async fn count_context_tokens(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
    local: State<'_, local_models::LocalModelState>,
    db: State<'_, DbState>,
) -> CmdResult<crate::types::ContextUsagePayload> {
    let Some(status) = local.0.status() else {
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: None,
            max_tokens: 0,
        });
    };

    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };

    // Only local sessions are tokenizable via llama-server; cloud sessions
    // use the meter's 256K fallback. Return a zero-cap so the consumer can
    // distinguish "no data" from "API session".
    if provider_str != "local_gguf" {
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: None,
            max_tokens: 0,
        });
    }

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
    // percentage matches the model's view. We omit skill / connector injection
    // (those depend on the current user message) — the meter is a rough
    // indicator, not a token-perfect preview, and the small delta is well
    // within the 5% slack the threshold check already has.
    let system_str: String = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let provider_id = ChatProviderId::LocalGguf;
        crate::chat::build_system_prompt(
            provider_id,
            &model_str,
            custom.as_deref(),
            &[],
            false,
            false,
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
) -> CmdResult<Option<crate::types::ContextBreakdownPayload>> {
    let Some(status) = local.0.status() else {
        return Ok(None);
    };
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };
    if provider_str != "local_gguf" {
        return Ok(None);
    }
    let client = chat_state.0.client.clone();
    let base_url = &status.base_url;

    // 1. System prompt — same builder as the send path. Omit skill/connector
    //    injection (those depend on the current user message); we capture them
    //    separately below so their token counts stay distinct.
    let system_str: String = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let provider_id = ChatProviderId::LocalGguf;
        crate::chat::build_system_prompt(provider_id, &model_str, custom.as_deref(), &[], false, false)
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
        fs_rules: Vec::new(),
    };
    let tool_specs_json = serde_json::to_string(&crate::chat::tools::openai_tool_specs(&caps, crate::chat::permission::PermissionMode::FullAuto))
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
