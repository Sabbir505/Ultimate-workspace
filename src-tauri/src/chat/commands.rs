//! Chat mode IPC command handlers (CONTRACT.md "Chat" section).

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use tauri::{AppHandle, State};

use crate::chat::providers::*;
use crate::chat::local_models;
use crate::db;
use crate::secrets;
use crate::types::*;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

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
    db: State<DbState>,
) -> CmdResult<ChatSession> {
    let conn = db.0.lock();
    db::create_chat_session(&conn, &provider, &model).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_session(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
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

/// Update a chat session's filesystem permission posture
/// (`read_only` | `manual` | `auto_edit` | `full_auto`). Per-session: persists
/// so reopening a chat restores its last mode; new sessions start at `manual`.
/// The frontend gates the switch to `full_auto` behind a one-time confirmation
/// modal — this command itself is a plain setter, applied only after the user
/// confirms (or for the other three modes, immediately).
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

/// One-shot (non-streaming) OpenAI-style completion returning the message text.
async fn openai_oneshot(
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
async fn anthropic_oneshot(
    client: &reqwest::Client,
    api_key: &str,
    base: &str,
    model: &str,
    system: &str,
    user: &str,
) -> CmdResult<String> {
    let url = format!("{base}/v1/messages");
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 32,
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
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };

    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    // local_gguf is keyless (runs locally); skip the key check and pass
    // an empty string as the key (the sidecar ignores the auth header).
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

    // Build a compact transcript from history (length-capped).
    let transcript = {
        let conn = db.0.lock();
        let records = db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?;
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
            anthropic_oneshot(&client, &api_key, base, &model, system, &user).await?
        }
        "anthropic_compatible" => {
            let Some(base) = base_url.as_deref() else {
                return Ok(None);
            };
            anthropic_oneshot(&client, &api_key, base, &model, system, &user).await?
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
    db: State<DbState>,
) -> CmdResult<Vec<ChatMessageRecord>> {
    let conn = db.0.lock();
    db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())
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
    // 1. Look up the session — provider/model + the per-session permission
    //    posture for filesystem tools (read at turn start so it governs this
    //    turn's tool schema/approval logic).
    let (provider_str, model_str, permission_mode_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model, cs.permission_mode)
    };
    let permission_mode = crate::chat::permission::PermissionMode::from_db(&permission_mode_str);

    // Connectors attached to THIS conversation (per-session opt-in, persisted
    // in chat_session_connectors — read at turn start, like permission_mode).
    // They're connected inside the spawned tool loop (see ChatManager::send);
    // here we just resolve the id list.
    let connector_ids: Vec<String> = {
        let conn = db.0.lock();
        db::list_chat_session_connectors(&conn, &chat_session_id).unwrap_or_default()
    };

    // 2. Persist the user message.
    {
        let conn = db.0.lock();
        db::add_chat_message(&conn, &chat_session_id, "user", &content, None, None, None)
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
    // Per-session model wins; the Settings model is only a default for
    // sessions created without one.
    let model = if model_str.trim().is_empty() {
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
    let system = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .map_err(|e| e.to_string())?;
        let skills_json = db::get_setting(&conn, "assistant.skills")
            .map_err(|e| e.to_string())?;
        let skills = parse_skills(skills_json.as_deref(), &content);
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
    let mut messages = {
        let conn = db.0.lock();
        let records = db::list_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?;
        records
            .into_iter()
            .map(|r| ChatMessage {
                role: r.role,
                // Thinking blocks are for display only — never re-sent.
                content: strip_think_blocks(&r.content),
                images: Vec::new(),
            })
            .collect::<Vec<_>>()
    };
    // Attach this turn's images to the just-persisted user message so they are
    // sent as vision content. Images are not persisted, so they only apply to
    // the live turn (not to regenerated/older turns).
    if !images.is_empty() {
        if let Some(last) = messages.last_mut() {
            if last.role == "user" {
                last.images = images;
            }
        }
    }

    let shared_db = Arc::clone(&db.0);
    // Granted filesystem roots: there is no granted-roots UI yet (the
    // filesystem task's roots model is out of scope for the selector), so we
    // start empty — auto-run modes gate every write outside the (empty) set
    // until roots are granted. The selector only changes approval *defaults*
    // within granted roots; it never expands reachability.
    let fs_roots: Vec<String> = Vec::new();
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
    );

    Ok(())
}

/// Parse the persisted skills setting (`assistant.skills`) — a JSON array of
/// `{ name, command?, content, enabled }` — into `(name, content)` pairs for
/// the skills the user actually INVOKED in this message. A skill is included
/// only when its slash token (`/command`, falling back to the slugified name)
/// appears as a standalone token in the message. Previously every enabled
/// skill was inlined on every turn (~7k tokens with all defaults); invoked-only
/// injection keeps every other turn's system prompt lean. Mirrors the frontend
/// rules in `src/lib/skillCommands.ts` — keep them in sync.
fn parse_skills(json: Option<&str>, message: &str) -> Vec<(String, String)> {
    let Some(raw) = json else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter(|s| s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
        .filter_map(|s| {
            let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            let content = s.get("content").and_then(|v| v.as_str()).unwrap_or("").trim();
            if content.is_empty() {
                return None;
            }
            let command = s
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .trim_start_matches('/');
            let token = if command.is_empty() {
                slugify_command(name)
            } else {
                command.to_lowercase()
            };
            if token.is_empty() || !message_has_slash_token(message, &token) {
                return None;
            }
            let name = if name.is_empty() { "Skill" } else { name };
            Some((name.to_string(), content.to_string()))
        })
        .collect()
}

/// Derive a slash token from a skill name: lowercase, runs of
/// non-alphanumerics collapse to `-`, edges trimmed.
/// "Word documents (.docx)" → "word-documents-docx".
fn slugify_command(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;
    for ch in name.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
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

/// Standard base64 encode (no external crate).
fn base64_encode(data: &[u8]) -> String {
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
/// Office documents (docx/pptx/xlsx) are extracted to HTML (kind = `office`);
/// anything else returns metadata only (rendered as a file card).
#[tauri::command]
pub fn read_artifact_preview(path: String) -> CmdResult<ArtifactPreview> {
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
        "js" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h" | "hpp"
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
        let bytes = std::fs::read(p).map_err(|e| format!("cannot read file: {e}"))?;
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
            size,
            truncated,
        });
    }

    if (is_image || is_pdf) && size <= MAX_MEDIA {
        let bytes = std::fs::read(p).map_err(|e| format!("cannot read file: {e}"))?;
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
            size,
            truncated: false,
        });
    }

    // Office documents: render to faithful, self-contained HTML (colours,
    // fonts, tables, slide layouts) shown in a sandboxed iframe (kind = office).
    if matches!(ext.as_str(), "docx" | "pptx" | "xlsx") && size <= MAX_MEDIA {
        if let Ok(bytes) = std::fs::read(p) {
            let html = match ext.as_str() {
                "docx" => crate::chat::office::docx_to_html(&bytes),
                "pptx" => crate::chat::office::pptx_to_html(&bytes),
                "xlsx" => crate::chat::office::xlsx_to_html(&bytes),
                _ => None,
            };
            if let Some(html) = html {
                return Ok(ArtifactPreview {
                    path,
                    filename,
                    ext,
                    kind: "office".to_string(),
                    text: Some(html),
                    data_uri: None,
                    size,
                    truncated: false,
                });
            }
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
        size,
        truncated: false,
    })
}

