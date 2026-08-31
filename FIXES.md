# Fix Log — Companion to AUDIT.md

Fixes applied for the findings in `AUDIT.md`, in its priority order. Verification at the bottom. Line numbers refer to the tree after the fixes; finding IDs reference `AUDIT.md`.

## Fixed

### Security
- **[S-1] Relay E2E pairing fails open on empty token** — `src-tauri/src/mobile/relay_crypto.rs` `verify_pair_proof()` now fails closed when `expected_token` is empty (the HMAC("") proof was publicly computable); `src-tauri/src/mobile/relay.rs` `handle_connection()` rejects with "no pairing token configured" before verifying. Tests: `pair_proof_round_trip`, `pair_proof_fails_closed_on_empty_token`.
- **[B-24] E2E connections accepted plaintext command frames** — `relay.rs` request loop rejects `Message::Text` with a protocol-violation error whenever the connection paired via E2E (`used_e2e`), matching what `relay_ws.rs` always documented. *Deferred:* nonce/challenge-based pairing proof (the static proof remains replayable; this needs a protocol change on the phone side).
- **[B-25] Unauthenticated peers received broadcast pushes** — `relay.rs` moves the `conn_registry` insert + `ConnCleanup` registration to after successful pairing; every pre-pairing failure path now returns before registration.

### Silent turn death / hangs
- **[B-1] Byte-slice panics on multi-byte text** — `src-tauri/src/chat/mod.rs` `compute_docs_retrieval()` and `src-tauri/src/chat/dispatch.rs` `run_search_docs_tool()` now truncate via `util::truncate_chars` (char-safe) instead of raw byte slicing.
- **[B-9] Missing stream stall watchdogs** — new shared helper `streaming.rs::stream_next_with_watchdog()` (60s); wired into `anthropic_stream_round`, `run_chat_stream` (non-tool), and the subagent loop (`dispatch.rs`). The OpenAI round keeps its existing inline watchdog (with the post-`stop` 2s grace).
- **[B-10] No HTTP timeouts** — `ChatManager.client` now has `connect_timeout(20s)`; all streaming `.send()` calls are wrapped in a 60s time-to-headers `tokio::time::timeout` (deliberately NOT a total request timeout, which would kill long streams); the five ad-hoc per-call clients (`generate_chat_title`, `generate_commit_message`, `generate_diff_review`, `list_chat_models`, `run_task_subagent`) get `connect_timeout(20s)` plus a 120s total timeout (safe for non-streaming JSON).
- **[B-4] ACP handshake failure wedged the chat**, **[B-5] dead persistent claude/ACP process never respawned**, **[E-5] respawn race on `turn_in_flight`** — `agent_sessions.rs` gains `reader_alive` (RAII guard cleared on every reader exit) and a per-process `proc_generation`. Respawn now triggers when the reader is dead even if `child` is `Some`; the stale reader can only clear `turn_in_flight` when its generation still owns the process. Helper `should_clear_in_flight()` is unit-tested.
- **[B-12] ACP replied to server requests with `id: 0`** — the `AcpLine::Request` arm destructures and echoes the real id.
- **[B-13] Error responses for ACP turns ≥ 2 ignored** — the reader also compares against `acp_request_id` (later turns), fails the turn, and consumes the id so a duplicate can't re-fail.
- **[B-3] Windows browser panes couldn't return action results** — `browser.rs` adds `attach_web_message_bridge()` (`add_WebMessageReceived`) on every raw pane; `action_wrapper_js` / `pushstate_injection_js` now prefer `window.chrome.webview.postMessage` (WebView2-native) and fall back to `__TAURI_INTERNALS__.invoke` on tauri-managed (macOS/Linux) panes. `browser_action_result` command accepts an optional nonce; every pending action carries a per-action 64-bit nonce (`resolve_action_verified`) so an untrusted page can't spoof results with guessed sequential ids. *Pending runtime verification:* open a pane, run `typeof window.__TAURI_INTERNALS__` (expect `"undefined"`) and one `browser_read` (expect < 5s).

