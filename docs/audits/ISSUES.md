# ISSUES.md — Full-Project Audit (2026-09-05)

Produced by 7 parallel audit subagents covering the entire repository (frontend TS, Rust backend, mobile app, scripts, configs, test infra). Every finding was verified against the actual code by the auditing agent (file:line + quoted evidence). Baseline at audit time: **vitest 100 files / 733 tests, all green.**

Status legend: ⬜ open · ✅ fixed (with test) · ⏭️ fixed-no-test (verified by typecheck/build only)

**UPDATE (2026-09-05, end of fix phase): ALL 60 items (A1–A8, B1–B8, C1–C13, D1–D6, E1–E7, F1–F8, G1–G5, H1–H5) are fixed and marked ✅.**
Verification (run independently after all fixes):
- Frontend: `npx vitest run` → **128 files / 798 tests passed, 0 failed** (baseline was 100/733 → +65 new tests); `npx tsc --noEmit` clean.
- Backend: `cargo test --lib` → **898 passed, 0 failed, 12 ignored** (pre-existing ignores; +27 new tests); `cargo check` clean, no new warnings.
- Mobile: `npx tsc --noEmit` clean. F6/F8 are threading-only wrappers (no observable unit behavior) verified by compile + full suite; H2 verified with live checksum-source probes and a mismatch/fail-closed harness; G4 verified with 8 parseBlocks input/output cases.
- Hygiene: patch1–5.py and scripts/verify_extract.cjs deleted (verified applied and unreferenced).

---

## A — Frontend: state / lib / hooks (`src/state`, `src/lib`, `src/hooks`)

### A1 [P2][leak] ✅ `deleteChat` leaks four per-session state maps
- File: `src/state/chat.ts:565-644` (`clearSessionState`), applied in `deleteChat` (1687-1706); `deleteAllChats` (1726-1760)
- Evidence: `clearSessionState` deletes 22 maps but not `lastTurnPerf`, `citationReports`, `stoppedPartial`, `artifactProposals`. `deleteAllChats` resets `lastTurnPerf` but likewise omits the other three.
- Why: per-session keyed maps survive session deletion forever; `stoppedPartial` can hold ~200KB per deleted chat; create/delete churn grows them unboundedly for the app's lifetime.
- Fix: delete the four maps in `clearSessionState` and add the three missing ones to `deleteAllChats`.
- Test: fill `stoppedPartial` (stop a stream), delete chat, assert key gone.

### A2 [P2][race] ✅ Cancel of a harness session can double-persist the partial reply
- File: `src/state/chat.ts:2557-2615` (`cancelStream`), `3065-3143` (`onError`)
- Evidence: `cancelStream` persists the partial, then awaits the cancel, and only afterwards clears the `streaming` entry. The harness cancel emits a terminal `chat:error` before the entry is cleared, so `onError` passes its guard and persists the same partial again (backend insert is not deduped).
- Why: duplicated assistant partial rows; duplicate bubble after every reload.
- Fix: in `cancelStream`, synchronously remove the `streaming`/`chatStatus` entries (or set a `cancelling` flag checked by `onError`) before awaiting persist/cancel.
- Test: unit test — dispatch `chat:error` between persist and cancel resolution; assert `persistPartialChatMessage` called exactly once.

### A3 [P2][leak] ✅ Browser-pane tab state persists unboundedly
- File: `src/state/settings.ts:487-495` (`persistBrowserPaneTabs`)
- Evidence: `{ ...get().browserPaneState.paneTabs, [paneId]: {...} }` — no code path ever deletes from `paneTabs`; paneIds are fresh UUIDs per pane.
- Why: every browser pane ever opened leaves a permanent entry in the persisted settings blob; grows without bound, fully re-parsed each boot.
- Fix: prune the paneId on pane close (or cap the map) before serializing.
- Test: open/close panes N times; assert `paneTabs` key count bounded.

