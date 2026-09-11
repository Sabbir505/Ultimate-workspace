//! `commands::api_keys` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- API key management ----

/// Store the chat API key in the OS keychain, and provider config in app_settings.
/// The key value is NEVER returnable via any IPC command.
///
/// When `key` is empty but the provider already has a stored key, the keychain
/// entry is left untouched — only settings (base_url, model) are updated. This
/// allows model-only / baseUrl-only changes without re-entering the key. When
/// `key` is non-empty, it replaces the stored keychain entry. When both `key`
/// is empty AND no key exists for this provider, we reject (nothing to save).
#[tauri::command(async)]
pub fn set_chat_api_key(
    provider: String,
    key: String,
    base_url: Option<String>,
    model: Option<String>,
    db: State<'_, DbState>,
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
        db::set_setting(&conn, &format!("chat.{provider}.model"), &m).map_err(|e| e.to_string())?;
    }
    // Remember the provider the user last configured so the app reopens on it
    // instead of falling back to the hardcoded priority order. See get_chat_config.
    db::set_setting(&conn, "chat.active_provider", &provider).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn delete_chat_api_key(provider: String, db: State<'_, DbState>) -> CmdResult<()> {
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
#[tauri::command(async)]
pub fn set_chat_default_model(
    provider: String,
    model: String,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("provider must not be empty".to_string());
    }
    let conn = db.0.lock();
    db::set_setting(&conn, &format!("chat.{provider}.model"), &model).map_err(|e| e.to_string())
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
#[tauri::command(async)]
pub fn get_chat_config(
    provider: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<ChatConfigPayload> {
    let conn = db.0.lock();
    match provider {
        Some(p) => {
            let base_url =
                db::get_setting(&conn, &format!("chat.{p}.base_url")).map_err(|e| e.to_string())?;
            let model =
                db::get_setting(&conn, &format!("chat.{p}.model")).map_err(|e| e.to_string())?;
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
            if let Some(active) =
                db::get_setting(&conn, "chat.active_provider").map_err(|e| e.to_string())?
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

    fetch_models_list(&provider, base, key).await
}

