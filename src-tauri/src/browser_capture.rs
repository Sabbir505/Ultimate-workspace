//! Browser-pane screenshot capture (Windows-only stub).
//!
//! `BrowserManager::capture_active_png` is the public entry point the chat
//! tool calls. The actual WebView2 CapturePreview roundtrip is a Windows
//! COM call (UI-thread `ICoreWebView2_15::CapturePreview`) that pulls a
//! PNG off the active webview without going through the screen — so the
//! pane's actual on-screen content, not a window snapshot, is what gets
//! returned.
//!
//! The full Windows implementation is tracked as a follow-up (it depends
//! on the `webview2-com` 0.30 surface being available in the
//! `tauri = "2"` release this crate pins to). The rot fix gets us a
//! compiling `capture_active_png` that returns `Ok(None)` on every
//! platform, so the chat dispatch compiles and the `browser_screenshot`
//! tool surfaces a clean "capture unavailable" error to the model instead
//! of a panic.
//!
//! Why the split: keeping the stub here (separate file) means the actual
//! Win32 implementation can land later without touching `browser.rs` —
//! it's a pure additive change to this file. No `unsafe` was added by
//! the rot fix.

#[cfg(windows)]
pub fn capture_active_png(
    mgr: &crate::browser::BrowserManager,
) -> Result<Option<Vec<u8>>, String> {
    // Stub: real implementation will call ICoreWebView2_15::CapturePreview
    // on the active webview. Until the COM bindings land, return Ok(None)
    // — the chat tool degrades to a descriptive error message.
    let _ = mgr;
    Ok(None)
}