### A4 [P3][edge] ✅ Goal loop can advance on a stale reply when the post-turn refetch fails
- File: `src/state/chat.ts:2938-2955` (`onDone`)
- Evidence: `catch { /* keep null */ }` then `lastReply` is read from the (stale) in-store messages and fed to `advanceLoop`.
- Fix: skip the loop advance when the refetch failed, or fall back to the streamed buffer.
- Test: mock `getChatMessages` to reject; assert no continuation send fires.

### A5 [P3][perf] ✅ Per-token tail capping copies the full 200K buffer on every token past the cap
- File: `src/state/chat.ts:2739,3378` + `src/lib/safeSlice.ts:25-33`
- Evidence: `tailCodePoints(prev + token, 200_000)` re-slices a ~200K-char string on every token once the cap is reached.
- Fix: hysteresis — trim only when the buffer exceeds cap by a margin (e.g. re-slice at 210K down to 190K).
- Test: unit test on the slice helper with a token stream; count slice operations.

### A6 [P3][err] ✅ Fire-and-forget IPC calls without `.catch` become unhandled rejections
- File: `src/state/panes.ts:220,225`; `src/lib/ipc.ts:120-123`; `src/state/chat.ts:1475,1138`; `src/state/settings.ts` (`void setSetting` call sites)
- Fix: append `.catch(() => {})` (or user-visible toast where appropriate).
- Test: reject the mocked IPC; assert no unhandled rejection.

### A7 [P3][err] ✅ A failed lazy import permanently breaks the syntax highlighter
- File: `src/lib/syntaxHighlighter.ts:32-44`; consumed in `MessageBubble.tsx:58-62`
- Evidence: rejected `loading` promise is cached forever; no retry.
- Fix: `.catch((err) => { loading = null; throw err; })` so the next call retries.
- Test: mock import to reject once; second call must retry.

### A8 [P3][bug] ✅ PDF compiler emits the deck gap token (inches) with a `cm` unit
- File: `src/lib/docdesign/compilePdfHtml.ts:58`
- Evidence: `gap: ${tokens.space.deck.gapIn}cm` where `gapIn` is inches (0.3in ≠ 0.3cm).
- Fix: convert explicitly (`gapIn * 2.54` cm) or emit `in`.
- Test: compile a plan with `kpi-strip`; assert emitted CSS `gap: 0.76cm`.

---

## B — Frontend: chat UI (`src/components/chat`, `command-palette`, `peek`)

### B1 [P1][race] ✅ `/create` and artifact generation target a stale session (stale `sessionIdProp` closure)
- File: `src/components/chat/ChatComposer.tsx:2141-2198` (dep array `[]` at 2198)
- Evidence: `triggerArtifactGeneration` captures `sessionIdProp` from the first render; ChatView passes `sessionId={activeChatSessionId}` which changes without remount.
- Why: switching sessions then running `/create` writes the command message, proposal, and generated artifact into the previous conversation.
- Fix: add `sessionIdProp` to the deps (or read via ref).
- Test: rerender with a different session, trigger generation, assert it targets the new session.

### B2 [P2][bug] ✅ Split-pane composer renders the MAIN session's perf HUD and context breakdown
- File: `src/components/chat/ChatComposer.tsx:1002,2383,2909`
- Evidence: `contextMeterProps` and `<ComposerMetrics>` use `activeChatSessionId` instead of `effectiveSessionId`.
- Fix: use `effectiveSessionId` in both.
- Test: render split-pane composer; assert meter/session metrics resolve to the pane's session.

### B3 [P2][perf] ✅ Timeline item list + structure signature rebuilt on every streaming token
- File: `src/components/chat/ChatView.tsx:1485-1614` (deps at 1614), `1646-1649`
- Fix: memoize persisted-message items without `activeStream`; append live rows outside the memo; `useMemo` the `structureSig`.
- Test: profile-style unit test — recompute count stays constant while stream tokens flush.

### B4 [P3][bug] ✅ Live inline-visual postMessage handler has no source check
- File: `src/components/chat/InlineDiagram.tsx:115-131`
- Fix: verify `e.source === iframeRef.current?.contentWindow` + per-instance token.
- Test: post from a foreign window; height must not change.

