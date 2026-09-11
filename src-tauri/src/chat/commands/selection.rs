//! `commands::selection` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

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
pub(super) static MODEL_WINDOWS_CACHE: std::sync::OnceLock<
    parking_lot::Mutex<
        std::collections::HashMap<
            String,
            (std::time::Instant, std::collections::HashMap<String, u32>),
        >,
    >,
> = std::sync::OnceLock::new();

pub(super) const MODEL_WINDOWS_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

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
    let cache = MODEL_WINDOWS_CACHE
        .get_or_init(|| parking_lot::Mutex::new(std::collections::HashMap::new()));
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
                .header("anthropic-version", ANTHROPIC_API_VERSION)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                // Stale cache beats a live failure.
                if let Some((_, table)) = cache.lock().get(&provider) {
                    eprintln!(
                        "[context-windows] anthropic fetch failed ({status}); using stale cache"
                    );
                    return Ok(table.clone());
                }
                return Err(format!(
                    "models fetch returned {status}: {}",
                    crate::util::truncate_chars(body.trim(), 300)
                ));
            }
            let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let mut table = std::collections::HashMap::new();
            for m in v
                .get("data")
                .and_then(|d| d.as_array())
                .into_iter()
                .flatten()
            {
                let Some(id) = m.get("id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let Some(w) = m.get("context_window").and_then(|w| w.as_u64()) else {
                    continue;
                };
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

    cache
        .lock()
        .insert(provider.clone(), (std::time::Instant::now(), table.clone()));
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

pub(super) fn selected_models_key(provider: &str) -> String {
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
#[tauri::command(async)]
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

/// Map a provider id string to the ChatProviderId enum (send-path dispatch,
/// auto fail-over chain building, and the context-meter paths).
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
pub(super) fn is_harness_provider(provider_str: &str) -> bool {
    provider_str.starts_with("harness:") || provider_str.starts_with("acp:")
}

/// Serialize the BUILT-IN tool schema — the reserve basis for every
/// compaction budget (local `/tokenize`d, cloud char-estimated). Connector
/// and MCP tools attach per-turn inside the send task and are covered by the
/// threshold's margin, exactly as the local block documented.
pub(super) fn builtin_tool_specs_json(provider_id: &ChatProviderId, model: &str, code_exec: bool) -> String {
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
        // Mirror the fresh-turn gates: memory on, browser interaction tools off.
        memory: true,
        browser: false,
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
        (
            "anthropic",
            crate::chat::providers::AnthropicProvider::DEFAULT_BASE,
        ),
        (
            "openai",
            crate::chat::providers::OpenAIProvider::DEFAULT_BASE,
        ),
        (
            "openrouter",
            crate::chat::providers::OpenRouterProvider::DEFAULT_BASE,
        ),
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
pub(super) fn estimate_usage_parts(
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

/// The meter's `used` figure for the estimate path. An empty session has used
/// NOTHING yet — its system+tools baseline is what the FIRST send would cost,
/// not usage, so reporting it made a brand-new chat claim ~14k tokens out of
/// nowhere (reading as leftover data from the previous chat; the meter's own
/// contract is 0 until the first turn completes). Pure for tests.
pub(super) fn estimate_used_tokens(n_records: usize, total_and_tools: u32) -> Option<u32> {
    (n_records > 0).then_some(total_and_tools)
}

/// The model id whose window a cloud/harness session's meter should use.
/// Harness sessions report the model their CLI LAST actually ran (persisted
/// as `agent.actual_model.<harness>.<sid>`); falling back to the session's
/// stored id keeps the window resolvable before the first harness turn.
pub(super) fn meter_model_for_session(
    conn: &rusqlite::Connection,
    provider_str: &str,
    model_str: &str,
    sid: &str,
) -> String {
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
/// Constant OpenAI tool-spec JSON for the cloud context meter — the meter's
/// ToolCaps are fixed, so the ~42k-char serialization is built once per
/// process instead of on every 2s poll.
pub(super) static METER_TOOL_SPECS: std::sync::OnceLock<String> = std::sync::OnceLock::new();

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
        // The session's most recent cache report (last assistant row): the
        // cache-accounted slice the meter's total must exclude so it counts
        // UNCACHED prompt tokens only (see ContextUsagePayload::cached_tokens).
        let cached_tokens = records
            .iter()
            .rev()
            .find(|r| r.role == "assistant")
            .map(|r| {
                cache_accounted_tokens(
                    Some(provider_str.as_str()),
                    r.cache_read_input_tokens.unwrap_or(0),
                    r.cache_creation_input_tokens.unwrap_or(0),
                )
            })
            .unwrap_or(0)
            .max(0) as u32;
        let messages: Vec<ChatMessage> = records
            .into_iter()
            .map(|r| ChatMessage {
                role: r.role,
                content: strip_think_blocks(&r.content),
                images: Vec::new(),
            })
            .collect();

        // PERF: the cache check runs on CHEAP inputs BEFORE the expensive
        // system-prompt build. `attach_availability` queries DB + MCP defs
        // and `build_system_prompt` scans the skills directory (~55k chars of
        // prompt), and the old fingerprint hashed the ALREADY-BUILT prompt —
        // so the memoization only ever skipped the cheap arithmetic while
        // still doing the expensive assembly on every 2s idle poll (same
        // rationale as the local path's PERF B11). system_str is a
        // deterministic function of (provider, model, custom prompt,
        // attached sources), so a key from those inputs is equally fresh.
        // (If a connector's live availability flips while the transcript is
        // unchanged, the estimate stays stale until the next transcript
        // change — acceptable for a meter, and it self-corrects on the next
        // real turn.)
        let is_harness = is_harness_provider(&provider_str);
        let (custom, attached_c, attached_m): (Option<String>, Vec<String>, Vec<String>) =
            if is_harness {
                // Harness turns carry no Relay-built system prompt or tool schema.
                (None, Vec::new(), Vec::new())
            } else {
                // LOCKING: never while another `conn` guard is held.
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

        let max_tokens = {
            let conn = db.0.lock();
            let meter_model =
                meter_model_for_session(&conn, &provider_str, &model_str, &chat_session_id);
            effective_session_window(&conn, &provider_str, &meter_model)
        };

        let fingerprint = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            is_harness.hash(&mut h);
            provider_str.hash(&mut h);
            model_str.hash(&mut h);
            custom.hash(&mut h);
            attached_c.hash(&mut h);
            attached_m.hash(&mut h);
            format!("{:x}:{last_id}:{n_records}", h.finish())
        };
        if let Some(tokens) = chat_state
            .0
            .cached_context_tokens(&chat_session_id, &fingerprint)
        {
            return Ok(crate::types::ContextUsagePayload {
                used_tokens: estimate_used_tokens(n_records, tokens as u32),
                max_tokens,
                cached_tokens,
            });
        }

        // Cache miss: only now pay for the prompt/tool-spec assembly.
        let (system_str, tool_specs_json) = if is_harness {
            (String::new(), String::new())
        } else {
            let attached_m: Vec<String> = attached_m
                .iter()
                .filter_map(|r| r.strip_prefix("mcp:").map(|s| s.to_string()))
                .collect();
            let system_str: String = {
                let provider_id =
                    parse_provider_id(&provider_str).unwrap_or(ChatProviderId::OpenAI);
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
                    None,
                )
                .unwrap_or_default()
            };
            // The spec request here uses constant caps (fs_roots empty, no
            // web search/docs/local model) — the serialization is identical
            // on every poll, so build it once per process.
            let tool_specs_json = METER_TOOL_SPECS
                .get_or_init(|| {
                    serde_json::to_string(&crate::chat::tools::openai_tool_specs(
                        &crate::chat::tools::ToolCaps {
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
                            // Mirror the fresh-turn gates: memory on, browser interaction tools off.
                            memory: true,
                            browser: false,
                            fs_rules: Vec::new(),
                        },
                        crate::chat::permission::SandboxPolicy::WorkspaceWrite,
                    ))
                    .unwrap_or_default()
                })
                .clone();
            (system_str, tool_specs_json)
        };

        let (total, _sys, _msgs, tools) =
            estimate_usage_parts(&system_str, &messages, &tool_specs_json);
        chat_state
            .0
            .store_context_tokens(&chat_session_id, fingerprint, total + tools);
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: estimate_used_tokens(n_records, total + tools),
            max_tokens,
            cached_tokens,
        });
    }

    let Some(status) = local.0.status() else {
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: None,
            max_tokens: 0,
            cached_tokens: 0,
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
        db::list_active_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?
    };

    // Same cache-accounted figure as the cloud branch (local_gguf is an
    // inclusive-input provider, so this is the cache-read slice — usually 0;
    // llama-server doesn't surface a cache split on the usage rows).
    let cached_tokens = records
        .iter()
        .rev()
        .find(|r| r.role == "assistant")
        .map(|r| {
            cache_accounted_tokens(
                Some("local_gguf"),
                r.cache_read_input_tokens.unwrap_or(0),
                r.cache_creation_input_tokens.unwrap_or(0),
            )
        })
        .unwrap_or(0)
        .max(0) as u32;

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
        let custom = db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?;
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
            None,
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
    if let Some(tokens) = chat_state
        .0
        .cached_context_tokens(&chat_session_id, &fingerprint)
    {
        return Ok(crate::types::ContextUsagePayload {
            used_tokens: if tokens > 0 || has_messages {
                Some(tokens)
            } else {
                None
            },
            max_tokens: status.n_ctx,
            cached_tokens,
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
                cached_tokens,
            });
        }
    };

    chat_state
        .0
        .store_context_tokens(&chat_session_id, fingerprint, tokens);

    // 0 with no messages is a genuinely empty transcript → null; 0 WITH
    // messages on a SUCCESSFUL tokenize is real data (empty system + no
    // active rows) and stays Some(0).
    Ok(crate::types::ContextUsagePayload {
        used_tokens: if tokens > 0 || has_messages {
            Some(tokens)
        } else {
            None
        },
        max_tokens: status.n_ctx,
        cached_tokens,
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
            let system_str: String = {
                let provider_id =
                    parse_provider_id(&provider_str).unwrap_or(ChatProviderId::OpenAI);
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
                    None,
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
                // Mirror the fresh-turn gates: memory on, browser interaction tools off.
                memory: true,
                browser: false,
                fs_rules: Vec::new(),
            };
            let tool_specs_json = serde_json::to_string(&crate::chat::tools::openai_tool_specs(
                &caps,
                crate::chat::permission::SandboxPolicy::WorkspaceWrite,
            ))
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
        let custom = db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?;
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
            None,
        )
        .unwrap_or_default()
    };
    let system_prompt_tokens =
        crate::chat::compaction::count_json_tokens(&client, base_url, &system_str)
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
    let total_tokens = crate::chat::compaction::count_tokens(
        &client,
        base_url,
        &Some(system_str.clone()),
        &messages,
    )
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
        // Mirror the fresh-turn gates: memory on, browser interaction tools off.
        memory: true,
        browser: false,
        fs_rules: Vec::new(),
    };
    let tool_specs_json = serde_json::to_string(&crate::chat::tools::openai_tool_specs(
        &caps,
        crate::chat::permission::SandboxPolicy::WorkspaceWrite,
    ))
    .unwrap_or_default();
    let tool_specs_tokens =
        crate::chat::compaction::count_json_tokens(&client, base_url, &tool_specs_json)
            .await
            .unwrap_or(0);

    // 4. Connector/MCP tools — we don't have live connector sessions here
    //    (they're per-turn); estimate from the DB's connector credential rows.
    let connector_tools_tokens: u32 = 0u32;

    // 5. Skills — invoke the same skill resolver the send path uses for the
    //    last user message (best effort: the breakdown fires on hover which is
    //    not message-aware, so we sample the latest user turn from history).
    let skills_tokens: u32 = {
        let last_user_content = messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.as_str());
        if let Some(content) = last_user_content {
            let invoked = parse_invoked_skills(content);
            if !invoked.is_empty() {
                let merged: String = invoked
                    .iter()
                    .map(|(_, body)| body.as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                crate::chat::compaction::count_json_tokens(&client, base_url, &merged)
                    .await
                    .unwrap_or(0)
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
        for m in messages.iter().filter(|m| {
            m.role == "system"
                && m.content
                    .trim_start()
                    .starts_with(crate::chat::compaction::COMPACTED_PREFIX)
        }) {
            total += crate::chat::compaction::count_json_tokens(&client, base_url, &m.content)
                .await
                .unwrap_or(0);
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
#[tauri::command(async)]
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

/// Most recent citation-integrity verdict (full JSON detail) for a chat
/// session — the "Fix citations" repair action reads it to tell the model
/// exactly which claims to re-cite, source properly, or drop.
#[tauri::command(async)]
pub fn research_citation_report(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    let conn = db.0.lock();
    db::latest_citation_detail(&conn, &chat_session_id).map_err(|e| e.to_string())
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
        let custom = db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?;
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
                None,
            )
            .unwrap_or_default()
        };
        let system = if system.trim().is_empty() {
            None
        } else {
            Some(system)
        };
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
                None,
            )
            .unwrap_or_default()
        };
        let system = if system.trim().is_empty() {
            None
        } else {
            Some(system)
        };
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

        let mixed =
            "<think>plan</think><tool>{\"title\":\"x\"}</tool>Done.<tool>{\"title\":\"y\"}</tool>";
        assert_eq!(strip_think_blocks(mixed), "Done.");

        // Unterminated trailing block (mid-stream) is dropped entirely.
        assert_eq!(
            strip_think_blocks("Answer.<tool>{\"title\":\"partial"),
            "Answer."
        );

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
            ChatMessage {
                role: "user".into(),
                content: "abcd".into(),
                images: Vec::new(),
            }, // 1
            ChatMessage {
                role: "assistant".into(),
                content: "abcd".repeat(4).into(),
                images: Vec::new(),
            }, // 4
        ];
        let (total, sys, msgs_tok, tools) = estimate_usage_parts("abcdabcd", &msgs, "abcd"); // 2 + 1
        assert_eq!(sys, 2);
        assert_eq!(msgs_tok, 5);
        assert_eq!(tools, 1);
        assert_eq!(total, 7);
    }

    #[test]
    fn empty_session_reports_no_used_tokens() {
        // A brand-new chat's system+tools baseline (~14k for the built-in
        // agent) must NOT surface as `used` — the meter's contract is 0
        // until the first turn completes. With history, the estimate flows.
        assert_eq!(estimate_used_tokens(0, 14_400), None);
        assert_eq!(estimate_used_tokens(1, 14_400), Some(14_400));
        assert_eq!(estimate_used_tokens(12, 0), Some(0));
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
        crate::db::set_setting(
            &conn,
            "agent.actual_model.claude_code.s1",
            "claude-opus-4-8",
        )
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
        let model =
            meter_model_for_session(&conn, "harness:claude_code", "claude-sonnet-4-5", "s9");
        let window = crate::chat::context_windows::cloud_window_for_model(&model);
        assert_eq!(window, 200_000);
    }

    #[test]
    fn slugify_command_matches_frontend_rules() {
        // The function lives in `installed_skills`; verify it produces the
        // same slugged names the frontend uses for slash-token matching.
        assert_eq!(
            crate::installed_skills::slugify("Word documents (.docx)"),
            "word-documents-docx"
        );
        assert_eq!(
            crate::installed_skills::slugify("Slide decks (.pptx)"),
            "slide-decks-pptx"
        );
        assert_eq!(
            crate::installed_skills::slugify("PDF documents"),
            "pdf-documents"
        );
        assert_eq!(
            crate::installed_skills::slugify("  Report — Style!! "),
            "report-style"
        );
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
        assert_eq!(
            got.len(),
            1,
            "expected exactly 1 docx skill match, got: {got:?}"
        );
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
        assert_eq!(
            g[0].1, l[0].1,
            "/goal and /loop should share the same skill body"
        );
        // The whole goal text is never required to include the token again —
        // a bare /goal alone also injects.
        assert_eq!(parse_invoked_skills("/goal").len(), 1);
    }
}

