//! HTML → PDF print engine for the chat `generate_document` tool (Windows).
//!
//! The model authors a complete HTML document; we render it in a hidden
//! WebView2 window with the Paged.js polyfill (real `@page` margin boxes,
//! page numbers, running headers, TOC page refs) and capture it with
//! WebView2's native `PrintToPdf` — browser-grade CSS/Unicode/CJK fidelity
//! with zero additional runtime, because the Evergreen WebView2 runtime is
//! already the app's Windows webview.
//!
//! Threading: the WebView2 COM surface is thread-affine, so the whole
//! navigate → wait-for-render → print sequence runs inside a single
//! `with_webview` closure on the UI thread, exactly like the CapturePreview
//! path in `browser.rs`. `wait_for_async_operation` pumps the message loop
//! while each COM call completes, so the app stays responsive between the
//! ~150 ms render polls; page rendering itself happens in separate WebView2
//! renderer processes and is never blocked by the host thread.

use std::path::Path;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Hidden render window label. One window is created lazily and reused for
/// every PDF render (navigation replaces the document each time).
const PRINT_WINDOW_LABEL: &str = "conduit-pdf-print";

/// Overall wall-clock budget for one render (page JS + print). Generous
/// because Paged.js pagination of a 100+ page document takes seconds.
const RENDER_TIMEOUT: Duration = Duration::from_secs(90);

/// Poll interval while waiting for the page to report render completion.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Paged.js auto-paginator (MIT, https://pagedjs.org) — vendored from
/// node_modules/pagedjs/dist/paged.polyfill.min.js so the print document is
/// fully self-contained and offline.
const PAGED_JS: &str = include_str!("paged.polyfill.min.js");

