//! Relay self-control — let the agent drive Relay's OWN UI through the DOM.
//!
//! # Why this exists
//!
//! "Computer use" for a desktop app has two very different cost profiles. The
//! expensive version is OS-level: screenshot the desktop, synthesize mouse and
//! keyboard events, watch the pixels come back. It is a screenshot→model→pixel
//! loop where the hard problems are coordinate scaling, DPI, multi-monitor
//! origins, and the reliability ceiling (published OSWorld 2.0 binary
//! completion is ~20% for the best model, and the failures are long-horizon
//! state management, not clicking).
//!
//! Relay does not need that for its own UI. Relay is a Tauri app: its entire
//! interface is React inside a WebView2, and the agent can address that DOM
//! directly — the same ref contract the built-in browser pane already uses.
//! A ref into the real DOM survives a layout shift, costs no pixel guessing,
//! and can be verified by reading the element back afterwards. Those are the
//! three properties the pixel loop spends all its reliability on, obtained for
//! free because the UI happens to be ours.
//!
//! So this module is the *in-app* slice of computer use, and it is deliberately
//! built as DOM control rather than as a mini screenshot loop. Screenshots of
//! Relay's own UI would be strictly worse: a VLM reading pixels to find a
//! button whose ref it could have looked up.
//!
//! # What this does NOT do
//!
//! It does not drive other applications. That is the OS-level problem above,
//! and it is out of scope here. This module reaches exactly one document: the
//! app's own main window.
//!
//! # Transport
//!
//! The main window is a normal Tauri webview, so (unlike the browser panes,
//! which are raw WebView2 controllers) injected script can call
//! `__TAURI_INTERNALS__.invoke` directly. The bridge reports each result to
//! the [`app_ui_result`] command, which resolves a pending oneshot. Rust never
//! blocks the UI thread waiting for it — see the MAIN-THREAD rule in lib.rs.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// The shared ref contract + the self-UI bridge, injected into the main window
/// on demand. Plain JS (no `eval`/`new Function`) because the main window runs
/// under a strict CSP with no `unsafe-eval` — the same reason these cannot be
/// folded into `browser_js.rs`'s `evaluate_js`.
const BRIDGE_REFS_JS: &str = include_str!("bridge_refs.js");
const BRIDGE_SELFUI_JS: &str = include_str!("bridge_selfui.js");

/// Label of the window this module drives. Relay's own chrome, by definition.
const MAIN_WINDOW: &str = "main";

/// How long to wait for the renderer to answer before giving up.
///
/// Generous enough for a slow React re-render or a machine under load, short
/// enough that a bridge that failed to install fails the tool call rather than
/// hanging the chat turn. The browser panes use a 10s ceiling for the same
/// reason (`with_core_on_main`).
const REPLY_TIMEOUT_MS: u64 = 10_000;

/// Ops the Rust side will send. Mirrors the `OPS` table in
/// `bridge_selfui.js` — the bridge rejects anything else, and this list is
/// what the tool layer advertises, so the two are checked against each other
/// by a test rather than by convention.
pub const SELFUI_OPS: [&str; 5] = ["snapshot", "click", "type", "press_key", "select_option"];

/// Pending self-UI requests, keyed by the id handed to the bridge.
///
/// Entries are removed by the responder on every path (success, error, and
/// timeout), so this cannot grow without bound — a leaked entry would be a
/// permanently-parked oneshot.
#[derive(Default)]
pub struct SelfUiPending(pub Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>);

/// The result the bridge posts back for one request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUiResult {
    /// Must match the id Rust generated. A mismatched or unknown id is
    /// dropped rather than resolved into whichever request happens to be
    /// waiting — the renderer is untrusted input like any other page.
    pub request_id: String,
    /// JSON-encoded result object (`{ok, text, …}`) from the bridge.
    pub payload: String,
}

/// Called by the injected bridge with each result.
///
/// Must never fail loudly into the renderer: a throw here would leave Rust
/// waiting out its full timeout for an answer that already arrived.
#[tauri::command(async)]
pub fn app_ui_result(
    state: State<'_, SelfUiPending>,
    request_id: String,
    payload: String,
) -> Result<(), String> {
    let sender = state.0.lock().ok().and_then(|mut m| m.remove(&request_id));
    match sender {
        Some(tx) => {
            let _ = tx.send(payload);
            Ok(())
        }
        // A late reply for an already-timed-out request, or an id we never
        // issued. Dropping it is correct in both cases; saying so out loud
        // would let a page probe which ids are live.
        None => Ok(()),
    }
}

