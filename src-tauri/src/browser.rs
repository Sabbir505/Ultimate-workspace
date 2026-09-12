//! Native browser panes (Windows / macOS / Linux).
//!
//! The browser pane used to be an <iframe> pointed at a URL, which breaks on
//! real browsing: sites sending X-Frame-Options refuse to render, and
//! cross-origin history reads are blocked by Chromium. We instead attach a
//! native webview to the main window — a top-level browsing context, so XFO
//! doesn't apply and full navigation works. The webview is positioned over
//! the pane's body div using the logical-pixel rect the frontend measures
//! with getBoundingClientRect (Tauri handles the HiDPI logical -> physical
//! conversion).
//!
//! Platform split:
//! - **Windows / macOS**: child webview (`WebviewBuilder` + `window.add_child`)
//!   — embedded in the main window, floats above the DOM. Works because
//!   WebView2 (Windows) and WKWebView (macOS) support multi-webview.
//! - **Linux**: wry/gtk has NO multi-webview support, so we spawn a separate
//!   Tauri `WebviewWindow` per pane+tab, position it over the grid cell, and
//!   keep it in lockstep with the frontend's reported rect. The window is
//!   frameless (`decorations=false`), excluded from the taskbar
//!   (`skip_taskbar=true`), and never shown to the OS as a top-level app
//!   window — it visually behaves as a pane of the main window.
//!
//! Two hazards this module is designed around (both platforms):
//! - Native webviews render ABOVE the page content (they are not composited
//!   with the DOM), so the frontend must call `browser_set_visible(false)`
//!   whenever an overlay opens or the pane is hidden in split mode.
//! - On Linux, the standalone windows must be repositioned whenever the
//!   main window moves or the grid is resized; the frontend's ResizeObserver
//!   already drives this through the existing `browser_set_bounds` IPC.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::oneshot;
use serde::{Deserialize, Serialize};
#[cfg(any(windows, target_os = "macos"))]
use tauri::webview::WebviewBuilder;
#[cfg(target_os = "linux")]
use tauri::webview::WebviewWindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, Webview, WebviewUrl,
};

pub(crate) use crate::browser_js::*;
use crate::types::BrowserNavigatedEvent;

/// Logical-pixel rect measured by the frontend (getBoundingClientRect).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Webview label for a pane+tab combination. The label scheme is how we
/// avoid collisions with the "main" webview window.
pub fn browser_label(pane_id: &str, tab_id: &str) -> String {
    format!("browser-{pane_id}-tab-{tab_id}")
}

/// One per (pane_id, tab_id). Wraps the underlying native handle (child
/// `Webview` on Windows/macOS, standalone `Webview` from a `WebviewWindow`
/// on Linux) so the rest of the manager can use one unified type. On Linux
/// we also keep a clone of the `WebviewWindow` itself for show/hide/close
/// operations, since `Webview` doesn't expose those.
#[derive(Clone)]
pub struct BrowserPane {
    /// Windows: our OWN WebView2 controller, created directly via
    /// webview2-com against the main window's HWND. NOT a tauri webview —
    /// tauri's dispatcher silently drops every Webview-message for child
    /// webviews created via add_child (with_webview / navigate / eval all
    /// dead), so the browser pane bypasses it entirely.
    #[cfg(windows)]
    pub controller: SendController,
    #[cfg(windows)]
    pub core: SendCore,
    /// macOS keeps the tauri child webview (the dispatch breakage is
    /// Windows-specific).
    #[cfg(target_os = "macos")]
    pub webview: Webview,
    /// Linux — the standalone `WebviewWindow` that hosts the webview.
    #[cfg(target_os = "linux")]
    pub window: tauri::WebviewWindow,
}

/// COM wrapper allowed to cross threads: the pointer only ever DEREFERENCES
/// on the main thread (every use marshals through `run_on_main_thread`), but
/// it must be able to LIVE in our pane map across worker-thread access.
#[cfg(windows)]
#[derive(Clone)]
pub struct SendController(pub webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller);
#[cfg(windows)]
unsafe impl Send for SendController {}
#[cfg(windows)]
#[derive(Clone)]
pub struct SendCore(pub webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2);
#[cfg(windows)]
unsafe impl Send for SendCore {}

impl BrowserPane {
    /// Eval JS in this pane's page — non-Windows fallback (B-2). The Windows
    /// path marshals through `with_core_on_main` instead (raw controller).
    #[cfg(not(windows))]
    pub(crate) fn eval_js(&self, js: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            return self.webview.eval(js).map_err(|e| e.to_string());
        }
        #[cfg(target_os = "linux")]
        {
            return self.window.eval(js).map_err(|e| e.to_string());
        }
        #[allow(unreachable_code)]
        Err("browser panes are not supported on this platform".to_string())
    }

    /// Navigate this pane — non-Windows fallback (B-2). There is no
    /// reachable Navigate binding on tauri-managed child panes, so drive
    /// `location.href` (a fresh history entry; acceptable for the fallback).
    #[cfg(not(windows))]
    pub(crate) fn navigate_to(&self, url: &str) -> Result<(), String> {
        let esc = serde_json::to_string(url).unwrap_or_else(|_| "\"about:blank\"".to_string());
        self.eval_js(&format!("location.href = {esc};"))
    }

    /// Toggle the native DevTools window — non-Windows fallback (B-2).
    #[cfg(not(windows))]
    pub(crate) fn open_devtools_pane(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            #[cfg(debug_assertions)]
            {
                self.webview.open_devtools();
                return Ok(());
            }
            #[cfg(not(debug_assertions))]
            {
                return Err("devtools require a debug build or tauri's `devtools` feature".into());
            }
        }
        #[cfg(target_os = "linux")]
        {
            #[cfg(debug_assertions)]
            {
                self.window.open_devtools();
                return Ok(());
            }
            #[cfg(not(debug_assertions))]
            {
                return Err("devtools require a debug build or tauri's `devtools` feature".into());
            }
        }
        #[allow(unreachable_code)]
        Err("browser panes are not supported on this platform".to_string())
    }

    fn show(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            unsafe { self.controller.0.SetIsVisible(true) }.map_err(|e| e.to_string())
        }
        #[cfg(target_os = "linux")]
        {
            self.window.show().map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            self.webview.show().map_err(|e| e.to_string())
        }
    }

    fn hide(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            unsafe { self.controller.0.SetIsVisible(false) }.map_err(|e| e.to_string())
        }
        #[cfg(target_os = "linux")]
        {
            self.window.hide().map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            self.webview.hide().map_err(|e| e.to_string())
        }
    }

    fn close(self) -> Result<(), String> {
        #[cfg(windows)]
        {
            // controller.Close() TEARS DOWN the native child window — this is
            // what kills the "ghost block area" after closing the pane (the
            // old path's close message was dropped, leaving an invisible
            // input-swallowing webview floating over the UI).
            unsafe { self.controller.0.Close() }.map_err(|e| e.to_string())
        }
        #[cfg(target_os = "linux")]
        {
            self.window.close().map_err(|e| e.to_string())
        }
        #[cfg(target_os = "macos")]
        {
            self.webview.close().map_err(|e| e.to_string())
        }
    }

    /// Apply bounds in PHYSICAL pixels relative to the parent window's client
    /// area (Windows path).
    #[cfg(windows)]
    fn set_bounds_physical(&self, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
        use windows::Win32::Foundation::RECT;
        unsafe {
            self.controller
                .0
                .SetBounds(RECT { left: x, top: y, right: x + w, bottom: y + h })
        }
        .map_err(|e| e.to_string())
    }

    #[cfg(not(windows))]
    fn set_position_size(&self, pos: LogicalPosition<f64>, size: LogicalSize<f64>) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            self.window.set_position(Position::Logical(pos))?;
            self.window.set_size(Size::Logical(size))?;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            self.webview.set_position(Position::Logical(pos))?;
            self.webview.set_size(Size::Logical(size))?;
            Ok(())
        }
    }
}

/// Fixed loopback port the `relay-browser-mcp` binary connects to. The
/// in-app WebSocket server (`browser_mcp::serve`) binds 127.0.0.1:{port}; the
/// standalone MCP binary reads this from the `RELAY_WS_PORT` env var (set in
/// `.mcp.json`/`--mcp-config` registration) and forwards tool calls here.
/// Shared between the two via `relay_lib` so they can never drift apart.
pub const BROWSER_MCP_PORT: u16 = 7681;

/// An interactive element the browser_click / browser_type tools target.
///
/// In `ReadMode::Interactive` (agent-driven control) the JS bridge emits the
/// full accessibility record — role, aria-label, form-field state (value,
/// checked, disabled, type), name/id, and the element's rect (so the visual
/// feedback layer can compute a click point without re-measuring). In the
/// readability read modes these a11y fields are absent (None) and only the
/// minimal ref/tag/label/href quadruple is present.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRef {
    pub r#ref: i64,
    pub tag: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    // --- a11y fields (interactive mode only) ---
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aria_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "type")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<ElementRect>,
}

/// Bounding rect of an interactive element, in viewport pixels. Emitted only
/// in interactive mode so the visual-feedback overlay can animate a cursor to
/// the element's centre without a second measurement pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// Structured result from the readability-style extraction bridge JS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedContent {
    pub markdown: String,
    pub title: String,
    pub url: String,
    pub canonical_url: Option<String>,
    pub published_date: Option<String>,
    pub byline: Option<String>,
    pub mode: String,
    pub failure_reason: Option<String>,
    pub element_refs: Vec<ElementRef>,
}

/// Read mode for browser_read: full extraction, headings-only summary, a
/// specific section of the page, or the interactive accessibility tree
/// (agent-driven control — roles, labels, form-field state, rects).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadMode {
    #[default]
    Full,
    SummaryOnly,
    Section,
    Interactive,
}

/// Options controlling the read-page orchestration (settle wait, scroll loop).
#[derive(Debug, Clone)]
pub struct ReadOpts {
    /// Milliseconds to wait after injection before the first extraction
    /// (settle for JS-rendered content). Default 400.
    pub settle_ms: u32,
    /// Max number of scroll-down steps for lazy-load handling. Default 4.
    pub max_scroll_steps: u32,
}

impl Default for ReadOpts {
    fn default() -> Self {
        Self {
            settle_ms: 400,
            max_scroll_steps: 4,
        }
    }
}

/// Options controlling agentic action behaviour (watch-mode pacing).
#[derive(Debug, Clone)]
pub struct ActionOpts {
    /// When true, a ~PANEDELAY_MS delay is applied after the JS body resolves
    /// and before the result is reported, so a human can follow the action.
    pub watch_mode: bool,
    /// Milliseconds to wait when watch_mode is true.
    pub pane_delay_ms: u64,
}

impl Default for ActionOpts {
    fn default() -> Self {
        Self {
            watch_mode: false,
            pane_delay_ms: 250,
        }
    }
}

/// Platform support: native browser panes work on every supported platform
/// today. The implementation path differs:
///   - Windows / macOS: child webview (WebviewBuilder + window.add_child) —
///     embedded in the main window, floats above the DOM. Works because
///     WebView2 (Windows) and WKWebView (macOS) support multi-webview.
///   - Linux: child webviews are unsupported in wry/gtk (no multi-webview),
///     so we instead spawn a separate Tauri `WebviewWindow` per pane+tab,
///     position it over the grid cell, and keep it in lockstep with the
///     frontend's reported rect (ResizeObserver).
pub fn platform_supported() -> bool {
    true
}

/// Scheme allowlist for pane navigation. Pages in the pane are untrusted and
/// both the MCP `navigate` tool and the chat `open_url` tool forward raw
/// strings: a `javascript:` URL would execute attacker-chosen script in the
/// pane's origin (the pushState/WebMessage paths already reject it — this
/// closes the direct-navigation hole). `file://` stays allowed: the MCP
/// navigate tool deliberately encourages it for previewing built apps.
fn validate_nav_url(url: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("invalid url `{url}`: {e}"))?;
    let allowed = matches!(parsed.scheme(), "http" | "https" | "file" | "about");
    if !allowed {
        return Err(format!(
            "blocked url scheme `{}` in browser pane (allowed: http, https, file, about)",
            parsed.scheme()
        ));
    }
    Ok(parsed)
}

fn ensure_supported() -> Result<(), String> {
    Ok(())
}

/// WebView2 profile name for a project (Windows multi-profile isolation —
/// cookies/storage separated per project so an agent prompt-injected on one
/// site never holds the user's session for another). Profile names are
/// restricted to [a-zA-Z0-9_-]; arbitrary project ids are sanitized. `None`
/// (no project context) keeps the legacy default profile.
fn browser_profile_for_project(project_id: Option<&str>) -> Option<String> {
    let pid = project_id?.trim();
    if pid.is_empty() {
        return None;
    }
    let sanitized: String = pid
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(48)
        .collect();
    Some(format!("p-{sanitized}"))
}