### Data integrity
- **[B-6] Cancelled opencode turn leaked partial text into the next turn** — `cancel()` clears `oc_full`/`oc_in_think` (backstop) and the turn thread's cancelled branch clears them too.
- **[B-19] Failed turns discarded all streamed content (frontend half)** — `chat.ts` `onError` persists the partial via `persistPartialChatMessage` before clearing state (the backend still doesn't persist on error, so no double-persist is possible).
- **[B-29] Non-transactional multi-statement writes** — wrapped in `unchecked_transaction`: `delete_chat_message`, `replace_file_chunks` (the RAG silent-data-loss path). *Partially done:* the remaining helpers from the audit list (`remove_project`, `remove_corpus`, `delete_indexed_files_not_in`, `delete_chat_sessions_for_project`, `delete_chat_session`, `delete_chat_messages_after`, `delete_session`) are the same mechanical pattern and can be wrapped in a follow-up pass.
- **[B-30] Migration crash-window skipped gated backfills** — `migrate_chat_session_agent` and `migrate_cost_v2` backfills are gated on persisted `app_settings` markers (`db.migration.agent.backfilled` / `db.migration.cost_v2.backfilled`) instead of "did the ALTER just add the column"; `ensure_settings_table()` keeps isolated schemas working. The two migration tests pass under the new contract.
- **[B-31] Deleting a compaction summary hid folded messages forever** — `delete_chat_message` (in the new transaction) clears `superseded_by` on rows pointing at the deleted id.
- **[E-9e user-message persist order]** — not changed; instead the E-4 reorder in `send()` now checks `turn_in_flight` *before* persisting the user message, so a rejected send can't leave an orphan row.

### Correctness / protocol
- **[B-11] Anthropic subagents 400'd on round 2** — `dispatch.rs` `run_subagent_loop` accumulates thinking blocks (text + signature, per index) and echoes them, in order, at the front of the round-2 assistant blocks — mirroring the main loop.
- **[B-14] UTF-8 corruption at chunk boundaries** — new `util::SseLineBuffer` (byte-buffered, converts only complete lines; `finish()` for EOF); wired into all four SSE readers (OpenAI round, Anthropic round, non-tool path, subagent loop).
- **[B-15] Anthropic non-tool usage recorded input_tokens = 0** — `parse_usage` now merges: input + cache fields from the first usage event (`message_start`), output from the last (`message_delta`).
- **[B-16] HTTP status unchecked in oneshots** — `openai_oneshot`/`anthropic_oneshot` return `Err("HTTP {status}: {body}")` instead of silently yielding `""` (which automations persisted as blank replies).
- **[B-17] Mid-stream provider error events swallowed** — detected in both `parse_sse_chunk` impls (`{"error":…}` / `{"type":"error"}`), the OpenAI tool loop, the Anthropic tool loop, and the subagent loop; the turn fails with `provider error: {message}`.
- **[B-18] Fatal SSE framing strictness on the non-tool path** — `providers.rs` parsers tolerate `data:` without a space; `run_chat_stream` tolerates malformed lines up to `MAX_PARSE_FAILURES` (50) instead of dying on the first; the subagent loop's prefix check is tolerant too. `{"error":…}` events remain immediately fatal (prefix `provider error:`).
- **[B-7] PTY respawn race** — the old pane's waiter now checks whether the registered pane for its id is still the same `Arc` instance before stripping the `session_to_pane` mapping and emitting `pty:exit`; a replaced pane's cleanup is skipped, a real close still emits (kill_pane relies on it).
- **[E-4] Harness switch killed the in-flight turn before rejecting** — the `turn_in_flight` gate now runs before both the persist and the harness-switch teardown.
- **[E-8] OAuth flow leaks / wedged callback port** — `FlowEntryGuard` (RAII) removes the pending-flow entry on every exit path; `accept_one_callback` sets 10s socket read/write timeouts after accept so a stalled local process can't hold the fixed port until app exit.
- **[E-9 misc]** — plan tool returns `Error: unknown plan tool …` instead of `""` (`E-9d`); PTY spawn errors kill the already-spawned child (`E-9b`); harness model ids validated against cmd.exe metacharacters via `harness_adapters::ensure_cmd_safe_model` (`E-9c`); `steerQueuedMessage` passes the session id through to `cancelStream`/`sendMessage`; `openArtifactTab` dedupes inline artifacts and refreshes their payload; CommandPalette `selectSession` gets the Sidebar-style `.catch`; updater `check()` catches; `exportSession` uses local-date formatting (`formatLocalDate`); `onToken` has the same straggler guard as `onPerf` (entry pre-created by `sendMessage`/`broadcastToSessions`, verified before adding the guard).

### Frontend turn lifecycle
- **[B-20]** `onDone` relist wrapped in try/catch — a rejecting `listChatSessions` can no longer strand the message queue (new test `onDoneQueueDrain.test.ts`).
- **[B-21]** Split-view composer keys the queue selector, `pickWorkingFolder`, and all four queue actions off `sessionIdProp ?? activeChatSessionId`.
- **[B-22]** `broadcastToSessions` passes the store's real `toolsEnabled`/`codeExecEnabled` — background broadcast turns no longer run with tools silently off (`broadcast.test.ts` updated + new case).
- **[B-23]** `cancelStream`/`deleteMessage` refetch with the 200-message limit and set `hasMoreHistory` correctly.

### Performance
- **[P-1]** `fs_read_file` reads `FS_READ_MAX + 4` bytes via `File::take()` instead of loading whole files.
- **[E-9g]** `github.rs` caches the git-config proxy lookup in a `OnceLock` (was 2 subprocesses per API call).
- **[B-8 partial]** `cancel_agent_chat_message` is now an async command running `cancel` on a blocking worker — the main thread no longer freezes while `send` holds the global sessions mutex. *Deferred:* the deeper fix (narrowing the `send()` lock scope around spawn/git-snapshot/wait-ready) is a larger locking refactor.

### Docs / honesty
- **[E-1]** Corrected the comments claiming a sandbox exists: `codeexec.rs` (interpreter() note), `tools/mod.rs` (`requires_local_sandbox` field doc — "bundled ≠ confined"), `RUN_SHELL_DESC` ("run_code for sandboxed snippets" → "short snippets").

### Build / CI
- **[B-2] macOS/Linux build was broken** — `browser.rs` COM touchpoints (`navigate`, `open_devtools`, `eval`, `run_action_for_pane_opts`) are `#[cfg(windows)]` with non-Windows fallbacks via the tauri-managed pane (`eval_js` / `navigate_to` / `open_devtools_pane`); the dead non-Windows `with_core_on_main` stub is gone. Added a `check-macos` compile-only CI job (`.github/workflows/build.yml`). *Note:* could not be verified on this Windows host (macOS cross-check fails at a `cc` build script before our code compiles) — the CI job is the verification.

## Deferred (with reasons)
- **[B-26-related]** Mobile `ChatTurn` runs on a spawned task with a `select!` over the socket (cancel now works mid-turn); other commands received mid-turn get an honest "busy" error rather than full reentrant dispatch.
- **[B-28]** PID-based stale automation locks implemented on Windows (OpenProcess/GetExitCodeProcess, `windows-sys` Threading feature added); non-Windows keeps the 6h age fallback (no cheap liveness probe wired).
- **[E-1 risk]** The actual OS sandbox for `run_code` (Landlock/Job Objects/sandbox-exec) remains future work — the hooks and honest warnings exist; wiring them is a feature, not a bug fix.
- **[B-24 protocol]** Nonce/challenge pairing proof — needs a coordinated phone-side protocol change.
- **[E-9 misc not done]** `started_at` per-turn reset for claude turns was included in the sessions fixes; `onStatus` symmetric guard, artifact-maps eviction (`P-3`), nav-injection thread pooling (`P-2` — the early-exit is covered by the B-7-era map check pattern) remain open, all Low.
- **[E-9h harness model quoting]** Solved by validation (`ensure_cmd_safe_model`) rather than quoting through cmd's `%*` — quoting is fragile; validation rejects the dangerous surface with a clear error.

## Verification
- `cargo check` — clean (0 errors; pre-existing warnings only).
- `cargo test` — **574 passed, 0 failed**, 11 ignored (includes new tests: pair-proof fail-closed, `should_clear_in_flight`, `ensure_cmd_safe_model`, pid_alive, SseLineBuffer, browser wrapper nonce/transport, migration marker behavior, plus the sessions-agent's tests).
- `npx vitest run` — **74 files / 499 tests passed** (baseline before fixes: 71/491; +3 new test files, updated broadcast assertions).
- Not run here: the GUI app itself. **Recommended manual checks:** (1) browser pane on Windows — `browser_read` resolves quickly (B-3 runtime verification, see AUDIT.md B-3 reproduce steps); (2) mobile stop button mid-turn (B-26); (3) a long Anthropic turn still streams past 60s (proves the B-10 header-only timeout doesn't clip streams).