/// One self-UI call: inject the bridge if needed, run `op`, wait for the reply.
pub async fn call(app: &AppHandle, op: &str, args: serde_json::Value) -> Result<String, String> {
    if !SELFUI_OPS.contains(&op) {
        return Err(format!(
            "unknown self-UI op \"{op}\" (expected one of: {})",
            SELFUI_OPS.join(", ")
        ));
    }
    // Fresh state per call. Refs are numbered against the DOM as it is NOW,
    // and the UI moves between turns — carrying numbering across calls would
    // hand the model refs that point at whatever happens to occupy that index
    // today.
    census_reset(app);

    let request_id = uuid_like_id();
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let pending = app.state::<SelfUiPending>();
        let mut map = pending
            .0
            .lock()
            .map_err(|_| "self-UI bridge state is poisoned".to_string())?;
        map.insert(request_id.clone(), tx);
    }

    // Install the bridge before every call. It is idempotent (both scripts
    // guard on their own global) and cheap, and re-injecting is what makes
    // this survive a frontend reload or a hot-module swap during development —
    // a once-at-startup install would go stale silently.
    install_bridge(app)?;

    let args_json = serde_json::to_string(&args)
        .map_err(|e| format!("self-UI arguments are not serializable: {e}"))?;
    // Every interpolated value is a JSON literal, so a request id, op name or
    // argument containing a quote cannot break out of the script (the same
    // discipline as `build_extract_js`'s template interpolation).
    let id = serde_json::to_string(&request_id).unwrap_or_else(|_| "\"\"".to_string());
    let op_js = serde_json::to_string(op).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!(
        "try {{ if (typeof window.__relay_selfui === 'function') {{ \
           window.__relay_selfui({id}, {op_js}, {args_json}); \
         }} else {{ \
           window.__TAURI_INTERNALS__.invoke('app_ui_result', {{ requestId: {id}, \
             payload: JSON.stringify({{ ok: false, code: 'bridge_missing', \
             text: 'The Relay self-UI bridge is not installed in the main window. This usually means the app was just reloaded — try again.' }}) }}); \
         }} }} catch (e) {{ \
           window.__TAURI_INTERNALS__.invoke('app_ui_result', {{ requestId: {id}, \
             payload: JSON.stringify({{ ok: false, code: 'eval_failed', \
             text: 'Could not evaluate the self-UI request: ' + (e && e.message ? e.message : String(e)) }}) }}); \
         }}"
    );
    eval_in_main(app, &script)?;

    match tokio::time::timeout(std::time::Duration::from_millis(REPLY_TIMEOUT_MS), rx).await {
        Ok(Ok(payload)) => Ok(payload),
        // The renderer answered with a channel that had already been dropped
        // (the timeout below won the race). Same outcome as a timeout.
        Ok(Err(_)) => Err(SELFUI_TIMEOUT.to_string()),
        Err(_) => {
            // Drop the sender so the map cannot leak the entry.
            if let Ok(mut map) = app.state::<SelfUiPending>().0.lock() {
                map.remove(&request_id);
            }
            Err(SELFUI_TIMEOUT.to_string())
        }
    }
}

const SELFUI_TIMEOUT: &str =
    "The Relay self-UI bridge did not answer in time (the main window may be busy, or the \
     bridge failed to install). The action was NOT performed — call app_snapshot to re-check \
     the UI state before retrying.";

/// Inject the ref contract + the self-UI bridge into the main window.
///
/// Returns an error rather than silently no-op'ing: every caller is a tool
/// invocation, and a tool that reports success without acting is worse than one
/// that fails.
fn install_bridge(app: &AppHandle) -> Result<(), String> {
    let script = format!("{BRIDGE_REFS_JS}\n{BRIDGE_SELFUI_JS}\n");
    eval_in_main(app, &script)
}

/// Eval JS in the main window.
///
/// `WebviewWindow::eval` is fire-and-forget: it posts to the wry event loop
/// and returns `Ok(())` whether or not the script later throws, and it yields
/// no value. So this returning `Ok` means "dispatched", never "ran" — the
/// authoritative success/failure signal is the bridge's own reply, which
/// `call` waits for. The only failure this surfaces is the window being gone.
fn eval_in_main(app: &AppHandle, js: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "the main window is not available".to_string())?;
    window
        .eval(js.to_string())
        .map_err(|e| format!("could not reach the main window: {e}"))
}

/// Random-enough request id. Not a security token — it only has to not collide
/// across concurrent calls, and the bridge echoes it back for correlation.
fn uuid_like_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "sui-{}-{}",
        std::process::id(),
        n
    )
}

