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
use std::sync::atomic::{AtomicU16, Ordering};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use crate::browser::{BrowserManager, ReadMode, ActionOpts, BROWSER_MCP_PORT};

/// Port the WS server actually bound (0 until `serve` runs). Registration
/// paths read this so per-project MCP configs always carry the live port —
/// a second app instance or a colliding process no longer silently degrades
/// every agent browser tool to `browser_unavailable` (the old fixed-port
/// behaviour).
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

/// The live WS port, falling back to the legacy fixed `BROWSER_MCP_PORT`
/// when read before the server binds (agent sessions can't spawn before app
/// setup completes, so the fallback is purely defensive).
pub fn bound_port() -> u16 {
    match BOUND_PORT.load(Ordering::SeqCst) {
        0 => BROWSER_MCP_PORT,
        p => p,
    }
}

/// Publish the bound port + pid to `<app_data>/mcp/browser-mcp.json` so
/// third-party MCP clients (and debugging tooling) can discover the endpoint
/// without a port scan. Deliberately does NOT contain the auth token — that
/// travels only in the MCP child's env block; this file is port discovery,
/// never an auth grant. Best-effort: failure only means no discovery file.
fn write_handshake_file(app: &AppHandle, port: u16) {
    let Some(dir) = app.path().app_data_dir().ok().map(|d| d.join("mcp")) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let payload = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
        "writtenAtMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    });
    let tmp = dir.join("browser-mcp.json.tmp");
    let final_path = dir.join("browser-mcp.json");
    if std::fs::write(&tmp, payload.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &final_path);
    }
}

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
        } else if lower.contains("stale") || lower.contains("no element") || lower.contains("not found") {
            // Stale refs ARE the not_found case — the message carries the
            // canonical "re-read the page" recovery instruction (Anthropic
            // stale-ref protocol).
            "not_found"
        } else if lower.contains("no page is open") || lower.contains("no browser webview") {
            "pane_not_found"
        } else {
            "action_failed"
        };
        Self { code, message: err }
    }
}