// ---- Vendored JS bridge files -----------------------------------------
// Mozilla's readability.js (Apache 2.0) is embedded at compile time via
// include_str!. It declares a global `Readability` constructor that takes a
// Document + options and exposes a `.parse()` method returning
// {title, content (HTML), textContent, excerpt, byline, length, ...} or null.
// Our own bridge wrapper (bridge_extract.js) is concatenated after it: it
// hardens the page, runs Readability, converts to Markdown, and returns
// structured JSON. Both are plain scripts — no module system — so they work
// when eval'd in any webview.
const READABILITY_JS: &str = include_str!("bridge_readability.js");
const BRIDGE_EXTRACT_JS: &str = include_str!("bridge_extract.js");
/// Description -> element resolution JS (Task #5): tags interactive elements,
/// tries the description as a CSS selector, then scores a case-insensitive
/// match against labels/aria/placeholder/name/id. Returns the resolved ref or
/// a `not_found` error with top-10 suggestions. Injected via
/// `run_action_for_pane`, wrapped by `action_wrapper_js`.
pub(crate) const BRIDGE_RESOLVE_JS: &str = include_str!("bridge_resolve.js");
/// Visual feedback overlay (Task #7): synthetic cursor tween, click ripple,
/// animated typing caret, pre-action highlight. Defines globals
/// `__relay_injectOverlay` / `__relay_tweenCursor` / `__relay_showRipple`
/// / `__relay_highlight` / `__relay_showCaret`. Injected after every
/// navigation (alongside the pushState monkey-patch) and re-injected lazily by
/// each action so a fresh page load re-installs it.
const BRIDGE_OVERLAY_JS: &str = include_str!("bridge_overlay.js");
/// Compact interactive snapshot + element search (`find`). One line per
/// interactive element with the same ref numbering as read_page/click —
/// 200-400 tokens instead of the full JSON tree. QUERY placeholder filters
/// the listing (find mode) without changing the numbering.
pub(crate) const BRIDGE_SNAPSHOT_JS: &str = include_str!("bridge_snapshot.js");

/// Diagnostics ring buffer (Phase 1): document-start instrumentation that
/// records console output, fetch/XHR network activity, and the last DOM
/// mutation timestamp into `window.__relayDiag`. Backs the agent-facing
/// `read_console` / `read_network` ops and the `wait_for: stable` DOM-stability
/// heuristic — cross-platform (pure JS, no CDP needed on macOS/Linux; on
/// Windows the same data could later come from CDP event receivers).
/// Installed via AddScriptToExecuteOnDocumentCreated (Windows) /
/// initialization_script (macOS) / the escalating post-nav injection (all
/// platforms — the guard makes re-injection a no-op).
const DIAG_INIT_JS: &str = r#"(function() {
    if (window.__relayDiag) { window.__relayDiag.installed = true; return; }
    var diag = {
        installed: true,
        seq: 0,
        lastMutation: 0,
        console: [],   // {seq, ts, level, text}
        network: []    // {seq, ts, method, url, status, resourceType}
    };
    window.__relayDiag = diag;
    var MAX = 100;
    function push(kind, entry) {
        entry.seq = ++diag.seq;
        entry.ts = Date.now();
        var arr = diag[kind];
        arr.push(entry);
        if (arr.length > MAX) arr.splice(0, arr.length - MAX);
    }
    // Console: wrap the methods that exist, capture formatted text.
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    for (var li = 0; li < levels.length; li++) {
        (function(level) {
            var orig = console[level] ? console[level].bind(console) : function() {};
            console[level] = function() {
                try {
                    var parts = [];
                    for (var i = 0; i < arguments.length && i < 6; i++) {
                        var a = arguments[i];
                        parts.push(typeof a === 'string' ? a : (a instanceof Error ? (a.message || String(a)) : JSON.stringify(a)));
                    }
                    push('console', { level: level, text: String(parts.join(' ')).slice(0, 500) });
                } catch (e) {}
                orig.apply(null, arguments);
            };
        })(levels[li]);
    }
    try {
        window.addEventListener('error', function(ev) {
            push('console', { level: 'error', text: ('Uncaught: ' + (ev.message || 'unknown error')).slice(0, 500) });
        });
    } catch (e) {}
    // Network: fetch + XHR (response side only — request bodies are never
    // recorded: they can carry credentials; headers neither).
    try {
        var origFetch = window.fetch;
        if (typeof origFetch === 'function') {
            window.fetch = function(input, init) {
                var method = 'GET';
                var url = '';
                try {
                    if (typeof input === 'string') { url = input; }
                    else if (input && input.url) { url = input.url; method = input.method || 'GET'; }
                    if (init && init.method) method = init.method;
                } catch (e) {}
                var entry = { method: String(method).toUpperCase(), url: String(url).slice(0, 300), status: null };
                return origFetch.apply(this, arguments).then(function(resp) {
                    try { entry.status = resp.status; entry.resourceType = 'fetch'; push('network', entry); } catch (e) {}
                    return resp;
                }, function(err) {
                    try { entry.status = 0; entry.resourceType = 'fetch'; push('network', entry); } catch (e) {}
                    throw err;
                });
            };
        }
    } catch (e) {}
    try {
        var XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype) {
            var origOpen = XHR.prototype.open;
            var origSend = XHR.prototype.send;
            XHR.prototype.open = function(method, url) {
                try { this.__relayReq = { method: String(method).toUpperCase(), url: String(url).slice(0, 300), status: null }; } catch (e) {}
                return origOpen.apply(this, arguments);
            };
            XHR.prototype.send = function() {
                var entry = this.__relayReq;
                if (entry) {
                    this.addEventListener('loadend', function() {
                        try { entry.status = this.status; entry.resourceType = 'xhr'; push('network', entry); } catch (e) {}
                    });
                }
                return origSend.apply(this, arguments);
            };
        }
    } catch (e) {}
    // DOM mutation timestamp for wait_for: stable.
    try {
        var markMutation = function() { diag.lastMutation = Date.now(); };
        if (document.body) {
            new MutationObserver(markMutation).observe(document.body, { childList: true, subtree: true, attributes: true });
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                new MutationObserver(markMutation).observe(document.body, { childList: true, subtree: true, attributes: true });
            });
        }
        markMutation();
    } catch (e) {}
})();"#;

/// Build the full extraction JS body for a given mode + optional selector.
/// The mode and selector are JSON-escaped and interpolated into the bridge
/// wrapper, which reads them as template placeholders.
/// Build the full extraction JS for a `browser_read` call: the vendored
/// readability.js followed by our bridge wrapper, with `mode` and `selector`
/// interpolated into the wrapper's `MODE`/`SELECTOR` placeholders.
///
/// The placeholders are already quoted in `bridge_extract.js` (`var MODE =
/// "MODE_PLACEHOLDER";`), so we inject the **inner** string value — the JSON
/// encoding with its surrounding quotes stripped. This preserves escaping of
/// special characters in a CSS `selector` (e.g. `a[href*="x"]`) while not
/// double-quoting the value into a syntax error (`""full""`).
fn build_extract_js(mode: &ReadMode, selector: Option<&str>) -> String {
    // serde_json::to_string yields a quoted JSON string; strip the outer quotes
    // to get the JS string-literal *contents* (already escaped). Fall back to
    // the bare value if the (infallible-for-str) encoding ever surprises us.
    let strip_quotes = |s: String| {
        if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
            s[1..s.len() - 1].to_string()
        } else {
            s
        }
    };
    let mode_str = strip_quotes(serde_json::to_string(&mode).unwrap_or_else(|_| "\"full\"".to_string()));
    let sel_str = strip_quotes(serde_json::to_string(&selector.unwrap_or("")).unwrap_or_else(|_| "\"\"".to_string()));
    // `bridge_extract.js` ends with an IIFE `(function(){ ... return extract(); })()`.
    // `action_wrapper_js` wraps the body as `(function() { {body} })()` — WITHOUT
    // a leading `return`, the IIFE's return value would be discarded and the
    // wrapper would report `undefined`. Insert `return ` directly before the
    // IIFE's opening `(function` so the outer wrapper returns the JSON string
    // `extract()` produced. (The leading comment lines stay before the return —
    // only a `return` immediately followed by a NEWLINE triggers ASI, and here
    // `return (` is followed by `function` on the same line.)
    let bridge = BRIDGE_EXTRACT_JS
        .replace("MODE_PLACEHOLDER", &mode_str)
        .replace("SELECTOR_PLACEHOLDER", &sel_str);
    let bridge = match bridge.find("(function") {
        Some(idx) => format!("{}return {}", &bridge[..idx], &bridge[idx..]),
        None => format!("return {bridge}"),
    };
    format!("{}\n{}\n", READABILITY_JS, bridge)
}

/// Guard against degenerate rects: a 0x0 or NaN rect (transient layout
/// states, display:none measurements) can make wry error or place the
/// webview somewhere nonsensical. Clamp sizes to >= 1 logical px and replace
/// non-finite values with a harmless origin.
fn sanitize(rect: Rect) -> Rect {
    let finite_or = |v: f64, fallback: f64| if v.is_finite() { v } else { fallback };
    Rect {
        x: finite_or(rect.x, 0.0),
        y: finite_or(rect.y, 0.0),
        width: finite_or(rect.width, 1.0).max(1.0),
        height: finite_or(rect.height, 1.0).max(1.0),
    }
}

/// Append one line to `<app-data>/logs/browser.log`. The pane's stderr is
/// invisible in packaged/dev-direct launches, and the stuck-loading diagnosis
/// needs the FULL navigation chain visible — create/navigate/nav-start/
/// nav-complete with error codes. Best-effort: logging must never fail a
/// browser operation.
pub(crate) fn browser_log(app: &tauri::AppHandle, msg: &str) {
    let dir = crate::user_dirs::app_data_dir(app).join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{:?}] {msg}\n", ts);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("browser.log"))
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

// ---- Main-thread WebView2 access ------------------------------------------
// ROOT CAUSE of the stuck-loading panes: tauri-runtime-wry dispatches EVERY
// Webview message (with_webview / navigate / eval / set_bounds / close) by
// looking the webview up in `window.webviews` and SILENTLY DROPS the message
// when the lookup misses — which it permanently does for the browser panes'
// child webviews on this stack (verified: dispatch failed identically from
// worker threads AND inline on the main thread; logs/browser.log shows
// "closure never ran" at every layer). run_on_main_thread closures, however,
// always execute. So the browser panes own their WebView2 controller directly
// (created via webview2-com in build_pane_on_main_thread) and every COM touch
// marshals through run_on_main_thread + a lookup in OUR OWN pane map — the
// tauri dispatcher is never involved.

/// The pane map, shared into main-thread closures.
pub(crate) type WebviewsMap = std::sync::Arc<Mutex<HashMap<String, BrowserPane>>>;

/// Run `f(&core)` for the pane ON THE MAIN THREAD. Synchronous COM only in
/// `f`; async completions fire later on the main thread's pump.
fn with_core_on_main<T: Send + 'static>(
    app: &AppHandle,
    webviews: WebviewsMap,
    label: &str,
    what: &str,
    f: impl FnOnce(
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    ) -> Result<T, String>
    + Send
    + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel::<Result<T, String>>();
    let (err_tx, err_rx) = mpsc::channel::<String>();
    let label = label.to_string();
    let app = app.clone();
    let dispatcher = app.clone();
    let dispatched = dispatcher.run_on_main_thread(move || {
        let res = (|| -> Result<(), String> {
            let pane = webviews
                .lock()
                .get(&label)
                .cloned()
                .ok_or_else(|| format!("no browser webview labelled {label}"))?;
            let out = f(pane.core.0.clone());
            drop(pane); // COM refs released on the main thread
            let _ = tx.send(out);
            Ok(())
        })();
        // Dispatch-level failure: surface the reason alongside the disconnect.
        if let Err(e) = res {
            let _ = err_tx.send(e);
        }
    });
    if dispatched.is_err() {
        return Err(format!("{what}: main thread unavailable"));
    }
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(res) => res,
        Err(_) => Err(format!(
            "{what}: closure never ran{}",
            err_rx
                .recv_timeout(Duration::ZERO)
                .map(|e| format!(": {e}"))
                .unwrap_or_default()
        )),
    }
}

// ---- Direct WebView2 creation (Windows) ------------------------------------
// Mirrors wry's env-to-controller sequence but fires ASYNC completions
// against the main thread's normal pump - never a nested wait_with_pump,
// never a tauri dispatcher message.

/// Shared "report creation outcome once" handle.
#[cfg(windows)]
type DoneHandle = std::sync::Arc<Mutex<Option<mpsc::Sender<Result<(), String>>>>>;

#[cfg(windows)]
fn take_done(done: &DoneHandle, r: Result<(), String>) {
    if let Some(tx) = done.lock().take() {
        let _ = tx.send(r);
    }
}

