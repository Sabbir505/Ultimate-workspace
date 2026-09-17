# Full Codebase Audit — 2026-09-17

**Scope:** entire repository — Rust backend (`src-tauri/src`, ~120 modules) and React/TypeScript frontend (`src`).
**Method:** three parallel deep-audit passes (chat engine + harness sessions; platform Rust; frontend React/zustand), each finding verified against surrounding source by the auditor, then the highest-severity claims independently spot-checked against the current tree. Supplemental mechanical signals: type-check, unwrap density, TODO census.
**Companion doc:** `CODEBASE_AUDIT_FULL_2026-09-14.md` (previous round). This report reflects the *current* tree (incl. all fixes merged since) and supersedes it for present-day state.

**Verification status at audit time:** backend `cargo test --lib` 1165/1165 passing · frontend `tsc --noEmit` clean · vitest 162/162 files passing. All findings below are latent defects, not current test failures.

**Totals: 3 high · 16 medium · 24 low.** (`cargo clippy` unavailable in this toolchain — `rustup component add clippy` recommended.)

> **REMEDIATION STATUS (updated 2026-09-17):** every finding was fixed EXCEPT two reclassified after re-reading the code: **L-6** (the generation arm sits strictly after a successful spawn — not a defect) and **M-8** (finalizing the discarded slot would regress the "Done ✓ but still working" fix; covered by the reader-EOF drain instead — a clarifying comment now sits at the site). Post-fix verification: backend 1165/1165 tests, frontend 162/162 test files, `tsc --noEmit` clean, production build OK.

---

## HIGH

### H-1 · ✅ FIXED — [hang/concurrency] Foreground `run_shell` can wedge the turn forever joining pipe-drain threads
`src-tauri/src/chat/tasks.rs:590` (also background variant `tasks.rs:986-1010`)
```rust
let _ = child.kill();
let _ = child.wait();
let mut out = out_thread.join().unwrap_or_default();
```
`child.kill()` terminates only the direct `cmd.exe`/`sh`, not its tree. Any grandchild that inherited the stdout/stderr pipe write handles (`start /b`, `npm run` wrappers, daemonizing commands — including the timeout path at 579-584) keeps the pipe open, so the drain threads (544-571) never see EOF and `join()` blocks indefinitely. The caller (`dispatch.rs:725-733`) awaits it inside `spawn_blocking` with no timeout → the turn never returns a tool result. Background `shell_task` has the same root cause: a cancelled shell whose grandchildren hold pipes leaves the task `Running` forever.
**Fix:** kill the process tree (`taskkill /T /F`, as `lifecycle::kill_child_tree` does) before joining; bound the joins (channel + grace wait, then leak the tails).

### H-2 · ✅ FIXED — [availability/missing timeout] OAuth token exchange/refresh/registration have no HTTP timeout
`src-tauri/src/connectors/oauth.rs:945, 1168, 153`
```rust
let http = reqwest::Client::new();
```
`Client::new()` sets no timeout and no outer `tokio::time::timeout` wraps these awaits. A wedged token endpoint parks `refresh_access_token_inner` forever — and it gates **every** connector tool call and `github.rs::resolve_repo`, hanging the entire connector surface. In `run_flow`, a hung `exchange_token` also leaves the RAII "already in progress" marker set until app restart.
**Fix:** one shared client with `.timeout(30s).connect_timeout(10s)`, or wrap each await in `tokio::time::timeout`.

### H-3 · ✅ FIXED — [performance/react] ChatView selector returns a fresh object every store notification → re-render storm
`src/components/chat/ChatView.tsx:147-149`
```ts
const sessionTaskMap = useChatStore((s) =>
  activeChatSessionId ? (s.tasks[activeChatSessionId] ?? {}) : null,
);
```
With no tasks for the session (the common idle case) every store notification — every composer keystroke (`composerDrafts` lives in the same store), every token flush of *any* session — yields a new `{}` that fails zustand's `Object.is` bail-out and re-renders the whole ChatView. `GitToolsSidebar.tsx:37` already solves this with a module-level `EMPTY_TASKS` constant.
**Fix:** use a module-level empty-object fallback (or select the map and default inside the memo).

---

## MEDIUM

### Backend — chat engine

**M-1 · ✅ FIXED — [error handling] Harness turn swallows assistant-row persist failure and still emits `chat:done`** — `src-tauri/src/agent_sessions/mod.rs:1255`
`add_chat_message(...).ok()` — on insert failure the reply text is cleared and lost, usage is still reported, and `chat:done` reports success. The built-in path treats persist failure as a failed turn (`chat/mod.rs:1128-1150`); the harness path silently drops the user's answer. *Fix:* propagate like the built-in path (emit `chat:error`).

