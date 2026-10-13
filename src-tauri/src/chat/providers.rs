//! Chat provider implementations: Anthropic, OpenAI, and compatible variants.
//!
//! Each provider builds the correct HTTP request and parses the SSE stream
//! into tokens and usage info. SSE parsing is tested with real payload samples.

use serde::{Deserialize, Serialize};

// ---- Shared types ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatProviderId {
    Anthropic,
    OpenAI,
    /// Custom endpoint that speaks the OpenAI `/v1/chat/completions` wire.
    /// Same protocol as `OpenAICompatible`, but selected EXPLICITLY by API
    /// style — relay keys are often provisioned for one endpoint family only,
    /// so "which wire does this key speak" is a first-class choice.
    OpenAIChat,
    /// Custom endpoint that speaks the OpenAI `/v1/responses` wire.
    OpenAIResponses,
    AnthropicCompatible,
    OpenAICompatible,
    OpenRouter,
    LocalGguf,
}

impl ChatProviderId {
    /// Catalog default model id for this provider (the `default_model` of the
    /// provider struct it routes to). Inherent so callers without a provider
    /// INSTANCE (e.g. the harness primer summarizer, which only knows the
    /// provider string) can still resolve a sane default model.
    pub fn default_model_id(&self) -> &'static str {
        match self {
            ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible => {
                AnthropicProvider.default_model()
            }
            ChatProviderId::OpenAIChat | ChatProviderId::OpenAIResponses => {
                OpenAIProvider.default_model()
            }
            ChatProviderId::OpenAI
            | ChatProviderId::OpenAICompatible
            | ChatProviderId::OpenRouter => OpenRouterProvider.default_model(),
            ChatProviderId::LocalGguf => LocalGgufProvider.default_model(),
        }
    }

    /// True for the two OpenAI-family wires where reported `input_tokens`
    /// already INCLUDE the cached prompt tokens (`prompt_tokens` ⊇ cached).
    /// Anthropic-style providers report the uncached slice instead.
    pub fn input_includes_cache(&self) -> bool {
        matches!(
            self,
            ChatProviderId::OpenAI
                | ChatProviderId::OpenAIChat
                | ChatProviderId::OpenAIResponses
                | ChatProviderId::OpenAICompatible
                | ChatProviderId::OpenRouter
                | ChatProviderId::LocalGguf
        )
    }

    /// Stable string used as the chat_messages.provider value (and thus the
    /// rollup's `chat:<provider>` grouping, spec §8).
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatProviderId::Anthropic => "anthropic",
            ChatProviderId::OpenAI => "openai",
            ChatProviderId::OpenAIChat => "openai_chat",
            ChatProviderId::OpenAIResponses => "openai_responses",
            ChatProviderId::AnthropicCompatible => "anthropic_compatible",
            ChatProviderId::OpenAICompatible => "openai_compatible",
            ChatProviderId::OpenRouter => "openrouter",
            ChatProviderId::LocalGguf => "local_gguf",
        }
    }
}

/// True for the protocol-kind ids (`ChatProviderId::as_str` values).
pub fn is_known_kind(s: &str) -> bool {
    matches!(
        s,
        "anthropic"
            | "openai"
            | "openai_chat"
            | "openai_responses"
            | "openrouter"
            | "anthropic_compatible"
            | "openai_compatible"
            | "local_gguf"
    )
}

/// Endpoint ids are either a bare kind ("anthropic" — a kind's default /
/// legacy endpoint) or "<kind>-<suffix>" (an extra endpoint of the same
/// kind, e.g. "openai_compatible-x7f2"). Extracts the protocol kind so
/// protocol dispatch never needs a settings lookup. Ids not shaped
/// "<known_kind>-<suffix>" are returned unchanged.
pub fn provider_kind(id: &str) -> &str {
    match id.split_once('-') {
        Some((kind, suffix)) if is_known_kind(kind) && !suffix.is_empty() => kind,
        _ => id,
    }
}

/// Canonicalize a user-supplied provider base URL.
///
/// The app's convention is that a stored base EXCLUDES the `/v1` prefix —
/// every request builder appends its own path (`{base}/v1/chat/completions`,
/// `{base}/v1/responses`, `{base}/v1/messages`, `{base}/v1/models`). Provider
/// docs, however, advertise the FULL endpoint (`https://host/v1/chat/...`),
/// so pasting the documented URL stored a base ending in `/v1` and every
/// request went to `.../v1/v1/...` — a 404 from the relay ("not a registered
/// API route"), which reads exactly like "my API key doesn't work".
///
/// Also drops trailing slashes, which would otherwise produce `//v1/...`
/// inside the built paths. Applied on save (`set_chat_api_key`) and once over
/// existing rows (`db::migrate_provider_base_urls`), so both spellings mean
/// the same endpoint and no reader has to care.
pub fn normalize_base_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    // Only a pure `/v1` path segment — never `/v1beta` or `/v10`.
    match trimmed.strip_suffix("/v1") {
        Some(head) if !head.is_empty() => head.trim_end_matches('/').to_string(),
        _ => trimmed.to_string(),
    }
}

/// A base64-encoded image attached to a user message, sent to vision-capable
/// models as a proper image content part (not inlined as garbled text).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatImage {
    /// e.g. "image/png", "image/jpeg".
    pub media_type: String,
    /// Raw base64 (no `data:` prefix).
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Images attached to this (user) turn. Empty for plain text messages and
    /// for history rebuilt from the DB (images are only sent for the live turn).
    #[serde(default)]
    pub images: Vec<ChatImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Reasoning effort hint ("low" | "medium" | "high"). Sent as
    /// `reasoning_effort` on OpenAI-style requests; ignored by Anthropic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Extended-thinking toggle from the composer.
    ///
    /// - `Some(true)`  — enable extended thinking (Anthropic) /
    ///   `chat_template_kwargs.enable_thinking` (Qwen3 / DeepSeek-R1 GGUF).
    /// - `Some(false)` — explicitly turn it off (omits the request fields).
    /// - `None`        — leave the field at the provider default (no override).
    ///
    /// OpenAI reasoning models (o-series, DeepSeek-R1) read `reasoning_effort`
    /// instead and ignore this flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    /// Automatic per-turn local-docs retrieval (roadmap P1 §3.1.7): pre-computed
    /// formatted hits from the user's indexed corpora, injected as a synthetic
    /// "Retrieved context" user message ahead of the conversation so the model
    /// answers from the user's own documents WITHOUT having to call the
    /// `search_docs` tool. Each entry is already rendered (path, score, excerpt);
    /// empty when the embedding sidecar isn't running or nothing matched.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub local_docs_retrieval: Vec<String>,
    /// Native server-side web search for NATIVE OpenAI Chat Completions
    /// (§4.3.7): injects `web_search_options` into the request body and
    /// drops the client web_search tool (see ToolCaps.native_search_openai).
    /// Opt-in (`chat.websearch.native_openai`) because the option is only
    /// accepted by the search-preview models — plain `gpt-4o`/`gpt-5`
    /// endpoints 400 on the unknown parameter. Never set for
    /// OpenAI-compatible/OpenRouter/LocalGguf providers.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub web_search_options: bool,
    /// Memory injection (MEMORY_DESIGN_ARCHITECTURE.md §11): a pre-rendered
    /// `<remembered_context>` block rendered as a synthetic user message
    /// AHEAD of the docs-retrieval message so durable user facts sit closest
    /// to the system prompt. `None` when memory is disabled or nothing scored
    /// above the injection floor. (Since the §11 amendment the whole memory
    /// rides in the system prompt as one document; this slot is the legacy
    /// per-turn path, currently unused.)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub memory_context: Option<String>,
    /// Send `"cache_prompt": true` on the OpenAI wire body. LocalGguf turns
    /// set this: llama-server's `cache_prompt` default flipped across
    /// releases, and an explicit true guarantees the sidecar reuses the
    /// cached KV prefix across turns/rounds regardless of the binary
    /// vintage. Cloud OpenAI-family endpoints reject unknown fields, so
    /// this must stay false for every non-local provider.
    /// (LOCAL_MODEL_PROMPT_CACHING.md §2.3)
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub cache_prompt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ChatUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Local (family-rate) estimate — the fallback, not the truth.
    pub cost_usd: f64,
    /// Cost the PROVIDER itself reported on the usage chunk (OpenRouter
    /// sends `usage.cost`). When present it supersedes `cost_usd` — the
    /// user's real billing, not a hardcoded family rate. It also feeds the
    /// DB's observed per-model rate so future turns on the same model price
    /// from reality (see db::record_observed_pricing).
    pub reported_cost_usd: Option<f64>,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub reasoning_tokens: i64,
}

/// Private-use char prefixed to reasoning/thinking tokens so the stream
/// runner can distinguish them from answer tokens and wrap them in
/// `<think>…</think>` for the frontend's collapsible thinking block.
pub const REASONING_PREFIX: char = '\u{E000}';

/// Anthropic wire API version sent as the `anthropic-version` header on
/// every Messages-API request (streaming, one-shot, metering, model listing).
pub(crate) const ANTHROPIC_API_VERSION: &str = "2023-06-01";