/// Kick off CreateCoreWebView2EnvironmentWithOptions; the completion fires on
/// the main thread's pump and hands the environment to `on_env`.
#[cfg(windows)]
fn create_environment_async(
    data_dir: &std::path::Path,
    done: DoneHandle,
    on_env: impl FnOnce(
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    ) -> Result<(), String>
    + Send
    + 'static,
) -> Result<(), String> {
    use webview2_com::CreateCoreWebView2EnvironmentCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::CreateCoreWebView2EnvironmentWithOptions;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2EnvironmentOptions;
    use windows::core::HSTRING;

    let options = webview2_com::CoreWebView2EnvironmentOptions::default();
    // wry's defaults: drop the mini menu + smart screen popups.
    unsafe {
        options.set_additional_browser_arguments(String::from(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        ));
    }
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |hr, environment| {
            let res = (|| -> Result<(), String> {
                hr.map_err(|e| format!("environment creation failed: {e}"))?;
                let env = match environment {
                    Some(e) => e,
                    None => {
                        take_done(&done, Err("environment creation returned none".into()));
                        return Ok(());
                    }
                };
                on_env(env)
            })();
            if let Err(e) = res {
                take_done(&done, Err(e));
            }
            Ok(())
        },
    ));
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            windows::core::PCWSTR::null(),
            &HSTRING::from(data_dir.as_os_str()),
            &ICoreWebView2EnvironmentOptions::from(options),
            &handler,
        )
    }
    .map_err(|e| format!("CreateEnvironment invoke failed: {e}"))?;
    Ok(())
}

/// Kick off controller creation against `hwnd`; completion hands the
/// controller (bounds already applied) to `on_controller`.
#[cfg(windows)]
/// Snapshot all descendant HWND addresses of `parent`. EnumChildWindows
/// walks the whole subtree, which is fine — we only diff addresses.
#[cfg(windows)]
fn snapshot_child_hwnds(parent: windows::Win32::Foundation::HWND) -> Vec<isize> {
    unsafe extern "system" fn proc(
        hwnd: windows::Win32::Foundation::HWND,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::core::BOOL {
        let out = &mut *(lparam.0 as *mut Vec<isize>);
        out.push(hwnd.0 as isize);
        windows::core::BOOL::from(true)
    }
    let mut out: Vec<isize> = Vec::new();
    let raw = &mut out as *mut Vec<isize>;
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::EnumChildWindows(
            Some(parent),
            Some(proc),
            windows::Win32::Foundation::LPARAM(raw as isize),
        );
    }
    out
}

/// WebView2 creates its child HWND(s) when the controller is created. Diff
/// against `before`, force each NEW child to the top of the sibling Z-order
/// (otherwise the app's main webview child can sit above them and the pane
/// paints nothing), and log the ground truth — class, screen rect,
/// IsWindowVisible — so a still-dark pane is diagnosable from browser.log.
#[cfg(windows)]
fn raise_and_log_new_children(
    app: &AppHandle,
    parent: windows::Win32::Foundation::HWND,
    before: &[isize],
) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowRect, IsWindowVisible, SetWindowPos, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE,
    };
    for addr in snapshot_child_hwnds(parent) {
        if before.contains(&addr) {
            continue;
        }
        let h = windows::Win32::Foundation::HWND(addr as *mut core::ffi::c_void);
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(h, &mut buf) }.max(0) as usize;
        let class = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        let mut r = windows::Win32::Foundation::RECT::default();
        let _ = unsafe { GetWindowRect(h, &mut r) };
        let visible_before = unsafe { IsWindowVisible(h) }.as_bool();
        let raised = unsafe { SetWindowPos(h, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE) }.is_ok();
        let visible_after = unsafe { IsWindowVisible(h) }.as_bool();
        browser_log(
            app,
            &format!(
                "webview2 child hwnd=0x{addr:X} class={class} rect=({},{})-({},{}) visible_before={visible_before} raised={raised} visible_after={visible_after}",
                r.left, r.top, r.right, r.bottom
            ),
        );
    }
}

fn create_controller_async(
    app: AppHandle,
    hwnd: windows::Win32::Foundation::HWND,
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    bounds: windows::Win32::Foundation::RECT,
    done: DoneHandle,
    controller_options: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ControllerOptions>,
    on_controller: impl FnOnce(
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    ) -> Result<(), String>
    + Send
    + 'static,
) -> Result<(), String> {
    use webview2_com::CreateCoreWebView2ControllerCompletedHandler;
    let before = snapshot_child_hwnds(hwnd);
    let parent = windows::Win32::Foundation::HWND(hwnd.0);
    let env2 = env.clone();
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |hr, controller| {
            let res = (|| -> Result<(), String> {
                hr.map_err(|e| format!("controller creation failed: {e}"))?;
                let controller = match controller {
                    Some(c) => c,
                    None => {
                        take_done(&done, Err("controller creation returned none".into()));
                        return Ok(());
                    }
                };
                unsafe { controller.SetBounds(bounds) }.map_err(|e| e.to_string())?;
                // Controllers are created INVISIBLE and stay that way until
                // IsVisible is flipped (wry did this implicitly in the tauri
                // path). Skipping it yields a dark pane that still logs
                // successful navigations.
                unsafe { controller.SetIsVisible(true) }
                    .map_err(|e| format!("SetIsVisible(true) failed: {e}"))?;
                raise_and_log_new_children(&app, parent, &before);
                on_controller(controller)
            })();
            if let Err(e) = res {
                take_done(&done, Err(e));
            }
            Ok(())
        },
    ));
    let created = match controller_options {
        // Multi-profile path: options live on Environment10 — cast (an old
        // installed Runtime without it falls back... but we only get here
        // with options in hand, which already required Environment10, so a
        // cast failure is a genuine error worth surfacing).
        Some(options) => {
            use windows::core::Interface as _;
            let env10: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment10 =
                env2.cast().map_err(|e| format!("Environment10 unavailable: {e}"))?;
            unsafe { env10.CreateCoreWebView2ControllerWithOptions(hwnd, &options, &handler) }
                .map_err(|e| format!("CreateControllerWithOptions invoke failed: {e}"))
        }
        None => unsafe { env2.CreateCoreWebView2Controller(hwnd, &handler) }
            .map_err(|e| format!("CreateController invoke failed: {e}")),
    };
    created?; // report the async init error through the done channel
    Ok(())
}

/// Register NavigationStarting / NavigationCompleted handlers DIRECTLY on a
/// core (called with the pane's own core on the main thread - no dispatch).
/// Logs every transition to logs/browser.log, emits `browser:navigated` on
/// START (the frontend's address-bar/history feed) and
/// `browser:load-completed` on success (the spinner's ground truth), and
/// re-installs the pushState hook + visual overlay after every navigation.
#[cfg(windows)]
fn attach_core_listeners(
    app: &AppHandle,
    webviews: crate::browser::WebviewsMap,
    label: &str,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {
    use webview2_com::NavigationCompletedEventHandler;
    use webview2_com::NavigationStartingEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventArgs;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationStartingEventArgs;

    // label = "browser-{pane_id}-tab-{tab_id}"
    let (pane_id, tab_id) = label
        .strip_prefix("browser-")
        .and_then(|rest| rest.split_once("-tab-"))
        .map(|(p, t)| (p.to_string(), t.to_string()))
        .unwrap_or_default();

    let app_start = app.clone();
    let label_start = label.to_string();
    let pane_start = pane_id.clone();
    let tab_start = tab_id.clone();
    let webviews_start = webviews.clone();
    let start_handler = NavigationStartingEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
            if let Some(args) = args {
                let mut pw = windows::core::PWSTR::null();
                if unsafe { args.Uri(&mut pw) }.is_ok() {
                    use webview2_com::take_pwstr;
                    let uri = take_pwstr(pw);
                    browser_log(&app_start, &format!("nav START label={label_start} uri={uri}"));
                    if let Some(state) = app_start.try_state::<crate::BrowserState>() {
                        state.0.remember_tab_url(&label_start, &uri);
                        // Nav-quiesce gate source (see run_action_for_pane_opts).
                        state.0.mark_nav_start(&label_start);
                    }
                    let _ = app_start.emit(
                        "browser:navigated",
                        BrowserNavigatedEvent {
                            pane_id: pane_start.clone(),
                            tab_id: tab_start.clone(),
                            url: uri.clone(),
                        },
                    );
                    // Re-install the pushState hook + visual overlay on the
                    // new document (escalating schedule; both are idempotent).
                    let pid = pane_start.clone();
                    let tid = tab_start.clone();
                    let map = webviews_start.clone();
                    let app2 = app_start.clone();
                    // P-2: this used to be a detached OS thread per navigation
                    // (each living up to 5s of escalating sleeps). It's a
                    // task on Tauri's existing tokio runtime now — same
                    // schedule, no thread churn per nav.
                    tauri::async_runtime::spawn(async move {
                        let mut waited = 0u64;
                        for target in [0u64, 150, 400, 900, 1800, 3500, 5000u64] {
                            if target > waited {
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    target - waited,
                                ))
                                .await;
                                waited = target;
                            }
                            let lbl = format!("browser-{pid}-tab-{tid}");
                            let js = format!(
                                "{}{}{}",
                                pushstate_injection_js(&pid, &tid),
                                DIAG_INIT_JS,
                                BRIDGE_OVERLAY_JS
                            );
                            let app3 = app2.clone();
                            let map2 = map.clone();
                            let lbl2 = lbl.clone();
                            let js2 = js.clone();
                            let _ = app3.run_on_main_thread(move || {
                                if let Some(pane) = map2.lock().get(&lbl2) {
                                    use webview2_com::ExecuteScriptCompletedHandler;
                                    let js_h = windows::core::HSTRING::from(js2);
                                    let handler = ExecuteScriptCompletedHandler::create(Box::new(
                                        |_, _| Ok(()),
                                    ));
                                    let _ =
                                        unsafe { pane.core.0.ExecuteScript(&js_h, &handler) };
                                }
                            });
                        }
                    });
                }
            }
            Ok(())
        },
    ));
    let mut start_token = 0i64;
    let _ = unsafe { core.add_NavigationStarting(&start_handler, &mut start_token) };

    // target=_blank / window.open: WebView2's default is a SEPARATE popup
    // window owned by the runtime — which reads as "the app spawned a
    // window". Claim the request and navigate this pane instead (what an
    // embedded browser should do).
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NewWindowRequestedEventArgs;
    use webview2_com::NewWindowRequestedEventHandler;
    let app_newwin = app.clone();
    let label_newwin = label.to_string();
    let newwin_handler = NewWindowRequestedEventHandler::create(Box::new(
        move |sender, args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
            use webview2_com::take_pwstr;
            if let Some(args) = args {
                let mut pw = windows::core::PWSTR::null();
                let uri = if unsafe { args.Uri(&mut pw) }.is_ok() {
                    take_pwstr(pw)
                } else {
                    String::new()
                };
                let _ = unsafe { args.SetHandled(true) };
                browser_log(
                    &app_newwin,
                    &format!("new-window label={label_newwin} uri={uri} -> same-tab navigate"),
                );
                if let (Some(core), false) = (sender, uri.is_empty()) {
                    let _ = unsafe { core.Navigate(&windows::core::HSTRING::from(uri.as_str())) };
                }
            }
            Ok(())
        },
    ));
    let mut newwin_token = 0i64;
    let _ = unsafe { core.add_NewWindowRequested(&newwin_handler, &mut newwin_token) };

    let app_complete = app.clone();
    let label_complete = label.to_string();
    let pane_complete = pane_id.clone();
    let tab_complete = tab_id.clone();
    let complete_handler = NavigationCompletedEventHandler::create(Box::new(
        move |sender, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
            if let Some(args) = args {
                let mut success = windows::core::BOOL::default();
                let _ = unsafe { args.IsSuccess(&mut success) };
                let mut err = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS::default();
                let _ = unsafe { args.WebErrorStatus(&mut err) };
                browser_log(
                    &app_complete,
                    &format!(
                        "nav COMPLETE label={label_complete} success={} error={}",
                        success.as_bool(),
                        err.0
                    ),
                );
                // Nav-quiesce gate: clear the in-flight marker on every load
                // end (success or failure — a failed nav still replaced the
                // document state the gate cares about).
                if let Some(state) = app_complete.try_state::<crate::BrowserState>() {
                    state.0.mark_nav_end(&label_complete);
                }
                if success.as_bool() {
                    let _ = app_complete.emit("browser:load-completed", label_complete.clone());
                    // Report the settled document title so the frontend can
                    // label the tab (the navigated event fires at nav START,
                    // before a title exists). Best-effort: the completion
                    // handler fires on the main-thread pump.
                    if let Some(core) = sender {
                        let js = title_report_js(&pane_complete, &tab_complete);
                        let js_h = windows::core::HSTRING::from(js);
                        let handler = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                        let _ = unsafe { core.ExecuteScript(&js_h, &handler) };
                    }
                }
            }
            Ok(())
        },
    ));
    let mut complete_token = 0i64;
    let _ = unsafe { core.add_NavigationCompleted(&complete_handler, &mut complete_token) };

    // Permission requests (camera / microphone / geolocation / notifications /
    // clipboard-read …): auto-DENY. An agent-driven pane must never surface a
    // consent dialog the user didn't ask for, and granting device access from
    // an embedded pane is never the right default (Edge's agentic mode also
    // suspends device permissions while the agent drives).
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;
    use webview2_com::PermissionRequestedEventHandler;
    let app_perm = app.clone();
    let label_perm = label.to_string();
    let perm_handler = PermissionRequestedEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
            if let Some(args) = args {
                let mut pw = windows::core::PWSTR::null();
                let uri = if unsafe { args.Uri(&mut pw) }.is_ok() {
                    webview2_com::take_pwstr(pw)
                } else {
                    String::new()
                };
                let mut kind = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND::default();
                let _ = unsafe { args.PermissionKind(&mut kind) };
                browser_log(
                    &app_perm,
                    &format!("permission DENIED label={label_perm} uri={uri} kind={}", kind.0),
                );
                let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY) };
            }
            Ok(())
        },
    ));
    let mut perm_token = 0i64;
    let _ = unsafe { core.add_PermissionRequested(&perm_handler, &mut perm_token) };

    // Downloads (Phase 3): redirect every download into the artifacts
    // downloads dir (the agent's file handoff — the timeline + chat can cite
    // the path) and suppress WebView2's default download UI, which paints
    // OS chrome over the app. Requires ICoreWebView2_4.
    use windows::core::Interface as _;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs;
    use webview2_com::DownloadStartingEventHandler;
    let app_dl = app.clone();
    let label_dl = label.to_string();
    let dl_handler = DownloadStartingEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2DownloadStartingEventArgs>| {
            const MAX_NAME: usize = 160;
            if let Some(args) = args {
                use webview2_com::take_pwstr;
                let _ = unsafe { args.SetHandled(true) };
                if let Ok(operation) = unsafe { args.DownloadOperation() } {
                    // Suggested file name from the original target path.
                    let mut pw = windows::core::PWSTR::null();
                    let original = if unsafe { args.ResultFilePath(&mut pw) }.is_ok() {
                        take_pwstr(pw)
                    } else {
                        String::new()
                    };
                    let file_name = std::path::Path::new(&original)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| "download.bin".to_string());
                    // Sanitize: no separators, no traversal.
                    let safe_name: String = file_name
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
                        .take(MAX_NAME)
                        .collect();
                    let dir = crate::chat::dispatch::artifacts_dir(&app_dl).join("downloads");
                    let _ = std::fs::create_dir_all(&dir);
                    let target = dir.join(&safe_name);
                    // Redirect BEFORE the download body lands: the redirect
                    // lives on the ARGS (the operation is already running).
                    let _ = unsafe {
                        args.SetResultFilePath(&windows::core::HSTRING::from(
                            target.to_string_lossy().as_ref(),
                        ))
                    };
                    let mut pw2 = windows::core::PWSTR::null();
                    let uri = if unsafe { operation.Uri(&mut pw2) }.is_ok() {
                        take_pwstr(pw2)
                    } else {
                        String::new()
                    };
                    browser_log(
                        &app_dl,
                        &format!(
                            "download label={label_dl} uri={uri} -> {}",
                            target.to_string_lossy()
                        ),
                    );
                    let (pane_id, _tab_id) = label_dl
                        .strip_prefix("browser-")
                        .and_then(|rest| rest.split_once("-tab-"))
                        .map(|(p, t)| (p.to_string(), t.to_string()))
                        .unwrap_or_default();
                    if let Some(state) = app_dl.try_state::<crate::BrowserState>() {
                        state.0.append_timeline(
                            &pane_id,
                            "download",
                            &format!("{file_name} <- {uri}"),
                            "ok",
                            None,
                            Some(target.to_string_lossy().to_string()),
                        );
                    }
                }
            }
            Ok(())
        },
    ));
    match core.cast::<ICoreWebView2_4>() {
        Ok(core4) => {
            let mut dl_token = 0i64;
            let _ = unsafe { core4.add_DownloadStarting(&dl_handler, &mut dl_token) };
        }
        Err(e) => browser_log(app, &format!("download redirect unavailable: {e}")),
    }
}

