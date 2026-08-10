//! Loopback WebSocket server: the bridge between the standalone
//! `conduit-browser-mcp` binary and the running Conduit app.
//!
//! The MCP binary (src/bin/conduit_browser_mcp.rs) speaks stdio JSON-RPC to a
//! harness (Claude Code / Kimi Code) and forwards every `tools/call` over a
//! loopback WebSocket to this server. Each request is dispatched against the
//! real visible browser pane via `BrowserManager`'s `run_action_for_pane` /
//! `read_page_for_pane` — the SAME eval-based bridge the Chat-tab browser
//! tools use, not a forked implementation.
//!
//! Wire envelope (one JSON object per WebSocket text frame):
//!   request:  { "op": "<op>", "project_id": "<str|null>", "pane_id": "<str|null>", "args": { ... } }
//!   response: { "ok": <value> } | { "ok": null, "error": { "code": "<str>", "message": "<str>" } }
//!
//! Error codes: not_found, nav_failure, timeout, browser_unavailable,
//! invalid_args, pane_not_found, unknown_op.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use crate::browser::{BrowserManager, ReadMode, ActionOpts, BROWSER_MCP_PORT};

/// Random auth token generated at startup so only the conduit-browser-mcp
/// binary can connect to the loopback WS. It is delivered to the binary via
/// the per-server env block of the generated `.mcp.json` / `opencode.json`
/// (CONDUIT_MCP_AUTH_TOKEN) — never process-wide, so pty shells and agent
/// processes don't inherit it.
static MCP_AUTH_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Upper bound for the `wait_for` op's caller-supplied timeout. The value is
/// untrusted LLM JSON arriving over the WS bridge: unclamped, a huge
/// `timeout_ms` starves the sequential dispatch loop (every other browser op
/// queues behind it for days) and `Instant + Duration` panics outright near
/// u64::MAX.
const MAX_WAIT_FOR_MS: u64 = 120_000;

/// Parse + clamp the untrusted `timeout_ms` arg for `wait_for`
/// (see MAX_WAIT_FOR_MS). Defaults to 10 s when absent.
fn wait_for_timeout_ms(args: &Value) -> u64 {
    args.get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(10_000)
        .min(MAX_WAIT_FOR_MS)
}

/// Return the current MCP auth token, generating one if this is the first call.
pub fn mcp_auth_token() -> &'static str {
    MCP_AUTH_TOKEN.get_or_init(|| format!("{:032x}", rand::random::<u128>()))
}

/// A structured error returned to the MCP binary over the WebSocket. The
/// binary maps these to JSON-RPC error objects so the agent gets an
/// actionable message ("element not found, try re-reading the page") instead
/// of a bare stack trace.
#[derive(Debug, Clone, Serialize)]
pub struct McpError {
    pub code: &'static str,
    pub message: String,
}

impl McpError {
    fn invalid_args(msg: impl Into<String>) -> Self {
        Self { code: "invalid_args", message: msg.into() }
    }
    fn unknown_op(op: &str) -> Self {
        Self { code: "unknown_op", message: format!("unknown operation: {op}") }
    }
    /// Map a `run_action`/`read_page` String error to the best-fit code. The
    /// bridge reports `'ERROR: ...'` strings for JS-side failures; we surface
    /// the text and let the code default to the op's domain (caller tags it).
    fn from_action_err(err: String) -> Self {
        let lower = err.to_lowercase();
        let code = if lower.contains("timed out") || lower.contains("still loading") {
            "timeout"
        } else if lower.contains("no element") || lower.contains("not found") {
            "not_found"
        } else if lower.contains("no page is open") || lower.contains("no browser webview") {
            "pane_not_found"
        } else {
            "action_failed"
        };
        Self { code, message: err }
    }
}

