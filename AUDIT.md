# Project Audit Report

> **Status (2026-09-05):** this is a point-in-time audit of the v0.4.1 tree (commit `0b6e4e32`, 2026-08-31); line numbers and counts refer to that snapshot. The headline S-1 auth fail-open is **fixed** — pairing now fails closed on an empty token (`src-tauri/src/mobile/relay_crypto.rs:60`); see `FIXES.md` for the itemized fix log and verification results. Current suite health: 865 cargo-lib tests passing, 100 vitest files / 733 tests passing, `tsc --noEmit` clean.

**Project:** Relay (`relay` v0.4.1) — Tauri 2 desktop shell for AI coding agents
**Scope:** full repo — `src-tauri/src` (126 Rust files, ~73k lines), `src` (221 TS/TSX files, ~55k lines), config, CI, tests
**Method:** manual line-level review of every critical module (fs/permission/secrets/browser/codeexec by hand; agent_sessions, chat pipeline, db/automations/mobile/oauth, frontend state/ipc reviewed across four parallel deep passes), with the top-severity findings re-verified against source in a second pass. Baseline confirmed before audit: `cargo check` clean, `npx vitest run` = 491/491 tests pass.

## Summary
- Risk level: **Critical** (one exploitable auth fail-open; several silent turn-death and data-corruption bugs on realistic inputs)
- Findings: 44 total — **43 Confirmed** (verified against the working tree), **1 Likely / needs runtime verification** ([B-3], with the exact check to run)
- Confirmed bugs: 39 (S-1 + B-1…B-31 minus B-3, plus E-2…E-9; E-9 bundles 14 smaller items; P-1…P-3 counted as performance below)
- High-risk edge cases: 9 (E-1…E-9, incl. one documented-risk security posture)
- Performance issues: 7 (B-8, B-23, P-1, P-2, P-3, plus github.rs proxy spawning and the E-9 frontend growth maps)
- Most dangerous area: **the mobile relay's pairing path** (network-reachable authentication), followed by **the chat turn pipeline** (hang/panic/corruption modes that the UI presents as an endless spinner) and **`agent_sessions.rs` process lifecycle** (wedges that outlive the turn).

Severity conventions used below: *Critical* = remotely exploitable or destroys user data; *High* = breaks a core flow on realistic input; *Medium* = wrong behavior/degraded UX with a clear trigger; *Low* = hardening/doc issues.

---

## Findings

### [S-1] Mobile relay E2E pairing fails OPEN when the stored token is empty
- Severity: Critical
- Type: Security
- Status: Confirmed
- Location: `src-tauri/src/mobile/relay.rs` — `handle_connection()` — lines 503–509 (token load), 558–570 (E2E branch); `src-tauri/src/mobile/relay_crypto.rs` — `verify_pair_proof()` — lines 43–57
- Trigger: the `mobile.pairing_token` settings row is missing or the DB read errors (`unwrap_or_default()` yields `""`; note the write at relay.rs:211 is itself swallowed with `let _ =`). Any peer that can reach the relay (loopback process, or any device on the tailnet via the CGNAT bind at relay.rs:198–202) sends `Pair { proof: HMAC("", "E2E") }` — a deterministic, publicly computable value.
- Impact: full remote control of the desktop: chat turns with the user's stored API keys, `SendToSession` PTY writes, session spawn, local-model start — plus the derived session key, so the attacker also speaks "E2E".
- Evidence: `relay_crypto.rs:53–57` computes `HMAC(key=expected_token, "E2E")` and compares; with an empty key this is a known constant. The legacy token path fixed this exact bug class — `pairing_token_accepted()` (relay.rs:421–429) begins with `!expected.is_empty() &&` and its comment describes the earlier empty-token pairing hole. The E2E branch has no such check.
- How to reproduce:
  1. Delete the `mobile.pairing_token` row from `app_settings` (or make the read fail).
  2. From any tailnet device, open the relay WebSocket and send `Pair { "proof": HMAC-SHA256(key="", msg="E2E") hex }`.
  3. Pairing succeeds; send `SendToSession` / `ChatTurn` commands.
- Fix:
  - Fail closed: in the E2E branch require `!expected_token.is_empty()` before verifying (mirror `pairing_token_accepted`); ideally put the emptiness check inside `verify_pair_proof` so no future caller can miss it.
  - Patch sketch: `if expected_token.is_empty() { return Err("pairing token not configured".into()); }` immediately after the token load.
- Tests to add: unit test `verify_pair_proof("", compute_pair_proof("")) == false`; integration test that a `Pair` frame against a DB with no token row is rejected.

### [B-1] Byte-slice truncation panics kill the chat turn silently (multi-byte text)
- Severity: High
- Type: Bug / Edge case
- Status: Confirmed
- Location: `src-tauri/src/chat/mod.rs` — `compute_docs_retrieval()` — lines 858–859; `src-tauri/src/chat/dispatch.rs` — `run_search_docs_tool()` — lines 1931–1933
- Trigger: local-docs retrieval returns a chunk whose 600th (resp. 800th) **byte** falls inside a multi-byte UTF-8 character — routine for any CJK/emoji/typographic-punctuation corpus.
- Impact: `&content[..MAX_CHUNK]` panics ("byte index not a char boundary"). Both sites run inside the `tokio::spawn`ed turn task (`mod.rs:434`); the panic is swallowed by the runtime: no `chat:done`, no `chat:error`, spinner until the user restarts the turn, and `remove_stream_if_current` / `clear_late_attach` / `turn_perf::unregister` (`mod.rs:724–731`) never run — the perf heartbeat task keeps emitting `chat:perf` forever.
- Evidence: a char-safe helper already exists (`crate::util::truncate_chars`, `util.rs:7–9`, with multibyte tests) and is used elsewhere (`dispatch.rs:952`, `tasks.rs:413`) — these two sites were missed.
- How to reproduce:
  1. Index a local corpus containing CJK text into the docs knowledge base.
  2. Ask a question that triggers retrieval (`search_docs`) hitting a chunk where byte 800 splits a character.
  3. Turn ends silently; spinner never clears; console shows the panic from the tokio worker.
- Fix: replace both with `crate::util::truncate_chars(&content, MAX_CHUNK)` (plus the `…` suffix).
- Tests to add: unit test feeding `"日".repeat(400)` through `compute_docs_retrieval`'s formatting lambda and `run_search_docs_tool`'s hit formatting.

