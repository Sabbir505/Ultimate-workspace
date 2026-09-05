//! conduit-browser-mcp — standalone MCP server binary.
//!
//! Speaks Model Context Protocol JSON-RPC over stdio to a harness (Claude
//! Code / Kimi Code) and forwards every `tools/call` to the running Conduit
//! app over a loopback WebSocket (ws://127.0.0.1:{CONDUIT_WS_PORT}). The app
//! executes against the real visible in-app browser pane — the harness sees
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
        let Some(response) = handle_line(&line, &url, &project_id, &mut ws).await else {
            // JSON-RPC notification — the spec forbids any response. The old
            // code wrote a bare `null` line here, which strict MCP clients
            // flag as a protocol violation.
            continue;
        };
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

/// Handle one stdin JSON-RPC line, returning the JSON-RPC response object —
/// or `None` for notifications, which MUST NOT receive a response per the
/// JSON-RPC spec. (Previously `notifications/initialized` got a bare `null`
/// line and unknown notifications got an error with `"id": null` — both are
/// protocol violations that strict MCP clients reject.)
async fn handle_line(
    line: &str,
    url: &str,
    project_id: &Option<String>,
    ws: &mut Option<WsConn>,
) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        // Unparseable input might be a mangled notification, but JSON-RPC
        // mandates a Parse-error reply with id:null here, and MCP clients
        // never send malformed frames — keep answering this one.
        Err(e) => return Some(error_response(None, "invalid_args", &format!("malformed JSON-RPC: {e}"))),
    };

    // Notifications carry no `id` member (or an explicit null) → silence.
    // This single gate covers `notifications/initialized` AND any unknown
    // notification method, which previously got an id:null error response.
    let id = msg.get("id").cloned();
    let is_notification = match msg.get("id") {
        None => true,
        Some(Value::Null) => true,
        _ => false,
    };
    if is_notification {
        return None;
    }
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

    Some(match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "conduit-browser-mcp", "version": "0.1.0" },
                "capabilities": { "tools": {} }
            }
        }),
        // A notifications/* method tagged with an id is a confused client;
        // answer with a valid envelope rather than the old bare `null` line.
        "notifications/initialized" | "initialized" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": null
        }),
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
    })
}

