# Bug Hunt Round 2 — compiled 2026-08-14

> **Naming note:** This document refers to the project as "Relay" because it was written before the 2026-08-27 user-visible rebrand to "Relay" (commit `e9abc7c3`). The findings still apply; the name has not. See `README.md` and `AI CONTEXT/RELEASE.md` for the current naming.

Whole-project re-audit after the 2026-08-07 bug hunt (`BUG_LIST.md`, 68/69 fixed — H2 still on hold
by user decision). Sources: `tsc --noEmit` (clean), `cargo check` (clean, 73 warnings), `vitest run`
(**3 test files / 9 tests failing**), and three deep audit passes (recent features, Rust backend,
React frontend). No overlap with BUG_LIST.md fixed items or PERFORMANCE_AUDIT.md perf-only items.

Fix order: P0 (broken test suite) → P1 (reachable panics) → P2 (functional bugs) → P3 (medium/low).
Mark items `[x]` as fixed with a note.

**Status: ALL 48 findings fixed** (2026-08-14). Verification: vitest 226/226 green, tsc clean,
cargo test --lib 383/383 green (junction/symlink + path-traversal + UTF-8 regressions included).

---

## P0 — Regression safety net is red (verified failing tests)

- [x] **T1. `activityGrouping.test.tsx` — 5/6 tests fail on stale selectors**
  ProcessSummary redesign renamed `.chat-activity-toggle`/`.chat-activity` → `.chat-process-toggle`/
  `.chat-process` (`src/components/chat/MessageBubble.tsx:765-767`) but tests still query the old
  classes (`src/test/activityGrouping.test.tsx:54,73,103-109,124-134`). Old class remains only in
  dead CSS (`src/styles/global.css:7473`).
  **Fix:** update test selectors to the new classes (or verify component structure and adjust assertions).
  **FIXED (it.1):** Updated selectors to `.chat-process-toggle`/`.chat-activity-steps`; tests now match the ProcessSummary redesign (one outer toggle, think disclosures + step groups inside).

- [x] **T2. `diffCard.test.tsx` — 3/3 tests fail** (same class as T1 — selectors/structure changed by
  the process-row redesign; `src/test/diffCard.test.tsx:51,79,96`).
  **FIXED (it.1):** Tests expand `.chat-process-toggle` before asserting nested DiffCards; stats assertions scoped to the card.

- [x] **T3. `projectBindingSwitch.repro.test.ts` — unhandled rejection: `getChatSessionMetrics` not
  mocked.** `selectSession` now calls `loadSessionMetrics` (`src/state/chat.ts:579` via `:671`) which
  invokes `getChatSessionMetrics` from `lib/ipc.ts`; the repro test's IPC mock doesn't cover it →
  VitestMocker "no mock defined" error escapes the test.
  **FIXED (it.1):** `getChatSessionMetrics` added to the ipc mock.

## P1 — Reachable panics from model/provider-controlled text

- [x] **R1. [High] UTF-8 boundary panic in subagent SSE error path** — `src-tauri/src/chat/dispatch.rs:658`
  `&b[..b.len().min(500)]` on provider error body → panics on multibyte char at byte 500, killing the
  whole tool-loop turn. Fix: char-based truncation.
  **FIXED (it.1):** `util::truncate_chars(&b, 500)` (dispatch.rs).
- [x] **R2. [Med] UTF-8 boundary panic in plan-step label** — `src-tauri/src/chat/dispatch.rs:364`
  `&cmd[..57]` on model's run_shell command. Fix: chars().take(57).
  **FIXED (it.1):** char-count + `truncate_chars(cmd, 57)` (dispatch.rs).
- [x] **R3. [Med] UTF-8 boundary panic in shell output tail-cap** — `src-tauri/src/chat/tasks.rs:361-364`
  `&t[start..]` on combined stdout/stderr >8 KB. Fix: snap `start` to char boundary.
  **FIXED (it.1):** `util::tail_chars(&t, MAX_BYTES)` (tasks.rs).