### [B-2] macOS/Linux build is broken — Windows COM types used unconditionally
- Severity: High
- Type: Bug (build/portability)
- Status: Confirmed
- Location: `src-tauri/src/browser.rs` — `navigate()` lines 1532–1560, `open_devtools()` 1564–1575, `eval()` 1787–1800, `run_action_for_pane_opts()` 1841–1883; `with_core_on_main` non-Windows stub lines 501–510; deps `Cargo.toml:150–158` (`windows`, `webview2-com` are `cfg(windows)`-only)
- Trigger: `cargo build` on any non-Windows target.
- Impact: `windows::core::HSTRING` and `webview2_com` references exist outside `#[cfg(windows)]` blocks, and the non-Windows `with_core_on_main` stub takes a 0-arg `FnOnce` while every caller passes a 1-arg `|core|` closure — compile failure. Meanwhile `platform_supported()` returns `true` unconditionally (browser.rs:317–319) and a full macOS pane-creation branch exists (1278+), so the product *claims* cross-platform support it cannot build. CI (`.github/workflows/build.yml`) only builds Windows, so nothing catches this.
- Evidence: Cargo.toml gates `windows`/`webview2-com` to `cfg(windows)`; the unconditional call sites are visible in the cited lines.
- How to reproduce: `rustup target add aarch64-apple-darwin && cargo check --target aarch64-apple-darwin` (fails).
- Fix: gate the COM-based fast paths behind `#[cfg(windows)]` with per-platform fallbacks to the tauri `Webview`/`eval` path that already exists for macOS (BrowserPane stores `webview: Webview` on macOS), or make `platform_supported()` cfg-gated to `false` until fixed.
- Tests to add: CI job doing `cargo check` for `x86_64-unknown-linux-gnu`/`aarch64-apple-darwin` (compile-only).

### [B-3] Windows browser panes cannot return action results — every agentic browser op times out at 45 s
- Severity: High
- Type: Bug (platform regression)
- Status: Likely (strong static evidence; needs one runtime check)
- Location: `src-tauri/src/browser.rs` — `action_wrapper_js()` lines 2509–2546 (`window.__TAURI_INTERNALS__.invoke('browser_action_result', …)`), `pushstate_injection_js()` lines 849–879 (same IPC for `browser_push_state`); raw WebView2 creation `build_pane_on_main_thread()` lines 1182–1275 (only `BRIDGE_OVERLAY_JS` is installed via `AddScriptToExecuteOnDocumentCreated`, line 1247–1250); consumer `run_action_for_pane_opts()` 1841–1883 (45 s timeout)
- Trigger: commit `cfa8eb8f` ("own WebView2 controller via webview2-com — tauri dispatch is dead for child webviews") made Windows panes raw WebView2 controllers. Tauri injects `__TAURI_INTERNALS__` only into webviews *it* manages; raw controllers never receive the IPC init script. There is no alternative callback channel (no `add_WebMessageReceived` anywhere in the tree — verified by grep).
- Impact: on Windows, `__report` in every injected action wrapper throws silently (`try/catch` + `.catch(()=>{})`), so `browser_read`, `browser_click`, `browser_type`, `browser_scroll`, `op_evaluate`, `op_wait_for`, `op_navigate`'s title check, and the whole `conduit-browser-mcp` op set (browser_mcp.rs:424, 446, 472, 548, 618, 819…) wait the full 45 s and return "browser action timed out". SPA pushState URL changes are also never reported to the address bar. On the pre-`cfa8eb8f` tauri-managed panes this worked.
- Evidence: see locations; the only init script on the raw path is `BRIDGE_OVERLAY_JS` (grep for `__TAURI_INTERNALS__` in `src-tauri/src/**` matches exactly the two bridge templates, nothing defines or injects it into pane webviews).
- How to reproduce:
  1. Open a browser pane on Windows, open its DevTools (`open_devtools`), run `typeof window.__TAURI_INTERNALS__` → expect `"undefined"` (this is the verification step).
  2. Ask the agent to `browser_read` the page → 45 s timeout with "the page may still be loading".
- Fix: replace the page→Rust callback with a channel that exists on raw controllers: `CoreWebView2.add_WebMessageReceived` + `window.chrome.webview.postMessage(...)` (WebView2-native, no Tauri involvement), or capture results via the `ExecuteScriptCompletedHandler` (currently `|_,_| Ok(())` discards the JSON result). Keep `__TAURI_INTERNALS__` only on tauri-managed (macOS) panes.
- Tests to add: e2e test asserting `browser_read` resolves < 5 s on Windows; unit test that the wrapper JS contains a transport that exists in raw panes.

### [B-4] ACP handshake failure permanently wedges the chat
- Severity: High
- Type: Bug / Concurrency
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `read_acp_stream()` lines 983–995 (handshake error early-return) and 1026–1035 (missing-sessionId return); respawn guard `send_acp_turn()` line 810 (`if entry.child.is_none()`); queueing at 888–898
- Trigger: the ACP agent answers `initialize`/`session/new` with a JSON-RPC error (protocol-version mismatch) or omits `sessionId`, but keeps running.
- Impact: the reader thread returns early **without clearing `entry.child`**. The next send sees `child.is_some()`, skips respawn, queues the turn into `acp_pending`, sets `turn_in_flight = true`, and returns `Ok` — with no reader alive to drain it. Every subsequent send is rejected "a turn is already running" until the user presses Stop (cancel does `child.take()`) or restarts the app.
- Evidence: cited lines; the EOF path at the bottom of the reader does handle turn-in-flight, but these two mid-handshake returns don't.
- How to reproduce: register an ACP agent binary that replies `{error}` to `initialize`; send a message; send another.
- Fix: on every reader exit, clear `entry.child`/`entry.stdin` (shared "process dead" cell checked by `send_acp_turn`), or kill the child in those branches so the next send respawns.
- Tests to add: fake ACP agent (script) returning an error to `initialize`; assert second `send` respawns instead of wedging.

### [B-5] Dead persistent claude/ACP process is never respawned — chat errors on every send
- Severity: High
- Type: Bug
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `send_claude_turn()` lines 672–699 (respawn condition) and 716–729 (stdin write)
- Trigger: the claude CLI (or any persistent harness process) crashes/exits between turns (bad `--resume` id, auth failure).
- Impact: `entry.child` remains `Some` holding a dead pipe → respawn condition false → write to broken pipe → `Err("failed to write to CLI stdin")` on every send until explicit cancel or restart. The opencode path *does* have a liveness probe + respawn (`opencode_server_alive`, 2493–2521); claude/ACP lack it.
- How to reproduce: kill the spawned `claude` process from Task Manager mid-conversation; send a message.
- Fix: on reader EOF clear the child/stdin cells, or `child.try_wait()` in `send_claude_turn` before reuse.
- Tests to add: spawn a fake CLI that exits after one turn; assert the next send respawns.

### [B-6] Cancelled opencode turn's partial reply leaks into the NEXT turn's persisted message
- Severity: High
- Type: Bug / Data integrity
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `cancel()` lines 287–310; opencode turn thread Err branch 2626–2645 (`oc_full` cleared only in the non-cancelled branch at 2633–2635); persist in `finish_turn` line 4406
- Trigger: cancel an opencode turn that has streamed any text, then send a new message.
- Impact: on cancel the server is killed; the cancelled branch only `drop(watches)` — `oc_full` keeps the stale partial text (and `oc_in_think` stays open). The next successful turn's `finish_turn` persists the whole shared buffer: the cancelled turn's partial reply is prefixed to the new answer (plus a stale `</think>`). Corrupts chat history and **survives restarts** (persisted to SQLite).
- How to reproduce: send an opencode turn, press Stop after text appears, send another message, reload — the second message contains the first turn's fragment.
- Fix: clear `oc_full`/`oc_in_think` in `cancel()` (or in the cancelled branch of the turn thread).
- Tests to add: state-machine test on the shared cells: cancel → assert `oc_full` empty before next turn.

