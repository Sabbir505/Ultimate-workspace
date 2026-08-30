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

/// Fixed loopback port the `conduit-browser-mcp` binary connects to. The
/// in-app WebSocket server (`browser_mcp::serve`) binds 127.0.0.1:{port}; the
/// standalone MCP binary reads this from the `CONDUIT_WS_PORT` env var (set in
/// `.mcp.json`/`--mcp-config` registration) and forwards tool calls here.
/// Shared between the two via `conduit_lib` so they can never drift apart.
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

fn ensure_supported() -> Result<(), String> {
    Ok(())
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
const BRIDGE_RESOLVE_JS: &str = include_str!("bridge_resolve.js");
/// Visual feedback overlay (Task #7): synthetic cursor tween, click ripple,
/// animated typing caret, pre-action highlight. Defines globals
/// `__conduit_injectOverlay` / `__conduit_tweenCursor` / `__conduit_showRipple`
/// / `__conduit_highlight` / `__conduit_showCaret`. Injected after every
/// navigation (alongside the pushState monkey-patch) and re-injected lazily by
/// each action so a fresh page load re-installs it.
const BRIDGE_OVERLAY_JS: &str = include_str!("bridge_overlay.js");

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
    let Some(dir) = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("logs"))
        .filter(|d| std::fs::create_dir_all(d).is_ok())
    else {
        return;
    };
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
#[cfg(windows)]
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

#[cfg(not(windows))]
fn with_core_on_main<T: Send + 'static>(
    _app: &AppHandle,
    _webviews: WebviewsMap,
    _label: &str,
    what: &str,
    _f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    Err(format!("{what}: requires the Windows WebView2 backend"))
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
    unsafe { env2.CreateCoreWebView2Controller(hwnd, &handler) }
        .map_err(|e| format!("CreateController invoke failed: {e}"))?;
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
                    std::thread::spawn(move || {
                        let mut waited = 0u64;
                        for target in [0u64, 150, 400, 900, 1800, 3500, 5000u64] {
                            if target > waited {
                                std::thread::sleep(std::time::Duration::from_millis(
                                    target - waited,
                                ));
                                waited = target;
                            }
                            let lbl = format!("browser-{pid}-tab-{tid}");
                            let js =
                                format!("{}{}", pushstate_injection_js(&pid, &tid), BRIDGE_OVERLAY_JS);
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

    let app_complete = app.clone();
    let label_complete = label.to_string();
    let complete_handler = NavigationCompletedEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
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
                if success.as_bool() {
                    let _ = app_complete.emit("browser:load-completed", label_complete.clone());
                }
            }
            Ok(())
        },
    ));
    let mut complete_token = 0i64;
    let _ = unsafe { core.add_NavigationCompleted(&complete_handler, &mut complete_token) };
}