- [x] **R4. [Med] UTF-8 boundary panic in browser extraction failure** — `src-tauri/src/browser.rs:1118-1121`
  `&first_json[..400]` on readability bridge output. Fix: char-safe truncation.
  **FIXED (it.1):** `util::truncate_chars(&first_json, 400)` (browser.rs).
- [x] **R5. [Low] UTF-8 boundary panic in stream error log** — `src-tauri/src/chat/streaming.rs:78-83`
  `&b[..2000]` on OpenAI error body. Fix: same.
  **FIXED (it.1):** `util::truncate_chars(&b, 2000)` (streaming.rs).

- [x] **F1. [Med] Surrogate-pair split in `onToken` 200 KB cap** — `src/state/chat.ts:1276`
  `(prev + token).slice(-200_000)` cuts mid-emoji → lone surrogate. Fix: step back to code-point boundary.
  **FIXED (it.1):** `tailCodePoints` (new `src/lib/safeSlice.ts`) in onToken.
- [x] **F2. [Med] `sessionTitle` persists corrupted title** — `src/lib/sessionTitle.ts:18`
  `cleaned.slice(0, 40)` splits surrogate pairs and the corrupted title is written to DB. Fix:
  code-point-safe truncation (shared helper).
  **FIXED (it.1):** `sliceCodePoints` in sessionTitle.ts (8 tests in `src/test/safeSlice.test.ts`; 2 util tests in Rust).

## P2 — Functional bugs (high impact)

- [x] **A1. [High] `download_file` hard-blocked whenever `fs_roots` is empty or dest outside a root** —
  `src-tauri/src/chat/dispatch.rs:835-846`: containment check runs BEFORE `check_system_permission`;
  `path_within_scope` returns false when `fs_roots` empty, so Manual-mode users never see the approval
  card — tool is dead. Fix: skip containment when `fs_roots.is_empty()` / reorder after permission decision.
  **FIXED (it.2):** dispatch.rs: containment gate now `!caps.fs_roots.is_empty() && !path_within_scope(...)` — Manual-mode users get the approval card again.
- [x] **A2. [High] `get_git_file_diff` never validates `file_path`** — `src-tauri/src/commands/git_cmds.rs:85-92`
  + `src-tauri/src/git.rs:270-291`: absolute paths / `..` in renderer-supplied `file_path` read arbitrary
  files via `git diff --no-index`. Fix: reject absolute/`..`, require strip_prefix of repo root.
  **FIXED (it.2):** git.rs: new `validate_repo_relative` (reject absolute + any `..`, then normalized containment via path_starts_with_ci) + test `repo_relative_validation_rejects_escapes`.
- [x] **A3. [High] `cancelStream` never clears `streaming[sid]`/`chatStatus[sid]`** — `src/state/chat.ts:1225`:
  aborted builtin turns emit no terminal event (backend `handle.abort()` kills the emitting task), so the
  sidebar "Working…" dot sticks forever. Fix: delete keys in cancelStream.
  **FIXED (it.1):** cancelStream deletes streaming[sid] + chatStatus[sid] in the same set (backend abort emits no terminal event).
- [x] **A4. [High] Deleting a streaming builtin chat never cancels the backend stream** —
  `src/state/chat.ts:740-749`/`783-807` + backend `delete_chat_session` (`chat/commands.rs:152-167`):
  orphaned tokens re-create deleted session state. Fix: cancel on delete (frontend + backend belt-and-suspenders).
  **FIXED (it.1):** deleteChat/deleteAllChats cancel builtin streams (cancelChatMessage) + harness (cancelAgentChatMessage); backend delete_chat_session/delete_all_chat_sessions now call chat_state.0.cancel too. 3 tests in `src/test/chatStreamLifecycle.test.ts`.
- [x] **A5. [Med] `usePlanTracker.parsedMessageIdx` never reset on session switch** —
  `src/hooks/usePlanTracker.ts:51,65,81`: missed or duplicated plan steps after switching chats.
  Fix: reset on activeSessionId change / track (sessionId, index).
  **FIXED (it.2):** usePlanTracker: `parsedSessionId` ref paired with the index; both reset on session switch.
