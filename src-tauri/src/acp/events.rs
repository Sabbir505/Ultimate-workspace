//! ACP notification → chat-event translation (roadmap #20).
//!
//! The headless chat layer normalizes every agent onto the built-in chat's
//! token stream (`chat:token`, `<tool>` markers, `chat:error`). This module
//! distills ACP `session/update` content items into the same vocabulary:
//! text deltas → plain tokens, reasoning deltas → `<think>…</think>` blocks,
//! tool calls → `<tool>` markers (the reader replies with an error result —
//! v1 doesn't execute ACP tools). Pure functions, unit-tested with canned
//! protocol fixtures.

use serde_json::Value;

/// A distilled unit from an ACP `session/update` / `session/finish` / error.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpEvent {
    /// Plain text delta → `emit_token`.
    Text(String),
    /// Reasoning/thinking delta → emitted wrapped in `<think>…</think>`.
    Reasoning(String),
    /// Tool invocation → `<tool>{meta}</tool>` marker (not executed in v1).
    ToolCall { id: String, name: String, input: Value },
    /// The turn ended normally (`session/finish`).
    Finished,
    /// The turn failed (`session/error`).
    Failed(String),
    /// The agent asked the client something (`session/prompt`) — out of scope.
    PromptIgnored,
}

/// Token/cost accounting attached to a turn by an agent that reports usage.
/// ACP v1 does not define a usage field — this is a best-effort read of the
/// extension key agents actually emit (`usage` on `session/update` /
/// `session/finish` params or on the finish's `message`). When nothing is
/// reported the reader falls back to a char-based estimate so the composer
/// HUD and DB token accounting aren't permanently empty for ACP sessions.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AcpUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
}

impl AcpUsage {
    /// Field-wise merge used to fold successive updates — a later report
    /// overrides only the fields it actually carries.
    pub fn merge(&mut self, other: AcpUsage) {
        if other.input_tokens.is_some() {
            self.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.output_tokens = other.output_tokens;
        }
        if other.cache_read_tokens.is_some() {
            self.cache_read_tokens = other.cache_read_tokens;
        }
        if other.cache_write_tokens.is_some() {
            self.cache_write_tokens = other.cache_write_tokens;
        }
        if other.cost_usd.is_some() {
            self.cost_usd = other.cost_usd;
        }
    }
}

/// Read one optional i64 out of a JSON object trying several key spellings
/// (snake_case per the rest of ACP, camelCase per the pi-lineage agents that
/// also speak this protocol shape).
fn i64_field(obj: &Value, keys: &[&str]) -> Option<i64> {
    let o = obj.as_object()?;
    keys.iter().find_map(|k| o.get(*k).and_then(|v| v.as_i64()))
}