**M-2 · ✅ FIXED — [race] Stream abort-handle inserted into registry after the task is spawned** — `src-tauri/src/chat/mod.rs:1414-1416` (task tail cleanup at 1404)
If the spawned turn finishes before the parent inserts, a handle for a *dead* task is registered: `has_active_stream(sid)` reports "turn in flight" forever (Session Mesh queues peer mail to a chat nobody is working on), never swept. Two overlapping sends can also overwrite the live stream's abort handle, making it uncancellable. *Fix:* insert only if `!handle.is_finished()` under the same lock.

**M-3 · ✅ FIXED — [hang/missing timeout] Compaction summarize call has no request timeout** — `src-tauri/src/chat/cloud_compact.rs:208`
Non-streaming `.send().await` on the shared streaming client (connect-timeout only, deliberately no body timeout). A server that accepts and never responds hangs `compact_and_retry` forever with the UI stuck at "Context window full — compacting and retrying…". *Fix:* `tokio::time::timeout` (~120s) or a bounded client — the one-shot path (`chat/mod.rs:2009-2012`) already does this.

**M-4 · ✅ FIXED — [resource leak/missing timeout] Citation-verify background task unbounded** — `src-tauri/src/chat/citation_verify.rs:82,99` (spawned detached at `chat/mod.rs:1220-1265`)
Same unbounded-body exposure on a fire-and-forget task: a wedged endpoint leaks the tokio task plus its cloned AppHandle/DB Arc per research turn. *Fix:* bounded client or timeout wrapper.

**M-5 · ✅ FIXED — [hang] Cancel on a task whose runner already died reports "Cancelling…" forever** — `src-tauri/src/chat/tasks.rs:393`
If the runner future died, `tx.send(())` fails silently and the snapshot stays `Running`; the registry sweep retains running tasks unconditionally, so `get_task_status` reports "running" forever. *Fix:* on oneshot send failure, finalize the entry as Failed; sweep Running entries whose cancel sender is gone.

**M-6 · ✅ FIXED — [dangling marker] `spawn_task_fanout` can leave an unclosed `<tool>` marker in the persisted transcript** — `src-tauri/src/chat/dispatch.rs:1187` (close emitted at `streaming.rs:1252-1255`)
A cancel/abort between the fan-out pre-pass and the in-order pass leaves a dangling `<tool>` block in `full`/`partial_buf`; the segment parser renders it as an eternally "working" step after reload. *Fix:* close dangling markers on the partial-persist path.

**M-7 · ✅ FIXED — [hot-path contention] Token emitter holds the global registry lock while cloning the payload** — `src-tauri/src/chat/stream_events.rs:74`
`emit_chat_token` runs per token per session; the payload clone and IPC `Channel::send` happen under the global `REGISTRY` mutex, so one chatty turn taxes every other session's emits. *Fix:* clone the `Channel` out from under the lock, drop the guard, then send.

**M-8 · WON'T FIX (deliberate, documented in-code) — [FIFO edge] Registered-subagent FIFO slots discarded without finalizing the panel** — `src-tauri/src/agent_sessions/tracker.rs:77`. Rationale: the discarded slot belongs to a REGISTERED subagent whose real completion arrives later by exact tool_use id / `task_notification` (background agents legitimately run for minutes) — finalizing on the discard would resurrect the "Done ✓ but still working" bug. Failure paths are covered by the reader-EOF `fail_pending` drain and `finish_background`; a comment at the site now records the trade-off.
An out-of-order result at the FIFO head silently drops the slot; if the matching `task_notification`/exact-id result never arrives, the Agents-pane chip spins until reader EOF. *Fix:* finalize the subagent meta (error/timeout) on this discard path.

### Backend — platform

**M-9 · ✅ FIXED — [security] Duplicate push listeners re-registered on every relay restart** — `src-tauri/src/mobile/relay.rs:272,293`
`start_relay` re-registers `chat:approval-request`/`chat:done` listeners each call; after N restarts every event fires N handlers → N duplicate push notifications and leaked AppHandles. The sibling `mobile:session_chat_event` listener already uses a `claim_listener_slot` guard — these two were missed. *Fix:* same AtomicBool compare-exchange pattern (`relay_owner.rs:19-24`).

**M-10 · ✅ FIXED — [security/cmd injection] `cmd_quote`'s `\"` escaping is ineffective under cmd.exe** — `src-tauri/src/mcp_gallery.rs:322-336` (used at 391-396)
cmd.exe doesn't treat `\` as an escape; an MCP-server arg like `a"&calc&"` becomes `"a\"&calc&\""` and cmd exits the quoted region at the second quote, executing `&calc&` when the custom server spawns. One remembered "Allow" per exact command line is the only gate. *Fix:* double inner quotes (`""`) and re-quote, or refuse `"` in custom-server args.

