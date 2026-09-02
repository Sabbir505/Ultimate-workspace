import io
p = "src/browser.rs"
src = io.open(p, encoding="utf-8").read()

# ---------- 1. build_pane_on_main_thread: split windows (direct COM) from mac ----------
old_head = """    /// Build the underlying webview (Windows/macOS: child webview via
    /// `WebviewBuilder`+`add_child`; Linux: standalone `WebviewWindow` per
    /// pane+tab). Runs on the main thread because Tauri webview APIs
    /// require it. Returns a uniform `BrowserPane` regardless of platform.
    fn build_pane_on_main_thread(
        &self,
        pane_id: &str,
        tab_id: &str,
        _url: &str,
        rect: Rect,
    ) -> Result<BrowserPane, String> {
        let label = browser_label(pane_id, tab_id);
        let event_pane_id = pane_id.to_string();
        let event_tab_id = tab_id.to_string();
        let _app_for_emit = self.app.clone();

        // --- Windows / macOS: child webview (existing path) ---
        #[cfg(any(windows, target_os = "macos"))]
        {"""
new_head = """    /// Build the underlying webview and return a uniform `BrowserPane`.
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
            let hwnd = main_window
                .hwnd()
                .map_err(|e| format!("main window hwnd unavailable: {e}"))?
                .0;
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
            // NOTE: called ON the main thread via run_main_thread_call — the
            // COM completions fire on the main thread's normal pump while the
            // WORKER waits on done_rx. The main thread never blocks.
            self.run_main_thread_call(move || {
                create_environment_async(&data_dir, done_ctrl.clone(), move |env| {
                    create_controller_async(hwnd, &env, bounds, done_ctrl.clone(), move |controller| {
                        let core = unsafe { controller.CoreWebView2() }
                            .map_err(|e| format!("CoreWebView2 unavailable: {e}"))?;
                        // Document-start bridge (visual overlay primitives) —
                        // installed once per webview; every later document
                        // re-runs it automatically.
                        let overlay_h = HSTRING::from(BRIDGE_OVERLAY_JS);
                        let script_handler = webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(())));
                        unsafe { core.AddScriptToExecuteOnDocumentCreated(&overlay_h, &script_handler) }
                            .map_err(|e| format!("AddScriptToExecuteOnDocumentCreated failed: {e}"))?;
                        attach_core_listeners(&app2, &label2, &core);
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
        {"""
assert old_head in src, "build head not found"
src = src.replace(old_head, new_head, 1)

# the old block ended with `return Ok(BrowserPane { webview }); }` — keep for mac.

io.open(p, "w", encoding="utf-8", newline="\n").write(src)
print("patch3a ok")
