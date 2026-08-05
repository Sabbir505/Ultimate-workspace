//! conduit-browser-mcp — standalone MCP server binary.
//!
//! Speaks Model Context Protocol JSON-RPC over stdio to a harness (Claude
//! Code / Kimi Code) and forwards every `tools/call` to the running Conduit
//! app over a loopback WebSocket (ws://127.0.0.1:{CONDUIT_WS_PORT}). The app
//! executes against the real visible Dev-tab browser pane — the harness sees
//! a normal browser MCP server, but it's driving the exact pane on screen.
//!
//! This binary deliberately does NOT link Tauri: it's a thin stdio→WS relay.
//! The WebSocket port comes from the `CONDUIT_WS_PORT` env var (default 7681,
//! matching `browser::BROWSER_MCP_PORT` in the app), and the project scope
//! from `CONDUIT_PROJECT_ID`. Both are set by the `.mcp.json` / `--mcp-config`
//! registration written per-project at agent-session spawn.
//!
//! Error shape (JSON-RPC error object, task §4):
//!   { "code": -32000, "message": "<human text>", "data": { "conduit_code": "<code>" } }
//! Codes: not_found, nav_failure, timeout, browser_unavailable, invalid_args,
//! pane_not_found, unknown_op, action_failed.

use std::io::{BufRead, Write};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Default WebSocket port — kept in sync with `browser::BROWSER_MCP_PORT` in
/// the app. Overridable via `CONDUIT_WS_PORT` (the registration always sets
/// it, so drift is impossible in practice).
const DEFAULT_WS_PORT: u16 = 7681;

fn main() {
    // Single-threaded runtime: an MCP server handles one request at a time
    // over stdio, so there's no benefit to a multi-threaded pool.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");
    rt.block_on(run());
}

async fn run() {
    let port: u16 = std::env::var("CONDUIT_WS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_WS_PORT);
    let project_id = std::env::var("CONDUIT_PROJECT_ID").ok();
    let url = format!("ws://127.0.0.1:{port}/");

    // Lazily connect to the app; reconnect if the socket drops (the app may
    // restart while an agent session is long-lived).
    let mut ws: Option<WsConn> = None;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_line(&line, &url, &project_id, &mut ws).await;
        let mut text = serde_json::to_string(&response).unwrap_or_else(|_| fallback_err().to_string());
        text.push('\n');
        if stdout.write_all(text.as_bytes()).is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

/// A live WebSocket connection to the app. `closed` is set when a read
/// returns Close/Err/end-of-stream so the next call reconnects.
struct WsConn {
    write: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    read: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    closed: bool,
}

async fn connect(url: &str) -> Result<WsConn, String> {
    let (stream, _resp) = connect_async(url)
        .await
        .map_err(|e| format!("ws connect failed: {e}"))?;
    let (mut write, read) = stream.split();
    // Send the MCP auth token as the first text frame. The Conduit app
    // generates a random token at startup and exposes it via the
    // CONDUIT_MCP_AUTH_TOKEN env var. If missing, the WS server rejects
    // the connection — this is expected when running standalone without
    // the Conduit app.
    let token = std::env::var("CONDUIT_MCP_AUTH_TOKEN").unwrap_or_default();
    let auth_msg = serde_json::json!({"auth": token});
    write
        .send(Message::Text(serde_json::to_string(&auth_msg).unwrap()))
        .await
        .map_err(|e| format!("ws auth send failed: {e}"))?;
    Ok(WsConn { write, read, closed: false })
}

/// Send a request envelope over the WebSocket and await the response envelope.
async fn round_trip(
    ws: &mut WsConn,
    req: Value,
) -> Result<Value, String> {
    let text = serde_json::to_string(&req).map_err(|e| format!("encode req: {e}"))?;
    ws.write
        .send(Message::Text(text))
        .await
        .map_err(|e| format!("ws send failed: {e}"))?;
    while let Some(msg) = ws.read.next().await {
        match msg {
            Ok(Message::Text(t)) => {
                return serde_json::from_str(&t).map_err(|e| format!("decode resp: {e}"));
            }
            Ok(Message::Ping(p)) => {
                let _ = ws.write.send(Message::Pong(p)).await;
            }
            Ok(Message::Close(_)) => {
                ws.closed = true;
                return Err("ws closed by peer".into());
            }
            Err(e) => {
                ws.closed = true;
                return Err(format!("ws read failed: {e}"));
            }
            _ => {}
        }
    }
    ws.closed = true;
    Err("ws stream ended without response".into())
}

/// Handle one stdin JSON-RPC line, returning the JSON-RPC response object.
async fn handle_line(
    line: &str,
    url: &str,
    project_id: &Option<String>,
    ws: &mut Option<WsConn>,
) -> Value {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error_response(None, "invalid_args", &format!("malformed JSON-RPC: {e}")),
    };

    // Notifications (no `id`) — acknowledge with nothing (no response per spec).
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "conduit-browser-mcp", "version": "0.1.0" },
                "capabilities": { "tools": {} }
            }
        }),
        "notifications/initialized" | "initialized" => json!(null),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tool_schemas() }
        }),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let result = handle_tool_call(params, url, project_id, ws).await;
            match result {
                Ok(content) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [ { "type": "text", "text": content } ] }
                }),
                Err((code, message)) => error_response(id, code, &message),
            }
        }
        other => error_response(id, "unknown_op", &format!("unknown method: {other}")),
    }
}

