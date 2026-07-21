//! Native child-webview browser panes (Windows/macOS).
//!
//! The browser pane used to be an <iframe> pointed at a URL, which breaks on
//! real browsing: sites sending X-Frame-Options refuse to render, and
//! cross-origin history reads are blocked by Chromium. On Windows/macOS we
//! instead attach a Tauri child webview to the main window — a top-level
//! browsing context, so XFO doesn't apply and full navigation works. The
//! webview is positioned over the pane's body div using the logical-pixel
//! rect the frontend measures with getBoundingClientRect (Tauri handles the
//! HiDPI logical -> physical conversion).
//!
//! Two hazards this module is designed around:
//! - Native webviews render ABOVE the page content (they are not composited
//!   with the DOM), so the frontend must call browser_set_visible(false)
//!   whenever an overlay opens or the pane is hidden in split mode.
//! - Linux: Tauri child webviews are unsupported there (wry/gtk has no
//!   multi-webview support), so every entry point returns a clean error and
//!   the frontend falls back to the iframe implementation.

use std::collections::HashMap;
use std::sync::mpsc;

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::webview::WebviewBuilder;
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

/// Child webviews are unsupported on Linux — the frontend falls back to an
/// iframe there. Kept as a function so the failure is a clean command error,
/// never a panic.
pub fn platform_supported() -> bool {
    !cfg!(target_os = "linux")
}

