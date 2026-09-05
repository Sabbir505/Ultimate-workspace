//! Prompt-cache plumbing for Anthropic-style requests.
//!
//! Without an explicit `cache_control` breakpoint the Anthropic API bills the
//! FULL prefix (tools → system → messages) at base input price on every
//! request. The agentic tool loop re-sends that prefix up to
//! `MAX_TOOL_ITERS` (45, or 96 in research mode) times per turn, so an
//! uncached long session pays the same stable prefix over and over at 10× the
//! cached rate. Placing breakpoints marks the longest stable content — tools,
//! system prompt, and everything up to the newest message — so each round
//! re-reads the prefix as cache hits (0.1× input price) and only pays the
//! 1.25× write premium on the round's fresh tail once.
//!
//! Breakpoint budget: the API allows 4 per request; we use 3 (last tool, the
//! system block, the last message block). Cache entries live 5 minutes, which
//! comfortably covers the seconds-long gaps between tool rounds and
//! back-to-back turns in an active session.
//!
//! OpenAI-style providers cache the ≥1,024-token prefix automatically (no
//! wire flag), which is why this module only touches Anthropic-shaped bodies —
//! but prefix *stability* matters for both, so nothing here may reorder or
//! mutate conversation content in a provider-visible way across rounds.

use serde_json::{json, Value};

/// The ephemeral (5-minute TTL) cache-control block the API expects.
pub(crate) fn cache_control() -> Value {
    json!({ "type": "ephemeral" })
}

/// Mark the LAST tool spec so the whole `tools` array caches as one prefix
/// segment (the API caches everything up to each breakpoint).
pub(crate) fn mark_last_tool(specs: &mut [Value]) {
    if let Some(last) = specs.last_mut() {
        last["cache_control"] = cache_control();
    }
}

/// Render the system prompt as a cached content-block array. The API accepts
/// either a bare string or a block array for `system`; only the block form
/// can carry `cache_control`.
pub(crate) fn cached_system_block(sys: &str) -> Value {
    json!([{
        "type": "text",
        "text": sys,
        "cache_control": cache_control(),
    }])
}

/// Mark the last cacheable content block of the last message so the request's
/// entire prefix (tools → system → messages) caches incrementally: each round
/// re-reads everything up to the previous round as a cache hit and writes only
/// the newly appended tail.
///
/// A plain-string `content` is upgraded to a one-block array (both forms are
/// accepted on the wire). `thinking` / `redacted_thinking` blocks cannot carry
/// `cache_control`, so the mark lands on the newest block before them.
pub(crate) fn mark_last_message(messages: &mut [Value]) {
    let Some(last) = messages.last_mut() else {
        return;
    };
    match last.get_mut("content") {
        Some(Value::String(s)) => {
            let text = std::mem::take(s);
            last["content"] = json!([{
                "type": "text",
                "text": text,
                "cache_control": cache_control(),
            }]);
        }
        Some(Value::Array(blocks)) => {
            for block in blocks.iter_mut().rev() {
                let ty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ty == "thinking" || ty == "redacted_thinking" {
                    continue;
                }
                block["cache_control"] = cache_control();
                break;
            }
        }
        _ => {}
    }
}

/// Recursively remove every `cache_control` key from a request body. Used as
/// the fallback when an Anthropic-compatible gateway rejects the field
/// outright (HTTP 400 naming `cache_control`/`ephemeral`) — the turn then
/// retries once without caching instead of failing.
pub(crate) fn strip_cache_control(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("cache_control");
            for (_, v) in map.iter_mut() {
                strip_cache_control(v);
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                strip_cache_control(v);
            }
        }
        _ => {}
    }
}

/// Does this HTTP error read as a gateway rejecting the cache fields?
pub(crate) fn is_cache_rejection(err: &str) -> bool {
    err.contains("cache_control") || err.contains("ephemeral")
}