// ---- Default model ids ----------------------------------------------------
// Single source for every "which model does this provider use by default"
// answer: the provider impls below, ChatProviderId::default_model_id, and the
// mobile relay's provider catalog all reference these.

pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";
pub const OPENAI_DEFAULT_MODEL: &str = "gpt-4o";
pub const OPENROUTER_DEFAULT_MODEL: &str = "openai/gpt-4o";
pub const LOCAL_GGUF_DEFAULT_MODEL: &str = "local";

// ---- Provider trait ----

#[async_trait::async_trait]
#[allow(dead_code)]
pub trait ChatProvider: Send + Sync {
    fn id(&self) -> ChatProviderId;
    fn default_model(&self) -> &'static str;

    /// Build the HTTP request — URL, headers, JSON body with stream:true.
    /// Takes a pre-built client for connection reuse.
    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String>;

    /// Parse ONE line from the SSE stream. Returns (token, done).
    /// `buf` is the per-request accumulation buffer used for usage parsing.
    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String>;

    /// Parse final usage from the accumulated SSE buffer.
    fn parse_usage(&self, buf: &str) -> Option<ChatUsage>;
}

// ---- Shared request bodies (Anthropic + OpenAI wire shapes) ----
//
// Hoisted to module level so the native + Compatible variants of each
// provider share ONE body definition + ONE request-builder instead of
// copy-pasting ~45 LOC per variant. The Compatible variants differ only
// in how they resolve the base_url (they REQUIRE one; the native variants
// default it) — everything else is identical, so they delegate here.

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct AnthropicWireBody {
    model: String,
    /// Built via `proto::anthropic_message_json` so messages carrying images
    /// become content-block arrays (vision); plain messages stay strings.
    /// The newest message carries a `cache_control` breakpoint (see
    /// `crate::chat::cache`) so the prefix caches incrementally across turns.
    messages: Vec<serde_json::Value>,
    max_tokens: i64,
    stream: bool,
    /// Rendered as a cached content-block array (not a bare string) so the
    /// stable system prompt hits the prompt cache on every turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<serde_json::Value>,
    /// Anthropic extended thinking. Only emitted when the user has explicitly
    /// toggled it on (composer "brain" icon). `budget_tokens` is bounded by
    /// `max_tokens` so the thinking block can't blow past the model's
    /// generation cap; we leave 1024 tokens of room for the visible answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<AnthropicThinking>,
}

/// Anthropic extended-thinking config. Sent as `{"type": "enabled",
/// "budget_tokens": N}`. `budget_tokens` must be < `max_tokens`.
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct AnthropicThinking {
    #[serde(rename = "type")]
    pub(crate) kind: &'static str,
    pub(crate) budget_tokens: i64,
}

#[derive(Serialize)]
struct OpenAIWireBody {
    model: String,
    /// Built via `proto::openai_message_json` so messages carrying images
    /// become multimodal content arrays (vision); plain messages stay strings.
    messages: Vec<serde_json::Value>,
    stream: bool,
    /// Ask the endpoint for the usage-only trailing chunk. Without this,
    /// OpenAI-style endpoints stream no token counts at all, so plain
    /// (non-tool) turns had NULL usage on `chat:done` and no DB token
    /// accounting. The tool loop already sends this on every round
    /// (`build_openai_body`); the OpenAI protocol sends the usage chunk
    /// after the final delta and before `data: [DONE]`.
    stream_options: OpenAIStreamOptions,
    /// Generation cap (E-2c): `ChatRequest.max_tokens` was silently dropped
    /// on every OpenAI-family request, making output length (and cost)
    /// unbounded while the Anthropic path honored it. Skipped for OpenAI
    /// REASONING models (o1/o3/o4/gpt-5*): those endpoints reject the
    /// deprecated `max_tokens` field outright (they require
    /// `max_completion_tokens`), so leaving it off preserves today's working
    /// behavior for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    /// Qwen3 / DeepSeek-R1 (and other GGUF chat templates that look for this
    /// key) toggle their built-in `<think>…</think>` block via
    /// `chat_template_kwargs.enable_thinking`. Emitted only for explicit
    /// user toggles (composer "brain" button), since llama-server templates
    /// that don't recognize the key will 400. Anthropic gets its own shape
    /// in `anthropic_request` and never sees this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_template_kwargs: Option<ChatTemplateKwargs>,
    /// Explicit llama-server prompt-cache opt-in (see `ChatRequest
    /// .cache_prompt`). `Some(true)` only for LocalGguf sends — cloud
    /// OpenAI-family endpoints 400 on unknown fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_prompt: Option<bool>,
}

/// `stream_options.include_usage` — the only field this codebase needs from
/// the OpenAI streaming-options object.
#[derive(Serialize)]
struct OpenAIStreamOptions {
    include_usage: bool,
}

/// Wraps a single `chat_template_kwargs` entry. We need a struct (not a
/// flat bool) because `chat_template_kwargs` is an object — `{ "enable_thinking": true }`,
/// not the bare value. `Option<bool>` would serialize as `true`, which
/// llama-server rejects.
#[derive(Serialize)]
struct ChatTemplateKwargs {
    enable_thinking: bool,
}

/// OpenAI reasoning-model name heuristic used by every `max_tokens` gate:
/// o1/o3/o4-prefixed and gpt-5-prefixed ids. Those endpoints reject the
/// deprecated `max_tokens` field outright ("Unsupported parameter … use
/// 'max_completion_tokens' instead"), so anything that would attach a cap
/// must omit it for them. Mirrors the streaming-path heuristic exactly — the
/// model ids the catalogs store are bare (no vendor prefix to strip).
pub(crate) fn is_openai_reasoning_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5")
}

/// E-2c: the `max_tokens` cap for OpenAI-family wire requests — sent whenever
/// the caller set one, EXCEPT for OpenAI reasoning models (see
/// [`is_openai_reasoning_model`]).
fn openai_wire_max_tokens(req: &ChatRequest) -> Option<u32> {
    if is_openai_reasoning_model(&req.model) {
        return None;
    }
    req.max_tokens.map(|t| t as u32)
}

/// Map the composer's effort slider to Anthropic's native reasoning control.
/// The Anthropic wire has no `reasoning_effort` parameter — its analog is
/// extended thinking with a token budget — so effort tiers become
/// thinking-budget tiers and the response cap is raised to keep
/// `budget_tokens < max_tokens` valid (Anthropic rejects the request
/// otherwise).
///
/// Precedence: an explicit brain-toggle OFF (`thinking == Some(false)`) wins
/// — the user disabled thinking and a tier must not silently re-enable it.
/// Otherwise any effort tier turns thinking ON with the tier's budget;
/// `Default` (no effort) keeps the legacy behavior (thinking only when the
/// brain toggle is on, budget = whatever the cap leaves).
///
/// Returns the (max_tokens, thinking) pair for the request body.
pub(crate) fn anthropic_thinking_for(req: &ChatRequest) -> (i64, Option<AnthropicThinking>) {
    let explicit_off = req.thinking == Some(false);
    let tier_budget = match req.effort.as_deref() {
        Some("low") => Some(4_096i64),
        Some("medium") => Some(12_288),
        Some("high") => Some(24_576),
        _ => None,
    };
    let thinking_on = !explicit_off && (req.thinking == Some(true) || tier_budget.is_some());
    // E-3: a caller-set max_tokens <= 1024 would make budget_tokens >=
    // max_tokens, which Anthropic rejects outright (budget must be strictly
    // smaller). Floor the cap so the thinking-enabled request stays valid —
    // but ONLY when thinking will actually be emitted: the unconditional
    // floor used to silently override a deliberate small cap on plain
    // (thinking-off) requests.
    let mut max_tokens = req.max_tokens.unwrap_or(4096);
    if thinking_on {
        max_tokens = max_tokens.max(3072);
        if let Some(budget) = tier_budget {
            // Reserve at least 1024 tokens for the visible answer above the
            // thinking budget.
            max_tokens = max_tokens.max(budget + 1024);
        }
    }
    let thinking = thinking_on.then(|| AnthropicThinking {
        kind: "enabled",
        budget_tokens: tier_budget.unwrap_or_else(|| anthropic_thinking_budget(max_tokens)),
    });
    (max_tokens, thinking)
}

/// The fallback thinking budget when no effort tier pins it: reserve ≥1024
/// visible-answer tokens, keeping the budget itself in Anthropic's valid
/// range (≥1024 and strictly below max_tokens). Used by BOTH the non-tool
/// builder (`anthropic_thinking_for` above) and the streaming tool-loop body
/// (streaming.rs `build_anthropic_body`) — the two must stay in lockstep or
/// one path starts emitting API-rejected requests.
pub(crate) fn anthropic_thinking_budget(max_tokens: i64) -> i64 {
    (max_tokens - 1024).clamp(1024, max_tokens - 1)
}