// ---- Artifact download ----

/// Copy a generated artifact to a user-chosen destination path (the frontend
/// gets `dest` from a save dialog).
#[tauri::command]
pub fn download_artifact(src: String, dest: String) -> CmdResult<()> {
    std::fs::copy(&src, &dest).map_err(|e| format!("could not save file: {e}"))?;
    Ok(())
}

/// Zip several artifacts into a user-chosen destination `.zip` path. Duplicate
/// filenames are disambiguated with a numeric suffix.
#[tauri::command]
pub fn download_artifacts_zip(paths: Vec<String>, dest: String) -> CmdResult<()> {
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
        let seen: std::collections::HashSet<String> =
            files.iter().map(|f| f.id.clone()).collect();
        // Load persisted user-added folders and scan each, deduping by file id.
        let stored = {
            let conn = db.0.lock();
            db::get_setting(&conn, "localModels.folders")
        };
        if let Ok(Some(json)) = stored {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
                for f in list.into_iter().filter(|s| !s.trim().is_empty()) {
                    for file in local_models::scan_folder(Path::new(&f), "user") {
                        if seen.contains(&file.id) {
                            continue;
                        }
                        files.push(file);
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
        base_url: a.base_url,
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
        assert_eq!(slugify_command("Word documents (.docx)"), "word-documents-docx");
        assert_eq!(slugify_command("Slide decks (.pptx)"), "slide-decks-pptx");
        assert_eq!(slugify_command("PDF documents"), "pdf-documents");
        assert_eq!(slugify_command("  Report — Style!! "), "report-style");
        assert_eq!(slugify_command("..."), "");
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
        let json = r#"[
            {"name": "Word documents (.docx)", "command": "docx", "content": "DOCX rules", "enabled": true},
            {"name": "PDF documents", "command": "pdf", "content": "PDF rules", "enabled": true},
            {"name": "Slides", "content": "PPTX rules", "enabled": true},
            {"name": "Hidden", "command": "hidden", "content": "off", "enabled": false},
            {"name": "Empty", "command": "empty", "content": "  ", "enabled": true}
        ]"#;

        // Explicit command token invokes; everything else is excluded.
        let got = parse_skills(Some(json), "/docx write the report");
        assert_eq!(got, vec![("Word documents (.docx)".to_string(), "DOCX rules".to_string())]);

        // Slugified-name fallback works when no explicit command is set.
        let got = parse_skills(Some(json), "/slides for the board meeting");
        assert_eq!(got, vec![("Slides".to_string(), "PPTX rules".to_string())]);

        // No invocation → nothing, even though skills are enabled.
        assert!(parse_skills(Some(json), "just a normal question").is_empty());

        // Disabled skills never inject, even when invoked.
        assert!(parse_skills(Some(json), "/hidden please").is_empty());

        // Multiple invocations in one message inject multiple skills.
        let got = parse_skills(Some(json), "/docx /pdf compare these");
        assert_eq!(got.len(), 2);
    }
}
