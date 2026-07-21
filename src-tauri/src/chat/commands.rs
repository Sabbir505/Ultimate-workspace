//! Chat mode IPC command handlers (CONTRACT.md "Chat" section).

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::chat::providers::*;
use crate::db;
use crate::secrets;
use crate::types::*;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

// ---- Chat session CRUD ----

/// Removes `<think>…</think>` reasoning blocks (display-only) from a message
/// before it is sent back to the API as conversation history.
fn strip_think_blocks(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
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

#[tauri::command]
pub fn update_chat_session_title(
    chat_session_id: String,
    title: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_title(&conn, &chat_session_id, &title).map_err(|e| e.to_string())
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

/// Persists the user message, looks up provider/model/api_key/base_url for the
/// session, assembles messages from history, and kicks off streaming.
#[tauri::command]
pub async fn send_chat_message(
    chat_session_id: String,
    content: String,
    effort: Option<String>,
    tools_enabled: Option<bool>,
    code_exec_enabled: Option<bool>,
    chat_state: State<'_, crate::ChatState>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<()> {
    let chat_mgr = &chat_state.0;
    // 1. Look up the session.
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
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
        other => return Err(format!("unknown provider: {other}")),
    };

    // 4. Load API key from keychain.
    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    }
    .ok_or_else(|| format!("no API key configured for provider: {provider_str}"))?;

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

    // 6. Build message history from DB.
    let messages = {
        let conn = db.0.lock();
        let records = db::list_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?;
        records
            .into_iter()
            .map(|r| ChatMessage {
                role: r.role,
                // Thinking blocks are for display only — never re-sent.
                content: strip_think_blocks(&r.content),
            })
            .collect::<Vec<_>>()
    };

    let shared_db = Arc::clone(&db.0);
    chat_state.0.send(
        chat_session_id,
        provider_id,
        model,
        api_key,
        base_url,
        effort,
        tools_enabled.unwrap_or(false),
        code_exec_enabled.unwrap_or(false),
        messages,
        shared_db,
        app,
    );

    Ok(())
}

#[tauri::command]
pub fn cancel_chat_message(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<()> {
    chat_state.0.cancel(&chat_session_id);
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
    if !key.trim().is_empty() {
        // User provided a new key — store it in the OS keychain.
        secrets::set_chat_api_key(&conn, &provider, &key)?;
    }
    // If key is empty and no existing key, we still allow saving base_url/model
    // so the user can set up the config before entering the key.
    // The key can be added later.

    if let Some(url) = base_url {
        db::set_setting(&conn, &format!("chat.{provider}.base_url"), &url)
            .map_err(|e| e.to_string())?;
    }
    if let Some(m) = model {
        db::set_setting(&conn, &format!("chat.{provider}.model"), &m)
            .map_err(|e| e.to_string())?;
    }
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
    Ok(())
}

/// Returns non-secret config only — the API key value is NEVER returned.
///
/// When `provider` is None, scans all providers in priority order and returns
/// config for the FIRST one that has a stored key (so the UI can pre-fill the
/// correct provider/model/baseUrl). The `has_key` field tells the API Keys
/// panel whether Save is allowed without re-entering the key.
#[tauri::command]
pub fn get_chat_config(provider: Option<String>, db: State<DbState>) -> CmdResult<ChatConfigPayload> {
    let conn = db.0.lock();
    match provider {
        Some(p) => {
            let base_url = db::get_setting(&conn, &format!("chat.{p}.base_url"))
                .map_err(|e| e.to_string())?;
            let model = db::get_setting(&conn, &format!("chat.{p}.model"))
                .map_err(|e| e.to_string())?;
            let has_key = secrets::has_chat_api_key(&conn, &p);
            Ok(ChatConfigPayload {
                provider: Some(p),
                base_url,
                model,
                has_key,
            })
        }
        None => {
            for p in ["anthropic", "openai", "anthropic_compatible", "openai_compatible"] {
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
    use reqwest;

    // Resolve base_url: prefer the passed argument, then the stored setting.
    let base = match base_url {
        Some(url) if !url.trim().is_empty() => url,
        _ => {
            let conn = db.0.lock();
            db::get_setting(&conn, &format!("chat.{provider}.base_url"))
                .map_err(|e| e.to_string())?
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
        "openai_compatible" => req.header("Authorization", format!("Bearer {key}")),
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