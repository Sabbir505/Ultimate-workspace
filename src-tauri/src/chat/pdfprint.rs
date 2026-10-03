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
const PRINT_WINDOW_LABEL: &str = "relay-pdf-print";

/// Overall wall-clock budget for one render (page JS + print). Generous
/// because Paged.js pagination of a 100+ page document takes seconds.
const RENDER_TIMEOUT: Duration = Duration::from_secs(90);

/// Poll interval while waiting for the page to report render completion.
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// Paged.js auto-paginator (MIT, https://pagedjs.org) — vendored from
/// node_modules/pagedjs/dist/paged.polyfill.min.js so the print document is
/// fully self-contained and offline.
const PAGED_JS: &str = include_str!("paged.polyfill.min.js");

/// CSP for the hidden print document (audit H8).
///
/// The window navigates to a `file://` temp file containing MODEL-authored
/// HTML, and that window is reused across renders. A `file://` document in
/// WebView2 may embed OTHER local files as subresources — an
/// `<iframe src="file:///C:/Users/me/.ssh/id_rsa">` renders the victim's
/// private key into the produced PDF, a local-file READ channel that
/// bypasses the permission-gated `read_file` tooling entirely. It may also
/// `fetch()` anywhere, so model JS could exfiltrate what it read.
///
/// The renderer is fully self-contained (Paged.js + CSS inlined above), so
/// nothing legitimate needs external loads: inline scripts/styles stay
/// allowed, remote images/fonts stay allowed (fidelity), and the dangerous
/// vectors — frames, objects, forms, and any script-initiated network —
/// are refused.
const PRINT_CSP: &str = "default-src * data: blob:; \
script-src 'unsafe-inline'; \
style-src 'unsafe-inline'; \
img-src * data: blob:; \
font-src * data: blob:; \
connect-src 'none'; \
frame-src 'none'; \
child-src 'none'; \
object-src 'none'; \
form-action 'none'; \
base-uri 'none'";

/// Base print CSS, generated from the shared docdesign tokens (default
/// theme) — fonts, sizes, margins and colors all come from
/// `src/lib/docdesign/tokens.json`, not from hand-written constants here.
/// Defaults only — the model's own <style> blocks are injected AFTER this
/// sheet and win the cascade. Paged.js consumes the `@page` rule to build its
/// page boxes with margin boxes.
fn base_css() -> String {
    crate::chat::docdesign::base_css()
}

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
/// document our CSS/scripts are spliced into <head>; fragments are wrapped in
/// a skeleton. Everything is injected once; double injection is impossible
/// because each render uses a fresh temp file.
pub(crate) fn compose_print_document(model_html: &str, title: &str) -> String {
    let head_inject = format!(
        "<title>{}</title>\n<meta http-equiv=\"Content-Security-Policy\" content=\"{PRINT_CSP}\">\n<style>{}</style>\n<script>{BOOTSTRAP_JS}</script>\n<script>{PAGED_JS}</script>\n<script>{FALLBACK_JS}</script>\n",
        html_escape(title),
        base_css(),
    );
    let trimmed = model_html.trim_start();
    // ASCII lowering preserves byte offsets, so `lower` indexes `trimmed`
    // directly — computing it from the untrimmed string shifted every splice
    // position by the trimmed prefix, corrupting the injected <head> block
    // (and splitting tags) whenever the model's HTML began with whitespace.
    let lower = trimmed.to_ascii_lowercase();

    if lower.contains("<html") {
        // Full document. Strip MODEL-AUTHORED CSP metas first: a second
        // policy from the model would otherwise be enforced too (policies
        // combine, but the model controls its own directives, so it could
        // simply omit `frame-src 'none'` and re-open the iframe read channel
        // this policy closes).
        let body = strip_model_csp(&trimmed);
        // Injection point is CONTENT-INDEPENDENT: immediately after the
        // <head ...> open tag. It used to be the model's first <style> (else
        // </head>, else <body>) — but a meta CSP only governs content parsed
        // AFTER it, so a model document with a <script> before its first
        // <style> executed it with NO policy at all. Model styles still win
        // the cascade: our sheet comes first, theirs later in the head.
        let body_lower = body.to_ascii_lowercase();
        if let Some(pos) = body_lower.find("<head") {
            let open_end = match body_lower[pos..].find('>') {
                Some(off) => pos + off + 1,
                // Malformed `<head` with no `>` — append at the very end.
                None => body.len(),
            };
            return format!("{}\n{head_inject}{}", &body[..open_end], &body[open_end..]);
        }
        // No <head> at all: construct one so the policy still precedes
        // everything the model authored.
        return format!("<!doctype html>\n<html>\n<head>\n{head_inject}</head>\n{body}\n</html>\n");
    }
    // Fragment: wrap in a standards-mode skeleton.
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n{head_inject}</head>\n<body>\n{trimmed}\n</body>\n</html>\n"
    )
}