**M-11 · ✅ FIXED — [security] Nonce anti-spoofing bypassable on tauri-managed browser panes** — `src-tauri/src/commands/browser_cmds.rs:118-125` + `browser/actions.rs:19-23`
Omitting `nonce` selects the unverified `resolve_action` path, which pages inside the pane can reach via the invoke fallback (`browser_js.rs:65`) — a hostile page can spoof any in-flight agentic action result. *Fix:* make the nonce mandatory.

**M-12 · ✅ FIXED — [security/script injection] `pane_id`/`tab_id` interpolated unescaped into injected JS string literals** — `src-tauri/src/browser.rs:1222-1242,1253-1294`
Renderer-supplied ids are inserted between single quotes in `format!`-built JS; an id containing `'` breaks out and executes script in the page context — exactly what the URL allowlist exists to prevent. *Fix:* JSON-encode ids (`serde_json::to_string`) as `build_resolve_js` already does.

**M-13 · ✅ FIXED — [security/consistency] Mobile relay `stop_relay` leaves live E2E connections fully authorized** — `src-tauri/src/mobile/relay.rs:418-423`
Only the oneshot abort + port clear; established WebSockets keep their pre-rotation key and full command surface indefinitely, defeating the "token rotated on every start" fail-closed gate. *Fix:* drain/broadcast-close the `conns` registry on stop (or stamp connections with a relay generation).

**M-14 · ✅ FIXED — [security/argv] `github_draft_pr_text` interpolates renderer-supplied `base` into git argv without the leading-dash guard** — `src-tauri/src/github.rs:493-499`
`format!("{base}...HEAD")` → a `base` starting with `-` is parsed by git as an option (e.g. `--output=<path>` writes the diff to an arbitrary path). Every sibling path (`create_branch`, checkout, worktree, scoped diff) validates; this one doesn't. *Fix:* reject leading `-` / validate ref shape.

### Frontend

**M-15 · ✅ FIXED — [stale-state race] ContextMeter breakdown fetch has no stale guard** — `src/components/chat/ContextMeter.tsx:260-267`
Hover session A (fetch starts), switch to B — the in-flight A-fetch resolves and writes A's token breakdown into B's tooltip; the refetch gate (`undefined | null`) then never re-fires. B shows A's numbers indefinitely. *Fix:* stale-flag the fetch keyed to `breakdownKey`.

**M-16 · ✅ FIXED — [stale-state race] `refreshAttached` can land a previous session's connector rows in the new session** — `src/components/chat/ChatComposer.tsx:530-542`
Fast switch A→B: A's slow `listSessionConnectors` resolves after B's; B's composer shows A's attach chips and the next send appends A's `[Connected: …]` marker and detaches A's rows from B. *Fix:* stale-flag on `chatSessionId` change.

**M-17 · ✅ FIXED — [state race] `steerQueuedMessage` queue snapshot races `drainQueue`, duplicating a user turn** — `src/state/chat/slices/composerSlice.ts:27-45`
If `onDone` fires between the queue snapshot and the park, `drainQueue` pops the head and the restore re-inserts it — the steered message sends twice, and anything drained in between is silently dropped. *Fix:* re-read the queue inside the park/restore (exclude the drained head).

**M-18 · ✅ FIXED — [performance] GitToolsSidebar subscribes to the whole `streaming` map** — `src/components/chat/GitToolsSidebar.tsx:213`
`onToken` replaces the `streaming` object identity per token flush, re-rendering the always-mounted sidebar (plans/progress/agents/mesh) at token rate though it only derives booleans. *Fix:* `useShallow` over `Object.keys(s.streaming)` (as `Sidebar.tsx:169` does).

---

## LOW

### Backend — chat engine