/// Build the Anthropic `/v1/messages` streaming request. Both
/// `AnthropicProvider` and `AnthropicCompatibleProvider` route through here.
fn anthropic_request(
    client: &reqwest::Client,
    req: &ChatRequest,
    api_key: &str,
    base: &str,
) -> reqwest::RequestBuilder {
    let url = format!("{base}/v1/messages");
    let (max_tokens, thinking) = anthropic_thinking_for(req);
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(mem) = &req.memory_context {
        messages.push(serde_json::json!({
            "role": "user",
            "content": mem,
        }));
    }
    messages.extend(
        req.messages
            .iter()
            .map(crate::chat::proto::anthropic_message_json),
    );
    // Per-turn local-docs auto-retrieval (§3.1.7): appended as the LAST
    // message, next to the turn's question, rather than injected at the
    // head. The synthetic message is not persisted, so an injected-first
    // copy would change the head of every request and invalidate the prompt
    // cache for the entire history (same reasoning as the tool loops in
    // streaming.rs; see `crate::chat::cache`).
    if !req.local_docs_retrieval.is_empty() {
        messages.push(serde_json::json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }
    // Breakpoint on the newest message so each turn's request re-reads the
    // whole prior conversation as cache hits and writes only the fresh tail.
    crate::chat::cache::mark_last_message(&mut messages);
    let body = AnthropicWireBody {
        model: req.model.clone(),
        messages,
        max_tokens,
        stream: true,
        system: req
            .system
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(crate::chat::cache::cached_system_block),
        thinking,
    };
    capture_request("POST", &url, &body);
    client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_API_VERSION)
        .header("content-type", "application/json")
        .json(&body)
}

/// Hand the verbatim wire body to the request-log capture sink, if one is
/// installed for this task.
///
/// This is the single seam every provider's request passes through, so the
/// log records exactly the bytes that went out rather than a reconstruction
/// of them. Serialization is skipped entirely when no sink is listening,
/// which is the case for every turn the user hasn't turned logging on for.
fn capture_request<T: serde::Serialize>(method: &str, url: &str, body: &T) {
    let listening = crate::llm_log::request_capture_active();
    if !listening {
        return;
    }
    if let Ok(json) = serde_json::to_string(body) {
        crate::llm_log::record_request(method, url, &json);
    }
}

/// Build the OpenAI `/v1/chat/completions` streaming request. Both
/// `OpenAIProvider` and `OpenAICompatibleProvider` route through here.
fn openai_request(
    client: &reqwest::Client,
    req: &ChatRequest,
    api_key: &str,
    base: &str,
) -> reqwest::RequestBuilder {
    openai_request_marked(client, req, api_key, base, false)
}

/// Same, with optional Anthropic-style `cache_control` breakpoints. Only
/// OpenRouter serving an `anthropic/*` model may set `cache_marks` (see
/// `cache::openrouter_anthropic`): OpenRouter translates the marks into
/// native Claude prompt caching, while other OpenAI-family backends are
/// stricter servers where unknown request fields can 400.
fn openai_request_marked(
    client: &reqwest::Client,
    req: &ChatRequest,
    api_key: &str,
    base: &str,
    cache_marks: bool,
) -> reqwest::RequestBuilder {
    let url = format!("{base}/v1/chat/completions");
    let body = openai_wire_body(req, cache_marks);
    // `.json(&body)` (B12): lets reqwest serialize + set content-type itself;
    // the previous `.body(to_string(&body))` eagerly stringified the payload
    // even when the request never fired, and duplicated the header.
    capture_request("POST", &url, &body);
    client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
}

/// Message assembly + wire body for the OpenAI family. Split from
/// [`openai_request_marked`] so tests can assert on the exact payload.
fn openai_wire_body(req: &ChatRequest, cache_marks: bool) -> OpenAIWireBody {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": sys }));
        }
    }
    // Per-turn memory injection (§11.3) precedes docs retrieval: durable user
    // facts first, then the turn's retrieved documents, then the conversation.
    if let Some(mem) = &req.memory_context {
        messages.push(serde_json::json!({
            "role": "user",
            "content": mem,
        }));
    }
    messages.extend(
        req.messages
            .iter()
            .map(crate::chat::proto::openai_message_json),
    );
    // Per-turn local-docs auto-retrieval (§3.1.7): appended as the LAST
    // message (next to the turn's question) rather than injected at the head
    // — the synthetic message isn't persisted, so injecting it early would
    // rewrite the head of every request and invalidate OpenAI's automatic
    // prefix cache for the entire history.
    if !req.local_docs_retrieval.is_empty() {
        messages.push(serde_json::json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }
    if cache_marks {
        crate::chat::cache::apply_openai_cache_marks(&mut messages);
    }
    OpenAIWireBody {
        model: req.model.clone(),
        messages,
        stream: true,
        stream_options: OpenAIStreamOptions {
            include_usage: true,
        },
        max_tokens: openai_wire_max_tokens(req),
        reasoning_effort: req.effort.clone(),
        chat_template_kwargs: req
            .thinking
            .map(|t| ChatTemplateKwargs { enable_thinking: t }),
        cache_prompt: req.cache_prompt.then_some(true),
    }
}

// ---- Anthropic ----

pub struct AnthropicProvider;

impl AnthropicProvider {
    pub const DEFAULT_BASE: &'static str = "https://api.anthropic.com";
}

impl ChatProvider for AnthropicProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::Anthropic
    }

    fn default_model(&self) -> &'static str {
        ANTHROPIC_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        Ok(anthropic_request(
            client,
            req,
            api_key,
            base_url.unwrap_or(Self::DEFAULT_BASE),
        ))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        // mi24: retain ONLY usage-bearing lines — pushing every streamed
        // line into `buf` grew it unboundedly (multi-MB on long
        // generations) while `parse_usage` only ever scans for usage JSON.
        if line.contains("\"usage\"") {
            buf.push_str(line);
            buf.push('\n');
        }

        // Anthropic SSE: lines prefixed with "event:" and "data:".
        // B-18: tolerate `data:` without the trailing space (OpenRouter-style
        // aggregators emit it; the tool loops already accept both forms).
        let data = if let Some(d) = line.strip_prefix("data:") {
            d.strip_prefix(' ').unwrap_or(d)
        } else {
            "" // not a data line — nothing below runs
        };
        if !data.is_empty() || line.starts_with("data:") {
            #[derive(Deserialize)]
            struct SsePayload {
                #[serde(rename = "type")]
                event_type: String,
                delta: Option<Delta>,
                usage: Option<serde_json::Value>,
                error: Option<serde_json::Value>,
            }

            #[derive(Deserialize)]
            struct Delta {
                text: Option<String>,
                // `thinking_delta` events carry their payload under
                // `delta.thinking` — previously dropped on the floor here,
                // so the non-tool Anthropic path never showed thinking.
                thinking: Option<String>,
            }

            let payload: SsePayload =
                serde_json::from_str(data).map_err(|e| format!("SSE parse error: {e}"))?;

            match payload.event_type.as_str() {
                "content_block_delta" => {
                    // mi24: move the delta text out instead of cloning —
                    // `payload` is dropped right after this match.
                    if let Some(delta) = payload.delta {
                        if let Some(text) = delta.text {
                            return Ok((Some(text), false));
                        }
                        if let Some(thinking) = delta.thinking {
                            if !thinking.is_empty() {
                                return Ok((Some(format!("{REASONING_PREFIX}{thinking}")), false));
                            }
                        }
                    }
                }
                "message_delta" | "message_stop" => {
                    // Usage will be in the payload; we keep it in buf.
                    return Ok((None, true));
                }
                "error" => {
                    // B-17: a mid-stream error event (after 200 OK) must fail
                    // the turn, not "complete" it with truncated text. The
                    // "provider error:" prefix tells run_chat_stream this is
                    // fatal (not a recoverable parse failure).
                    let msg = payload
                        .error
                        .as_ref()
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("provider returned an error event")
                        .to_string();
                    return Err(format!("provider error: {msg}"));
                }
                "ping" => {}
                _ => {}
            }
        }

        Ok((None, false))
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        // B-15: Anthropic splits usage across the stream — `message_start`
        // carries input_tokens (+ the cache fields) and only `message_delta`
        // carries the final output_tokens. The old backward scan always
        // landed on message_delta, so input (and all cache accounting) was
        // recorded as 0 on the non-tool path. Merge instead: input/cache from
        // the FIRST usage-bearing event, output from the LAST.
        #[derive(Deserialize)]
        struct UsageEvent {
            usage: Option<UsageData>,
        }
        #[derive(Deserialize)]
        struct UsageData {
            input_tokens: Option<i64>,
            output_tokens: Option<i64>,
            cache_creation_input_tokens: Option<i64>,
            cache_read_input_tokens: Option<i64>,
        }

        let mut first_input: Option<(i64, i64, i64)> = None; // (input, cache_creation, cache_read)
        let mut last_output: i64 = 0;
        for line in buf.lines() {
            let Some(data) = line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
            else {
                continue;
            };
            let Ok(ev) = serde_json::from_str::<UsageEvent>(data) else {
                continue;
            };
            let Some(u) = ev.usage else { continue };
            if first_input.is_none() {
                if let Some(i) = u.input_tokens {
                    first_input = Some((
                        i,
                        u.cache_creation_input_tokens.unwrap_or(0),
                        u.cache_read_input_tokens.unwrap_or(0),
                    ));
                }
            }
            if let Some(o) = u.output_tokens {
                last_output = o;
            }
        }
        let (input, cache_creation, cache_read) = match first_input {
            Some(v) => v,
            // Degenerate stream with only a message_delta usage: keep the old
            // behavior of reporting at least the output count.
            None if last_output > 0 => (0, 0, 0),
            None => return None,
        };
        let cost = calculate_anthropic_cost(input, last_output);
        Some(ChatUsage {
            input_tokens: input,
            output_tokens: last_output,
            cost_usd: cost,
            // The Messages API carries no cost field — estimate only.
            reported_cost_usd: None,
            cache_creation_input_tokens: cache_creation,
            cache_read_input_tokens: cache_read,
            reasoning_tokens: 0, // Anthropic doesn't surface reasoning_tokens on message_delta yet
        })
    }
}