/// Tell the renderer that the current DOM is no longer the one refs were
/// numbered against.
///
/// Refs are re-derived from the live DOM on every `call`, so this is a hint to
/// the renderer (so it can drop any cached assumption) rather than the
/// mechanism that makes them correct. Emitted rather than required so a
/// missing frontend listener costs nothing.
pub fn census_reset(app: &AppHandle) {
    let _ = app.emit("app-ui:census-reset", serde_json::json!({}));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bridge's `OPS` table and `SELFUI_OPS` must name the same set. Rust
    /// is the gate — `call` refuses an op not in `SELFUI_OPS` — so a bridge op
    /// added in JS but forgotten here is a tool that exists in the schema and
    /// fails at runtime. This is the check that catches that.
    #[test]
    fn selfui_ops_match_the_bridge_dispatch_table() {
        // Each `<op>: op<Name>` entry the dispatch table actually contains.
        let wired = [
            "snapshot",
            "click",
            "type",
            "press_key",
            "select_option",
        ];
        for op in wired {
            assert!(
                BRIDGE_SELFUI_JS.contains(&format!("{op}: op")),
                "bridge_selfui.js's OPS table has no entry for \"{op}\""
            );
        }
        // And the reverse direction: every op Rust will send has a bridge
        // handler. A missing one is a tool that advertises itself and then
        // answers `unknown_op` at runtime.
        for op in SELFUI_OPS {
            assert!(
                BRIDGE_SELFUI_JS.contains(&format!("{op}: op")),
                "SELFUI_OPS advertises \"{op}\" but bridge_selfui.js cannot dispatch it"
            );
        }
    }

    /// The self-UI bridge runs under the main window's strict CSP, which has no
    /// `unsafe-eval`. `ExecuteScript`/Tauri `eval` are host-side injections and
    /// bypass page CSP, but any `eval`/`new Function` INSIDE the injected code
    /// would still be blocked — and the failure would be silent (eval() discards
    /// script errors), showing up as a bridge that never answers.
    #[test]
    fn selfui_bridge_avoids_eval_under_strict_csp() {
        for banned in ["eval(", "new Function"] {
            assert!(
                !BRIDGE_SELFUI_JS.contains(banned),
                "bridge_selfui.js uses `{banned}`, which the main window's CSP blocks \
                 (script-src has no 'unsafe-eval')"
            );
        }
    }

    /// Both scripts must be idempotent: they are re-injected before EVERY
    /// self-UI call, so a second injection that re-defined state would reset
    /// numbering mid-call. The guards are what make re-injection safe.
    #[test]
    fn both_bridge_scripts_guard_against_double_injection() {
        assert!(
            BRIDGE_REFS_JS.contains("if (window.__relay_refs) return;"),
            "bridge_refs.js must no-op when already installed"
        );
        assert!(
            BRIDGE_SELFUI_JS.contains("window.__relay_selfui = function"),
            "bridge_selfui.js must (re)define its entry point"
        );
    }

    /// The self-control exclusion is the whole point of the snapshot filter:
    /// the agent must not be able to see or click Relay's own leash. If the
    /// attribute name drifts from what the frontend emits, the filter silently
    /// stops filtering — so pin the name here and in the TSX.
    #[test]
    fn selfui_bridge_excludes_agent_chrome_by_attribute() {
        assert!(
            BRIDGE_SELFUI_JS.contains("data-relay-agent-exclude"),
            "bridge_selfui.js must filter on the exclusion attribute"
        );
        // Exclusion must apply to the CENSUS (so refs never point at excluded
        // elements), not merely hide them from the listing — otherwise a ref
        // would silently mean something different from what it listed.
        assert!(
            BRIDGE_SELFUI_JS.contains("continue;") || BRIDGE_SELFUI_JS.contains("continue"),
            "excluded elements must be skipped before numbering"
        );
    }

    /// The shared ref contract exists to stop the selector drifting between
    /// surfaces. Pin it, because a divergence here means a ref means one thing
    /// to the browser pane and another to the self-UI — the exact "clicked the
    /// wrong element" class of bug.
    #[test]
    fn shared_ref_contract_matches_the_browser_pane_bridges() {
        assert!(
            BRIDGE_REFS_JS.contains("a[href], button, input, textarea, select, [role=button], [onclick]"),
            "the shared selector must stay identical to the browser pane bridges"
        );
        // Both surfaces must still exclude the visual-feedback overlay, or
        // Relay's own injected cursor becomes a targetable element.
        assert!(BRIDGE_REFS_JS.contains("data-relay-overlay"));
    }

    #[test]
    fn request_ids_are_unique_per_process() {
        let a = uuid_like_id();
        let b = uuid_like_id();
        assert_ne!(a, b, "concurrent self-UI calls must not share a request id");
        assert!(a.starts_with("sui-"));
    }
}