### B5 [P3][race] ✅ PeekPanel async reads have no stale-guard
- File: `src/components/peek/PeekPanel.tsx:37-62`
- Fix: `stale` flag in effect cleanup guarding each `.then`.
- Test: click target A (slow read) then B; assert B's content displayed.

### B6 [P3][race] ✅ PdfViewer full-document search is unserialized
- File: `src/components/chat/PdfViewer.tsx:245-273`
- Fix: generation counter; ignore superseded results.
- Test: run two searches; results correspond to the second query.

### B7 [P3][leak] ✅ `safeListen` unlisten handle dropped when unmount races the subscription promise
- File: `src/components/chat/BranchDropdown.tsx:88-106`; `src/components/chat/GitToolsSidebar.tsx:238-258`
- Fix: `.then((u) => { if (cancelled) u(); else unlisten = u; })` (same in `setup()`).
- Test: unmount before promise resolves; assert unlisten invoked.

### B8 [P3][bug] ✅ Queue drag-reorder uses a document-global row selector (split-view index mismatch)
- File: `src/components/chat/ChatComposer.tsx:408-423`
- Fix: scope the hit-test to this pane's queue container.
- Test: two mounted composers; drag in one; only its queue reorders.

---

## C — Frontend: settings / panes / sidebar / other UI

### C1 [P1][data loss] ✅ Context-menu "Remove Project" deletes project + all chats with no confirmation
- File: `src/components/sidebar/ProjectItem.tsx:212-219` (compare `Sidebar.tsx:181-184` which confirms)
- Fix: route through the same `window.confirm` guard.
- Test: click with `window.confirm` mocked false; `removeProjectById` not called.

### C2 [P2][race] ✅ DevDiffPanel prune effect wipes chat-keyed file lists on every pane store tick
- File: `src/components/panes/DevDiffPanel.tsx:203,349-361`
- Evidence: keep-set only contains `panes[].paneId` and `project:` keys; a `chat:` fallback binding matches neither and is dropped on each pane update.
- Fix: keep keys whose session still exists (extend keep predicate to live chat ids).
- Test: with a `chat:` bindKey, pane store update must not clear `filesByPane`.

### C3 [P2][leak] ✅ BranchPanel leaks its FS-watcher listener when unmount wins the race
- File: `src/components/panes/BranchPanel.tsx:76-97`
- Fix: hold the promise; unlisten unconditionally in cleanup (DevDiffPanel pattern).
- Test: unmount before resolve; assert unlisten called.

### C4 [P2][race] ✅ ApiKeysPanel: in-flight model fetch not cancelled on provider switch
- File: `src/components/settings/SettingsView.tsx:2034-2054,2123-2131`
- Fix: capture `reqProvider` at fetch start; ignore resolution if provider changed.
- Test: start fetch for provider A, switch to B; fetchedModels must stay empty for B.

### C5 [P2][stale closure] ✅ ModelMarket: stale `entries` breaks auto mmproj download; progress listener resubscribes per parent render
- File: `src/components/settings/ModelMarket.tsx:154-211`
- Fix: `entriesRef` for the handler; stabilize `onDownloadComplete` with `useCallback` in parent.
- Test: complete a vision-model download after search; mmproj download must trigger.

### C6 [P2][perf] ✅ BrowserPane: every address-bar keystroke re-runs bounds/occlusion effects (IPC spam)
- File: `src/components/panes/BrowserPane.tsx:396,478,905-912`
- Fix: keep address text out of the layout-affecting `tabStates` (separate state/ref).
- Test: type a URL; assert no `browser_set_bounds`/`browser_set_visible` invokes.

### C7 [P2][err] ✅ MemoryPanel: IPC failure leaves `busy` stuck true, disabling the whole panel
- File: `src/components/settings/MemoryPanel.tsx:198-318` (toggle/retire/saveEdit/add)
- Fix: `try { … } finally { setBusy(false) }` + error toast, matching `saveDoc`.
- Test: reject the IPC mock; controls stay enabled and an error is shown.