/// Base print CSS. Defaults only — the model's own <style> blocks are
/// injected AFTER this sheet and win the cascade. Paged.js consumes the
/// `@page` rule to build its page boxes with margin boxes.
const BASE_CSS: &str = r#"
@page { size: A4; margin: 20mm 17mm; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  color: #1a1a1a; line-height: 1.55; font-size: 11pt;
}
h1, h2, h3, h4 { line-height: 1.2; margin: 1.4em 0 0.5em; }
h1 { font-size: 24pt; } h2 { font-size: 17pt; } h3 { font-size: 13.5pt; }
p { margin: 0.55em 0; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 6px 9px; text-align: left; }
th { background: #f3f4f6; }
blockquote { margin: 1em 0; padding: 0.4em 1em; border-left: 3px solid #bbb; color: #444; }
code, pre { font-family: Consolas, monospace; font-size: 9.5pt; }
pre { background: #f6f6f6; padding: 10px 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
img { max-width: 100%; }
a { color: #1156d6; text-decoration: none; }
@media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
"#;

/// Bootstrap script injected before Paged.js: a completion flag the host
/// polls via `ExecuteScript`, wired into PagedConfig.after, plus safety
/// valves (render error capture and a no-Paged fallback timer).
const BOOTSTRAP_JS: &str = r#"
window.__renderState = 'working';
window.addEventListener('error', function (e) {
  if (window.__renderState === 'working') window.__renderState = 'error: ' + e.message;
});
window.PagedConfig = {
  auto: true,
  after: function () { window.__renderState = 'done'; }
};
"#;

/// Fallback tail script: if Paged.js never ran (missing/failed), declare the
/// plain document done after a grace period so the print still happens.
const FALLBACK_JS: &str = r#"
window.addEventListener('load', function () {
  setTimeout(function () {
    if (window.__renderState === 'working') window.__renderState = 'done';
  }, 2500);
});
"#;

/// Compose the final print document. If the model authored a full HTML
/// document our CSS/scripts are spliced into <head> (after its own <style>,
/// so the model can still override base rules — wait, base CSS first, model
/// CSS after: we splice ours immediately BEFORE the model's first <style> if
/// one exists, else at the end of <head>); fragments are wrapped in a
/// skeleton. Everything is injected once; double injection is impossible
/// because each render uses a fresh temp file.
pub(crate) fn compose_print_document(model_html: &str, title: &str) -> String {
    let head_inject = format!(
        "<title>{}</title>\n<style>{BASE_CSS}</style>\n<script>{BOOTSTRAP_JS}</script>\n<script>{PAGED_JS}</script>\n<script>{FALLBACK_JS}</script>\n",
        html_escape(title),
    );
    let lower = model_html.to_ascii_lowercase();
    let trimmed = model_html.trim_start();

    if lower.contains("<html") {
        // Full document: splice our block into <head> if present (before the
        // model's first <style> so its styles win the cascade), else before
        // </head>, else before <body>.
        if let Some(style_pos) = lower.find("<style") {
            return format!("{}\n{head_inject}{}", &trimmed[..style_pos], &trimmed[style_pos..]);
        }
        if let Some(pos) = lower.find("</head>") {
            return format!("{}\n{head_inject}{}", &trimmed[..pos], &trimmed[pos..]);
        }
        if let Some(pos) = lower.find("<body") {
            return format!("{}\n{head_inject}{}", &trimmed[..pos], &trimmed[pos..]);
        }
        return format!("{trimmed}\n{head_inject}");
    }
    // Fragment: wrap in a standards-mode skeleton.
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n{head_inject}</head>\n<body>\n{trimmed}\n</body>\n</html>\n"
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Render `model_html` to `out_path` (PDF bytes) using the hidden WebView2
/// print window. Windows-only; other platforms return a descriptive error so
/// the caller can fall back to the Python engine.
pub async fn render_html_to_pdf(
    app: &AppHandle,
    model_html: &str,
    out_path: &Path,
    title: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let doc = compose_print_document(model_html, title);
        // Serialize renders: one hidden window serves every request and a
        // second navigation mid-render would corrupt the first.
        static RENDER_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
            once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));
        let _guard = RENDER_LOCK.lock().await;

        let window = get_or_create_print_window(app)?;
        let out_display = out_path.display().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        window
            .with_webview(move |platform_webview| {
                let result = print_via_webview(&platform_webview, &doc, &out_display);
                let _ = tx.send(result);
            })
            .map_err(|e| format!("could not reach the print webview: {e}"))?;

        // The closure runs asynchronously on the UI thread; bound the wait.
        match tokio::time::timeout(RENDER_TIMEOUT + Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("PDF print worker was dropped (window closed mid-render).".to_string()),
            Err(_) => Err(format!(
                "HTML→PDF render timed out after {}s (page kept for inspection: print window stays open).",
                (RENDER_TIMEOUT + Duration::from_secs(30)).as_secs()
            )),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (app, model_html, out_path, title);
        Err("The HTML→PDF print engine requires the WebView2 runtime (Windows). \
             Re-run with language=\"python\" to use the ReportLab engine instead."
            .to_string())
    }
}

/// Fetch the shared hidden print window, creating it on first use.
#[cfg(windows)]
fn get_or_create_print_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        return Ok(existing);
    }
    build_print_window(app)
}

/// Create the hidden print window. Called eagerly from app setup (main
/// thread) and lazily as a fallback if the window was closed since.
#[cfg(windows)]
pub fn ensure_print_window(app: &AppHandle) -> Result<(), String> {
    build_print_window(app).map(|_| ())
}

#[cfg(windows)]
fn build_print_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    let url = WebviewUrl::External("about:blank".parse().map_err(|e| format!("bad url: {e}"))?);
    WebviewWindowBuilder::new(app, PRINT_WINDOW_LABEL, url)
        .title("Conduit document renderer")
        .visible(false)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(900.0, 1180.0) // ≥ one A4 page box (~794px) so Paged.js never overflows horizontally
        .build()
        .map_err(|e| format!("could not create the hidden print window: {e}"))
}

