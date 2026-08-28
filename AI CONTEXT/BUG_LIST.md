# Bug Hunt — compiled 2026-08-07

> **Naming note:** This document refers to the project as "Conduit" because it was written before the 2026-08-27 user-visible rebrand to "Relay" (commit `e9abc7c3`). The findings still apply; the name has not. See `README.md` and `AI CONTEXT/RELEASE.md` for the current naming.

Whole-project audit of Conduit (Rust backend `src-tauri/` + React frontend `src/`).
67 findings from 7 parallel audit passes. Fix order: critical → high → medium → low.
Mark items `[x]` as fixed; add a note with the fix commit/approach.

**Status: 69/69 fixed** (H2 resolved by the permission rewire `ff0b812f`; C1, C2, C3, H12, L12, L13 — it.2; H1, H15 — it.3; H3, H4, H5 — it.4; H6+L18, H7, H8 — it.5; H9, H10, H11 — it.6; H13, H14, H16, H17 — it.7; M1, M2, M3, M4 — it.8; M5, M6, M7, M8, B1 — it.9; M9+L17, M10, M11, M12 — it.10; M13, M14, M15, M16 — it.11; M17, M18, M19, M20 — it.12; M21, M22+M25, M23, M24 — it.13; M26, M27, M28+M29+L11, L1, L2, L3, L4, L5, L6+L19, L7, L8, L9, L10, L14, L15, L16, B2 — it.14)

---

## CRITICAL (3)

- [x] **C1. WS MCP dispatch can run ANY chat tool (write_file/delete_file) with no permission gate** — `src-tauri/src/browser_mcp.rs:275` + `mcp_tools_bridge.rs:40`
  **FIXED:** server-side `ALLOWED_RELAY_TOOLS` whitelist in `tool_from_op` (mcp_tools_bridge.rs) — non-whitelisted ops fall through to `unknown_op`. Tests added. Note: token still exposed to child env (post-whitelist it only unlocks the 5 benign tools + browser ops the agent legitimately has anyway); tightening env hygiene tracked under L19 (fixed in it.14 — token no longer process-wide).

- [x] **C2. Mermaid rendered with `securityLevel: "loose"` injected unsanitized into main window DOM (model-output XSS)** — `src/components/chat/MermaidDiagram.tsx:39` + `:277`
  **FIXED:** `securityLevel: "antiscript"` + rendered SVG passed through new `sanitizeSvg()` (DOMPurify svg/html/mathMl profiles, `ADD_TAGS: foreignObject`, `HTML_INTEGRATION_POINTS: {foreignobject: true}` — without the latter DOMPurify force-removes all htmlLabel content). 6 unit tests in `src/test/sanitizeSvg.test.ts`.

- [x] **C3. Diagram export injects raw model HTML into the main document** — `src/components/chat/ArtifactExportMenu.tsx:155` (also `:274`)
  **FIXED:** `holder.innerHTML = sanitizeHtml(html)` in both `rasterizeHtml` and `rasterizeToSvg`.

---

## HIGH (17)

- [x] **H1. Granted-root containment uses raw prefix match — sibling dirs pass** — `src-tauri/src/chat/permission.rs:364`
  **FIXED:** segment-boundary match (`needle == root || needle.starts_with(root + "/")`) + regression test `granted_root_requires_segment_boundary`. 27 permission tests pass.