### [B-7] PTY respawn race: stale waiter thread strips the new pane's mapping and emits a spurious `pty:exit`
- Severity: High
- Type: Concurrency
- Status: Confirmed
- Location: `src-tauri/src/pty/mod.rs` — `spawn()` line 609 (`kill_pane` first) and 970–982 (insert + re-register); old waiter thread 941–967 (`retain(|_, v| *v != pane.id)` at 957, `pty:exit` emit at 960–966)
- Trigger: respawning a pane with the same pane-id (normal "restart terminal" / session relaunch). The old pane's waiter polls `try_wait` every 120 ms; the new pane is inserted in ~10–50 ms — the old waiter's cleanup almost always lands *after* the insert.
- Impact: `session_to_pane.retain(...)` removes the **new** pane's mapping (same pane-id string) and `pty:exit` fires for a live pane → frontend (`usePtyEvents.ts:110` → `markPaneExited`) shows the "press R to resume" overlay on a healthy terminal; mobile `SendToSession` routing is lost.
- How to reproduce: restart a terminal pane (R key or session relaunch) repeatedly; observe the exit overlay flash on the fresh pane.
- Fix: generation/instance token per spawn; the waiter verifies it still owns the map entry (compare generation) before `retain`/emit.
- Tests to add: unit test simulating two `spawn()` calls with an interleaved waiter tick; assert the mapping survives.

### [B-8] Global `sessions` mutex held across process spawn, git snapshots and up-to-20 s sleeps — UI freeze + chat serialization
- Severity: High
- Type: Performance / Concurrency
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `send()` 156–273; `opencode_wait_ready()` 2773–2787 (`std::thread::sleep` loop, budget 20 s, called at 2721); `maybe_baseline` (git working-tree snapshot) at 260–263; `DirWatch::new` full-tree walks (1285+); `kill_child_tree` `taskkill` 450–471; command layer `commands/agent_cmds.rs:33` (`async fn send_agent_chat_message`) vs `:77` (`fn cancel_agent_chat_message` — synchronous command)
- Trigger: any send while opencode boots slowly, or any cancel while a send holds the lock; also two chats used concurrently.
- Impact: `send()` holds the single global std mutex for the whole turn setup (SQLite writes, full git snapshot, directory walks, process spawn/kill, worst case the 20 s ready-wait). The synchronous cancel command blocks its thread on the same mutex; one chat's slow boot freezes cancels and serializes every other chat. (`automations.rs:444–463` has the same class: `finalize` sleeps 250 ms while holding the DB mutex.)
- How to reproduce: point a chat at an opencode binary that starts slowly; from another chat press Stop; observe multi-second freeze; watch the 20 s worst case with a broken binary.
- Fix: clone the needed `Arc` cells out of the map and drop the guard before spawning/probing; `spawn_blocking` the send; make `cancel_agent_chat_message` `async`.
- Tests to add: concurrency test: send on session A while `cancel` is called on B; assert cancel returns < 500 ms.

### [B-9] Missing stall watchdogs on the Anthropic and non-tool stream loops — turn hangs forever
- Severity: High
- Type: Error handling
- Status: Confirmed
- Location: `src-tauri/src/chat/streaming.rs` — `anthropic_stream_round()` line 460 (bare `while let Some(chunk) = stream.next().await`); `src-tauri/src/chat/mod.rs` — `run_chat_stream()` line 921 (same); contrast `openai_stream_round()` 178–202 which **has** the 60 s watchdog with a comment stating exactly why ("a stalled stream blocks forever — the frontend's streaming entry never clears and the stop button spins indefinitely")
- Trigger: half-open proxy / OpenRouter routing hang / idle upstream on an Anthropic tools-on turn, or on any provider with tools toggled off.
- Impact: the spawned turn task parks forever; no `chat:done`/`chat:error`; spinner until the user sends again or restarts; usage/cost never recorded.
- How to reproduce: use a base URL through a proxy that blackholes after headers; send an Anthropic message with tools on.
- Fix: wrap both `stream.next()` calls in `tokio::time::timeout(Duration::from_secs(60), …)` exactly as the OpenAI round does (one helper reused at 3 sites — also see B-10).
- Tests to add: mock SSE server that sends headers then stalls; assert each loop errors within ~1 s (test-timeout scaled).

### [B-10] No timeout anywhere on the shared chat HTTP client (and five ad-hoc clients)
- Severity: High
- Type: Error handling
- Status: Confirmed
- Location: `src-tauri/src/chat/mod.rs:134` (`reqwest::Client::new()` on `ChatManager`); unguarded `.send()`: `streaming.rs:119–126`, `streaming.rs:425–433`, `mod.rs:894–897`, `dispatch.rs:948`; fresh no-timeout clients per call: `commands.rs:706`, `827`, `1014`, `3453`, `dispatch.rs:738`
- Trigger: blackholed connect (wrong base_url at a firewalled IP — OS TCP timeout can be minutes) or a wedged local sidecar.
- Impact: async commands (`generate_chat_title`, `generate_commit_message`, …) never resolve; `count_context_tokens` — polled every 2 s by the frontend — stacks unbounded pending requests against a wedged sidecar; the subagent `handle.await` (streaming.rs:985–991/1170–1176) hangs the whole turn even for OpenAI, whose round watchdog doesn't cover this wait.
- How to reproduce: set a custom base_url to an unfiltered IP; open the composer (title generation fires).
- Fix: build the shared client with `.connect_timeout(20s)`; wrap every `.send()` in `tokio::time::timeout`; reuse one client instead of five ad-hoc ones.
- Tests to add: mock server that accepts TCP and never responds; assert each helper errors in bounded time.

### [B-11] Anthropic subagents: thinking enabled but never echoed — every tool-using subagent 400s on round 2
- Severity: High
- Type: Bug (API contract)
- Status: Confirmed
- Location: `src-tauri/src/chat/dispatch.rs` — subagent body line 751–755 hardcodes `"thinking": {"type":"enabled","budget_tokens":2048}` (comment admits "never echoed back"); echoed assistant turn built at 1145–1150 from text + `tool_use` blocks only; the main loop does it correctly (`streaming.rs:644–649` echoes `thinking` + `signature` with the comment "or the API 400s on the next round")
- Trigger: any Anthropic/AnthropicCompatible session where the model calls the `Task` tool and the subagent makes ≥1 tool call (its tools are read-only and it is prompted to use them).
- Impact: Anthropic rejects the round-2 request (`Expected thinking or redacted_thinking…`); subagent fails with HTTP 400 and the first round's streamed output is discarded (`dispatch.rs:796–807`) — Task-subagents are simply broken on Anthropic.
- How to reproduce: Anthropic session → "use a subagent to search the codebase" → watch the Agents pane: round 1 streams, round 2 errors.
- Fix: accumulate `thinking_delta`/`signature_delta` in the subagent loop and prepend a thinking block to the echoed assistant turn (mirror `streaming.rs:544–595`), or stop sending `thinking: enabled` for subagents.
- Tests to add: golden-request test capturing the round-2 body for an Anthropic subagent with tool calls; assert a `thinking` block with signature is present.