/// Map an MCP tool name to the WS op the app dispatches. Browser tools keep
/// their bare op names; conduit-tools live under a `conduit_tools:<name>`
/// prefix so the app-side dispatcher can route them to
/// chat::tools::execute_tool (which receives the name back).
fn tool_op(tool: &str) -> Result<String, &'static str> {
    match tool {
        "navigate" | "read_page" | "click" | "type_text" | "scroll" | "wait_for" => Ok(tool.to_string()),
        "generate_document" | "generate_diagram" | "generate_file"
        | "get_skill" | "list_skills" => Ok(format!("conduit_tools:{tool}")),
        _ => Err("unknown tool"),
    }
}

/// Dispatch a `tools/call` to the app over the WebSocket. Returns the tool's
/// text result or a structured (code, message) error.
async fn handle_tool_call(
    params: Value,
    url: &str,
    project_id: &Option<String>,
    ws: &mut Option<WsConn>,
) -> Result<String, (&'static str, String)> {
    let tool = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    let op = tool_op(tool).map_err(|_| ("unknown_op", format!("unknown tool: {tool}")))?;

    // Ensure we have a connection (lazy connect / reconnect on drop).
    if ws.as_ref().map(|c| c.closed).unwrap_or(true) {
        *ws = None;
    }
    if ws.is_none() {
        match connect(url).await {
            Ok(c) => *ws = Some(c),
            Err(e) => return Err(("browser_unavailable", e)),
        }
    }
    let conn = ws.as_mut().unwrap();

    let req = json!({
        "op": op,
        "project_id": project_id,
        "pane_id": args.get("pane_id"),
        "args": args,
    });

    let resp = round_trip(conn, req)
        .await
        .map_err(|e| ("browser_unavailable", e))?;

    if let Some(err) = resp.get("error") {
        let code = err.get("code").and_then(|v| v.as_str()).unwrap_or("action_failed");
        let message = err.get("message").and_then(|v| v.as_str()).unwrap_or("unknown error");
        // Map the app's conduit code into a static-code + message pair.
        let static_code = match code {
            "not_found" => "not_found",
            "nav_failure" => "nav_failure",
            "timeout" => "timeout",
            "pane_not_found" => "pane_not_found",
            "invalid_args" => "invalid_args",
            "unknown_op" => "unknown_op",
            _ => "action_failed",
        };
        return Err((static_code, message.to_string()));
    }

    let ok = resp.get("ok").unwrap_or(&Value::Null);
    // Flatten the ok value into a readable text result for the harness.
    Ok(serde_json::to_string_pretty(ok).unwrap_or_else(|_| "ok".into()))
}

/// JSON-RPC error response with a `conduit_code` data field.
fn error_response(id: Option<Value>, code: &str, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32000,
            "message": message,
            "data": { "conduit_code": code }
        }
    })
}

fn fallback_err() -> Value {
    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32603, "message": "internal error" } })
}