/// JS snippet that reports the current document title + URL back to the host
/// (`browser:title` event) so the frontend can label tabs. Runs on every
/// injection pass (escalating post-nav schedule — idempotent for the
/// frontend, which just overwrites the label) and on Windows
/// NavigationCompleted for a fast, accurate read. Transport mirrors
/// `pushstate_injection_js`: raw WebView2 panes post a `title_report`
/// envelope via `chrome.webview.postMessage` (handled by
/// `attach_web_message_bridge`), tauri-managed panes invoke the
/// `browser_report_title` command.
fn title_report_js(pane_id: &str, tab_id: &str) -> String {
    format!(
        r#"(function() {{
    var args = {{ paneId: '{pane}', tabId: '{tab}', title: (document.title || '').slice(0, 300) }};
    try {{
        if (window.chrome && window.chrome.webview &&
            typeof window.chrome.webview.postMessage === 'function') {{
            args.__relay = 'title_report';
            window.chrome.webview.postMessage(JSON.stringify(args));
            return;
        }}
    }} catch(e) {{}}
    try {{
        window.__TAURI_INTERNALS__.invoke('browser_report_title', args)
            .catch(function() {{}});
    }} catch(e) {{}}
}})();"#,
        pane = pane_id,
        tab = tab_id
    )
}

/// JS snippet that monkey-patches history.pushState / replaceState to call
/// browser_push_state whenever the URL changes via same-document navigation.
/// This catches Bing's Images/Videos/Maps tab clicks, SPA route changes, etc.
/// — events WebView2's NavigationStarting does NOT fire for.
///
/// Each injection pass ALSO reports the current document title (before the
/// install guard returns) — the escalating post-nav schedule means a
/// slow-loading page's title lands within ~5 s even without a
/// NavigationCompleted hook (the macOS/Linux paths have none).
fn pushstate_injection_js(pane_id: &str, tab_id: &str) -> String {
    format!(
        r#"(function() {{
    {title_report}
    if (window.__relay_pushstate_patched) return;
    window.__relay_pushstate_patched = true;
    var emit = function() {{
        var args = {{ paneId: '{pane}', tabId: '{tab}', url: location.href }};
        try {{
            if (window.chrome && window.chrome.webview &&
                typeof window.chrome.webview.postMessage === 'function') {{
                // B-3: raw WebView2 panes have no Tauri IPC — report through
                // the WebMessageReceived bridge instead.
                args.__relay = 'push_state';
                args.cmd = 'browser_push_state';
                window.chrome.webview.postMessage(JSON.stringify(args));
                return;
            }}
        }} catch(e) {{}}
        try {{
            window.__TAURI_INTERNALS__.invoke('browser_push_state', args)
                .catch(function() {{}});
        }} catch(e) {{}}
    }};
    var origPush = history.pushState;
    history.pushState = function() {{
        origPush.apply(this, arguments);
        emit();
    }};
    var origReplace = history.replaceState;
    history.replaceState = function() {{
        origReplace.apply(this, arguments);
        emit();
    }};
    window.addEventListener('popstate', emit);
    window.addEventListener('hashchange', emit);
}})();"#,
        pane = pane_id,
        tab = tab_id,
        title_report = title_report_js(pane_id, tab_id)
    )
}

/// B-3: page→host bridge for RAW WebView2 panes. Tauri injects
/// `__TAURI_INTERNALS__` only into webviews it manages, so the injected
/// bridge JS on these panes had no way to report action results or
/// pushState changes — every agentic browser op waited out its 45s timeout.
/// WebView2's native `window.chrome.webview.postMessage` fills that gap:
/// `add_WebMessageReceived` fires with the posted string, which we parse as
/// our envelope and route to the same handlers the tauri commands use.
#[cfg(windows)]
fn attach_web_message_bridge(
    app: &AppHandle,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {
    use webview2_com::WebMessageReceivedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs;

    let app = app.clone();
    let handler = WebMessageReceivedEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2WebMessageReceivedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut pw = windows::core::PWSTR::null();
            if unsafe { args.TryGetWebMessageAsString(&mut pw) }.is_err() {
                return Ok(());
            }
            let raw = webview2_com::take_pwstr(pw);
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
                // Not our envelope (page posted its own data) — ignore.
                return Ok(());
            };
            match v.get("__relay").and_then(|k| k.as_str()) {
                Some("action_result") => {
                    let req_id = v.get("reqId").and_then(|x| x.as_u64()).unwrap_or(0);
                    let nonce = v.get("nonce").and_then(|x| x.as_str()).unwrap_or("");
                    let result = v
                        .get("result")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some(state) = app.try_state::<crate::BrowserState>() {
                        state.0.resolve_action_verified(req_id, nonce, result);
                    }
                }
                Some("push_state") => {
                    // Mirror the `browser_push_state` command for raw panes.
                    let pane_id = v.get("paneId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let tab_id = v.get("tabId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if !url.trim().to_lowercase().starts_with("javascript:") {
                        if let Some(state) = app.try_state::<crate::BrowserState>() {
                            state.0.remember_tab_url(
                                &crate::browser::browser_label(&pane_id, &tab_id),
                                &url,
                            );
                        }
                        let _ = app.emit(
                            "browser:navigated",
                            BrowserNavigatedEvent { pane_id, tab_id, url },
                        );
                    }
                }
                Some("title_report") => {
                    // Mirror `browser_report_title` for raw panes: the page
                    // reports its document.title so the frontend can label
                    // the tab. Purely cosmetic — a spoofed title only changes
                    // the label, never behaviour.
                    let _ = app.emit(
                        "browser:title",
                        crate::types::BrowserTitleEvent {
                            pane_id: v.get("paneId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            tab_id: v.get("tabId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        },
                    );
                }
                _ => {}
            }
            Ok(())
        },
    ));
    let mut token = 0i64;
    let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
}

/// RAII guard for the `in_flight` create marker: removes the label on drop so
/// EVERY exit path of `create` (success and every `?` error return) releases
/// it. Without this, an early error return leaked the marker and every later
/// create for that pane was silently skipped — the pane sat on
/// "Opening browser…" forever.
struct InFlightGuard<'a> {
    in_flight: &'a Mutex<std::collections::HashSet<String>>,
    label: String,
}

impl<'a> InFlightGuard<'a> {
    fn new(in_flight: &'a Mutex<std::collections::HashSet<String>>, label: String) -> Self {
        Self { in_flight, label }
    }
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.in_flight.lock().remove(&self.label);
    }
}

/// The user's answer to a gate confirmation ("Allow once" / "Always on this
/// site" / Deny), delivered via the `browser_confirm_result` command.
#[derive(Debug, Clone, Copy)]
pub struct GateAnswer {
    pub approved: bool,
    pub always_for_site: bool,
}

/// One user-owned timeline record of an agent browser action. The agent
/// cannot write or delete these — the backend appends on every dispatch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub ts_ms: u64,
    pub op: String,
    /// What the agent said it was targeting (element description, URL, key…)
    pub target: String,
    /// "ok" | "error" | "denied" | "cancelled" | "paused"
    pub outcome: String,
    /// When gated: the risk class the classifier assigned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Cap for the per-pane in-memory timeline (oldest entries evicted).
pub const TIMELINE_CAP: usize = 200;

/// Per-label navigation-in-flight tracking (Windows raw panes). Present in
/// the map = a navigation started on that webview and hasn't completed; the
/// value is when it started. `run_action_for_pane_opts` consults this before
/// every eval — see `wait_nav_quiet`.
#[derive(Default)]
struct NavTracker {
    starts: HashMap<String, std::time::Instant>,
}

impl NavTracker {
    fn start(&mut self, label: &str) {
        self.starts.insert(label.to_string(), std::time::Instant::now());
    }
    fn end(&mut self, label: &str) {
        self.starts.remove(label);
    }
    fn since(&self, label: &str) -> Option<std::time::Duration> {
        self.starts.get(label).map(|t| t.elapsed())
    }
    fn in_flight(&self, label: &str) -> bool {
        self.starts.contains_key(label)
    }
}