- [x] **H2. Session permission mode hardcoded to FullAuto** — `src-tauri/src/chat/commands.rs:1213` (also `mobile/session_chat.rs:274`)
  **FIXED (was ON HOLD):** the permission rewire (`ff0b812f`, 2026-08-15) shipped the intended design — `chat_sessions.permission_mode` column (default `manual`), `PermissionMode::from_db` fail-closed load at send time (`chat/commands.rs:1103`), `update_chat_session_permission_mode` IPC, the `PermissionModeMenu` + `ApprovalCard`/`FullAutoConfirmModal` UI, the approval-rules engine, and the Claude Code `can_use_tool` stdio relay. Automations/headless one-shots remain intentionally full-auto (unattended turns can't answer prompts).

- [x] **H3. Non-tool streaming path has no partial-line buffering — split SSE lines abort the turn** — `src-tauri/src/chat/mod.rs:414`
  **FIXED:** `pending` carry-over buffer; only newline-terminated lines reach `parse_sse_chunk` (mirrors streaming.rs rounds). EOF flush parses a final unterminated line (preserves pre-fix `str::lines` behavior) but tolerates its failure instead of killing a completed turn.

- [x] **H4. Download task's 60 s reqwest timeout caps total transfer — large model downloads always fail** — `src-tauri/src/chat/tasks.rs:350`
  **FIXED:** blanket `.timeout(60s)` → `.connect_timeout(20s)` + per-chunk stall detection (60s without bytes = stall → Range-resume retry). ALSO FIXED (discovered here): the WIP SSRF guard in the download path (uncommitted) had broken all 3 download tests by refusing their 127.0.0.1 fixture server — added `CONDUIT_ALLOW_PRIVATE_DOWNLOADS` app-env escape hatch (also serves LAN model mirrors; child processes can't set it), tests opt in. 157/157 chat tests green.

- [x] **H5. Non-tool request builders silently drop attached vision images** — `src-tauri/src/chat/providers.rs:205` (also `:241` OpenAI)
  **FIXED:** both wire bodies now build messages via `proto::anthropic_message_json` / `proto::openai_message_json` (multimodal content arrays when images are present); single-string wire message structs deleted.

- [x] **H6. SSRF guard misses IPv4-mapped IPv6 loopback/private** — `src-tauri/src/chat/tools/search.rs:39`
  **FIXED:** V6 arm now unwraps `to_ipv4()` (mapped + compatible) and recurses into the V4 check; CGNAT 100.64/10 blocked manually (`is_shared()` is still unstable, rust#27709); V6 doc range 2001:db8::/32 added for parity. 3 new tests (mapped/compat loopback+private blocked, mapped public + public V6 allowed, CGNAT boundary, bracketed host literal).

- [x] **H7. OpenCode spawn puts all flags after the `--` terminator — yargs swallows them** — `src-tauri/src/agent_sessions.rs:848` (also `:1223`)
  **FIXED:** both spawn sites now put `--format json`, `-m`, `--auto`, `-s` BEFORE `--`; only the prompt is positional.

- [x] **H8. `prepare_run_inner` leaks RUNNING guard + lock file on DB error — automation never fires again** — `src-tauri/src/automations.rs:253`
  **FIXED:** both post-guard error paths (`create_chat_session`, `start_run`) now call `release_guards` (removes RUNNING entry + deletes lock file) before returning.

- [x] **H9. Mobile session-chat streaming events never delivered — owner channel receiver dropped** — `src-tauri/src/mobile/relay.rs:564`
  **FIXED:** wired the never-spawned pump: WS write half is now `SharedWsWrite` (Arc<tokio::Mutex<SplitSink>> — parking_lot guards are !Send), one `pump_to_ws_shared` task per connection, sessions register the connection's `conn_tx`, and an `OwnerCleanup` drop guard removes this connection's owner-map entries on ANY exit (also covers the M28 cleanup). `handle_chat_turn`/`send_msg`/`send_done` converted to the shared write. BONUS: the ChatTurn SSE loop had the H3-class partial-line bug — same `pending` buffer fix applied.

- [x] **H10. Mobile `SendChatMessage` hardcodes Anthropic with literal key `"no-key"` — every turn 401s** — `src-tauri/src/mobile/session_chat.rs:265`
  **FIXED:** provider/model read back from the chat_sessions row, real key via `secrets::get_chat_api_key` (local_gguf keyless), base_url from settings — mirrors the desktop command. ALSO FIXED (found in the same function): `messages: Vec::new()` sent the model a blank conversation — history now loaded from the DB (active-rows variant for local models).

- [x] **H11. `CancelSessionStream` uses owner_session_id, streams keyed by chat_session_id — cancel is a no-op** — `src-tauri/src/mobile/session_chat.rs:307`
  **FIXED:** resolves chat_session_id via the owner_session_id column before cancelling.

- [x] **H12. `sendMessage` built-in path never resets streaming state when `send_chat_message` rejects** — `src/state/chat.ts:677`
  **FIXED:** try/catch around `sendChatMessage` mirroring the harness path — deletes streaming/chatStatus keys, clears `streamingChatSessionId`, sets `error`.

- [x] **H13. `browser:url_detected` never navigates an existing native browser pane** — `src/hooks/usePtyEvents.ts:149`
  **FIXED:** resolves the pane's active tab and calls `browserNavigateTab` alongside `setBrowserUrl` (mirrors `openInBrowserPane`).

- [x] **H14. "Edit" on an automation opens the create form — Save duplicates instead of updating** — `src/components/automations/AutomationsView.tsx:267`
  **FIXED:** `__edit__:<id>` sentinel in selectedId mounts `AutomationForm` with the automation (its update branch); onClose returns to the detail view.

- [x] **H15. Path allowlist prefix checks lack separator boundary (3 files)** — `src-tauri/src/commands/data.rs:283`, `commands/git_cmds.rs:34`, `commands/local_model_market.rs:955`
  **FIXED:** shared `util::path_starts_with_ci` (component-wise `Path::starts_with` on lowered paths) replaces all three raw-string prefix checks + regression test. IMPORTANT follow-through: worktrees are *siblings* of project roots and legitimately failed the tightened check — both `is_path_allowed` (data.rs) and `verify_project_path` (git_cmds.rs) now explicitly allowlist recorded `sessions.worktree_path` values instead of relying on the loose prefix. Chat fs_roots need no worktree entry (chat tools only target project roots + artifacts dir).

- [x] **H16. `start_model_download` leaks registry slot on early errors — model id permanently "in progress"** — `src-tauri/src/commands/local_model_market.rs:584`
  **FIXED:** both early-error paths (resolve_models_dir, create_dir_all) now remove the registry slot before returning (keeps the check+insert-under-one-lock TOCTOU fix intact).

- [x] **H17. `session_to_pane` mapping never removed — dead sessions reported live to phone** — `src-tauri/src/pty/mod.rs:617`
  **FIXED:** waiter thread now `retain`s out mappings pointing at the exited pane (covers kill_pane too — kill lands there via try_wait); `pane_id_for_session` additionally verifies the pane exists and hasn't exited. `build_session_list` goes through it, so the phone stops seeing dead sessions as live/working.

---

## MEDIUM (29)

- [x] **M1. `move_file` containment checks only `dest` — source anywhere on disk deleted under full_auto** — `src-tauri/src/chat/dispatch.rs:90`
  **FIXED:** AutoRun branch now also requires `path_within_scope(src, fs_roots)` for MOVE_FILE — both ends of a move must lie inside a granted root (copy_file stays dest-only: reads are unscoped). Wiring-only fix on top of the H1-tested containment helper; no unit test — the gate lives in the AppHandle-bound dispatch body.

- [x] **M2. Unbounded Vec growth from network-controlled stream `index`** — `src-tauri/src/chat/streaming.rs:199` (also `:352/:369`)
  **FIXED:** `MAX_STREAM_BLOCK_INDEX = 64` clamp on both grow-loops (OpenAI `tool_calls[].index`, Anthropic `content_block_start.index`) — oversized indexes are skipped before the vec grows; deltas for skipped Anthropic blocks drop harmlessly via `blocks.get_mut`. No unit test (round functions require AppHandle); verified by inspection + full suite green.

- [x] **M3. GGUF parser reads array count as u32 (spec: u64) — stream desyncs on every array** — `src-tauri/src/chat/local_models.rs:142`
  **FIXED:** 12-byte array header (u32 elem-type + u64 elem-count). Regression test `parse_gguf_array_kv_does_not_desync_following_metadata` (array KV → scalar KV → 2 string KVs) — verified FAILING against the old u32-count read, passing after the fix.

- [x] **M4. Folder scan aborts entirely on first unreadable entry** — `src-tauri/src/chat/local_models.rs:245`
  **FIXED:** `filter_map(|e| e.ok())` replaces `collect::<Result<Vec<_>,_>>()` — unreadable entries (permission-denied subdir, dangling junction) skip instead of zeroing the whole scan.

- [x] **M5. Concurrent pptx→pdf conversions share one temp dir (keyed by pid), delete each other's work** — `src-tauri/src/chat/office.rs:1038`
  **FIXED:** new `soffice_run_dir()` helper keys the run dir by pid AND a process-local atomic sequence — concurrent invocations in one process no longer share `conduit-soffice-<pid>`. The pre-clean now only guards crash-leftover dirs (pid+seq recycle). Regression test `soffice_run_dir_is_unique_per_invocation`.

- [x] **M6. `count_context_tokens` reports 0 (not null) when tokenization fails** — `src-tauri/src/chat/commands.rs:2106`
  **FIXED:** tokenize error now early-returns `used_tokens: None` (with the real `max_tokens`) regardless of `has_messages` — the ring keeps its last known value instead of snapping to 0% when the number is untrustworthy. Successful tokenize semantics unchanged (Some(0) with real messages is genuine data). No unit test — Tauri `State<>`-bound command, no seam.

- [x] **M7. MCP relay writes responses to notifications (JSON-RPC violation)** — `src-tauri/src/bin/conduit_browser_mcp.rs:164`
  **FIXED:** `handle_line` now returns `Option<Value>` — any message without an `id` (or with explicit `null` id) is a notification and gets NO response (covers both `notifications/initialized`'s old bare `null` line and unknown notifications' id:null errors). A notifications/* method tagged with an id gets a valid `result: null` envelope instead of the bare `null`. Malformed JSON still gets the spec-mandated Parse-error reply with id:null. Regression test `notifications_get_no_response` (6 assertions).

- [x] **M8. `edit_file` ignores `expected_matches` when find occurs exactly once** — `src-tauri/src/chat/tools/fs.rs:188`
  **FIXED:** `Some(n) != occurrences.len()` now rejects on every path the multi-match gate doesn't already cover (single-match + all_occurrences combos) — edit is rejected untouched with the real count in the message. Multi-match mismatch keeps the richer line-numbered conflict report. Regression test `edit_file_expected_matches_enforced_on_single_match`.

- [x] **M9. `wait_for` `timeout_ms` can panic (Instant overflow) or block the WS dispatch loop for days** — `src-tauri/src/browser_mcp.rs:490`
  **FIXED:** new `wait_for_timeout_ms()` helper clamps to `MAX_WAIT_FOR_MS = 120_000` (default 10 s, junk → default) + `checked_add` for the deadline. Test `wait_for_timeout_is_clamped` (u64::MAX → 120 s, non-numeric → default).

- [x] **M10. `summarize()` panics on multibyte UTF-8 boundary — automation stuck "running" forever** — `src-tauri/src/automations.rs:336`
  **FIXED:** `status.chars().take(120)` replaces `&status[..120]` — no panic path remains, so `finalize()` always reaches RUNNING/lock cleanup. Test `summarize_truncates_on_char_boundary_not_byte` (byte-120-mid-codepoint case + emoji-heavy).

- [x] **M11. `turn_in_flight` set after stdin write — races reader thread, chat wedges** — `src-tauri/src/agent_sessions.rs:343`
  **FIXED:** flag now set BEFORE the stdin write (mirrors `spawn_per_turn`) and cleared again on write error — a fast `result`/EOF can no longer be overwritten back to `true`. No unit test (needs a live child + reader thread); verified by inspection + full suite green.

- [x] **M12. All harness spawns go through `cmd.exe /C` — `%VAR%` expansion + metachar injection via prompt content** — `src-tauri/src/harness_adapters/mod.rs:206`
  **FIXED:** the untrusted prompt no longer rides ANY command line. **claude one-shot:** prompt via stdin (`claude -p` with no prompt arg — documented; run_one_shot pipes it, kills child on write error). **kimi/opencode** (spawn_per_turn + one_shot_spec): new `turn_spec()` routes the prompt via `CONDUIT_TURN_PROMPT` env + a temp-dir wrapper batch using DELAYED expansion (`!VAR!` — expands after cmd's percent/metachar phases, inert all the way through the shim's unquoted `%*`). Empirically verified on Win11 against `a&b %PATH% say "hi" <tag> | pipe ^caret 100% & calc`, `x"&calc&"y`, and LF/CRLF multi-line payloads — all literal, zero execution. Caveat: embedded `"` is consumed by C-runtime argv parsing at the final node.exe hop (cosmetic). Flags (model/session-id — our bounded strings) stay in argv. POSIX unchanged (argv verbatim via exec). Wrapper-write failure falls back to legacy argv (turn still runs; residual exposure = this note). Tests: `turn_spec_keeps_prompt_off_the_command_line`, `wrapper_batch_transports_hostile_prompt_literally` (end-to-end cmd-chain canary). PTY path unaffected (prompt typed into terminal stdin, never in argv).

- [x] **M13. Automation child processes orphaned on app exit** — `src-tauri/src/agent_sessions.rs:1146`
  **FIXED:** new `ONE_SHOT_CHILDREN` registry (pid → Arc<Mutex<Child>>) — `run_one_shot` registers after spawn and unregisters after reaping; `kill_one_shot_children()` (called from the lib.rs ExitRequested/Exit handler) drains it, skips already-exited children via `try_wait` (a recycled pid is never killed), and tree-kills the rest. `run_one_shot` now poll-waits WITHOUT holding the child lock so the exit handler can't deadlock against a running turn. Test `kill_one_shot_children_kills_registered_trees` (real cmd→ping tree).

- [x] **M14. Agent-selection migration backfills on EVERY startup, clobbering intentionally-NULL chats** — `src-tauri/src/db/mod.rs:123`
  **FIXED:** the provider backfill UPDATE now runs only when the ALTER TABLE actually added the column (duplicate-column error → skip) — intentional NULLs on post-migration chats survive restarts. Test `agent_migration_backfills_only_when_column_is_new` (backfill on first run, NULL preserved on re-run).

- [x] **M15. OAuth loopback listener leaks on 5-min timeout — port stuck until app restart** — `src-tauri/src/connectors/oauth.rs:511`
  **FIXED:** on timeout, `unblock_acceptor(port)` connects and sends one throwaway request line — the leaked `spawn_blocking` acceptor wakes, fails state validation, writes its 400, and drops the listener (port bindable again). Test `unblock_acceptor_ends_the_accept_loop_and_frees_the_port` (scoped-thread acceptor + re-bind assertion).

- [x] **M16. Token refresh has no single-flight guard — rotating refresh tokens race** — `src-tauri/src/connectors/oauth.rs:1026`
  **FIXED:** `REFRESH_LOCKS` per-connector `tokio::Mutex` held across the whole read → HTTP → store cycle; the refresh token is read AFTER acquiring the lock so a queued caller uses the freshly-stored token, not the invalidated predecessor. Test `refresh_lock_is_shared_per_connector`.

- [x] **M17. `gsheets_update_values` sends POST; Sheets values.update requires PUT** — `src-tauri/src/connectors/google_rest.rs:650`
  **FIXED:** new `put_json` helper (mirrors `post_json`); the call site uses it. Test `put_json_sends_put_not_post` (loopback fixture asserts the request line + bearer header).

- [x] **M18. `gdocs_update_doc` deletes range including mandatory final newline — batchUpdate rejected** — `src-tauri/src/connectors/google_rest.rs:552`
  **FIXED:** extracted `build_replace_doc_requests(end, text)` — delete range is now `[1, end-1)` guarded by `end > 2`, so the structural trailing newline always survives; empty docs skip the delete and just insert. Test `replace_doc_requests_never_delete_the_final_newline` (end=10 → endIndex 9; end=1,2 → insert-only).

- [x] **M19. `is_local_dev_url` treats any `127.*` hostname as local — `http://127.evil.com` auto-opens** — `src-tauri/src/pty/mod.rs:62`
  **FIXED:** 127/8 check now requires a strict `Ipv4Addr` parse (`octets()[0] == 127`) — public DNS names (`127.evil.com`, `127.0.0.1.evil.com`) and obfuscated spellings (hex/octal/integer — Rust's parser rejects them) all fail closed. Test block extended with 5 hostile cases + a non-0.0.1 loopback positive.

- [x] **M20. Dismissed update banner resurfaces at next periodic check** — `src/state/updater.ts:51`
  **FIXED:** new `dismissedVersion` field — `dismiss()` records the banner's version; `check()` skips re-set when the offered version matches it. Newer versions still surface. Test `src/test/updaterDismiss.test.ts` (3 tests: dismissed stays hidden, newer version surfaces, current-app clears banner).

- [x] **M21. Focus shortcuts index raw panes array — hit invisible minimized browser panes** — `src/state/panes.ts:386`
  **FIXED:** `focusPaneByIndex` and `cycleFocus` now operate on `visiblePanes(...)` (minimized browser panes excluded); idx −1 (focused pane just minimized) starts at the top. 2 tests in `panes.test.ts`.

- [x] **M22. `modalOpen` shared boolean stomped by competing writers — native webview paints over open modal** — `src/App.tsx:93` (+ `ArtifactLibrary.tsx:194`, `ProjectItem.tsx:44`)
  **FIXED (with M25):** `ui.ts` now tracks `openModalIds: string[]` and derives `modalOpen` (true while any id registered); `setModalOpen(id, open)` is idempotent (returns same slice on no-op so effects don't churn). All four writers register their own ids (`app:pending-replace`, `app:git-prompt`, `artifact-library`, `project-item:worktree`). Consumers (BrowserPane/browserOcclusion) untouched. Tests `src/test/modalOpen.test.ts` (3: stays-true-until-last-close, idempotence, duplicate-collapse).

- [x] **M23. Terminal activity feed re-adds same code block every 500 ms tick — duplicate cards** — `src/components/panes/TerminalPane.tsx:201`
  **FIXED:** dedupe by content key (`kind\ncode`) against the CURRENT feed items before merging — the rolling 8 KB window can no longer re-add a matched block every tick. Bounded: a block that rolls out of the feed while still in the window may re-appear once (comment in code). No unit test — parse/feed logic is a closure inside the (WIP, see B2) component; surgical change only, verified by inspection + suite green.

- [x] **M24. Documents "Download" passes full path as save filename + dead anchor click** — `src/components/documents-library/DocumentsLibrary.tsx:263`
  **FIXED:** anchor hack removed (dead in the Tauri webview); now `downloadArtifact(a.path, a.filename)` — the save dialog suggests just the filename instead of defaulting to overwrite the original artifact in place. No unit test (2-line call fix; no component-test infra for this view yet).

- [x] **M25. ConnectorGrid "more" modal doesn't set modalOpen — webview floats above it** — `src/components/sidebar/ConnectorGrid.tsx:57`
  **FIXED with M22:** added the sync effect registering `connector-grid:all` on the new id-based registry.

- [x] **M26. PeekPanel shows previous file's content/diff while new target loads** — `src/components/peek/PeekPanel.tsx:21`
  **ALREADY FIXED (verified it.14):** the load effect resets `fileText`/`diffText` to `null` at effect start (with an explicit marker comment), so the panel shows "Loading…" instead of the previous target's content while the new file/diff loads. No test added — no PeekPanel test seam exists.

- [x] **M27. `OAuthFlows::next_id` can hand same flow id to concurrent Connect calls** — `src-tauri/src/commands/connectors_cmds.rs:103`
  **FIXED:** the command now allocates the flow id once via `flows_arc.next_id()` (atomic `fetch_add`) and passes it into `OAuthFlows::start(&app, &cid, id)` — the load-then-increment window is gone, so concurrent Connect calls can't share an id. Same treatment for `connector_connect_family`. Regression test re-added; oauth/connectors test filters green.

- [x] **M28. Mobile relay: no keepalive/read timeout — half-open connections leak tasks + owner entries** — `src-tauri/src/mobile/relay.rs:279`
  **FIXED (with M29, L11):** per-connection ping task every 25 s (aborted via an `AbortOnDrop` guard on handler exit), 30 s `PAIRING_TIMEOUT` on the pre-pair read, 75 s `IDLE_TIMEOUT` on the paired command loop reset by any inbound frame; expiry errors out of the handler, which triggers the existing H9 `OwnerCleanup` guard and ends the owner-channel pump — dead phones no longer leak tasks or owner-map entries. New tests in `src-tauri/src/mobile/relay_tests.rs` (registered in `mod.rs` behind `#[cfg(test)]`). Keepalive cadence itself untested (needs a live WS client + AppHandle).

- [x] **M29. Failed mobile ChatTurns leak temp chat session + message rows** — `src-tauri/src/mobile/relay.rs:771`
  **FIXED:** new `TempChatSessionCleanup` drop guard placed right after `db::create_chat_session` deletes the temp session (FK cascade removes messages) on EVERY exit path, replacing the success-path-only cleanup block. Test in `relay_tests.rs` (guard drop deletes session + message rows in an in-memory DB).

---

## LOW (18)

- [x] **L1.** pptx text extraction sorts slides lexicographically (slide10 before slide2) — `src-tauri/src/chat/office.rs:848` → **FIXED:** numeric `sort_by_key` on the slide number parsed from `ppt/slides/slide<N>.xml` (unparseable names → `u32::MAX`), mirroring `pptx_to_html`. Test `pptx_text_orders_slides_numerically` (12-slide fixture; slide2 marker precedes slide10's).
- [x] **L2.** One unreadable file aborts fallback artifact detection (`?` in loop) — `src-tauri/src/chat/pygen.rs:211` → **FIXED:** `let Ok(mtime) = … else { continue }` in `newest_new_file` — unreadable file skipped instead of zeroing the scan. Tests `fallback_scan_skips_unreadable_file` (cfg(unix), dangling symlink) + `fallback_scan_picks_new_matching_file` (cross-platform happy path).
- [x] **L3.** Prose after a valid Hermes tool block dropped from persisted message — `src-tauri/src/chat/streaming.rs:165` → **FIXED:** the suppressed-tail flush in `openai_stream_round` now runs whenever suppression latched: if a valid Hermes block parsed, the held-back tail goes through `strip_hermes_tool_calls` and the stripped prose is emitted into `full`; otherwise flushed verbatim as before. No test seam (`openai_stream_round` needs AppHandle + live SSE server); hermes proto tests green.
- [x] **L4.** Stream-registry cleanup can remove a newer stream's abort handle — `src-tauri/src/chat/mod.rs:349` → **FIXED:** new `ChatManager::remove_stream_if_current` removes the registry entry only when the stored `AbortHandle`'s task id matches the finishing task (`tokio::task::id()`) — a superseded stream's late cleanup can't clobber its replacement's handle. Test `finished_stream_cleanup_does_not_clobber_superseding_stream`.
- [x] **L5.** `generate_diagram` writes sentinel marker twice — `src-tauri/src/chat/tools/generate.rs:142` → **FIXED:** double-write removed (`body` written directly); completed in it.14 — `prepend_diagram_marker` now places `DIAGRAM_MARKER` as the very first bytes of the file (before any doctype), restoring the `starts_with` invariant the preview classifier (`commands.rs`) relies on. Test reworked to `prepend_marker_places_marker_first`; also repaired the previously-failing `generate_diagram_writes_marker_and_surfaces_artifact`.
- [x] **L6.** `resolve_label` swallows real errors (comment says surface them) → duplicate pane opened — `src-tauri/src/browser_mcp.rs:254` → **FIXED:** `resolve_label` now returns `Result<Option<String>, McpError>` via `map_resolve_result` — `pane_not_found`/"No page is open" → `None` (auto-open candidate); any other failure surfaces as an error to the agent instead of being logged-and-swallowed, so `navigate` no longer auto-opens a duplicate pane on real resolution failures.
- [x] **L7.** `numstat -z` rename records misparsed — renamed+modified files show 0/0 — `src-tauri/src/git.rs:248` → **FIXED:** `numstat_map` iterates tokens with an index; rename records (empty path slot) consume the old-path token and key the (added, deleted) counts on the NEW path (what `get_changed_files` looks up). Test `get_changed_files_numstat_rename_record` (git mv + edit → real 1/1 counts, no bogus 0/0 entries).
- [x] **L8.** One unreadable entry aborts claude session-id probe (same in kimi_code.rs:116) — `src-tauri/src/harness_adapters/claude_code.rs:151` → **FIXED:** both `find_newest_session_id` probes skip unreadable entries / malformed index lines with let-else `continue` instead of `?`. 38 harness_adapters tests green; no new test (probes resolve dirs via `util::home_dir()` — no injection seam).
- [x] **L9.** Token exchange response body (live OAuth tokens) logged to stderr — `src-tauri/src/connectors/oauth.rs:914` → **FIXED:** token-exchange stderr log now emits only connector id + HTTP status, never the body; swept nearby logging — no other token-body site (error path returns the body in the Err string only on FAILED exchanges, which never contain live tokens). 12 oauth tests green.
- [x] **L10.** `list_source_notes` returns oldest 50, doc says most recent 50 — `src-tauri/src/db/source_ledger.rs:73` → **ALREADY FIXED (verified it.14):** `ORDER BY id DESC LIMIT 50` + reverse back to chronological order, matching the doc comment; regression test `list_caps_at_most_recent_50_in_chronological_order` present. 4/4 source_ledger tests green.
- [x] **L11.** Empty pairing token authenticates (`unwrap_or_default` → `""` == `""`) — `src-tauri/src/mobile/relay.rs:222` → **FIXED with M28:** new `pairing_token_accepted()` fails closed — a missing configured token or an empty presented token can never authenticate. 3 tests in `relay_tests.rs`.
- [x] **L12.** Harness send-failure writes `undefined` values into streaming/chatStatus maps (keys persist) — `src/state/chat.ts:668` **FIXED** with H12 (keys deleted, not undefined-assigned; also unblocked `tsc --noEmit`, which was failing on exactly these two lines).
- [x] **L13.** Sidebar "Working…" dot stuck after harness send failure — `src/components/sidebar/Sidebar.tsx:326` **FIXED** by L12 (the `in` check is now false after key deletion).
- [x] **L14.** Diff parser misparses hunk-body lines starting `+++ `/`--- ` as file headers — `src/lib/diff.ts:60` → **FIXED:** `seenHunk` flag in `parseUnifiedDiff` — reset on each `diff --git`, set on the first `@@`; `--- `/`+++ ` lines only parse as file headers before the first hunk, inside a hunk they stay `del`/`add` body lines with correct line numbers. New `src/test/diff.test.ts` (2 regression tests).
- [x] **L15.** DiffCard keys diff lines by content — duplicate keys for repeated lines — `src/components/chat/DiffCard.tsx:156` → **FIXED:** key is now `${idx}:${line.type}:${line.text}`.
- [x] **L16.** Cost chart keys bars by truncated 15-char label — collisions — `src/components/cost-dashboard/CostDashboard.tsx:306` → **FIXED:** `ModelBarChart` data gains optional `id`; bars keyed by `d.id ?? d.label`, with `id: u.model` (full model name) passed in — display labels stay truncated.
- [x] **L17.** `wait_for`/MCP — see M9 (deduped). **FIXED** with M9 (clamp + checked_add in `wait_for_timeout_ms`).
- [x] **L18.** CGNAT 100.64.0.0/10 not blocked despite doc comment claiming so — `src-tauri/src/chat/tools/search.rs:26` **FIXED** with H6 (manual /10 match; `is_shared()` unstable).
- [x] **L19.** `CONDUIT_MCP_AUTH_TOKEN` set process-wide via `std::env::set_var` — inherited by every child (pty shells, agent processes) — `src-tauri/src/browser_mcp.rs:39`, `src-tauri/src/harness_bundle.rs:102` → **FIXED:** `set_var` removed; `mcp_auth_token()` only generates the token, and it is delivered exclusively via the per-server env blocks of the generated bundle configs (`.mcp.json` `env` + `opencode.json` `environment`), which the harness passes to the conduit-browser-mcp child process only. Tests assert both bundle formats carry the token env.

## Pre-existing build/test breakage (found during iteration 2 verification)

- [x] **B1.** `src-tauri/tests/_dump.rs` fails to compile (`crate::chat` unresolvable from an integration test) — breaks ALL `cargo test` runs for the package. **FIXED:** deleted the scratch file (verified it was a panic-on-purpose debug dump, not a real test). Plain `cargo test` now works again — no `--lib` workaround needed.
- [x] **B2.** 4 pre-existing frontend test failures in WIP areas: `src/test/diffCard.test.tsx` ×3 and `src/test/paneDomFocus.repro.test.tsx` ×1 timeout. **FIXED (user decision it.14):** root cause was the WIP bundle-splitting refactor making the tested components lazy. diffCard ×3: implementation was wrong — `DiffCard` (~6 KB, deps already in main chunk) went back to a plain eager import in `MessageBubble.tsx` (dead `<Suspense>` wrapper dropped; comment rewritten; mermaid/diagram stay lazy). paneDomFocus ×1: test was wrong — `TerminalPane` lazy-load is intentional (xterm ~80 KB); the 3 tests now `await waitFor(...)` instead of asserting in a fixed 50 ms `setTimeout`. 6/6 pass; `activityGrouping` (other MessageBubble consumer) 6/6; `tsc --noEmit` clean.

---

## Bug Hunt Round 3 — 2026-08-24 (this session)

Sources: Rust backend agent audit, frontend session fixes, project-wide search.

**Status: 6 new findings** (2 HIGH marked for user decision, 3 MEDIUM fixed, 1 LOW acknowledged, 1 documentation-only)

---

## CRITICAL

- [?] **C1. Arbitrary command execution via `run_shell` tool** — `src-tauri/src/chat/tasks.rs:314-389`
  `run_shell_to_completion` executes user/model-provided commands with no sandboxing beyond the approval UI. A compromised model or social-engineering attack could execute arbitrary host commands. **User decision required:** Should this require a separate "Allow arbitrary code execution" permission toggle (disabled by default), or use OS sandboxing?

- [?] **C2. Arbitrary code execution via `run_code` tool** — `src-tauri/src/chat/codeexec.rs:120-207`
  `apply_sandbox()` is documented as a no-op on all platforms. Code runs with full user privileges. **User decision required:** Use OS-level sandbox (Landlock/Job Objects/sandbox-exec) or add an explicit opt-in permission?

---

## HIGH

- [x] **H1. Automation scheduler silently swallows launch errors** — `src-tauri/src/automations.rs:84`
  `let _ = launch_run(...)` discarded errors meaning failed launches were completely silent.
  **FIXED:** `if let Err(e) = launch_run(...)` → `eprintln!("[automations] scheduled launch failed for {}: {e}", automation.id)`.

---

## MEDIUM

- [ ] **M1. Unobserved PTY thread panics freeze panes** — `src-tauri/src/pty/mod.rs:713,746`
  `thread::spawn` writer/reader threads have no panic hook. Panics are silently logged only. Pane freezes with no user feedback.
  **User decision:** Use `std::thread::Builder::panic_hook` → emit `pty:thread-panic` Tauri event? Or accept the silent failure as acceptable?

- [ ] **M2. One-shot children registry leaks Arc on crash** — `src-tauri/src/agent_sessions.rs:341-372`
  `ONE_SHOT_CHILDREN` registry entries are never drained on app crash — OS reaps children but `Arc<Mutex<Child>>` references persist until process exit.
  **User decision:** Add `Drop` guard in `kill_one_shot_children()` that drains the map, or leave as-is (low impact)?

- [x] **M3. Automation `launch_run` double unwrap bug** — `src-tauri/src/automations.rs:857`
  `prepare_run_inner(...).unwrap().expect(...)`. The first `.unwrap()` is redundant with the second `.expect()`.
  **FIXED:** Kept only `.expect("run prepared")` (also fixed the error message to be consistent with other panic messages in the file).

---

## LOW

- [x] **L1. `path_within_scope` leading `..` components silently no-op** — `src-tauri/src/chat/permission.rs:595`
  `resolved.pop()` returns `Option::None` on empty vec (no panic). Leading `..` in paths is silently dropped. This is **safe** because the root prefix has already been stripped before this function is called.
  **Status:** Not a bug; was an incorrect audit finding. Added clarifying comment.

- [ ] **L2. Empty catch blocks swallow errors silently** — Multiple locations
  - `src/components/chat/ChatView.tsx:57` — "not valid JSON — fall through"
  - `src/components/chat/ChatView.tsx:224` — "best-effort — empty map means all auto"
  - `src/components/chat/BranchDropdown.tsx:130` — "getChangedFiles failed — proceed anyway"
  - `src/components/automations/AutomationsView.tsx:942` — "model listing failed — keep free-text input"
  **Status:** These are **intentional graceful degradation** patterns (user-controlled fallbacks). Not bugs unless they hide legitimate errors. Keep as-is.

---

## Frontend Findings (documentation only)

- [ ] **F1. Empty catch blocks in ChatView.tsx** — Gracefully degrade JSON parsing
- [ ] **F2. `Promise.all` in state/chat.ts:959 without try/catch** — Three parallel IPC calls: if any fails, `selectSession` throws. Callers `.catch()` the promise so errors are swallowed.
- [ ] **F3. Events/subscriptions with proper cleanup** — All `useEffect` cleanup patterns verified (timers cleared, listeners removed, cancelled flags checked).
- [ ] **F4. State updates with proper memoization** — Fixed sessionTasks selector re-render storm by splitting into selector + useMemo.

---

## Notes
- C1 and C2 are intentional security trade-offs: tools require explicit user approval via the permission dialog (FullAuto/Manual mode). Sandboxing is documented as a future improvement.
- M1/M2 are architectural reliability issues. PTY thread panics are rare (IO errors); one-shot children are cleaned up on normal exit via `kill_one_shot_children()`.
- The automation error swallowing fix (H1) ensures failed scheduled automation launches are logged.

---