/// Does this OpenRouter model id serve an Anthropic-family model? OpenRouter
/// prefixes every model id with its vendor (`anthropic/claude-…`), and only
/// that family accepts Anthropic-style `cache_control` passthrough on the
/// OpenAI wire format — OpenRouter translates the marks into native Claude
/// prompt caching. Other vendors' backends must NOT receive the marks:
/// unknown request fields can 400 on stricter servers, so the caller gates
/// on this and never marks anything else.
pub(crate) fn openrouter_anthropic(model: &str) -> bool {
    model.to_ascii_lowercase().starts_with("anthropic/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_only_the_last_tool() {
        let mut specs = vec![
            json!({"name": "a", "input_schema": {}}),
            json!({"name": "b", "input_schema": {}}),
        ];
        mark_last_tool(&mut specs);
        assert!(specs[0].get("cache_control").is_none());
        assert_eq!(specs[1]["cache_control"]["type"], "ephemeral");
        assert!(!is_cache_rejection("some other failure"));
    }

    #[test]
    fn openrouter_detection_matches_the_vendor_prefix_only() {
        assert!(openrouter_anthropic("anthropic/claude-sonnet-4.5"));
        assert!(openrouter_anthropic("Anthropic/Claude-3-Haiku:beta"));
        assert!(!openrouter_anthropic("openai/gpt-4o"));
        assert!(!openrouter_anthropic("meta-llama/llama-3.1-70b"));
        // Native Anthropic model ids have no vendor prefix — they get marks
        // through the Anthropic-shaped loop, never via this detector.
        assert!(!openrouter_anthropic("claude-sonnet-4-5"));
        assert!(!openrouter_anthropic("anthropic"));
    }

    #[test]
    fn system_string_becomes_cached_block_array() {
        let sys = cached_system_block("You are Relay.");
        assert!(sys.is_array());
        assert_eq!(sys[0]["type"], "text");
        assert_eq!(sys[0]["text"], "You are Relay.");
        assert_eq!(sys[0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn string_content_is_upgraded_to_cached_block() {
        let mut messages = vec![
            json!({"role": "user", "content": "earlier"}),
            json!({"role": "user", "content": "newest"}),
        ];
        mark_last_message(&mut messages);
        // Earlier message untouched (plain string, no cache_control).
        assert!(messages[0]["content"].is_string());
        let blocks = messages[1]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "newest");
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn array_content_marks_last_block_only() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "r1"},
                {"type": "tool_result", "tool_use_id": "t2", "content": "r2"},
            ]
        })];
        mark_last_message(&mut messages);
        let blocks = messages[0]["content"].as_array().unwrap();
        assert!(blocks[0].get("cache_control").is_none());
        assert_eq!(blocks[1]["cache_control"]["type"], "ephemeral");
        // The tool_result payload itself is unchanged.
        assert_eq!(blocks[1]["content"], "r2");
    }

    #[test]
    fn thinking_blocks_are_skipped_for_the_mark() {
        let mut messages = vec![json!({
            "role": "assistant",
            "content": [
                {"type": "text", "text": "reasoning out"},
                {"type": "thinking", "thinking": "...", "signature": "sig"},
            ]
        })];
        mark_last_message(&mut messages);
        let blocks = messages[0]["content"].as_array().unwrap();
        assert!(blocks[1].get("cache_control").is_none());
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn empty_messages_are_a_noop() {
        let mut messages: Vec<Value> = Vec::new();
        mark_last_message(&mut messages);
        assert!(messages.is_empty());
    }

    #[test]
    fn strip_removes_every_cache_control() {
        let mut body = json!({
            "system": [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}],
            "tools": [{"name": "a", "cache_control": {"type": "ephemeral"}}],
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "x", "cache_control": {"type": "ephemeral"}}
                ]},
            ],
        });
        strip_cache_control(&mut body);
        let flat = serde_json::to_string(&body).unwrap();
        assert!(!flat.contains("cache_control"));
        // Everything else survives.
        assert_eq!(body["tools"][0]["name"], "a");
        assert_eq!(body["messages"][0]["content"][0]["text"], "x");
    }
}