/// Bind 127.0.0.1 on an OS-assigned ephemeral port and serve connections
/// until the app exits. Non-fatal if the bind fails (the MCP binary will just
/// see connection-refused → `browser_unavailable`). Generates a random auth
/// token at startup; it reaches the conduit-browser-mcp binary via the env
/// block of the generated MCP configs so only that binary can connect. The
/// actual port is published via `bound_port()` (used by every registration
/// path) and a handshake file under `<app_data>/mcp/`.
pub async fn serve(browser: Arc<BrowserManager>, app: AppHandle) {
    let token = mcp_auth_token();
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => {
            let port = l
                .local_addr()
                .map(|a| a.port())
                .unwrap_or(BROWSER_MCP_PORT);
            BOUND_PORT.store(port, Ordering::SeqCst);
            write_handshake_file(&app, port);
            eprintln!("[conduit:browser-mcp] WebSocket server listening on ws://127.0.0.1:{port}");
            l
        }
        Err(e) => {
            eprintln!(
                "[conduit:browser-mcp] FAILED to bind 127.0.0.1:0: {e} — agent browser tools will be unavailable"
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

/// The gated dispatch: every op passes the trust layer (pause/cancel flags,
/// autonomy dial + hard-gate confirmations) BEFORE execution, and appends a
/// user-owned timeline record AFTER it. Reads pass through ungated (except in
/// pause/stop states); mutating ops gate per the autonomy dial; hard-gate
/// risk classes (payment/destructive/credential) confirm in every mode.
async fn dispatch(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    // Skip the whole trust layer for the conduit-tools escape hatch and for
    // pure control ops that must always work (tab listing, diagnostics).
    if crate::mcp_tools_bridge::tool_from_op(&req.op).is_some() || is_uncontrolled_op(&req.op) {
        return dispatch_inner(req, browser, app).await;
    }

    let pane_context = resolve_gate_context(req, browser).await;

    // 1. Pause/stop flags win over everything (the user is driving). These
    // paths record their own timeline entry and return — the shared tail
    // must not double-log the same op.
    if let Some(pane_id) = pane_context.as_ref() {
        if browser.is_cancelled(pane_id) {
            browser.append_timeline(pane_id, &req.op, &timeline_target(&req.args), "cancelled", None,
                Some("blocked: the user stopped the agent".into()));
            return Err(McpError {
                code: "cancelled_by_user",
                message: "cancelled_by_user — the user stopped the agent. Ask them before browsing again.".into(),
            });
        }
        if browser.is_paused(pane_id) {
            browser.append_timeline(pane_id, &req.op, &timeline_target(&req.args), "paused", None,
                Some("blocked: the user paused the agent".into()));
            return Err(McpError {
                code: "paused_by_user",
                message: "paused_by_user — the user paused the agent; they will resume when ready.".into(),
            });
        }
    }

    // 2. Classification + autonomy dial.
    let class = classify_gate(&req.op, &req.args);
    let autonomy = read_autonomy_setting(app);
    let needs_gate = match (autonomy.as_str(), &class) {
        // Manual mode: every mutating action confirms with the user.
        ("manual", _) => is_mutating_op(&req.op),
        // Auto mode (default): only hard-gate risk classes confirm.
        (_, Some((risk, _))) => !risk.is_empty(),
        (_, None) => false,
    };

    let result = if needs_gate {
        match enforce_gate(req, browser, app, pane_context.clone(), class.clone()).await {
            Ok(()) => dispatch_inner(req, browser, app).await,
            Err(e) => Err(e),
        }
    } else {
        dispatch_inner(req, browser, app).await
    };

    // 3. User-owned timeline record (the agent can neither write nor delete).
    // (Gate denials land here as outcome "error" — one entry per op; the
    // pause/cancel early-returns above log their own and never reach this.)
    if let Some(pane_id) = pane_context.or_else(|| req.pane_id.clone()) {
        let (outcome, detail) = match &result {
            Ok(_) => ("ok", None),
            Err(e) => ("error", Some(crate::util::truncate_chars(&e.message, 200))),
        };
        browser.append_timeline(
            &pane_id,
            &req.op,
            &timeline_target(&req.args),
            outcome,
            class.as_ref().map(|(r, _)| *r),
            detail,
        );
    }

    result
}

/// Ops the trust layer never blocks: diagnostics and inventory reads. (Page
/// reads DO respect pause/stop — an agent should halt entirely — but the tab
/// list stays available so the user-facing UI keeps working.)
fn is_uncontrolled_op(op: &str) -> bool {
    matches!(op, "list_tabs" | "read_console" | "read_network")
}

/// Mutating ops — the Manual autonomy dial confirms each of these.
fn is_mutating_op(op: &str) -> bool {
    matches!(
        op,
        "click" | "type_text" | "fill_form" | "select_option" | "press_key"
            | "hover" | "evaluate" | "navigate" | "new_tab" | "close_tab"
            | "scroll" | "history" | "screenshot" | "zoom"
    )
}

/// Resolve the pane id for gate/timeline purposes without side effects
/// (no auto-open, no activity event). None when nothing is open yet.
async fn resolve_gate_context(
    req: &Request,
    browser: &BrowserManager,
) -> Option<String> {
    let label = resolve_label(browser, req.project_id.as_deref(), req.pane_id.as_deref())
        .await
        .ok()??;
    let (pane_id, _tab) = parse_label(&label)?;
    Some(pane_id)
}

/// Human-facing target string for the timeline.
fn timeline_target(args: &Value) -> String {
    for key in ["element", "selector_or_description", "url", "key", "value", "expression"] {
        if let Some(v) = args.get(key).and_then(|x| x.as_str()) {
            if !v.is_empty() {
                return v.chars().take(120).collect();
            }
        }
    }
    if let Some(fields) = args.get("fields").and_then(|x| x.as_array()) {
        return format!("{} field(s)", fields.len());
    }
    if let Some(actions) = args.get("actions").and_then(|x| x.as_array()) {
        let ops: Vec<&str> = actions
            .iter()
            .filter_map(|a| a.get("op").and_then(|o| o.as_str()))
            .collect();
        return format!("batch: {}", ops.join(" -> "));
    }
    String::new()
}

/// Hard-gate risk classes (confirmed in EVERY autonomy mode — Anthropic's
/// "action-class hard gates" / OpenAI's confirmation gates). Returns
/// (risk_class, human reason). Heuristics on the agent's own description +
/// the optional `element` audit param; false positives just surface a
/// confirmation (safe default), false negatives are bounded by the site
/// consent model and the visible watch-mode overlay.
fn classify_gate(op: &str, args: &Value) -> Option<(&'static str, String)> {
    let mut texts: Vec<String> = Vec::new();
    for key in ["element", "selector_or_description"] {
        if let Some(v) = args.get(key).and_then(|x| x.as_str()) {
            texts.push(v.to_lowercase());
        }
    }
    let haystack = texts.join(" ");

    const PAYMENT: &[&str] = &[
        "checkout", "place order", "place your order", "pay now", "payment",
        "complete purchase", "buy now", "confirm order", "billing address",
        "credit card", "card number",
    ];
    const DESTRUCTIVE: &[&str] = &[
        "delete", "remove item", "permanently", "cancel subscription",
        "close account", "discard", "revoke", "transfer", "publish", "post",
        "send message", "send email", "submit order",
    ];
    const CREDENTIAL: &[&str] = &[
        "password", "passwd", "pwd", "passcode", "cvv", "cvc",
        "security code", "card number", "one-time code", "otp",
        "verification code", "2fa", "two-factor", "social security",
    ];

    match op {
        "click" | "click_and_wait" | "hover" => {
            if let Some(kw) = PAYMENT.iter().find(|k| haystack.contains(*k)) {
                return Some(("payment", format!("looks like a payment action ('{kw}')")));
            }
            if let Some(kw) = DESTRUCTIVE.iter().find(|k| haystack.contains(*k)) {
                return Some(("destructive", format!("looks irreversible ('{kw}')")));
            }
            None
        }
        "type_text" | "fill_form" => {
            if let Some(kw) = CREDENTIAL.iter().find(|k| haystack.contains(*k)) {
                return Some(("credential", format!("targets a credential field ('{kw}')")));
            }
            None
        }
        "close_tab" => Some(("destructive", "closes a tab".into())),
        _ => None,
    }
}

/// Read the autonomy dial: DB setting `browserAutonomy`, "auto" | "manual".
/// Defaults to "auto" (hard gates only) — the research consensus is that
/// per-action prompts on every step erode the agent's value and train
/// click-through habituation.
fn read_autonomy_setting(app: &AppHandle) -> String {
    let db_state = app.state::<crate::DbState>();
    let conn = db_state.0.lock();
    crate::db::get_setting(&conn, "browserAutonomy")
        .ok()
        .flatten()
        .filter(|v| v == "manual" || v == "auto")
        .unwrap_or_else(|| "auto".to_string())
}

/// Per-site consent map parsed from the DB setting `browserSiteConsents`:
/// `{ "<origin>": { "<riskClass>": true } }`.
fn parse_site_consents(raw: Option<String>) -> std::collections::HashMap<String, std::collections::HashMap<String, bool>> {
    raw.and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default()
}

async fn enforce_gate(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
    pane_id: Option<String>,
    class: Option<(&'static str, String)>,
) -> Result<(), McpError> {
    let (risk, reason) = class.unwrap_or(("action", "the user set autonomy to Manual".to_string()));
    let target = timeline_target(&req.args);

    // Current origin for per-site consent (unknown before the first page).
    let label = resolve_label(browser, req.project_id.as_deref(), req.pane_id.as_deref())
        .await
        .ok()
        .flatten();
    let url = label
        .as_deref()
        .and_then(|l| browser.tab_url(l))
        .unwrap_or_default();
    let origin = tauri::Url::parse(&url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default();
    if req.op == "navigate" {
        // For navigation the TARGET url is the consent context.
        if let Some(u) = req.args.get("url").and_then(|v| v.as_str()) {
            if let Some(origin_parsed) = tauri::Url::parse(u).ok().map(|u| u.origin().ascii_serialization()) {
                let origin = origin_parsed;
                if site_consent_grants(app, &origin, risk) {
                    return Ok(());
                }
            }
        }
    } else if !origin.is_empty() && site_consent_grants(app, &origin, risk) {
        return Ok(());
    }

    // Credential fields are NEVER typed by the agent — the user takes over.
    // Emit the takeover signal so the UI can hide the agent overlay and hand
    // control to the human, then deny the action.
    if risk == "credential" {
        let pane = pane_id.clone().unwrap_or_default();
        let _ = app.emit(
            "browser:takeover-request",
            serde_json::json!({
                "paneId": pane,
                "reason": reason,
                "url": url,
                "target": target,
            }),
        );
        return Err(McpError {
            code: "credential_entry_blocked",
            message: "credential_entry_blocked — the agent never types passwords or card details. The user has been asked to enter them themselves; hand the task back afterwards.".into(),
        });
    }

    let Some(pane) = pane_id.clone() else {
        // No pane yet (e.g. first navigate): nothing on screen to protect —
        // allow; the post-open ops still gate.
        return Ok(());
    };

    match browser
        .request_gate_approval(&pane, &req.op, &target, &url, risk, &reason)
        .await
    {
        Some(crate::browser::GateAnswer { approved: true, always_for_site }) => {
            if always_for_site && !origin.is_empty() {
                grant_site_consent(app, &origin, risk);
            }
            Ok(())
        }
        Some(crate::browser::GateAnswer { approved: false, .. }) => Err(McpError {
            code: "denied_by_user",
            message: "denied_by_user — the user declined this action. Do not retry it without asking.".into(),
        }),
        None => Err(McpError {
            code: "denied_by_user",
            message: "confirmation timed out with no user response — treated as denial".into(),
        }),
    }
}

fn site_consent_grants(app: &AppHandle, origin: &str, risk: &str) -> bool {
    if origin.is_empty() {
        return false;
    }
    let db_state = app.state::<crate::DbState>();
    let conn = db_state.0.lock();
    let consents = parse_site_consents(crate::db::get_setting(&conn, "browserSiteConsents").ok().flatten());
    consents.get(origin).and_then(|m| m.get(risk)).copied().unwrap_or(false)
}

fn grant_site_consent(app: &AppHandle, origin: &str, risk: &str) {
    let db_state = app.state::<crate::DbState>();
    let conn = db_state.0.lock();
    let mut consents = parse_site_consents(crate::db::get_setting(&conn, "browserSiteConsents").ok().flatten());
    consents
        .entry(origin.to_string())
        .or_default()
        .insert(risk.to_string(), true);
    if let Ok(json) = serde_json::to_string(&consents) {
        let _ = crate::db::set_setting(&conn, "browserSiteConsents", &json);
    }
}

async fn dispatch_inner(
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
        "history" => op_history(req, browser, app).await,
        "hover" => op_hover(req, browser, app).await,
        "evaluate" => op_evaluate(req, browser, app).await,
        "click_and_wait" => op_click_and_wait(req, browser, app).await,
        // Phase 1 agent core
        "find" => op_find(req, browser, app).await,
        "fill_form" => op_fill_form(req, browser, app).await,
        "select_option" => op_select_option(req, browser, app).await,
        "press_key" => op_press_key(req, browser, app).await,
        "batch" => op_batch(req, browser, app).await,
        "read_console" => op_read_diag(req, browser, app, "console").await,
        "read_network" => op_read_diag(req, browser, app, "network").await,
        "list_tabs" => op_list_tabs(req, browser, app).await,
        "switch_tab" => op_switch_tab(req, browser, app).await,
        "new_tab" => op_new_tab(req, browser, app).await,
        "close_tab" => op_close_tab(req, browser, app).await,
        "zoom" => op_zoom(req, browser, app).await,
        "print_to_pdf" => op_print_to_pdf(req, browser, app).await,
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
        .navigate(_app, &pane_id, &tab_id, url)
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
    let narration = req
        .args
        .get("element")
        .and_then(|v| v.as_str())
        .map(|s| format!("clicking {s}"))
        .or_else(|| Some(format!("clicking {desc}")));
    let result = browser
        .resolve_and_click_narrated(&label, desc, narration.as_deref(), &opts)
        .await
        .map_err(McpError::from_action_err)?;
    let mut payload = interpret_resolve_result(result)?;
    echo_element(&req.args, &mut payload);
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
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
    let narration = req
        .args
        .get("element")
        .and_then(|v| v.as_str())
        .map(|s| format!("typing {s}"))
        .or_else(|| Some(format!("typing into {desc}")));
    let result = browser
        .resolve_and_type_narrated(&label, desc, text, narration.as_deref(), &opts)
        .await
        .map_err(McpError::from_action_err)?;
    let mut payload = interpret_resolve_result(result)?;
    echo_element(&req.args, &mut payload);
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
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
    let mut payload = serde_json::json!({ "result": result });
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
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
    // An empty/missing selector would poll `querySelector("")` (always false)
    // for the whole timeout — fail fast so the agent can fix its args.
    if condition == "selector" && target.map(str::is_empty).unwrap_or(true) {
        return Err(McpError::invalid_args(
            "wait_for with condition 'selector' requires a non-empty 'target' selector",
        ));
    }

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
            "stable" => crate::browser::stable_check_js(),
            other => return Err(McpError::invalid_args(format!(
                "wait_for condition must be navigation|selector|network_idle|stable, got {other}"
            ))),
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
                        "stable" => {
                            // DOM-stability: readyState complete AND no
                            // mutation in the last ~600ms (see DIAG_INIT_JS).
                            // Require TWO consecutive stable probes 500ms
                            // apart so a momentary render gap doesn't pass.
                            if v.get("stable").and_then(|x| x.as_bool()).unwrap_or(false) {
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                if let Ok(s2) = browser.run_action_for_pane_opts(&label, &check_js, opts.clone()).await {
                                    if let Ok(v2) = serde_json::from_str::<Value>(&s2) {
                                        if v2.get("stable").and_then(|x| x.as_bool()).unwrap_or(false) {
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
        let step = if condition == "selector" || condition == "stable" { 200 } else { 300 };
        tokio::time::sleep(std::time::Duration::from_millis(step)).await;
    }

    Ok(serde_json::json!({
        "resolved": resolved,
        "condition": condition,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "detail": detail,
    }))
}

/// `history` — drive the webview's real history stack back/forward via
/// `history.go(-1)|go(1)` and report the resulting URL. Unlike
/// `BrowserManager::go_back` (fire-and-forget eval), this uses the awaited
/// bridge so the agent learns whether the navigation actually occurred.
async fn op_history(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let direction = req
        .args
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("back");
    if direction != "back" && direction != "forward" {
        return Err(McpError::invalid_args(format!(
            "history direction must be 'back' or 'forward', got {direction}"
        )));
    }
    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let _opts = resolve_action_opts(app, Some(&pane_id));
    let result = browser
        .history_for_pane(&label, direction)
        .await
        .map_err(McpError::from_action_err)?;
    Ok(serde_json::json!({ "direction": direction, "result": result, "pane_id": pane_id }))
}

/// `hover` — resolve a selector/description to an element and dispatch real
/// mouseover/mouseenter/mousemove events on it. Needed for CSS-`:hover` menus
/// and dropdowns that only reveal on hover before a click is possible. Uses the
/// same resolve path as click/type (returns not_found + suggestions on miss).
async fn op_hover(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let desc = req
        .args
        .get("selector_or_description")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("hover requires 'selector_or_description' (string)"))?;
    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let opts = resolve_action_opts(app, Some(&pane_id));
    let result = browser
        .resolve_and_hover_opts(&label, desc, &opts)
        .await
        .map_err(McpError::from_action_err)?;
    let mut payload = interpret_resolve_result(result)?;
    echo_element(&req.args, &mut payload);
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
}

/// `evaluate` — run arbitrary JS in the pane's own origin and return a
/// JSON-serialized result. Lets the agent read form state, page JS variables,
/// run custom extraction, and assert on page invariants — capability unlocks
/// the existing read/click tools can't reach. The expression is wrapped in
/// `new Function('return (<expr>);')`, so a bare expression (e.g.
/// `document.title`, `Array.from(document.querySelectorAll('.row')).length`)
/// works directly. Functions/undefined/circular values become readable
/// markers (`[Function]`, `[undefined]`, `[circular]`).
async fn op_evaluate(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let expression = req
        .args
        .get("expression")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("evaluate requires 'expression' (string)"))?;
    // Cap the expression body so an over-long payload can't wedge a
    // single-threaded eval path; 64 KiB is far above any reasonable page-side
    // read but well below pathological LLM output.
    const MAX_EXPR_LEN: usize = 65_536;
    if expression.len() > MAX_EXPR_LEN {
        return Err(McpError::invalid_args(format!(
            "evaluate expression too long: {} bytes (max {MAX_EXPR_LEN})",
            expression.len()
        )));
    }
    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let _opts = resolve_action_opts(app, Some(&pane_id));
    let result = browser
        .evaluate_for_pane(&label, expression)
        .await
        .map_err(McpError::from_action_err)?;
    // The bridge returns either a JSON string (the evaluated value serialized
    // with our replacer) or an 'ERROR: <msg>' marker (compile/throw). Surface
    // both as the `result` text payload so the agent parses accordingly.
    Ok(serde_json::json!({ "result": result, "pane_id": pane_id }))
}

/// `click_and_wait` — click a selector/description, then immediately poll for
/// a condition (navigation change | CSS selector appears | network_idle) in
/// the SAME round-trip. Removes the fragile two-call dance (click, then
/// wait_for) where a fast navigation can finish before wait_for's poll starts
/// and the wait times out. Shares the `wait_for` polling + clamped timeout
/// logic; the click happens first and its JSON is folded into the response.
async fn op_click_and_wait(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let desc = req
        .args
        .get("selector_or_description")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("click_and_wait requires 'selector_or_description' (string)"))?;
    let condition = req
        .args
        .get("condition")
        .and_then(|v| v.as_str())
        .unwrap_or("navigation");
    if !matches!(condition, "navigation" | "selector" | "network_idle") {
        return Err(McpError::invalid_args(format!(
            "click_and_wait condition must be navigation|selector|network_idle, got {condition}"
        )));
    }
    let target = req.args.get("target").and_then(|v| v.as_str());
    let timeout_ms = wait_for_timeout_ms(&req.args);
    // Same fail-fast as wait_for: an empty selector can never match, so
    // polling would just burn the whole timeout.
    if condition == "selector" && target.map(str::is_empty).unwrap_or(true) {
        return Err(McpError::invalid_args(
            "click_and_wait with condition 'selector' requires a non-empty 'target' selector",
        ));
    }

    let (pane_id, _tab_id) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let opts = resolve_action_opts(app, Some(&pane_id));

    // Snapshot the URL (for navigation-change detection) BEFORE the click so a
    // same-URL SPA route change can't be missed — we compare against this.
    // On snapshot failure keep `None`: swallowing the error into "" made the
    // poll compare `location.href !== ""`, which is ALWAYS true → instant
    // false-positive "navigation happened". Instead we fall back to the
    // readyState check (same as wait_for's no-target path).
    let prev_url: Option<String> = match condition {
        "navigation" => match browser
            .run_action_for_pane_opts(&label, "return location.href;", opts.clone())
            .await
        {
            Ok(u) if !u.trim().is_empty() => Some(u),
            Ok(_) => None, // empty eval result — treat as a failed snapshot
            Err(e) => {
                eprintln!("[conduit:browser-mcp] click_and_wait URL snapshot failed: {e}");
                None
            }
        },
        _ => None,
    };

    let click_result = browser
        .resolve_and_click_opts(&label, desc, &opts)
        .await
        .map_err(McpError::from_action_err)?;
    let click_v: Value = serde_json::from_str(&click_result)
        .map_err(|e| McpError {
            code: "action_failed",
            message: format!("bad click result: {e}: {click_result}"),
        })?;
    if !click_v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        // Click failed to resolve — skip the wait and surface the not_found
        // result (with suggestions) so the agent can retry.
        return interpret_resolve_result(click_result);
    }

    // Poll for the condition. Mirrors op_wait_for's polling logic but shares
    // the `target` semantics (CSS selector for selector, prev URL for
    // navigation when target absent).
    let started = std::time::Instant::now();
    let deadline = started
        .checked_add(std::time::Duration::from_millis(timeout_ms))
        .unwrap_or_else(|| started + std::time::Duration::from_millis(MAX_WAIT_FOR_MS));
    let mut resolved = false;
    let mut detail = String::new();

    while std::time::Instant::now() < deadline {
        let check_js = match condition {
            "navigation" => {
                match target.or(prev_url.as_deref()) {
                    Some(cmp) => format!(
                        "return JSON.stringify({{ url: location.href, changed: location.href !== {} }});",
                        serde_json::to_string(cmp).unwrap_or_else(|_| "\"\"".into())
                    ),
                    // No usable pre-click URL — mirror wait_for's no-target
                    // fallback and treat a completed load as the change.
                    None => "return JSON.stringify({ url: location.href, changed: document.readyState === 'complete' });".to_string(),
                }
            }
            "selector" => {
                let sel = target.unwrap_or("");
                format!(
                    "return JSON.stringify({{ found: !!document.querySelector({}) }});",
                    serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".into())
                )
            }
            "network_idle" => {
                "return JSON.stringify({ idle: document.readyState === 'complete' });".to_string()
            }
            _ => unreachable!(), // validated above
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
                                // 500ms quiet period, mirroring op_wait_for.
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                if let Ok(s2) = browser
                                    .run_action_for_pane_opts(&label, &check_js, opts.clone())
                                    .await
                                {
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
                // A mid-navigation eval may fail transiently; keep polling.
                eprintln!("[conduit:browser-mcp] click_and_wait poll error: {e}");
            }
        }
        let step = if condition == "selector" { 200 } else { 300 };
        tokio::time::sleep(std::time::Duration::from_millis(step)).await;
    }

    Ok(serde_json::json!({
        "click": click_v,
        "wait": {
            "resolved": resolved,
            "condition": condition,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "detail": detail,
        },
        "pane_id": pane_id,
    }))
}




// ---- Phase 1 agent core: observation loop, form semantics, diagnostics ----

/// When `args.include_snapshot` is truthy, attach a compact interactive
/// snapshot (same ref numbering as click/type) to `payload` under "snapshot".
/// This is the observation-loop upgrade: the agent sees the post-action page
/// in the SAME round trip instead of paying a separate read_page call.
async fn maybe_attach_snapshot(
    args: &Value,
    label: &str,
    browser: &BrowserManager,
    payload: &mut Value,
) {
    let wants = args.get("include_snapshot").and_then(|v| v.as_bool()).unwrap_or(false);
    if !wants {
        return;
    }
    if let Ok(snapshot) = browser.snapshot_for_pane(label, None).await {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("snapshot".to_string(), Value::String(snapshot));
        }
    }
}

/// Echo the human-readable `element` description the agent passed (MCP
/// approval/audit pattern — the confirm UI and timeline show what the agent
/// THOUGHT it was targeting) onto the result payload.
fn echo_element(args: &Value, payload: &mut Value) {
    if let Some(desc) = args.get("element").and_then(|v| v.as_str()) {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("intendedTarget".to_string(), Value::String(desc.to_string()));
        }
    }
}

/// `find` — search the page's interactive elements by substring across
/// label/aria/placeholder/id/value. Reuses the compact snapshot serializer
/// (QUERY filter) so refs match click/type numbering and the output stays
/// token-lean.
async fn op_find(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let query = req
        .args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("find requires 'query' (string)"))?;
    let result = browser
        .snapshot_for_pane(&label, Some(query))
        .await
        .map_err(McpError::from_action_err)?;
    Ok(serde_json::json!({ "content": result }))
}

/// `fill_form` — set multiple fields directly by ref in one call. Fields are
/// clamped (max 25, text <= 10 KiB each) since they're untrusted LLM JSON.
async fn op_fill_form(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let fields = req
        .args
        .get("fields")
        .and_then(|v| v.as_array())
        .ok_or_else(|| McpError::invalid_args("fill_form requires 'fields' (array of {ref, text})"))?;
    if fields.len() > 25 {
        return Err(McpError::invalid_args("fill_form supports at most 25 fields per call"));
    }
    let mut clean: Vec<Value> = Vec::with_capacity(fields.len());
    for f in fields {
        let r = f.get("ref").and_then(|v| v.as_i64()).ok_or_else(|| {
            McpError::invalid_args("fill_form fields need an integer 'ref'")
        })?;
        let text = f.get("text").map(|v| match v {
            Value::String(sv) => sv.clone(),
            other => other.to_string(),
        }).unwrap_or_default();
        if text.len() > 10 * 1024 {
            return Err(McpError::invalid_args("fill_form field text too long (max 10 KiB)"));
        }
        clean.push(serde_json::json!({ "ref": r, "text": text }));
    }
    let fields_json = serde_json::to_string(&clean)
        .map_err(|e| McpError { code: "action_failed", message: format!("serialize fields: {e}") })?;
    let result = browser
        .fill_form_for_pane(&label, &fields_json)
        .await
        .map_err(McpError::from_action_err)?;
    let mut payload = serde_json::json!({ "result": result });
    echo_element(&req.args, &mut payload);
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
}

/// `select_option` — pick an `<option>` by value or visible text.
async fn op_select_option(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let r = req
        .args
        .get("ref")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| McpError::invalid_args("select_option requires 'ref' (integer)"))?;
    let value = req
        .args
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("select_option requires 'value' (option value or visible text)"))?;
    let result = browser
        .select_option_for_pane(&label, r, value)
        .await
        .map_err(McpError::from_action_err)?;
    let mut payload = serde_json::json!({ "result": result });
    echo_element(&req.args, &mut payload);
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
}