/// Bind 127.0.0.1 on the fixed BROWSER_MCP_PORT and serve connections until
/// the app exits. Non-fatal if the bind fails (the MCP binary will just see
/// connection-refused → `browser_unavailable`). Generates a random auth token
/// at startup; it reaches the conduit-browser-mcp binary via the env block of
/// the generated MCP configs so only that binary can connect.
pub async fn serve(browser: Arc<BrowserManager>, app: AppHandle) {
    let token = mcp_auth_token();
    let addr = format!("127.0.0.1:{BROWSER_MCP_PORT}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            eprintln!("[conduit:browser-mcp] WebSocket server listening on ws://{addr}");
            l
        }
        Err(e) => {
            eprintln!(
                "[conduit:browser-mcp] FAILED to bind {addr}: {e} — agent browser tools will be unavailable"
            );
            return;
        }
    };

    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let browser = browser.clone();
                let app = app.clone();
                let expected_token = token.to_string();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, browser, app, &expected_token).await {
                        eprintln!("[conduit:browser-mcp] connection error: {e}");
                    }
                });
            }
            Err(e) => {
                eprintln!("[conduit:browser-mcp] accept error: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    browser: Arc<BrowserManager>,
    app: AppHandle,
    expected_token: &str,
) -> Result<(), String> {
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake failed: {e}"))?;
    let (mut write, mut read) = ws_stream.split();

    // Auth gate: the first text message MUST be {"auth":"<token>"}.
    // Any other first message (including close) rejects the connection.
    // The conduit-browser-mcp binary reads CONDUIT_MCP_AUTH_TOKEN from
    // the environment at startup and sends this as its first message.
    let first = loop {
        if let Some(msg) = read.next().await {
            let msg = msg.map_err(|e| format!("ws read failed: {e}"))?;
            if msg.is_close() {
                return Err("connection closed before auth".into());
            }
            if let Message::Text(t) = msg {
                break t;
            }
            // Ignore ping/pong/binary before auth.
        } else {
            return Err("connection closed before auth".into());
        }
    };
    let auth: serde_json::Value = serde_json::from_str(&first)
        .map_err(|e| format!("malformed auth message: {e}"))?;
    let token_ok = auth.get("auth")
        .and_then(|v| v.as_str())
        .map(|t| {
            // Constant-time comparison to prevent timing side-channels.
            // `subtle` is in the dep tree (via rustls); use a simple
            // byte-level XOR-length check when lengths differ to avoid
            // short-circuiting on length mismatch.
            if t.as_bytes().len() != expected_token.as_bytes().len() {
                // Still do a comparison to burn the same cycles — compare
                // against a slice of matching length (prefix of expected_token).
                let _ = expected_token.as_bytes().iter().zip(t.as_bytes().iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b));
                false
            } else {
                expected_token.as_bytes().iter().zip(t.as_bytes().iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
            }
        })
        .unwrap_or(false);
    if !token_ok {
        let _ = write.send(Message::Text(r#"{"error":"unauthorized"}"#.into())).await;
        return Err("MCP auth token mismatch — connection rejected".into());
    }

    while let Some(msg) = read.next().await {
        let msg = msg.map_err(|e| format!("ws read failed: {e}"))?;
        if msg.is_close() {
            break;
        }
        // Only text frames carry JSON-RPC forwards; binary/ping are ignored.
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(p) => {
                let _ = write.send(Message::Pong(p)).await;
                continue;
            }
            _ => continue,
        };

        let response = match serde_json::from_str::<Request>(&text) {
            Ok(req) => dispatch(&req, &browser, &app).await,
            Err(e) => Err(McpError::invalid_args(format!("malformed request: {e}"))),
        };
        let resp_json = match response {
            Ok(value) => serde_json::json!({ "ok": value }),
            Err(err) => serde_json::json!({ "ok": null, "error": err }),
        };
        let resp_text = serde_json::to_string(&resp_json).unwrap_or_else(|_| r#"{"ok":null}"#.into());
        write
            .send(Message::Text(resp_text))
            .await
            .map_err(|e| format!("ws write failed: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    pane_id: Option<String>,
    #[serde(default)]
    args: Value,
}

/// Resolve the target pane label for a request, auto-opening one on `navigate`
/// when none exists for the project. Returns the label or a structured error.
/// Every successfully-resolved op also emits `browser:activity` so the
/// frontend surfaces the Browser tab — agent browser work should be visible
/// the moment it happens (same auto-open contract as generated artifacts).
async fn resolve_or_open(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<String, McpError> {
    let label = if let Some(label) =
        resolve_label(browser, req.project_id.as_deref(), req.pane_id.as_deref()).await?
    {
        // Explicit pane_id always wins. A genuine resolution failure (stale
        // pane_id, missing active tab) propagates — it must NOT be mistaken for
        // "no pane yet", or navigate would silently auto-open a duplicate pane.
        label
    } else if req.op == "navigate" {
        // No resolvable pane. For navigate we auto-open; for everything else the
        // caller must read_page first (or the agent should navigate).
        let project_id = req.project_id.as_deref().ok_or_else(|| McpError {
            code: "pane_not_found",
            message: "no browser pane is open for this project — call navigate first".to_string(),
        })?;
        let url = req.args.get("url").and_then(|v| v.as_str()).unwrap_or("about:blank");
        browser
            .open_pane_for_project(project_id, url)
            .await
            .map_err(|e| McpError { code: "pane_not_found", message: e })?
    } else {
        return Err(McpError {
            code: "pane_not_found",
            message: "no browser pane is open for this project — call navigate first".to_string(),
        });
    };
    if let Some((pane_id, _tab_id)) = parse_label(&label) {
        let _ = app.emit("browser:activity", serde_json::json!({ "pane_id": pane_id }));
    }
    Ok(label)
}

/// Thin wrapper around BrowserManager::resolve_pane_label: Ok(Some) resolved
/// a label, Ok(None) is the genuine "no pane yet" case (the caller may
/// auto-open on navigate), Err is a real resolution failure that must surface
/// to the agent instead of being treated as not-found.
async fn resolve_label(
    browser: &BrowserManager,
    project_id: Option<&str>,
    pane_id: Option<&str>,
) -> Result<Option<String>, McpError> {
    map_resolve_result(browser.resolve_pane_label(project_id, pane_id).await)
}

/// Map a `resolve_pane_label` outcome: the `pane_not_found` sentinel and the
/// global-active miss ("No page is open…") both mean "no pane exists" → None
/// (auto-open candidate). Anything else (e.g. "no active tab for pane X" from
/// a stale explicit pane_id) is a real failure — previously it was logged and
/// swallowed as None, so `navigate` auto-opened a duplicate pane.
fn map_resolve_result(res: Result<String, String>) -> Result<Option<String>, McpError> {
    match res {
        Ok(label) => Ok(Some(label)),
        Err(e) if e == "pane_not_found" => Ok(None),
        Err(e) if e.starts_with("No page is open") => Ok(None),
        Err(e) => {
            eprintln!("[conduit:browser-mcp] pane resolution failed: {e}");
            Err(McpError { code: "pane_not_found", message: e })
        }
    }
}

async fn dispatch(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    match req.op.as_str() {
        "navigate" => op_navigate(req, browser, app).await,
        "read_page" => op_read_page(req, browser, app).await,
        "click" => op_click(req, browser, app).await,
        "type_text" => op_type_text(req, browser, app).await,
        "scroll" => op_scroll(req, browser, app).await,
        "wait_for" => op_wait_for(req, browser, app).await,
        "screenshot" => op_screenshot(req, browser, app).await,
        op if crate::mcp_tools_bridge::tool_from_op(op).is_some() => {
            let tool = crate::mcp_tools_bridge::tool_from_op(op).unwrap();
            let args = req.args.clone();
            match crate::mcp_tools_bridge::execute_conduit_tool(app, &tool, &args).await {
                Ok(v) => Ok(v),
                Err(e) => Err(e),
            }
        }
        other => Err(McpError::unknown_op(other)),
    }
}

/// Resolve the watch-mode pacing opts for a pane. Reads the global `watchMode`
/// setting from the DB; if the pane isn't visible (backgrounded), forces
/// watch_mode to false even when the global setting is on.
fn resolve_action_opts(app: &AppHandle, pane_id: Option<&str>) -> ActionOpts {
    let global_on = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        crate::db::get_setting(&conn, "watchMode")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(false)
    };
    // If the pane is not visible, skip pacing even when the global setting is on.
    let watch_mode = if global_on {
        pane_id.map_or(true, |pid| {
            let browser_state = app.state::<crate::BrowserState>();
            browser_state.0.pane_is_visible(pid)
        })
    } else {
        false
    };
    ActionOpts { watch_mode, pane_delay_ms: 250 }
}

// ---- per-op handlers -------------------------------------------------------

/// Capture the pane's current page as PNG. Saves the shot into the artifacts
/// dir (so the user can open it in the canvas and the agent can embed the
/// path in chat — local images render via the chat's IPC image loader) and
/// returns the path + base64 payload; the MCP binary turns the base64 into
/// an MCP image content block so the agent can actually SEE the page.
async fn op_screenshot(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let mgr = app.state::<crate::BrowserState>().0.clone();
    let png = tokio::task::spawn_blocking(move || mgr.capture_pane_png(&label))
        .await
        .map_err(|e| McpError {
            code: "browser_unavailable",
            message: format!("capture task failed: {e}"),
        })?
        .ok_or_else(|| McpError {
            code: "browser_unavailable",
            message: "screenshot capture failed (unsupported platform or no page is open)".to_string(),
        })?;
    let dir = crate::chat::dispatch::artifacts_dir(app);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[conduit:browser-mcp] artifacts dir create failed: {e}");
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let filename = format!("browser-shot-{millis}.png");
    let path = dir.join(&filename);
    std::fs::write(&path, &png).map_err(|e| McpError {
        code: "browser_unavailable",
        message: format!("could not save screenshot: {e}"),
    })?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "png_base64": crate::chat::commands::base64_encode(&png),
    }))
}

async fn op_navigate(
    req: &Request,
    browser: &BrowserManager,
    _app: &AppHandle,
) -> Result<Value, McpError> {
    let url = req
        .args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("navigate requires 'url' (string)"))?;

    // Auto-open if no pane exists yet (resolve_or_open handles it).
    let label = resolve_or_open(req, browser, _app).await?;

    // We need (pane_id, tab_id) to call BrowserManager::navigate. The label is
    // `browser-{pane}-tab-{tab}` — parse it back. (The manager's navigate also
    // sets `active` + `pane_active_tab`, keeping subsequent ops on this pane.)
    let (pane_id, tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    browser
        .navigate(&pane_id, &tab_id, url)
        .map_err(|e| McpError { code: "nav_failure", message: e })?;

    // Best-effort title read (non-fatal if it fails).
    let title = browser
        .run_action_for_pane(&label, "return document.title || '';")
        .await
        .unwrap_or_default();
    Ok(serde_json::json!({ "url": url, "title": title.trim(), "pane_id": pane_id }))
}

async fn op_read_page(
    req: &Request,
    browser: &BrowserManager,
    _app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, _app).await?;
    let mode_str = req.args.get("mode").and_then(|v| v.as_str()).unwrap_or("interactive");
    let mode = match mode_str {
        "interactive" => ReadMode::Interactive,
        "content" | "full" => ReadMode::Full,
        "summary" | "summary_only" => ReadMode::SummaryOnly,
        "section" => ReadMode::Section,
        other => return Err(McpError::invalid_args(format!("unknown read mode: {other}"))),
    };
    let selector = req.args.get("selector").and_then(|v| v.as_str());
    let result = browser
        .read_page_for_pane(&label, mode, selector)
        .await
        .map_err(McpError::from_action_err)?;
    // read_page returns a fenced string; pass it through as the text payload.
    // The MCP binary wraps it as a tool result content block.
    Ok(serde_json::json!({ "content": result }))
}

async fn op_click(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let desc = req
        .args
        .get("selector_or_description")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("click requires 'selector_or_description' (string)"))?;
    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let opts = resolve_action_opts(app, Some(&pane_id));
    // resolve_and_click_opts runs bridge_resolve.js (CSS selector then scored
    // label/aria match) and clicks the resolved element with pacing opts, or
    // returns a not_found JSON with top-10 suggestions for the agent to retry.
    let result = browser
        .resolve_and_click_opts(&label, desc, &opts)
        .await
        .map_err(McpError::from_action_err)?;
    interpret_resolve_result(result)
}

async fn op_type_text(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let desc = req
        .args
        .get("selector_or_description")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("type_text requires 'selector_or_description' (string)"))?;
    let text = req
        .args
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("type_text requires 'text' (string)"))?;
    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let opts = resolve_action_opts(app, Some(&pane_id));
    let result = browser
        .resolve_and_type_opts(&label, desc, text, &opts)
        .await
        .map_err(McpError::from_action_err)?;
    interpret_resolve_result(result)
}

