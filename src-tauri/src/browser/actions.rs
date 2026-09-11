//! `browser::actions` — action execution (resolve/verify, run_action, nav-quiet waits), devtools/print-to-pdf, page capture, and read/observe/extract.
//! Carved verbatim from the former browser.rs impl monolith
//! (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

impl BrowserManager {

    /// Resolve a pending agentic action (called by the `browser_action_result`
    /// command from the injected JS). Unknown ids are ignored (already timed
    /// out or resolved). NOTE: unverified — prefer `resolve_action_verified`
    /// from any caller that can carry the per-action nonce.
    pub fn resolve_action(&self, req_id: u64, result: String) {
        if let Some(p) = self.pending.lock().remove(&req_id) {
            let _ = p.tx.send(result);
        }
    }

    /// Same as `resolve_action` but requires the per-action nonce echoed by
    /// the injected JS. A hostile page in the pane can post arbitrary
    /// messages with guessed sequential req ids; only the wrapper that
    /// launched the action knows the nonce.
    pub fn resolve_action_verified(&self, req_id: u64, nonce: &str, result: String) {
        let known = {
            let map = self.pending.lock();
            map.get(&req_id).map(|p| p.nonce == nonce).unwrap_or(false)
        };
        if known {
            if let Some(p) = self.pending.lock().remove(&req_id) {
                let _ = p.tx.send(result);
            }
        }
    }

    pub(super) fn active_label(&self) -> Result<String, String> {
        match self.active.lock().as_ref() {
            Some((p, t)) => Ok(browser_label(p, t)),
            None => Err("No page is open in the browser pane yet — call open_url first.".to_string()),
        }
    }

    /// Pane id of the globally active browser pane, if any. Used by the SERP
    /// browser fallback (`chat::tools::serp_browser`), which needs ANY open
    /// pane to host its throwaway search tab without a frontend roundtrip.
    pub(crate) fn active_pane_id(&self) -> Option<String> {
        self.active.lock().as_ref().map(|(p, _)| p.to_string())
    }

    /// Cheap liveness probe for the tool-schema gate: is a page open in the
    /// built-in browser pane right now? (`ToolCaps.browser` — the interaction
    /// tools are only advertised when there is something to act on, or once
    /// the session has used the browser at all.)
    pub fn has_active_page(&self) -> bool {
        self.active.lock().is_some()
    }