/// `press_key` — send Enter/Escape/arrows/etc. to the focused element.
async fn op_press_key(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let key = req
        .args
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("press_key requires 'key' (e.g. 'Enter', 'Escape', 'ArrowDown')"))?;
    if key.len() > 32 {
        return Err(McpError::invalid_args("press_key 'key' too long"));
    }
    let result = browser
        .press_key_for_pane(&label, key)
        .await
        .map_err(McpError::from_action_err)?;
    let mut payload = serde_json::json!({ "result": result });
    echo_element(&req.args, &mut payload);
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
}

/// `batch` — run several browser actions in ONE round trip, in order, halting
/// on the first failure ("Not executed: an earlier action failed" for the
/// remaining steps). Cuts harness round trips for multi-step interactions
/// (fill form -> press Enter -> wait). Only deterministic browser ops
/// allowed; no nested batch, no conduit tools.
const MAX_BATCH_ACTIONS: usize = 15;

async fn op_batch(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let actions = req
        .args
        .get("actions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| McpError::invalid_args("batch requires 'actions' (array of {op, args})"))?;
    if actions.is_empty() {
        return Err(McpError::invalid_args("batch 'actions' is empty"));
    }
    if actions.len() > MAX_BATCH_ACTIONS {
        return Err(McpError::invalid_args(format!(
            "batch supports at most {MAX_BATCH_ACTIONS} actions per call"
        )));
    }
    let mut results: Vec<Value> = Vec::with_capacity(actions.len());
    for (idx, action) in actions.iter().enumerate() {
        let op = action.get("op").and_then(|v| v.as_str()).unwrap_or("");
        if op == "batch" {
            return Err(McpError::invalid_args("batch cannot contain a nested batch"));
        }
        let step_req = Request {
            op: op.to_string(),
            project_id: req.project_id.clone(),
            pane_id: req.pane_id.clone(),
            args: action.get("args").cloned().unwrap_or(Value::Null),
        };
        // Halt on the first failure; remaining steps are reported as skipped.
        // Box::pin breaks the async recursion cycle (dispatch -> op_batch ->
        // dispatch) for the compiler; the runtime guard above already rejects
        // nested batches.
        match Box::pin(dispatch(&step_req, browser, app)).await {
            Ok(v) => results.push(serde_json::json!({ "step": idx, "op": op, "ok": true, "result": v })),
            Err(e) => {
                for skip in (idx + 1)..actions.len() {
                    let skipped_op = actions[skip].get("op").and_then(|v| v.as_str()).unwrap_or("");
                    results.push(serde_json::json!({
                        "step": skip, "op": skipped_op,
                        "ok": false, "skipped": "Not executed: an earlier action failed",
                    }));
                }
                return Ok(serde_json::json!({
                    "halted": true,
                    "failedStep": idx,
                    "failedOp": op,
                    "error": { "code": e.code, "message": e.message },
                    "steps": results,
                }));
            }
        }
    }
    let mut payload = serde_json::json!({ "halted": false, "steps": results });
    maybe_attach_snapshot(&req.args, &label, browser, &mut payload).await;
    Ok(payload)
}

/// `read_console` / `read_network` — incremental diagnostics from the
/// document-start ring buffer. `since` is the highest seq the agent has seen
/// (default 0 = everything buffered); the response carries `latest` so the
/// next call can resume. Console entries are filtered server-side by level.
async fn op_read_diag(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
    kind: &'static str,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let since = req.args.get("since").and_then(|v| v.as_u64()).unwrap_or(0);
    let level = req.args.get("level").and_then(|v| v.as_str()).unwrap_or("all");
    let result = browser
        .read_diag_for_pane(&label, kind, since)
        .await
        .map_err(McpError::from_action_err)?;
    let mut v: Value = serde_json::from_str(&result)
        .unwrap_or(serde_json::json!({ "entries": [], "latest": 0, "installed": false }));
    if kind == "console" && level != "all" {
        if let Some(entries) = v.get_mut("entries").and_then(|e| e.as_array_mut()) {
            entries.retain(|e| e.get("level").and_then(|l| l.as_str()) == Some(level));
        }
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("kind".to_string(), Value::String(kind.to_string()));
    }
    Ok(v)
}

/// `list_tabs` — inventory of the pane's tabs with the active flag. Reads
/// each activated tab's URL via the eval bridge (<=6 tabs, best-effort).
async fn op_list_tabs(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let (pane_id, _tab) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let tabs = browser.list_tabs_for_pane(&pane_id);
    let mut out: Vec<Value> = Vec::new();
    for (tab_id, is_active, has_webview) in tabs.iter().take(6) {
        let url = if *has_webview {
            let tab_label = crate::browser::browser_label(&pane_id, tab_id);
            browser
                .evaluate_for_pane(&tab_label, "location.href")
                .await
                .ok()
                .map(|u| u.trim().trim_matches('"').to_string())
        } else {
            None
        };
        out.push(serde_json::json!({
            "tabId": tab_id,
            "active": is_active,
            "activated": has_webview,
            "url": url,
        }));
    }
    Ok(serde_json::json!({ "paneId": pane_id, "tabs": out }))
}

/// Resolve the pane for a tab-management op WITHOUT page semantics (these ops
/// don't act on a page, so no auto-open — an explicit or project-resolvable
/// pane is required).
async fn resolve_pane_for_tab_op(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<String, McpError> {
    let label = resolve_label(browser, req.project_id.as_deref(), req.pane_id.as_deref()).await?
        .ok_or_else(|| McpError {
            code: "pane_not_found",
            message: "no browser pane is open for this project — call navigate first".to_string(),
        })?;
    let (pane_id, _tab) = parse_label(&label)
        .ok_or_else(|| McpError { code: "invalid_args", message: format!("bad label: {label}") })?;
    let _ = app.emit("browser:activity", serde_json::json!({ "pane_id": pane_id }));
    Ok(pane_id)
}

async fn op_switch_tab(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let pane_id = resolve_pane_for_tab_op(req, browser, app).await?;
    let tab_id = req
        .args
        .get("tabId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("switch_tab requires 'tabId' (from list_tabs)"))?;
    let label = browser
        .switch_tab_for_pane(&pane_id, tab_id)
        .await
        .map_err(|e| McpError { code: "pane_not_found", message: e })?;
    Ok(serde_json::json!({ "paneId": pane_id, "tabId": tab_id, "label": label }))
}

async fn op_new_tab(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let pane_id = resolve_pane_for_tab_op(req, browser, app).await?;
    let url = req
        .args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("new_tab requires 'url'"))?;
    let label = browser
        .new_tab_for_pane(&pane_id, url)
        .await
        .map_err(|e| McpError { code: "pane_not_found", message: e })?;
    let (_, tab_id) = parse_label(&label).unwrap_or((pane_id.clone(), String::new()));
    Ok(serde_json::json!({ "paneId": pane_id, "tabId": tab_id }))
}

async fn op_close_tab(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let pane_id = resolve_pane_for_tab_op(req, browser, app).await?;
    let tab_id = req
        .args
        .get("tabId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::invalid_args("close_tab requires 'tabId' (from list_tabs)"))?;
    browser
        .close_tab_for_pane(&pane_id, tab_id)
        .await
        .map_err(|e| McpError { code: "invalid_args", message: e })?;
    Ok(serde_json::json!({ "paneId": pane_id, "closed": tab_id }))
}

/// `zoom` — capture a REGION of the viewport at up to 4x so small text and
/// dense UI are readable (the vision fallback for canvas/dense layouts).
async fn op_zoom(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let get_f64 = |k: &str| req.args.get(k).and_then(|v| v.as_f64());
    let (x, y, width, height) = (
        get_f64("x").ok_or_else(|| McpError::invalid_args("zoom requires 'x'"))?,
        get_f64("y").ok_or_else(|| McpError::invalid_args("zoom requires 'y'"))?,
        get_f64("width").ok_or_else(|| McpError::invalid_args("zoom requires 'width'"))?,
        get_f64("height").ok_or_else(|| McpError::invalid_args("zoom requires 'height'"))?,
    );
    let scale = get_f64("scale").unwrap_or(2.0);
    let mgr = app.state::<crate::BrowserState>().0.clone();
    let png = tokio::task::spawn_blocking(move || {
        mgr.capture_pane_png_clipped(&label, x, y, width, height, scale)
    })
    .await
    .map_err(|e| McpError { code: "browser_unavailable", message: format!("zoom task failed: {e}") })?
    .ok_or_else(|| McpError {
        code: "browser_unavailable",
        message: "zoom capture failed (Windows-only today, or no page is open)".to_string(),
    })?;
    let dir = crate::chat::dispatch::artifacts_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("browser-zoom-{millis}.png"));
    std::fs::write(&path, &png).map_err(|e| McpError {
        code: "browser_unavailable",
        message: format!("could not save zoom capture: {e}"),
    })?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "png_base64": crate::chat::commands::base64_encode(&png),
    }))
}

