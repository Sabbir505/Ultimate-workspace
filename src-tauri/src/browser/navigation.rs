//! `browser::navigation` — pane navigation, history, window bounds/visibility, and pane/tab close.
//! Carved verbatim from the former browser.rs impl monolith
//! (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

impl BrowserManager {
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
        // A manual (or any) navigation re-arms the agent: the sticky cancel
        // flag exists to halt an out-of-control agent until a human acts.
        self.clear_cancelled(pane_id);
        self.remember_tab_url(&browser_label(pane_id, tab_id), &parsed.to_string());
        // Route through CoreWebView2.Navigate ON THE MAIN THREAD, against our
        // own controller (the tauri dispatcher's Webview messages are
        // silently dropped for these panes).
        let label = browser_label(pane_id, tab_id);
        let url2 = parsed.to_string();
        // Mark the navigation in flight SYNCHRONOUSLY, before the async COM
        // dispatch on the main thread: NavigationStarting fires there, so a
        // follow-up op (op_navigate's title read, the agent's next click) can
        // reach the quiesce gate before the marker exists otherwise.
        #[cfg(windows)]
        self.mark_nav_start(&label);
        #[cfg(windows)]
        {
            let result = with_core_on_main(app, self.webviews.clone(), &label, "navigate", move |core| {
                let url_h = windows::core::HSTRING::from(url2);
                unsafe { core.Navigate(&url_h) }.map_err(|e| format!("Navigate failed: {e}"))?;
                Ok(())
            });
            match &result {
                Ok(_) => browser_log(app, &format!("navigate INVOKE OK url={parsed} — waiting for nav START/COMPLETE")),
                Err(e) => {
                    browser_log(app, &format!("navigate INVOKE FAILED url={parsed}: {e}"));
                    // The dispatch failed — no navigation is in flight, so the
                    // marker we set above would never be cleared by a
                    // NavigationCompleted.
                    self.mark_nav_end(&label);
                }
            }
            result?;
        }
        #[cfg(not(windows))]
        {
            // B-2: tauri-managed panes — eval-based navigation fallback.
            let pane = self.get(&label)?;
            if let Err(e) = pane.navigate_to(&url2) {
                browser_log(app, &format!("navigate INVOKE FAILED url={parsed}: {e}"));
                return Err(e);
            }
            browser_log(app, &format!("navigate INVOKE OK url={parsed} — waiting for nav START/COMPLETE"));
        }
        self.spawn_post_nav_inject(pane_id, tab_id);
        self.refocus_main_webview();
        Ok(())
    }

    /// Toggle the native DevTools window for a pane's webview (roadmap #15).
    /// Gives console + network + DOM inspection for agent debugging.
    pub fn open_devtools(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        ensure_supported()?;
        let label = browser_label(pane_id, tab_id);
        #[cfg(windows)]
        {
            with_core_on_main(&self.app, self.webviews.clone(), &label, "open_devtools", move |core| {
                // Surface COM failures — a silently-failed open left the user
                // clicking the DevTools button with nothing happening.
                unsafe { core.OpenDevToolsWindow() }
                    .map_err(|e| format!("OpenDevToolsWindow failed: {e}"))
            })
        }
        #[cfg(not(windows))]
        {
            let pane = self
                .webviews
                .lock()
                .get(&label)
                .cloned()
                .ok_or_else(|| format!("no browser webview labelled {label}"))?;
            pane.open_devtools_pane()
        }
    }

    /// Shared first half of `navigate`: validate the URL, mark the pane active
    /// and resolve the pane handle. Split out so `create` (an async worker)
    /// can dispatch the controller `navigate` call itself on the main thread.
    pub(super) fn prepare_navigate(
        &self,
        pane_id: &str,
        tab_id: &str,
        url: &str,
    ) -> Result<(BrowserPane, tauri::Url), String> {
        ensure_supported()?;
        let parsed = validate_nav_url(url)?;
        *self.active.lock() = Some((pane_id.to_string(), tab_id.to_string()));
        self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());
        let label = browser_label(pane_id, tab_id);
        let pane = self.get(&label)?;
        Ok((pane, parsed))
    }

    /// Shared second half of `navigate`: inject the pushState monkey-patch
    /// after a delay so the new page's DOM has loaded. The eval fires on
    /// whatever document is current.
    pub(super) fn spawn_post_nav_inject(&self, pane_id: &str, tab_id: &str) {
        let pid = pane_id.to_string();
        let tid = tab_id.to_string();
        let label = browser_label(pane_id, tab_id);
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Some(w) = app.get_webview(&label) {
                let _ = w.eval(&pushstate_injection_js(&pid, &tid));
                // Re-inject the diagnostics layer + visual-feedback overlay
                // after navigation — a fresh page load clears injected DOM, so
                // the console/network ring buffer and the cursor/highlight
                // primitives must be re-installed (Task #7). Idempotent on the
                // JS side: a no-op if already present.
                let _ = w.eval(DIAG_INIT_JS);
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

    /// Clear the current site's session for a pane: cookies visible to the
    /// page (document.cookie expiry), localStorage and sessionStorage, then
    /// reload. Scoped to the CURRENT origin — that's what "clear this site"
    /// means and it's the origin the user can see. HttpOnly cookies are NOT
    /// touchable from JS (by design); with per-project profiles (Windows) the
    /// project profile itself already scopes those. Cross-platform, best-
    /// effort: any failure leaves the page intact.
    pub fn clear_site_session(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        let label = browser_label(pane_id, tab_id);
        // NB: self.eval runs the body as a SCRIPT (ExecuteScript) — a
        // top-level `return` is a SyntaxError and would silently no-op the
        // whole clear. Statements only; the reload makes the outcome visible.
        self.eval(
            &label,
            r#"
try { localStorage.clear(); } catch (e) {}
try { sessionStorage.clear(); } catch (e) {}
try {
  var expired = 'Thu, 01 Jan 1970 00:00:00 GMT';
  var parts = document.cookie.split(';');
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].split('=')[0].trim();
    if (!name) continue;
    var base = name + '=; expires=' + expired + ' path=/';
    document.cookie = base;
    document.cookie = base + '; domain=' + location.hostname;
    if (location.hostname.indexOf('.') !== -1) {
      document.cookie = base + '; domain=.' + location.hostname.split('.').slice(-2).join('.');
    }
  }
} catch (e) {}
window.__relaySiteCleared = location.origin;
location.reload();
"#,
        )
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
        let label = browser_label(pane_id, tab_id);
        // Dedupe: the frontend's occlusion effect re-runs on every tabState
        // change — i.e. every address-bar keystroke — and each real show()
        // ends by handing focus back to the main webview. Without this skip,
        // every keystroke yanks focus out of the input mid-word.
        if self.tab_visible.lock().get(&label).copied() == Some(visible) {
            return Ok(());
        }
        self.pane_visible.lock().insert(pane_id.to_string(), visible);
        self.tab_visible.lock().insert(label.clone(), visible);
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
        self.tab_visible.lock().remove(&label);
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
            self.tab_visible.lock().remove(label);
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
        let prefix = format!("browser-{pane_id}-tab-");
        self.tab_visible.lock().retain(|k, _| !k.starts_with(&prefix));
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

    pub(super) fn eval(&self, label: &str, js: &str) -> Result<(), String> {
        ensure_supported()?;
        let js = js.to_string();
        #[cfg(windows)]
        {
            with_core_on_main(&self.app, self.webviews.clone(), label, "eval", move |core| {
                use webview2_com::ExecuteScriptCompletedHandler;
                let js_h = windows::core::HSTRING::from(js);
                let handler = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                unsafe { core.ExecuteScript(&js_h, &handler) }
                    .map_err(|e| format!("ExecuteScript failed: {e}"))?;
                Ok(())
            })
        }
        #[cfg(not(windows))]
        {
            let pane = self
                .webviews
                .lock()
                .get(label)
                .cloned()
                .ok_or_else(|| format!("no browser webview labelled {label}"))?;
            pane.eval_js(&js)
        }
    }
}