    /// Eval a JS action body (an IIFE-able block that `return`s a string) in the
    /// active page and await the string it reports back. Times out so a stuck
    /// or navigating page can't wedge the chat turn.
    pub(super) async fn run_action(&self, body: &str) -> Result<String, String> {
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
        // Trust layer (manager level — covers the chat tools too, which don't
        // pass the MCP gate layer): the user's pause/stop always wins.
        let pane_id = label
            .strip_prefix("browser-")
            .and_then(|rest| rest.split_once("-tab-"))
            .map(|(p, _)| p.to_string());
        if let Some(pid) = pane_id.as_deref() {
            if self.is_cancelled(pid) {
                return Err("ERROR: cancelled_by_user — the user stopped the agent".to_string());
            }
            if self.is_paused(pid) {
                return Err("ERROR: paused_by_user — the user paused the agent".to_string());
            }
        }
        let pane = self.get(label)?;
        // Nav-quiesce gate (root cause of the "navigate returns empty" /
        // "read_page times out" flakiness): an eval fired while a navigation
        // is in flight executes in the document that is about to be REPLACED.
        // When the old context dies mid-run, the wrapper's result report never
        // fires and the op burns its whole 45s timeout. Wait — bounded — for
        // the pane's navigation to complete before evaluating. Windows-only
        // tracking (the markers come from the WebView2 COM handlers); on
        // other platforms this returns immediately.
        self.wait_nav_quiet(label).await;
        let req_id = self.next_req.fetch_add(1, Ordering::SeqCst);
        let nonce = format!("{:016x}", rand::random::<u64>());
        let (tx, rx) = oneshot::channel::<String>();
        self.pending.lock().insert(
            req_id,
            PendingAction { tx, nonce: nonce.clone(), label: label.to_string() },
        );
        let js = action_wrapper_js(req_id, &nonce, body, &opts);
        let eval_res = {
            #[cfg(windows)]
            {
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
            }
            #[cfg(not(windows))]
            {
                // B-2: tauri-managed panes (macOS/Linux) — fire-and-forget
                // eval; the result comes back via the `browser_action_result`
                // command over tauri's IPC (the wrapper picks that transport
                // when window.chrome.webview is absent).
                pane.eval_js(&js)
            }
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

    /// Mark a navigation as started on `label` (in-flight until the matching
    /// NavigationCompleted). Idempotent per START.
    pub fn mark_nav_start(&self, label: &str) {
        self.nav.lock().start(label);
    }

    /// Mark the pane's navigation as finished (cleared by the
    /// NavigationCompleted handlers, success or failure).
    pub fn mark_nav_end(&self, label: &str) {
        self.nav.lock().end(label);
    }

    pub(super) fn nav_in_flight_since(&self, label: &str) -> Option<Duration> {
        self.nav.lock().since(label)
    }

    /// Bounded wait for the pane's in-flight navigation to complete before an
    /// eval. Budget is counted from the navigation's START (not from here), so
    /// an already-hung navigation adds at most `NAV_QUIET_SLACK` — a stuck
    /// page must not make every agent op pay a full extra wait. After the
    /// budget the eval proceeds anyway (best-effort; the caller keeps its own
    /// action timeout). A short settle after completion lets the freshly
    /// committed document come live before we run JS in it.
    #[cfg(windows)]
    pub(super) async fn wait_nav_quiet(&self, label: &str) {
        const NAV_QUIET_MAX: Duration = Duration::from_secs(10);
        const NAV_QUIET_SLACK: Duration = Duration::from_secs(2);
        const POLL: Duration = Duration::from_millis(60);
        const SETTLE: Duration = Duration::from_millis(150);
        let Some(since) = self.nav_in_flight_since(label) else {
            return; // nothing in flight — eval immediately
        };
        let budget = NAV_QUIET_MAX.saturating_sub(since).max(NAV_QUIET_SLACK);
        let deadline = tokio::time::Instant::now() + budget;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(POLL).await;
            if !self.nav.lock().in_flight(label) {
                tokio::time::sleep(SETTLE).await;
                return;
            }
        }
        browser_log(
            &self.app,
            &format!("nav-quiesce gave up label={label} after {budget:?} — evaluating anyway"),
        );
    }

    #[cfg(not(windows))]
    pub(super) async fn wait_nav_quiet(&self, _label: &str) {}

    /// Capture the page currently shown in a pane's webview as PNG bytes.
    /// Backs the `browser_screenshot` tool so the agent can show the user
    /// exactly what the page looks like. Blocking (up to a ~20 s roundtrip) —
    /// call inside `tokio::task::spawn_blocking` from async contexts.
    ///
    /// Renders through the CDP compositor (`Page.captureScreenshot`), which
    /// works from any thread and doesn't depend on the OS painting the child
    /// HWND (the old COM `CapturePreview` roundtrip intermittently returned
    /// empty frames and needed UI-thread marshaling). Windows-only today;
    /// other platforms return `None` and callers surface a clear error.
    pub fn capture_pane_png(&self, label: &str) -> Option<Vec<u8>> {
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

    /// Print the pane's CURRENT page to PDF (ICoreWebView2_7::PrintToPdf) —
    /// the `print_to_pdf` agent tool: hand a faithful document version of a
    /// page to the workspace (receipts, confirmations, docs, your own app's
    /// print preview). Blocking (main-thread COM roundtrip, up to ~30 s);
    /// call inside `spawn_blocking` from async contexts.
    #[cfg(windows)]
    pub fn print_to_pdf_for_pane(
        &self,
        label: &str,
        output_path: &std::path::Path,
        landscape: bool,
    ) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
        use webview2_com::PrintToPdfCompletedHandler;
        use windows::core::Interface as _;

        let out = output_path.to_path_buf();
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
        }
        with_core_on_main(&self.app, self.webviews.clone(), label, "print to pdf", move |core| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment6;
            // Print settings come from the environment (via ICoreWebView2_2's
            // Environment getter — the same chain chat/pdfprint.rs uses).
            let core2 = core.cast::<ICoreWebView2_2>().map_err(|e| e.to_string())?;
            let env = unsafe { core2.Environment() }.map_err(|e| e.to_string())?;
            let env6 = env
                .cast::<ICoreWebView2Environment6>()
                .map_err(|e| format!("print settings unavailable (old runtime?): {e}"))?;
            let settings = unsafe { env6.CreatePrintSettings() }.map_err(|e| e.to_string())?;
            let orientation = if landscape {
                webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            };
            let _ = unsafe { settings.SetOrientation(orientation) };
            let _ = unsafe { settings.SetShouldPrintBackgrounds(true) };
            let _ = unsafe { settings.SetShouldPrintHeaderAndFooter(false) };

            let core7: ICoreWebView2_7 = core
                .cast()
                .map_err(|e| format!("PrintToPdf unavailable (old runtime?): {e}"))?;
            let out_target = windows::core::HSTRING::from(out.to_string_lossy().as_ref());
            // Runs ON the main thread: wait_for_async_operation pumps the
            // message loop so the COM completion can fire (pdfprint pattern).
            PrintToPdfCompletedHandler::wait_for_async_operation(
                {
                    let core7 = core7.clone();
                    let settings = settings.clone();
                    Box::new(move |handler| unsafe {
                        core7.PrintToPdf(&out_target, &settings, &handler)
                            .map_err(webview2_com::Error::WindowsError)
                    })
                },
                Box::new(|error_code, succeeded| {
                    error_code?;
                    if succeeded {
                        Ok(())
                    } else {
                        // PrintToPdf reported success=false without an error
                        // code — surface generic E_FAIL (pdfprint pattern).
                        Err(windows::core::Error::from(windows::core::HRESULT(-2147467259)))
                    }
                }),
            )
            .map_err(|e| format!("PrintToPdf failed: {e}"))?;
            if !out.is_file() {
                return Err("print completed but produced no file".to_string());
            }
            Ok(())
        })
    }

    #[cfg(not(windows))]
    pub fn print_to_pdf_for_pane(
        &self,
        _label: &str,
        _output_path: &std::path::Path,
        _landscape: bool,
    ) -> Result<(), String> {
        Err("print_to_pdf requires the Windows WebView2 backend".to_string())
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
    /// `observe`/`extract` against the ACTIVE pane (the built-in chat's
    /// browser_* tools act on whatever the user is looking at; the MCP
    /// sidecar passes explicit pane ids instead).
    pub async fn observe_active(&self) -> Result<String, String> {
        let label = self.active_label()?;
        self.observe_for_pane(&label).await
    }

    pub async fn extract_active(&self, prompt: &str, max_chars: usize) -> Result<String, String> {
        let label = self.active_label()?;
        self.extract_for_pane(&label, prompt, max_chars).await
    }

    /// `observe` — "what's actionable here" (Stagehand's observe() shape).
    /// A COMPACT interactive-element census: ref id, tag, label, and the
    /// input-specific extras the agent needs to aim an action, one line per
    /// element. Unlike `read_page` interactive mode there is NO markdown body
    /// — this is for the decide-then-act loop, where full a11y records waste
    /// tokens. Capped at 80 elements.
    pub async fn observe_for_pane(&self, label: &str) -> Result<String, String> {
        let json = self
            .read_page_for_pane(label, ReadMode::Interactive, None)
            .await?;
        let v: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| format!("observe: unreadable extraction result: {e}"))?;
        if let Some(reason) = v.get("failureReason").and_then(|x| x.as_str()) {
            return Ok(format!(
                "The page could not be read ({reason}) — nothing to observe."
            ));
        }
        let elements = v
            .get("elementRefs")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        if elements.is_empty() {
            return Ok(
                "No interactive elements found on the current page (no links, buttons, or inputs)."
                    .to_string(),
            );
        }
        let mut lines: Vec<String> = Vec::new();
        for e in elements.iter().take(80) {
            let r = e.get("ref").and_then(|x| x.as_i64()).unwrap_or(-1);
            let tag = e.get("tag").and_then(|x| x.as_str()).unwrap_or("");
            let label = e.get("label").and_then(|x| x.as_str()).unwrap_or("");
            let aria = e.get("ariaLabel").and_then(|x| x.as_str()).unwrap_or("");
            let placeholder = e.get("placeholder").and_then(|x| x.as_str()).unwrap_or("");
            let typ = e.get("type").and_then(|x| x.as_str()).unwrap_or("");
            let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let mut extra = String::new();
            if !typ.is_empty() {
                extra.push_str(&format!(" type={typ}"));
            }
            if !name.is_empty() {
                extra.push_str(&format!(" name={name}"));
            }
            if !placeholder.is_empty() {
                extra.push_str(&format!(" placeholder={placeholder:?}"));
            }
            if !aria.is_empty() && aria != label {
                extra.push_str(&format!(" aria={aria:?}"));
            }
            let shown = if label.is_empty() { aria } else { label };
            lines.push(format!(
                "[{r}] {tag}{extra} {}",
                if shown.is_empty() { "(unlabelled)" } else { shown }
            ));
        }
        let dropped = elements.len().saturating_sub(80);
        let mut out = format!(
            "{} actionable element(s) on {}:\n{}\n",
            elements.len(),
            v.get("url").and_then(|x| x.as_str()).unwrap_or(""),
            lines.join("\n")
        );
        if dropped > 0 {
            out.push_str(&format!(
                "(+{dropped} more — use browser_read interactive for the full list)"
            ));
        }
        Ok(out)
    }

    /// `extract` — focused extraction against a prompt (Stagehand's
    /// extract(prompt) shape, deterministic: no extra model call). The page's
    /// markdown is split into sections at headings, each section is scored by
    /// keyword overlap with the prompt, and the best sections are returned in
    /// document order up to `max_chars` (default 2500). Lets the agent pull
    /// ONLY the relevant slice of a huge page instead of paying for the full
    /// 50k-char read.
    pub async fn extract_for_pane(
        &self,
        label: &str,
        prompt: &str,
        max_chars: usize,
    ) -> Result<String, String> {
        let terms: Vec<String> = prompt
            .to_lowercase()
            .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '.')
            .filter(|w| w.len() >= 3)
            .map(str::to_string)
            .collect();
        if terms.is_empty() {
            return Err(
                "extract requires a 'prompt' with meaningful keywords (3+ chars) to score sections against."
                    .to_string(),
            );
        }
        let json = self.read_page_for_pane(label, ReadMode::Full, None).await?;
        let v: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| format!("extract: unreadable extraction result: {e}"))?;
        if let Some(reason) = v.get("failureReason").and_then(|x| x.as_str()) {
            return Ok(format!(
                "The page could not be read ({reason}) — nothing to extract."
            ));
        }
        let markdown = v
            .get("markdown")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if markdown.trim().is_empty() {
            return Ok("The page has no extractable text content.".to_string());
        }

        // Split into sections: a heading line starts a new section; the
        // heading rides with its body so context survives the cut.
        let mut sections: Vec<(String, String)> = Vec::new(); // (header, body)
        let mut current_header = String::from("(top of page)");
        let mut current_body = String::new();
        for line in markdown.lines() {
            if line.trim_start().starts_with('#') {
                if !current_body.trim().is_empty() {
                    sections.push((current_header.clone(), current_body.clone()));
                    current_body.clear();
                }
                current_header = line.trim().to_string();
            } else {
                current_body.push_str(line);
                current_body.push('\n');
            }
        }
        if !current_body.trim().is_empty() {
            sections.push((current_header, current_body));
        }

        // Score: how many prompt terms appear in the section (header terms
        // count triple — a heading naming the topic is a strong signal).
        let mut scored: Vec<(usize, usize)> = sections
            .iter()
            .enumerate()
            .map(|(i, (h, b))| {
                let hl = h.to_lowercase();
                let bl = b.to_lowercase();
                let score = terms
                    .iter()
                    .map(|t| (hl.contains(t) as usize) * 3 + (bl.contains(t) as usize))
                    .sum::<usize>();
                (i, score)
            })
            .filter(|(_, s)| *s > 0)
            .collect();
        if scored.is_empty() {
            return Ok(format!(
                "No section of the page matched the prompt {prompt:?}. The page has {} characters of content — use browser_read full if you need everything.",
                markdown.len()
            ));
        }
        // Keep the best sections, then restore document order.
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let mut kept: Vec<usize> = Vec::new();
        let mut used = 0usize;
        for (i, s) in &scored {
            if used >= max_chars {
                break;
            }
            kept.push(*i);
            used += sections[*i].0.len() + sections[*i].1.len();
        }
        kept.sort_unstable();
        let mut out = String::new();
        for i in kept {
            out.push_str(&sections[i].0);
            out.push('\n');
            out.push_str(sections[i].1.trim());
            out.push_str("\n\n");
        }
        let mut out = out.trim_end().to_string();
        if out.len() > max_chars {
            out = crate::util::truncate_chars(&out, max_chars);
        }
        Ok(out)
    }

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
                            "[relay:browser] lazy-load scroll loop: scrollHeight={scroll_height} \
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
                                            "[relay:browser] lazy-load scroll stop: no content growth at step {step}"
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
                                            "[relay:browser] lazy-load scroll stop: scrollHeight stable at {new_sh}"
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
}