fn ensure_supported() -> Result<(), String> {
    if platform_supported() {
        Ok(())
    } else {
        Err("native browser panes are not supported on Linux; the frontend uses the iframe fallback"
            .to_string())
    }
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

pub struct BrowserManager {
    app: AppHandle,
    webviews: Mutex<HashMap<String, Webview>>,
    /// Panes currently being created (so concurrent creates for the same paneId
    /// don't race — the second one waits for the first). Key = pane_id string.
    in_flight: Mutex<std::collections::HashSet<String>>,
}

impl BrowserManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            webviews: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(std::collections::HashSet::new()),
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

        // Guard against concurrent creates for the same label. React
        // StrictMode double-mounts in dev, so the frontend may send two
        // browser_create calls at once. The second call sees the in-flight
        // marker and returns immediately.
        {
            let mut inf = self.in_flight.lock();
            if inf.contains(&label) {
                eprintln!("[conduit:browser] create SKIP label={label} — already in-flight");
                return Ok(());
            }
            inf.insert(label.clone());
        }

        ensure_supported().map_err(|e| {
            eprintln!("[conduit:browser] ensure_supported FAILED: {e}");
            self.in_flight.lock().remove(&label);
            e
        })?;

        // Replacing an existing tab: close the old webview first.
        {
            let map = self.webviews.lock();
            if map.contains_key(&label) {
                drop(map);
                self.close(pane_id, tab_id).map_err(|e| {
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
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| {
                let known: Vec<String> = self
                    .app
                    .windows()
                    .iter()
                    .map(|(label, _)| label.to_string())
                    .collect();
                let msg = "main window not found".to_string();
                eprintln!("[conduit:browser] get_window('main') FAILED: {msg} — known window labels: {known:?}");
                msg
            })?;

        let app = self.app.clone();
        let event_pane_id = pane_id.to_string();
        let event_tab_id = tab_id.to_string();
        let app2 = self.app.clone();
        let event_pane_id2 = pane_id.to_string();
        let event_tab_id2 = tab_id.to_string();
        let blank: tauri::Url = "about:blank".parse().expect("about:blank is a valid url");
        // Clone before the on_navigation closure captures label.
        let label_for_nav = label.clone();
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(blank))
            .on_navigation(move |nav_url| {
                eprintln!("[conduit:browser] navigation: {nav_url}");
                let _ = app.emit(
                    "browser:navigated",
                    BrowserNavigatedEvent {
                        pane_id: event_pane_id.clone(),
                        tab_id: event_tab_id.clone(),
                        url: nav_url.to_string(),
                    },
                );
                // Inject the pushState monkey-patch via JS setTimeout so it
                // fires after the new page's DOM is ready. This is a pure
                // eval — it doesn't navigate, so no feedback loop.
                let lbl = label_for_nav.clone();
                let app_ref = app.clone();
                let pid = event_pane_id.clone();
                let tid = event_tab_id.clone();
                // We use a thread + delay here because on_navigation fires
                // BEFORE the new page loads. The 1.5s delay gives the page
                // time to render before we inject the monkey-patch.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    if let Some(w) = app_ref.get_webview(&lbl) {
                        let _ = w.eval(&pushstate_injection_js(&pid, &tid));
                    }
                });
                true
            })
            .on_new_window(move |url, _label| {
                // Intercept new-window requests (target=_blank, window.open()).
                // Navigate the existing webview to this URL in-place instead of
                // opening a system popup. We navigate via the app handle (by
                // label) since we don't have the Webview handle in this closure.
                eprintln!("[conduit:browser] new_window: {url} — navigating in-place");
                let _ = app2.emit(
                    "browser:navigated",
                    BrowserNavigatedEvent {
                        pane_id: event_pane_id2.clone(),
                        tab_id: event_tab_id2.clone(),
                        url: url.to_string(),
                    },
                );
                // Deny the popup — the frontend's event handler will call
                // browser_navigate to actually load the URL in the existing
                // webview (see BrowserPane.tsx).
                tauri::webview::NewWindowResponse::Deny
            });

        let rect = sanitize(rect);
        eprintln!(
            "[conduit:browser] add_child at ({},{}) {}x{} (main-thread scheduled)",
            rect.x, rect.y, rect.width, rect.height
        );

        let (tx, rx) = mpsc::sync_channel::<Result<Webview, String>>(1);
        let window_ref = window.clone();
        let pos = LogicalPosition::new(rect.x, rect.y);
        let size = LogicalSize::new(rect.width, rect.height);
        let label_owned = label.clone();
        self.app.run_on_main_thread(move || {
            let res = window_ref
                .add_child(builder, pos, size)
                .map_err(|e| format!("failed to create browser webview: {e}"));
            match &res {
                Ok(_) => eprintln!("[conduit:browser] add_child OK on main thread for label={label_owned}"),
                Err(msg) => eprintln!("[conduit:browser] add_child FAILED on main thread: {msg}"),
            }
            let _ = tx.send(res);
        });

        let webview = match rx.recv() {
            Ok(Ok(w)) => w,
            Ok(Err(msg)) => {
                self.in_flight.lock().remove(&label);
                return Err(msg);
            }
            Err(_) => {
                self.in_flight.lock().remove(&label);
                return Err("browser webview create thread dropped".to_string());
            }
        };
        eprintln!("[conduit:browser] create OK for label={label}");

        self.webviews.lock().insert(label.clone(), webview);
        self.navigate(pane_id, tab_id, url)?;
        self.in_flight.lock().remove(&label);
        Ok(())
    }

    pub fn navigate(&self, pane_id: &str, tab_id: &str, url: &str) -> Result<(), String> {
        ensure_supported()?;
        let parsed: tauri::Url = url
            .parse()
            .map_err(|e| format!("invalid url `{url}`: {e}"))?;
        let label = browser_label(pane_id, tab_id);
        let webview = self.get(&label)?;
        webview.navigate(parsed)
            .map_err(|e| e.to_string())?;
        // Inject the pushState monkey-patch after a delay so the new page's
        // DOM has loaded. The eval fires on whatever document is current.
        let pid = pane_id.to_string();
        let tid = tab_id.to_string();
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Some(w) = app.get_webview(&label) {
                let _ = w.eval(&pushstate_injection_js(&pid, &tid));
            }
        });
        Ok(())
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
        let label = browser_label(pane_id, tab_id);
        self.get(&label)?
            .set_bounds(tauri::Rect {
                position: Position::Logical(LogicalPosition::new(rect.x, rect.y)),
                size: Size::Logical(LogicalSize::new(rect.width, rect.height)),
            })
            .map_err(|e| e.to_string())
    }

    /// Occlusion control: native webviews float above the DOM, so overlays
    /// (settings views, palette, peek panel, modals) and hidden split-mode
    /// panes must hide their webview explicitly.
    pub fn set_visible(&self, pane_id: &str, tab_id: &str, visible: bool) -> Result<(), String> {
        ensure_supported()?;
        let label = browser_label(pane_id, tab_id);
        let webview = self.get(&label)?;
        let res = if visible { webview.show() } else { webview.hide() };
        res.map_err(|e| e.to_string())
    }

    /// Idempotent close — closing an unknown tab is a no-op (the frontend
    /// calls this both on unmount and from closePane).
    pub fn close(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        self.in_flight.lock().remove(&label);
        let webview = self.webviews.lock().remove(&label);
        if let Some(webview) = webview {
            webview.close().map_err(|e| e.to_string())?;
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
            if let Some(webview) = self.webviews.lock().remove(label) {
                let _ = webview.close();
            }
        }
        Ok(())
    }

    /// App-exit cleanup, wired next to PtyManager::kill_all in lib.rs.
    pub fn close_all(&self) {
        self.in_flight.lock().clear();
        let webviews: Vec<Webview> = self.webviews.lock().drain().map(|(_, w)| w).collect();
        for webview in webviews {
            let _ = webview.close();
        }
    }

    fn eval(&self, label: &str, js: &str) -> Result<(), String> {
        ensure_supported()?;
        self.get(label)?.eval(js).map_err(|e| e.to_string())
    }

    fn get(&self, label: &str) -> Result<Webview, String> {
        self.webviews
            .lock()
            .get(label)
            .cloned()
            .ok_or_else(|| format!("no browser webview with label {label}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(platform_supported(), !cfg!(target_os = "linux"));
    }

    #[test]
    fn rect_deserializes_from_frontend_shape() {
        let r: Rect = serde_json::from_str(r#"{"x":1.0,"y":2.0,"width":3.0,"height":4.0}"#).unwrap();
        assert_eq!((r.x, r.y, r.width, r.height), (1.0, 2.0, 3.0, 4.0));
    }
}