pub(crate) fn calculate_anthropic_cost(input_tokens: i64, output_tokens: i64) -> f64 {
    // Approximate rates for claude-sonnet-4-5 ($3/$15 per Mtok).
    // The real rate should come from a settings override — this is the
    // fallback estimate used when pricing keys are absent.
    let in_rate = 3.0;
    let out_rate = 15.0;
    (input_tokens as f64 * in_rate + output_tokens as f64 * out_rate) / 1_000_000.0
}

// ---- OpenAI ----

pub struct OpenAIProvider;

impl OpenAIProvider {
    pub const DEFAULT_BASE: &'static str = "https://api.openai.com";
}

impl ChatProvider for OpenAIProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::OpenAI
    }

    fn default_model(&self) -> &'static str {
        OPENAI_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        Ok(openai_request(
            client,
            req,
            api_key,
            base_url.unwrap_or(Self::DEFAULT_BASE),
        ))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        // mi24: retain ONLY usage-bearing lines (see Anthropic impl above).
        if line.contains("\"usage\"") {
            buf.push_str(line);
            buf.push('\n');
        }

        // B-18: tolerate `data:` without the trailing space (OpenRouter /
        // vLLM emit it; the tool loops already accept both forms).
        if let Some(rest) = line.strip_prefix("data:") {
            let data = rest.strip_prefix(' ').unwrap_or(rest);

            if data == "[DONE]" {
                return Ok((None, true));
            }

            #[derive(Deserialize)]
            struct SsePayload {
                choices: Option<Vec<Choice>>,
                usage: Option<serde_json::Value>,
                error: Option<serde_json::Value>,
            }

            #[derive(Deserialize)]
            struct Choice {
                delta: Option<Delta>,
            }

            #[derive(Deserialize)]
            struct Delta {
                content: Option<String>,
                // Reasoning models (DeepSeek, GLM, o-series compatibles)
                // stream thinking under one of these keys.
                reasoning_content: Option<String>,
                reasoning: Option<String>,
            }

            let payload: SsePayload =
                serde_json::from_str(data).map_err(|e| format!("SSE parse error: {e}"))?;

            // B-17: mid-stream error events (OpenRouter overload, credit
            // exhaustion — sent as {"error": …} after 200 OK) used to be
            // ignored, so the turn "completed" with truncated text.
            if let Some(err) = payload.error {
                let msg = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("provider returned an error event");
                return Err(format!("provider error: {msg}"));
            }

            // Check for final chunk (may have usage, may have finish_reason).
            // `finish_reason: "stop"` is NOT terminal: the provider's usage
            // chunk arrives AFTER it (llama-server order: final delta →
            // `{"choices":[],"usage":{…}}` → `[DONE]`), so only `data: [DONE]`
            // ends the read loop — breaking at stop dropped token accounting
            // on every plain (non-tool) turn. The stream still ends promptly
            // at `[DONE]` or EOF; a half-open connection that never sends
            // either hits the existing 60s stall watchdog, same as the tool
            // loop's degenerate case.
            if let Some(choices) = payload.choices {
                for choice in choices {
                    if let Some(delta) = choice.delta {
                        if let Some(content) = delta.content {
                            if !content.is_empty() {
                                return Ok((Some(content), false));
                            }
                        }
                        if let Some(reasoning) = delta.reasoning_content.or(delta.reasoning) {
                            if !reasoning.is_empty() {
                                return Ok((Some(format!("{REASONING_PREFIX}{reasoning}")), false));
                            }
                        }
                    }
                }
            }

            // A usage-bearing chunk is mid-stream by definition — keep
            // reading so the trailing `[DONE]` (or EOF) ends the turn.
            if payload.usage.is_some() {
                return Ok((None, false));
            }
        }

        Ok((None, false))
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        // Usage in OpenAI appears in the final chunk with usage object.
        // Search for the last data line that contains usage.
        for line in buf.lines().rev() {
            // Tolerate `data:{…}` without the trailing space — the same
            // aggregators (OpenRouter, vLLM) that emit it stream it here too,
            // and the retained buffer keeps the raw line.
            let data = match line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
            {
                Some(d) => d,
                None => continue,
            };
            if data == "[DONE]" {
                continue;
            }
            #[derive(Deserialize)]
            struct UsageEvent {
                usage: Option<UsageData>,
            }
            #[derive(Deserialize)]
            struct UsageData {
                prompt_tokens: Option<i64>,
                completion_tokens: Option<i64>,
                /// OpenRouter reports the request's REAL cost on the usage
                /// chunk; OpenAI-family endpoints that don't simply omit it.
                #[serde(rename = "cost")]
                reported_cost: Option<f64>,
                #[serde(rename = "prompt_tokens_details")]
                prompt_details: Option<PromptTokenDetails>,
                #[serde(rename = "completion_tokens_details")]
                completion_details: Option<CompletionTokenDetails>,
            }
            #[derive(Deserialize)]
            struct PromptTokenDetails {
                cached_tokens: Option<i64>,
            }
            #[derive(Deserialize)]
            struct CompletionTokenDetails {
                reasoning_tokens: Option<i64>,
            }
                if let Ok(ev) = serde_json::from_str::<UsageEvent>(data) {
                    if let Some(u) = ev.usage {
                        let input = u.prompt_tokens.unwrap_or(0);
                        let output = u.completion_tokens.unwrap_or(0);
                        let cost = calculate_openai_cost(input, output);
                        return Some(ChatUsage {
                            input_tokens: input,
                            output_tokens: output,
                            cost_usd: cost,
                            // OpenRouter's reported cost is the user's real
                            // billing — carried separately so the turn (and
                            // the observed-rate learner) can prefer it over
                            // the family-rate estimate in `cost_usd`.
                            reported_cost_usd: u.reported_cost.filter(|c| *c > 0.0),
                            // OpenAI reports the cache-served share of the prompt
                            // (billed at the cached rate) and reasoning tokens
                            // folded into completion — mirror the tool loop's
                            // extraction so the cache chip and cost rollup see
                            // the same detail on the non-tool path.
                            cache_read_input_tokens: u
                                .prompt_details
                                .and_then(|d| d.cached_tokens)
                                .unwrap_or(0),
                            cache_creation_input_tokens: 0,
                            reasoning_tokens: u
                                .completion_details
                                .and_then(|d| d.reasoning_tokens)
                                .unwrap_or(0),
                        });
                    }
                }
        }
        None
    }
}

pub(crate) fn calculate_openai_cost(input_tokens: i64, output_tokens: i64) -> f64 {
    // Approximate rates for gpt-4o ($2.50/$10 per Mtok).
    let in_rate = 2.50;
    let out_rate = 10.0;
    (input_tokens as f64 * in_rate + output_tokens as f64 * out_rate) / 1_000_000.0
}

// ---- AnthropicCompatible ----

pub struct AnthropicCompatibleProvider;

impl ChatProvider for AnthropicCompatibleProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::AnthropicCompatible
    }

    fn default_model(&self) -> &'static str {
        ANTHROPIC_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base =
            base_url.ok_or_else(|| "base_url is required for AnthropicCompatible".to_string())?;
        Ok(anthropic_request(client, req, api_key, base))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        AnthropicProvider.parse_sse_chunk(line, buf)
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        AnthropicProvider.parse_usage(buf)
    }
}

// ---- OpenAICompatible ----

pub struct OpenAICompatibleProvider;

impl ChatProvider for OpenAICompatibleProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::OpenAICompatible
    }

    fn default_model(&self) -> &'static str {
        OPENAI_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base =
            base_url.ok_or_else(|| "base_url is required for OpenAICompatible".to_string())?;
        Ok(openai_request(client, req, api_key, base))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        OpenAIProvider.parse_sse_chunk(line, buf)
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        OpenAIProvider.parse_usage(buf)
    }
}

// ---- OpenAIChat ----
//
// Explicit API-STYLE variant of `OpenAICompatible`: the same
// `/v1/chat/completions` wire and `Authorization: Bearer` auth, but selectable
// as "Chat Completions" in Settings because relay keys are commonly issued per
// endpoint family. Unlike the native `OpenAI` kind it has NO default base — a
// missing base URL is a configuration error, never a silent call to
// api.openai.com with the user's key.

pub struct OpenAIChatProvider;

impl OpenAIChatProvider {
    const REQUIRED_BASE: &'static str = "base_url is required for OpenAIChat";
}

