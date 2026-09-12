//! `commands::send` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- Send / cancel ----

/// Turn composer attachments into (extra message text, vision images). Text
/// files and extracted document text are appended to the message body so they
/// persist in history; images are collected separately to be sent as vision
/// content on the live turn (a short placeholder is added to the body text).
pub(crate) fn process_attachments(attachments: &[ChatAttachmentInput]) -> (String, Vec<ChatImage>) {
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
/// Fetch + parse a provider's `/v1/models` list — shared by the
/// `list_chat_models` command and the auto-router's snapshot gathering.
/// `base`/`key` are pre-resolved (the command resolves arg → setting →
/// provider default → keychain; the resolver resolves setting → provider
/// default → keychain).
pub(crate) async fn fetch_models_list(
    provider: &str,
    base: String,
    key: String,
) -> Result<Vec<crate::types::ChatModel>, String> {
    use reqwest;

    let url = format!("{base}/v1/models");

    // B-10: these are one-shot JSON calls — a total timeout is safe here and
    // bounds a wedged endpoint instead of hanging the async command forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let req = client.get(&url);

    let req = match provider {
        "anthropic" | "anthropic_compatible" => req
            .header("x-api-key", &key)
            .header("anthropic-version", ANTHROPIC_API_VERSION),
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
            eprintln!(
                "[list_chat_models] Raw response (first 500 chars): {}",
                &body_text.chars().take(500).collect::<String>()
            );
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
    let models: Vec<crate::types::ChatModel> =
        if let Some(data) = json.get("data").and_then(|v| v.as_array()) {
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

/// Public alias for the mobile relay path (mobile/session_chat.rs), which
/// holds the DB Arc directly instead of a Tauri State. Currently unused on
/// the mobile side (its WS dispatch is sync and resolves via the health-aware
/// scan instead) — kept as the extension point.
#[allow(dead_code)]
pub async fn gather_auto_snapshots_arc(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Vec<crate::chat::auto_router::ProviderSnapshot> {
    gather_auto_snapshots(db).await
}

/// Resolve the concrete (provider, model) an Auto-mode chat should use right
/// now — the same health/bias/sticky-aware resolver the send path runs, for
/// non-send LLM callers (artifact generation). A fresh Auto chat stores
/// provider/model as "auto"/"auto" until its first send resolves and writes
/// the pick back; `/create` in such a chat used to read provider "auto" as an
/// OpenAI-shaped endpoint and die with a 401 from api.openai.com.
///
/// `sticky` semantics match the send path: concrete row values (from a
/// previous resolution) prefer the same pick while it stays eligible.
pub(crate) async fn resolve_auto_session_pick(
    db: &DbState,
    provider: &str,
    model: &str,
    prompt_tokens: u64,
    needs_vision: bool,
) -> Result<(String, String), String> {
    let sticky = if provider != "auto" || model != "auto" {
        Some((provider.to_string(), model.to_string()))
    } else {
        None
    };
    let bias_setting = {
        let conn = db.0.lock();
        db::get_setting(&conn, "chat.auto.bias").ok().flatten()
    };
    let snapshots = gather_auto_snapshots(&db.0).await;
    let chain = crate::chat::auto_router::resolve(
        &snapshots,
        &crate::chat::auto_router::AutoQuery {
            prompt_tokens,
            needs_vision,
            sticky,
            bias: crate::chat::auto_router::Bias::from_setting(bias_setting.as_deref()),
        },
    )?;
    let pick = &chain[0];
    Ok((pick.provider.clone(), pick.model.clone()))
}

/// Per-provider config snapshot gathered under one DB lock for the auto
/// router (see gather_auto_snapshots).
pub(super) struct AutoProviderCfg {
    id: &'static str,
    has_key: bool,
    base: Option<String>,
    key: String,
    preferred: Option<String>,
    /// (model id, persisted context window) — the curated list.
    curated: Option<Vec<crate::chat::auto_router::ModelEntry>>,
    /// Active provider-level health exclusion (dead key / out of credit) —
    /// from chat/model_health.rs.
    excluded_reason: Option<String>,
    /// True when the provider's /v1/models endpoint requires a valid key — a
    /// successful fetch there re-proves the key and clears a key-invalid
    /// exclusion. OpenRouter's models list is public and proves nothing.
    endpoint_validates_key: bool,
}

/// Gather everything the auto router needs per candidate provider: key
/// presence (keychain), the provider's persisted default model, the user's
/// curated model list (`chat.<provider>.selected_models` — wins over the
/// live list when present, exactly like the picker's), and a live
/// `/v1/models` fetch per keyed provider. Fetches run CONCURRENTLY so one
/// dead endpoint can't serialize the resolution (the Open WebUI failure
/// mode); a provider whose fetch fails comes through as `Err` and is skipped
/// by the resolver rather than failing the turn.
pub(super) async fn gather_auto_snapshots(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Vec<crate::chat::auto_router::ProviderSnapshot> {
    use crate::chat::auto_router::{ModelEntry, ProviderSnapshot, AUTO_PROVIDERS};

    // Everything touchable under the DB lock is read up front — the lock
    // must never be held across the awaits below.
    let now = crate::db::now_ts();
    let cfgs: Vec<AutoProviderCfg> = {
        let conn = db.lock();
        AUTO_PROVIDERS
            .iter()
            .map(|p| {
                let base = db::get_setting(&conn, &format!("chat.{p}.base_url"))
                    .ok()
                    .flatten();
                let key = secrets::get_chat_api_key(&conn, p).unwrap_or_default();
                let preferred = db::get_setting(&conn, &format!("chat.{p}.model"))
                    .ok()
                    .flatten();
                let curated: Option<Vec<ModelEntry>> =
                    db::get_setting(&conn, &format!("chat.{p}.selected_models"))
                        .ok()
                        .flatten()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        .and_then(|v| serde_json::from_value::<Vec<serde_json::Value>>(v).ok())
                        .map(|list| {
                            list.iter()
                                .filter_map(|e| {
                                    let id = e.get("id")?.as_str()?.to_string();
                                    let context_window = e
                                        .get("contextWindow")
                                        .and_then(|w| w.as_u64())
                                        .filter(|w| *w > 0);
                                    Some(ModelEntry { id, context_window })
                                })
                                .collect()
                        })
                        .filter(|l: &Vec<ModelEntry>| !l.is_empty());
                let excluded_reason = crate::chat::model_health::provider_excluded(&conn, p, now);
                AutoProviderCfg {
                    id: p,
                    has_key: !key.is_empty(),
                    base,
                    key,
                    preferred,
                    curated,
                    excluded_reason,
                    // First-party keyed endpoints 401 on /v1/models with a
                    // bad key; OpenRouter's is public.
                    endpoint_validates_key: *p != "openrouter",
                }
            })
            .collect()
    };

    let fetches = cfgs.into_iter().map(|cfg| async move {
        // Health-aware fetch: drop models cooling down from a recent
        // 429/5xx, and skip (or revalidate) providers the health store has
        // excluded. On fetch success a key-validating endpoint's exclusion
        // is cleared — its /v1/models 401s on a bad key, so success
        // re-proves the key.
        let drop_cooled = |models: Vec<ModelEntry>,
                           db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>|
         -> Vec<ModelEntry> {
            let conn = db.lock();
            models
                .into_iter()
                .filter(|m| {
                    crate::chat::model_health::model_cooldown_remaining(&conn, cfg.id, &m.id, now)
                        .is_none()
                })
                .collect()
        };
        let models = if !cfg.has_key {
            Err("no API key".to_string())
        } else if let Some(reason) = &cfg.excluded_reason {
            // Health-excluded providers skip the fetch entirely — EXCEPT
            // first-party ones whose models fetch can revalidate a bad key.
            let revalidating = cfg.endpoint_validates_key && reason.contains("key");
            if !revalidating {
                Err(reason.clone())
            } else {
                match fetch_auto_models(&cfg).await {
                    Ok(list) => {
                        let conn = db.lock();
                        crate::chat::model_health::clear_key_invalid_on_fetch_ok(
                            &conn, cfg.id, true, now,
                        );
                        Ok(list)
                    }
                    Err(e) => Err(e),
                }
            }
        } else {
            match fetch_auto_models(&cfg).await {
                Ok(list) => {
                    if cfg.endpoint_validates_key {
                        let conn = db.lock();
                        crate::chat::model_health::clear_key_invalid_on_fetch_ok(
                            &conn, cfg.id, true, now,
                        );
                    }
                    Ok(list)
                }
                Err(e) => Err(e),
            }
        };
        // Curated fallback: a fetch failure must not disqualify a provider
        // the user explicitly curated — but cooled-down entries still drop.
        let models = match models {
            Ok(m) => Ok(m),
            Err(e) => match &cfg.curated {
                Some(curated) => Ok(curated.clone()),
                None => Err(e),
            },
        };
        let models = models.map(|m| drop_cooled(m, db));
        ProviderSnapshot {
            id: cfg.id.to_string(),
            has_key: cfg.has_key,
            preferred_model: cfg.preferred,
            models,
        }
    });
    futures_util::future::join_all(fetches).await
}

/// Resolve base URL (stored setting → provider default; compatible providers
/// require a stored one) and fetch + parse the provider's model list into
/// resolver entries, overlaying the curated list's persisted context windows.
pub(super) type AutoModelEntry = crate::chat::auto_router::ModelEntry;

pub(super) async fn fetch_auto_models(cfg: &AutoProviderCfg) -> Result<Vec<AutoModelEntry>, String> {
    let base = cfg
        .base
        .clone()
        .filter(|b| !b.trim().is_empty())
        .or_else(|| match cfg.id {
            "openrouter" => {
                Some(crate::chat::providers::OpenRouterProvider::DEFAULT_BASE.to_string())
            }
            "anthropic" => {
                Some(crate::chat::providers::AnthropicProvider::DEFAULT_BASE.to_string())
            }
            "openai" => Some(crate::chat::providers::OpenAIProvider::DEFAULT_BASE.to_string()),
            _ => None,
        })
        .ok_or_else(|| "base_url not configured".to_string())?;
    let list = fetch_models_list(cfg.id, base, cfg.key.clone()).await?;
    let live: Vec<AutoModelEntry> = list
        .into_iter()
        .map(|m| AutoModelEntry {
            id: m.id,
            context_window: m.context_window,
        })
        .collect();
    // Curated list wins when present (exactly like the picker's); entries
    // missing a persisted window fall back to the live fetch's figure.
    Ok(match &cfg.curated {
        Some(curated) => {
            if live.is_empty() {
                curated.clone()
            } else {
                curated
                    .iter()
                    .map(|c| AutoModelEntry {
                        context_window: c.context_window.or_else(|| {
                            live.iter()
                                .find(|l| l.id == c.id)
                                .and_then(|l| l.context_window)
                        }),
                        ..c.clone()
                    })
                    .collect()
            }
        }
        None => live,
    })
}

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
    let (provider_str, model_str, sandbox_str, approval_str, mode_label, session_auto) = {
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
            cs.auto_model,
        )
    };
    let sandbox = crate::chat::permission::SandboxPolicy::from_db(&sandbox_str);
    let approval = crate::chat::permission::ApprovalPolicy::from_db(&approval_str);

    // 1b. Auto model routing: an auto-flagged session re-resolves its
    // provider+model on EVERY send (chat/auto_router.rs — cloud providers
    // only; the local sidecar and harness CLIs are never auto candidates).
    // The resolution is written back to the session row (auto_model stays 1)
    // so the context meter, cost attribution, and the picker chip all see
    // real values, and the next turn sticks to this pick while it stays
    // eligible (prompt-cache economics). A chat:status notice discloses the
    // pick — and its reason — before the first token.
    let (provider_str, model_str, auto_fallbacks) = if session_auto {
        // The pre-resolution row values are this conversation's sticky pick
        // ("auto"/"auto" on a fresh Auto chat = no sticky yet).
        let sticky = if provider_str != "auto" || model_str != "auto" {
            Some((provider_str.clone(), model_str.clone()))
        } else {
            None
        };
        // Conservative prompt estimate: outgoing message text (attachments'
        // textual form included) plus a fixed budget for the system prompt
        // (tools + skills + memory routinely push it past 4k tokens),
        // ≈4 chars/token.
        let prompt_tokens = ((content.len() + 16_000) / 4) as u64;
        let snapshots = gather_auto_snapshots(&db.0).await;
        // Cost/quality preference (the picker's Auto pane writes
        // `chat.auto.bias`); Balanced keeps provider-preference ranking.
        let bias_setting = {
            let conn = db.0.lock();
            db::get_setting(&conn, "chat.auto.bias").ok().flatten()
        };
        let query = crate::chat::auto_router::AutoQuery {
            prompt_tokens,
            needs_vision: !images.is_empty(),
            sticky,
            bias: crate::chat::auto_router::Bias::from_setting(bias_setting.as_deref()),
        };
        let chain = crate::chat::auto_router::resolve(&snapshots, &query)?;
        let pick = &chain[0];
        {
            let conn = db.0.lock();
            db::update_chat_session_provider(&conn, &chat_session_id, &pick.provider)
                .map_err(|e| e.to_string())?;
            db::update_chat_session_model(&conn, &chat_session_id, &pick.model)
                .map_err(|e| e.to_string())?;
        }
        let _ = app.emit(
            "chat:status",
            crate::types::ChatStatusPayload {
                chat_session_id: chat_session_id.clone(),
                reason: "auto_route".to_string(),
                message: format!(
                    "Auto → {} · {} ({})",
                    crate::chat::auto_router::provider_label(&pick.provider),
                    pick.model,
                    pick.reason
                ),
            },
        );
        // Fail-over chain: candidates after the pick, with credentials
        // pre-resolved so the turn loop never touches the DB for them.
        // Candidates missing a usable key are dropped (the resolver already
        // required has_key, but a key can be deleted between the snapshot
        // and this read).
        let mut fallbacks: Vec<crate::chat::AutoFallback> = Vec::new();
        for cand in chain.iter().skip(1) {
            let Some(pid) = parse_provider_id(&cand.provider) else {
                continue;
            };
            let key = {
                let conn = db.0.lock();
                secrets::get_chat_api_key(&conn, &cand.provider).unwrap_or_default()
            };
            if key.is_empty() {
                continue;
            }
            let base_url = {
                let conn = db.0.lock();
                db::get_setting(&conn, &format!("chat.{}.base_url", cand.provider))
                    .ok()
                    .flatten()
            };
            fallbacks.push(crate::chat::AutoFallback {
                provider_id: pid,
                model: cand.model.clone(),
                api_key: key,
                base_url,
            });
        }
        (pick.provider.clone(), pick.model.clone(), fallbacks)
    } else {
        (provider_str, model_str, Vec::new())
    };

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
        db::add_chat_message(
            &conn,
            db::NewChatMessage {
                chat_session_id: &chat_session_id,
                role: "user",
                content: &content,
                ..Default::default()
            },
        )
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
    // the sidecar warms; it clears on the first token / done / error, and
    // (E-9a) when the warmup itself finishes — whichever comes first.
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
                eprintln!(
                    "[local-warmup] provider=local_gguf, session model name = {:?}",
                    want
                );
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
                        let warm_model_id =
                            g.meta.name.clone().unwrap_or_else(|| g.filename.clone());
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
                                // E-9a: paired clear for the "local_model_loading" status — the
                                // warmup finished (one way or another) and the first token may be
                                // seconds away or never come if the turn fails elsewhere; the
                                // pill must not outlive this block.
                                let _ = app.emit(
                                    "chat:status",
                                    crate::types::ChatStatusPayload {
                                        chat_session_id: chat_session_id.clone(),
                                        reason: String::new(),
                                        message: String::new(),
                                    },
                                );
                                return Err(format!(
                                    "The local model \"{want}\" could not be started after restart: {e}"
                                ));
                            }
                        }
                    } else {
                        eprintln!(
                            "[local-warmup] NO MATCH for {:?} — send will hit the stale URL",
                            want
                        );
                    }
                }
            }
            // E-9a: paired clear for the "local_model_loading" status — the
            // warmup finished (one way or another) and the first token may be
            // seconds away or never come if the turn fails elsewhere; the
            // pill must not outlive this block.
            let _ = app.emit(
                "chat:status",
                crate::types::ChatStatusPayload {
                    chat_session_id: chat_session_id.clone(),
                    reason: String::new(),
                    message: String::new(),
                },
            );
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
        plan_state.set_plan_mode(
            Some(&app),
            &chat_session_id,
            persisted,
            "restored from session",
            &mode_label,
        );
        tools_on && plan_state.plan_mode(&chat_session_id)
    };
    // Raw system-prompt inputs for Auto sessions: the turn loop rebuilds a
    // provider-appropriate prompt per fail-over candidate (the prebuilt
    // `system` below matches only the primary). Populated inside the 5b
    // block; the working-directory suffix is appended further down.
    let mut auto_system_inputs: Option<crate::chat::SystemPromptInputs> = if session_auto {
        Some(crate::chat::SystemPromptInputs::default())
    } else {
        None
    };
    let (mut system, prompt_audit) = {
        let conn = db.0.lock();
        let custom = db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?;
        let mut skills = parse_invoked_skills(&content);
        // Self-improving artifacts telemetry: one open run per invoked skill;
        // the turn lifecycle closes it (applied/failed/corrected). When a
        // canary window is open, the run serves the SHADOW version's body so
        // live traffic exercises the candidate (§9.2). Best-effort — telemetry
        // must never block a send.
        for (skill_name, skill_body) in skills.iter_mut() {
            if let Ok(artifact) =
                db::improve::ensure_artifact(&conn, "skill", skill_name, skill_name, skill_body)
            {
                if let Ok((_, Some(shadow_body))) =
                    db::improve::start_run_shadow(&conn, &artifact.id, Some(&chat_session_id))
                {
                    *skill_body = shadow_body;
                }
            }
        }
        // Memory injection (MEMORY_DESIGN_ARCHITECTURE.md §11, amended):
        // ON DEMAND — the turn's query loads only matching records (plus a
        // tiny standing identity core), budgeted at 800 tokens in render.rs.
        // The full 2200-token document is the store, not injected wholesale;
        // it rides along only as the fallback when nothing qualifies (see
        // `memory::on_demand_injection`). Feature-off → None → the prompt
        // part is omitted byte-neutral.
        let project_id = db::get_chat_session(&conn, &chat_session_id)
            .ok()
            .flatten()
            .and_then(|s| s.project_id);
        let memory_profile = if crate::memory::memory_enabled(&conn) {
            crate::memory::on_demand_injection(
                &conn,
                Some(&content),
                project_id.as_deref(),
                crate::db::now_ts(),
                tools_on,
            )
        } else {
            None
        };
        let built = crate::chat::build_system_prompt(
            provider_id.clone(),
            &model,
            custom.as_deref(),
            &skills,
            tools_on,
            research_mode,
            session_plan_mode,
            manifest.as_deref(),
            memory_profile.as_deref(),
        );
        // [prompt-audit] inputs captured before `custom`/`skills` are consumed.
        let audit = (
            custom.as_deref().map(|c| c.trim().len()).unwrap_or(0),
            skills.iter().map(|(_, body)| body.len()).sum::<usize>(),
        );
        if let Some(inp) = auto_system_inputs.as_mut() {
            inp.custom = custom.clone();
            inp.skills = skills.clone();
            inp.manifest = manifest.clone();
            inp.memory_profile = memory_profile.clone();
            inp.plan_mode = session_plan_mode;
        }
        (built, audit)
    };
    // [memory-audit]: injected memory document size, alongside the
    // prompt-audit line below (the budget is enforced in render.rs).
    {
        let profile_chars = system
            .as_ref()
            .and_then(|s| s.find("## About this user").map(|i| s.len() - i))
            .unwrap_or(0);
        eprintln!("[memory-audit] document_chars={profile_chars}");
    }
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
        let records =
            db::list_active_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?;
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
                let json = builtin_tool_specs_json(
                    &provider_id,
                    &model,
                    code_exec_enabled.unwrap_or(false),
                );
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
                if injected_raw {
                    None
                } else {
                    pre_count_result.ok()
                },
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
                            db::NewChatMessage {
                                chat_session_id: &chat_session_id,
                                role: "system",
                                content: &summary_content,
                                input_tokens: Some(o.summary_input_tokens),
                                output_tokens: Some(o.summary_output_tokens),
                                cost_usd: None,
                                cache_creation_input_tokens: None,
                                cache_read_input_tokens: None,
                                reasoning_output_tokens: None,
                                provider: None,
                                model_key: None,
                                pricing_estimated_usd: None,
                                started_at: None,
                                completed_at: None,
                                llm_time_ms: None,
                                tool_time_ms: None,
                                ttft_ms: None,
                                tokens_per_second: None,
                            },
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
                    let post_compact_tokens: u32 = crate::chat::compaction::count_tokens(
                        &chat_mgr.client,
                        &status.base_url,
                        &system,
                        &o.messages,
                    )
                    .await
                    .unwrap_or_else(|_| {
                        pre_compact_tokens.saturating_sub(o.summary_input_tokens as u32)
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
                    compacted_system_notice = Some(("context_compacted".to_string(), notice));
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
                    eprintln!("[cloud-compaction] failed ({e}); sending history unchanged");
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
    // artifacts dir (Documents/Relay). Mutating tool calls routed through
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
            // The suffix rides the rebuilt fail-over prompts too (without it
            // a failed-over candidate would lose the working directory).
            if let Some(inp) = auto_system_inputs.as_mut() {
                inp.system_suffix.push_str(&section);
            }
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
        auto_fallbacks,
        auto_system_inputs,
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
        let custom = db::get_setting(&conn, "assistant.systemPrompt")
            .ok()
            .flatten();
        let fs_rules: Vec<crate::chat::permission::ApprovalRule> =
            db::get_setting(&conn, "permissions.rules")
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
        None,
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
    let pcaps = crate::chat::prompts::provider_capabilities(ChatProviderId::LocalGguf, model_id);
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
        attachable_mcp: std::sync::Arc::new(avail_m.into_iter().map(|e| (e.id, e.name)).collect()),
        local_model: true,
        // Mirror the send path's gates (chat/mod.rs) — the warmup prompt must
        // stay byte-identical to the real send so the provider cache warms.
        memory: crate::memory::memory_enabled_conn(&app.state::<crate::DbState>().0),
        browser: chat_session_id
            .map(|sid| app.state::<crate::ChatState>().0.browser_session_live(sid))
            .unwrap_or(false)
            || app.state::<crate::BrowserState>().0.has_active_page(),
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
        let specs = crate::chat::tools::openai_tool_specs(&caps, sandbox);
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
pub(super) fn parse_invoked_skills(message: &str) -> Vec<(String, String)> {
    crate::installed_skills::cached_skills()
        .into_iter()
        .filter(|s| message_has_slash_token(message, &s.slug))
        .map(|s| (s.name, s.body))
        .collect()
}

/// True when `/token` appears in the message as a standalone token: preceded
/// by start-of-string or whitespace, followed by whitespace or end.
/// Case-insensitive, so `/docx` never matches `/docx2` or `a/docx`.
pub(super) fn message_has_slash_token(message: &str, token: &str) -> bool {
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

#[tauri::command(async)]
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
#[tauri::command(async)]
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
        db::NewChatMessage {
            chat_session_id: &chat_session_id,
            role: "assistant",
            content: trimmed,
            input_tokens: None,
            output_tokens: None,
            cost_usd: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None,
            provider: provider_val,
            model_key: model_key,
            pricing_estimated_usd: None,
            started_at: None,
            completed_at: Some(db::now_ts()),
            llm_time_ms: None,
            tool_time_ms: None,
            ttft_ms: None,
            tokens_per_second: None,
        },
    );
    let _ = db::touch_chat_session(&conn, &chat_session_id);
    Ok(())
}