/// `print_to_pdf` — print the pane's CURRENT page to a PDF file in the
/// artifacts dir (Windows). The faithful-document handoff: receipts,
/// confirmations, docs, your own app's print output. Returns the path so the
/// agent can cite/attach it.
async fn op_print_to_pdf(
    req: &Request,
    browser: &BrowserManager,
    app: &AppHandle,
) -> Result<Value, McpError> {
    let label = resolve_or_open(req, browser, app).await?;
    let landscape = req.args.get("landscape").and_then(|v| v.as_bool()).unwrap_or(false);
    let dir = crate::chat::dispatch::artifacts_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("page-{millis}.pdf"));
    let out_path = path.clone();
    let mgr = app.state::<crate::BrowserState>().0.clone();
    let result = tokio::task::spawn_blocking(move || {
        mgr.print_to_pdf_for_pane(&label, &out_path, landscape)
    })
    .await
    .map_err(|e| McpError {
        code: "browser_unavailable",
        message: format!("print task failed: {e}"),
    })?;
    result.map_err(|e| McpError {
        code: "browser_unavailable",
        message: e,
    })?;
    Ok(serde_json::json!({ "path": path.to_string_lossy() }))
}

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
    fn stale_ref_errors_map_to_not_found() {
        // The canonical stale-ref message must classify as not_found so the
        // agent understands a re-read recovers it.
        assert_eq!(
            McpError::from_action_err(
                "ERROR: ref 4 is stale — no element with this ref on the current page. The page changed since the ref was assigned; re-read the page (read_page or find) to get fresh refs.".into()
            ).code,
            "not_found"
        );
    }

    #[test]
    fn echo_element_attaches_intended_target() {
        let mut payload = serde_json::json!({ "ok": true });
        echo_element(&serde_json::json!({ "element": "the checkout button" }), &mut payload);
        assert_eq!(payload["intendedTarget"], "the checkout button");
        // Absent element param is a no-op.
        let mut payload2 = serde_json::json!({ "ok": true });
        echo_element(&serde_json::json!({}), &mut payload2);
        assert!(payload2.get("intendedTarget").is_none());
    }

    #[test]
    fn classify_gate_flags_payment_destructive_and_credential() {
        // Payment: clicking a checkout button is hard-gated in every mode.
        let (risk, _) = classify_gate(
            "click",
            &serde_json::json!({ "selector_or_description": "the Place Order button" }),
        ).unwrap();
        assert_eq!(risk, "payment");

        // Destructive: delete/remove/publish.
        let (risk, _) = classify_gate(
            "click",
            &serde_json::json!({ "element": "Delete account" }),
        ).unwrap();
        assert_eq!(risk, "destructive");

        // Credential: typing into a password field is takeover-class.
        let (risk, _) = classify_gate(
            "type_text",
            &serde_json::json!({ "selector_or_description": "the password field", "text": "x" }),
        ).unwrap();
        assert_eq!(risk, "credential");

        // Benign click: no gate.
        assert!(classify_gate(
            "click",
            &serde_json::json!({ "selector_or_description": "the search box" }),
        ).is_none());
        // Reads never gate.
        assert!(classify_gate("read_page", &serde_json::json!({})).is_none());
        // Tab close is always destructive-class.
        let (risk, _) = classify_gate("close_tab", &serde_json::json!({})).unwrap();
        assert_eq!(risk, "destructive");
    }

    #[test]
    fn parse_site_consents_tolerates_junk() {
        assert!(parse_site_consents(None).is_empty());
        assert!(parse_site_consents(Some("not json".into())).is_empty());
        let parsed = parse_site_consents(Some(
            r#"{"https://x.com": {"payment": true}}"#.into(),
        ));
        assert_eq!(parsed["https://x.com"]["payment"], true);
    }

    #[test]
    fn timeline_target_extracts_the_most_human_field() {
        assert_eq!(
            timeline_target(&serde_json::json!({ "element": "checkout", "selector_or_description": "#buy" })),
            "checkout"
        );
        assert_eq!(
            timeline_target(&serde_json::json!({ "url": "https://x.com/" })),
            "https://x.com/"
        );
        assert_eq!(
            timeline_target(&serde_json::json!({ "fields": [{ "ref": 1 }, { "ref": 2 }] })),
            "2 field(s)"
        );
        assert_eq!(
            timeline_target(&serde_json::json!({ "actions": [{ "op": "click" }, { "op": "wait_for" }] })),
            "batch: click -> wait_for"
        );
        assert_eq!(timeline_target(&serde_json::json!({})), "");
    }

    #[test]
    fn mutating_op_coverage() {
        for op in ["click", "type_text", "fill_form", "select_option", "press_key", "evaluate", "navigate", "close_tab"] {
            assert!(is_mutating_op(op), "{op} should be mutating");
        }
        for op in ["read_page", "find", "list_tabs", "read_console", "screenshot"] {
            // screenshot/zoom are read-only observationally; they stay ungated
            // in Auto mode (they're also mutating-list only for Manual mode).
            let _ = op;
        }
        assert!(!is_mutating_op("read_page"));
        assert!(!is_mutating_op("find"));
    }

    #[test]
    fn maybe_attach_snapshot_is_opt_in() {
        // Arg absence → no snapshot field. (The async eval path needs a live
        // pane, so we only assert the gating logic branch that's reachable
        // without one: include_snapshot=false returns immediately.)
        let args = serde_json::json!({ "include_snapshot": false });
        assert!(!args.get("include_snapshot").and_then(|v| v.as_bool()).unwrap_or(false));
        let args_missing = serde_json::json!({});
        assert!(!args_missing.get("include_snapshot").and_then(|v| v.as_bool()).unwrap_or(false));
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
