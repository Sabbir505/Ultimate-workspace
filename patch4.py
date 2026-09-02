import io
p = "src/browser.rs"
src = io.open(p, encoding="utf-8").read()

# ---------- navigate(): with_core Navigate ----------
old = """        drop(pane);
        browser_log(app, &format!("navigate pane={pane_id} tab={tab_id} url={parsed}"));
        // Route through CoreWebView2.Navigate ON THE MAIN THREAD: the old
        // Webview::navigate message rode the event-loop proxy and was
        // silently dropped for freshly-created panes (queued "OK", nothing
        // ever navigated).
        let label = browser_label(pane_id, tab_id);
        let result = navigate_inline(app, &label, parsed.as_str());"""
new = """        drop(pane);
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
        });"""
assert old in src, "navigate block"
src = src.replace(old, new, 1)

# ---------- eval(): with_core ExecuteScript ----------
old = """    fn eval(&self, label: &str, js: &str) -> Result<(), String> {
        ensure_supported()?;
        eval_inline(&self.app, label, js)
    }"""
new = """    fn eval(&self, label: &str, js: &str) -> Result<(), String> {
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
    }"""
assert old in src, "eval block"
src = src.replace(old, new, 1)

# ---------- open_devtools(): with_core ----------
old = """    pub fn open_devtools(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        ensure_supported()?;
        let label = browser_label(pane_id, tab_id);
        let pane = self.get(&label)?;
        pane.webview.open_devtools();
        Ok(())
    }"""
new = """    pub fn open_devtools(&self, pane_id: &str, tab_id: &str) -> Result<(), String> {
        ensure_supported()?;
        let label = browser_label(pane_id, tab_id);
        with_core_on_main(&self.app, self.webviews.clone(), &label, "open_devtools", move |core| {
            unsafe { core.OpenDevTools() };
            Ok(())
        })
    }"""
assert old in src, "open_devtools block"
src = src.replace(old, new, 1)

# ---------- set_bounds(): physical via scale, main-thread ----------
old = """        #[cfg(not(target_os = "linux"))]
        let (final_x, final_y) = (rect.x, rect.y);
        // Bounds must apply ON the main thread: Webview::set_bounds from a
        // worker rides the event-loop proxy and was silently dropped for
        // freshly-created panes (resizes never applied).
        let pane2 = pane;
        self.run_main_thread_call(move || {
            pane2
                .set_position_size(
                    LogicalPosition::new(final_x, final_y),
                    LogicalSize::new(rect.width, rect.height),
                )
                .map_err(|e| e.to_string())
        })
    }"""
new = """        #[cfg(not(target_os = "linux"))]
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
    }"""
assert old in src, "set_bounds block"
src = src.replace(old, new, 1)

# ---------- close paths: controller.Close() on the main thread ----------
old = """            if let Some(pane) = self.webviews.lock().remove(label) {
                let _ = pane.close();
            }
        }
        // Clean up per-pane registries on close."""
new = """            if let Some(pane) = self.webviews.lock().remove(label) {
                // controller.Close() destroys the native child window — run
                // it on the main thread (COM affinity). A dropped/dispatched
                // close left the invisible webview floating over the UI as a
                // click-blocking ghost block.
                let _ = self.run_main_thread_call(move || pane.close());
            }
        }
        // Clean up per-pane registries on close."""
assert old in src, "close_pane_tabs block"
src = src.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(src)
print("patch4 ok")