impl ChatProvider for OpenAIChatProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::OpenAIChat
    }

    fn default_model(&self) -> &'static str {
        OPENAI_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base = base_url.ok_or_else(|| Self::REQUIRED_BASE.to_string())?;
        Ok(openai_request(client, req, api_key, base))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        OpenAIProvider.parse_sse_chunk(line, buf)
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        OpenAIProvider.parse_usage(buf)
    }
}

// ---- OpenAIResponses ----
//
// The OpenAI Responses API (`/v1/responses`) — OpenAI's newer wire for its
// frontier/reasoning models and the endpoint family many relay providers now
// expose. Structurally different from chat completions:
//   - the system prompt is `instructions`, not a system message;
//   - the conversation is an `input` ITEM array (messages, function_call,
//     function_call_output) instead of role messages;
//   - tools are flat `{type:"function", name, description, parameters}`
//     declarations;
//   - the stream is a sequence of TYPED events (`response.output_text.delta`,
//     `response.output_item.done`, `response.completed`, …) rather than
//     `choices[].delta` chunks, so tool calls arrive as whole `function_call`
//     items.
// Uses the same `Authorization: Bearer` auth as the rest of the OpenAI family
// and, like the other custom kinds, REQUIRES an explicit base URL.

pub struct OpenAIResponsesProvider;

impl OpenAIResponsesProvider {
    const REQUIRED_BASE: &'static str = "base_url is required for OpenAIResponses";
}

/// Assemble one OpenAI `/v1/responses` wire body. Shared by the plain
/// (tools-off) request builder and the streaming tool loop
/// (`streaming.rs::run_openai_responses_tool_loop`) so both paths emit one
/// identical shape.
pub(crate) fn responses_wire_body(
    req: &ChatRequest,
    input: Vec<serde_json::Value>,
    tools: Vec<serde_json::Value>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": req.model,
        "input": input,
        "stream": true,
        // Retention opt-out: relay endpoints pass this through to OpenAI, and
        // response bodies are the user's prompts. Standard field, honored by
        // every Responses-compatible server we know of.
        "store": false,
    });
    if let Some(sys) = req.system.as_deref().filter(|s| !s.is_empty()) {
        body["instructions"] = serde_json::json!(sys);
    }
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools);
    }
    // Generation cap. Same reasoning-model heuristic as the chat-completions
    // wire (o-series / gpt-5 endpoints reject the plain cap field).
    if let Some(max) = openai_wire_max_tokens(req) {
        body["max_output_tokens"] = serde_json::json!(max);
    }
    // Reasoning-effort hint — the Responses equivalent of the chat wire's
    // `reasoning_effort` (a nested `reasoning` object here).
    if let Some(effort) = &req.effort {
        body["reasoning"] = serde_json::json!({ "effort": effort });
    }
    body
}

/// The `input` ITEM array for a request: optional memory block, the
/// conversation, then the per-turn local-docs retrieval (appended LAST so the
/// stable prefix stays byte-identical across turns — same caching rationale as
/// the other wires; see `openai_wire_body`).
pub(crate) fn responses_input(req: &ChatRequest) -> Vec<serde_json::Value> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    if let Some(mem) = &req.memory_context {
        items.push(serde_json::json!({ "role": "user", "content": mem }));
    }
    items.extend(
        req.messages
            .iter()
            .map(crate::chat::proto::responses_message_json),
    );
    if !req.local_docs_retrieval.is_empty() {
        items.push(serde_json::json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }
    items
}

/// Build the OpenAI `/v1/responses` streaming request (the tools-off path).
fn responses_request(
    client: &reqwest::Client,
    req: &ChatRequest,
    api_key: &str,
    base: &str,
) -> reqwest::RequestBuilder {
    let url = format!("{base}/v1/responses");
    let body = responses_wire_body(req, responses_input(req), Vec::new());
    capture_request("POST", &url, &body);
    client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
}

impl ChatProvider for OpenAIResponsesProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::OpenAIResponses
    }

    fn default_model(&self) -> &'static str {
        OPENAI_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base = base_url.ok_or_else(|| Self::REQUIRED_BASE.to_string())?;
        Ok(responses_request(client, req, api_key, base))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        // mi24 contract: retain ONLY usage-bearing lines (the `response.completed`
        // event carries the usage object) — see the Anthropic impl.
        if line.contains("\"usage\"") {
            buf.push_str(line);
            buf.push('\n');
        }

        let data = match line.strip_prefix("data:").map(|s| s.trim_start()) {
            Some(d) => d,
            None => return Ok((None, false)), // event:/id:/retry: lines
        };
        if data == "[DONE]" {
            // Some gateways terminate a Responses stream with the
            // chat-completions sentinel even though the spec ends at
            // `response.completed`.
            return Ok((None, true));
        }

        let payload: serde_json::Value =
            serde_json::from_str(data).map_err(|e| format!("SSE parse error: {e}"))?;

        // B-17: a mid-stream error event must fail the turn, not "complete" it
        // with truncated text.
        if let Some(err) = payload.get("error").filter(|e| !e.is_null()) {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("provider returned an error event")
                .to_string();
            return Err(format!("provider error: {msg}"));
        }

        let event_type = payload
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        match event_type {
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(text) = payload.get("delta").and_then(|d| d.as_str()) {
                    if !text.is_empty() {
                        return Ok((Some(text.to_string()), false));
                    }
                }
            }
            // Reasoning summaries / raw reasoning text — same private-use
            // sentinel the other wires use so the pump wraps them in <think>.
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(text) = payload.get("delta").and_then(|d| d.as_str()) {
                    if !text.is_empty() {
                        return Ok((Some(format!("{REASONING_PREFIX}{text}")), false));
                    }
                }
            }
            "response.failed" | "response.incomplete" => {
                // Terminal. `incomplete` is a truncated answer (e.g. the
                // output cap) — the text streamed so far stands, so this is
                // not an error; `failed` carries the provider's reason.
                if event_type == "response.failed" {
                    let msg = payload
                        .pointer("/response/error/message")
                        .and_then(|m| m.as_str())
                        .or_else(|| payload.pointer("/error/message").and_then(|m| m.as_str()))
                        .unwrap_or("response failed");
                    return Err(format!("provider error: {msg}"));
                }
                return Ok((None, true));
            }
            "response.completed" => return Ok((None, true)),
            "error" => {
                let msg = payload
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("provider returned an error event");
                return Err(format!("provider error: {msg}"));
            }
            _ => {}
        }
        Ok((None, false))
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        // Usage rides the terminal `response.completed` event:
        // {"type":"response.completed","response":{"usage":{…}}}. Same
        // OpenAI-style accounting as the chat wire (input INCLUDES the cached
        // slice; reasoning is a detail of the output tokens).
        for line in buf.lines().rev() {
            let data = match line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
            {
                Some(d) => d,
                None => continue,
            };
            if data == "[DONE]" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let usage = payload
                .pointer("/response/usage")
                .or_else(|| payload.get("usage"))
                .filter(|u| !u.is_null());
            let Some(u) = usage else { continue };
            let input = u.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            let output = u.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            let cost = calculate_openai_cost(input, output);
            return Some(ChatUsage {
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost,
                reported_cost_usd: None,
                cache_read_input_tokens: u
                    .pointer("/input_tokens_details/cached_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
                cache_creation_input_tokens: 0,
                reasoning_tokens: u
                    .pointer("/output_tokens_details/reasoning_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
            });
        }
        None
    }
}

// ---- OpenRouter ----
//
// OpenRouter (https://openrouter.ai) is an OpenAI-compatible aggregator: the
// same `/v1/chat/completions` wire format, `Authorization: Bearer` auth, and a
// `/v1/models` catalogue — but with a FIXED endpoint, so unlike the generic
// "OpenAI Compatible" provider the user does not have to type a base URL. It's
// its own first-class provider so its key/model live under their own settings
// namespace. OpenRouter recommends (optional) `HTTP-Referer` / `X-Title`
// headers to identify the app; we send them best-effort.

pub struct OpenRouterProvider;

impl OpenRouterProvider {
    /// `openai_request` appends `/v1/chat/completions`, so the base stops at
    /// `/api` to yield `https://openrouter.ai/api/v1/chat/completions`.
    pub const DEFAULT_BASE: &'static str = "https://openrouter.ai/api";
}

impl ChatProvider for OpenRouterProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::OpenRouter
    }

    fn default_model(&self) -> &'static str {
        OPENROUTER_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base = base_url.unwrap_or(Self::DEFAULT_BASE);
        Ok(openai_request_marked(
            client,
            req,
            api_key,
            base,
            crate::chat::cache::openrouter_anthropic(&req.model),
        )
        .header("HTTP-Referer", "https://conduit.app")
        .header("X-Title", "Relay"))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        OpenAIProvider.parse_sse_chunk(line, buf)
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        OpenAIProvider.parse_usage(buf)
    }
}

// ---- LocalGguf ----
//
// llama-server speaks the OpenAI-compatible wire format at
// `http://127.0.0.1:<port>/v1/chat/completions`, so LocalGgufProvider reuses
// `openai_request` and delegates SSE parsing / usage extraction to
// `OpenAIProvider`. The base_url is REQUIRED (stored by the sidecar-start
// command); the API key is a dummy placeholder since llama-server ignores it.