pub struct BrowserManager {
    app: AppHandle,
    webviews: crate::browser::WebviewsMap,
    /// Panes currently being created (so concurrent creates for the same paneId
    /// don't race — the second one waits for the first). Key = pane_id string.
    in_flight: Mutex<std::collections::HashSet<String>>,
    /// The (pane_id, tab_id) most recently created or navigated — the target
    /// the agentic `browser_*` chat tools act on ("the page the user is
    /// looking at").
    active: Mutex<Option<(String, String)>>,
    /// In-flight agentic actions: request id -> sender + one-time nonce. The
    /// action's injected JS calls back (via the pane's WebMessageReceived
    /// bridge on Windows raw panes, or the `browser_action_result` command on
    /// tauri-managed panes) with the id AND the nonce, which resolves the
    /// matching oneshot so the async tool call can return. The nonce exists
    /// because browser panes load ARBITRARY external pages: req ids are
    /// sequential and guessable, and every page in the pane can post
    /// messages — without the shared secret, a hostile page could spoof a
    /// result for an in-flight action.
    pending: Mutex<HashMap<u64, PendingAction>>,
    next_req: AtomicU64,
    /// Maps pane_id -> project_id so the MCP WS dispatch (Task #4) can
    /// resolve a project_id to its browser panes.
    project_pane_registry: Mutex<HashMap<String /*pane_id*/, String /*project_id*/>>,
    /// Per-pane visibility state (updated by `set_visible`; default true on create).
    pane_visible: Mutex<HashMap<String /*pane_id*/, bool>>,
    /// Navigation-in-flight markers per webview label (Windows). Sources:
    /// `navigate` (synchronous, before the COM dispatch), the
    /// NavigationStarting handler; cleared by NavigationCompleted. Read by
    /// `run_action_for_pane_opts`'s quiesce gate.
    nav: Mutex<NavTracker>,
    /// Most-recently-created/navigated (pane_id, tab_id) per pane, so an explicit
    /// pane_id can resolve to the current active tab webview label.
    pane_active_tab: Mutex<HashMap<String /*pane_id*/, String /*tab_id*/>>,
    /// Last applied visibility per webview label ("browser-{pane}-tab-{tab}").
    /// The frontend's occlusion effect re-runs on every tabState change (i.e.
    /// every address-bar keystroke); without this dedupe each re-run would
    /// show() again and hand focus back to the main webview mid-typing.
    tab_visible: Mutex<HashMap<String /*label*/, bool>>,
    /// Pending resolve-pane roundtrip request id -> sender.
    pane_resolve_pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next_resolve_req: AtomicU64,
    /// Pending open-browser roundtrip request id -> sender. The answer is
    /// (pane_id, Option<tab_id>) — the tab lets open_pane_for_project poll
    /// for the right webview label instead of a hardcoded "default".
    pane_open_pending: Mutex<HashMap<u64, oneshot::Sender<Option<(String, Option<String>)>>>>,
    next_open_req: AtomicU64,
    /// Pending tab-management roundtrips (switch/new/close): request id ->
    /// sender. The frontend owns the tab list (zustand store), so the MCP tab
    /// ops resolve through it, then poll for the webview to register.
    tab_pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next_tab_req: AtomicU64,
    /// Last known URL per webview label — the origin source for the action
    /// gate's per-site consent ("always allow on this site"). Updated on
    /// navigate + every browser:navigated source.
    tab_urls: Mutex<HashMap<String /* label */, String /* url */>>,
    /// User pause/stop flags per pane (Phase 2 trust layer). `paused` rejects
    /// agent actions with a resumable "paused_by_user" error; `cancelled` is
    /// sticky until the user manually navigates (the UI stop button drains
    /// pending actions with cancelled_by_user).
    paused: Mutex<HashMap<String /* pane_id */, bool>>,
    cancelled: Mutex<HashMap<String /* pane_id */, bool>>,
    /// Pending gate confirmations: request id -> sender (approved?).
    gate_pending: Mutex<HashMap<u64, oneshot::Sender<GateAnswer>>>,
    next_gate_req: AtomicU64,
    /// In-memory action timeline per pane (user-owned audit trail; capped).
    /// The agent cannot write to or delete it — only the backend records.
    timeline: Mutex<HashMap<String /* pane_id */, Vec<TimelineEntry>>>,
}

/// One in-flight agentic action (see `BrowserManager.pending`).
struct PendingAction {
    tx: oneshot::Sender<String>,
    /// Per-action shared secret the page must echo back (anti-spoofing).
    nonce: String,
    /// Webview label the action was injected into — lets the user's Stop
    /// button drain only the stopped pane's in-flight actions.
    label: String,
}