/// Map an MCP tool name to the WS op the app dispatches. Browser tools keep
/// their bare op names; conduit-tools live under a `conduit_tools:<name>`
/// prefix so the app-side dispatcher can route them to
/// chat::tools::execute_tool (which receives the name back).
fn tool_op(tool: &str) -> Result<String, &'static str> {
    match tool {
        "navigate" | "read_page" | "click" | "type_text" | "scroll" | "wait_for"
        | "history" | "hover" | "evaluate" | "click_and_wait" | "screenshot"
        | "find" | "fill_form" | "select_option" | "press_key" | "batch"
        | "read_console" | "read_network" | "list_tabs" | "switch_tab"
        | "new_tab" | "close_tab" | "zoom" | "print_to_pdf" => Ok(tool.to_string()),
        "generate_document" | "generate_diagram" | "generate_file"
        | "plan_document" | "revise_document"
        | "get_skill" | "list_skills" | "list_artifacts" | "search_docs" | "get_capabilities" => Ok(format!("conduit_tools:{tool}")),
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
            "browser_unavailable" => "browser_unavailable",
            "cancelled_by_user" => "cancelled_by_user",
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
            "description": "Navigate the in-app browser pane to a URL. This is NOT an external browser — the page loads in the Conduit window's visible pane. Auto-opens a pane if none exists. Use this (not fetch_url) when the user asks to browse, open a website, search, or interact with a web page. ALSO use it to preview a web app you just built: a static app (HTML/CSS/JS on disk) needs NO server — navigate straight to its index.html via a file:/// URL (e.g. file:///C:/proj/index.html); only framework dev servers (vite/next/…) need to be started first (background task), then navigate to http://localhost:PORT. After navigating, call read_page to see what's on the page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Absolute URL — https://… for web pages, or file:///C:/path/index.html to preview a local app you created." },
                    "pane_id": { "type": "string", "description": "Optional explicit browser pane id (omit to target the most-recently-used pane for the project)." }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "read_page",
            "annotations": { "readOnlyHint": true },
            "description": "Read the current page in the browser pane. ALWAYS call this after navigating, before clicking or typing. Modes: 'interactive' (default — accessibility tree with element roles, labels, form state, and numbered refs you use in click/type_text); 'content' (readability-stripped article text); 'full' (raw page text); 'summary' (~1500 chars + headings for quick triage); 'section' (extract content under a CSS selector or heading). Refs from a read are valid only until the next navigation — re-read after any page change.",
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
            "description": "Click an element on the browser page. Pass a CSS selector or a natural-language description (visible text, aria-label, placeholder, or role). The agent cursor visibly moves to the element and a click ripple appears — the user sees it happen. After clicking, if the page changes, call read_page again to get fresh refs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector_or_description": { "type": "string", "description": "CSS selector (e.g. '#submit-btn', 'button.login') or a description (e.g. 'the Sign In button', 'search box')." },
                    "element": { "type": "string", "description": "Optional human-readable description of what you intend to click — recorded in the action timeline shown to the user (e.g. 'the checkout button')." },
                    "include_snapshot": { "type": "boolean", "description": "Attach a compact post-click element snapshot to the result (same [ref] numbering) so you don't need a separate read_page." },
                    "pane_id": { "type": "string" }
                },
                "required": ["selector_or_description"]
            }
        }),
        json!({
            "name": "type_text",
            "description": "Type text into an input field on the browser page. Pass a CSS selector or description to find the input, then the text to type. Text is typed character-by-character (visible to the user) with real keydown/keyup/input events per keystroke, so React/Vue controlled inputs work correctly. After typing, call read_page to verify the input state if needed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector_or_description": { "type": "string", "description": "CSS selector or description of the input field (e.g. '#search', 'the email input')." },
                    "text": { "type": "string", "description": "Text to type into the field." },
                    "element": { "type": "string", "description": "Optional human-readable description of the field (recorded in the action timeline)." },
                    "include_snapshot": { "type": "boolean" },
                    "pane_id": { "type": "string" }
                },
                "required": ["selector_or_description", "text"]
            }
        }),
        json!({
            "name": "scroll",
            "description": "Scroll the browser page up or down by one viewport step. Use to reveal more content (e.g. lazy-loaded lists, below-the-fold sections). After scrolling, call read_page to get fresh refs — new elements may have appeared.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down"], "default": "down" },
                    "include_snapshot": { "type": "boolean", "description": "Attach the compact post-scroll snapshot (newly revealed elements get refs)." },
                    "pane_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "wait_for",
            "description": "Wait for a condition on the browser page before continuing. 'navigation' — wait for the URL to change (pass the previous URL as target). 'selector' — wait for an element matching the CSS selector to appear. 'network_idle' — wait for the page to settle (readyState complete + network quiet). 'stable' — wait until the DOM has stopped mutating for ~600ms (best for streaming SPAs and infinite feeds). Essential after clicks that trigger navigation or async content loads.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "condition": { "type": "string", "enum": ["navigation", "selector", "network_idle", "stable"] },
                    "target": { "type": "string", "description": "For navigation: the previous URL to compare against; for selector: the CSS selector." },
                    "timeout_ms": { "type": "integer", "default": 10000 },
                    "pane_id": { "type": "string" }
                },
                "required": ["condition"]
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "history",
            "description": "Drive the browser pane's real history stack back or forward (the same as clicking the browser's back/forward button). Use 'back' to return to the previous page (e.g. after a redirect that landed you somewhere unexpected), 'forward' to undo a back. The tool reports the resulting URL after the navigation settles — call read_page afterwards to see what's on the page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["back", "forward"], "default": "back" },
                    "pane_id": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "hover",
            "description": "Hover an element on the browser page — dispatches real mouseover/mouseenter/mousemove events so CSS :hover styles apply and React/Vue hover handlers fire. Use this BEFORE click when a menu or submenu only appears on hover (e.g. dropdown menus, mega-menu navigation, tooltip reveals). After hovering, call read_page to see the newly-revealed elements, then click the now-visible target.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector_or_description": { "type": "string", "description": "CSS selector (e.g. '#menu', 'nav li.products') or a natural-language description (e.g. 'the Products menu', 'the user avatar')." },
                    "element": { "type": "string", "description": "Optional human-readable description (recorded in the action timeline)." },
                    "include_snapshot": { "type": "boolean" },
                    "pane_id": { "type": "string" }
                },
                "required": ["selector_or_description"]
            }
        }),
        json!({
            "name": "evaluate",
            "annotations": { "destructiveHint": true },
            "description": "Run arbitrary JavaScript in the browser pane (in the page's own origin) and return the result as JSON. The expression is wrapped so a bare expression works directly — e.g. `document.title`, `Array.from(document.querySelectorAll('.row')).length`, `JSON.stringify({url: location.href, ready: document.readyState})`. Use to read form state, page JS variables, or run custom extraction/assertion the read_page/click tools can't reach. Functions/undefined/circular values become markers ([Function], [undefined], [circular]). Avoid side effects — prefer click/type_text for interaction.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "expression": { "type": "string", "description": "A JS expression to evaluate. May reference the live document and window. The returned value is JSON-stringified and reported back." },
                    "pane_id": { "type": "string" }
                },
                "required": ["expression"]
            }
        }),
        json!({
            "name": "click_and_wait",
            "description": "Click an element AND wait for a resulting condition in one round-trip — stronger than separate click + wait_for because the click and the polling happen in the same atomic sequence (a fast navigation can finish before a separate wait_for's first poll, causing a spurious timeout). Use after navigating to a page with a form whose submit triggers a navigation or async content load. Conditions: 'navigation' (URL changes — pass the pre-click URL as target, or omit to auto-snapshot), 'selector' (an element matching a CSS selector appears — pass the selector as target), 'network_idle' (page settles). If the click can't resolve the element, the not_found result with suggestions is returned and no wait is performed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector_or_description": { "type": "string", "description": "CSS selector or natural-language description of the element to click." },
                    "condition": { "type": "string", "enum": ["navigation", "selector", "network_idle"], "default": "navigation" },
                    "target": { "type": "string", "description": "For navigation: the previous URL to compare against (auto-snapshotted if omitted). For selector: the CSS selector to wait for." },
                    "timeout_ms": { "type": "integer", "default": 10000 },
                    "element": { "type": "string", "description": "Optional human-readable description (recorded in the action timeline)." },
                    "pane_id": { "type": "string" }
                },
                "required": ["selector_or_description"]
            }
        }),
        json!({
            "name": "screenshot",
            "description": "Capture the browser pane's current page as a PNG screenshot. The image is saved into the artifacts dir (the returned 'path' can be embedded in chat) and returned as base64 so you can visually inspect layout, canvas content, charts, or rendering state that read_page's accessibility tree cannot show. Prefer read_page for text/structure (far cheaper); use screenshot when visual layout matters — checking your own app's rendering, verifying a UI fix, reading canvas/WebGL content. Windows-only today; other platforms return a clear error.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string" }
                }
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "find",
            "description": "Search the page's interactive elements WITHOUT a full read: substring match across labels/aria/placeholder/id/value. Returns the compact element list (same [ref] numbering as click/type_text) for matching elements — far cheaper than read_page when you just need to locate a control. Example: find(query: \"submit\") before clicking. Refs are valid until the page changes materially — re-find after navigations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive substring to match (e.g. 'sign in', 'search', 'cart')." },
                    "pane_id": { "type": "string" }
                },
                "required": ["query"]
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "fill_form",
            "description": "Fill MULTIPLE form fields in one call by element ref (from read_page/find). Sets each value directly (React/Vue-safe) — much faster than repeated type_text. Example: fill_form(fields: [{\"ref\": 3, \"text\": \"a@b.c\"}, {\"ref\": 5, \"text\": \"Hunter2\"}]). The result reports per-field success; stale refs (page changed) are flagged for a re-read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "ref": { "type": "integer", "description": "Element ref from read_page/find." },
                                "text": { "type": "string", "description": "Value to set. Empty string clears the field." }
                            },
                            "required": ["ref", "text"]
                        }
                    },
                    "include_snapshot": { "type": "boolean", "description": "Attach the compact post-fill element snapshot to the result." },
                    "pane_id": { "type": "string" }
                },
                "required": ["fields"]
            }
        }),
        json!({
            "name": "select_option",
            "description": "Select an option in a <select> dropdown by value OR visible text — the reliable way to operate dropdowns (a11y-tree clicks on dropdowns are a known failure mode). Example: select_option(ref: 7, value: \"Shipping\"). If no exact match, a substring match on option text is tried; the error lists available options.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": { "type": "integer", "description": "Element ref of the <select>." },
                    "value": { "type": "string", "description": "Option value or visible text." },
                    "include_snapshot": { "type": "boolean" },
                    "pane_id": { "type": "string" }
                },
                "required": ["ref", "value"]
            }
        }),
        json!({
            "name": "press_key",
            "description": "Press a key on the currently-focused element: Enter, Escape, Tab, ArrowDown, PageDown, Backspace, etc. Enter on a search input submits its form; Escape blurs/closes lightweight menus. Focus first via type_text (leaves focus in the field) or click.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Key name: 'Enter', 'Escape', 'Tab', 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight', 'Backspace', 'Delete', 'PageUp', 'PageDown', 'Home', 'End'." },
                    "include_snapshot": { "type": "boolean" },
                    "pane_id": { "type": "string" }
                },
                "required": ["key"]
            }
        }),
        json!({
            "name": "batch",
            "description": "Run up to 15 browser actions in ONE round trip, in order. Halts on the first failure and reports the remaining steps as 'Not executed: an earlier action failed' — so multi-step interactions (fill_form -> press_key Enter -> wait_for) cost a single harness call. Each step: {op: 'click'|'type_text'|'fill_form'|'select_option'|'press_key'|'hover'|'scroll'|'wait_for'|'read_page', args: {...}}. batch and navigate are not allowed inside.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": { "type": "string" },
                                "args": { "type": "object" }
                            },
                            "required": ["op"]
                        }
                    },
                    "include_snapshot": { "type": "boolean", "description": "Attach the compact post-batch snapshot." },
                    "pane_id": { "type": "string" }
                },
                "required": ["actions"]
            }
        }),
        json!({
            "name": "read_console",
            "description": "Read the page's console output + uncaught errors incrementally (since your last read). Use to diagnose a misbehaving page or your own app after a navigation — far cheaper than screenshots. The response carries 'latest': pass it back as 'since' next time to get only new entries.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": { "type": "integer", "description": "Only entries with a higher sequence number (default 0 = all buffered)." },
                    "level": { "type": "string", "enum": ["all", "error", "warn", "info", "log", "debug"], "default": "all" },
                    "pane_id": { "type": "string" }
                }
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "read_network",
            "description": "Read the page's network activity (fetch/XHR: method, URL, status) incrementally since your last read — diagnose failed API calls, check a request actually fired, or find an endpoint the page hit. Does NOT record request bodies or headers (they can carry credentials). Pass 'latest' back as 'since' for incremental reads.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": { "type": "integer" },
                    "pane_id": { "type": "string" }
                }
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "list_tabs",
            "description": "List the browser pane's tabs (tabId, active flag, URL). Use before switch_tab/close_tab. Unactivated tabs report activated:false (their webview is created on first switch).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane_id": { "type": "string" }
                }
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "switch_tab",
            "description": "Make a different tab of the browser pane active (from list_tabs). Subsequent read/click/... ops target the newly-active tab. Auto-waits for the tab's webview to be ready.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string" },
                    "pane_id": { "type": "string" }
                },
                "required": ["tabId"]
            }
        }),
        json!({
            "name": "new_tab",
            "description": "Open a NEW tab in the browser pane pointed at a URL and make it active. Use to compare pages side-by-side (e.g. keep docs open while driving your app in another tab) without losing the current page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "pane_id": { "type": "string" }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "close_tab",
            "description": "Close a tab of the browser pane (from list_tabs). Closing the last tab closes the whole pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string" },
                    "pane_id": { "type": "string" }
                },
                "required": ["tabId"]
            },
            "annotations": { "destructiveHint": true }
        }),
        json!({
            "name": "zoom",
            "description": "Capture a REGION of the page as an upscaled PNG (vision fallback for canvas content, charts, maps, small/dense text that read_page can't represent). Coordinates are viewport CSS pixels from the top-left of the pane; scale defaults to 2 (up to 4). Windows-only today. Saved to the artifacts dir and returned as base64.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "width": { "type": "number" },
                    "height": { "type": "number" },
                    "scale": { "type": "number", "default": 2 },
                    "pane_id": { "type": "string" }
                },
                "required": ["x", "y", "width", "height"]
            }
        }),
        json!({
            "name": "print_to_pdf",
            "description": "Print the browser pane's CURRENT page to a PDF file in the artifacts dir and return the path — the faithful-document handoff for receipts, order confirmations, tickets, docs, or your own app's print output. Windows-only today. Use screenshot/zoom for visual checks; use this when a durable document matters.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "landscape": { "type": "boolean", "default": false },
                    "pane_id": { "type": "string" }
                }
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "generate_document",
            "description": "Create a REAL, professionally formatted docx/pptx/xlsx/pdf file in the artifacts dir. Use this instead of hand-building office files with python. Args: format ('docx'|'pptx'|'xlsx'|'pdf'), filename, code (a complete runnable Python program that saves the built document to os.environ['CONDUIT_OUTPUT']).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["docx", "pptx", "xlsx", "pdf"] },
                    "filename": { "type": "string" },
                    "code": { "type": "string", "description": "Complete runnable Python program (python-docx/python-pptx/openpyxl/reportlab, or conduit_docgen) that builds the document and saves it to os.environ['CONDUIT_OUTPUT']. Not natural-language instructions." },
                    "instructions": { "type": "string" }
                },
                "required": ["format", "filename", "code"]
            }
        }),
        json!({
            "name": "plan_document",
            "description": "Create a REAL, professionally designed docx/pptx/pdf from a structured PLAN — no code. You author content (title, per-slide layouts or document sections, slot text, chart data, tables, KPIs, speaker notes); Relay validates the plan (layout budgets, chart shapes, deck coherence), compiles it against the built-in design system (typography, spacing, colors handled for you), renders it, and runs design QA before saving. QA warnings come back in the result — fix them by re-calling with a revised plan (same filename overwrites). Prefer this over generate_document for polished pptx/docx/pdf. The full planner guide is returned with any error.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["pptx", "docx", "pdf"] },
                    "filename": { "type": "string" },
                    "theme": { "type": "string", "enum": ["ink", "midnight", "emerald", "plum", "amber", "crimson", "teal"] },
                    "system": { "type": "string", "enum": ["editorial", "consulting", "product", "minimal"], "description": "Named design system: defaults the theme and nudges layout selection." },
                    "plan": {
                        "type": "object",
                        "description": "Deck plan: { v: 1, kind: 'deck', title, theme?, slides: [{ id, layout, slots, notes? }] } with layouts cover|section|agenda|bullets|two-col|chart-text|chart-full|kpi|quote|timeline|table|statement|closing. Document plan: { v: 1, kind: 'doc', title, subtitle?, sections: [{ id, heading, blocks: [...] }] } with block types paragraph|bullets|numbered|callout|quote|table|kpi-strip. Full schema arrives with any validation error."
                    }
                },
                "required": ["format", "filename", "plan"]
            }
        }),
        json!({
            "name": "revise_document",
            "description": "Make targeted edits to a document previously created with plan_document: patch individual slide slots or document blocks in the PLAN, and Relay recompiles and re-validates — revisions stay on-brand and within budgets. Far better than regenerating the whole document for copy tweaks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Artifact path from the original plan_document result." },
                    "patches": {
                        "type": "array",
                        "items": { "type": "object" },
                        "description": "Deck: { slide: id, slot: id, value: any } or { slide: id, notes: str }. Document: { section: id, heading: str } | { section: id, block: index, value: str|object } | { section: id, block: index, remove: true }."
                    }
                },
                "required": ["path", "patches"]
            }
        }),
        json!({
            "name": "generate_diagram",
            "description": "Create a hand-styled HTML/CSS diagram file in the artifacts dir from a full HTML document. Use get_skill('diagram') for guidance.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": { "type": "string" },
                    "html": { "type": "string" }
                },
                "required": ["filename", "html"]
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
        json!({
            "name": "list_artifacts",
            "description": "List Relay's artifacts — generated documents, charts, exports, \
                reports and downloads from the last 30 days — newest first, each with its \
                kind, date and ABSOLUTE path. Call this when the user asks where an artifact \
                lives, what was generated recently, or wants one opened or shown; the path is \
                readable with your file tools.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Optional filename substring filter (case-insensitive)." },
                    "limit": { "type": "integer", "description": "Max entries to return (1–50, default 10)." }
                }
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "search_docs",
            "description": "Search the user's locally-indexed document folders (Settings → Knowledge). Use when the user asks about their own files, notes, or docs. Returns ranked hits with path, score, and text excerpt. Images return a path citation only. Self-reports unavailable when the embedding sidecar isn't running.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language search query." },
                    "top_k": { "type": "integer", "description": "Max results to return (1–20, default 5)." }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "get_capabilities",
            "description": "Report which connectors, MCP servers, and skills are available in this Relay session, as JSON. THE authority on availability — call this instead of running `claude mcp list` or similar shell probes; it is instant, in-process, and reflects the app's real connections rather than a config file.",
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
                     "generate_file", "plan_document", "revise_document",
                     "get_skill", "list_skills", "search_docs",
                     "get_capabilities",
                     "history", "hover", "evaluate", "click_and_wait", "screenshot"] {
            assert!(names.contains(&tool), "missing tool schema: {tool}");
        }
        // Every advertised tool must be routable through tool_op — the
        // screenshot op existed in the app-side dispatch but was never
        // mapped/advertised here, making it unreachable from harnesses.
        for tool in &names {
            assert!(tool_op(tool).is_ok(), "advertised tool {tool} has no tool_op mapping");
        }
        // Read-only tools carry the annotation so MCP clients can auto-approve.
        let screenshot = schemas.iter().find(|t| t["name"] == "screenshot").unwrap();
        assert_eq!(screenshot["annotations"]["readOnlyHint"], true);
    }

    #[test]
    fn conduit_tool_routing_uses_tools_namespace() {
        assert_eq!(tool_op("generate_document").unwrap(), "conduit_tools:generate_document");
        // The plan-compiled design path is reachable from harnesses too.
        assert_eq!(tool_op("plan_document").unwrap(), "conduit_tools:plan_document");
        assert_eq!(tool_op("revise_document").unwrap(), "conduit_tools:revise_document");
        assert_eq!(tool_op("search_docs").unwrap(), "conduit_tools:search_docs");
        assert_eq!(tool_op("navigate").unwrap(), "navigate"); // browser tools unchanged
        // New browser tools keep their bare op names (dispatched in
        // browser_mcp::dispatch) — never the conduit_tools namespace.
        for tool in ["history", "hover", "evaluate", "click_and_wait"] {
            assert_eq!(tool_op(tool).unwrap(), tool, "expected bare op for {tool}");
        }
        assert!(tool_op("bogus").is_err()); // unknown tools error, not misroute
    }

    #[test]
    fn new_browser_tool_schemas_require_correct_args() {
        let schemas = tool_schemas();
        let by_name = |n: &str| schemas.iter().find(|t| t["name"] == n).unwrap();
        // hover / evaluate / click_and_wait require their primary arg.
        assert_eq!(by_name("hover")["inputSchema"]["required"][0], "selector_or_description");
        assert_eq!(by_name("evaluate")["inputSchema"]["required"][0], "expression");
        assert_eq!(by_name("click_and_wait")["inputSchema"]["required"][0], "selector_or_description");
        // history defaults to 'back'.
        let props = &by_name("history")["inputSchema"]["properties"];
        assert_eq!(props["direction"]["default"], "back");
    }

    #[test]
    fn notifications_get_no_response() {
        // JSON-RPC: notifications (no id, or null id) must be answered with
        // silence. The old code emitted a bare `null` line for
        // notifications/initialized and id:null errors for unknown
        // notifications — both protocol violations.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let url = "ws://127.0.0.1:1/".to_string();
            let pid = None;
            let mut ws = None;

            // Initialized notification (the MCP handshake's tail).
            assert!(handle_line(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &url, &pid, &mut ws,
            ).await.is_none());
            // Explicit null id is still a notification.
            assert!(handle_line(
                r#"{"jsonrpc":"2.0","id":null,"method":"notifications/initialized"}"#,
                &url, &pid, &mut ws,
            ).await.is_none());
            // Unknown NOTIFICATION: also silent (previously an id:null error).
            assert!(handle_line(
                r#"{"jsonrpc":"2.0","method":"notifications/cancelled"}"#,
                &url, &pid, &mut ws,
            ).await.is_none());

            // Requests WITH an id are still answered.
            let resp = handle_line(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
                &url, &pid, &mut ws,
            ).await.expect("initialize request must be answered");
            assert_eq!(resp["id"], 1);
            assert!(resp.get("result").is_some());

            // Unknown REQUEST: error response with the caller's id.
            let resp = handle_line(
                r#"{"jsonrpc":"2.0","id":7,"method":"bogus/method"}"#,
                &url, &pid, &mut ws,
            ).await.expect("unknown request must get an error response");
            assert_eq!(resp["id"], 7);
            assert!(resp.get("error").is_some());

            // Malformed JSON: parse error is answered with id:null (spec).
            let resp = handle_line("{not json", &url, &pid, &mut ws)
                .await
                .expect("parse errors must be answered");
            assert!(resp.get("error").is_some());
        });
    }
}