/// Static MCP tool schemas. Each tool takes the args it forwards to the app's
/// WebSocket dispatch (`browser_mcp::op_*`); the optional `pane_id` lets the
/// harness target a specific browser pane.
fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "navigate",
            "description": "Navigate the Dev-tab browser pane to a URL. Auto-opens a pane if none exists for the project.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Absolute URL to navigate to." },
                    "pane_id": { "type": "string", "description": "Optional explicit browser pane id (omit to target the most-recently-used pane for the project)." }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "read_page",
            "description": "Read the active page. 'interactive' (default) returns the accessibility tree (roles, labels, form state, rects) so you can locate and interact with elements without pixel coordinates; 'content' returns readability-stripped page content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["interactive", "content", "full", "summary", "section"], "default": "interactive" },
                    "selector": { "type": "string", "description": "CSS selector (section mode) or anchor description." },
                    "pane_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "click",
            "description": "Click an element resolved from a CSS selector or a role/text description.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector_or_description": { "type": "string", "description": "CSS selector or a description (visible text / aria-label / placeholder) of the element to click." },
                    "pane_id": { "type": "string" }
                },
                "required": ["selector_or_description"]
            }
        }),
        json!({
            "name": "type_text",
            "description": "Type text into an input resolved from a CSS selector or role/text description. Dispatches per-keystroke events so controlled inputs (React/Vue) register the change.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector_or_description": { "type": "string" },
                    "text": { "type": "string" },
                    "pane_id": { "type": "string" }
                },
                "required": ["selector_or_description", "text"]
            }
        }),
        json!({
            "name": "scroll",
            "description": "Scroll the page up or down by a viewport step.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down"], "default": "down" },
                    "pane_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "wait_for",
            "description": "Wait for a condition: 'navigation' (URL change), 'selector' (element exists), or 'network_idle' (readyState complete + quiet period).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "condition": { "type": "string", "enum": ["navigation", "selector", "network_idle"] },
                    "target": { "type": "string", "description": "For navigation: the previous URL to compare against; for selector: the CSS selector." },
                    "timeout_ms": { "type": "integer", "default": 10000 },
                    "pane_id": { "type": "string" }
                },
                "required": ["condition"]
            }
        }),
        json!({
            "name": "generate_document",
            "description": "Create a REAL, professionally formatted docx/pptx/xlsx/pdf file in the artifacts dir. Use this instead of hand-building office files with python. Args: format ('docx'|'pptx'|'xlsx'|'pdf'), filename, title, content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["docx", "pptx", "xlsx", "pdf"] },
                    "filename": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["format", "filename", "title", "content"]
            }
        }),
        json!({
            "name": "generate_diagram",
            "description": "Create a diagram (SVG/PNG) in the artifacts dir from a structured spec (mindmap/flow/sequence/architecture).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["mindmap", "flow", "sequence", "architecture"] },
                    "filename": { "type": "string" },
                    "title": { "type": "string" },
                    "items": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["kind", "filename", "title", "items"]
            }
        }),
        json!({
            "name": "generate_file",
            "description": "Write a plain text/code file into the artifacts dir. Args: format (extension without dot), filename, title, content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string" },
                    "filename": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["format", "filename", "title", "content"]
            }
        }),
        json!({
            "name": "get_skill",
            "description": "Load a skill's detailed instructions (e.g. 'docx', 'pdf', 'pptx', 'diagram') before producing that artifact.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string" }
                },
                "required": ["slug"]
            }
        }),
        json!({
            "name": "list_skills",
            "description": "List every available skill slug.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schemas_include_conduit_tools() {
        let schemas = tool_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        for tool in ["navigate", "read_page", "generate_document", "generate_diagram",
                     "generate_file", "get_skill", "list_skills"] {
            assert!(names.contains(&tool), "missing tool schema: {tool}");
        }
    }

    #[test]
    fn conduit_tool_routing_uses_tools_namespace() {
        assert_eq!(tool_op("generate_document").unwrap(), "conduit_tools:generate_document");
        assert_eq!(tool_op("navigate").unwrap(), "navigate"); // browser tools unchanged
        assert!(tool_op("bogus").is_err()); // unknown tools error, not misroute
    }
}