/// The bridge returns a JSON envelope: `{"ok":true,...}` for a successful
/// resolve+act, or `{"ok":false,"error":"not_found","suggestions":[...]}` when
/// no element matched. Surface the ok payload to the agent, or map not_found
/// to a structured McpError carrying the suggestions so the agent can retry.
fn interpret_resolve_result(result: String) -> Result<Value, McpError> {
    let v: Value = serde_json::from_str(&result)
        .map_err(|e| McpError { code: "action_failed", message: format!("bad resolve result: {e}: {result}") })?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        Ok(v)
    } else {
        let err_code = v.get("error").and_then(|x| x.as_str()).unwrap_or("not_found");
        let suggestions = v.get("suggestions").cloned().unwrap_or(Value::Array(vec![]));
        let message = format!(
            "element not found for '{}'. Top suggestions: {}",
            v.get("desc").and_then(|x| x.as_str()).unwrap_or(""),
            serde_json::to_string(&suggestions).unwrap_or_else(|_| "[]".into())
        );
        Err(McpError {
            code: if err_code == "not_found" { "not_found" } else { "action_failed" },
            message,
        })
    }
}

async fn op_scroll(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let direction = req
        .args
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("down");
    let dy: i64 = match direction {
        "up" => -600,
        "down" => 600,
        other => return Err(McpError::invalid_args(format!("scroll direction must be up|down, got {other}"))),
    };
    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let opts = resolve_action_opts(app, Some(&pane_id));
    let result = browser
        .run_action_for_pane_opts(&label, &format!(
            "window.scrollBy(0, {dy}); return 'Scrolled {direction}. scrollY=' + Math.round(window.scrollY) + ' of ' + Math.round(document.body ? document.body.scrollHeight : 0) + '.';"
        ), opts)
        .await
        .map_err(McpError::from_action_err)?;
    Ok(serde_json::json!({ "result": result }))
}