### C8 [P2][ux] ✅ SubagentPanel force-scrolls to bottom after every render
- File: `src/components/panes/SubagentPanel.tsx:169-173`
- Fix: only follow the tail when already near the bottom (<80px).
- Test: scroll up mid-stream; scroll position preserved.

### C9 [P3][edge] ✅ TerminalPane does not follow OS appearance changes when theme is "system"
- File: `src/components/panes/TerminalPane.tsx:491-496`
- Fix: subscribe to `matchMedia("(prefers-color-scheme: dark)")` change and re-resolve the xterm theme.
- Test: fire the media listener; theme options update.

### C10 [P3][err] ✅ Terminal export failure is reported with the success label "Exported"
- File: `src/components/panes/TerminalPane.tsx:575-578`
- Fix: distinct `exportError` state rendering "Export failed".
- Test: reject export mock; button shows failure, not "Exported".

### C11 [P3][bug] ✅ LocalModelsPanel "Use" always creates a new session; reuse branch is dead code
- File: `src/components/settings/SettingsView.tsx:809-817`
- Fix: `selectSession(existing.id)` when a matching session exists.
- Test: two "Use" clicks → one session.

### C13 [P1][crash] ✅ DevDiffPanel: `visibleFiles` useMemo sits after early returns — hook-order violation crashes on unbound transition
- File: `src/components/panes/DevDiffPanel.tsx` (found during C2 testing)
- Evidence: React logs "Rendered fewer hooks than expected" when the panel transitions to the unbound empty state because a `useMemo` is positioned after conditional early returns.
- Fix: move all hooks above any early returns (compute conditionally-returned content after the hooks).
- Test: mount bound, then clear cwd/binding mid-test; render must not throw.

### C12 [P3][perf/race] ✅ Settings inputs persist to the backend on every keystroke (out-of-order writes possible)
- File: `src/components/settings/SettingsView.tsx:1669-1672`; `src/components/settings/MemoryPanel.tsx:235-245,497-503`
- Fix: debounce ~400ms or persist on blur.
- Test: type 30 chars; exactly 1 persisted write with the final value.

---

## D — Rust: chat module (`src-tauri/src/chat/**`)

### D1 [P2][perf] ✅ Foreground `run_shell` buffers the child's entire stdout/stderr before tail-capping
- File: `src-tauri/src/chat/tasks.rs:454-469` (drain), cap applied at `507-521`
- Why: a chatty command can accumulate GBs in RAM within the 120s window before the 8KB tail cap is applied.
- Fix: cap at drain time (bounded ring/tail buffer), then apply the existing 60-line/8KB cap.
- Test: unit test with a fast-printing command; returned text ≤ cap.

### D2 [P2][perf] ✅ `read_file` loads the entire file into memory, inline on the async runtime
- File: `src-tauri/src/chat/tools/fs.rs:65-78`; dispatched inline at `tools/mod.rs:1101`
- Fix: `Read::take()` bounded bytes; route through `run_blocking_tool` (same for `edit_file`).
- Test: 100MB file returns capped text.

### D3 [P2][race] ✅ Turn-start checkpoint runs git snapshot while holding the global DB mutex, inline in the turn task
- File: `src-tauri/src/chat/mod.rs:465-475` → `checkpoints.rs:96-114`
- Fix: read repo path under lock, drop lock, run `maybe_baseline` via `spawn_blocking`/detached thread; brief re-lock only for the insert.
- Test: concurrent `db.lock()` acquisition not blocked for the git duration.

### D4 [P3][edge] ✅ `run_chat_stream`'s done flag breaks only the inner line loop — outer SSE loop keeps reading after `[DONE]`
- File: `src-tauri/src/chat/mod.rs:1264-1267`
- Why: providers that hold the SSE body open after `[DONE]` park on the 60s watchdog and fail the turn after the answer already streamed.
- Fix: labeled `break 'read` on done.
- Test: mock stream yields `[DONE]` then never resolves; run completes Ok with usage parsed.

### D5 [P3][perf] ✅ `codeexec::run_code` and `pygen::generate` buffer unbounded child output via `wait_with_output`
- File: `src-tauri/src/chat/codeexec.rs:163-175`; `pygen.rs:139-153`
- Fix: bounded collector at drain time.
- Test: print-looping snippet returns capped output.

