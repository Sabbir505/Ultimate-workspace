import io
p = "src/browser.rs"
src = io.open(p, encoding="utf-8").read()

# 1. attach_core_listeners: take the map as a param (no BrowserState roundtrip).
src = src.replace(
    """fn attach_core_listeners(
    app: &AppHandle,
    label: &str,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {""",
    """fn attach_core_listeners(
    app: &AppHandle,
    webviews: crate::browser::WebviewsMap,
    label: &str,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {""",
    1,
)
src = src.replace(
    "    let webviews_start = app.state::<BrowserState>().0.webviews.clone();",
    "    let webviews_start = webviews.clone();",
    1,
)
src = src.replace(
    "attach_core_listeners(&app2, &label2, &core);",
    "attach_core_listeners(&app2, self_webviews.clone(), &label2, &core);",
    1,
)
# pass the map into build's chain
src = src.replace(
    "            let label2 = label.clone();\n            let app2 = self.app.clone();\n            let url2 = url.to_string();",
    "            let label2 = label.clone();\n            let app2 = self.app.clone();\n            let url2 = url.to_string();\n            let self_webviews = self.webviews.clone();",
    1,
)

# 2. f(&pane.core.0) -> f(pane.core.0.clone())
src = src.replace("let out = f(&pane.core.0);", "let out = f(pane.core.0.clone());", 1)

# 3. options method name
src = src.replace(
    'options.set_additional_browser_args("--disable-features',
    'options.set_additional_browser_arguments("--disable-features',
    1,
)

# 4. hwnd pointer -> HWND struct
src = src.replace(
    """            let hwnd = main_window
                .hwnd()
                .map_err(|e| format!("main window hwnd unavailable: {e}"))?
                .0;""",
    """            let hwnd = windows::Win32::Foundation::HWND(
                main_window
                    .hwnd()
                    .map_err(|e| format!("main window hwnd unavailable: {e}"))?
                    .0,
            );""",
    1,
)

# 5. OpenDevTools -> OpenDevToolsWindow (bindings name)
src = src.replace("unsafe { core.OpenDevTools() };", "unsafe { core.OpenDevToolsWindow() };", 1)

# 6. second eval site (evaluate_for_pane path) — read around 1702 and rewrite via with_core
old = """        if let Err(e) = pane.webview.eval(&js) {"""
assert old in src, "eval site 1702"
# find enclosing fn to see variable names
i = src.index(old)
seg = src[max(0, i - 700):i + 200]
io.open("_seg.txt", "w", encoding="utf-8").write(seg)

io.open(p, "w", encoding="utf-8", newline="\n").write(src)
print("patch5 ok")
