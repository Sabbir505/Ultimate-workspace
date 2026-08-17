# Conduit — Bug & Edge-Case Audit

**Date:** 2026-08-17 · **Scope:** full project (frontend `src/`, Rust backend `src-tauri/src/`, mobile app `mobile/`)

> **STATUS: FIXED** — All H/M items and 13 of 18 L items are fixed (marked ✅ below) with regression tests for H1/H2/M1/M7.
> Deliberately NOT fixed (design tradeoffs, see their entries): L8 CSS-url hardening, L12 `--dangerously-skip-permissions`
> documentation task, L16 writePtySubmit delay, L17 chatScroll singleton, L18 DB-mutex read connection.
> Post-fix verification: `tsc` clean · `vitest` **374/374** (3 new regression tests) · `cargo test` **502/502** (1 new) · `vite build` ✅

## Machine-check results

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ clean |
| `vitest run` | ✅ 371/371 tests pass (56 files) |
| `cargo check` | ✅ compiles — 79 warnings, all dead-code/unused (3 non-test `lock().unwrap()` are acceptable) |
| `cargo clippy` | ✅ no clippy-specific lints |
| `vite build` | ✅ passes |
| `cargo test` | ✅ 506 passed, 0 failed, 11 ignored (lib 501 + browser-mcp bin 4 + smoke 1; initially blocked by a full disk, re-run after freeing space) |

**Environment note:** the D: drive was at 100% capacity during the first audit pass, which blocked `cargo test` linking (`os error 112`). After freeing space (66 GB free at re-run) the suite passed in full. A nearly-full disk can still make the app's SQLite writes, artifact saves, and checkpoint snapshots fail at runtime — worth keeping headroom.

**Coverage note:** state stores, hooks, lib modules, PTY, git, secrets, DB, agent sessions, chat dispatch, mobile relay crypto, automations, and the mobile `useRelay`/crypto were read line-by-line. Components got a risk-pattern sweep (JSON.parse guarding, listener balance, timers) plus targeted reads — not an exhaustive per-file read of all ~24k lines.

---

## HIGH severity