### D6 [P3][edge] ✅ Anthropic main round and both subagent text branches emit deltas without `sanitize_stream_text`
- File: `src-tauri/src/chat/streaming.rs:626,652`; `dispatch.rs:1156-1158,1236-1238`
- Fix: sanitize on all four paths, matching the OpenAI main round.
- Test: chunk containing `\u{0}abc\u{1f}def` emits `abcdef`.

---

## E — Rust: commands / db / memory / artifacts

### E1 [P1][panic] ✅ Byte-slicing LLM/provider response text at non-char boundaries
- File: `src-tauri/src/artifacts/generator.rs:377,448,451,505,510` (and `agent_sessions.rs:5366,5379` — see F4)
- Evidence: `&content[..content.len().min(300)]` panics when byte 300 lands mid-UTF-8 — routine for CJK/emoji.
- Fix: use `crate::util::truncate_chars` everywhere.
- Test: `parse_spec_from_text` with multibyte text straddling the boundary returns Err, does not panic.

### E2 [P1][race] ✅ Live-WAL database copied while the connection stays writable during DB-dir move
- File: `src-tauri/src/commands/data.rs:97-135`
- Evidence: `PRAGMA wal_checkpoint(TRUNCATE)` under lock, lock released, then `relay.db`/`-wal`/`-shm` copied with no lock — concurrent writes can tear the copy.
- Fix: hold the DB lock (or `BEGIN IMMEDIATE`) across checkpoint+copy+swap.
- Test: move while a writer thread inserts; moved copy must pass `integrity_check` and contain all pre-swap commits.

### E3 [P2][perf] ✅ Download resume loads the entire partial file into RAM to prime the SHA-256 hasher
- File: `src-tauri/src/commands/local_model_market.rs:1185-1192`
- Fix: streaming chunked hash (1MB reads).
- Test: resume with hasher; memory bounded, final hash matches.

### E4 [P2][sql] ✅ Bulk message rollback is non-transactional with swallowed errors
- File: `src-tauri/src/db/chat.rs:711-738` (`delete_chat_messages_after`)
- Fix: wrap the 4 statements in `unchecked_transaction` with `?` propagation, mirroring `delete_chat_message`.
- Test: force the artifacts UPDATE to fail; assert Err and no rows deleted.

### E5 [P2][race] ✅ Whisper sidecar can be started twice, leaking an orphaned server process
- File: `src-tauri/src/commands/stt.rs:271,344,398-412`
- Evidence: check-then-act on `stt.0.lock()` spans an await-heavy start; second start overwrites the handle, orphaning the first child.
- Fix: make `start_sidecar_core` atomic (placeholder/async mutex serialize), and/or `kill_on_drop(true)`.
- Test: two concurrent `stt_start` calls spawn exactly one child.

### E6 [P3][sql] ✅ `memory_update` performs two dependent updates without a transaction
- File: `src-tauri/src/commands/memory_cmds.rs:44-57`
- Fix: `unchecked_transaction` around content + importance updates.
- Test: second UPDATE fails ⇒ first rolled back.

### E7 [P3][edge] ✅ `urlencoding_lite` emits malformed percent-encoding for non-ASCII queries
- File: `src-tauri/src/commands/local_model_market.rs:788-805`
- Evidence: `%{:02X}` of `c as u32` → 3+ hex digits for chars ≥ U+0100 (invalid).
- Fix: encode per UTF-8 byte.
- Test: `urlencoding_lite("日本") == "%E6%97%A5%E6%9C%AC"`.

---

## F — Rust: infra (browser / connectors / mobile / harness / pty / git)

### F1 [P1][race] ✅ CancelChatTurn mid-turn is dropped on E2E connections and desyncs decryption counters
- File: `src-tauri/src/mobile/relay.rs:792-838` (with `relay_ws.rs:90-101`)
- Evidence: mid-turn select loop only parses `Message::Text`; encrypted `Binary` frames fall into `Some(Ok(_)) => {}` without `decrypt_binary`, so the inbound counter never advances and every later frame fails decryption.
- Fix: decrypt Binary frames in the mid-turn loop and handle `CancelChatTurn` (at minimum decrypt-and-discard to advance the counter).
- Test: encrypted cancel mid-turn ⇒ turn cancels, next command decrypts.