/// The full COM sequence on the UI thread: navigate → poll render state →
/// print to PDF file. Runs synchronously inside `with_webview`; the
/// `wait_for_async_operation` helper pumps the message loop so the app and
/// the in-page renderer keep making progress while we wait.
#[cfg(windows)]
fn print_via_webview(
    webview: &tauri::webview::PlatformWebview,
    doc_html: &str,
    out_path: &str,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};

    // Write the self-contained print document to a temp file (no size limit,
    // unlike NavigateToString) and hand WebView2 a file:/// URL.
    let temp_dir = std::env::temp_dir();
    let file_name = format!(
        "conduit-print-{}.html",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let temp_html = temp_dir.join(&file_name);
    std::fs::write(&temp_html, doc_html)
        .map_err(|e| format!("could not write the print document: {e}"))?;
    let file_url = format!(
        "file:///{}",
        temp_html.to_string_lossy().replace('\\', "/")
    );

    let cleanup = |result: Result<(), String>| -> Result<(), String> {
        let _ = std::fs::remove_file(&temp_html);
        result
    };

    let core = unsafe { webview.controller().CoreWebView2() }
        .map_err(|e| format!("webview core unavailable: {e}"))?;

    // Navigate. Result arrives asynchronously; the first polls below may run
    // against the previous (about:blank) document — they just report "working".
    let nav_url = HSTRING::from(file_url);
    unsafe { core.Navigate(&nav_url) }.map_err(|e| format!("navigation failed: {e}"))?;

    // Poll `window.__renderState` until done/error/timeout. Each poll is a
    // pumped async call; a poll failure (navigation tearing the script
    // context) is retried until the deadline. wait_for_async_operation only
    // returns the COM status, so the script result comes back through a slot
    // captured by the completed-closure.
    let script = HSTRING::from("String(window.__renderState)");
    let deadline = Instant::now() + RENDER_TIMEOUT;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if Instant::now() >= deadline {
            return cleanup(Err(format!(
                "document render timed out after {}s (Paged.js pagination did not finish).",
                RENDER_TIMEOUT.as_secs()
            )));
        }
        let slot: std::sync::Arc<std::sync::Mutex<Option<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let slot_for_closure = slot.clone();
        let poll: webview2_com::Result<()> = {
            let core = core.clone();
            let script = script.clone();
            ExecuteScriptCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    core.ExecuteScript(&script, &handler)
                        .map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |error_code, result_json| {
                    *slot_for_closure.lock().unwrap() = Some(result_json);
                    error_code
                }),
            )
        };
        let state = poll.ok().and_then(|_| slot.lock().unwrap().take());
        match state.as_deref() {
            Some("\"done\"") => break,
            Some(s) if s.starts_with("\"error") => {
                let msg = s.trim_matches('"');
                return cleanup(Err(format!(
                    "document render failed: {msg}. Check the HTML/CSS for script errors."
                )));
            }
            _ => continue, // "working", null (script context not ready), or poll failure
        }
    }

    // Print settings: A4 paper, zero printer margins (Paged.js owns margins
    // via the @page rule), backgrounds on, headers/footers off.
    let environment = {
        let core2 = core
            .cast::<ICoreWebView2_2>()
            .map_err(|e| format!("missing ICoreWebView2_2: {e}"))?;
        unsafe { core2.Environment() }.map_err(|e| format!("environment unavailable: {e}"))?
    };
    let environment6 = environment
        .cast::<ICoreWebView2Environment6>()
        .map_err(|e| format!("missing ICoreWebView2Environment6 (WebView2 runtime too old): {e}"))?;
    let settings = unsafe { environment6.CreatePrintSettings() }
        .map_err(|e| format!("CreatePrintSettings failed: {e}"))?;
    unsafe {
        settings.SetPageWidth(8.27); // A4 in inches — must match the @page size
        settings.SetPageHeight(11.69);
        settings.SetMarginTop(0.0);
        settings.SetMarginBottom(0.0);
        settings.SetMarginLeft(0.0);
        settings.SetMarginRight(0.0);
        settings.SetScaleFactor(1.0);
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT);
        settings.SetShouldPrintBackgrounds(true);
        settings.SetShouldPrintHeaderAndFooter(false);
    }

    let core7 = core
        .cast::<ICoreWebView2_7>()
        .map_err(|e| format!("missing ICoreWebView2_7 (WebView2 runtime too old): {e}"))?;
    let out_target = HSTRING::from(out_path);
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
                Err(windows::core::Error::from(windows::core::HRESULT(-2147467259))) // E_FAIL
            }
        }),
    )
    .map_err(|e| format!("PrintToPdf failed: {e}"))?;

    if !std::path::Path::new(out_path).is_file() {
        return cleanup(Err("PrintToPdf completed but produced no file.".to_string()));
    }
    cleanup(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_gets_full_skeleton() {
        let doc = compose_print_document("<h1>Hi</h1>", "T");
        assert!(doc.starts_with("<!doctype html>"));
        assert!(doc.contains("<style>"));
        assert!(doc.contains("paged"));
        assert!(doc.contains("<h1>Hi</h1>"));
        assert!(doc.contains("__renderState"));
    }

    #[test]
    fn full_document_is_spliced_into_head() {
        let model = "<!doctype html><html><head><style>p{color:red}</style></head><body><p>x</p></body></html>";
        let doc = compose_print_document(model, "T");
        // Our sheet lands BEFORE the model's <style>, so the model wins.
        let ours = doc.find("Segoe UI").unwrap();
        let theirs = doc.find("p{color:red}").unwrap();
        assert!(ours < theirs);
        assert!(doc.contains("<p>x</p>"));
        // Model content is never duplicated.
        assert_eq!(doc.matches("p{color:red}").count(), 1);
    }

    #[test]
    fn full_document_without_head_style_still_spliced() {
        let model = "<html><head><title>x</title></head><body>hi</body></html>";
        let doc = compose_print_document(model, "T");
        assert!(doc.contains("__renderState"));
        assert!(doc.contains("<title>x</title>"));
    }

    #[test]
    fn title_is_escaped() {
        let doc = compose_print_document("<p>x</p>", "<b>&</b>");
        assert!(doc.contains("&lt;b&gt;&amp;&lt;/b&gt;"));
    }
}