### ✅ H1. Rapid chat switching permanently deletes a chat with history (data loss)
- **Where:** `src/state/chat.ts:767` + `src/state/chat.ts:849`
- **Problem:** `selectSession` decides whether to delete the outgoing chat from the shared `messages` buffer: `const outgoingEmpty = get().messages.length === 0`. But `messages` only contains the outgoing session's rows if that session's own fetch already committed. Viewing empty chat A, rapidly clicking session B then C: when C's handler runs, `messages` is still A's empty buffer, so `outgoingEmpty` is true for **B**, and `deleteChat(outgoingId)` deletes B and its full history from the DB (B's in-flight fetch is later discarded by the `activeChatSessionId === chatSessionId` guard, so nothing corrects it).
- **Solution:** Track which session `messages` belongs to — e.g. a `messagesSessionId` field set in the same `set()` as `messages` — and only treat the outgoing chat as empty when `messagesSessionId === outgoingId && messages.length === 0`. Alternatively decide emptiness from the fetched `listChatSessions` metadata instead of the local buffer.

### ✅ H2. Double-send guard is global, not per-session → two concurrent streams in one chat
- **Where:** `src/state/chat.ts:1136` (guard), `src/state/chat.ts:1653` (scalar flip)
- **Problem:** The send guard is `if (get().streamingChatSessionId === activeChatSessionId)`, but `streamingChatSessionId` is a single global scalar that `onToken` flips on *every* token of *any* session (including background `broadcastToSessions` streams, which correctly use the per-session `streaming` map — line 1322 filters with `!(id in state.streaming)`). With two concurrent streams the scalar points at whichever session emitted the last token, so sending in a session that *is* streaming (while the scalar names the other) bypasses the queue and starts a second concurrent turn for the same session — interleaved replies and corrupted history.
- **Solution:** Change the guard to `if (activeChatSessionId in get().streaming)`, matching `drainQueue`'s per-session check (line 645).

### ✅ H3. Chat DB and per-session frontend state grow without bound / never fully cleaned
- **Where:** `src/state/chat.ts:933-981` (`deleteChat`), `:1000` (`deleteAllChats`), `:1893` (`onError`), `:1988` (subagent output)
- **Problem:** `deleteChat` clears only some per-session keys. Left behind: `chatStatus`, `messageQueue`, `tasks`, `planSteps`, `subagents`, `livePerf`, `sessionMetrics`, `cwdOverrides`, plus `artifactsByMessage` (keyed by messageId, never pruned). `deleteAllChats` additionally misses `pendingApprovals`, `subagents`, `livePerf`, `sessionMetrics`, `previewArtifacts`. `onError` never clears `livePerf`/`pendingArtifacts`. Separately, `onToken` caps the main stream at 200k code points but subagent streams (`sub.output + payload.chunk`) have **no cap**.
- **Solution:** Extract one `clearSessionState(chatSessionId)` helper that removes every per-session key and call it from `deleteChat`, `deleteAllChats`, and (partially) `onError`; apply the same `tailCodePoints(..., 200_000)` cap to subagent output.

---

## MEDIUM severity

### ✅ M1. Stop button can cancel the wrong stream or silently do nothing
- **Where:** `src/state/chat.ts:1551-1571`, `src/components/chat/ChatView.tsx:703`
- **Problem:** `cancelStream` reads the global `streamingChatSessionId` scalar. With sessions A and B streaming concurrently, pressing Stop while viewing B can cancel A; if the scalar is `null` (B hasn't emitted its first token), Stop does nothing and the button can vanish mid-stream.
- **Solution:** Cancel by the active session's key: `const sid = get().activeChatSessionId; if (sid && sid in get().streaming) ...`, and key Stop-button visibility off `activeChatSessionId in streaming`.

### ✅ M2. Regenerate/edit blocked or allowed at the wrong times (same scalar bug)
- **Where:** `src/state/chat.ts:1389` (`regenerate`), `:1408` (`editMessage`), `:810` (artifact restore)
- **Problem:** Both are gated on the global scalar: a background stream blocks regenerate/edit in the idle session the user is viewing; conversely if the viewed session streams but the scalar points elsewhere, regenerate proceeds mid-stream (supersede + send while a turn runs). Line 810 uses the same scalar to decide whether to skip overwriting a mid-stream session's artifact buffers.
- **Solution:** Guard with `activeChatSessionId in get().streaming` (and `!(chatSessionId in streaming)` at line 810).

### ✅ M3. Approval-card failure leaves the turn wedged forever
- **Where:** `src/state/chat.ts:1531-1541`
- **Problem:** `resolveApproval` optimistically deletes the card, then `await resolveToolAction(...)` with no try/catch (caller does `void resolveApproval(...)`). If the IPC rejects, the card is already gone but the backend tool loop is still paused waiting for a resolution — the turn hangs with no way to re-approve.
- **Solution:** Wrap in try/catch; on failure restore the approval card (`pendingApprovals[chatSessionId] = pending`) and surface the error via `toastError`.

### ✅ M4. Streaming text can be dropped or resurrect stale text after reset
- **Where:** `src/hooks/useStreamingText.ts:80-83`, `:119`
- **Problem:** The rAF flush uses a captured snapshot (`const base = displayedRef.current`) instead of a functional update; under load a second frame's flush can read the same stale base and overwrite the first flush's pending `setDisplayed` — silently dropping streamed text. `reset()` can't cancel an already-queued transition update, so a flush scheduled just before reset can commit after it and resurrect old text.
- **Solution:** Use `startTransition(() => setDisplayed(prev => prev + flushed))` (no snapshot), and make `reset` bump an epoch the flush callback checks (or clear a pending-flush ref).

### ✅ M5. Plan-tracker watermark is index-based → duplicate plan steps
- **Where:** `src/hooks/usePlanTracker.ts:75,91`; triggers via `src/state/chat.ts:735` (`loadOlderMessages` prepends) and `:1741-1762` (`onDone` replaces the 200-row page with full history)
- **Problem:** The parse watermark is an array index. After prepending older messages or replacing the page with the full history, indices after the watermark point at already-parsed messages, which get re-parsed with a new `planIndex` — duplicate step entries accumulate in the Progress panel (stepIds are unique per re-parse, nothing dedupes).
- **Solution:** Key the watermark by message id, not index (scan `messages` after the last parsed id), which is invariant under prepends and full-list replacement.

### ✅ M6. Closed PTY panes are never evicted → unbounded memory growth
- **Where:** `src-tauri/src/pty/mod.rs:963` (insert), `:1007-1014` (`kill_pane` kills but never removes)
- **Problem:** The `panes` HashMap only ever inserts/overwrites by pane id; closed pane ids are never reused, so every closed pane's `Arc<Pane>` (ring transcript + vt100 screen with scrollback + master handle) is retained for the app's lifetime. Transcript retention after close is deliberate, but there is no cap on how many are retained.
- **Solution:** On `kill_pty`, move the transcript into a small bounded LRU (e.g. last 20 transcripts keyed by session id) and drop the `Pane` from the map; keep `transcript_for_session` reading from that LRU.

### ✅ M7. Freshly-initialized git repos break the diff/commit/log paths (unborn HEAD)
- **Where:** `src-tauri/src/git.rs:244` (`git diff HEAD`), `:704` (`rev-parse --short HEAD`), `:724` (`git log`); created via `initGitRepo` (`src/lib/ipc.ts:97`)
- **Problem:** A repo with zero commits has an unborn HEAD. `git diff HEAD` and `git log` fail with "ambiguous argument 'HEAD'". The app itself creates this exact state (`init_git_repo`), so the Changes panel and log view error out on a just-initialized project until the first commit is made. (`get_git_status` is fine — porcelain works on unborn HEAD. `git_commit` turned out to be fine too: the commit births HEAD before the `rev-parse` runs.)
- **Solution (applied):** `get_git_diff` detects unborn HEAD (`rev-parse --verify --quiet HEAD`) and synthesizes all-added diffs per untracked file via the existing `--no-index /dev/null` path; `get_git_log` returns an empty list; `get_git_file_diff` routes staged files in unborn repos through the no-index path too. Regression test `unborn_head_diff_and_log_are_not_errors` added.

### ✅ M8. Mobile: changing the relay URL while a reconnect is pending reconnects to the OLD URL
- **Where:** `mobile/src/hooks/useRelay.ts:337` (timer), `:341-354` (`globalConnect` doesn't clear it)
- **Problem:** `ws.onclose` schedules `_reconnectTimer = setTimeout(() => _doConnect(target), 3000)` closing over the *old* target. `globalConnect(newUrl)` sets `_url`/`_token` and connects, but does not cancel the pending timer — 3s later it fires and reconnects to the previous desktop's URL, silently overriding the user's choice (and `_url` then points at the old host again).
- **Solution:** Clear `_reconnectTimer` at the top of `globalConnect`/`_doConnect` (as `globalDisconnect` already does), and have the timer re-read `_url` instead of the captured `target`.

### ✅ M9. Fire-and-forget async chains without rejection handling (pattern)
- **Where:** `src/state/chat.ts:841-844` (`touchChatSession(...).then(...)`), `src/state/automations.ts:68`, `src/hooks/useAutomationEvents.ts:20`, `src/hooks/useBudgetEvents.ts:31`, every `void selectSession(id)` caller (e.g. `src/components/sidebar/Sidebar.tsx:183`), `src/lib/workspaceRestore.ts:119,147` (`void saveLayoutNow()`), `src/lib/exportSession.ts:31` (`exportSessionMarkdown` awaited outside its try block)
- **Problem:** A single IPC failure in any of these produces an unhandled promise rejection; the follow-up work (session relist, automations reload, layout save) silently never happens.
- **Solution:** Add `.catch(...)` to each fire-and-forget chain — no-op or `toastError` depending on user impact; move the `exportSessionMarkdown` await inside the try block.

### ✅ M10. `onDone` replaces the capped message page with the entire session history
- **Where:** `src/state/chat.ts:1713`
- **Problem:** Every completed turn calls `getChatMessages(chatSessionId)` with **no limit**, replacing the 200-row page that pagination (`loadMessages`, M7 pagination) normally maintains. On huge sessions this re-renders the whole list per turn (and feeds the plan-tracker duplication in M5).
- **Solution:** Fetch with the same cap (`getChatMessages(chatSessionId, undefined, 200)`) or refetch only the tail rows after the last known id.

---

## LOW severity

### ✅ L1. `loadOlderMessages` breaks infinite scroll for the newly-viewed session
- **Where:** `src/state/chat.ts:726`
- **Problem:** When the older-messages fetch returns empty, `set({ hasMoreHistory: false })` runs *without* the `activeChatSessionId === chatSessionId` guard the subsequent set has. Switching sessions mid-fetch wrongly forces `hasMoreHistory` false for the new session.
- **Solution:** Move that `set` inside the same active-session guard.

### ✅ L2. Dangling-custom-theme safety check is dead code
- **Where:** `src/state/settings.ts:150-158`
- **Problem:** The check that `customThemeId` references an existing theme runs *before* the stored id is assigned to `next.customThemeId`, so it validates the previous (usually null) value; the freshly loaded id is assigned unvalidated.
- **Solution:** Move the `customThemeId` assignment above the `themesJson` block so the check validates the just-loaded value.

### ✅ L3. "Focus clears the notify cooldown" is promised but never wired
- **Where:** `src/hooks/usePtyEvents.ts:22,28-32`
- **Problem:** `clearNotifyCooldown` is defined but never called; focusing a pane doesn't clear its cooldown, so the next completion within 30s still doesn't notify. `lastNotifiedAt` entries are also never removed when panes close (map grows one entry per pane ever notified).
- **Solution:** Call `clearNotifyCooldown(paneId)` when `paneId === focusedPaneId` in the `pty:state` handler (or from `focusPane`), and delete entries in the pane-close path.

### ✅ L4. Plain unified diffs without `diff --git` headers are dropped entirely
- **Where:** `src/lib/diff.ts:54-63`
- **Problem:** `parseUnifiedDiff` only starts a file when it sees `diff --git `. A classic unified diff that starts with `--- a/file` is skipped (`if (!current) continue`) and the whole input parses to zero files — the diff card shows nothing. Model/tool output sometimes lacks git headers.
- **Solution:** Also start a new file on `--- ` when `current` is null (using the following `+++ ` line as the new path).

### ✅ L5. `file://` URL construction breaks on Windows backslash paths and `#`/`?` in filenames
- **Where:** `src/lib/sessionLauncher.ts:213`
- **Problem:** `encodeURI(`file:///${path.replace(/^\/+/, "")}`)` neither converts backslashes to `/` nor escapes `#`/`?` (encodeURI leaves them). A Windows path like `D:\a\b.html` produces `file:///D:\a\b.html`, and a filename containing `#` truncates the URL at the fragment — the artifact preview fails to load.
- **Solution:** Normalize `path.replaceAll("\\", "/")` before encoding and percent-encode `#`/`?` explicitly (or use `encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F")`).

### ✅ L6. Plan-completion scanner false-positives on words containing the markers
- **Where:** `src/lib/planMatcher.ts:81`
- **Problem:** The pattern `(?:completed|finished|done)[\s:]*${label}` has no word boundary, so prose like "unfinished setup database" matches "finished … setup database" and wrongly marks the step complete.
- **Solution:** Anchor the verbs with `\b`: `(?:\b(?:completed|finished|done)\b)[\s:]*${label}`.

### ✅ L7. Plan-step label normalization mangles snake_case; dedup drops distinct nested steps
- **Where:** `src/lib/planParser.ts:10` (`.replace(/_/g, "")`) and `:17-24,72-73` (word overlap divided by `min` size)
- **Problem:** Stripping *all* underscores destroys labels like `parse_plan_steps` → `parseplansteps`. The containment-style overlap ("Add X" vs "Add X and test it" scores 1.0) treats distinct hierarchical steps as duplicates and drops the second.
- **Solution:** Only strip markdown-emphasis underscores (e.g. `/_([^_]+)_/` around word characters), and dedup on equality or overlap ≥0.8 with similar lengths (or use Jaccard over the union instead of min).

### ⏸ L8. CSS-based exfiltration channel in sanitized iframe previews (hardening note)
- **Where:** `src/lib/sanitize.ts:21-63` (inline `style` allowed)
- **Problem:** The DOMPurify config deliberately allows `style` attributes (office renderers need them). Inside `style`, `url(...)` values can load remote resources, giving crafted model output a beacon/exfiltration channel even in a `sandbox=""` iframe. The tradeoff is documented, but nothing constrains it.
- **Solution:** Inject a CSP into the srcDoc (`<meta http-equiv="Content-Security-Policy" content="img-src 'none'; default-src 'none'">` style lockdown appropriate to the preview) or post-process sanitized HTML to strip `url(` from style attributes.

### ✅ L9. `taskkill`-based seen-URL pruning comment misleads; pruning is arbitrary order
- **Where:** `src-tauri/src/pty/mod.rs:831-844`
- **Problem:** The "Drop the oldest 200 entries" prune iterates a `HashSet` (unordered), so it drops 200 *arbitrary* entries, not the oldest — a recently detected URL can be evicted and re-fire, re-opening a browser pane the user closed.
- **Solution:** Use an insertion-ordered structure (e.g. an `IndexSet` or `VecDeque<String>` + HashSet index) so pruning really drops the oldest.

### ✅ L10. Dead/unreachable match arm in the permission glob matcher
- **Where:** `src-tauri/src/chat/permission.rs:612`
- **Problem:** `(Some(_), None)` at line 612 is unreachable — `(Some(seg_p), None)` at line 599 already matches. Harmless dead code (compiler warning), but it hides the intended "remaining pattern must be all `**`" rule.
- **Solution:** Delete the redundant arm (or fold its `p.iter().all(|x| x == "**")` semantics into arm 599 if the stricter behavior was intended — currently 599 only allows exactly one trailing `**`).

### ✅ L11. `set_secret` can orphan a keychain entry
- **Where:** `src-tauri/src/secrets.rs:45-49`
- **Problem:** The value is written to the OS keychain first, then the DB registry row. If the DB write fails, the keychain entry remains but is unlisted (and unrecoverable through the UI).
- **Solution:** On DB-write failure, best-effort `platform::remove(project_id, key)` before returning the error.

### ⏸ L12. Security note: headless/automation turns run with `--dangerously-skip-permissions`
- **Where:** `src-tauri/src/agent_sessions.rs:2333`
- **Problem:** Claude headless one-shots (used by automations and agent-chat) pass `--dangerously-skip-permissions` so unattended runs never block on the CLI's own prompts. This is a deliberate design choice, but it means scheduled automations execute with full filesystem/tool permissions on the machine with no app-level approval gate.
- **Solution:** At minimum document it prominently in the Automations UI; ideally offer a per-automation "restricted" mode (read-only permission mode) that maps to the CLI's own sandbox flags where available.

### ✅ L13. Mobile `extractToken` mishandles fragments containing only one of `?`/`&`
- **Where:** `mobile/src/hooks/useRelay.ts:233-236`
- **Problem:** `Math.min(frag.indexOf('?'), frag.indexOf('&')) === -1 ? frag.length : ...` — if *either* separator is absent the min is -1 and the whole fragment (including the separator and everything after) is treated as the token; pairing then fails with a confusing error.
- **Solution:** Compute each index separately and take the smallest non-negative one: `const ends = [frag.indexOf('?'), frag.indexOf('&')].filter(i => i !== -1); const end = ends.length ? Math.min(...ends) : frag.length;`

### ✅ L14. `defaultHarness()` can return a harness that isn't installed
- **Where:** `src/lib/sessionLauncher.ts:141-145`
- **Problem:** The fallback chain ends with `?? "claude_code"` even when nothing is installed, so Cmd+N creates a session that immediately fails to spawn.
- **Solution:** Return `null` when nothing is installed and let the caller surface the "install a harness" onboarding state.

### ✅ L15. Deprecated `navigator.platform` for shell selection
- **Where:** `src/lib/sessionLauncher.ts:260`
- **Problem:** `navigator.platform.startsWith("Win")` is deprecated and empty in some embedded webviews → falls through to `bash` on Windows and the shell pane fails to spawn.
- **Solution:** Use `navigator.userAgentData?.platform ?? navigator.userAgent` (or a Tauri OS API) for the platform check.

### ⏸ L16. `writePtySubmit`'s fixed 250 ms Enter delay
- **Where:** `src/lib/ipc.ts:120-123`
- **Problem:** The submit `\r` is sent on a fixed 250 ms timer after the text write. A slow TUI render (large paste, cold start) can receive Enter before it rendered the text; an idle one waits a visible fraction of a second. Borderline by design (comment documents why it's separate), but it's a timing heuristic with no feedback.
- **Solution:** Optionally echo-check via the pane's screen state before sending `\r`, or make the delay a setting. Low priority.

### ⏸ L17. `chatScroll` module singleton assumes a single ChatView
- **Where:** `src/lib/chatScroll.ts:8`
- **Problem:** A module-level `scrollFn` is clobbered by whichever ChatView mounted last. Fine today (one chat view), but any future split-pane chat breaks TurnNavigator scrolling for the first view silently.
- **Solution:** Key the registry by chat session id, or document the single-view constraint at the registration site.

### ⏸ L18. Single global DB mutex can stall chat turns behind long writes
- **Where:** `src-tauri/src/lib.rs:49` (`DbState(Arc<Mutex<Connection>>)`), heavy writers: docs indexing, cost rollups
- **Problem:** All commands serialize on one SQLite connection behind one mutex (correct, but a long write — e.g. document embedding index or a big checkpoint — blocks every other DB call, including the early `db.lock()` in each chat turn). Not a deadlock (lock ordering is consistent: sessions→db; parking_lot guards are `!Send` so they structurally cannot be held across `.await` in spawned tasks).
- **Solution:** Move heavy analytics/indexing to a second connection (WAL allows one writer + concurrent readers) or chunk long writes into short transactions.

---

## Verified-clean areas (no action needed)

- **Rust unwrap discipline:** ~470 unwraps are all inside `#[cfg(test)]`; only 3 non-test `lock().unwrap()` (poison-only panics).
- **SQL injection:** all `format!()` SQL builds placeholder lists / constant column lists only; values always bound via `params!`.
- **Lock ordering:** `sessions` → `db` consistently; no inversion found.
- **Mobile E2E crypto** (`relay_crypto.rs` + `relayCrypto.ts`): HKDF-SHA256 with pinned salt/info, per-direction strictly-increasing counter nonces (16 zero bytes + BE u64), AEAD tag verified, nonce-vs-counter checked on decrypt, CSPRNG pairing token, HMAC proof (raw token never on the wire), cross-implementation test vectors. Correct mirror on both sides.
- **Sanitization:** DOMPurify for iframe srcDoc and mermaid SVG, applied at every injection site (except the documented style-attr tradeoff in L8); all frontend `JSON.parse` sites are try/catch guarded.
- **Automations scheduler:** catch_unwind around execution, overlap skipping via RUNNING set, single catch-up for missed cron windows, on-disk lock cleanup.
- **PTY process handling:** Windows tree-kill via `taskkill /T /F`, slave-drop for EOF, poll-based reaping that never holds the child lock across a blocking wait, 16ms/64KB output coalescing with UTF-8-safe tail slicing.
- **Git hardening:** repo-relative path validation rejects absolute paths and `..` escapes (`git.rs:279`); detached HEAD and no-upstream handled; lossy UTF-8 everywhere.
- **Browser MCP:** caller-supplied `wait_for` timeouts clamped to a sane max with overflow-safe deadline math.
- **Session lifecycle (Rust):** `turn_in_flight` checked before persisting the user message (no orphaned messages), harness switch kills the old tree and drops the resume id, cancel resolves pending approvals to deny.

## Fix status (all applied)

1. **H1, H2, M1, M2** ✅ — `streamingChatSessionId` scalar reads replaced with per-session `streaming`-map checks (send/regenerate/edit/cancel/Stop/goal-loop/artifact-restore); `messagesSessionId` tracking added across every wholesale `messages` replacement, also guarding `deleteActiveIfEmpty` and `newChat`'s reuse path. Regression tests: `chatStreamLifecycle.test.ts` (H1, H2, M1).
2. **M3, M4, M5** ✅ — approval card restored + toasted on IPC failure; streaming-flush uses a functional update behind an epoch that `reset()` invalidates; plan watermark keyed by message id.
3. **M6, M7, H3** ✅ — closed panes evicted with a 20-entry transcript LRU (export-after-close preserved); unborn-HEAD git fallbacks + regression test; `clearSessionState` helper wired into deleteChat/deleteAllChats/onError, subagent output capped at 200k code points.
4. **M8–M10 + L-series** ✅ (L1–L7, L9–L11, L13–L15) — mobile reconnect timer race + `extractToken`; `.catch` pass over fire-and-forget chains; `onDone` capped to the 200-row page.

**Left open (deliberate):** L8 (CSP/CSS-url hardening — documented tradeoff), L12 (document `--dangerously-skip-permissions` in the Automations UI), L16 (writePtySubmit feedback-based submit), L17 (chatScroll single-view constraint), L18 (second SQLite reader connection).