/// Remove model-authored `<meta http-equiv="Content-Security-Policy" …>`
/// tags, so a model cannot weaken (or blank) the policy we splice in — CSPs
/// are additive, but the model controls its own directives and could simply
/// omit `frame-src 'none'`, re-opening the local-file read channel PRINT_CSP
/// closes. Case-insensitive, on the same ASCII-lowered-offset convention the
/// rest of this file uses.
fn strip_model_csp(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let mut out = String::with_capacity(body.len());
    let mut cur = 0usize;
    while let Some(pos) = lower[cur..].find("<meta") {
        let start = cur + pos;
        // Unterminated `<meta` — nothing left to scan safely; keep the rest.
        let Some(off) = lower[start..].find('>') else { break };
        let tag_end = start + off + 1;
        if lower[start..tag_end].contains("content-security-policy") {
            out.push_str(&body[cur..start]);
        } else {
            out.push_str(&body[cur..tag_end]);
        }
        cur = tag_end;
    }
    out.push_str(&body[cur..]);
    out
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
        Err(
            "The HTML→PDF print engine requires the WebView2 runtime (Windows). \
             Re-run with language=\"python\" to use the ReportLab engine instead."
                .to_string(),
        )
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
        .title("Relay document renderer")
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
        "relay-print-{}.html",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let temp_html = temp_dir.join(&file_name);
    std::fs::write(&temp_html, doc_html)
        .map_err(|e| format!("could not write the print document: {e}"))?;
    let file_url = format!("file:///{}", temp_html.to_string_lossy().replace('\\', "/"));

    let core = unsafe { webview.controller().CoreWebView2() }
        .map_err(|e| format!("webview core unavailable: {e}"))?;

    // Cleanup runs on EVERY exit path (success, render error, timeout): drop
    // the temp file AND reset the reused hidden window to about:blank
    // (audit H8). The window outlives the render, so leaving the model's
    // document loaded kept its JS running and left a persistent hidden page on
    // a `file://` origin — able to navigate itself anywhere and to retain
    // whatever it had already loaded.
    let cleanup = |result: Result<(), String>| -> Result<(), String> {
        let blank = HSTRING::from("about:blank");
        let _ = unsafe { core.Navigate(&blank) };
        let _ = std::fs::remove_file(&temp_html);
        result
    };

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
        .map_err(|e| {
            format!("missing ICoreWebView2Environment6 (WebView2 runtime too old): {e}")
        })?;
    let settings = unsafe { environment6.CreatePrintSettings() }
        .map_err(|e| format!("CreatePrintSettings failed: {e}"))?;
    unsafe {
        // Every setter's HRESULT is checked: a silently-failed page-size or
        // margin setting used to produce a PDF printed with WebView2's
        // DEFAULTS — a layout-corruption bug with no error path.
        settings
            .SetPageWidth(8.27) // A4 in inches — must match the @page size
            .map_err(|e| format!("SetPageWidth failed: {e}"))?;
        settings
            .SetPageHeight(11.69)
            .map_err(|e| format!("SetPageHeight failed: {e}"))?;
        settings
            .SetMarginTop(0.0)
            .map_err(|e| format!("SetMarginTop failed: {e}"))?;
        settings
            .SetMarginBottom(0.0)
            .map_err(|e| format!("SetMarginBottom failed: {e}"))?;
        settings
            .SetMarginLeft(0.0)
            .map_err(|e| format!("SetMarginLeft failed: {e}"))?;
        settings
            .SetMarginRight(0.0)
            .map_err(|e| format!("SetMarginRight failed: {e}"))?;
        settings
            .SetScaleFactor(1.0)
            .map_err(|e| format!("SetScaleFactor failed: {e}"))?;
        settings
            .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
            .map_err(|e| format!("SetOrientation failed: {e}"))?;
        settings
            .SetShouldPrintBackgrounds(true)
            .map_err(|e| format!("SetShouldPrintBackgrounds failed: {e}"))?;
        settings
            .SetShouldPrintHeaderAndFooter(false)
            .map_err(|e| format!("SetShouldPrintHeaderAndFooter failed: {e}"))?;
    }

    let core7 = core
        .cast::<ICoreWebView2_7>()
        .map_err(|e| format!("missing ICoreWebView2_7 (WebView2 runtime too old): {e}"))?;
    let out_target = HSTRING::from(out_path);
    let printed = PrintToPdfCompletedHandler::wait_for_async_operation(
        {
            let core7 = core7.clone();
            let settings = settings.clone();
            Box::new(move |handler| unsafe {
                core7
                    .PrintToPdf(&out_target, &settings, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            })
        },
        Box::new(|error_code, succeeded| {
            error_code?;
            if succeeded {
                Ok(())
            } else {
                Err(windows::core::Error::from(windows::core::HRESULT(
                    -2147467259,
                ))) // E_FAIL
            }
        }),
    );
    // Through the same teardown as every other exit path: a failed PrintToPdf
    // used to leave the multi-MB relay-print-*.html in the user's temp dir
    // (audit L-8) — and must also blank the window (audit H8), so route the
    // error through `cleanup` instead of removing only the file.
    if let Err(e) = printed {
        return cleanup(Err(format!("PrintToPdf failed: {e}")));
    }

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
    fn leading_whitespace_does_not_corrupt_the_head_splice() {
        // The lowercase search buffer must index the SAME string the splice
        // cuts. Computed from the untrimmed input, every `</head>` position
        // shifted by the trimmed prefix and the injection landed mid-tag
        // (splitting `</head>` apart).
        let model = "  \n  <html><head><title>x</title></head><body>hi</body></html>";
        let doc = compose_print_document(model, "T");
        assert!(
            doc.contains("</head>"),
            "</head> must survive intact, got: {doc}"
        );
        let ours = doc.find("__renderState").unwrap();
        let head_close = doc.find("</head>").unwrap();
        assert!(ours < head_close, "injection must land inside <head>: {doc}");
        assert!(doc.contains("<title>x</title>"));
        // No duplicated content either way.
        assert_eq!(doc.matches("</head>").count(), 1);
    }

    #[test]
    fn title_is_escaped() {
        let doc = compose_print_document("<p>x</p>", "<b>&</b>");
        assert!(doc.contains("&lt;b&gt;&amp;&lt;/b&gt;"));
    }

    #[test]
    fn csp_precedes_any_model_script() {
        // A meta CSP only governs what is parsed AFTER it, so the injection
        // point must not be content-derived: a model <script> sitting before
        // its first <style> used to run with no policy at all.
        let model = "<html><head><script>fetch('file:///C:/x')</script>\
                     <style>p{color:red}</style></head><body>hi</body></html>";
        let doc = compose_print_document(model, "T");
        let csp = doc.find("Content-Security-Policy").unwrap();
        let script = doc.find("<script>fetch").unwrap();
        assert!(csp < script, "policy must precede the model's script: {doc}");
    }

    #[test]
    fn model_authored_csp_meta_is_stripped() {
        let model = "<html><head>\
                     <meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\">\
                     </head><body>hi</body></html>";
        let doc = compose_print_document(model, "T");
        assert_eq!(doc.matches("Content-Security-Policy").count(), 1);
        assert!(
            !doc.contains(r#"content="default-src *""#),
            "the model's own policy must be gone: {doc}"
        );
    }
}