pub struct LocalGgufProvider;

impl ChatProvider for LocalGgufProvider {
    fn id(&self) -> ChatProviderId {
        ChatProviderId::LocalGguf
    }

    fn default_model(&self) -> &'static str {
        LOCAL_GGUF_DEFAULT_MODEL
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base = base_url.ok_or_else(|| "base_url is required for LocalGguf".to_string())?;
        Ok(openai_request(client, req, api_key, base))
    }

    fn parse_sse_chunk(
        &self,
        line: &str,
        buf: &mut String,
    ) -> Result<(Option<String>, bool), String> {
        OpenAIProvider.parse_sse_chunk(line, buf)
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        OpenAIProvider.parse_usage(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- OpenAI reasoning-model max_tokens gate ----

    #[test]
    fn reasoning_models_are_recognized_for_the_max_tokens_gate() {
        // The ids whose endpoints 400 on `max_tokens` without this gate.
        for m in ["o1", "o1-mini", "o3", "o4-mini", "gpt-5", "gpt-5.2-codex", "GPT-5"] {
            assert!(is_openai_reasoning_model(m), "{m}");
        }
        for m in ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o2-typo", "claude-sonnet-4-5", "qwen3-8b", ""]
        {
            assert!(!is_openai_reasoning_model(m), "{m}");
        }
    }

    // ---- Effort → Anthropic extended-thinking tier mapping ----

    fn bare_req() -> ChatRequest {
        ChatRequest {
            model: "claude-sonnet-4-5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
                images: Vec::new(),
            }],
            max_tokens: Some(4096),
            system: None,
            effort: None,
            thinking: None,
            local_docs_retrieval: Vec::new(),
            web_search_options: false,
            memory_context: None,
            cache_prompt: false,
        }
    }

    #[test]
    fn effort_none_keeps_legacy_thinking_behavior() {
        let (max, thinking) = anthropic_thinking_for(&bare_req());
        assert_eq!(max, 4096);
        assert!(thinking.is_none());
        let mut r = bare_req();
        r.thinking = Some(true);
        let (max, thinking) = anthropic_thinking_for(&r);
        assert_eq!(max, 4096);
        assert_eq!(thinking.unwrap().budget_tokens, 3072);
    }

    #[test]
    fn effort_tiers_map_to_ascending_thinking_budgets() {
        for (tier, budget, max) in [
            ("low", 4_096, 5_120),
            ("medium", 12_288, 13_312),
            ("high", 24_576, 25_600),
        ] {
            let mut r = bare_req();
            r.effort = Some(tier.to_string());
            let (max_tokens, thinking) = anthropic_thinking_for(&r);
            assert_eq!(max_tokens, max, "tier {tier}");
            let t = thinking.expect(tier);
            assert_eq!(t.budget_tokens, budget, "tier {tier}");
            assert!(t.budget_tokens < max_tokens);
        }
    }

    #[test]
    fn explicit_brain_off_beats_effort_tier() {
        let mut r = bare_req();
        r.effort = Some("high".to_string());
        r.thinking = Some(false);
        let (max, thinking) = anthropic_thinking_for(&r);
        assert_eq!(max, 4096);
        assert!(thinking.is_none());
    }

    #[test]
    fn effort_tier_implies_thinking_without_the_brain_toggle() {
        let mut r = bare_req();
        r.effort = Some("low".to_string());
        r.thinking = None;
        let (_, thinking) = anthropic_thinking_for(&r);
        assert!(thinking.is_some());
    }

    #[test]
    fn thinking_off_preserves_a_small_max_tokens_cap() {
        // The 3072 floor exists to keep budget_tokens < max_tokens, so it must
        // apply only when thinking will be emitted — an unconditional floor
        // silently overrode a deliberate small cap on thinking-off requests.
        let mut r = bare_req();
        r.max_tokens = Some(1024);
        r.thinking = Some(false);
        let (max, thinking) = anthropic_thinking_for(&r);
        assert_eq!(max, 1024);
        assert!(thinking.is_none());

        // The floor still applies when thinking is on (and the request stays
        // valid: budget < cap).
        r.thinking = Some(true);
        let (max, thinking) = anthropic_thinking_for(&r);
        assert_eq!(max, 3072);
        let t = thinking.expect("thinking on");
        assert!(t.budget_tokens < max);
    }

    // ---- Anthropic wire-body cache tests ----

    fn req_with(system: Option<String>) -> ChatRequest {
        ChatRequest {
            model: "claude-sonnet-4-5".to_string(),
            messages: vec![
                ChatMessage {
                    role: "user".to_string(),
                    content: "earlier question".to_string(),
                    images: Vec::new(),
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: "earlier answer".to_string(),
                    images: Vec::new(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: "new question".to_string(),
                    images: Vec::new(),
                },
            ],
            max_tokens: Some(4096),
            system,
            effort: None,
            thinking: None,
            local_docs_retrieval: Vec::new(),
            web_search_options: false,
            memory_context: None,
            cache_prompt: false,
        }
    }

    #[test]
    fn anthropic_wire_body_system_is_a_cached_block() {
        let req = req_with(Some("You are Relay.".to_string()));
        let thinking = None;
        // Rebuild the body the same way anthropic_request does.
        let mut messages: Vec<serde_json::Value> = req
            .messages
            .iter()
            .map(crate::chat::proto::anthropic_message_json)
            .collect();
        crate::chat::cache::mark_last_message(&mut messages);
        let body = AnthropicWireBody {
            model: req.model.clone(),
            messages,
            max_tokens: 4096,
            stream: true,
            system: req
                .system
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(crate::chat::cache::cached_system_block),
            thinking,
        };
        let json: serde_json::Value = serde_json::to_value(&body).unwrap();

        assert_eq!(json["system"][0]["type"], "text");
        assert_eq!(json["system"][0]["cache_control"]["type"], "ephemeral");
        // Only the newest message is marked; earlier ones stay plain strings.
        let msgs = json["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert!(msgs[0]["content"].is_string());
        assert!(msgs[1]["content"].is_string());
        assert_eq!(msgs[2]["content"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn anthropic_wire_body_empty_system_stays_absent() {
        let req = req_with(Some(String::new()));
        let system = req
            .system
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(crate::chat::cache::cached_system_block);
        assert!(system.is_none());
    }

    #[test]
    fn openai_wire_body_cache_marks_only_when_requested() {
        let req = req_with(Some("You are Relay.".to_string()));
        // Marks OFF — the flag is the caller's decision (OpenRouter gating on
        // `anthropic/*`), so a non-marked body never carries the field.
        let plain: serde_json::Value = serde_json::to_value(openai_wire_body(&req, false)).unwrap();
        assert!(!serde_json::to_string(&plain)
            .unwrap()
            .contains("cache_control"));
        assert!(plain["messages"][0]["content"].is_string());

        // Marks ON — system converted to a cached content-block array,
        // newest message marked, middle messages untouched strings.
        let marked: serde_json::Value = serde_json::to_value(openai_wire_body(&req, true)).unwrap();
        let msgs = marked["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"][0]["type"], "text");
        assert_eq!(msgs[0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(msgs[1]["content"].is_string());
        assert!(msgs[2]["content"].is_string());
        assert_eq!(msgs[3]["content"][0]["cache_control"]["type"], "ephemeral");

        // And the detector that gates the flag at the OpenRouter call site.
        assert!(crate::chat::cache::openrouter_anthropic(
            "anthropic/claude-sonnet-4.5"
        ));
        assert!(!crate::chat::cache::openrouter_anthropic("openai/gpt-4o"));
    }

    // ---- Anthropic SSE tests ----

    #[test]
    fn anthropic_parse_content_block_delta() {
        let provider = AnthropicProvider;
        let mut buf = String::new();

        // Simulate event + data lines arriving:
        let event_line = "event: content_block_delta";
        let (tok, done) = provider.parse_sse_chunk(event_line, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(!done);

        let data_line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert_eq!(tok, Some("Hello".to_string()));
        assert!(!done);
    }

    #[test]
    fn openai_parse_sse_delta_content_and_reasoning() {
        let provider = OpenAIProvider;
        let mut buf = String::new();

        // Plain content delta.
        let line = r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#;
        let (tok, done) = provider.parse_sse_chunk(line, &mut buf).unwrap();
        assert_eq!(tok, Some("Hi".to_string()));
        assert!(!done);

        // Reasoning models stream thinking under reasoning_content (or the
        // `reasoning` alias) — prefixed so the stream runner wraps it in
        // <think> for the collapsible reasoning block.
        let line = r#"data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}"#;
        let (tok, done) = provider.parse_sse_chunk(line, &mut buf).unwrap();
        assert_eq!(tok, Some(format!("{REASONING_PREFIX}thinking")));
        assert!(!done);

        // Non-data lines parse to nothing.
        let (tok, done) = provider.parse_sse_chunk("event: ping", &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(!done);
    }

    #[test]
    fn openai_parse_sse_done_and_finish_reason() {
        let provider = OpenAIProvider;
        let mut buf = String::new();

        let (tok, done) = provider.parse_sse_chunk("data: [DONE]", &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(done);

        // `finish_reason: "stop"` alone is mid-stream: the usage chunk and
        // `[DONE]` follow it, and ending the read at stop dropped usage on
        // every tools-off turn.
        let (tok, done) = provider
            .parse_sse_chunk(
                r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                &mut buf,
            )
            .unwrap();
        assert!(tok.is_none());
        assert!(!done);
    }

    #[test]
    fn openai_parse_sse_error_event_is_fatal() {
        let provider = OpenAIProvider;
        let mut buf = String::new();
        let err = provider
            .parse_sse_chunk(
                r#"data: {"error":{"message":"overloaded"}}"#,
                &mut buf,
            )
            .unwrap_err();
        assert!(err.contains("provider error: overloaded"), "{err}");
    }

    #[test]
    fn openai_parse_usage_reads_last_usage_line() {
        let provider = OpenAIProvider;
        let mut buf = String::new();
        // Only usage-bearing lines are retained in the buffer (mi24).
        provider
            .parse_sse_chunk(r#"data: {"choices":[{"delta":{"content":"a"}}]}"#, &mut buf)
            .unwrap();
        provider
            .parse_sse_chunk(
                r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}"#,
                &mut buf,
            )
            .unwrap();
        let usage = provider.parse_usage(&buf).expect("usage parsed");
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert!(usage.cost_usd > 0.0);
    }

    #[test]
    fn anthropic_parse_message_delta_with_usage() {
        let provider = AnthropicProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(done);

        let usage = provider.parse_usage(&buf);
        assert!(usage.is_some());
        let u = usage.unwrap();
        assert_eq!(u.output_tokens, 42);
        assert!(u.cost_usd > 0.0);
    }

    #[test]
    fn anthropic_parse_message_stop() {
        let provider = AnthropicProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"type":"message_stop"}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(done);
    }

    #[test]
    fn anthropic_parse_ping_is_ignored() {
        let provider = AnthropicProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"type":"ping"}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(!done);
    }

    #[test]
    fn anthropic_parse_usage_full() {
        let provider = AnthropicProvider;
        let buf = r#"
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":95}}
"#;
        let usage = provider.parse_usage(buf);
        assert!(usage.is_some());
        let u = usage.unwrap();
        assert_eq!(u.output_tokens, 95);
        assert_eq!(u.input_tokens, 0);
        assert!(u.cost_usd > 0.0);
    }

    #[test]
    fn anthropic_parse_usage_none() {
        let provider = AnthropicProvider;
        let buf = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n";
        let usage = provider.parse_usage(buf);
        assert!(usage.is_none());
    }

    // ---- OpenAI SSE tests ----

    #[test]
    fn openai_parse_delta_content() {
        let provider = OpenAIProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert_eq!(tok, Some("Hello".to_string()));
        assert!(!done);
    }

    #[test]
    fn openai_parse_done() {
        let provider = OpenAIProvider;
        let mut buf = String::new();

        let data_line = "data: [DONE]";
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(done);
    }

    #[test]
    fn openai_parse_final_chunk_with_usage() {
        let provider = OpenAIProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert!(tok.is_none());
        // A usage chunk is mid-stream — only `data: [DONE]` ends the read,
        // so a usage chunk arriving after (or carrying) finish_reason is
        // still captured by the runner.
        assert!(!done);

        let usage = provider.parse_usage(&buf);
        assert!(usage.is_some());
        let u = usage.unwrap();
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 50);
        assert!(u.cost_usd > 0.0);
    }

    #[test]
    fn openai_stop_chunk_is_not_terminal() {
        let provider = OpenAIProvider;
        let mut buf = String::new();

        let stop_line = r#"data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        let (tok, done) = provider.parse_sse_chunk(stop_line, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(!done, "finish_reason:stop must not end the read — the usage chunk follows it");

        // Content delivered in the same chunk as finish_reason still streams
        // and still doesn't end the read.
        let mut buf2 = String::new();
        let last_delta = r#"data: {"id":"x","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}"#;
        let (tok, done) = provider.parse_sse_chunk(last_delta, &mut buf2).unwrap();
        assert_eq!(tok, Some("done".to_string()));
        assert!(!done);
    }

    #[test]
    fn openai_parse_usage_captures_cache_and_reasoning_details() {
        let provider = OpenAIProvider;
        let buf = r#"data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":80,"prompt_tokens_details":{"cached_tokens":150},"completion_tokens_details":{"reasoning_tokens":30}}}
data: [DONE]
"#;
        let usage = provider.parse_usage(buf).expect("usage chunk must parse");
        assert_eq!(usage.input_tokens, 200);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.cache_read_input_tokens, 150);
        assert_eq!(usage.reasoning_tokens, 30);
    }

    #[test]
    fn openai_parse_usage_tolerates_data_prefix_without_space() {
        let provider = OpenAIProvider;
        // OpenRouter / vLLM emit `data:{…}` (no trailing space).
        let buf = r#"data:{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}
"#;
        let usage = provider.parse_usage(buf).expect("no-space data prefix must parse");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 5);
    }

    #[test]
    fn openai_parse_usage_captures_reported_cost() {
        let provider = OpenAIProvider;
        // OpenRouter's usage chunk carries the request's real cost.
        let buf = r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0123}}
"#;
        let usage = provider.parse_usage(buf).expect("usage chunk must parse");
        assert_eq!(usage.reported_cost_usd, Some(0.0123));
        // Endpoints without a cost field report None (estimate stays the
        // fallback), and a zero cost is treated as "not reported".
        let none_buf = r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}
"#;
        assert_eq!(provider.parse_usage(none_buf).unwrap().reported_cost_usd, None);
        let zero_buf = r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0}}