- [x] **A6. [Med] `closePane` focuses last pane of raw array — can focus minimized browser pane** —
  `src/state/panes.ts:354-357`. Fix: use `visiblePanes(...)`.
  **FIXED (it.2):** panes.ts closePane focuses last VISIBLE pane (+ test in panes.test.ts).
- [x] **A7. [Med] `click_and_wait` false-positive navigation when URL snapshot fails** —
  `src-tauri/src/browser_mcp.rs:799-805`: `.unwrap_or_default()` → compares href to `""` → instant
  `changed:true`. Fix: propagate error or fall back to readyState check.
  **FIXED (it.2):** browser_mcp.rs: prev_url is Option; on snapshot failure falls back to readyState check instead of comparing href to "".
- [x] **A8. [Med] run_shell result markers render as permanent "working…" step rows** — backend
  `chat/streaming.rs:677-684,794-801` emits result marker as a titleless `<tool>` segment; frontend
  `MessageBubble.tsx:518-534` labels missing title "working…" and counts it as a step. Fix: give marker
  a title or fold into previous step in `groupSegments`.
  **FIXED (it.2):** streaming.rs: result markers now carry `"title": "Output"` in both tool loops — no more phantom working… step.
- [x] **A9. [Med] Tool-loop turns drop cache/reasoning usage** — `chat/streaming.rs:828-843` `build_usage`
  zeroes cache fields; Anthropic `message_delta`/OpenAI usage parsing misses cache/reasoning details
  (`:463-467`, `:153-160`). Cost model v2 blind for all tool-mode chat. Fix: parse + sum the v2 fields.
  **FIXED (it.2):** streaming.rs: new `RoundUsage` (input/output/cache_creation/cache_read/reasoning) parsed in both stream rounds (OpenAI prompt/completion_tokens_details, Anthropic message_start/message_delta with no-double-count guards) and summed into ChatUsage v2 fields via the reworked `build_usage`.
- [x] **A10. [Med] Settings shows "Commit message model" section twice + dead duplicated state** —
  `src/components/settings/SettingsView.tsx:994-1060` vs `:1062-1125`; dead state in AssistantPanel
  `:869-912` fires pointless `listChatModels` on mount. Fix: delete duplicate + dead code.
  **FIXED (it.2):** SettingsView: duplicate Commit-message-model section deleted; dead AssistantPanel state/effects removed.
- [x] **A11. [Med-Lo] Fast-model picker keeps old provider's model id on provider switch** —
  `SettingsView.tsx:1015-1024`/`1082-1091` → HTTP 400 → commit dialog silently never pre-fills.
  Fix: clear model when provider changes.
  **FIXED (it.2):** SettingsView: provider change clears cmModel + persisted commitMessage.model.
- [x] **A12. [Med] DevDiffPanel: one failed `getChangedFiles` freezes the file list forever** —
  `src/components/panes/DevDiffPanel.tsx:185-241`, `inFlight`/`loading` latch never released on reject.
  Fix: `.catch`/`.finally`.
  **FIXED (it.2):** DevDiffPanel: `.catch` releases inFlight/loading; both listener races use the promise-holding pattern.
- [x] **A13. [Med] TerminalPane `ptyChannel` subscription resolves after unmount** —
  `TerminalPane.tsx:285-299`: handler attaches to disposed terminal; channel leaks. Fix: disposed flag.
  **FIXED (it.2):** TerminalPane: `disposed` flag guards the ptyChannel `.then`; late resolution detaches instead of attaching to a disposed terminal.
- [x] **A14. [Med] AutomationsView edit form silently rewrites non-preset schedules** —
  `AutomationsView.tsx:542-550,601`: cron not matching presets/simple parser falls back to defaults and
  saves `0 9 * * 1-5`. Fix: keep original cron as selectable "current" option.
  **FIXED (it.2):** AutomationsView: non-representable crons become a `Current: <cron>` option selected by default — no silent schedule rewrite.