**L-1** `agent_sessions/mod.rs:1255` follow-on — *covered in M-1.*
**L-1 · ✅ FIXED — [consistency] Second watcher expiry loses a late cross-session answer** — `session_fabric/mod.rs:993` — after ceiling+re-arm (2×15 min) the mail is EXPIRED and a later answer is never pushed as the promised follow-up turn. *Fix:* leave a late-answer watcher/marker at expiry.
**L-2 · ✅ FIXED — [error handling] Rate-guard treats a transient DB read failure as "rate limit reached"** — `session_fabric/mod.rs:788` — `count_mail_from_since(...).unwrap_or(MAX_MAIL_PER_HOUR)` fail-closes mesh messaging with a misleading message (inconsistent with the fail-open `spawn_depth` right below). *Fix:* distinct error path.
**L-3 · ✅ FIXED — [performance] `summaries_for` is N+1 (one SELECT per peer, up to 50)** — `db/session_fabric.rs:187`. *Fix:* single `IN` query.
**L-4 · ✅ FIXED — [robustness] `dirwatch.rs:132,180` are the only poison-propagating `lock().unwrap()` sites in agent_sessions** — one panic in the notify callback permanently poisons the lock and panics the reader thread, skipping turn cleanup. *Fix:* `unwrap_or_else(|e| e.into_inner())` (codebase convention).
**L-5 · ✅ FIXED — [security-adjacent/TOCTOU] Harness turn wrapper batches live in the shared temp dir** — `harness_adapters/mod.rs:466` — same-user local processes can swap `relay-turn-wrappers\*.cmd` between the read-back check and execution (wrappers run arbitrary commands with Relay's privileges). *Fix:* pid-keyed subdirectory with restrictive ACLs, or write-temp+rename immediately before spawn.
**L-6 · N/A (verified not a defect) — [correctness] `claude.rs:215` generation/`reader_alive` arming** — re-read at fix time: the arming block sits strictly AFTER `cmd.spawn()?` (the `?` early-returns first), so a spawn failure cannot leave a phantom "alive" reader. No change needed.
**L-7 · ✅ FIXED — [performance] Per-round `[prompt-audit]` eprintln re-serializes the full tool-spec JSON every round** — `chat/streaming.rs:1344-1345` (OpenAI loop only; diverges from the Anthropic loop). *Fix:* env-gate / log once per turn.
**L-8 · ✅ FIXED — [resource leak] Temp print HTML leaks when `PrintToPdf` fails** — `chat/pdfprint.rs:352-368` — the error path skips the `cleanup` closure other returns use. *Fix:* route through `cleanup`.

### Backend — platform

**L-9 · ✅ FIXED — [security] Dynamically registered OAuth `client_secret` persisted as plaintext `oauth-clients.json`** — `connectors/oauth.rs:106-127` — contrary to the codebase's keychain discipline (pairing token, API keys, connector tokens). *Fix:* route through `secrets::generic_store`.
**L-10 · ✅ FIXED — [resource leak] Browser roundtrip maps leak oneshot senders on every timeout** — `browser/tabs.rs:235/244, 159/170, 349/353, 392/396` — timeout arm doesn't remove the entry; unbounded growth when the frontend doesn't answer. *Fix:* remove on the `Err` arm.
**L-11 · ✅ FIXED — [concurrency] `mobile/session_chat.rs:824-830` — `blocking_read` parks a tokio worker and its `expect` kills the phone's WS connection on panic.** *Fix:* await a `JoinHandle`; return an error instead of `expect`.
**L-12 · ✅ FIXED — [resource] Unbounded owner channel vs stalled phone socket** — `mobile/relay_ws.rs:135-137` + `relay.rs:842` — memory grows with streamed tokens while a half-open socket holds the write lock. *Fix:* bounded channel + drop/flag when full.
**L-13 · ✅ FIXED — [performance] Synchronous model-dir scans inside async relay handlers** — `mobile/relay.rs:2193-2216, 2125-2146`. *Fix:* `spawn_blocking` + short-TTL cache.
**L-14 · ✅ FIXED — [error handling] Partial DB-move copy leaves a torn destination then permanently refuses retries** — `commands/data.rs:163-170` — a failed copy mid-loop bricks the target with a misleading error. *Fix:* delete written target files on failure.
**L-15 · ✅ FIXED — [portability] `ensure_commandcode_bridge` hardcodes `Command::new("cmd")`** — `browser_mcp_register.rs:332-343` — dead feature + repeated failed spawns on non-Windows. *Fix:* `#[cfg(windows)]` the whole path.
**L-16 · ✅ FIXED — [security hardening] Relay accept loop spawns a handler per TCP stream with no cap** — `mobile/relay.rs:354-411` — any tailnet peer can accumulate handler/pump tasks (pump spawns before pairing). *Fix:* semaphore cap + per-peer backoff after failed pairing.

### Frontend

**L-17 · ✅ FIXED — [memory leak] `composerDrafts` never cleared on delete; `deleteAllChats` also misses `supersededPartial`** — `state/chat/moduleState.ts:402-512`, `slices/sessionsSlice.ts:469-509`. *Fix:* add both to the reset paths.
**L-18 · ✅ FIXED — [error handling] `void deleteChat(id)` without catch** — `components/sidebar/Sidebar.tsx:257`, `slices/sessionsSlice.ts:272,275` — destructive action fails silently (row stays, no toast, unhandled rejection). *Fix:* `.catch(toastError…)`.
**L-19 · ✅ FIXED — [error handling] Full-auto confirmation modal can wedge open on IPC failure** — `components/chat/ChatView.tsx:1764-1768` + `sessionsSlice.ts:696-712` — rejection leaves the modal open with no feedback. *Fix:* catch + toast.
**L-20 · ✅ FIXED — [key collisions] Slash-menu rows keyed by slug/trigger collide across item kinds** — `components/chat/ChatComposer.tsx:1662` (e.g. a skill slug colliding with the static `compact` command). *Fix:* key on `` `${kind}:${slug ?? trigger}` ``.
**L-21 · ✅ FIXED — [listener leak, self-healing] Queue-row drag listeners survive row unmount mid-drag** — `components/chat/composerChrome.tsx:100-103`. *Fix:* cleanup on unmount (mirror `pointerDrag.ts`).
**L-22 · ✅ FIXED — [performance] Every `cost:updated` event flashes loading and refetches the full rollup** — `hooks/useCostRollups.ts:17-31`. *Fix:* debounce; silent refresh when data exists.
**L-23 · ✅ FIXED — [correctness] DocxViewer caches `naturalPageWidth/Height` from a partially rendered document** — `components/chat/DocxViewer.tsx:60-67` — ResizeObserver can fire mid-render; the 0-guard never re-measures, leaving a wrong fit-to-width scale. *Fix:* measure only after the render epoch commits.
**L-24 · ✅ FIXED — [error handling] `newChat` rejection unhandled in `useNewChatAction.ts:21`** — no toast, view never switches. *Fix:* `.catch(toastError…)`.
**L-25 · ✅ FIXED — [notification logic] Split view: a turn completing in a visible-but-unfocused pane still toasts/chimes/marks unread** — `hooks/useChatEvents.ts:54-58` + `streamingSlice.ts:634-636`. *Fix:* treat any session in an open pane buffer as "viewing".

---

## Mechanical signals

| Signal | Value | Note |
|---|---|---|
| Backend tests | 1165 passed / 0 failed | `cargo test --lib` at audit time |
| Frontend type-check | clean | `tsc --noEmit` |
| Frontend tests | 162/162 files | vitest (one known load-flake: `jsxPreviewRuntime` timeout under full parallel load — passes isolated) |
| `cargo clippy` | not installed | `rustup component add clippy` — worth wiring into CI |
| `.unwrap()` in non-test Rust | ~1,733 occurrences | breadth signal only — most are infallible parses/locked-invariants, but the audit found several genuinely reachable ones (H-1, L-4, L-11) |
| TODO/FIXME census | ~15 | mostly deliberate scaffolding (`codeexec.rs` sandbox TODOs, `harnessModels.ts` static catalog) |

---

## Verified-clean areas (audited, no defects found)

- **Chat engine:** Hermes parser slicing (`proto.rs`), `<tool_call` suppression + char-boundary carry (`streaming.rs`), permission scope checks incl. move/download gates (`permission.rs`), stream watchdog + reconnect ladder, per-round usage accounting, `partial_buf`, `turn_perf` lifecycle, TaskManager id sweep.
- **Platform:** `relay_crypto.rs` (constant-time proof, counter nonces), DB migrations (`db/mod.rs`), FTS sanitization (`db/chat.rs`), keychain discipline (`secrets.rs`), `git.rs` argv guards + repo-relative path validation, `pty/mod.rs`, `exec_gate.rs`, `pinned_zip.rs` (zip-slip), `local_model_market.rs`, `gmail_api.rs`/`google_rest.rs`, `browser_mcp.rs` loopback+token gate.
- **Frontend:** `safeListen` unmount races (all four audited sites correctly invoke late unlistens), `maskRelayAsk`/`parseSegments` JSON guards, localStorage parse guards, `pointerDrag`/`chatPaneDnd`, TTS token-guarded pump, TerminalPane listener lifecycle, ContextMeter render-time reset pattern.

## Recommended remediation order

1. **Now:** H-1 (user-facing permanent turn wedge), H-2 (connector surface hangs), M-2/M-5 (stuck "running" states that mislead both user and model).
2. **Next:** M-9–M-14 security batch (all small, mechanical fixes), M-15–M-18 frontend races (each is a stale-flag or selector tweak).
3. **Scheduled:** LOW items batched by module; add `clippy` to CI; consider a follow-up audit of `chat/codeexec.rs` sandbox TODOs before enabling that tool broadly.
