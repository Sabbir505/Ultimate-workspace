//! ACP (Agent Client Protocol) client support (roadmap #20).
//!
//! ACP is a JSON-RPC 2.0 protocol over the agent binary's stdio: the client
//! (Conduit) launches the binary, performs the `initialize` → `initialized`
//! handshake, opens a `session/new`, then drives turns with `session/request`
//! and streams `session/update` notifications until `session/finish`.
//!
//! This module owns the wire framing (pure + unit-tested) and the
//! notification → chat-event translation in `events`. Process lifecycle lives
//! in `agent_sessions.rs`, which reuses the same persistent-process machinery
//! that drives the claude CLI. The registry of known/configured agents is in
//! `crate::acp_agents`.

use serde_json::{json, Value};

pub mod events;

/// Protocol version we speak (ACP semver string). Older agents may accept
/// newer versions; the handshake result can echo back a lower one.
pub const ACP_PROTOCOL_VERSION: &str = "0.1.0";

/// One parsed ACP line (the reader splits the stdout stream on newlines —
/// every protocol message is a single-line JSON object).
#[derive(Debug, Clone, PartialEq)]
pub enum AcpLine {
    /// Response to one of our requests:
    /// `{ "jsonrpc":"2.0", "id":N, "result":… }` or the error variant.
    Response {
        id: u64,
        result: Option<Value>,
        error: Option<Value>,
    },
    /// Notification from the agent: `{ "jsonrpc":"2.0", "method":M, "params":… }`.
    Notification { method: String, params: Value },
    /// Server-initiated request (e.g. `session/prompt`) — out of scope for v1.
    Request { id: u64, method: String, params: Value },
}

/// Serialize a request (the agent MUST respond with the same id).
pub fn encode_request(id: u64, method: &str, params: &Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

/// Serialize a notification (no response expected).
pub fn encode_notification(method: &str, params: &Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

/// Parse one ACP line into a message. Returns `None` for lines that aren't
/// well-formed protocol objects (agents may interleave log output).
pub fn decode_line(line: &str) -> Option<AcpLine> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    let method = obj.get("method").and_then(|m| m.as_str());
    let id = obj.get("id").and_then(|i| i.as_u64());
    match (method, id) {
        (Some(m), None) => Some(AcpLine::Notification {
            method: m.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(m), Some(id)) => Some(AcpLine::Request {
            id,
            method: m.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, Some(id)) => Some(AcpLine::Response {
            id,
            result: obj.get("result").cloned(),
            error: obj.get("error").cloned(),
        }),
        (None, None) => None,
    }
}

/// Ids only need to be unique per process, but a global counter is simpler
/// and harmless — every request (initialize, session/new, session/request,
/// tool-result replies) draws from it.
static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn next_request_id() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Build a `session/request` message for a user turn.
pub fn user_session_request(session_id: &str, text: &str) -> Value {
    json!({
        "sessionId": session_id,
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        "toolsEnabled": true,
    })
}

/// Build a `session/request` message that answers a tool call with an error
/// result (v1 does not execute ACP tools; replying keeps the agent from
/// waiting forever on a result that would never come).
pub fn tool_error_session_request(session_id: &str, tool_call_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_result",
                "tool_call_id": tool_call_id,
                "is_error": true,
                "content": "Tool execution is not supported by this client (Conduit ACP v1) — describe what you would have done with this tool instead.",
            }],
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_request_matches_jsonrpc_shape() {
        let s = encode_request(7, "initialize", &json!({ "protocolVersion": "0.1.0" }));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["protocolVersion"], "0.1.0");
    }

    #[test]
    fn encode_notification_has_no_id() {
        let s = encode_notification("initialized", &json!({}));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["method"], "initialized");
        assert!(v.get("id").is_none());
    }

    #[test]
    fn decode_response_result_and_error() {
        let ok = decode_line(r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}"#).unwrap();
        match ok {
            AcpLine::Response { id, result, error } => {
                assert_eq!(id, 1);
                assert_eq!(result.unwrap()["sessionId"], "s1");
                assert!(error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }
        let err = decode_line(r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}"#).unwrap();
        match err {
            AcpLine::Response { id, error, .. } => {
                assert_eq!(id, 2);
                assert_eq!(error.unwrap()["message"], "nope");
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn decode_notification_and_request() {
        let n = decode_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","content":[]}}"#).unwrap();
        match n {
            AcpLine::Notification { method, params } => {
                assert_eq!(method, "session/update");
                assert_eq!(params["sessionId"], "s1");
            }
            other => panic!("expected notification, got {other:?}"),
        }
        let r = decode_line(r#"{"jsonrpc":"2.0","id":9,"method":"session/prompt","params":{}}"#).unwrap();
        match r {
            AcpLine::Request { id, method, .. } => {
                assert_eq!(id, 9);
                assert_eq!(method, "session/prompt");
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn decode_ignores_garbage_and_ids_only_increase() {
        assert!(decode_line("not json").is_none());
        assert!(decode_line("").is_none());
        assert!(decode_line(r#"{"foo":1}"#).is_none());
        let a = next_request_id();
        let b = next_request_id();
        assert!(b > a);
    }
}