## P3 — Medium/low

- [x] **B1. [Med] Granted-root containment is lexicographic — junctions/symlinks inside a root escape it** —
  `chat/permission.rs:411-445`: canonicalize doesn't resolve FS links; FullAuto write outside all roots
  via pnpm junctions. Fix: fs::canonicalize (fallback lexical) before compare.
  **FIXED (it.3):** permission.rs: path_within_scope now resolves the FILESYSTEM (fs_resolved: canonicalize path, else existing parent + leaf) and compares against fs-resolved roots — junction/symlink escapes rejected. Test `junction_inside_root_pointing_outside_is_rejected` (real mklink /J on Windows).
- [x] **B2. [Med] `run_shell_to_completion` blocks a tokio worker forever, no timeout/cancel** —
  `chat/tasks.rs:313-344` called from async `dispatch.rs:447-457`. Fix: spawn_blocking + timeout + kill.
  **FIXED (it.3):** tasks.rs run_shell_to_completion: drain threads + 120s deadline loop, kills the child on expiry with a timeout notice in the output; dispatch.rs runs it via spawn_blocking so a stuck command can't pin a tokio worker.
- [x] **B3. [Low] `opencode_live_models` pipe deadlock >64 KB stdout** — `harness_config.rs:272-298`.
  Fix: drain threads before wait (pattern in git.rs:48-72).
  **FIXED (it.2):** harness_config.rs: stdout drain thread spawned before the wait loop; try_wait Err kills the child.
- [x] **B4. [Low] git_watcher uninstall misses map key when dir deleted** — `git_watcher.rs:179-182`
  (verbatim-path keying) → watcher leak; debounce loop can also starve emits (148-151).
  **FIXED (it.2):** git_watcher.rs: uninstall removes both canonical + raw keys; debounce burst capped at MAX_BURST=2s.
- [x] **B5. [Low] `write_bundle` discards all write errors** — `harness_bundle.rs:279-306` returns paths
  to nonexistent files. Fix: propagate.
  **FIXED (it.2):** harness_bundle.rs: write_or_none logs failing writes; core file failures return None.
- [x] **B6. [Low] `checkout_branch` strips only `origin/`** — `git.rs:604`: other remotes check out
  detached HEAD. Fix: strip any known remote / use --track.
  **FIXED (it.2):** git.rs checkout_branch strips the remote prefix only when it matches a `git remote` entry (test added by agent).
- [x] **B7. [Low] Automation finalize ignores DB errors → re-fire loop; skip-status flapping** —
  `automations.rs:356-361,249-251`. Fix: retry/log; stop re-stamping skipped.
  **FIXED (it.2):** automations.rs: record_run retried once + loud logs; skipped status stamped only on transition (stamp_skipped_once).
- [x] **B8. [Low] Gmail REST path ids unencoded** — `connectors/gmail_api.rs:~196` etc. Fix: urlencoding::encode.
  **FIXED (it.2):** gmail_api.rs: thread/message ids urlencoding::encode'd (3 URL sites).
- [x] **B9. [Low] Recursive FS tool scans run on the async runtime; `fs_search_files` has no skip-list** —
  `chat/tools/search_content.rs:179,266-314`, `chat/tools/fs.rs:83-116`. Fix: spawn_blocking + skip-list.
  **FIXED (it.2):** chat/tools: fs_search_files + fs_search_content dispatched via spawn_blocking (run_blocking_tool); fs_search_files shares search_content's SKIP_DIRS.
- [x] **B10. [Low] `wait_for`/`click_and_wait` condition:"selector" with empty target burns full timeout** —
  `browser_mcp.rs:598-599,841-845`. Fix: invalid_args when target missing.
  **FIXED (it.2):** browser_mcp.rs: condition=selector with empty target → invalid_args in both wait_for and click_and_wait.
