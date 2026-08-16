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
}