"#;
        assert_eq!(provider.parse_usage(zero_buf).unwrap().reported_cost_usd, None);
    }

    #[test]
    fn openai_wire_body_requests_usage_chunk() {
        let req = ChatRequest {
            model: "gpt-4o".to_string(),
            ..bare_req()
        };
        let body = openai_wire_body(&req, false);
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["stream_options"]["include_usage"], serde_json::json!(true));
        assert_eq!(json["stream"], serde_json::json!(true));
    }

    #[test]
    fn openai_wire_body_sends_cache_prompt_only_when_requested() {
        // Cloud OpenAI-family requests must NOT carry the field — those
        // endpoints reject unknown parameters — while LocalGguf sends
        // explicitly opt the sidecar's prompt cache in.
        let cloud = bare_req();
        let json = serde_json::to_value(openai_wire_body(&cloud, false)).unwrap();
        assert!(json.get("cache_prompt").is_none(), "{json}");

        let mut local = bare_req();
        local.cache_prompt = true;
        let json = serde_json::to_value(openai_wire_body(&local, false)).unwrap();
        assert_eq!(json["cache_prompt"], serde_json::json!(true));
    }

    #[test]
    fn openai_parse_usage_no_usage_field() {
        let provider = OpenAIProvider;
        let buf = r#"data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
"#;
        let usage = provider.parse_usage(buf);
        assert!(usage.is_none());
    }

    #[test]
    fn anthropic_compatible_delegates_to_anthropic() {
        let provider = AnthropicCompatibleProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert_eq!(tok, Some("Hi".to_string()));
        assert!(!done);

        let buf2 = r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":20}}"#;
        let usage = provider.parse_usage(buf2);
        assert!(usage.is_some());
        let u = usage.unwrap();
        assert_eq!(u.input_tokens, 10);
        assert_eq!(u.output_tokens, 20);
    }

    #[test]
    fn openai_compatible_delegates_to_openai() {
        let provider = OpenAICompatibleProvider;
        let mut buf = String::new();

        let data_line = r#"data: {"id":"x","choices":[{"index":0,"delta":{"content":"hey"},"finish_reason":null}]}"#;
        let (tok, done) = provider.parse_sse_chunk(data_line, &mut buf).unwrap();
        assert_eq!(tok, Some("hey".to_string()));
        assert!(!done);
    }

    // ---- Responses wire tests ----

    #[test]
    fn responses_wire_body_is_instructions_plus_input_items() {
        let req = req_with(Some("You are Relay.".to_string()));
        let input: Vec<serde_json::Value> = req
            .messages
            .iter()
            .map(crate::chat::proto::responses_message_json)
            .collect();
        let body = responses_wire_body(&req, input, Vec::new());

        assert_eq!(body["model"], serde_json::json!("claude-sonnet-4-5"));
        assert_eq!(body["instructions"], serde_json::json!("You are Relay."));
        assert_eq!(body["stream"], serde_json::json!(true));
        // Retention opt-out — prompts are the user's, not OpenAI's training set.
        assert_eq!(body["store"], serde_json::json!(false));
        // No system message on this wire; the roles carry only the turns.
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["role"], "user");
        assert!(body.get("tools").is_none(), "no tools on the plain path");
        // Non-reasoning model + a set cap → max_output_tokens (the Responses
        // spelling of max_tokens).
        assert_eq!(body["max_output_tokens"], serde_json::json!(4096));
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn responses_wire_body_reasoning_model_omits_the_cap_and_sends_effort() {
        let mut req = req_with(None);
        req.model = "gpt-5-codex".to_string();
        req.effort = Some("high".to_string());
        let body = responses_wire_body(&req, Vec::new(), Vec::new());
        // gpt-5-family endpoints reject the plain cap field.
        assert!(body.get("max_output_tokens").is_none(), "{body}");
        assert_eq!(body["reasoning"]["effort"], serde_json::json!("high"));
        // No system prompt → no instructions key at all.
        assert!(body.get("instructions").is_none());
    }

    #[test]
    fn responses_message_json_is_string_for_text_and_parts_for_images() {
        let text = crate::chat::providers::ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
            images: Vec::new(),
        };
        assert!(crate::chat::proto::responses_message_json(&text)["content"].is_string());

        let with_image = crate::chat::providers::ChatMessage {
            role: "user".to_string(),
            content: "look".to_string(),
            images: vec![crate::chat::providers::ChatImage {
                media_type: "image/png".to_string(),
                data: "AAAA".to_string(),
            }],
        };
        let item = crate::chat::proto::responses_message_json(&with_image);
        assert_eq!(item["content"][0]["type"], "input_text");
        assert_eq!(item["content"][1]["type"], "input_image");
        assert_eq!(
            item["content"][1]["image_url"],
            serde_json::json!("data:image/png;base64,AAAA")
        );
    }

    #[test]
    fn responses_parse_streams_text_and_reasoning() {
        let provider = OpenAIResponsesProvider;
        let mut buf = String::new();

        let text = r#"data: {"type":"response.output_text.delta","delta":"Hello"}"#;
        let (tok, done) = provider.parse_sse_chunk(text, &mut buf).unwrap();
        assert_eq!(tok, Some("Hello".to_string()));
        assert!(!done);

        let reasoning =
            r#"data: {"type":"response.reasoning_summary_text.delta","delta":"hmm"}"#;
        let (tok, done) = provider.parse_sse_chunk(reasoning, &mut buf).unwrap();
        assert_eq!(tok, Some(format!("{REASONING_PREFIX}hmm")));
        assert!(!done);

        // Non-terminal bookkeeping events stay quiet.
        let added = r#"data: {"type":"response.output_item.added","item":{"type":"function_call"}}"#;
        let (tok, done) = provider.parse_sse_chunk(added, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(!done);

        let completed = r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let (tok, done) = provider.parse_sse_chunk(completed, &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(done, "response.completed terminates the stream");
    }

    #[test]
    fn responses_parse_usage_reads_the_completed_event() {
        let provider = OpenAIResponsesProvider;
        let mut buf = String::new();
        let completed = r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":200,"output_tokens":80,"input_tokens_details":{"cached_tokens":150},"output_tokens_details":{"reasoning_tokens":30}}}}"#;
        provider.parse_sse_chunk(completed, &mut buf).unwrap();

        let usage = provider.parse_usage(&buf).expect("usage parsed");
        assert_eq!(usage.input_tokens, 200);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.cache_read_input_tokens, 150);
        assert_eq!(usage.reasoning_tokens, 30);
        assert!(usage.cost_usd > 0.0);
    }

    #[test]
    fn responses_parse_error_events_are_fatal() {
        let provider = OpenAIResponsesProvider;
        let mut buf = String::new();
        let err = provider
            .parse_sse_chunk(
                r#"data: {"type":"error","message":"overloaded"}"#,
                &mut buf,
            )
            .unwrap_err();
        assert!(err.contains("provider error: overloaded"), "{err}");

        let failed = provider
            .parse_sse_chunk(
                r#"data: {"type":"response.failed","response":{"error":{"message":"model not found"}}}"#,
                &mut buf,
            )
            .unwrap_err();
        assert!(failed.contains("provider error: model not found"), "{failed}");

        // A top-level {"error": …} frame (proxy rejections) fails too.
        let top = provider
            .parse_sse_chunk(r#"data: {"error":{"message":"bad key"}}"#, &mut buf)
            .unwrap_err();
        assert!(top.contains("provider error: bad key"), "{top}");
    }

    #[test]
    fn responses_parse_done_sentinel_is_terminal() {
        // A few gateways end a Responses stream with the chat-completions
        // sentinel instead of relying on response.completed.
        let provider = OpenAIResponsesProvider;
        let mut buf = String::new();
        let (tok, done) = provider.parse_sse_chunk("data: [DONE]", &mut buf).unwrap();
        assert!(tok.is_none());
        assert!(done);
    }

    #[test]
    fn openai_chat_kind_requires_a_base_url_and_routes_bearer() {
        let provider = OpenAIChatProvider;
        let req = bare_req();
        let client = reqwest::Client::new();
        assert!(provider.build_request(&client, &req, "k", None).is_err());
        let built = provider
            .build_request(&client, &req, "k", Some("https://relay.example.com"))
            .expect("with a base");
        let request = built.build().unwrap();
        assert_eq!(request.url().as_str(), "https://relay.example.com/v1/chat/completions");
        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer k"
        );
        assert_eq!(provider.id(), ChatProviderId::OpenAIChat);
    }

    #[test]
    fn responses_kind_requires_a_base_url_and_posts_to_v1_responses() {
        let provider = OpenAIResponsesProvider;
        let req = bare_req();
        let client = reqwest::Client::new();
        assert!(provider.build_request(&client, &req, "k", None).is_err());
        let built = provider
            .build_request(&client, &req, "k", Some("https://relay.example.com"))
            .expect("with a base");
        let request = built.build().unwrap();
        assert_eq!(request.url().as_str(), "https://relay.example.com/v1/responses");
        assert_eq!(provider.id(), ChatProviderId::OpenAIResponses);
    }

    // ---- Base-URL canonicalization ----

    #[test]
    fn normalize_base_url_strips_a_pasted_v1_suffix() {
        // The reported failure: providers document `https://host/v1/chat/...`,
        // so the pasted base ended in `/v1` and every built path doubled it
        // (`.../v1/v1/chat/completions` → the relay's 404 "not a registered API
        // route", which reads as a broken key).
        assert_eq!(
            normalize_base_url("https://api.commandcode.ai/provider/v1"),
            "https://api.commandcode.ai/provider"
        );
        assert_eq!(
            normalize_base_url("  https://api.commandcode.ai/provider/v1/  "),
            "https://api.commandcode.ai/provider"
        );
        // Trailing slashes alone would produce `//v1/...` inside built paths.
        assert_eq!(
            normalize_base_url("https://relay.example.com/"),
            "https://relay.example.com"
        );
        assert_eq!(
            normalize_base_url("https://relay.example.com/v1"),
            "https://relay.example.com"
        );
    }

    #[test]
    fn normalize_base_url_leaves_other_shapes_alone() {
        for unchanged in [
            "https://api.openai.com",
            // Only a pure `/v1` segment — never a lookalike prefix.
            "https://host/api/v1beta",
            "https://host/v10",
            "https://openrouter.ai/api",
            "https://host/api/v1/segment",
            "",
            "/v1",
        ] {
            assert_eq!(normalize_base_url(unchanged), unchanged, "{unchanged}");
        }
        // Idempotent: configure() re-runs the migration over stored rows.
        let once = normalize_base_url("https://host/api/v1");
        assert_eq!(normalize_base_url(&once), once);
    }

    // ---- Catalog wiring pins ----
    //
    // One list, checked through EVERY seam a kind string travels: the
    // known-kind gate `set_chat_api_key` validates against, `provider_kind`'s
    // instance-id stripping, the send-path `parse_provider_id`, and
    // `resolve_provider`. A kind added to the enum but missed in any one of
    // them previously failed only at runtime — "unknown provider kind" on
    // save, an "unknown provider" send error, or a silently dead picker pane.
    // Adding a kind means adding it here; the count assertion makes that
    // unavoidable.
    #[test]
    fn every_kind_resolves_through_every_seam() {
        const KINDS: &[&str] = &[
            "anthropic",
            "openai",
            "openai_chat",
            "openai_responses",
            "openrouter",
            "anthropic_compatible",
            "openai_compatible",
            "local_gguf",
        ];

        for kind in KINDS {
            assert!(is_known_kind(kind), "is_known_kind must accept {kind}");
            assert_eq!(provider_kind(kind), *kind, "provider_kind({kind})");
            // Named endpoints ("<kind>-<suffix>") must resolve to the kind.
            let instance = format!("{kind}-x7f2");
            assert_eq!(
                provider_kind(&instance),
                *kind,
                "provider_kind({instance}) must strip the instance suffix"
            );

            // String → enum → string round trip, both id shapes.
            let id = crate::chat::commands::parse_provider_id(kind)
                .unwrap_or_else(|| panic!("parse_provider_id({kind})"));
            assert_eq!(id.as_str(), *kind, "as_str round trip for {kind}");
            assert_eq!(
                crate::chat::commands::parse_provider_id(&instance),
                Some(id),
                "parse_provider_id({instance})"
            );

            // A provider instance exists and reports the same id (the read
            // that drives every wire branch).
            assert_eq!(crate::chat::streaming::resolve_provider(&id).id(), id);
        }

        // Keep the list (and therefore the enum) honest.
        assert_eq!(KINDS.len(), 8, "a kind was added or removed — update this pin");
    }
}
