//! Native browser-pane commands (child webviews; see src/browser.rs).
//!
//! All commands return a clean error on Linux — the frontend detects that
//! from browser_create and falls back to the iframe implementation.

use tauri::{Emitter, State};

use crate::browser::Rect;
use crate::types::BrowserNavigatedEvent;
use crate::BrowserState;

type CmdResult<T> = Result<T, String>;

// The create command is async so it runs on a Tauri async worker thread, not
// the main thread. That way if add_child hangs (WebView2 init deadlock), only
// the worker thread blocks — the main thread and other commands stay alive.
#[tauri::command]
pub async fn browser_create(
    pane_id: String,
    tab_id: String,
    url: String,
    rect: Rect,
    project_id: Option<String>,
    browser: State<'_, BrowserState>,
) -> CmdResult<()> {
    browser
        .0
        .create(&pane_id, &tab_id, &url, rect, project_id.as_deref())
}

#[tauri::command]
pub fn browser_navigate(
    app: tauri::AppHandle,
    pane_id: String,
    tab_id: String,
    url: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    // The user navigating manually re-arms a stopped agent (sticky cancel).
    browser.0.clear_cancelled(&pane_id);
    browser.0.navigate(&app, &pane_id, &tab_id, &url)
}

/// Open the WebView2 DevTools window for a pane's webview (roadmap #15):
/// console + network + DOM inspection for agent debugging.
#[tauri::command]
pub fn browser_open_devtools(
    pane_id: String,
    tab_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.open_devtools(&pane_id, &tab_id)
}

/// Called from injected JS in the webview whenever history.pushState or
/// history.replaceState fires. Emits browser:navigated so the frontend's
/// address bar + history stack stay in sync with same-document navigations
/// (e.g. Bing's Images/Videos/Maps tabs, SPAs).
///
/// SECURITY: `javascript:` URLs are rejected to prevent XSS if the user
/// navigates back to a pushed state that executes script in the webview's
/// origin.
#[tauri::command]
pub fn browser_push_state(
    pane_id: String,
    tab_id: String,
    url: String,
    app: tauri::AppHandle,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    if url.trim().to_lowercase().starts_with("javascript:") {
        return Err("javascript: URLs are not allowed in pushState".to_string());
    }
    browser.0.remember_tab_url(&crate::browser::browser_label(&pane_id, &tab_id), &url);
    let _ = app.emit(
        "browser:navigated",
        BrowserNavigatedEvent {
            pane_id,
            tab_id,
            url,
        },
    );
    Ok(())
}

/// Called from the injected bridge when a page's document title settles (on
/// every post-nav injection pass, plus NavigationCompleted on Windows). Emits
/// `browser:title` so the frontend can label the tab + derive a favicon.
/// Purely cosmetic: a page can spoof its own title anyway.
#[tauri::command]
pub fn browser_report_title(
    pane_id: String,
    tab_id: String,
    title: String,
    app: tauri::AppHandle,
) -> CmdResult<()> {
    let _ = app.emit(
        "browser:title",
        crate::types::BrowserTitleEvent {
            pane_id,
            tab_id,
            title,
        },
    );
    Ok(())
}

/// Called from an agentic action's injected JS to report its result back to
/// the backend, keyed by the request id the backend assigned. Resolves the
/// pending oneshot the `browser_read`/`browser_click`/etc. tool is awaiting.
#[tauri::command]
pub fn browser_action_result(
    req_id: u64,
    nonce: Option<String>,
    result: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    // B-3: verify the per-action nonce when the caller supplied one (the
    // injected wrapper always does). Pages loaded in a browser pane are
    // untrusted and req ids are sequential/guessable — the nonce is the
    // shared secret only the wrapper that launched the action knows.
    match nonce {
        Some(n) => browser.0.resolve_action_verified(req_id, &n, result),
        None => browser.0.resolve_action(req_id, result),
    }
    Ok(())
}

#[tauri::command]
pub fn browser_go_back(
    pane_id: String,
    tab_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.go_back(&pane_id, &tab_id)
}