- [x] **B11. [Low] Hermes suppression leaks partial `<tool` split across SSE chunks** —
  `chat/streaming.rs:173-188`. Fix: incremental-scan carry buffer.
  **FIXED (it.3):** streaming.rs: Hermes suppression uses a carry buffer — a partial `<tool_call` opener split across chunks is held back instead of leaking to the UI/full; unresolved carry flushed at stream end.
- [x] **B12. [Low] Literal `<tool>`/`<think>` in payloads corrupts segment parsing** — `chat/proto.rs:218`
  sanitize only closes tags; frontend parseSegments same. Fix: neutralize opening tags too.
  **FIXED (it.3):** proto.rs tool_block sanitize + new neutralize_markers (streaming.rs result markers) neutralize `<tool>`/`<think>` openers as well as `</tool>`.
- [x] **B13. [Low] Tool steps never observable as "running"** — marker emitted atomically closed before
  execution (`chat/streaming.rs:671-674,790-793`). Fix: two-part emit.
  **FIXED (it.3):** streaming.rs: both tool loops emit the `<tool>` marker open before run_tool and `</tool>` after — steps now show as running (spinner + live label) during execution; persisted bytes unchanged.
- [x] **B14. [Low] Debug `eprintln!` on every /v1/chat/completions request** — `chat/providers.rs:259-265`.
  **FIXED (it.2):** providers.rs: per-request debug eprintln!s removed.
- [x] **B15. [Low] DiffCard promises done-reset collapse that doesn't exist** — `DiffCard.tsx:122-123`.
  **FIXED (it.2):** DiffCard: useEffect resets expanded on done flip (implements the documented reset).
- [x] **C1. [Low] Listener-registration races (unmount beats listen promise)** — `BrowserPane.tsx:394-427`,
  `DevDiffPanel.tsx:250-268,405-420`, `useGitStatusPolling.ts:53-78`. Fix: promise-holding pattern.
  **FIXED (it.2):** BrowserPane + DevDiffPanel(x2) + useGitStatusPolling all use the promise-holding cleanup pattern.
- [x] **C2. [Low] `updateModelDownload` 3s cleanup timer can delete a restarted download's entry** —
  `state/ui.ts:219-234`. Fix: only delete if still terminal.
  **FIXED (it.2):** ui.ts: cleanup timer only deletes entries still in a terminal state (no-op slice when restarted).
- [x] **C3. [Low] Composer drops second attachment with same filename** — `ChatComposer.tsx:583-585,704`.
  Fix: dedupe/key by name+size.
  **FIXED (it.2):** ChatComposer: dedupe/key/removal by name+size; ChatAttachment carries size.
- [x] **C4. [Low] `regenerate` attachment-marker strip regex breaks on `]` in filename** —
  `state/chat.ts:1110`. Fix: `[^\n]*\]`.
  **FIXED (it.1):** regex now `

\[Attached (?:image|file):[^
]*\]` — greedy to the line's last `]`.
- [x] **C5. [Low] Queued messages strand when two sessions stream concurrently** — `state/chat.ts:499-500,923,1416`.
  Fix: per-session check in drainQueue.
  **FIXED (it.1):** drainQueue checks the per-session streaming key (2 tests).
- [x] **C6. [Low] `onDone`'s unguarded `await setChatSessionUnread` can wedge streaming state** —
  `state/chat.ts:1322-1324`. Fix: best-effort catch / reorder.
  **FIXED (it.1):** setChatSessionUnread + getChatMessages are best-effort (catch); streaming cleanup always runs.
- [x] **C7. [Low] `refreshGitStatus` Promise.all dies on one bad project; stale statuses never cleared** —
  `state/projects.ts:143-163`. Fix: allSettled + delete stale entries.
  **FIXED (it.2):** projects.ts: allSettled sweep; refreshGitStatusFor drops stale badges on failure/null.

## Architecture notes (not bugs; tracked for later)

- PERFORMANCE_AUDIT.md items C1–C15 (pty event batching, bundle splitting, mobile polling, N+1 SQL)
  remain the top architecture/perf debt — separate effort from this correctness pass.
- `global.css` at ~9.9k lines keeps growing; consider freezing + Tailwind migration policy.