/// Best-effort usage extraction from a `session/update` / `session/finish`
/// params object. Returns `None` when no usage-shaped object is present (the
/// common case — ACP v1 doesn't define one); `Some` carries only the fields
/// the agent actually sent.
pub fn extract_usage(params: &Value) -> Option<AcpUsage> {
    // The usage object can sit at the params root, under `message` (the
    // finish summary shape), or under a `usage` key on either.
    let candidates = [
        params.get("usage"),
        params.get("message").and_then(|m| m.get("usage")),
    ];
    let usage = candidates.into_iter().flatten().find(|u| u.is_object())?;
    let mut out = AcpUsage {
        input_tokens: i64_field(
            usage,
            &["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
        ),
        output_tokens: i64_field(
            usage,
            &["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
        ),
        cache_read_tokens: i64_field(
            usage,
            &["cache_read_tokens", "cacheReadTokens", "cache_read_input_tokens", "cached_tokens"],
        ),
        cache_write_tokens: i64_field(
            usage,
            &["cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens"],
        ),
        cost_usd: usage
            .as_object()
            .and_then(|o| {
                o.get("cost").and_then(|c| {
                    c.as_f64()
                        .or_else(|| c.get("total").and_then(|t| t.as_f64()))
                })
            })
            .or_else(|| i64_field(usage, &["total_cost_usd"]).map(|v| v as f64))
            .or_else(|| {
                usage
                    .as_object()?
                    .get("cost_usd")
                    .and_then(|c| c.as_f64())
            }),
    };
    if out == AcpUsage::default() {
        // A usage object carrying none of the recognized keys is noise, not
        // an empty report — treat it as absent so the estimator runs.
        return None;
    }
    // Fold a root-level cost that sits outside the usage object (some agents
    // put `cost` next to `usage`).
    if out.cost_usd.is_none() {
        if let Some(cost) = params
            .as_object()
            .and_then(|o| o.get("cost"))
            .and_then(|c| c.as_f64())
        {
            out.cost_usd = Some(cost);
        }
    }
    Some(out)
}

/// Pull the content-item array from a notification's params. ACP puts the
/// turn's streamed items in `content` for `session/update`, and the final
/// summary inside `message.content` for `session/finish` — accept both.
fn content_items(params: &Value) -> Vec<Value> {
    let direct = params.get("content").and_then(|c| c.as_array());
    if let Some(items) = direct {
        return items.clone();
    }
    params
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Map one content item to events (most items produce at most one).
fn item_to_events(item: &Value) -> Vec<AcpEvent> {
    let Some(obj) = item.as_object() else {
        return vec![];
    };
    match obj.get("type").and_then(|t| t.as_str()) {
        Some("text") => {
            let text = obj.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if text.is_empty() {
                vec![]
            } else {
                vec![AcpEvent::Text(text.to_string())]
            }
        }
        Some("reasoning") => {
            let text = obj.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if text.is_empty() {
                vec![]
            } else {
                vec![AcpEvent::Reasoning(text.to_string())]
            }
        }
        Some("tool_call") => {
            // ACP nests the call under `tool_call`; some agents put the fields
            // at the top level. Accept both.
            let tc = obj.get("tool_call").and_then(|t| t.as_object());
            let get = |key: &str| -> Option<String> {
                if let Some(tc) = tc {
                    tc.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
                }
            };
            let id = get("id").unwrap_or_default();
            let name = get("name").unwrap_or_else(|| "tool".to_string());
            let input = if let Some(tc) = tc {
                tc.get("input").cloned()
            } else {
                obj.get("input").cloned()
            };
            vec![AcpEvent::ToolCall {
                id,
                name,
                input: input.unwrap_or(Value::Null),
            }]
        }
        // Progress/command/attachment items are decorative — the text items
        // alongside them carry the readable content.
        Some("progress") | Some("command") | Some("attachment") => vec![],
        _ => vec![],
    }
}

/// Translate a `session/update` notification's params into events.
pub fn translate_session_update(params: &Value) -> Vec<AcpEvent> {
    content_items(params).iter().flat_map(item_to_events).collect()
}

/// Translate a `session/finish` notification's params: drain any final
/// message content, then signal the turn finished.
pub fn translate_session_finish(params: &Value) -> Vec<AcpEvent> {
    let mut events: Vec<AcpEvent> = content_items(params).iter().flat_map(item_to_events).collect();
    events.push(AcpEvent::Finished);
    events
}

/// Translate a `session/error` notification's params into a Failed event.
pub fn translate_session_error(params: &Value) -> AcpEvent {
    let msg = params
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("ACP session error");
    AcpEvent::Failed(msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn update_with_text_and_reasoning() {
        let params = json!({
            "sessionId": "s1",
            "content": [
                { "type": "text", "text": "Hello" },
                { "type": "reasoning", "text": "let me think" },
                { "type": "text", "text": " world" },
            ],
        });
        let events = translate_session_update(&params);
        assert_eq!(
            events,
            vec![
                AcpEvent::Text("Hello".into()),
                AcpEvent::Reasoning("let me think".into()),
                AcpEvent::Text(" world".into()),
            ]
        );
    }

    #[test]
    fn update_with_tool_call_both_shapes() {
        // Nested shape (spec).
        let nested = json!({
            "sessionId": "s1",
            "content": [{
                "type": "tool_call",
                "tool_call": { "id": "t1", "name": "read_file", "input": { "file_path": "a.rs" } },
            }],
        });
        match translate_session_update(&nested).remove(0) {
            AcpEvent::ToolCall { id, name, input } => {
                assert_eq!(id, "t1");
                assert_eq!(name, "read_file");
                assert_eq!(input["file_path"], "a.rs");
            }
            other => panic!("expected tool_call, got {other:?}"),
        }
        // Flat shape (lenient).
        let flat = json!({
            "sessionId": "s1",
            "content": [{ "type": "tool_call", "id": "t2", "name": "bash", "input": { "command": "ls" } }],
        });
        match translate_session_update(&flat).remove(0) {
            AcpEvent::ToolCall { id, name, .. } => {
                assert_eq!(id, "t2");
                assert_eq!(name, "bash");
            }
            other => panic!("expected tool_call, got {other:?}"),
        }
    }

    #[test]
    fn finish_drains_final_message_and_ends() {
        let params = json!({
            "sessionId": "s1",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "done now" }],
            },
        });
        let events = translate_session_finish(&params);
        assert_eq!(
            events,
            vec![AcpEvent::Text("done now".into()), AcpEvent::Finished]
        );
    }

    #[test]
    fn error_and_ignored_items() {
        assert_eq!(
            translate_session_error(&json!({ "sessionId": "s1", "error": { "code": 1, "message": "boom" } })),
            AcpEvent::Failed("boom".into())
        );
        assert_eq!(
            translate_session_error(&json!({ "sessionId": "s1" })),
            AcpEvent::Failed("ACP session error".into())
        );
        // progress + empty text items produce nothing.
        let params = json!({
            "content": [
                { "type": "progress", "progress": { "value": 0.5 } },
                { "type": "text", "text": "" },
                { "type": "unknown", "whatever": true },
            ],
        });
        assert!(translate_session_update(&params).is_empty());
    }

    #[test]
    fn usage_absent_for_plain_updates() {
        // ACP v1 has no usage field — a spec-conformant update must read as
        // "no usage reported" so the estimator runs.
        let params = json!({ "sessionId": "s1", "content": [{ "type": "text", "text": "hi" }] });
        assert_eq!(extract_usage(&params), None);
    }

    #[test]
    fn usage_extracted_from_extension_object() {
        // An agent that extends the protocol with a usage object gets its
        // numbers read — snake_case spellings.
        let params = json!({
            "sessionId": "s1",
            "usage": {
                "input_tokens": 120,
                "output_tokens": 45,
                "cache_read_tokens": 100,
                "cache_write_tokens": 20,
            },
        });
        let u = extract_usage(&params).expect("usage object must be recognized");
        assert_eq!(u.input_tokens, Some(120));
        assert_eq!(u.output_tokens, Some(45));
        assert_eq!(u.cache_read_tokens, Some(100));
        assert_eq!(u.cache_write_tokens, Some(20));
        assert_eq!(u.cost_usd, None);
    }

    #[test]
    fn usage_extracted_camel_case_and_message_nesting() {
        let params = json!({
            "sessionId": "s1",
            "message": {
                "role": "assistant",
                "content": [],
                "usage": { "inputTokens": 10, "outputTokens": 4, "cost": 0.0123 },
            },
        });
        let u = extract_usage(&params).expect("message.usage must be recognized");
        assert_eq!(u.input_tokens, Some(10));
        assert_eq!(u.output_tokens, Some(4));
        assert_eq!(u.cost_usd, Some(0.0123));
    }

    #[test]
    fn usage_recognizes_unrecognized_shape_as_absent() {
        // A `usage` object with none of the known keys is noise — treat it
        // as absent rather than reporting a zero turn.
        let params = json!({ "usage": { "weird": true } });
        assert_eq!(extract_usage(&params), None);
    }

    #[test]
    fn usage_merge_overrides_only_present_fields() {
        let mut base = AcpUsage {
            input_tokens: Some(1),
            output_tokens: None,
            ..Default::default()
        };
        base.merge(AcpUsage {
            input_tokens: None,
            output_tokens: Some(2),
            ..Default::default()
        });
        assert_eq!(base.input_tokens, Some(1));
        assert_eq!(base.output_tokens, Some(2));
    }
}