#[tauri::command]
pub fn browser_go_forward(
    pane_id: String,
    tab_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.go_forward(&pane_id, &tab_id)
}

#[tauri::command]
pub fn browser_reload(
    pane_id: String,
    tab_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.reload(&pane_id, &tab_id)
}

#[tauri::command]
pub fn browser_set_bounds(
    pane_id: String,
    tab_id: String,
    rect: Rect,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.set_bounds(&pane_id, &tab_id, rect)
}

#[tauri::command]
pub fn browser_set_visible(
    pane_id: String,
    tab_id: String,
    visible: bool,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.set_visible(&pane_id, &tab_id, visible)
}

#[tauri::command]
pub fn browser_close(
    pane_id: String,
    tab_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.close(&pane_id, &tab_id)
}

/// Close ALL tab webviews for a pane (used when the entire pane is closed).
#[tauri::command]
pub fn browser_close_pane(
    pane_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.close_pane_tabs(&pane_id)
}

// --- Browser pane project registry + MCP roundtrip commands ----------
// These allow the MCP WebSocket server (Task #4) to resolve a project_id
// to a browser pane via a frontend roundtrip, and to auto-open panes.

#[tauri::command]
pub fn register_browser_pane_project(
    pane_id: String,
    project_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.register_browser_pane_project(&pane_id, &project_id);
    Ok(())
}

#[tauri::command]
pub fn unregister_browser_pane_project(
    pane_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.unregister_browser_pane_project(&pane_id);
    Ok(())
}

#[tauri::command]
pub fn browser_resolve_pane_result(
    req_id: u64,
    pane_id: Option<String>,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.resolve_pane_request_resolve(req_id, pane_id);
    Ok(())
}

#[tauri::command]
pub fn browser_open_pane_result(
    req_id: u64,
    pane_id: Option<String>,
    tab_id: Option<String>,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.open_pane_request_resolve(req_id, pane_id, tab_id);
    Ok(())
}

// --- Trust layer (Phase 2): gate confirmations, pause/stop, timeline ------

/// The user's answer to a `browser:confirm-request` gate prompt.
/// `always_for_site` persists per-origin consent for the same risk class.
#[tauri::command]
pub fn browser_confirm_result(
    req_id: u64,
    approved: bool,
    always_for_site: bool,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.gate_request_resolve(
        req_id,
        crate::browser::GateAnswer { approved, always_for_site },
    );
    Ok(())
}

/// Pause/resume agent browser actions for a pane (the pane's own user
/// controls; the page and the user's typing are unaffected).
#[tauri::command]
pub fn browser_set_agent_paused(
    pane_id: String,
    paused: bool,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.set_paused(&pane_id, paused);
    Ok(())
}

/// Stop the agent for a pane: sticky cancel + drain in-flight actions with
/// `cancelled_by_user`. Cleared by the next manual navigation.
#[tauri::command]
pub fn browser_cancel_agent(
    pane_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.cancel_agent(&pane_id);
    Ok(())
}

/// Clear the current site's session (page-visible cookies + storage) for a
/// pane and reload — the trust strip's "clear this site" escape hatch.
#[tauri::command]
pub fn browser_clear_site_data(
    pane_id: String,
    tab_id: String,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.clear_site_session(&pane_id, &tab_id)
}

/// Snapshot the pane's user-owned action timeline (oldest first).
#[tauri::command]
pub fn browser_timeline(
    pane_id: String,
    browser: State<BrowserState>,
) -> CmdResult<Vec<crate::browser::TimelineEntry>> {
    Ok(browser.0.timeline_for_pane(&pane_id))
}

/// Answer a tab-management roundtrip (switch/new/close) from the frontend.
/// `tab_id` echoes the affected tab; None = the operation failed (unknown
/// pane/tab, or the pane's last tab refused to close).
#[tauri::command]
pub fn browser_tab_result(
    req_id: u64,
    tab_id: Option<String>,
    browser: State<BrowserState>,
) -> CmdResult<()> {
    browser.0.tab_request_resolve(req_id, tab_id);
    Ok(())
}