### [B-12] ACP replies to server-initiated requests with a hardcoded `"id": 0`
- Severity: Medium
- Type: Bug (protocol)
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `AcpLine::Request` arm, lines 1132–1144
- Trigger: an ACP agent sends a request (e.g. `session/prompt` request-form) instead of the notification form.
- Impact: the response carries `id: 0` regardless of the request id (the variant carries the real `id` but the arm discards it), so the agent's JSON-RPC client never correlates it and waits forever → turn hang. The "safety net" this code exists to provide is defeated.
- How to reproduce: agent binary that sends a request-form `session/prompt`; watch the turn never complete.
- Fix: destructure `AcpLine::Request { id, .. }` and echo `"id": id`.
- Tests to add: unit test on the arm with a captured fake stdin asserting the echoed id matches.

### [B-13] JSON-RPC error responses for ACP turns ≥ 2 are silently ignored → wedge
- Severity: Medium
- Type: Error handling
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `read_acp_stream()` lines 983–998 (gate `!handshake_done || Some(id) == pending_request_id`; `pending_request_id` is set only for the first turn at 1046–1055); later ids live in `acp_request_id` (stored at 907) but are never compared
- Trigger: agent returns an error response for turn 2+ without also sending `session/error`.
- Impact: `turn_in_flight` stays true forever; the chat is wedged like B-4.
- Fix: compare against `acp_request_id` in the reader and treat a match as turn failure.
- Tests to add: fake-agent test: error response on the second `session/request` → assert `chat:error` + flag cleared.

### [B-14] UTF-8 lossy conversion per network chunk corrupts multi-byte characters at read boundaries
- Severity: Medium
- Type: Bug
- Status: Confirmed
- Location: `src-tauri/src/chat/streaming.rs:202` and `:462`; `src-tauri/src/chat/mod.rs:923`; `src-tauri/src/chat/dispatch.rs:970` — all four SSE readers do `pending.push_str(&String::from_utf8_lossy(&chunk))` on each raw chunk independently
- Trigger: a code point split across two TCP reads — routine for long CJK/emoji/typographic-dash answers over TLS.
- Impact: each boundary becomes two U+FFFD replacement characters; corruption hits the live stream, the persisted message, and every later re-send of history (permanent).
- How to reproduce: stream a long Chinese answer through a throttling proxy; observe � in the transcript.
- Fix: buffer raw bytes (`Vec<u8>`), split lines on `b'\n'`, then `from_utf8_lossy` per complete line (one shared helper for the four readers).
- Tests to add: unit test feeding a chunk split mid-codepoint through the line assembler.