impl BrowserManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            webviews: std::sync::Arc::new(Mutex::new(HashMap::new())),
            in_flight: Mutex::new(std::collections::HashSet::new()),
            active: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_req: AtomicU64::new(1),
            project_pane_registry: Mutex::new(HashMap::new()),
            pane_visible: Mutex::new(HashMap::new()),
            nav: Mutex::new(NavTracker::default()),
            tab_visible: Mutex::new(HashMap::new()),
            pane_active_tab: Mutex::new(HashMap::new()),
            pane_resolve_pending: Mutex::new(HashMap::new()),
            next_resolve_req: AtomicU64::new(1),
            pane_open_pending: Mutex::new(HashMap::new()),
            next_open_req: AtomicU64::new(1),
            tab_pending: Mutex::new(HashMap::new()),
            next_tab_req: AtomicU64::new(1),
            tab_urls: Mutex::new(HashMap::new()),
            paused: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            gate_pending: Mutex::new(HashMap::new()),
            next_gate_req: AtomicU64::new(1),
            timeline: Mutex::new(HashMap::new()),
        }
    }

    /// Create (or replace) the native webview for a pane+tab. Every navigation —
    /// including in-page link clicks — emits `browser:navigated` so the
    /// frontend can track the address bar and its local history stack.
    ///
    /// The `add_child` call (WebView2 child-control init) can block for a long
    /// time — or, under some window configs, hang indefinitely. Calling it
    /// synchronously on the main thread from a `#[tauri::command]` would wedge
    /// the whole IPC pipeline (session spawns, settings, everything queue up
    /// behind it and never run). So this method MUST be driven from an `async`
    /// command (runs on a Tauri async worker thread) that schedules `add_child`
    /// on the main thread via `run_on_main_thread` and blocks only its *own*
    /// worker thread on the result — leaving the main thread and other worker
    /// threads free to keep the app responsive.
    pub fn create(
        &self,
        pane_id: &str,
        tab_id: &str,
        url: &str,
        rect: Rect,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        eprintln!("[relay:browser] create pane={pane_id} tab={tab_id} label={label} url={url} rect={rect:?}");
        browser_log(&self.app, &format!("create pane={pane_id} tab={tab_id} label={label} url={url} rect={rect:?}"));

        // Guard against concurrent creates for the same label. React
        // StrictMode double-mounts in dev, so the frontend may send two
        // browser_create calls at once. The second call sees the in-flight
        // marker and returns immediately.
        {
            let mut inf = self.in_flight.lock();
            if inf.contains(&label) {
                eprintln!("[relay:browser] create SKIP label={label} — already in-flight");
                browser_log(&self.app, &format!("create SKIP label={label} — already in-flight"));
                return Ok(());
            }
            inf.insert(label.clone());
        }
        // Releases the in-flight marker on every exit path below — success and
        // all `?` error returns — so a failed create can't wedge the pane on
        // "Opening browser…" with later creates silently skipped.
        let _in_flight_guard = InFlightGuard::new(&self.in_flight, label.clone());

        ensure_supported().map_err(|e| {
            eprintln!("[relay:browser] ensure_supported FAILED: {e}");
            e
        })?;

        // Replacing an existing tab: close the old webview first. `close` is a
        // WebView2 controller call, and this method runs on an async worker
        // thread — controller calls from a non-UI thread cause access
        // violations / hangs, so dispatch it to the main thread. (We inline
        // the removal instead of calling `self.close`, which would also strip
        // the in-flight marker the guard above now owns.)
        {
            let old = self.webviews.lock().remove(&label);
            if let Some(pane) = old {
                eprintln!("[relay:browser] create replacing existing label={label} — closing old webview on main thread");
                self.run_main_thread_call(move || pane.close().map_err(|e| e.to_string()))
                    .map_err(|e| {
                        eprintln!("[relay:browser] close(existing) FAILED: {e}");
                        e
                    })?;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }

        // Validate the target URL up front (scheme allowlist — see
        // validate_nav_url).
        let _parsed = validate_nav_url(url).map_err(|e| {
            eprintln!("[relay:browser] url validation FAILED: {e}");
            e
        })?;
        let rect = sanitize(rect);

        // Build the webview (or webview window on Linux) on the main thread
        // then return the handle to the calling worker. The two paths
        // produce a `BrowserPane` whose API is uniform for the rest of
        // this module. See `build_pane_on_main_thread` for the platform
        // split.
        let pane = match self.build_pane_on_main_thread(pane_id, tab_id, url, rect, project_id) {
            Ok(p) => p,
            Err(e) => {
                browser_log(&self.app, &format!("create FAILED label={label}: {e}"));
                return Err(e);
            }
        };
        eprintln!("[relay:browser] create OK for label={label}");

        self.webviews.lock().insert(label.clone(), pane);

        // (Windows) the COM init chain in build_pane_on_main_thread already
        // attached the nav listeners, installed the document-start bridge and
        // navigated to `url` — all directly on our own controller, before the
        // pane ever landed in the map.

        // CDP: enable the Page domain for this webview so Page.* methods work
        // immediately and page-domain events (load, frameNavigated — the
        // Phase 2 wait_for upgrade) can be subscribed. Best-effort: a failure
        // never blocks pane creation. Must run AFTER the map insert (the CDP
        // call resolves the pane through it), like every other main-thread
        // roundtrip in this method.
        match self.call_devtools_protocol(&label, "Page.enable", "{}") {
            Ok(_) => browser_log(&self.app, &format!("Page.enable OK label={label}")),
            Err(e) => {
                eprintln!("[relay:browser] Page.enable failed (non-fatal): {e}");
                browser_log(&self.app, &format!("Page.enable FAILED label={label}: {e}"));
            }
        }
        self.pane_visible.lock().insert(pane_id.to_string(), true);
        self.tab_visible.lock().insert(label.clone(), true);
        self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());

        self.spawn_post_nav_inject(pane_id, tab_id);

        // Hand keyboard focus back to the main webview: the freshly-attached
        // WebView2 child grabs it, stealing keystrokes from the chat composer.
        self.refocus_main_webview();
        Ok(())
    }

    /// Register WebView2 NavigationStarting / NavigationCompleted COM event
    /// handlers on the pane's webview (best-effort, diagnostics + truthful
    /// load events). Runs on the main thread via with_webview; the handlers
    /// are COM-refcounted by WebView2 so they outlive this call.
    fn attach_navigation_listeners(&self, label: &str) {
        #[cfg(windows)]
        {
            use webview2_com::NavigationCompletedEventHandler;
            use webview2_com::NavigationStartingEventHandler;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventArgs;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationStartingEventArgs;

            let app = self.app.clone();
            let label_start = label.to_string();
            let app_complete = self.app.clone();
            let label_complete = label.to_string();
            // Registration must marshal through run_on_main_thread: a
            // with_webview dispatched from this (worker) thread was silently
            // dropped, so the listeners never attached.
            let attached = with_core_on_main(&self.app, self.webviews.clone(), label, "attach nav listeners", move |core| {
                use webview2_com::take_pwstr;
                use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS;
                // NavigationStarting: every navigation attempt (URL +
                // whether wry's on_navigation allowed it).
                let start_handler = NavigationStartingEventHandler::create(Box::new(
                    move |_sender, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
                        if let Some(args) = args {
                            let mut pw = windows::core::PWSTR::null();
                            if unsafe { args.Uri(&mut pw) }.is_ok() {
                                let uri = take_pwstr(pw);
                                browser_log(&app, &format!("nav START label={label_start} uri={uri}"));
                            }
                        }
                        // Nav-quiesce gate source: any navigation (typed URL,
                        // link click, redirect) marks the pane in-flight until
                        // the matching NavigationCompleted.
                        if let Some(state) = app.try_state::<crate::BrowserState>() {
                            state.0.mark_nav_start(&label_start);
                        }
                        Ok(())
                    },
                ));
                let mut start_token = 0i64;
                let _ = unsafe { core.add_NavigationStarting(&start_handler, &mut start_token) };
                // NavigationCompleted: success/failure + the WebView2 error
                // code — the ground truth for "stuck loading" reports.
                let complete_handler = NavigationCompletedEventHandler::create(Box::new(
                    move |_sender, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
                        if let Some(args) = args {
                            let mut success = windows::core::BOOL::default();
                            let _ = unsafe { args.IsSuccess(&mut success) };
                            let mut err = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                            let _ = unsafe { args.WebErrorStatus(&mut err) };
                            browser_log(
                                &app_complete,
                                &format!(
                                    "nav COMPLETE label={label_complete} success={} error={}",
                                    success.as_bool(),
                                    err.0
                                ),
                            );
                            if let Some(state) = app_complete.try_state::<crate::BrowserState>() {
                                state.0.mark_nav_end(&label_complete);
                            }
                            if success.as_bool() {
                                // The navigation reached a real load end —
                                // mirror it through an event the frontend
                                // can use to clear `loading` truthfully.
                                let _ = app_complete.emit(
                                    "browser:load-completed",
                                    label_complete.clone(),
                                );
                            }
                        }
                        Ok(())
                    },
                ));
                let mut complete_token = 0i64;
                let _ = unsafe { core.add_NavigationCompleted(&complete_handler, &mut complete_token) };
                Ok(())
            });
            if let Err(e) = attached {
                browser_log(&self.app, &format!("attach nav listeners FAILED label={label}: {e}"));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = label;
        }
    }

    /// Build the underlying webview and return a uniform `BrowserPane`.
    ///
    /// Windows: create the WebView2 environment + controller DIRECTLY via
    /// webview2-com against the main window's HWND. Tauri's dispatcher
    /// silently drops every Webview message for add_child children on this
    /// stack, so the tauri webview is not usable here. The
    /// environment->controller COM completions arrive on the main thread's
    /// normal pump (the worker blocks on a done-channel, never the pump);
    /// the chain attaches listeners, installs the document-start bridge and
    /// navigates to `url` before reporting done.
    ///
    /// macOS: child webview via `WebviewBuilder`+`add_child` (dispatch there
    /// is unaffected). Linux: standalone `WebviewWindow` per pane+tab.
    fn build_pane_on_main_thread(
        &self,
        pane_id: &str,
        tab_id: &str,
        url: &str,
        rect: Rect,
        project_id: Option<&str>,
    ) -> Result<BrowserPane, String> {
        let label = browser_label(pane_id, tab_id);
        let event_pane_id = pane_id.to_string();
        let event_tab_id = tab_id.to_string();
        let _app_for_emit = self.app.clone();

        // --- Windows: direct webview2-com controller (bypasses tauri) ---
        #[cfg(windows)]
        {
            use windows::core::HSTRING;

            let main_window = self
                .app
                .get_window("main")
                .ok_or_else(|| "main window not found".to_string())?;
            let hwnd_addr =
                main_window
                    .hwnd()
                    .map_err(|e| format!("main window hwnd unavailable: {e}"))?
                    .0 as usize;
            let scale = main_window
                .scale_factor()
                .map_err(|e| format!("scale_factor unavailable: {e}"))?;
            let bounds = windows::Win32::Foundation::RECT {
                left: (rect.x * scale) as i32,
                top: (rect.y * scale) as i32,
                right: ((rect.x + rect.width) * scale) as i32,
                bottom: ((rect.y + rect.height) * scale) as i32,
            };
            let data_dir = crate::user_dirs::app_data_dir(&self.app).join("webview2");

            let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
            let done: DoneHandle = std::sync::Arc::new(Mutex::new(Some(done_tx)));
            let slot: std::sync::Arc<Mutex<Option<BrowserPane>>> =
                std::sync::Arc::new(Mutex::new(None));

            let done_ctrl = done.clone();
            let slot_ctrl = slot.clone();
            let label2 = label.clone();
            let app2 = self.app.clone();
            let url2 = url.to_string();
            let self_webviews = self.webviews.clone();
            // Per-project profile (Phase 2): cookies/storage separated per
            // project via WebView2 multi-profile. Falls back to the default
            // profile when there's no project context or the options API is
            // unavailable in the installed WebView2 Runtime.
            let profile_name = browser_profile_for_project(project_id);
            // NOTE: called ON the main thread via run_main_thread_call — the
            // COM completions fire on the main thread's normal pump while the
            // WORKER waits on done_rx. The main thread never blocks.
            struct SendHwnd(windows::Win32::Foundation::HWND);
            unsafe impl Send for SendHwnd {}
            let hwnd = SendHwnd(windows::Win32::Foundation::HWND(
                hwnd_addr as *mut core::ffi::c_void,
            ));
            self.run_main_thread_call(move || {
                // Capture the WRAPPER (disjoint capture would otherwise grab
                // the raw HWND field directly and break Send).
                let hwnd_wrap = hwnd;
                create_environment_async(&data_dir, done_ctrl.clone(), move |env| {
                    // Move the WHOLE wrapper into a local first — `hwnd_wrap.0`
                    // directly in the call would disjoint-capture the raw HWND
                    // field again and break the controller closure's Send.
                    let h = hwnd_wrap;
                    let app_log = app2.clone();
                    // Per-project controller options (profile name). Requires
                    // Environment10 (WebView2 Runtime >= 1.0.1108); when the
                    // runtime is older, None keeps the default-profile path.
                    let controller_options = (|| {
                        use windows::core::Interface as _;
                        let profile = profile_name.as_ref()?;
                        let env10: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment10 =
                            env.cast().ok()?;
                        let options = unsafe { env10.CreateCoreWebView2ControllerOptions() }.ok()?;
                        unsafe {
                            options.SetProfileName(&windows::core::HSTRING::from(profile.as_str()))
                        }
                        .ok()?;
                        Some(options)
                    })();
                    create_controller_async(app_log, h.0, &env, bounds, done_ctrl.clone(), controller_options, move |controller| {
                        let core = unsafe { controller.CoreWebView2() }
                            .map_err(|e| format!("CoreWebView2 unavailable: {e}"))?;
                        // Document-start bridge (visual overlay primitives +
                        // diagnostics ring buffer) — installed once per
                        // webview; every later document re-runs both
                        // automatically.
                        let overlay_h = HSTRING::from(BRIDGE_OVERLAY_JS);
                        let script_handler = webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(())));
                        unsafe { core.AddScriptToExecuteOnDocumentCreated(&overlay_h, &script_handler) }
                            .map_err(|e| format!("AddScriptToExecuteOnDocumentCreated failed: {e}"))?;
                        let diag_h = HSTRING::from(DIAG_INIT_JS);
                        let diag_handler = webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(())));
                        let _ = unsafe { core.AddScriptToExecuteOnDocumentCreated(&diag_h, &diag_handler) };
                        attach_core_listeners(&app2, self_webviews.clone(), &label2, &core);
                        // B-3: page→host bridge for the raw pane (no Tauri IPC
                        // here) — action results + pushState reports.
                        attach_web_message_bridge(&app2, &core);
                        // Navigate straight to the target — no about:blank hop.
                        unsafe { core.Navigate(&HSTRING::from(url2)) }
                            .map_err(|e| format!("initial Navigate failed: {e}"))?;
                        *slot_ctrl.lock() = Some(BrowserPane {
                            controller: SendController(controller),
                            core: SendCore(core),
                        });
                        take_done(&done_ctrl, Ok(()));
                        Ok(())
                    })
                })
            })?;

            match done_rx.recv_timeout(Duration::from_secs(30)) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(format!("webview init failed: {e}")),
                Err(_) => return Err("webview init timed out (30s)".to_string()),
            }
            let pane = slot
                .lock()
                .take()
                .ok_or_else(|| "webview init produced no pane".to_string())?;
            return Ok(pane);
        }

        // --- macOS: child webview (tauri path — dispatch unaffected there) ---
        #[cfg(target_os = "macos")]
        {
            let main_window = self
                .app
                .get_window("main")
                .ok_or_else(|| {
                    let known: Vec<String> = self
                        .app
                        .windows()
                        .iter()
                        .map(|(l, _)| l.to_string())
                        .collect();
                    let msg = "main window not found".to_string();
                    eprintln!("[relay:browser] get_window('main') FAILED: {msg} — known: {known:?}");
                    msg
                })?;

            let app = self.app.clone();
            let app2 = self.app.clone();
            let event_pane_id2 = event_pane_id.clone();
            let event_tab_id2 = event_tab_id.clone();
            let label_for_nav = label.clone();
            let blank: tauri::Url = "about:blank".parse().expect("about:blank is a valid url");
            let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(blank))
                // Visual-feedback overlay: install at DOCUMENT-START in every
                // page the pane ever loads. This is the primary installation
                // path — the post-navigation evals below are belt-and-braces.
                // Without this, the overlay only existed on pages reached via
                // an explicit navigate() call: the FIRST click into a new page
                // cleared it, and every agent action after that degraded
                // silently to no-visual clicks (no cursor, no typing effect).
                .initialization_script(DIAG_INIT_JS)
                .initialization_script(BRIDGE_OVERLAY_JS)
                .on_navigation(move |nav_url| {
                    eprintln!("[relay:browser] navigation: {nav_url}");
                    browser_log(&app, &format!("wry on_navigation (nav START allowed) url={nav_url} label={label_for_nav}"));
                    if let Some(state) = app.try_state::<crate::BrowserState>() {
                        state.0.remember_tab_url(&label_for_nav, nav_url.as_str());
                    }
                    let _ = app.emit(
                        "browser:navigated",
                        BrowserNavigatedEvent {
                            pane_id: event_pane_id.clone(),
                            tab_id: event_tab_id.clone(),
                            url: nav_url.to_string(),
                        },
                    );
                    let lbl = label_for_nav.clone();
                    let app_ref = app.clone();
                    let pid = event_pane_id.clone();
                    let tid = event_tab_id.clone();
                    // P-2: tokio task, not a detached OS thread per nav (see
                    // the site above).
                    tauri::async_runtime::spawn(async move {
                        // B9: no more blind 1.5 s sleep. The injection is
                        // idempotent (guarded by
                        // `window.__relay_pushstate_patched`), so inject on
                        // an escalating schedule: fast pages get the hook
                        // immediately, slow pages still get it within ~5 s,
                        // and each later eval no-ops once installed.
                        let mut waited = 0u64;
                        for target in [0u64, 150, 400, 900, 1800, 3500, 5000] {
                            if target > waited {
                                tokio::time::sleep(std::time::Duration::from_millis(target - waited)).await;
                                waited = target;
                            }
                            match app_ref.get_webview(&lbl) {
                                Some(w) => {
                                    let _ = w.eval(&pushstate_injection_js(&pid, &tid));
                                    // Belt-and-braces: the overlay + diag layer
                                    // are ALSO initialization scripts (install
                                    // at document-start in every page), but keep
                                    // the evals here so panes created before a
                                    // bridge update and any document-start
                                    // race still get them. Idempotent.
                                    let _ = w.eval(DIAG_INIT_JS);
                                    let _ = w.eval(BRIDGE_OVERLAY_JS);
                                }
                                // Webview gone (tab closed mid-load) — stop.
                                None => break,
                            }
                        }
                    });
                    true
                })
                .on_new_window(move |new_url, _label| {
                    eprintln!("[relay:browser] new_window: {new_url} — navigating in-place");
                    let _ = app2.emit(
                        "browser:navigated",
                        BrowserNavigatedEvent {
                            pane_id: event_pane_id2.clone(),
                            tab_id: event_tab_id2.clone(),
                            url: new_url.to_string(),
                        },
                    );
                    tauri::webview::NewWindowResponse::Deny
                });

            eprintln!(
                "[relay:browser] add_child at ({},{}) {}x{} (main-thread scheduled)",
                rect.x, rect.y, rect.width, rect.height
            );

            let (tx, rx) = mpsc::sync_channel::<Result<Webview, String>>(1);
            let window_ref = main_window.clone();
            let pos = LogicalPosition::new(rect.x, rect.y);
            let size = LogicalSize::new(rect.width, rect.height);
            let label_owned = label.clone();
            let _ = self.app.run_on_main_thread(move || {
                // wry/webview2-com can PANIC inside add_child (WebView2
                // controller init failure, duplicate-label race). Letting that
                // unwind through the tao main event loop kills the whole
                // process, so catch it and convert to the normal Err path —
                // the frontend then engages its iframe fallback.
                let res = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    window_ref
                        .add_child(builder, pos, size)
                        .map_err(|e| format!("failed to create browser webview: {e}"))
                })) {
                    Ok(res) => res,
                    Err(payload) => {
                        let detail = if let Some(s) = payload.downcast_ref::<&str>() {
                            (*s).to_string()
                        } else if let Some(s) = payload.downcast_ref::<String>() {
                            s.clone()
                        } else {
                            "unknown panic".to_string()
                        };
                        eprintln!("[relay:browser] add_child PANICKED on main thread: {detail}");
                        Err(format!("browser webview creation panicked: {detail}"))
                    }
                };
                match &res {
                    Ok(_) => eprintln!("[relay:browser] add_child OK on main thread for label={label_owned}"),
                    Err(msg) => eprintln!("[relay:browser] add_child FAILED on main thread: {msg}"),
                }
                let _ = tx.send(res);
            });
            let webview = match rx.recv() {
                Ok(Ok(w)) => w,
                Ok(Err(msg)) => return Err(msg),
                Err(_) => return Err("browser webview create thread dropped".to_string()),
            };
            return Ok(BrowserPane { webview });
        }

        // --- Linux: standalone WebviewWindow per pane+tab ---
        #[cfg(target_os = "linux")]
        {
            // The frontend reports the pane's rect in viewport-relative
            // logical pixels. We need to convert that to absolute screen
            // coordinates by adding the main window's position. If the main
            // window hasn't been measured yet (e.g. very first call), we
            // defer the position update via `set_position` after the window
            // is built — the frontend's ResizeObserver will sync it again
            // moments later.
            let main = self.app.get_window("main");
            let (abs_x, abs_y) = match main.as_ref().and_then(|w| w.outer_position().ok()) {
                Some(pos) => (pos.x as f64 + rect.x, pos.y as f64 + rect.y),
                None => (rect.x, rect.y),
            };

            let (tx, rx) = mpsc::sync_channel::<Result<tauri::WebviewWindow, String>>(1);
            let app = self.app.clone();
            let label_for_win = label.clone();
            let pos = LogicalPosition::new(abs_x, abs_y);
            let size = LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0));
            let _ = self.app.run_on_main_thread(move || {
                // Re-resolve the main window position on the main thread so
                // the value is current (the previous read may have raced with
                // a recent window-move event).
                let final_pos = if let Some(m) = app.get_window("main") {
                    if let Ok(op) = m.outer_position() {
                        LogicalPosition::new(op.x as f64 + rect.x, op.y as f64 + rect.y)
                    } else {
                        pos
                    }
                } else {
                    pos
                };

                let res = WebviewWindowBuilder::new(
                    &app,
                    &label_for_win,
                    WebviewUrl::External("about:blank".parse().expect("about:blank is a valid url")),
                )
                .title(format!("Browser - {label_for_win}"))
                .decorations(false)
                .resizable(false)
                .skip_taskbar(true)
                .always_on_top(false)
                .focused(false)
                .inner_size(size.width, size.height)
                .position(final_pos.x, final_pos.y)
                .build()
                .map_err(|e| format!("failed to create browser webview window: {e}"));
                match &res {
                    Ok(_) => eprintln!("[relay:browser] WebviewWindow OK for label={label_for_win}"),
                    Err(msg) => eprintln!("[relay:browser] WebviewWindow FAILED for label={label_for_win}: {msg}"),
                }
                let _ = tx.send(res);
            });

            let window = match rx.recv() {
                Ok(Ok(w)) => w,
                Ok(Err(msg)) => return Err(msg),
                Err(_) => return Err("browser webview window create thread dropped".to_string()),
            };

            // The webview is the inner webview of the WebviewWindow.
            // `Manager::get_webview` resolves by label across all windows.
            let webview = self
                .app
                .get_webview(&label)
                .ok_or_else(|| format!("created webview window but could not resolve webview for label {label}"))?;

            // Suppress the unused-emit capture on this code path.
            let _ = app_for_emit;

            // Hide by default until the frontend calls set_visible(true).
            // On creation we treat the pane as visible — the frontend will
            // call set_visible(false) if the pane is occluded.
            let _ = window.show();

            return Ok(BrowserPane { webview, window });
        }
    }

    /// Run a webview controller call on the main thread and block the calling
    /// worker until it completes — the same dispatch pattern `add_child` uses.
    /// WebView2 controller calls from a non-UI thread cause access violations
    /// / hangs, so async-worker code paths must funnel controller calls
    /// through here. MUST NOT be called from the main thread itself (the
    /// queued closure would never run while we block on `recv` — deadlock).
    fn run_main_thread_call<F>(&self, f: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String> + Send + 'static,
    {
        let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let _ = self.app.run_on_main_thread(move || {
            let _ = tx.send(f());
        });
        match rx.recv() {
            Ok(res) => res,
            Err(_) => Err("main thread dropped browser webview call".to_string()),
        }
    }

    /// Hand keyboard focus back to the main webview after a browser-pane
    /// transition (create / navigate / show): appearing WebView2 children grab
    /// focus, which steals keystrokes from the chat composer. Queued (not
    /// blocking) so it's safe from both the main thread and async workers.
    fn refocus_main_webview(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(w) = app.get_webview("main") {
                let _ = w.set_focus();
            }
        });
    }

}

