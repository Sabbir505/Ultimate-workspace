import io, re
p = "src/browser.rs"
src = io.open(p, encoding="utf-8").read()

# ---------- 1. webviews map -> Arc<Mutex<..>> ----------
src = src.replace(
    "pub struct BrowserManager {\n    app: AppHandle,\n    webviews: Mutex<HashMap<String, BrowserPane>>,",
    "pub struct BrowserManager {\n    app: AppHandle,\n    webviews: crate::browser::WebviewsMap,",
    1,
)
src = src.replace(
    "            app,\n            webviews: Mutex::new(HashMap::new()),",
    "            app,\n            webviews: std::sync::Arc::new(Mutex::new(HashMap::new())),",
    1,
)
# WebviewsMap is only defined on windows; alias everywhere.
src = src.replace(
    "/// The pane map, shared into main-thread closures.\n#[cfg(windows)]\npub(crate) type WebviewsMap = std::sync::Arc<Mutex<HashMap<String, BrowserPane>>>;",
    "/// The pane map, shared into main-thread closures.\npub(crate) type WebviewsMap = std::sync::Arc<Mutex<HashMap<String, BrowserPane>>>;",
    1,
)
# with_core_on_main non-windows stub signature takes () map — change to WebviewsMap
src = src.replace(
    """#[cfg(not(windows))]
fn with_core_on_main<T: Send + 'static>(
    _app: &AppHandle,
    _webviews: (),
    _label: &str,
    what: &str,
    _f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    Err(format!("{what}: requires the Windows WebView2 backend"))
}""",
    """#[cfg(not(windows))]
fn with_core_on_main<T: Send + 'static>(
    _app: &AppHandle,
    _webviews: WebviewsMap,
    _label: &str,
    what: &str,
    _f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    Err(format!("{what}: requires the Windows WebView2 backend"))
}""",
    1,
)

# ---------- 2. create(): drop the post-insert attach + navigate (the COM init
# chain already attaches listeners and navigates); keep Page.enable + injects.
old = """        eprintln!("[relay:browser] create OK for label={label}");

        self.webviews.lock().insert(label.clone(), pane);

        // Definitive navigation instrumentation: WebView2's own
        // NavigationStarting / NavigationCompleted events, registered
        // straight on CoreWebView2 (wry's on_navigation only covers
        // navigation-START, and nothing covered completion/failure — a pane
        // whose navigation silently never ran looked identical to one stuck
        // loading). Logs every transition to logs/browser.log with the error
        // code, and emits `browser:navigated` on COMPLETED so the frontend's
        // loading flag tracks real load completion.
        self.attach_navigation_listeners(&label);

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
        self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());

        // The navigate controller call must run on the main thread too (this
        // method runs on an async worker) — same WebView2 constraint as
        // add_child above.
        let (nav_pane, parsed) = self.prepare_navigate(pane_id, tab_id, url)?;
        browser_log(&self.app, &format!("create navigate label={label} url={parsed}"));
        let nav_result = self.run_main_thread_call(move || {
            nav_pane.webview.navigate(parsed).map_err(|e| e.to_string())
        });
        match &nav_result {
            Ok(_) => browser_log(&self.app, &format!("create navigate OK label={label}")),
            Err(e) => browser_log(&self.app, &format!("create navigate FAILED label={label}: {e}")),
        }
        nav_result?;
        self.spawn_post_nav_inject(pane_id, tab_id);"""
new = """        eprintln!("[relay:browser] create OK for label={label}");

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
        self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());

        self.spawn_post_nav_inject(pane_id, tab_id);"""
assert old in src, "create nav block not found"
src = src.replace(old, new, 1)

# ---------- 3. attach_navigation_listeners: pass the map ----------
src = src.replace(
    'let attached = with_core_on_main(&self.app, label, "attach nav listeners", move |core| {',
    'let attached = with_core_on_main(&self.app, self.webviews.clone(), label, "attach nav listeners", move |core| {',
    1,
)

# ---------- 4. call_devtools_protocol: pass the map ----------
src = src.replace(
    "        with_core_on_main(&self.app, label, \"cdp invoke\", move |core| {",
    "        with_core_on_main(&self.app, self.webviews.clone(), label, \"cdp invoke\", move |core| {",
    1,
)

io.open(p, "w", encoding="utf-8", newline="\n").write(src)
print("patch2 ok")