async fn op_wait_for(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let condition = req
        .args
        .get("condition")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("wait_for requires 'condition'"))?;
    let target = req.args.get("target").and_then(|v| v.as_str());
    let timeout_ms = wait_for_timeout_ms(&req.args);

    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let opts = resolve_action_opts(app, Some(&pane_id));

    let started = std::time::Instant::now();
    // checked_add on top of the clamp — belt and braces against Instant
    // overflow on platforms with exotic monotonic clocks.
    let deadline = started
        .checked_add(std::time::Duration::from_millis(timeout_ms))
        .unwrap_or_else(|| started + std::time::Duration::from_millis(MAX_WAIT_FOR_MS));
    let mut resolved = false;
    let mut detail = String::new();

    while std::time::Instant::now() < deadline {
        let check_js = match condition {
            "navigation" => {
                // Poll the current URL; resolved when it differs from `target`
                // (the pre-navigation URL the caller snapshotted) — or, if no
                // target given, just confirm readyState == complete.
                if let Some(prev) = target {
                    format!(
                        "return JSON.stringify({{ url: location.href, changed: location.href !== {prev_js} }});",
                        prev_js = serde_json::to_string(prev).unwrap_or_else(|_| "\"\"".into())
                    )
                } else {
                    "return JSON.stringify({ url: location.href, changed: document.readyState === 'complete' });".to_string()
                }
            }
            "selector" => {
                let sel = target.unwrap_or("");
                format!(
                    "return JSON.stringify({{ found: !!document.querySelector({sel_js}) }});",
                    sel_js = serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into())
                )
            }
            "network_idle" => {
                "return JSON.stringify({ idle: document.readyState === 'complete' });".to_string()
            }
            other => return Err(McpError::invalid_args(format!("wait_for condition must be navigation|selector|network_idle, got {other}"))),
        };

        match browser.run_action_for_pane_opts(&label, &check_js, opts.clone()).await {
            Ok(s) => {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    match condition {
                        "navigation" => {
                            if v.get("changed").and_then(|x| x.as_bool()).unwrap_or(false) {
                                resolved = true;
                                detail = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
                                break;
                            }
                        }
                        "selector" => {
                            if v.get("found").and_then(|x| x.as_bool()).unwrap_or(false) {
                                resolved = true;
                                break;
                            }
                        }
                        "network_idle" => {
                            if v.get("idle").and_then(|x| x.as_bool()).unwrap_or(false) {
                                // Require a 500ms quiet period: re-check once
                                // after a short sleep to avoid declaring idle
                                // mid-navigation.
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                if let Ok(s2) = browser.run_action_for_pane_opts(&label, &check_js, opts.clone()).await {
                                    if let Ok(v2) = serde_json::from_str::<Value>(&s2) {
                                        if v2.get("idle").and_then(|x| x.as_bool()).unwrap_or(false) {
                                            resolved = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                // A mid-navigation eval may fail transiently; keep polling
                // unless we've blown the deadline.
                eprintln!("[conduit:browser-mcp] wait_for poll error: {e}");
            }
        }
        let step = if condition == "selector" { 200 } else { 300 };
        tokio::time::sleep(std::time::Duration::from_millis(step)).await;
    }

    Ok(serde_json::json!({
        "resolved": resolved,
        "condition": condition,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "detail": detail,
    }))
}

// ---- helpers ---------------------------------------------------------------

/// Parse `browser-{pane}-tab-{tab}` back into (pane_id, tab_id). Returns None
/// if the shape doesn't match (defensive — labels are always built by
/// `browser_label`, but a corrupt label shouldn't panic the server).
fn parse_label(label: &str) -> Option<(String, String)> {
    let rest = label.strip_prefix("browser-")?;
    let idx = rest.find("-tab-")?;
    let pane = &rest[..idx];
    let tab = &rest[idx + 5..];
    if pane.is_empty() || tab.is_empty() {
        return None;
    }
    Some((pane.to_string(), tab.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_label_round_trips_browser_label() {
        assert_eq!(parse_label("browser-abc-123-tab-default"), Some(("abc-123".into(), "default".into())));
        assert_eq!(parse_label("browser-pane-1-tab-tab-2"), Some(("pane-1".into(), "tab-2".into())));
        assert_eq!(parse_label("not-a-label"), None);
        assert_eq!(parse_label("browser-x-tab-"), None); // empty tab
    }

    #[test]
    fn mcp_error_maps_timeout_and_not_found() {
        assert_eq!(McpError::from_action_err("browser action timed out".into()).code, "timeout");
        assert_eq!(McpError::from_action_err("no element with ref 3".into()).code, "not_found");
        assert_eq!(
            McpError::from_action_err("no page is open in the browser pane".into()).code,
            "pane_not_found"
        );
        assert_eq!(McpError::from_action_err("something else".into()).code, "action_failed");
    }

    #[test]
    fn resolve_result_maps_not_found_sentinel_but_surfaces_real_errors() {
        // Resolved label passes through.
        assert_eq!(
            map_resolve_result(Ok("browser-p1-tab-t1".into())).unwrap(),
            Some("browser-p1-tab-t1".into())
        );
        // The pane_not_found sentinel → None (caller may auto-open).
        assert_eq!(map_resolve_result(Err("pane_not_found".into())).unwrap(), None);
        // Global-active miss is also a genuine "no pane exists" → None.
        assert_eq!(
            map_resolve_result(Err("No page is open in the browser pane yet — call open_url first.".into())).unwrap(),
            None
        );
        // A real failure (stale explicit pane_id) must surface as an error —
        // previously swallowed as None, so navigate auto-opened a duplicate pane.
        let err = map_resolve_result(Err("no active tab for pane ghost".into())).unwrap_err();
        assert_eq!(err.code, "pane_not_found");
        assert!(err.message.contains("no active tab for pane ghost"));
    }

    #[test]
    fn wait_for_timeout_is_clamped() {
        // Untrusted LLM JSON: absent → default, small → passthrough,
        // u64::MAX → clamped (previously panicked Instant arithmetic and
        // starved the sequential dispatch loop).
        assert_eq!(wait_for_timeout_ms(&serde_json::json!({})), 10_000);
        assert_eq!(wait_for_timeout_ms(&serde_json::json!({ "timeout_ms": 5_000 })), 5_000);
        assert_eq!(wait_for_timeout_ms(&serde_json::json!({ "timeout_ms": u64::MAX })), MAX_WAIT_FOR_MS);
        // Non-numeric junk falls back to the default, not a panic.
        assert_eq!(wait_for_timeout_ms(&serde_json::json!({ "timeout_ms": "soon" })), 10_000);
    }
}