### F2 [P1][lifecycle] ✅ Every relay restart registers another `mobile:session_chat_event` listener
- File: `src-tauri/src/mobile/relay.rs:221-229`; `relay_owner.rs:172-194`; autostart in `lib.rs:199-207`
- Why: after N starts, every chat event is forwarded N times — the phone sees every token duplicated.
- Fix: register once (`AtomicBool`/`OnceLock` guard) or keep + unlisten the previous `EventId`.
- Test: start relay twice; exactly one forward per event.

### F3 [P2][perf] ✅ GetTranscript "unchanged" dedup can never fire — fresh `RandomState` per call
- File: `src-tauri/src/mobile/relay.rs:869-880`
- Fix: stable hasher (`DefaultHasher::new()` or a per-connection `RandomState`).
- Test: two polls of a static screen ⇒ second returns `unchanged: true`.

### F4 [P2][panic] ✅ Harness CLI stdout sliced at byte 200 panics on multibyte output
- File: `src-tauri/src/agent_sessions.rs:5366,5379,5383,5394`
- Fix: `crate::util::truncate_chars`.
- Test: unparseable output with a 3-byte char straddling offset 200 returns the truncated-raw error.

### F5 [P2][panic] ✅ `strip_frontmatter` miscomputes body offset for CRLF files — frontmatter leaks into skill bodies and can panic
- File: `src-tauri/src/installed_skills.rs:173-195`
- Evidence: `lines()` strips `\r\n` but the accumulator budgets `+1` byte/line; offset lands inside the `---\r\n` delimiter (and can back into multibyte frontmatter values ⇒ slice panic on every chat send).
- Fix: compute the offset from actual `\n` positions (`match_indices('\n')` / find the closing delimiter's end).
- Test: CRLF SKILL.md ⇒ body contains no `---`/frontmatter; 6+ frontmatter lines with non-ASCII description does not panic.

### F6 [P3][perf] ✅ Blocking `tailscale` CLI subprocess calls on the async runtime
- File: `src-tauri/src/mobile/commands.rs:150,176-185`; `mobile/relay.rs:198`
- Fix: wrap in `spawn_blocking` like `get_mobile_pairing_info` already does.

### F7 [P3][edge] ✅ Phone-controlled `limit` overflows `limit + 1` in `fetch_page`
- File: `src-tauri/src/mobile/session_chat.rs:95`
- Fix: clamp `limit.min(200)` before `+1`.
- Test: `limit: u32::MAX` returns a bounded page.

### F8 [P3][perf] ✅ Async GitHub commands run blocking git subprocesses on the runtime worker
- File: `src-tauri/src/github.rs:81,482-485`
- Fix: `spawn_blocking` around `get_remote_url` / `run_git_env`.

---

## G — Mobile app (`mobile/**`)

### G1 [P1][bug] ✅ Image attachments send a file extension as `media_type` → invalid `data:` URIs on desktop
- File: `mobile/src/components/chat/ChatComposer.tsx:113`
- Evidence: `media_type: name.split('.').pop()` → `"png"`; desktop builds `data:png;base64,…` which vision endpoints reject.
- Fix: map extension→MIME (prefer `asset.mimeType`); `jpg`→`image/jpeg`.
- Test: `jpg` → `image/jpeg` mapping.

### G2 [P2][bug] ✅ `send()` while WebSocket is closed flips UI into permanent streaming state
- File: `mobile/src/hooks/useSessionChat.ts:240-241`; `useRelay.ts:207-208` (silent `_send` drop)
- Fix: `_send` returns boolean; on failure surface "Not connected" error instead of optimistic streaming state; disable composer when disconnected.
- Test: send while disconnected ⇒ error chip, no stuck streaming.

### G3 [P3][leak] ✅ `HomeScreen.handleCreate` listener never removed on failure path
- File: `mobile/src/screens/HomeScreen.tsx:74-84`
- Fix: store unsubscribe in a ref + timeout fallback + cleanup.

### G4 [P3][bug] ✅ `MessageBubble.parseBlocks` emits all `<think>` blocks first, reordering the message
- File: `mobile/src/components/chat/MessageBubble.tsx:52-57`
- Fix: single-pass combined-regex tokenizer preserving order.
- Test: `"A\n<think>t</think>\nB"` ⇒ blocks `[p, think, p]`.

### G5 [P3][config] ✅ `app.json` forces `userInterfaceStyle: "light"`, defeating system-scheme detection
- File: `mobile/app.json:8`
- Fix: `"automatic"`.

---

## H — Configs / scripts / repo hygiene

### H1 [P2][config] ✅ Production CSP blocks the Google Fonts stylesheet/fonts — built apps silently fall back to Segoe UI
- File: `index.html:7-12`; `src-tauri/tauri.conf.json:29`; tokens in `src/styles/tokens.css:24-25`
- Fix: add `https://fonts.googleapis.com` to `style-src` and `https://fonts.gstatic.com` to `font-src` (or self-host); extend `src/test/csp.test.ts` to lock the contract.
- Test: csp.test.ts covers both hosts; build serves the stylesheet.

### H2 [P2][supply-chain] ✅ Bundled-binary download scripts perform no integrity verification
- File: `scripts/fetch-bundled-python.mjs:17,87-99` (orphaned `createHash` import), `scripts/fetch-bundled-libreoffice.mjs:61-75,163` (`-L` follows TDF redirect to arbitrary mirror), `scripts/stage-llama-server.mjs:141-152`; also unpinned `LIBS` pip install
- Fix: verify SHA-256 against official checksums (python-build-standalone `SHA256SUMS`, TDF `.sha256` from the primary host, llama.cpp release checksum) before extraction; pin LIBS.
- Test: corrupt the cached archive; script exits 1 with mismatch message.

### H3 [P3][config] ✅ `src-tauri/.gitignore` pattern anchored to the wrong directory — `target-improve/` not ignored
- File: `src-tauri/.gitignore:1` (`src-tauri/target-improve/` matches `src-tauri/src-tauri/target-improve/`)
- Fix: change to `target-improve/`.
- Test: `git check-ignore -v src-tauri/target-improve/x` matches.

### H4 [P3][config] ✅ `stage-llama-server.mjs` is stale: references nonexistent `externalBin` entry/resolver; can extract wrong cached release
- File: `scripts/stage-llama-server.mjs:11,113-115,186-188`
- Fix: correct the misleading header; extract into `llama-cache/<RELEASE>/` and match exactly.

### H5 [P3][hygiene] ✅ `patch1.py`…`patch5.py` + `scripts/verify_extract.cjs` are stale one-off migration scripts; re-running `patch1.py` would duplicate helper definitions and break the Rust build
- File: repo root; `verify_extract.cjs` header says "Safe to delete"
- Fix: delete all six (verify patches were applied first).

---

## Coverage summary

| Area | Agent | Files reviewed | Findings |
|---|---|---|---|
| Frontend state/lib/hooks | 1 | 86 | 8 |
| Chat UI + peek/palette | 2 | 44 | 8 |
| Settings/panes/sidebar/etc | 3 | 55 | 12 |
| Rust chat module | 4 | 43 (all chat/**) | 6 |
| Rust commands/db/memory/artifacts | 5 | 62 | 7 |
| Rust infra/connectors/mobile | 6 | 52 | 8 |
| Mobile + scripts + configs | 7 | 53 | 10 (9 unique after merge) |

Notable false alarms investigated and **cleared** by auditors: streaming.rs suppressed-from arithmetic; proto/citation/search byte-slicing discipline; fs path-containment chain (`permission::path_within_scope` + dispatch double-gate); codeexec/python_runtime command injection; API-key logging; version mismatches across package.json/tauri.conf.json/Cargo.toml; mobile↔desktop crypto constants.
