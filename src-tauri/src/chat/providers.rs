//! Chat provider implementations: Anthropic, OpenAI, and compatible variants.
//!
//! Each provider builds the correct HTTP request and parses the SSE stream
//! into tokens and usage info. SSE parsing is tested with real payload samples.

use serde::{Deserialize, Serialize};

// ---- Shared types ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatProviderId {
    Anthropic,
    OpenAI,
    AnthropicCompatible,
    OpenAICompatible,
    OpenRouter,
    LocalGguf,
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
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChatUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

/// Private-use char prefixed to reasoning/thinking tokens so the stream
/// runner can distinguish them from answer tokens and wrap them in
/// `<think>…</think>` for the frontend's collapsible thinking block.
pub const REASONING_PREFIX: char = '\u{E000}';

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
struct AnthropicWireMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct AnthropicWireBody {
    model: String,
    messages: Vec<AnthropicWireMessage>,
    max_tokens: i64,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
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
struct AnthropicThinking {
    #[serde(rename = "type")]
    kind: &'static str,
    budget_tokens: i64,
}

#[derive(Serialize)]
struct OpenAIWireMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct OpenAIWireBody {
    model: String,
    messages: Vec<OpenAIWireMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
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
    let max_tokens = req.max_tokens.unwrap_or(4096);
    // Reserve at least 1024 tokens for the visible answer; cap the thinking
    // budget at the rest. Anthropic requires `budget_tokens < max_tokens`.
    let thinking = req.thinking.unwrap_or(false).then(|| AnthropicThinking {
        kind: "enabled",
        budget_tokens: (max_tokens - 1024).max(1024),
    });
    let body = AnthropicWireBody {
        model: req.model.clone(),
        messages: req
            .messages
            .iter()
            .map(|m| AnthropicWireMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect(),
        max_tokens,
        stream: true,
        system: req.system.clone(),
        thinking,
    };
    client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
}

/// Build the OpenAI `/v1/chat/completions` streaming request. Both
/// `OpenAIProvider` and `OpenAICompatibleProvider` route through here.
fn openai_request(
    client: &reqwest::Client,
    req: &ChatRequest,
    api_key: &str,
    base: &str,
) -> reqwest::RequestBuilder {
    let url = format!("{base}/v1/chat/completions");
    let mut messages: Vec<OpenAIWireMessage> = Vec::new();
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            messages.push(OpenAIWireMessage {
                role: "system".to_string(),
                content: sys.clone(),
            });
        }
    }
    messages.extend(req.messages.iter().map(|m| OpenAIWireMessage {
        role: m.role.clone(),
        content: m.content.clone(),
    }));
    let body = OpenAIWireBody {
        model: req.model.clone(),
        messages,
        stream: true,
        reasoning_effort: req.effort.clone(),
    };
    client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
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
        "claude-sonnet-4-5-20250929"
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
        buf.push_str(line);
        buf.push('\n');

        // Anthropic SSE: lines prefixed with "event:" and "data:"
        if line.starts_with("data: ") {
            let data = &line[6..];

            #[derive(Deserialize)]
            struct SsePayload {
                #[serde(rename = "type")]
                event_type: String,
                delta: Option<Delta>,
                usage: Option<serde_json::Value>,
            }

            #[derive(Deserialize)]
            struct Delta {
                text: Option<String>,
            }

            let payload: SsePayload =
                serde_json::from_str(data).map_err(|e| format!("SSE parse error: {e}"))?;

            match payload.event_type.as_str() {
                "content_block_delta" => {
                    if let Some(ref delta) = payload.delta {
                        if let Some(ref text) = delta.text {
                            return Ok((Some(text.clone()), false));
                        }
                    }
                }
                "message_delta" | "message_stop" => {
                    // Usage will be in the payload; we keep it in buf.
                    return Ok((None, true));
                }
                "ping" => {}
                _ => {}
            }
        }

        Ok((None, false))
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        // Usage in Anthropic appears in the message_delta or message_stop
        // events. Search backwards through the buffer for the event that
        // carries usage.
        for line in buf.lines().rev() {
            if let Some(data) = line.strip_prefix("data: ") {
                #[derive(Deserialize)]
                struct UsageEvent {
                    usage: Option<UsageData>,
                }
                #[derive(Deserialize)]
                struct UsageData {
                    input_tokens: Option<i64>,
                    output_tokens: Option<i64>,
                }
                if let Ok(ev) = serde_json::from_str::<UsageEvent>(data) {
                    if let Some(u) = ev.usage {
                        let input = u.input_tokens.unwrap_or(0);
                        let output = u.output_tokens.unwrap_or(0);
                        let cost = calculate_anthropic_cost(input, output);
                        return Some(ChatUsage {
                            input_tokens: input,
                            output_tokens: output,
                            cost_usd: cost,
                        });
                    }
                }
            }
        }
        None
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
        "gpt-4o"
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
        buf.push_str(line);
        buf.push('\n');

        if line.starts_with("data: ") {
            let data = &line[6..];

            if data == "[DONE]" {
                return Ok((None, true));
            }

            #[derive(Deserialize)]
            struct SsePayload {
                choices: Option<Vec<Choice>>,
                usage: Option<serde_json::Value>,
            }

            #[derive(Deserialize)]
            struct Choice {
                delta: Option<Delta>,
                finish_reason: Option<String>,
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

            // Check for final chunk (may have usage, may have finish_reason).
            let mut is_done = false;
            if let Some(ref choices) = payload.choices {
                for choice in choices {
                    if choice.finish_reason.as_deref() == Some("stop") {
                        is_done = true;
                    }
                    if let Some(ref delta) = choice.delta {
                        if let Some(ref content) = delta.content {
                            if !content.is_empty() {
                                return Ok((Some(content.clone()), false));
                            }
                        }
                        if let Some(reasoning) = delta
                            .reasoning_content
                            .as_ref()
                            .or(delta.reasoning.as_ref())
                        {
                            if !reasoning.is_empty() {
                                return Ok((
                                    Some(format!("{REASONING_PREFIX}{reasoning}")),
                                    false,
                                ));
                            }
                        }
                    }
                }
            }

            // Some compatible endpoints send usage on the same chunk as finish.
            if payload.usage.is_some() || is_done {
                return Ok((None, payload.usage.is_some() || is_done));
            }
        }

        Ok((None, false))
    }

    fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
        // Usage in OpenAI appears in the final chunk with usage object.
        // Search for the last data line that contains usage.
        for line in buf.lines().rev() {
            if let Some(data) = line.strip_prefix("data: ") {
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
                    total_tokens: Option<i64>,
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
                        });
                    }
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
        "claude-sonnet-4-5-20250929"
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
        "gpt-4o"
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
        "openai/gpt-4o"
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base = base_url.unwrap_or(Self::DEFAULT_BASE);
        Ok(openai_request(client, req, api_key, base)
            .header("HTTP-Referer", "https://conduit.app")
            .header("X-Title", "Conduit"))
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
        "local"
    }

    fn build_request(
        &self,
        client: &reqwest::Client,
        req: &ChatRequest,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let base =
            base_url.ok_or_else(|| "base_url is required for LocalGguf".to_string())?;
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
        assert!(done);

        let usage = provider.parse_usage(&buf);
        assert!(usage.is_some());
        let u = usage.unwrap();
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 50);
        assert!(u.cost_usd > 0.0);
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
}