/// JS snippet that monkey-patches history.pushState / replaceState to call
/// browser_push_state whenever the URL changes via same-document navigation.
/// This catches Bing's Images/Videos/Maps tab clicks, SPA route changes, etc.
/// — events WebView2's NavigationStarting does NOT fire for.
fn pushstate_injection_js(pane_id: &str, tab_id: &str) -> String {
    format!(
        r#"(function() {{
    if (window.__conduit_pushstate_patched) return;
    window.__conduit_pushstate_patched = true;
    var emit = function() {{
        try {{
            window.__TAURI_INTERNALS__.invoke('browser_push_state', {{
                paneId: '{pane}',
                tabId: '{tab}',
                url: location.href
            }}).catch(function() {{}});
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
        tab = tab_id
    )
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
    /// In-flight agentic actions: request id -> result sender. The action's
    /// injected JS calls back `browser_action_result` with the id, which
    /// resolves the matching oneshot so the async tool call can return.
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    next_req: AtomicU64,
    /// Maps pane_id -> project_id so the MCP WS dispatch (Task #4) can
    /// resolve a project_id to its browser panes.
    project_pane_registry: Mutex<HashMap<String /*pane_id*/, String /*project_id*/>>,
    /// Per-pane visibility state (updated by `set_visible`; default true on create).
    pane_visible: Mutex<HashMap<String /*pane_id*/, bool>>,
    /// Most-recently-created/navigated (pane_id, tab_id) per pane, so an explicit
    /// pane_id can resolve to the current active tab webview label.
    pane_active_tab: Mutex<HashMap<String /*pane_id*/, String /*tab_id*/>>,
    /// Pending resolve-pane roundtrip request id -> sender.
    pane_resolve_pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next_resolve_req: AtomicU64,
    /// Pending open-browser roundtrip request id -> sender.
    pane_open_pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next_open_req: AtomicU64,
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
            pane_active_tab: Mutex::new(HashMap::new()),
            pane_resolve_pending: Mutex::new(HashMap::new()),
            next_resolve_req: AtomicU64::new(1),
            pane_open_pending: Mutex::new(HashMap::new()),
            next_open_req: AtomicU64::new(1),
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
    pub fn create(&self, pane_id: &str, tab_id: &str, url: &str, rect: Rect) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        eprintln!("[conduit:browser] create pane={pane_id} tab={tab_id} label={label} url={url} rect={rect:?}");
        browser_log(&self.app, &format!("create pane={pane_id} tab={tab_id} label={label} url={url} rect={rect:?}"));

        // Guard against concurrent creates for the same label. React
        // StrictMode double-mounts in dev, so the frontend may send two
        // browser_create calls at once. The second call sees the in-flight
        // marker and returns immediately.
        {
            let mut inf = self.in_flight.lock();
            if inf.contains(&label) {
                eprintln!("[conduit:browser] create SKIP label={label} — already in-flight");
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
            eprintln!("[conduit:browser] ensure_supported FAILED: {e}");
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
                eprintln!("[conduit:browser] create replacing existing label={label} — closing old webview on main thread");
                self.run_main_thread_call(move || pane.close().map_err(|e| e.to_string()))
                    .map_err(|e| {
                        eprintln!("[conduit:browser] close(existing) FAILED: {e}");
                        e
                    })?;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }

        // Validate the target URL up front.
        let _parsed: tauri::Url = url
            .parse()
            .map_err(|e| {
                let msg = format!("invalid url `{url}`: {e}");
                eprintln!("[conduit:browser] url parse FAILED: {msg}");
                msg
            })?;
        let rect = sanitize(rect);

        // Build the webview (or webview window on Linux) on the main thread
        // then return the handle to the calling worker. The two paths
        // produce a `BrowserPane` whose API is uniform for the rest of
        // this module. See `build_pane_on_main_thread` for the platform
        // split.
        let pane = match self.build_pane_on_main_thread(pane_id, tab_id, url, rect) {
            Ok(p) => p,
            Err(e) => {
                browser_log(&self.app, &format!("create FAILED label={label}: {e}"));
                return Err(e);
            }
        };
        eprintln!("[conduit:browser] create OK for label={label}");

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
                eprintln!("[conduit:browser] Page.enable failed (non-fatal): {e}");
                browser_log(&self.app, &format!("Page.enable FAILED label={label}: {e}"));
            }
        }
        self.pane_visible.lock().insert(pane_id.to_string(), true);
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
            let data_dir = self
                .app
                .path()
                .app_data_dir()
                .map(|d| d.join("webview2"))
                .unwrap_or_else(|_| std::path::PathBuf::from("conduit-webview2"));

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
                    create_controller_async(app_log, h.0, &env, bounds, done_ctrl.clone(), move |controller| {
                        let core = unsafe { controller.CoreWebView2() }
                            .map_err(|e| format!("CoreWebView2 unavailable: {e}"))?;
                        // Document-start bridge (visual overlay primitives) —
                        // installed once per webview; every later document
                        // re-runs it automatically.
                        let overlay_h = HSTRING::from(BRIDGE_OVERLAY_JS);
                        let script_handler = webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(())));
                        unsafe { core.AddScriptToExecuteOnDocumentCreated(&overlay_h, &script_handler) }
                            .map_err(|e| format!("AddScriptToExecuteOnDocumentCreated failed: {e}"))?;
                        attach_core_listeners(&app2, self_webviews.clone(), &label2, &core);
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
                    eprintln!("[conduit:browser] get_window('main') FAILED: {msg} — known: {known:?}");
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
                .initialization_script(BRIDGE_OVERLAY_JS)
                .on_navigation(move |nav_url| {
                    eprintln!("[conduit:browser] navigation: {nav_url}");
                    browser_log(&app, &format!("wry on_navigation (nav START allowed) url={nav_url} label={label_for_nav}"));
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
                    std::thread::spawn(move || {
                        // B9: no more blind 1.5 s sleep. The injection is
                        // idempotent (guarded by
                        // `window.__conduit_pushstate_patched`), so inject on
                        // an escalating schedule: fast pages get the hook
                        // immediately, slow pages still get it within ~5 s,
                        // and each later eval no-ops once installed.
                        let mut waited = 0u64;
                        for target in [0u64, 150, 400, 900, 1800, 3500, 5000] {
                            if target > waited {
                                std::thread::sleep(std::time::Duration::from_millis(target - waited));
                                waited = target;
                            }
                            match app_ref.get_webview(&lbl) {
                                Some(w) => {
                                    let _ = w.eval(&pushstate_injection_js(&pid, &tid));
                                    // Belt-and-braces: the overlay is ALSO an
                                    // initialization script (installs at
                                    // document-start in every page), but keep
                                    // the eval here so panes created before a
                                    // bridge update and any document-start
                                    // race still get visuals. Idempotent.
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
                    eprintln!("[conduit:browser] new_window: {new_url} — navigating in-place");
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
                "[conduit:browser] add_child at ({},{}) {}x{} (main-thread scheduled)",
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
                        eprintln!("[conduit:browser] add_child PANICKED on main thread: {detail}");
                        Err(format!("browser webview creation panicked: {detail}"))
                    }
                };
                match &res {
                    Ok(_) => eprintln!("[conduit:browser] add_child OK on main thread for label={label_owned}"),
                    Err(msg) => eprintln!("[conduit:browser] add_child FAILED on main thread: {msg}"),
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
                    Ok(_) => eprintln!("[conduit:browser] WebviewWindow OK for label={label_for_win}"),
                    Err(msg) => eprintln!("[conduit:browser] WebviewWindow FAILED for label={label_for_win}: {msg}"),
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

    pub fn navigate(&self, app: &AppHandle, pane_id: &str, tab_id: &str, url: &str) -> Result<(), String> {
        let (pane, parsed) = match self.prepare_navigate(pane_id, tab_id, url) {
            Ok(v) => v,
            Err(e) => {
                browser_log(app, &format!("navigate REJECTED pane={pane_id} tab={tab_id} url={url}: {e}"));
                return Err(e);
            }
        };
        drop(pane);
        browser_log(app, &format!("navigate pane={pane_id} tab={tab_id} url={parsed}"));
        // Route through CoreWebView2.Navigate ON THE MAIN THREAD, against our
        // own controller (the tauri dispatcher's Webview messages are
        // silently dropped for these panes).
        let label = browser_label(pane_id, tab_id);
        let url2 = parsed.to_string();
        let result = with_core_on_main(app, self.webviews.clone(), &label, "navigate", move |core| {
            let url_h = windows::core::HSTRING::from(url2);
            unsafe { core.Navigate(&url_h) }.map_err(|e| format!("Navigate failed: {e}"))?;
            Ok(())
        });
        match &result {
            Ok(_) => browser_log(app, &format!("navigate INVOKE OK url={parsed} — waiting for nav START/COMPLETE")),
            Err(e) => browser_log(app, &format!("navigate INVOKE FAILED url={parsed}: {e}")),
        }
        result?;
        self.spawn_post_nav_inject(pane_id, tab_id);
        self.refocus_main_webview();
        Ok(())
    }

    /// Toggle the native DevTools window for a pane's webview (roadmap #15).
    /// Gives console + network + DOM inspection for agent debugging.
    pub fn open_devtools(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        ensure_supported()?;
        let label = browser_label(pane_id, tab_id);
        with_core_on_main(&self.app, self.webviews.clone(), &label, "open_devtools", move |core| {
            unsafe { core.OpenDevToolsWindow() };
            Ok(())
        })
    }

    /// Shared first half of `navigate`: validate the URL, mark the pane active
    /// and resolve the pane handle. Split out so `create` (an async worker)
    /// can dispatch the controller `navigate` call itself on the main thread.
    fn prepare_navigate(
        &self,
        pane_id: &str,
        tab_id: &str,
        url: &str,
    ) -> Result<(BrowserPane, tauri::Url), String> {
        ensure_supported()?;
        let parsed: tauri::Url = url
            .parse()
            .map_err(|e| format!("invalid url `{url}`: {e}"))?;
        *self.active.lock() = Some((pane_id.to_string(), tab_id.to_string()));
        self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());
        let label = browser_label(pane_id, tab_id);
        let pane = self.get(&label)?;
        Ok((pane, parsed))
    }

    /// Shared second half of `navigate`: inject the pushState monkey-patch
    /// after a delay so the new page's DOM has loaded. The eval fires on
    /// whatever document is current.
    fn spawn_post_nav_inject(&self, pane_id: &str, tab_id: &str) {
        let pid = pane_id.to_string();
        let tid = tab_id.to_string();
        let label = browser_label(pane_id, tab_id);
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Some(w) = app.get_webview(&label) {
                let _ = w.eval(&pushstate_injection_js(&pid, &tid));
                // Re-inject the visual-feedback overlay after navigation — a
                // fresh page load clears injected DOM, so the cursor/highlight
                // primitives must be re-installed (Task #7). Idempotent on the
                // JS side: a no-op if already present.
                let _ = w.eval(BRIDGE_OVERLAY_JS);
            }
        });
    }

    /// Back/forward/reload drive the webview's REAL history via JS eval —
    /// the resulting URL comes back through the `browser:navigated` event.
    pub fn go_back(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        self.eval(&label, "history.back()")
    }

    pub fn go_forward(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        self.eval(&label, "history.forward()")
    }

    pub fn reload(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        self.eval(&label, "location.reload()")
    }

    pub fn set_bounds(&self, pane_id: &str, tab_id: &str, rect: Rect) -> Result<(), String> {
        ensure_supported()?;
        let rect = sanitize(rect);
        // Zero/degenerate rects make the pane INVISIBLE (black area under the
        // app UI) while every navigation actually succeeds — log the rect so
        // "stuck loading" reports can be told apart from "never painted".
        browser_log(&self.app, &format!("set_bounds pane={pane_id} tab={tab_id} rect={rect:?}"));
        let label = browser_label(pane_id, tab_id);
        let pane = self
            .webviews
            .lock()
            .get(&label)
            .cloned()
            .ok_or_else(|| format!("no browser webview with label {label}"))?;
        // On Windows/macOS the webview's coords are viewport-relative (the
        // child floats above the DOM). On Linux the standalone window
        // needs absolute screen coords — we convert here by adding the
        // main window's current outer position. If we can't read it, fall
        // back to passing the rect as-is (Tauri will clamp/position based
        // on the parent context).
        #[cfg(target_os = "linux")]
        let (final_x, final_y) = match self.app.get_window("main").and_then(|m| m.outer_position().ok()) {
            Some(pos) => (pos.x as f64 + rect.x, pos.y as f64 + rect.y),
            None => (rect.x, rect.y),
        };
        #[cfg(not(target_os = "linux"))]
        {
            // Bounds must apply ON the main thread against OUR controller
            // (tauri's set_bounds message is dropped for these panes).
            let scale = self
                .app
                .get_window("main")
                .and_then(|w| w.scale_factor().ok())
                .unwrap_or(1.0);
            let pane2 = pane;
            self.run_main_thread_call(move || {
                pane2.set_bounds_physical(
                    (rect.x * scale) as i32,
                    (rect.y * scale) as i32,
                    (rect.width * scale) as i32,
                    (rect.height * scale) as i32,
                )
            })
        }
        #[cfg(target_os = "linux")]
        {
            let pane2 = pane;
            self.run_main_thread_call(move || {
                pane2.set_position_size(
                    LogicalPosition::new(final_x, final_y),
                    LogicalSize::new(rect.width, rect.height),
                )
            })
        }
    }

    /// Occlusion control: native webviews float above the DOM, so overlays
    /// (settings views, palette, peek panel, modals) and hidden split-mode
    /// panes must hide their webview explicitly.
    pub fn set_visible(&self, pane_id: &str, tab_id: &str, visible: bool) -> Result<(), String> {
        ensure_supported()?;
        self.pane_visible.lock().insert(pane_id.to_string(), visible);
        let label = browser_label(pane_id, tab_id);
        let pane = self
            .webviews
            .lock()
            .get(&label)
            .cloned()
            .ok_or_else(|| format!("no browser webview with label {label}"))?;
        // show/hide drive the controller's IsVisible — a dispatcher message
        // that rides the proxy from a worker and can be silently dropped
        // (pane stays invisible = black). Apply ON the main thread where it
        // executes inline.
        let pane2 = pane;
        let out = self.run_main_thread_call(move || {
            let res = if visible { pane2.show() } else { pane2.hide() };
            res.map_err(|e| e.to_string())
        });
        let outcome = match &out {
            Ok(_) => "ok".to_string(),
            Err(e) => e.clone(),
        };
        browser_log(
            &self.app,
            &format!("set_visible pane={pane_id} tab={tab_id} visible={visible} -> {outcome}"),
        );
        if visible && out.is_ok() {
            // Showing the pane lets the WebView2 child grab keyboard focus —
            // hand it back to the main webview so the composer keeps typing.
            self.refocus_main_webview();
        }
        out
    }

    /// Idempotent close — closing an unknown tab is a no-op (the frontend
    /// calls this both on unmount and from closePane).
    pub fn close(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        self.in_flight.lock().remove(&label);
        let pane = self.webviews.lock().remove(&label);
        if let Some(pane) = pane {
            pane.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Close ALL tab webviews for a given pane (used when the entire pane is
    /// closed). Iterates the HashMap and removes every entry whose label
    /// starts with `browser-{pane_id}-tab-`.
    pub fn close_pane_tabs(&self, pane_id: &str) -> Result<(), String> {
        let prefix = format!("browser-{pane_id}-tab-");
        let labels: Vec<String> = self
            .webviews
            .lock()
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for label in &labels {
            self.in_flight.lock().remove(label);
            if let Some(pane) = self.webviews.lock().remove(label) {
                // controller.Close() destroys the native child window — run
                // it on the main thread (COM affinity). A dropped/dispatched
                // close left the invisible webview floating over the UI as a
                // click-blocking ghost block.
                let _ = self.run_main_thread_call(move || pane.close());
            }
        }
        // Clean up per-pane registries on close.
        self.project_pane_registry.lock().remove(pane_id);
        self.pane_visible.lock().remove(pane_id);
        self.pane_active_tab.lock().remove(pane_id);
        Ok(())
    }

    /// App-exit cleanup, wired next to PtyManager::kill_all in lib.rs.
    pub fn close_all(&self) {
        self.in_flight.lock().clear();
        let panes: Vec<BrowserPane> = self.webviews.lock().drain().map(|(_, p)| p).collect();
        for pane in panes {
            let _ = self.run_main_thread_call(move || pane.close());
        }
    }

    fn eval(&self, label: &str, js: &str) -> Result<(), String> {
        ensure_supported()?;
        let js = js.to_string();
        with_core_on_main(&self.app, self.webviews.clone(), label, "eval", move |core| {
            use webview2_com::ExecuteScriptCompletedHandler;
            let js_h = windows::core::HSTRING::from(js);
            let handler = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
            unsafe { core.ExecuteScript(&js_h, &handler) }
                .map_err(|e| format!("ExecuteScript failed: {e}"))?;
            Ok(())
        })
    }

    // --- Agentic browser control ---------------------------------------
    // The chat's `browser_*` tools drive whatever page is active. Because
    // `webview.eval` is fire-and-forget, each action's JS reports its result
    // back by invoking the `browser_action_result` command with a request id;
    // `resolve_action` (below) matches it to the pending oneshot.

    /// Resolve a pending agentic action (called by the `browser_action_result`
    /// command from the injected JS). Unknown ids are ignored (already timed
    /// out or resolved).
    pub fn resolve_action(&self, req_id: u64, result: String) {
        if let Some(tx) = self.pending.lock().remove(&req_id) {
            let _ = tx.send(result);
        }
    }

    fn active_label(&self) -> Result<String, String> {
        match self.active.lock().as_ref() {
            Some((p, t)) => Ok(browser_label(p, t)),
            None => Err("No page is open in the browser pane yet — call open_url first.".to_string()),
        }
    }

    /// Eval a JS action body (an IIFE-able block that `return`s a string) in the
    /// active page and await the string it reports back. Times out so a stuck
    /// or navigating page can't wedge the chat turn.
    async fn run_action(&self, body: &str) -> Result<String, String> {
        let label = self.active_label()?;
        self.run_action_for_pane(&label, body).await
    }

    /// Same as `run_action` but targets an explicit webview label instead of
    /// resolving the global active pane. Used by the MCP dispatch (Task #4) and
    /// `read_page_for_pane`. Delegates to `run_action_for_pane_opts` with
    /// defaults (no pacing).
    pub async fn run_action_for_pane(&self, label: &str, body: &str) -> Result<String, String> {
        self.run_action_for_pane_opts(label, body, ActionOpts::default()).await
    }

    /// Same as `run_action_for_pane` but accepts `ActionOpts` for watch-mode
    /// pacing. When opts.watch_mode is true a ~PANE_DELAY_MS delay is applied
    /// after the JS body resolves and before the result is reported.
    pub async fn run_action_for_pane_opts(
        &self,
        label: &str,
        body: &str,
        opts: ActionOpts,
    ) -> Result<String, String> {
        ensure_supported()?;
        let pane = self.get(label)?;
        let req_id = self.next_req.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<String>();
        self.pending.lock().insert(req_id, tx);
        let js = action_wrapper_js(req_id, body, &opts);
        let eval_res = {
            let js = js.clone();
            with_core_on_main(
                &self.app,
                self.webviews.clone(),
                label,
                "action eval",
                move |core| {
                    use webview2_com::ExecuteScriptCompletedHandler;
                    let js_h = windows::core::HSTRING::from(js);
                    let handler = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                    unsafe { core.ExecuteScript(&js_h, &handler) }
                        .map_err(|e| format!("ExecuteScript failed: {e}"))?;
                    Ok(())
                },
            )
        };
        if let Err(e) = eval_res {
            self.pending.lock().remove(&req_id);
            return Err(e);
        }
        drop(pane);
        match tokio::time::timeout(Duration::from_secs(45), rx).await {
            Ok(Ok(s)) => Ok(s),
            Ok(Err(_)) => Err("browser action channel closed".to_string()),
            Err(_) => {
                self.pending.lock().remove(&req_id);
                Err("browser action timed out — the page may still be loading.".to_string())
            }
        }
    }

    /// Capture the page currently shown in a pane's webview as PNG bytes.
    /// Backs the `browser_screenshot` tool so the agent can show the user
    /// exactly what the page looks like. Blocking (up to a 15 s roundtrip) —
    /// call inside `tokio::task::spawn_blocking` from async contexts.
    ///
    /// Windows: WebView2 `CapturePreview` on the pane's child webview. The
    /// WebView2 API is UI-thread-affine, so the call is marshalled onto the
    /// main thread; `wait_for_async_operation` pumps the message loop while
    /// it waits, so the UI stays alive during the capture. Returns `None` on
    /// failure and on platforms without a capture path (Linux/macOS today).
    pub fn capture_pane_png(&self, label: &str) -> Option<Vec<u8>> {
        // The COM CapturePreview path captured from the calling thread via a
        // with_webview that was silently dropped for freshly-created panes.
        // The CDP screenshot path now routes through with_core_on_main
        // (run_on_main_thread marshaling) and works from any thread.
        self.capture_pane_png_via_cdp(label)
    }

    /// Capture the active chat-mode page (same as `capture_pane_png` but
    /// resolves the global active pane first, like `run_action`).
    pub fn capture_active_png(&self) -> Option<Vec<u8>> {
        let label = self.active_label().ok()?;
        self.capture_pane_png(&label)
    }

    /// Call a Chrome DevTools Protocol method on the pane's WebView2 and
    /// return the raw JSON result object. This is the entry point of the CDP
    /// execution layer — Phase 1 wires `Page.captureScreenshot` (below) and
    /// `Page.enable`; later phases move the eval-bridge primitives (a11y
    /// tree extraction, input events, network-idle waits) onto CDP as well.
    /// Runs the COM roundtrip on the main thread with the message loop
    /// pumped (same pattern as `capture_pane_png`), so the UI stays alive.
    #[cfg(windows)]
    pub fn call_devtools_protocol(
        &self,
        label: &str,
        method: &str,
        params_json: &str,
    ) -> Result<String, String> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;

        let method_h = HSTRING::from(method);
        let params_h = HSTRING::from(params_json);
        let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<String, String>>();
        // Invoke on the main thread via run_on_main_thread + with_webview
        // (worker-dispatched with_webview messages were silently dropped).
        // The completed handler delivers the result JSON through its own
        // channel; the CALLING thread waits on it — so this must be called
        // from a worker (Page.enable on the create path uses the no-wait
        // page_enable variant instead).
        with_core_on_main(&self.app, self.webviews.clone(), label, "cdp invoke", move |core| {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |hr: windows::core::Result<()>, json: String| {
                    let _ = result_tx.send(hr.map(|_| json).map_err(|e| e.to_string()));
                    Ok(())
                },
            ));
            unsafe { core.CallDevToolsProtocolMethod(&method_h, &params_h, &handler) }
                .map_err(|e| format!("CallDevToolsProtocolMethod failed: {e}"))?;
            Ok(())
        })?;
        match result_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(result) => result,
            // Disconnected = webview destroyed before completion.
            Err(_) => Err("cdp call never completed (webview gone?)".to_string()),
        }
    }

    #[cfg(not(windows))]
    pub fn call_devtools_protocol(
        &self,
        _label: &str,
        _method: &str,
        _params_json: &str,
    ) -> Result<String, String> {
        Err("CDP execution layer requires the Windows WebView2 backend".to_string())
    }

    /// Capture the pane as PNG via CDP `Page.captureScreenshot` — the CDP
    /// path renders through the compositor (works where the COM
    /// `CapturePreview` stream roundtrip intermittently returns an empty
    /// frame) and decodes the base64 payload straight out of the JSON.
    pub fn capture_pane_png_via_cdp(&self, label: &str) -> Option<Vec<u8>> {
        #[cfg(windows)]
        {
            let json = self
                .call_devtools_protocol(label, "Page.captureScreenshot", r#"{"format":"png"}"#)
                .ok()?;
            let v: serde_json::Value = serde_json::from_str(&json).ok()?;
            let b64 = v.get("data")?.as_str()?;
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(b64).ok()
        }
        #[cfg(not(windows))]
        {
            let _ = label;
            None
        }
    }

    /// CDP-first capture with the COM CapturePreview path as fallback — the
    /// screenshot callers use this so a CDP failure degrades instead of
    /// breaking the tool.
    pub fn capture_active_png_via_cdp(&self) -> Option<Vec<u8>> {
        let label = self.active_label().ok()?;
        match self.capture_pane_png_via_cdp(&label) {
            Some(png) if !png.is_empty() => Some(png),
            _ => {
                eprintln!("[conduit:browser] CDP screenshot empty — falling back to CapturePreview");
                self.capture_pane_png(&label)
            }
        }
    }

    /// Read the active page with structured readability-style extraction.
    ///
    /// The orchestrator does three phases:
    /// 1. Inject the vendored readability.js + our bridge wrapper (consent-banner
    ///    dismissal, element tagging, Readability parse, HTML-to-Markdown) in a
    ///    single eval and await the structured JSON result.
    /// 2. If the extracted markdown is suspiciously short relative to the page's
    ///    scrollHeight, run a bounded scroll-down loop (up to `opts.max_scroll_steps`
    ///    steps, ~350ms between each) to surface lazy-loaded content, then
    ///    re-extract.
    /// 3. Serialize the `ExtractedContent` as pretty-printed JSON, capped at 50k
    ///    chars of markdown, and return it as the tool result string.
    pub async fn read_page(
        &self,
        mode: ReadMode,
        selector: Option<&str>,
    ) -> Result<String, String> {
        let label = self.active_label()?;
        self.read_page_for_pane(&label, mode, selector).await
    }

    /// Same orchestration as `read_page` but targets an explicit webview label.
    /// Used by the MCP dispatch (Task #4) to extract content from a specific
    /// browser pane identified by its project/pane.
    pub async fn read_page_for_pane(
        &self,
        label: &str,
        mode: ReadMode,
        selector: Option<&str>,
    ) -> Result<String, String> {
        let body = build_extract_js(&mode, selector);
        let opts = ReadOpts::default();

        // Phase 1: initial extraction with a settle wait for JS-rendered content.
        // The settle is done via a sleep BEFORE the first eval so the page's
        // on-load renderers have time to finish — this is a cheap heuristic that
        // catches the common SPA loading-skeleton case.
        if opts.settle_ms > 0 {
            tokio::time::sleep(Duration::from_millis(opts.settle_ms as u64)).await;
        }

        let first_json = self.run_action_for_pane(label, &body).await?;
        let mut content: ExtractedContent = serde_json::from_str(&first_json).map_err(|e| {
            // Surface the raw bridge output (truncated) so a JS-side throw or
            // a non-JSON return is diagnosable instead of an opaque parse error.
            // Char-safe: page content is almost always non-ASCII.
            let raw = crate::util::truncate_chars(&first_json, 400);
            format!("browser_read: failed to parse extraction result: {e} (raw: {raw:?})")
        })?;

        // Phase 2: bounded scroll loop for lazy-loaded content.
        // We check if the page scrollHeight is much larger than what we got
        // (signalling below-the-fold lazy content), and scroll down a capped
        // number of times, re-extracting after each scroll. Stop early if the
        // scrollHeight stops growing (infinite feed guard).
        if matches!(mode, ReadMode::Full) && content.failure_reason.is_none() {
            // Ask the page for its scrollHeight and viewport height.
            let dims_js = r#"
var h = document.body ? document.body.scrollHeight : 0;
var vh = window.innerHeight || 0;
return JSON.stringify({scrollHeight: h, viewportHeight: vh});
"#;
            if let Ok(dims_str) = self.run_action_for_pane(label, dims_js).await {
                if let Ok(dims) = serde_json::from_str::<serde_json::Value>(&dims_str) {
                    let scroll_height = dims["scrollHeight"].as_f64().unwrap_or(0.0) as i64;
                    let viewport = dims["viewportHeight"].as_f64().unwrap_or(600.0) as i64;
                    let markdown_len = content.markdown.len() as i64;
                    // If the page is tall but we got little content, it may have
                    // lazy-loaded sections. Threshold: scrollHeight > 2x viewport
                    // AND extracted content < 2000 chars.
                    if scroll_height > viewport * 2 && markdown_len < 2000 {
                        eprintln!(
                            "[conduit:browser] lazy-load scroll loop: scrollHeight={scroll_height} \
                             viewport={viewport} markdownLen={markdown_len}"
                        );
                        let mut prev_scroll_height = scroll_height;
                        let scroll_step = (viewport as f64 * 0.8) as i64; // 80% viewport per step
                        for step in 0..opts.max_scroll_steps {
                            let scroll_js_body = format!(
                                "window.scrollBy(0, {}); return JSON.stringify({{scrollY: Math.round(window.scrollY), scrollHeight: document.body ? Math.round(document.body.scrollHeight) : 0}});",
                                scroll_step
                            );
                            let _ = self.run_action_for_pane(label, &scroll_js_body).await;
                            tokio::time::sleep(Duration::from_millis(350)).await;

                            // Re-extract
                            if let Ok(re_json) = self.run_action_for_pane(label, &body).await {
                                if let Ok(re_content) = serde_json::from_str::<serde_json::Value>(&re_json) {
                                    let new_md = re_content["markdown"].as_str().unwrap_or("");
                                    let new_len = new_md.len();
                                    // Short-circuit: content didn't grow meaningfully
                                    if new_len <= content.markdown.len() + 100 {
                                        eprintln!(
                                            "[conduit:browser] lazy-load scroll stop: no content growth at step {step}"
                                        );
                                        break;
                                    }
                                    if let Ok(updated) = serde_json::from_str::<ExtractedContent>(&re_json) {
                                        content = updated;
                                    }
                                }
                            }

                            // Check scrollHeight growth
                            let check_js = r#"return JSON.stringify({scrollHeight: document.body ? Math.round(document.body.scrollHeight) : 0});"#;
                            if let Ok(check_str) = self.run_action_for_pane(label, check_js).await {
                                if let Ok(check) = serde_json::from_str::<serde_json::Value>(&check_str) {
                                    let new_sh = check["scrollHeight"].as_f64().unwrap_or(0.0) as i64;
                                    if new_sh <= prev_scroll_height {
                                        eprintln!(
                                            "[conduit:browser] lazy-load scroll stop: scrollHeight stable at {new_sh}"
                                        );
                                        break;
                                    }
                                    prev_scroll_height = new_sh;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Phase 3: serialize as pretty JSON with a cap on markdown length.
        const MAX_MD: usize = 50_000;
        if content.markdown.len() > MAX_MD {
            let mut cut = MAX_MD;
            while !content.markdown.is_char_boundary(cut) {
                cut -= 1;
            }
            content.markdown.truncate(cut);
            content.markdown.push_str("\n\n[...truncated]");
        }
        let json = serde_json::to_string_pretty(&content)
            .map_err(|e| format!("browser_read: serialization failed: {e}"))?;
        Ok(format!("EXTRACTED CONTENT (mode={}):\n```json\n{}\n```", content.mode, json))
    }

    // --- Pane registry + MCP roundtrip helpers ---------------------------
    // The MCP WebSocket server (Task #4) needs to target a specific browser
    // pane by pane_id, or resolve a project_id to the best pane via a
    // frontend roundtrip. These methods wire that resolution path.

    /// True if the pane is currently visible (set via `set_visible`; defaults
    /// to true on create). Backgrounded panes skip watch-mode pacing.
    pub fn pane_is_visible(&self, pane_id: &str) -> bool {
        self.pane_visible.lock().get(pane_id).copied().unwrap_or(true)
    }

    /// Register a browser pane's project association (called by the frontend
    /// after creating a browser pane).
    pub fn register_browser_pane_project(&self, pane_id: &str, project_id: &str) {
        self.project_pane_registry.lock().insert(pane_id.to_string(), project_id.to_string());
    }

    /// Remove a pane from the registry + visibility + active-tab maps (called
    /// when a pane is closed).
    pub fn unregister_browser_pane_project(&self, pane_id: &str) {
        self.project_pane_registry.lock().remove(pane_id);
        self.pane_visible.lock().remove(pane_id);
        self.pane_active_tab.lock().remove(pane_id);
    }

    /// Emit a `browser:resolve-pane-request` event to the frontend, asking it
    /// to pick the best browser pane for `project_id`. Returns a req_id the
    /// caller awaits via `resolve_pane_request_resolve`.
    pub fn resolve_pane_request_emit(&self, project_id: &str) -> u64 {
        let req_id = self.next_resolve_req.fetch_add(1, Ordering::SeqCst);
        let (tx, _rx) = oneshot::channel::<Option<String>>();
        self.pane_resolve_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({ "reqId": req_id, "projectId": project_id });
        let _ = self.app.emit("browser:resolve-pane-request", payload);
        req_id
    }

    /// Receive the frontend's answer for a resolve-pane request.
    pub fn resolve_pane_request_resolve(&self, req_id: u64, pane_id: Option<String>) {
        if let Some(tx) = self.pane_resolve_pending.lock().remove(&req_id) {
            let _ = tx.send(pane_id);
        }
    }

    /// Emit a `browser:open-browser-request` event asking the frontend to
    /// create (or reveal) a browser pane for `project_id` pointed at `url`.
    /// Returns a req_id the caller awaits via `open_pane_request_resolve`.
    pub fn open_pane_request_emit(&self, project_id: &str, url: &str) -> u64 {
        let req_id = self.next_open_req.fetch_add(1, Ordering::SeqCst);
        let (tx, _rx) = oneshot::channel::<Option<String>>();
        self.pane_open_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({ "reqId": req_id, "projectId": project_id, "url": url });
        let _ = self.app.emit("browser:open-browser-request", payload);
        req_id
    }

    /// Receive the frontend's answer for an open-browser request.
    pub fn open_pane_request_resolve(&self, req_id: u64, pane_id: Option<String>) {
        if let Some(tx) = self.pane_open_pending.lock().remove(&req_id) {
            let _ = tx.send(pane_id);
        }
    }

    /// High-level helper used by the MCP WS dispatch (Task #4) to resolve a
    /// `pane_id` and/or `project_id` into a concrete webview label. The label
    /// can then be passed to `run_action_for_pane` / `read_page_for_pane`.
    ///
    /// Resolution order:
    /// 1. `explicit_pane_id` -> look up its active tab from `pane_active_tab`.
    /// 2. `project_id` -> ask the frontend for the best pane (roundtrip, 5s
    ///    timeout), then resolve its tab. Falls back to global active if the
    ///    roundtrip times out.
    /// 3. Neither -> global `active_label()`.
    pub async fn resolve_pane_label(
        &self,
        project_id: Option<&str>,
        explicit_pane_id: Option<&str>,
    ) -> Result<String, String> {
        // Case 1: explicit pane_id — look up its active tab.
        if let Some(pid) = explicit_pane_id {
            let tab = self
                .pane_active_tab
                .lock()
                .get(pid)
                .cloned()
                .ok_or_else(|| format!("no active tab for pane {pid}"))?;
            return Ok(browser_label(pid, &tab));
        }

        // Case 2: project_id — roundtrip through the frontend.
        if let Some(pid) = project_id {
            // Create our own channel for this async resolution. The emit
            // method creates its own sender (for the resolve command path),
            // but here we need to await the receiver directly.
            let req_id = self.next_resolve_req.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel::<Option<String>>();
            self.pane_resolve_pending.lock().insert(req_id, tx);
            let payload = serde_json::json!({ "reqId": req_id, "projectId": pid });
            let _ = self.app.emit("browser:resolve-pane-request", payload);

            match tokio::time::timeout(Duration::from_secs(5), rx).await {
                Ok(Ok(Some(best_pane_id))) => {
                    let tab = self
                        .pane_active_tab
                        .lock()
                        .get(&best_pane_id)
                        .cloned()
                        .ok_or_else(|| {
                            format!("no active tab for resolved pane {best_pane_id}")
                        })?;
                    return Ok(browser_label(&best_pane_id, &tab));
                }
                Ok(Ok(None)) => {
                    // No pane exists for this project — caller should auto-open.
                    return Err("pane_not_found".to_string());
                }
                Ok(Err(_)) | Err(_) => {
                    // Channel closed or timeout — fall through to global active.
                }
            }
            // Fallback: try the global active pane.
            return self.active_label();
        }

        // Case 3: neither — use the global active pane.
        self.active_label()
    }

    /// Convenience helper: ask the frontend to open a new browser pane for
    /// `project_id` pointed at `url`, wait for the pane to be created (5s
    /// timeout), and return the new pane's webview label. Used by the MCP WS
    /// dispatch (Task #4) for auto-open on navigate when no pane exists.
    pub async fn open_pane_for_project(
        &self,
        project_id: &str,
        url: &str,
    ) -> Result<String, String> {
        let req_id = self.next_open_req.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<Option<String>>();
        self.pane_open_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({ "reqId": req_id, "projectId": project_id, "url": url });
        let _ = self.app.emit("browser:open-browser-request", payload);

        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(Some(new_pane_id))) => {
                // The frontend created the pane and returned its id, but the
                // native webview (`browser_create` → `create()`) may still be
                // initializing async on the main thread — `pane_active_tab` /
                // `webviews` aren't populated until `create()` finishes. Poll
                // for the predictable default-tab label to appear in the
                // webviews map (create() inserts it last), up to ~3s, rather
                // than relying on a fixed sleep that races the webview init.
                let label = browser_label(&new_pane_id, "default");
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                loop {
                    if self.webviews.lock().contains_key(&label) {
                        return Ok(label);
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(format!(
                            "open_pane_for_project: pane {new_pane_id} webview did not register within 3s"
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            Ok(Ok(None)) => Err("open_pane_for_project: frontend returned null pane_id".to_string()),
            Ok(Err(_)) => Err("open_pane_for_project: channel closed".to_string()),
            Err(_) => Err("open_pane_for_project: timed out waiting for pane creation".to_string()),
        }
    }

    pub async fn click_ref(&self, r: i64) -> Result<String, String> {
        self.run_action(&click_js(r)).await
    }

    pub async fn type_into(&self, r: i64, text: &str) -> Result<String, String> {
        self.run_action(&type_js(r, text)).await
    }

    pub async fn scroll_by(&self, dy: i64) -> Result<String, String> {
        self.run_action(&scroll_js(dy)).await
    }

    /// Hover the element tagged with `data-conduit-ref="{r}"` in the active
    /// pane. Dispatches real mouseover/mouseenter events so React/Vue hover
    /// handlers and CSS `:hover` activate. Backs the new `hover` MCP tool.
    pub async fn hover_ref(&self, r: i64) -> Result<String, String> {
        self.run_action(&hover_js(r)).await
    }

    /// Same as `hover_ref` but targets an explicit pane label.
    pub async fn hover_ref_for_pane(&self, label: &str, r: i64) -> Result<String, String> {
        self.run_action_for_pane(label, &hover_js(r)).await
    }

    /// Drive the webview's real history back/forward. Unlike the existing
    /// `go_back`/`go_forward` (fire-and-forget `eval`), this uses the awaited
    /// `run_action_for_pane` bridge so the tool result carries whether the
    /// navigation occurred and the post-nav URL. `direction` is "back" |
    /// "forward". Backs the new `back`/`forward` MCP tools.
    pub async fn history_for_pane(
        &self,
        label: &str,
        direction: &str,
    ) -> Result<String, String> {
        let dir = if direction == "forward" { "forward" } else { "back" };
        self.run_action_for_pane(label, &history_js(dir)).await
    }

    /// Evaluate arbitrary JS in the pane and return a JSON-serialized result.
    /// Used by the new `evaluate` MCP tool. Runs in the pane's own origin.
    pub async fn evaluate_for_pane(
        &self,
        label: &str,
        expression: &str,
    ) -> Result<String, String> {
        self.run_action_for_pane(label, &evaluate_js(expression)).await
    }

    fn get(&self, label: &str) -> Result<BrowserPane, String> {
        self.webviews
            .lock()
            .get(label)
            .cloned()
            .ok_or_else(|| format!("no browser webview with label {label}"))
    }

    // --- Agent-driven description resolution (Task #5) ---------------------
    // These resolve a `selector_or_description` string to a concrete element
    // via bridge_resolve.js, then act on it. Used by the MCP WS dispatch
    // (browser_mcp::op_click / op_type_text). The click/type bodies are the
    // sync versions from click_js/type_js for now; Task #2 swaps in the
    // animated Promise-returning overlays on top of the same resolution.

    /// Resolve `desc` to an element ref in the pane labelled `label`. Returns
    /// the raw JSON the bridge emits: `{"ok":true,"ref":..,...}` or
    /// `{"ok":false,"error":"not_found","suggestions":[...]}`.
    pub async fn resolve_element(&self, label: &str, desc: &str, action: &str) -> Result<String, String> {
        let body = build_resolve_js(desc, action);
        self.run_action_for_pane(label, &body).await
    }

    /// Resolve + click. Returns the bridge JSON (ok or not_found with
    /// suggestions) when resolution succeeds/fails; the click result string is
    /// folded into the ok payload's `result` field so the caller can surface
    /// both.
    pub async fn resolve_and_click(&self, label: &str, desc: &str) -> Result<String, String> {
        self.resolve_and_click_opts(label, desc, &ActionOpts::default()).await
    }

    /// Resolve + click with pacing opts. Same shape as resolve_and_click.
    pub async fn resolve_and_click_opts(&self, label: &str, desc: &str, opts: &ActionOpts) -> Result<String, String> {
        let resolved = self.resolve_element(label, desc, "click").await?;
        let v: serde_json::Value = serde_json::from_str(&resolved)
            .map_err(|e| format!("resolve_and_click: bad resolution json: {e}"))?;
        if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
            let r = v.get("ref").and_then(|x| x.as_i64()).unwrap_or(-1);
            let click_result = self.run_action_for_pane_opts(label, &click_js(r), opts.clone()).await?;
            // mi13: build with json! — one serializer pass instead of three
            // format!-embedded to_string calls.
            Ok(serde_json::json!({
                "ok": true,
                "clicked": {
                    "ref": r,
                    "tag": v.get("tag").and_then(|x| x.as_str()).unwrap_or(""),
                    "label": v.get("label").and_then(|x| x.as_str()).unwrap_or(""),
                },
                "result": click_result,
            }).to_string())
        } else {
            Ok(resolved)
        }
    }

    /// Resolve + type. Same shape as resolve_and_click.
    pub async fn resolve_and_type(&self, label: &str, desc: &str, text: &str) -> Result<String, String> {
        self.resolve_and_type_opts(label, desc, text, &ActionOpts::default()).await
    }

    /// Resolve + type with pacing opts. Same shape as resolve_and_type.
    pub async fn resolve_and_type_opts(&self, label: &str, desc: &str, text: &str, opts: &ActionOpts) -> Result<String, String> {
        let resolved = self.resolve_element(label, desc, "type").await?;
        let v: serde_json::Value = serde_json::from_str(&resolved)
            .map_err(|e| format!("resolve_and_type: bad resolution json: {e}"))?;
        if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
            let r = v.get("ref").and_then(|x| x.as_i64()).unwrap_or(-1);
            let type_result = self.run_action_for_pane_opts(label, &type_js(r, text), opts.clone()).await?;
            Ok(serde_json::json!({
                "ok": true,
                "typed": {
                    "ref": r,
                    "tag": v.get("tag").and_then(|x| x.as_str()).unwrap_or(""),
                    "label": v.get("label").and_then(|x| x.as_str()).unwrap_or(""),
                },
                "result": type_result,
            }).to_string())
        } else {
            Ok(resolved)
        }
    }

    /// Resolve + hover with pacing opts. Same shape as resolve_and_click but
    /// dispatches a hover sequence instead of a click — backs the `hover` MCP
    /// tool when the agent passes a description rather than a bare ref.
    pub async fn resolve_and_hover_opts(
        &self,
        label: &str,
        desc: &str,
        opts: &ActionOpts,
    ) -> Result<String, String> {
        // ACTION="click" is fine for resolution scoring — hover targets the
        // same interactive set and we don't penalize non-inputs the way type
        // does. We just swap the action body to hover_js.
        let resolved = self.resolve_element(label, desc, "click").await?;
        let v: serde_json::Value = serde_json::from_str(&resolved)
            .map_err(|e| format!("resolve_and_hover: bad resolution json: {e}"))?;
        if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
            let r = v.get("ref").and_then(|x| x.as_i64()).unwrap_or(-1);
            let hover_result = self
                .run_action_for_pane_opts(label, &hover_js(r), opts.clone())
                .await?;
            Ok(serde_json::json!({
                "ok": true,
                "hovered": {
                    "ref": r,
                    "tag": v.get("tag").and_then(|x| x.as_str()).unwrap_or(""),
                    "label": v.get("label").and_then(|x| x.as_str()).unwrap_or(""),
                },
                "result": hover_result,
            }).to_string())
        } else {
            Ok(resolved)
        }
    }
}

/// Build the description-resolution JS body for `run_action_for_pane`. The
/// bridge reads `DESC` (the selector/description) and `ACTION` ("click" |
/// "type") as interpolated literals — JSON-escaped so special characters in a
/// CSS selector or a label can't break out of the string. Returns the bridge's
/// JSON: `{"ok":true,"ref":..,"tag":..,"label":..,"matchType":..,"confidence":..}`
/// or `{"ok":false,"error":"not_found","desc":..,"suggestions":[..]}`.
fn build_resolve_js(desc: &str, action: &str) -> String {
    let desc_js = serde_json::to_string(desc).unwrap_or_else(|_| "\"\"".to_string());
    let action_js = serde_json::to_string(action).unwrap_or_else(|_| "\"click\"".to_string());
    BRIDGE_RESOLVE_JS
        .replace("DESC_PLACEHOLDER", &desc_js)
        .replace("ACTION_PLACEHOLDER", &action_js)
}

/// Wrap an agentic action `body` (a JS block that `return`s a string OR a
/// Promise that resolves to a string) so it runs in the page and reports its
/// result — or an error message — back to the backend via the
/// `browser_action_result` command keyed by `req_id`.
///
/// The wrapper is promise-aware: if the body returns a thenable, the wrapper
/// awaits it before reporting. This lets the visual-feedback layer (Task 2)
/// run an async sequence (cursor tween → highlight → real click → pacing)
/// and only report once the whole chain resolves — the race guard that keeps
/// a tool result from being read before the on-screen action completes.
/// Synchronous bodies (the existing `click_js`/`type_js`/`scroll_js`) keep
/// working unchanged: their non-thenable return is reported immediately.
///
/// When `WATCH_MODE` is true the wrapper applies a `PANE_DELAY_MS` pacing
/// delay via setTimeout before calling `__report`, so a human watching can
/// follow the action at a comfortable pace. The delay gates the final report
/// (race guard): the caller reading the tool result knows the action AND
/// pacing both completed.
fn action_wrapper_js(req_id: u64, body: &str, opts: &ActionOpts) -> String {
    let watch_mode = opts.watch_mode;
    let pane_delay_ms = opts.pane_delay_ms;
    format!(
        r#"(function() {{
    var WATCH_MODE = {watch_mode};
    var PANE_DELAY_MS = {pane_delay_ms};
    var __report = function(res) {{
        try {{
            window.__TAURI_INTERNALS__.invoke('browser_action_result', {{
                reqId: {req_id},
                result: res === undefined ? 'undefined' : String(res)
            }}).catch(function() {{}});
        }} catch(e) {{}}
    }};
    var __finish = function(res) {{
        if (WATCH_MODE) {{
            setTimeout(function() {{ __report(res); }}, PANE_DELAY_MS);
        }} else {{
            __report(res);
        }}
    }};
    try {{
        var __result = (function() {{ {body} }})();
        if (__result && typeof __result.then === 'function') {{
            __result.then(
                function(v) {{ __finish(v); }},
                function(e) {{ __finish('ERROR: ' + (e && e.message ? e.message : e)); }}
            );
        }} else {{
            __finish(__result);
        }}
    }} catch(e) {{
        __finish('ERROR: ' + (e && e.message ? e.message : e));
    }}
}})();"#
    )
}

/// Legacy flat-text read JS (replaced by the readability-style bridge above,
/// but kept for the click_js / type_js tests that check the ref-tagging pattern).
/// The interactive-element ref scheme (data-conduit-ref + non-zero-bounding-rect
/// guard) is preserved in the new bridge_extract.js.
#[allow(dead_code)]
const READ_PAGE_JS: &str = r#"
var sel = 'a[href], button, input, textarea, select, [role=button], [onclick]';
var els = Array.prototype.slice.call(document.querySelectorAll(sel));
var lines = [];
var i = 0;
els.forEach(function(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    el.setAttribute('data-conduit-ref', String(i));
    var tag = el.tagName.toLowerCase();
    var label = (el.innerText || el.value || el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || el.getAttribute('name') || '')
        .trim().replace(/\s+/g, ' ').slice(0, 80);
    var extra = tag === 'a' ? (el.getAttribute('href') || '')
        : (el.getAttribute('type') || '');
    lines.push('[' + i + '] ' + tag + (extra ? '(' + extra + ')' : '') +
        (label ? ' ' + JSON.stringify(label) : ''));
    i++;
});
var text = (document.body ? document.body.innerText : '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
return 'URL: ' + location.href + '\nTITLE: ' + document.title +
    '\n\nINTERACTIVE ELEMENTS (ref | tag | label):\n' +
    (lines.length ? lines.join('\n') : '(none found)') +
    '\n\nPAGE TEXT:\n' + text;
"#;

/// Click the element tagged with `data-conduit-ref="{r}"`. Returns a JS body
/// (for `action_wrapper_js`) that returns a PROMISE: it tweens the synthetic
/// cursor to the element, shows a ripple, THEN fires the real click — so a
/// human watching can follow the action, and the tool result is only reported
/// once the whole sequence (and the real DOM click) completes (Task #7 race
/// guard). The overlay primitives come from bridge_overlay.js (injected after
/// navigation + lazily by __conduit_injectOverlay).
fn click_js(r: i64) -> String {
    format!(
        r#"
var el = document.querySelector('[data-conduit-ref="{r}"]');
if (!el) return 'ERROR: no element with ref {r}. Call browser_read first to refresh the element map.';
function doClick() {{
    el.scrollIntoView({{block: 'center'}});
    el.click();
    return 'Clicked ref {r}. Current URL: ' + location.href + '. Call browser_read to see the resulting page.';
}}
// Graceful degradation: if the visual overlay isn't installed yet (page loaded
// before the post-nav injection fired, or the primitives got cleared), skip the
// cursor/ripple and just click. Functionality never depends on the visuals.
if (typeof __conduit_tweenCursor !== 'function') {{ return doClick(); }}
var rect = el.getBoundingClientRect();
var cx = rect.left + rect.width / 2;
var cy = rect.top + rect.height / 2;
__conduit_highlight(rect);
return __conduit_tweenCursor(cx, cy, 150).then(function() {{
    __conduit_showRipple(cx, cy);
    return doClick();
}}).then(function(msg) {{
    setTimeout(function() {{ __conduit_fadeHighlight(); }}, 250);
    return msg;
}});
"#
    )
}

/// Type `text` into the element tagged with `data-conduit-ref="{r}"`. Returns a
/// JS body that returns a PROMISE: it tweens the cursor to the field, shows a
/// caret, then inserts the text CHARACTER BY CHARACTER (~14ms±6ms per char,
/// randomized) dispatching real keydown/keyup/input events per keystroke —
/// this is functionally required (not just visual) so React/Vue controlled
/// inputs register the change the same way a real user typing does. The tool
/// result reports only after the last keystroke (Task #7 race guard).
fn type_js(r: i64, text: &str) -> String {
    let js_text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
var el = document.querySelector('[data-conduit-ref="{r}"]');
if (!el) return 'ERROR: no element with ref {r}. Call browser_read first to refresh the element map.';
var text = {js_text};
function doTypePlain() {{
    el.focus();
    if ('value' in el && typeof el.value === 'string') {{ el.value = text; }} else {{ el.textContent = text; }}
    el.dispatchEvent(new Event('input', {{bubbles: true}}));
    el.dispatchEvent(new Event('change', {{bubbles: true}}));
    return 'Typed into ref {r}.';
}}
// Graceful degradation when the overlay primitives aren't installed yet.
if (typeof __conduit_tweenCursor !== 'function') {{ return doTypePlain(); }}
var rect = el.getBoundingClientRect();
var cx = rect.left + rect.width / 2;
var cy = rect.top + rect.height / 2;
__conduit_highlight(rect);
return __conduit_tweenCursor(cx, cy, 150).then(function() {{
    el.focus();
    __conduit_showCaret(cx + rect.width / 2 - 2, cy);
    var existing = ('value' in el && typeof el.value === 'string') ? el.value : '';
    var i = 0;
    function next() {{
        if (i >= text.length) {{
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
            __conduit_hideCaret();
            setTimeout(function() {{ __conduit_fadeHighlight(); }}, 200);
            return 'Typed into ref {r}.';
        }}
        var ch = text[i];
        try {{ el.dispatchEvent(new KeyboardEvent('keydown', {{key: ch, bubbles: true}})); }} catch(e) {{}}
        if ('value' in el && typeof el.value === 'string') {{
            el.value = existing + text.slice(0, i + 1);
        }} else {{
            el.textContent = existing + text.slice(0, i + 1);
        }}
        try {{ el.dispatchEvent(new KeyboardEvent('keyup', {{key: ch, bubbles: true}})); }} catch(e) {{}}
        el.dispatchEvent(new Event('input', {{bubbles: true}}));
        var r2 = el.getBoundingClientRect();
        __conduit_showCaret(r2.left + Math.min(r2.width, 8), r2.top + r2.height / 2 - 9);
        i++;
        var delay = 8 + Math.random() * 12;
        return new Promise(function(resolve) {{ setTimeout(function() {{ resolve(next()); }}, delay); }});
    }}
    return next();
}});
"#
    )
}

fn scroll_js(dy: i64) -> String {
    format!(
        r#"
window.scrollBy(0, {dy});
return 'Scrolled by {dy}px. scrollY=' + Math.round(window.scrollY) +
    ' of ' + Math.round(document.body ? document.body.scrollHeight : 0) + '.';
"#
    )
}

/// Hover (dispatch true mouseover/mouseenter/mousemove) over the element tagged
/// with `data-conduit-ref="{r}"`. Needed for CSS-`:hover` menus and dropdowns
/// that reveal on hover before a click is possible. Real MouseEvents with
/// `bubbles:true` are required so React/Vue `onMouseEnter` handlers fire the
/// same way they do for a real cursor. Returns a Promise like click_js (cursor
/// tween → hover events), degrading gracefully without the overlay.
fn hover_js(r: i64) -> String {
    format!(
        r#"
var el = document.querySelector('[data-conduit-ref="{r}"]');
if (!el) return 'ERROR: no element with ref {r}. Call browser_read first to refresh the element map.';
var rect = el.getBoundingClientRect();
var cx = Math.max(rect.left + Math.max(rect.width / 2, 1), 1);
var cy = Math.max(rect.top + Math.max(rect.height / 2, 1), 1);
function doHover() {{
    var opts = {{ bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }};
    // Real user hover emits mouseover (bubbles, target=el) then mouseenter
    // (non-bubbling, listens on ancestor) for each ancestor in the chain that
    // has a listener, plus a leading mousemove so CSS :hover (:hover applies
    // on any pointing-device movement over the element) activates.
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    try {{ el.dispatchEvent(new MouseEvent('mouseenter', opts)); }} catch(e) {{}}
    return 'Hovered ref {r}. Menus toggled by :hover should now be visible.';
}}
if (typeof __conduit_tweenCursor !== 'function') {{ return doHover(); }}
__conduit_highlight(rect);
return __conduit_tweenCursor(cx, cy, 150).then(function() {{
    var msg = doHover();
    setTimeout(function() {{ __conduit_fadeHighlight(); }}, 250);
    return msg;
}});
"#
    )
}

/// Drive the webview's real history stack and report the resulting URL. Unlike
/// `self.eval(...)` (fire-and-forget), this uses the awaited `run_action` bridge
/// so the tool result carries whether navigation actually left the page and the
/// new URL. `direction` is "back" | "forward". history.go(-1)/go(1) fire the
/// same `popstate`/`browser:navigated` bookkeeping as a real browser button.
fn history_js(direction: &str) -> String {
    let go = if direction == "forward" { "history.go(1)" } else { "history.go(-1)" };
    format!(
        r#"
var before = location.href;
{go};
return 'Navigating {direction} from ' + before + '. New URL (after settle): ' + location.href + '.';
"#
    )
}

/// Evaluate arbitrary JS in the page and return a JSON-serialized result. The
/// expression may reference the live DOM; `new Function('return (<expr>);')`
/// lets a bare expression (e.g. `document.title`) or a statement block both
/// work, and JSON.stringify preserves the value's real shape (numbers, strings,
/// arrays, plain objects) instead of string-coercing it. Functions, undefined,
/// and circular structures are turned into readable markers. Cross-origin and
/// untrusted-page caveats apply: this runs in the pane's own origin.
fn evaluate_js(expression: &str) -> String {
    let expr_js = serde_json::to_string(expression).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
var __expr = {expr_js};
var __replacer = function(k, v) {{
    if (typeof v === 'function') return '[Function]';
    if (typeof v === 'undefined') return '[undefined]';
    if (v && typeof v === 'object') {{
        try {{ JSON.stringify(v); return v; }} catch (e) {{ return '[circular]'; }}
    }}
    return v;
}};
try {{
    var __fn = new Function('return (' + __expr + ');');
    var __value = __fn.call(window);
    if (typeof __value === 'undefined') return '[undefined]';
    return JSON.stringify(__value, __replacer);
}} catch (e) {{
    return 'ERROR: ' + e.message;
}}
"#
    )
}

// ---- Page capture (browser_screenshot) ------------------------------------


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_wrapper_reports_via_command_with_req_id() {
        let js = action_wrapper_js(42, "return 'hi';", &ActionOpts::default());
        assert!(js.contains("browser_action_result"));
        assert!(js.contains("reqId: 42"));
        assert!(js.contains("return 'hi';"));
        // Errors are reported too, not swallowed.
        assert!(js.contains("'ERROR: '"));
    }

    #[test]
    fn action_wrapper_awaits_promise_results() {
        // A body that returns a Promise (the visual-feedback path) must be
        // detected and awaited, not reported as "[object Promise]".
        let js = action_wrapper_js(7, "return new Promise(function(r){ r('done'); });", &ActionOpts::default());
        assert!(js.contains("typeof __result.then === 'function'"));
        assert!(js.contains("browser_action_result"));
        assert!(js.contains("reqId: 7"));
        // Promise rejection path still maps to the ERROR prefix.
        assert!(js.contains("'ERROR: '"));
    }

    #[test]
    fn action_wrapper_includes_pacing_when_watch_mode_true() {
        let opts = ActionOpts { watch_mode: true, pane_delay_ms: 600 };
        let js = action_wrapper_js(1, "return 'ok';", &opts);
        // The JS must interpolate WATCH_MODE = true and PANE_DELAY_MS = 600
        // as literal values, not strings.
        assert!(js.contains("var WATCH_MODE = true;"));
        assert!(js.contains("var PANE_DELAY_MS = 600;"));
        assert!(js.contains("if (WATCH_MODE)"));
        assert!(js.contains("setTimeout(function() { __report(res); }, PANE_DELAY_MS)"));
        assert!(js.contains("__finish(__result)"));
    }

    #[test]
    fn action_wrapper_skips_pacing_when_watch_mode_false() {
        let opts = ActionOpts::default();
        let js = action_wrapper_js(1, "return 'ok';", &opts);
        assert!(js.contains("var WATCH_MODE = false;"));
        assert!(js.contains("var PANE_DELAY_MS = 250;"));
        assert!(js.contains("if (WATCH_MODE)"));
        // __finish still wraps the report (unified path), but the setTimeout
        // branch won't fire.
    }

    #[test]
    fn click_js_targets_ref_and_guards_missing() {
        let js = click_js(3);
        assert!(js.contains(r#"data-conduit-ref="3""#));
        assert!(js.contains(".click()"));
        assert!(js.contains("ERROR: no element with ref 3"));
    }

    #[test]
    fn type_js_json_escapes_text() {
        let js = type_js(1, "he said \"hi\"\nbye");
        // The typed text must be a valid JS string literal (quotes/newlines escaped).
        assert!(js.contains(r#"he said \"hi\"\nbye"#));
        assert!(js.contains(r#"data-conduit-ref="1""#));
        assert!(js.contains("dispatchEvent"));
    }

    #[test]
    fn scroll_js_uses_amount() {
        assert!(scroll_js(-250).contains("window.scrollBy(0, -250)"));
    }

    #[test]
    fn hover_js_targets_ref_and_dispatches_mouse_events() {
        let js = hover_js(4);
        assert!(js.contains(r#"data-conduit-ref="4""#));
        assert!(js.contains("MouseEvent"));
        assert!(js.contains("mouseover"));
        assert!(js.contains("mouseenter"));
        assert!(js.contains("ERROR: no element with ref 4"));
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
        assert!(READ_PAGE_JS.contains("data-conduit-ref"));
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

    #[test]
    fn read_opts_default_values() {
        let opts = ReadOpts::default();
        assert_eq!(opts.settle_ms, 400);
        assert_eq!(opts.max_scroll_steps, 4);
    }
}