### [B-15] Anthropic non-tool path records `input_tokens = 0` (usage/cost wrong)
- Severity: Medium
- Type: Bug (accounting)
- Status: Confirmed
- Location: `src-tauri/src/chat/providers.rs` — `AnthropicProvider::parse_usage()` lines 392–427 (scans `buf.lines().rev()` and returns the first-from-the-end usage event)
- Trigger: any Anthropic turn with tools disabled (goes through `run_chat_stream` → `parse_usage`).
- Impact: Anthropic puts `input_tokens` (and cache fields) on `message_start` and only `output_tokens` on `message_delta`; the backward scan always lands on `message_delta` → `input_tokens = 0`, cache stats = 0, `cost_usd` computed on output only. Cost dashboard under-reports by the entire input cost on that path. (The tools-on loop does it right — `streaming.rs:486–501` — which hides the bug in default use.)
- How to reproduce: disable tools for an Anthropic session, send a message, open the cost dashboard.
- Fix: merge — take `input_tokens`/cache fields from the first usage-bearing line (`message_start`) and `output_tokens` from the last.
- Tests to add: usage test with a buffer containing both `message_start` and `message_delta` events (today's tests only cover single-event buffers).

### [B-16] HTTP status never checked in `openai_oneshot`/`anthropic_oneshot` — auth/quota errors become empty strings
- Severity: Medium
- Type: Error handling
- Status: Confirmed
- Location: `src-tauri/src/chat/commands.rs` — `openai_oneshot()` 560–592, `anthropic_oneshot()` 597–625 (no `resp.status()` check; error body has no `choices` → `""`)
- Trigger: 401/403/429/5xx during title generation, commit-message generation, diff review, or automations (`run_one_shot_chat`, `mod.rs:1131–1143`).
- Impact: silent empty results; an automation on a quota error **persists a blank assistant message** and reports success. Zero diagnostics.
- Fix: check `!resp.status().is_success()` first and return `Err(format!("HTTP {status}: {body}"))`.
- Tests to add: mock 429 → assert `Err` contains "429".

### [B-17] Mid-stream provider error events are swallowed everywhere
- Severity: Medium
- Type: Error handling
- Status: Confirmed
- Location: `src-tauri/src/chat/providers.rs:489–511` (`OpenAIProvider::parse_sse_chunk` ignores an `error` field), `:342–360` (Anthropic shape), `src-tauri/src/chat/streaming.rs:232–253` (tool loop reads only `usage`/`delta`)
- Trigger: provider signals a mid-stream failure as `data: {"error":{…}}` after 200 OK (OpenRouter overload, credit exhaustion).
- Impact: the turn "completes successfully" with truncated text; no `chat:error`; a cut-off answer is persisted as complete.
- Fix: check `v.get("error")` in each SSE handler and fail the round with its message.
- Tests to add: stream containing an error event → assert round returns `Err`.

### [B-18] Non-tool path is fatally strict about SSE framing the tool loops explicitly tolerate
- Severity: Medium
- Type: Bug (compat)
- Status: Confirmed
- Location: `src-tauri/src/chat/providers.rs:339` and `:482` (require `data: ` with space) vs `streaming.rs:206–213` (tolerates `data:` without space, citing OpenRouter/vLLM); `mod.rs:932` propagates any parse error via `?` while tool loops tolerate 50 strikes (`MAX_PARSE_FAILURES`, streaming.rs:43); same strict prefix in the subagent loop (`dispatch.rs:974`)
- Trigger: tools toggled off against a no-space emitter, or one malformed keep-alive line.
- Impact: empty assistant reply persisted, or aborted turn with an SSE parse error; subagents report "produced no output" (dispatch.rs:1220–1222).
- Fix: reuse the tolerant prefix handling from `streaming.rs:210` in `providers.rs` and `dispatch.rs`; make `run_chat_stream` tolerate consecutive parse failures.
- Tests to add: `data:{...}` (no space) frames through each parser.

### [B-19] Failed turn discards all streamed content — nothing persisted, frontend drops its buffer too
- Severity: Medium
- Type: Data integrity
- Status: Confirmed
- Location: backend `src-tauri/src/chat/mod.rs:701–715` (error path emits `chat:error` only; loops drop the accumulated buffer — `streaming.rs:833`, `:1118` return `Err` losing N−1 rounds); frontend `src/state/chat.ts` `onError` at 2728+ (deletes streaming state; `persistPartialChatMessage` is wired only into the cancel path, chat.ts:2322–2329)
- Trigger: transient provider 500/429 or a watchdog stall at tool round N after minutes of streamed work.
- Impact: everything the user watched the agent do vanishes on reload (only disk side effects remain); usage from completed rounds is lost; files written by tools with no matching transcript.
- Fix: return partial text + usage from the loops and persist a failed-flagged assistant message before `chat:error`; or have the frontend call `persistPartialChatMessage` in `onError` as it does on cancel.
- Tests to add: round-2 failure e2e → reload → partial assistant message present.

### [B-20] `onDone` has an unguarded IPC await that strands the message queue
- Severity: Medium
- Type: Error handling
- Status: Confirmed
- Location: `src/state/chat.ts` — `onDone` line 2587 (`const sessions = await listChatSessions();`); caller `src/hooks/useChatEvents.ts:67` (`void …onDone(…)`, no `.catch`)
- Trigger: any transient `list_chat_sessions` rejection while a turn completes (`safeInvoke` rejects inside Tauri — `ipc.ts:44–54` — e.g. DB briefly locked by the message write that just happened).
- Impact: `onDone` aborts before `drainQueue` (2597) and the goal-loop advance (2605–2623); queued messages strand until the user manually sends; unhandled promise rejection. The sibling fetch two lines up (2516–2521) is guarded — this one was missed.
- Fix: wrap 2587–2595 in `try { … } catch { /* best-effort relist */ }`.
- Tests to add: store test with `listChatSessions` rejecting → assert queue still drains.

### [B-21] Split-view composer renders and mutates the MAIN session's message queue
- Severity: Medium
- Type: Bug
- Status: Confirmed
- Location: `src/components/chat/ChatComposer.tsx` — lines 897–903 (`queuedMessages` keyed on global `activeChatSessionId`, ignoring the `sessionIdProp` received at 849), 918–922 (`pickWorkingFolder` sets `cwdOverride` on the global id), 2032–2035 (steer/edit/remove/move all target the global id); split rendering `App.tsx:395` → `ChatView.tsx:1824`
- Trigger: open split view; stack a message in the main chat while it streams.
- Impact: the split pane's composer shows the *other* chat's queued chips; steering/cancel from there interrupts the main chat; the folder picker silently rebinds the main chat's working dir.
- Fix: key the queue UI, the four queue actions and `pickWorkingFolder` off `sessionIdProp ?? activeChatSessionId`.
- Tests to add: render ChatComposer with a `sessionIdProp` different from active; assert chips/actions address the prop id.
- Note: fix `steerQueuedMessage` (chat.ts:1065, 1070) at the same time — its internal `cancelStream()`/`sendMessage()` calls drop the session id, so a naive fix of this finding turns that latent bug live.

### [B-22] Team broadcast sends background turns with tools silently disabled
- Severity: Medium
- Type: Bug
- Status: Confirmed
- Location: `src/state/chat.ts` — `broadcastToSessions` line 1989 (`sendChatMessage(sid, content, undefined, undefined, …)`); `src/lib/ipc.ts:1353–1354` (`toolsEnabled: toolsEnabled ?? false`)
- Trigger: broadcast one prompt to N sessions.
- Impact: every non-active target runs with the tool loop off (`toolsEnabled: false`) while the identical single-session send uses the store default (`true`, chat.ts:971) — broadcast replies can't search or run tools, no error shown.
- Fix: pass the store's `toolsEnabled`/`codeExecEnabled` (destructured `state` at 1945) in those positional slots.
- Tests to add: broadcast test asserting the invoke payload carries `toolsEnabled: true` for background sessions.

### [B-23] `cancelStream`/`deleteMessage` refetch the FULL history, defeating pagination
- Severity: Medium
- Type: Performance
- Status: Confirmed
- Location: `src/state/chat.ts` — `cancelStream` line 2378, `deleteMessage` line 2104 (`getChatMessages(id)` with no limit → backend "legacy full history", `chat/commands.rs:1070–1074`); every other caller passes `200` (documented as fix "M10", chat.ts:2509–2515)
- Trigger: hit Stop after a partial reply, or fail a message delete, in a multi-thousand-message session.
- Impact: entire history deserialized into the zustand buffer and re-rendered; `hasMoreHistory` desyncs (stays true after everything loaded).
- Fix: pass the 200 limit at both sites and set `hasMoreHistory: messages.length >= 200` with the buffer write.
- Tests to add: store test asserting the invoke args include the limit.

### [B-24] Relay E2E mode still honors plaintext `Text` command frames; pairing proof is replayable
- Severity: Medium (High when combined with S-1's capture scenarios)
- Type: Security
- Status: Confirmed
- Location: `src-tauri/src/mobile/relay.rs` — request loop 645–680 (plaintext `Message::Text` still parsed as a command after E2E pairing); static proof `relay_crypto.rs:43–49` (no nonce/challenge); contradicted doc `relay_ws.rs:86–89` ("a plaintext frame in E2E mode is a protocol violation the caller reports" — the caller does not report it)
- Trigger: observe one `Pair` frame (proof is static), reconnect with the replayed proof, send plaintext JSON commands.
- Impact: E2E mode adds response confidentiality but no integrity over the legacy path; the advertised property (relay_crypto.rs header) is not delivered.
- Fix: reject `Message::Text` whenever E2E is enabled; add a server nonce to the pairing proof.
- Tests to add: post-pairing plaintext frame → expect rejection.

### [B-25] Unauthenticated relay connections receive broadcast pushes
- Severity: Medium
- Type: Security
- Status: Confirmed
- Location: `src-tauri/src/mobile/relay.rs` — registry insert 471–479 (before pairing, which happens at 511–598); `broadcast` 86–91, `broadcast_automation_run_finished` 96–115, `broadcast_budget_alert` 117–137
- Trigger: any peer opens the WebSocket and idles (pairing timeout is 30 s).
- Impact: receives every `AutomationRunFinished` (summary can carry provider/error text) and `BudgetAlert` (project names, spend) — in plaintext when E2E isn't enabled.
- Fix: insert into `conns` only after successful pairing.
- Tests to add: connect without pairing → assert no broadcast received.

### [B-26] `CancelChatTurn` is dead while a chat turn streams
- Severity: Medium
- Type: Bug
- Status: Confirmed
- Location: `src-tauri/src/mobile/relay.rs` — `ChatTurn` arm 719–742 (`handle_chat_turn(...).await` inline in the read loop) vs `CancelChatTurn` arm 743–747
- Trigger: phone user presses Stop while a mobile chat turn streams.
- Impact: the read loop is not polled during the turn; the cancel frame sits in the socket until the turn completes — the stop button does nothing mid-turn.
- Fix: spawn the turn and `select!` over `read.next()` + turn completion, routing cancel to `chat_mgr.cancel()`.
- Tests to add: integration test with a mock provider: send `ChatTurn` then `CancelChatTurn`; assert cancel observed mid-stream.

### [B-27] Headless automation binary ignores the `storage.dbDir` override — different database than the GUI
- Severity: Medium
- Type: Bug / Data integrity
- Status: Confirmed
- Location: `src-tauri/src/bin/conduit_automation.rs` — `db_path()` 89–94 (hardcoded `dirs::data_dir()/dev.conduit.app/conduit.db`) vs `src-tauri/src/db/mod.rs` — `chat_db_path()` 54–71 (honors `storage.dbDir`)
- Trigger: user relocates the DB in Settings; "run while closed" Task-Scheduler entry invokes `run-due`.
- Impact: the headless runner reads a stale/empty DB — automations silently stop firing while closed or run with outdated prompts.
- Fix: replicate the `storage.dbDir` peek in `db_path()`.
- Tests to add: unit test with a settings DB carrying `storage.dbDir`; assert resolved path.

### [B-28] Crash mid-run blocks an automation for up to 6 hours
- Severity: Medium
- Type: Bug / failure mode
- Status: Confirmed
- Location: `src-tauri/src/automations.rs` — `prepare_run_inner()` 276–307 (stale only if `age > 6h`, line 288; header comment 274–276 claims "blocks one run")
- Trigger: app crash/kill while an automation run is in progress (lock file persists).
- Impact: every 30 s tick stamps "skipped" for up to 6 h — a `*/15` automation loses ~24 slots after one crash.
- Fix: write the owning PID into the lock and treat it stale immediately when the PID is gone.
- Tests to add: create a lock with a dead PID → assert next prepare runs.

### [B-29] Multi-statement DB writes are not transactional
- Severity: Medium
- Type: Data integrity
- Status: Confirmed
- Location: only one transaction exists in `db/` (`db/chat.rs:378`, `set_chat_session_connectors`). Non-transactional multi-statement writes: `db/projects.rs:49–62` `remove_project` (6 DELETEs + a swallowed `let _ =` at 59); `db/docs.rs:190–206` `replace_file_chunks` (the test named `…replaces_atomically`, docs.rs:463–469, asserts end-state only — the atomicity it claims does not exist); `db/docs.rs:95–100`, `155–185`; `db/chat.rs:155–166`, `177–190`, `635–649`, `658–683`
- Trigger: crash/kill midway through any of these.
- Impact: torn state; worst case is the docs index: partial chunks with a `doc_files.mtime` that then looks fresh → file never re-embedded → permanently missing from RAG search. Project deletion can orphan chat rows.
- Fix: wrap each helper in `conn.unchecked_transaction()` like the one existing example.
- Tests to add: inject a failure between statements (test-only hook) and assert all-or-nothing.

### [B-30] Migration crash-window permanently skips gated backfills
- Severity: Medium (low probability, permanent effect)
- Type: Data integrity
- Status: Confirmed
- Location: `src-tauri/src/db/mod.rs` — `configure()` 114–139 (≈14 sequential migrations, no wrapping transaction); `migrate_chat_session_agent` 245–264; `migrate_cost_v2` 317–398
- Trigger: process death between an `ALTER TABLE … ADD COLUMN` (autocommitted) and the gated backfill `UPDATE` that follows.
- Impact: the column now exists, so `column_added = false` on every later start and the backfill never runs — pre-feature rows stay `NULL` forever (e.g. all old chats permanently `agent = NULL`).
- Fix: run migrations in one transaction, or gate backfills on a persisted marker row instead of column existence.
- Tests to add: simulate a crash after ALTER (fresh DB, partial run) → restart → assert backfill completed.

### [B-31] Deleting a compaction summary permanently hides the folded messages
- Severity: Medium
- Type: Data integrity
- Status: Confirmed
- Location: `src-tauri/src/db/mod.rs:559` (`superseded_by INTEGER` — no FK); `db/chat.rs:635–649` `delete_chat_message`; filter `list_active_chat_messages` `superseded_by IS NULL` (chat.rs:623); folding via `mark_superseded` (chat.rs:690–704)
- Trigger: user deletes the message row that a compaction summary used as its anchor.
- Impact: folded rows point at a ghost id and are silently excluded from the model's context forever while still rendering in the UI timeline.
- Fix: clear `superseded_by` on rows referencing the deleted id (or `ON DELETE SET NULL` FK).
- Tests to add: delete a summary row → assert folded rows become active again.

### [E-1] `run_shell`/`run_code`/`download_file` posture risks (documented tradeoffs, restated for the record)
- Severity: Medium (risk)
- Type: Security
- Status: Confirmed (as design; residual risk)
- Location: `src-tauri/src/chat/permission.rs:243–280` (`run_shell` auto-runs under FullAccess), `codeexec.rs:38–93` (`sandbox_available() = false`; no OS sandbox wired), `dispatch.rs:1556–1568` (`download_file` scope check skipped when `fs_roots` is empty so the approval card can show)
- Trigger: FullAccess mode + prompt injection; or code-exec enabled + injected model output.
- Impact: arbitrary native code with full user privileges; the result text does honestly warn ("⚠ No OS-level sandbox is enforced…"). The user-facing honesty is good; the residual risk is real and worth tracking, not fixing silently.
- Evidence: `codeexec.rs` header documents the no-sandbox state; `tools/mod.rs:186–199` claims code exec "routes through the bundled sandboxed Python" — **that comment is wrong** (`python_runtime.rs` only resolves an interpreter; nothing sandboxes it).
- Fix (docs first): correct the `tools/mod.rs` and `codeexec.rs:104–107` comments ("sandbox profile denies network…") which overstate confinement; longer term, wire the reserved Landlock/JobObject/sandbox-exec hooks.
- Tests to add: none (doc fix).

### [E-2] Compaction bugs: constant "interpolation", wrong truncation unit, missing `max_tokens` on OpenAI wire
- Severity: Medium
- Type: Bug
- Status: Confirmed
- Location: `src-tauri/src/chat/compaction.rs:64–67` (`0.80_f64.min(0.85)` is always 0.80 — the documented 0.80→0.85 interpolation never happens); `compaction.rs:606` (`max_chars = n_ctx * 3 / 4` but the comment's 4-chars-per-token ratio implies `n_ctx * 3` — summarization input over-truncated ~4×); `providers.rs:175–192` (`OpenAIWireBody` has no `max_tokens`; the tool-loop body `streaming.rs:812–818` omits it too — `ChatRequest.max_tokens = Some(4096)` is silently dropped for every OpenAI-family provider → unbounded generation length/cost; Anthropic honors it at `streaming.rs:1094`)
- Trigger: any compaction on a >16k context; any long OpenAI-family generation.
- Impact: over-eager compaction (more tokens spent re-summarizing than necessary), silently discarded history, and unbounded output spend.
- Fix: implement the interpolation; `max_chars = n_ctx * 3`; add `max_tokens` to `OpenAIWireBody` and the loop body.
- Tests to add: threshold values across window sizes; wire-body serialization snapshot asserting `max_tokens` present.

### [E-3] Anthropic thinking-budget math produces an invalid request when `max_tokens <= 1024`
- Severity: Low today (latent), Medium on trigger
- Type: Edge case
- Status: Confirmed (latent)
- Location: `src-tauri/src/chat/providers.rs:214–217`, `src-tauri/src/chat/streaming.rs:1108–1114` — `budget_tokens: (max_tokens - 1024).max(1024)` yields `budget_tokens >= max_tokens` for small caps, which Anthropic rejects (must be strictly smaller) → 400 on every thinking-enabled turn. Currently unreachable only because `ChatManager::send` hardcodes `max_tokens: Some(4096)` (mod.rs:319).
- Fix: `budget_tokens = (max_tokens - 1024).clamp(1024, max_tokens - 1)` and raise the cap to ≥ 2049 when thinking is on.

### [E-4] Harness-switch teardown order kills the running CLI before the in-flight gate rejects
- Severity: Low
- Type: Bug
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `send()` 189–199 (kill) before 203–205 (`turn_in_flight` gate)
- Trigger: switch a chat's harness mid-turn.
- Impact: the in-flight turn's process tree is destroyed *and* the new message is rejected; old reader emits "exited mid-turn".
- Fix: move the harness-switch teardown after the gate.

### [E-5] Respawn race on the shared `turn_in_flight` flag
- Severity: Low (narrow window)
- Type: Concurrency
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — kill+respawn 676–699, new-turn store 715, old reader EOF `in_flight.swap(false)` 2188
- Trigger: old reader's EOF handling outlasting the new spawn (plausible under DB contention — both lock `db.0`).
- Impact: flag cleared while a new turn runs → a second concurrent turn can be written to the same stdin; spurious "exited mid-turn".
- Fix: per-process flag (like `cancelled`) or identity check before clearing.

### [E-6] Lock-poisoning asymmetry: teardown silently no-ops after a panic
- Severity: Low
- Type: Error handling
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `send` recovers poisoned locks (156), but `cancel` errors (288) and `remove_session` (368) / `kill_all` (390) use `if let Ok(...)` — children never killed exactly in the panic scenario.
- Fix: `into_inner()` recovery everywhere.

### [E-7] Zombie process trees from bare `child.kill()` on Windows timeout paths
- Severity: Medium
- Type: Resource leak
- Status: Confirmed
- Location: `src-tauri/src/agent_sessions.rs` — `harness_oneshot_blocking` 3838–3845 and `run_one_shot` stdin-failure path 3614–3617 (both use `kill()`, which on Windows only kills the `cmd.exe /C` wrapper — the node.exe grandchild survives); `kill_child_tree` exists (450–471) and is used by the deadline path (3684) but not these two
- Trigger: generation timeout or stdin failure on a Windows harness spawn.
- Impact: orphaned full-auto CLI processes keep running (and spending).
- Fix: call `kill_child_tree` in both spots.

### [E-8] OAuth: pending-flow map leaks on early exits; loopback acceptor can wedge the fixed port forever
- Severity: Medium
- Type: Resource leak / failure mode
- Status: Confirmed
- Location: `src-tauri/src/connectors/oauth.rs` — `flows.insert` 437–443, early returns at 487–501 (bind fail) and 515–526 (browser-open fail), removal only at 538–541; `accept_one_callback` 707–714 (no socket read timeout after `accept()`)
- Trigger: bind/open failure mid-flow; or a local process connects to the callback port and stalls before sending a request line.
- Impact: `PendingFlow` entries leak for process lifetime; the stalled `read_line` blocks the `spawn_blocking` thread until app exit while still owning the listener — every later Connect for that connector hits EADDRINUSE.
- Fix: move the flows-map removal into the RAII guard; `stream.set_read_timeout(Some(10s))`.

### [E-9] Misc smaller confirmed items
- Severity: Low each
- Type: Bug / Error handling / Performance
- Status: Confirmed
- Items:
  - `agent_sessions.rs:1919/2143` — claude reader's `started_at` never reset between turns → "Worked for Xs" inflated after turn 1 (ACP does reset, 1103–1104).
  - `src-tauri/src/chat/dispatch.rs:1452–1454` — `run_plan_tool(...).unwrap_or_default()` returns `""` to the model on failure instead of an error string.
  - `src/state/chat.ts:1065/1070` — `steerQueuedMessage` internal `cancelStream()`/`sendMessage()` drop the session id (latent; see B-21).
  - `src/state/ui.ts:508–529` — `openArtifactTab`'s dedupe/refresh branch requires `!artifact.inline`, so inline artifacts (mermaid/jsx) stack duplicate tabs; the refresh path is dead code.
  - `src/components/command-palette/CommandPalette.tsx:180` — `selectSession` without `.catch` (Sidebar.tsx:196 has it) → unhandled rejection, palette closes silently on DB lock.
  - `src/state/updater.ts:47–66` — `try/finally` without `catch` around `checkForUpdate`; `App.tsx:200/202` call it `void`-ed → startup + 4-hourly unhandled rejections when the endpoint errors.
  - `src/lib/exportSession.ts:15` — `toISOString().slice(0,10)` puts yesterday's date in the filename between local midnight and UTC midnight.
  - `src/state/chat.ts:2407–2432` — `onToken` unconditionally recreates `streaming[id]` keys cleared by done/cancel (the straggler guard exists only in `onPerf`, 2777) → resurrected "working" dot blocking sends until the next terminal event.
  - `src-tauri/src/chat/commands.rs:1363–1368` — user message persisted before provider/key/model validation (1378/1552/1570/1614) → orphaned user rows on validation failure.
  - `src-tauri/src/pty/mod.rs:669–676` — PTY spawn error paths after `slave.spawn_command` never kill the child (orphan agent process, rare).
  - `src-tauri/src/connectors/oauth.rs:1054–1063` — `store_exchanged` ordering can leave a stale refresh token on silent delete failure → later spurious `invalid_grant`.
  - `src-tauri/src/github.rs:94–136` — two git subprocesses spawned per HTTP client build (per command, incl. per-page fetches) — cache the proxy per session.
  - `src-tauri/src/harness_adapters/mod.rs:282–291` — automation `-m <model>` flag rides the cmd.exe line unquoted; a model string like `a&b` is re-parsed as a command separator (same-user-only surface today).

### [P-1] `fs_read_file` loads the entire file before truncating
- Severity: Low–Medium
- Type: Performance
- Status: Confirmed
- Location: `src-tauri/src/chat/tools/fs.rs` — `fs_read_file()` lines 60–80 (`std::fs::read` then truncate to `FS_READ_MAX = 32_000`)
- Trigger: model calls `read_file` on a multi-GB file (log, dataset, model blob).
- Impact: full-file allocation in the turn task before the cap is applied; memory spike / possible OOM on huge files.
- Fix: read bounded — `File::open` + `take(FS_READ_MAX as u64 + 4)` then truncate at char boundary (existing logic).

### [P-2] One OS thread per navigation start, each sleeping up to ~12.75 s
- Severity: Low
- Type: Performance
- Status: Confirmed
- Location: `src-tauri/src/browser.rs` — `attach_core_listeners()` NavigationStarting handler 747–775 (`std::thread::spawn` + escalating sleeps `[0,150,400,900,1800,3500,5000]` + 7 main-thread dispatches); `spawn_post_nav_inject()` 1596–1615 (1 s sleep + 2 dispatches, no early-exit when the pane is gone — the macOS variant breaks at 1350)
- Trigger: redirect chains / rapid link clicks — each NavigationStarting spawns a fresh thread.
- Impact: thread churn and 7 no-op main-thread dispatches per navigation even after the tab is closed (the map lookup no-ops but the dispatch still round-trips).
- Fix: single re-registration task keyed by pane generation with cancellation on close/replace.

### [P-3] Frontend `onDone`-path full relist and uncapped growth maps (minor)
- Severity: Low
- Type: Performance
- Status: Confirmed (bounded, app-lifetime)
- Location: `src/state/chat.ts` — `artifactsByMessage`/`lastTurnPerf`/`sessionMetrics` entries for sessions that are viewed but never deleted persist for the app run (acknowledged in code); `manuallyRenamed`/`deletedSessions` are correctly capped at 1000 via `capMap`.
- Fix: evict with session deletion where cheap; acceptable as-is.

## Clean areas
Reviewed and found solid (selected highlights):

- **Permission/sandbox core** (`chat/permission.rs`, `chat/dispatch.rs` gating): the dual Sandbox/Approval model is consistently enforced; `move_file` checks **both** src and dest (dispatch.rs:1612–1621); the hard `path_within_scope` gate resolves junctions/symlinks via the filesystem (defeats in-root link escapes; tested at permission.rs:807–843); approval rules cannot widen scope; connector tools fail-closed to Write; delete is gated under every level except FullAccess-in-roots. The `download_file` empty-roots carve-out (dispatch.rs:1556) is deliberate and commented.
- **Secrets** (`secrets.rs`): keychain-backed on Win/mac (Linux D-Bus); SQLite holds only marker blobs; chat API keys and OAuth tokens never cross to the frontend (verified against every command layer); no key material in error strings or logs.
- **SQL injection: none.** Every query in `db/*.rs` is parameterized; FTS input sanitized to quoted terms with tests; LIKE wildcards escaped.
- **Git command injection: none.** All invocations are `Command::new("git").args(...)` (no shell); branch names rejected with leading `-`; pathspecs use `--`; `validate_repo_relative` blocks absolute/`..` traversal (tested); the command layer allowlists paths against registered roots.
- **Browser MCP WS auth** (`browser_mcp.rs`): random per-startup token delivered only via the per-server env block of a config in the **app data dir** (not the workspace); constant-time compare; first-message auth gate; `wait_for` timeout clamped against `Instant + Duration` panics.
- **tasks.rs downloads**: retry with backoff, per-chunk stall watchdog, SSRF guard with post-connect DNS-rebinding re-check, Range-resume `.part` files, TTL sweep, pipe-drain threads avoiding the 64 KB pipe deadlock — the best-engineered file in the backend.
- **Scheduler double-fire defenses**: in-process `RUNNING` set + cross-process `O_EXCL` lock; `last_run_at` written before guard release; missed-window catch-up fires exactly once; cron in local time (DST handled as standard local cron).
- **OAuth core**: state validation with PKCE S256, loopback redirect restriction, single-flight refresh with re-read token, tokens never logged.
- **Frontend sanitization**: DOMPurify configs correct (`ALLOW_UNKNOWN_PROTOCOLS: false`, `ALLOW_DATA_ATTR: false`, explicit FORBID_TAGS); mermaid rendered behind `antiscript` + sanitize + 256 KB cap; the mermaid `foreignObject` exception is the documented necessary one; react-markdown default `urlTransform` active at all three markdown surfaces (no `javascript:` hrefs); live-preview iframes are `sandbox="allow-scripts …"` **without** `allow-same-origin` (opaque origin) and CSP-constrained.
- **Frontend listener/interval hygiene**: every per-view `listen()` cleaned up (including the unlisten-before-resolve edge, `useGitStatusPolling.ts:55–82`); all intervals cleared; streaming buffers capped at 200 KB char-safe; queue ids monotonic; toasts capped.
- **Race guards in `chat.ts`**: per-session streaming map, `messagesSessionId` buffer-ownership guards, optimistic-bubble dedupe, tombstoned deleted sessions, full key sweep on delete.
- **Lock ordering** in agent_sessions/pty traced both directions — no cycles; no guard is held across `.await` anywhere audited (the hazard is blocking-under-lock, finding B-8, not async deadlock).
- **Stream-suppression state machine** (`openai_stream_round`) and the untrusted-index clamp (`MAX_STREAM_BLOCK_INDEX = 64`) are correct, with tests.

## Testing gaps
- **No backend integration tests at all** beyond a 9-line smoke (`src-tauri/tests/smoke.rs`). Every lifecycle wedge (B-4, B-5, B-6, B-7, B-13) needs a fake-agent harness test.
- **No non-Windows CI compile** — B-2 (broken macOS/Linux build) is invisible to CI, which builds Windows only.
- **No stream-failure tests**: no test feeds a stalled stream (B-9/B-10), a mid-stream `error` event (B-17), no-space `data:` framing (B-18), or a chunk split mid-codepoint (B-14).
- **Usage tests use single-event buffers** — M1-class bugs (`message_start` vs `message_delta`) can't be caught by them.
- **`replace_file_chunks_replaces_atomically` asserts end-state only** — it passes despite the non-transactional write (B-29); crash-injection is needed.
- **Frontend**: no test covers `onDone` with a rejecting relist (B-20), split-view composer keying (B-21), broadcast tool flags (B-22), or `onError` partial persistence (B-19).
- **No e2e for the agentic browser loop on Windows** — B-3 would have been caught by any "browser_read resolves quickly" assertion.

## Priority fix order
1. **S-1** — one-line fail-closed check on the E2E pairing path (security, remote).
2. **B-1** — two one-line `truncate_chars` fixes (silent turn death on CJK input).
3. **B-9 + B-10 + B-3-subagent-watchdog** — one timeout helper reused at the stream read sites + `connect_timeout` on the shared client (hangs).
4. **B-11** — Anthropic subagent thinking echo (feature-level breakage of Task tool).
5. **B-4 / B-5 / B-13 / B-12** — ACP/claude lifecycle wedges (clear dead-child state + echo request id + compare `acp_request_id`).
6. **B-6** — clear `oc_full` on cancel (persisted history corruption).
7. **B-7** — PTY respawn generation token (spurious exit overlay, lost mobile routing).
8. **B-8** — drop the global `sessions` guard before blocking work; async cancel (UI freeze).
9. **B-3** — browser action callback via `WebMessageReceived`/result-capturing handler (verify `typeof __TAURI_INTERNALS__` first).
10. **B-15 / B-16 / B-17 / B-14** — usage accounting, HTTP status checks, SSE error events, byte-buffered line assembly.
11. **B-2** — restore a compiling non-Windows path (or gate `platform_supported`) + add cross-platform `cargo check` CI.
12. **B-24 / B-25 / B-26** — relay: reject plaintext in E2E, register post-pairing, selectable cancel.
13. **B-19 / B-20 / B-21 / B-22 / B-23** — frontend turn-lifecycle fixes.
14. **B-27 / B-28 / B-29 / B-30 / B-31 / E-7 / E-8** — automations + DB durability batch.
15. **E-1 / E-2 / E-3 / E-4 / E-5 / E-6 / E-9 / P-1 / P-2 / P-3** — hardening and doc corrections.

---
*Verification notes: baseline `cargo check` (clean, 63 warnings — mostly unused `Result`s in pdfprint.rs) and `vitest run` (71 files / 491 tests, all passing) were executed before the audit. Every Critical/High finding above was re-verified against the working tree by a second pass; findings marked "Likely" state exactly what runtime check would confirm them. Line numbers refer to the tree at commit `0b6e4e32` (working tree, untracked patch scripts not applied).*