// ---- BrowserManager impl children (mechanical split of the former
// monolith); private methods are pub(super) so sibling impl blocks reach them.
mod actions;
mod interactions;
mod navigation;
mod tabs;


// Build the description-resolution JS body for `run_action_for_pane`. The
// bridge reads `DESC` (the selector/description) and `ACTION` ("click" |
// "type") as interpolated literals — JSON-escaped so special characters in a
// CSS selector or a label can't break out of the string. Returns the bridge's
// JSON: `{"ok":true,"ref":..,"tag":..,"label":..,"matchType":..,"confidence":..}`
// or `{"ok":false,"error":"not_found","desc":..,"suggestions":[..]}`.

// ---- Page capture (browser_screenshot) ------------------------------------


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_wrapper_reports_via_command_with_req_id() {
        let js = action_wrapper_js(42, "abc123def4567890", "return 'hi';", &ActionOpts::default());
        assert!(js.contains("browser_action_result"));
        assert!(js.contains("reqId: 42"));
        // B-3: the per-action nonce must ride along (anti-spoofing) ...
        assert!(js.contains("nonce: 'abc123def4567890'"));
        assert!(js.contains("return 'hi';"));
        // ... and the raw-WebView2 transport (postMessage) is preferred with
        // the Tauri invoke kept as the tauri-managed-pane fallback.
        assert!(js.contains("chrome.webview.postMessage"));
        assert!(js.contains("__TAURI_INTERNALS__"));
        // Errors are reported too, not swallowed.
        assert!(js.contains("'ERROR: '"));
    }

    #[test]
    fn action_wrapper_awaits_promise_results() {
        // A body that returns a Promise (the visual-feedback path) must be
        // detected and awaited, not reported as "[object Promise]".
        let js = action_wrapper_js(
            7,
            "feedfacedeadbeef",
            "return new Promise(function(r){ r('done'); });",
            &ActionOpts::default(),
        );
        assert!(js.contains("typeof __result.then === 'function'"));
        assert!(js.contains("browser_action_result"));
        assert!(js.contains("reqId: 7"));
        // Promise rejection path still maps to the ERROR prefix.
        assert!(js.contains("'ERROR: '"));
    }

    #[test]
    fn action_wrapper_includes_pacing_when_watch_mode_true() {
        let opts = ActionOpts { watch_mode: true, pane_delay_ms: 600 };
        let js = action_wrapper_js(1, "0123456789abcdef", "return 'ok';", &opts);
        // The JS must interpolate WATCH_MODE = true and PANE_DELAY_MS = 600
        // as literal values, not strings.
        assert!(js.contains("var WATCH_MODE = true;"));
        assert!(js.contains("var PANE_DELAY_MS = 600;"));
        assert!(js.contains("if (WATCH_MODE)"));
        assert!(js.contains("setTimeout(report, PANE_DELAY_MS)"));
        assert!(js.contains("__finish(__result)"));
        // Watch mode + a navigation committing during the pacing delay used
        // to drop the result (the timer's context died). pagehide delivers
        // it as the document unloads instead.
        assert!(js.contains("addEventListener('pagehide', report"));
        assert!(js.contains("if (sent) return;"));
    }

    #[test]
    fn action_wrapper_skips_pacing_when_watch_mode_false() {
        let opts = ActionOpts::default();
        let js = action_wrapper_js(1, "0123456789abcdef", "return 'ok';", &opts);
        assert!(js.contains("var WATCH_MODE = false;"));
        assert!(js.contains("var PANE_DELAY_MS = 250;"));
        assert!(js.contains("if (WATCH_MODE)"));
        // __finish still wraps the report (unified path), but the setTimeout
        // branch won't fire.
    }

    #[test]
    fn nav_tracker_marks_in_flight_until_completion() {
        // Root cause of the navigate/read_page flakiness: evals racing an
        // in-flight navigation die with the old JS context, so the result
        // report never arrives. The quiesce gate keys off NavTracker — the
        // marker must flip exactly with START/COMPLETED.
        let mut nav = NavTracker::default();
        let label = "browser-p1-tab-default";
        assert!(!nav.in_flight(label));
        assert!(nav.since(label).is_none());

        nav.start(label);
        assert!(nav.in_flight(label));
        let since = nav.since(label).expect("start must record an instant");
        assert!(since < Duration::from_secs(1), "elapsed must start near zero");

        // A second START (redirect / double handler registration) is
        // idempotent — it overwrites, never counts up.
        nav.start(label);
        assert!(nav.in_flight(label));

        nav.end(label);
        assert!(!nav.in_flight(label));
        assert!(nav.since(label).is_none());

        // End without a matching start (stray COMPLETE from an earlier nav)
        // must be a no-op, not a panic.
        nav.end(label);
        assert!(!nav.in_flight(label));
    }

    #[test]
    fn nav_tracker_tracks_labels_independently() {
        // Multi-pane: a navigation on pane A must not gate evals on pane B.
        let mut nav = NavTracker::default();
        nav.start("browser-p1-tab-default");
        assert!(nav.in_flight("browser-p1-tab-default"));
        assert!(!nav.in_flight("browser-p2-tab-default"));
        nav.end("browser-p1-tab-default");
        assert!(!nav.in_flight("browser-p1-tab-default"));
    }

    #[test]
    fn click_js_targets_ref_and_guards_missing() {
        let js = click_js(3, None);
        assert!(js.contains(r#"data-relay-ref="3""#));
        assert!(js.contains(".click()"));
        assert!(js.contains("ERROR: ref 3 is stale"));
    }

    #[test]
    fn type_js_json_escapes_text() {
        let js = type_js(1, "he said \"hi\"\nbye", None);
        // The typed text must be a valid JS string literal (quotes/newlines escaped).
        assert!(js.contains(r#"he said \"hi\"\nbye"#));
        assert!(js.contains(r#"data-relay-ref="1""#));
        assert!(js.contains("dispatchEvent"));
    }

    #[test]
    fn scroll_js_uses_amount() {
        assert!(scroll_js(-250).contains("window.scrollBy(0, -250)"));
    }

    #[test]
    fn hover_js_targets_ref_and_dispatches_mouse_events() {
        let js = hover_js(4);
        assert!(js.contains(r#"data-relay-ref="4""#));
        assert!(js.contains("MouseEvent"));
        assert!(js.contains("mouseover"));
        assert!(js.contains("mouseenter"));
        assert!(js.contains("ERROR: ref 4 is stale"));
    }

    #[test]
    fn history_js_drives_real_history_stack() {
        assert!(history_js("back").contains("history.go(-1)"));
        assert!(history_js("forward").contains("history.go(1)"));
        // Both directions report the before/after URL.
        assert!(history_js("back").contains("before = location.href"));
    }

    #[test]
    fn evaluate_js_json_serializes_expression_value() {
        let js = evaluate_js("document.title");
        // The expression is injected as a JS string literal wrapped in new Function.
        assert!(js.contains("new Function('return (' + __expr + ');')"));
        // Function/undefined/circular tolerance markers present.
        assert!(js.contains("[Function]"));
        assert!(js.contains("[undefined]"));
        assert!(js.contains("[circular]"));
        // Result path is JSON.stringify, not string coercion.
        assert!(js.contains("JSON.stringify(__value"));
    }

    #[test]
    fn evaluate_js_escapes_expression_literal() {
        // Quotes/backslashes in the expression must be JSON-escaped so they
        // can't break out of the injected string literal.
        let js = evaluate_js(r#"document.querySelector(".a\"b")"#);
        assert!(js.contains(r#"document.querySelector(\".a\\\"b\")"#));
    }

    #[test]
    fn read_page_js_assigns_refs_and_collects_text() {
        assert!(READ_PAGE_JS.contains("data-relay-ref"));
        assert!(READ_PAGE_JS.contains("INTERACTIVE ELEMENTS"));
        assert!(READ_PAGE_JS.contains("location.href"));
    }

    #[test]
    fn label_is_prefixed_and_unique_per_pane_and_tab() {
        assert_eq!(browser_label("abc-123", "default"), "browser-abc-123-tab-default");
        assert_eq!(browser_label("abc-123", "tab-2"), "browser-abc-123-tab-tab-2");
        assert_ne!(browser_label("a", "x"), browser_label("b", "y"));
        assert!(browser_label("x", "y").starts_with("browser-"));
    }

    #[test]
    fn sanitize_clamps_degenerate_sizes() {
        let r = sanitize(Rect {
            x: 10.0,
            y: 20.0,
            width: 0.0,
            height: -5.0,
        });
        assert_eq!(r.x, 10.0);
        assert_eq!(r.y, 20.0);
        assert_eq!(r.width, 1.0);
        assert_eq!(r.height, 1.0);
    }

    #[test]
    fn sanitize_replaces_non_finite_values() {
        let r = sanitize(Rect {
            x: f64::NAN,
            y: f64::INFINITY,
            width: f64::NAN,
            height: f64::NEG_INFINITY,
        });
        assert_eq!(r.x, 0.0);
        assert_eq!(r.y, 0.0);
        assert_eq!(r.width, 1.0);
        assert_eq!(r.height, 1.0);
    }

    #[test]
    fn sanitize_keeps_valid_rect() {
        let r = sanitize(Rect {
            x: 100.5,
            y: 42.25,
            width: 640.0,
            height: 480.0,
        });
        assert_eq!((r.x, r.y, r.width, r.height), (100.5, 42.25, 640.0, 480.0));
    }

    #[test]
    fn platform_support_matches_target_os() {
        // All supported platforms now provide a native browser pane (Linux
        // uses standalone WebviewWindows instead of child webviews).
        assert!(platform_supported());
    }

    #[test]
    fn rect_deserializes_from_frontend_shape() {
        let r: Rect = serde_json::from_str(r#"{"x":1.0,"y":2.0,"width":3.0,"height":4.0}"#).unwrap();
        assert_eq!((r.x, r.y, r.width, r.height), (1.0, 2.0, 3.0, 4.0));
    }

    // ---- New extraction tests ----

    #[test]
    fn read_mode_deserializes_from_snake_case() {
        let full: ReadMode = serde_json::from_str("\"full\"").unwrap();
        assert!(matches!(full, ReadMode::Full));
        let summary: ReadMode = serde_json::from_str("\"summary_only\"").unwrap();
        assert!(matches!(summary, ReadMode::SummaryOnly));
        let section: ReadMode = serde_json::from_str("\"section\"").unwrap();
        assert!(matches!(section, ReadMode::Section));
    }

    #[test]
    fn read_mode_defaults_to_full() {
        let mode = ReadMode::default();
        assert!(matches!(mode, ReadMode::Full));
    }

    #[test]
    fn read_mode_serializes_to_snake_case() {
        let json = serde_json::to_string(&ReadMode::Full).unwrap();
        assert_eq!(json, "\"full\"");
        let json = serde_json::to_string(&ReadMode::SummaryOnly).unwrap();
        assert_eq!(json, "\"summary_only\"");
        let json = serde_json::to_string(&ReadMode::Section).unwrap();
        assert_eq!(json, "\"section\"");
        let json = serde_json::to_string(&ReadMode::Interactive).unwrap();
        assert_eq!(json, "\"interactive\"");
    }

    #[test]
    fn build_extract_js_with_interactive_mode() {
        // Interactive mode must reach the bridge as "interactive" so the
        // extract() short-circuit (accessibility tree, no Readability) fires.
        let js = build_extract_js(&ReadMode::Interactive, None);
        assert!(js.contains("var MODE = \"interactive\";"));
    }

    #[test]
    fn build_resolve_js_injects_desc_and_action_escaped() {
        // The description must be a JSON-escaped JS string literal so a CSS
        // selector or label containing quotes can't break out.
        let js = build_resolve_js("a[href*=\"x\"]", "click");
        assert!(js.contains("var DESC = \"a[href*=\\\"x\\\"]\";"));
        assert!(js.contains("var ACTION = \"click\";"));
    }

    #[test]
    fn extracted_content_round_trips_sample_json() {
        // Sample JSON matching what the bridge emits for a full extraction.
        // Use actual newlines in the raw string, not \n escapes, and avoid
        // quote sequences that could conflict with the r#" delimiter.
        let sample = r##"{
  "markdown": "# Hello\n\nWorld\n\n- item 1\n- item 2\n\n[Link](https://example.com)",
  "title": "Example Page",
  "url": "https://example.com/page",
  "canonicalUrl": "https://example.com/canonical",
  "publishedDate": "2026-01-15",
  "byline": "Jane Doe",
  "mode": "full",
  "failureReason": null,
  "elementRefs": [
    {"ref": 0, "tag": "a", "label": "Home", "href": "/"},
    {"ref": 1, "tag": "button", "label": "Search", "href": null}
  ]
}"##;
        let content: ExtractedContent = serde_json::from_str(sample).unwrap();
        assert_eq!(content.title, "Example Page");
        assert_eq!(content.url, "https://example.com/page");
        assert_eq!(content.canonical_url.as_deref(), Some("https://example.com/canonical"));
        assert_eq!(content.published_date.as_deref(), Some("2026-01-15"));
        assert_eq!(content.byline.as_deref(), Some("Jane Doe"));
        assert_eq!(content.mode, "full");
        assert!(content.failure_reason.is_none());
        assert_eq!(content.element_refs.len(), 2);
        assert_eq!(content.element_refs[0].r#ref, 0);
        assert_eq!(content.element_refs[0].tag, "a");
        assert_eq!(content.element_refs[0].href.as_deref(), Some("/"));
        assert_eq!(content.element_refs[1].r#ref, 1);
        assert_eq!(content.element_refs[1].tag, "button");
        assert!(content.element_refs[1].href.is_none());
        // Round-trip: serialize back and verify
        let json = serde_json::to_string_pretty(&content).unwrap();
        let reparse: ExtractedContent = serde_json::from_str(&json).unwrap();
        assert_eq!(reparse.title, content.title);
        assert_eq!(reparse.markdown, content.markdown);
    }

    #[test]
    fn extracted_content_with_failure_reason() {
        let sample = r##"{
  "markdown": "",
  "title": "Paywall Site",
  "url": "https://example.com/paywall",
  "canonicalUrl": null,
  "publishedDate": null,
  "byline": "",
  "mode": "full",
  "failureReason": "paywalled",
  "elementRefs": []
}"##;
        let content: ExtractedContent = serde_json::from_str(sample).unwrap();
        assert_eq!(content.failure_reason.as_deref(), Some("paywalled"));
        assert_eq!(content.markdown, "");
        assert!(content.element_refs.is_empty());
    }

    #[test]
    fn bridge_js_includes_readability_constructor() {
        // The vendored readability.js must be non-empty and contain the
        // Readability constructor function.
        assert!(READABILITY_JS.len() > 1000, "readability.js should be > 1KB");
        assert!(READABILITY_JS.contains("function Readability"));
        assert!(READABILITY_JS.contains("Readability.prototype"));
    }

    #[test]
    fn build_extract_js_embeds_mode_and_selector() {
        let js = build_extract_js(&ReadMode::Full, None);
        assert!(js.contains("function Readability")); // readability.js is prepended
        // The placeholders are quoted in bridge_extract.js; the injected value
        // must be the *inner* string, NOT re-quoted into `""full""` (a syntax
        // error that would break every browser_read call in the live webview).
        assert!(js.contains("var MODE = \"full\";"));
        assert!(js.contains("var SELECTOR = \"\";"));
        // No double-quoting / triple-quote sequence (the old bug).
        assert!(!js.contains("\"\"\""), "selector was double-quoted into a syntax error");
        assert!(!js.contains("\"\"full\"\""), "mode was double-quoted into a syntax error");
        // Placeholders fully replaced.
        assert!(!js.contains("MODE_PLACEHOLDER"), "MODE placeholder not replaced");
        assert!(!js.contains("SELECTOR_PLACEHOLDER"), "SELECTOR placeholder not replaced");
    }

    #[test]
    fn build_extract_js_with_section_mode() {
        // A selector with embedded quotes must be escaped, not double-quoted,
        // so the resulting JS string literal is still valid.
        let js = build_extract_js(&ReadMode::Section, Some("#content"));
        assert!(js.contains("var MODE = \"section\";"));
        assert!(js.contains("var SELECTOR = \"#content\";"));
        // No double-quoting on the MODE/SELECTOR lines specifically (the
        // readability.js vendored blob legitimately contains `""` elsewhere, so
        // we can't assert absence over the whole string — only the lines we own).
        for line in js.lines() {
            if line.contains("var MODE") || line.contains("var SELECTOR") {
                assert!(
                    !line.contains("\"\"") && !line.contains("\"\"\""),
                    "injected line was double-quoted into a syntax error: {line}"
                );
            }
        }
    }

    #[test]
    fn build_extract_js_escapes_quotes_in_selector() {
        // A selector containing a double-quote must be backslash-escaped so the
        // injected JS string literal parses — regression guard for the
        // double-quote bug that broke live browser_read calls.
        let js = build_extract_js(&ReadMode::Section, Some("a[href*=\"foo\"]"));
        // The injected literal must contain the escaped quote, and the whole
        // `var SELECTOR = ...;` line must be a syntactically valid JS statement.
        assert!(js.contains("a[href*=\\\"foo\\\"]"));
        let line = js
            .lines()
            .find(|l| l.contains("var SELECTOR"))
            .expect("SELECTOR line present");
        // Exactly one unescaped pair of surrounding quotes.
        let trimmed = line.trim_start();
        assert!(
            trimmed.starts_with("var SELECTOR = \"") && trimmed.trim_end().ends_with("\";"),
            "SELECTOR line is not a valid JS string-literal assignment: {line}"
        );
    }

    // ---- Phase 1 agent core ----

    #[test]
    fn validate_nav_url_allows_browseable_schemes_and_blocks_script() {
        // The pane forwards raw strings from agents and chat tools; the
        // scheme allowlist must reject script-bearing URLs while keeping
        // http/https/file/about (file is deliberately allowed for app
        // previews; about:blank is the pane's blank state).
        assert!(validate_nav_url("https://example.com/").is_ok());
        assert!(validate_nav_url("http://localhost:5173/").is_ok());
        assert!(validate_nav_url("file:///C:/proj/index.html").is_ok());
        assert!(validate_nav_url("about:blank").is_ok());
        assert!(validate_nav_url("javascript:alert(1)").is_err());
        assert!(validate_nav_url("JAVASCRIPT:alert(1)").is_err());
        assert!(validate_nav_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(validate_nav_url("vbscript:msgbox(1)").is_err());
        assert!(validate_nav_url("blob:https://example.com/abc").is_err());
        assert!(validate_nav_url("not a url at all ://").is_err());
    }

    #[test]
    fn snapshot_js_injects_query_and_keeps_placeholder_free() {
        let js = snapshot_js(Some("Sign In"));
        assert!(js.contains("var QUERY = \"Sign In\";"));
        assert!(!js.contains("QUERY_PLACEHOLDER"));
        let js_empty = snapshot_js(None);
        assert!(js_empty.contains("var QUERY = \"\";"));
        // The bridge must tag refs (same contract as click/type) and emit
        // the compact one-line-per-element format.
        assert!(js.contains("data-relay-ref"));
        assert!(js.contains("var MAX_LIST = 250;"));
    }

    #[test]
    fn fill_form_js_embeds_fields_json_and_uses_native_setter() {
        let fields = serde_json::json!([
            { "ref": 2, "text": "a\"b" },
            { "ref": 5, "text": "" }
        ]).to_string();
        let js = fill_form_js(&fields);
        // Fields ride as a JSON literal (escaped quotes preserved).
        assert!(js.contains("a\\\"b"));
        assert!(js.contains("var fields ="));
        // React-controlled inputs need the native value setter.
        assert!(js.contains("getOwnPropertyDescriptor"));
        assert!(js.contains("dispatchEvent"));
        // Stale refs are reported per-field, not fatal.
        assert!(js.contains("stale"));
    }

    #[test]
    fn select_option_js_targets_ref_and_matches_value_or_text() {
        let js = select_option_js(7, "Shipping");
        assert!(js.contains(r#"data-relay-ref="7""#));
        assert!(js.contains("var want = \"Shipping\";"));
        assert!(js.contains("HTMLSelectElement"));
        assert!(js.contains("Available:")); // error path lists options
    }

    #[test]
    fn press_key_js_dispatches_key_events_and_submits_form_on_enter() {
        let js = press_key_js("Enter");
        assert!(js.contains("var key = \"Enter\";"));
        assert!(js.contains("KeyboardEvent('keydown'"));
        assert!(js.contains("KeyboardEvent('keyup'"));
        assert!(js.contains("requestSubmit"));
        let js_esc = press_key_js("Escape");
        assert!(js_esc.contains("blur"));
    }

    #[test]
    fn diag_read_js_returns_incremental_entries() {
        let js = diag_read_js("console", 42);
        assert!(js.contains("var since = 42;"));
        assert!(js.contains("diag.console"));
        assert!(js.contains("__relayDiag"));
        // Uninstalled pages degrade to an explicit marker.
        assert!(js.contains("installed: false"));
    }

    #[test]
    fn diag_init_js_patches_console_fetch_xhr_and_mutations_once() {
        // Guard: re-injection must be a no-op (escalating schedule + post-nav).
        assert!(DIAG_INIT_JS.contains("if (window.__relayDiag)"));
        assert!(DIAG_INIT_JS.contains("console[level]"));
        assert!(DIAG_INIT_JS.contains("window.fetch"));
        assert!(DIAG_INIT_JS.contains("XMLHttpRequest"));
        assert!(DIAG_INIT_JS.contains("MutationObserver"));
        assert!(DIAG_INIT_JS.contains("lastMutation"));
        // Never record request bodies (credentials) — URLs/status only.
        assert!(!DIAG_INIT_JS.contains("request body"));
    }

    #[test]
    fn stable_check_js_requires_quiescence_and_ready_state() {
        let js = stable_check_js();
        assert!(js.contains("readyState === 'complete'"));
        assert!(js.contains("lastMutation"));
        assert!(js.contains("600"));
    }

    #[test]
    fn browser_profile_names_are_sanitized_and_scoped() {
        // Webview2 profile names must stay within [a-zA-Z0-9_-]; arbitrary
        // project ids are sanitized, not rejected, so every project gets a
        // stable isolated profile.
        assert_eq!(
            browser_profile_for_project(Some("proj-123")).as_deref(),
            Some("p-proj-123")
        );
        let weird = browser_profile_for_project(Some(r"C:\Users\odd id.uuid")).unwrap();
        assert!(weird.starts_with("p-"));
        assert!(weird.chars().skip(2).all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // No project context -> default profile (legacy behavior).
        assert!(browser_profile_for_project(None).is_none());
        assert!(browser_profile_for_project(Some("   ")).is_none());
        // Deterministic: same id -> same profile (cookies persist per project).
        assert_eq!(
            browser_profile_for_project(Some("acme")),
            browser_profile_for_project(Some("acme"))
        );
    }

    #[test]
    fn click_and_type_js_narrate_when_given() {
        // Narration labels (trust layer) ride into the action body, guarded on
        // the overlay primitive existing (graceful degradation).
        let js = click_js(3, Some("clicking the checkout button"));
        assert!(js.contains("__relay_narrate"));
        assert!(js.contains("clicking the checkout button"));
        let plain = click_js(3, None);
        assert!(!plain.contains("__relay_narrate"));
        let type_n = type_js(4, "x", Some("typing email"));
        assert!(type_n.contains("__relay_narrate"));
        assert!(type_n.contains("typing email"));
    }

    #[test]
    fn stale_ref_messages_follow_the_re_read_protocol() {
        // click/type/hover JS must return the canonical stale-ref error —
        // the agent-facing instruction to re-read (Anthropic stale-ref
        // protocol), not the old vague "call browser_read" wording.
        for (js, r) in [
            (click_js(3, None), "3"),
            (type_js(4, "x", None), "4"),
            (hover_js(5), "5"),
        ] {
            assert!(js.contains("is stale"), "missing stale wording");
            assert!(js.contains(&format!("ref {r}")));
            assert!(js.contains("re-read the page"));
        }
        // select_option carries the same protocol.
        assert!(select_option_js(9, "x").contains("is stale"));
    }

    #[test]
    fn read_opts_default_values() {
        let opts = ReadOpts::default();
        assert_eq!(opts.settle_ms, 400);
        assert_eq!(opts.max_scroll_steps, 4);
    }
}
