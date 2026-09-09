# Relay — Full Project Audit (2026-09-09)

> **FIX STATUS (2026-09-10): every actionable finding is now fixed.** The only findings deliberately not code-changed are #93/#94/#95 (verified as deliberate, test-guarded product decisions — see the fix log) and #96 (attempted, deferred with evidence — enabling it surfaces 124 pre-existing dead-symbol errors; a tracked follow-up). Verification after the final pass: `cargo test --lib` **1011 passed / 0 failed**, `vitest run` **136 files / 857 tests passed**, `tsc --noEmit` clean, compiler-warning count **down 71 → 62** with zero new warnings introduced by fixes. See the "Fix log" sections at the bottom.

Whole-project review of every source area: **~75,000 lines of TypeScript/React** (`src/`) and **~109,000 lines of Rust** (`src-tauri/`), plus build config, Tauri capabilities/CSP, release scripts, and CI.

**Method.** Ten parallel deep-review passes, each read its scoped files in full and verified every candidate finding against the actual code (cross-checking callers/consumers before reporting). Two scopes were re-verified directly by hand after reviewer capacity ran out (chat tool/permission core, misc + build config). Every finding below has a `file:line` and a code-level justification. No speculative or style-level items are included.

**Build health at audit time.**
- `tsc --noEmit`: clean (0 errors).
- `vitest run`: **135 files / 847 tests, all passing**.
- `cargo check`: compiles with **71 warnings** — mostly unused imports/variables/dead code, plus **12 discarded `Result`s in `pdfprint.rs:299-308`** and 1 in `browser.rs:2233` (see §9).
- Known-relevant warnings worth fixing: `browser.rs:2233` (`OpenDevToolsWindow` result ignored), `pdfprint.rs:299-308` (WebView2 print-settings results ignored), `agent_sessions.rs:3404` (assigned-but-never-read `prompt_env`), `dispatch.rs:1325`/`office.rs:88`/`pty/mod.rs:940` (assigned-never-read values).

**Counts:** 3 High, 33 Medium, 39 Low, plus config/notes. No Critical findings.

| Area | Findings |
|---|---|
| §1 Rust chat core A (commands/dispatch/mod/streaming) | 12 |
| §2 Rust chat core B (tools/permission/providers/…) | 3 |
| §3 Frontend state + hooks | 5 |
| §4 Frontend lib utilities | 6 |
| §5 Chat UI core (ChatComposer/ChatView/MessageBubble) | 11 |
| §6 Other chat UI components | 13 |
| §7 Non-chat UI (App/panes/settings/sidebar/…) | 21 |
| §8 DB / memory / commands (Rust) | 9 |
| §9 Harness/ACP/browser/connectors/PTY (Rust) | 11 |
| §10 Build config & security config | 5 |
| §11 Repo hygiene | 3 |

---

## 1. Rust chat core A — `chat/commands.rs`, `dispatch.rs`, `mod.rs`, `streaming.rs`

These four files are notably hardened (stall watchdogs, byte-buffered SSE, char-safe slicing, clamped wire indices in the main rounds, poisoned-lock-free `parking_lot` with no guards held across awaits). The real defects cluster around **abort paths** and **heavyweight work under the global DB mutex**.

1. **[High][Leak] `src-tauri/src/chat/streaming.rs:1294` (also `:1565`) — Cancelling a turn leaves `Task` subagent LLM loops running indefinitely.** Every `Task` call is spawned via `dispatch::spawn_run_tool` (plain `tokio::spawn`, never registered), so when `ChatManager::cancel` aborts the turn task, the `JoinHandle` is dropped and the child is detached — the subagent keeps its tool loop (up to `SUBAGENT_MAX_ROUNDS = 100` provider round-trips), spending tokens and emitting `chat:subagent-tokens` for a turn the user stopped. Only the `background: true` variant registers a `cancel_rx`. Evidence: `handle.await.unwrap_or_else(|e| format!("Error: subagent task failed: {e}"))` with spawn site `dispatch.rs:1705`. **Fix:** register spawned `Task` handles with the `ChatManager` and abort them in `cancel()`/`drop_pending_for_session`.

2. **[Medium][Leak] `src-tauri/src/chat/turn_perf.rs:72-87` (cleanup site `mod.rs:1121`) — Aborted turns leak the perf registry entry and a 500 ms heartbeat task forever.** `turn_perf::unregister(&sid)` runs only in the spawned task's tail; on abort (user cancel, session delete) that tail never executes and neither `ChatManager::cancel` (`mod.rs:1144-1149`) nor `delete_chat_session` (`commands.rs:238-255`) unregisters. The heartbeat's liveness check stays true and it calls `app.emit("chat:perf", …)` every 500 ms for the process lifetime, per abandoned session. **Fix:** call `turn_perf::unregister(sid)` inside `ChatManager::cancel` and `delete_chat_session`.

3. **[Medium][Perf] `src-tauri/src/chat/dispatch.rs:2577-2582` — `search_docs` runs a brute-force cosine scan over all indexed chunks while holding the global DB mutex, on the async runtime.** `db.0.lock(); crate::db::search_chunks(&conn, &query_vec, top_k)` blocks every other DB consumer (all IPC, stream persistence) for hundreds of ms on large corpora. `compute_docs_retrieval` (`mod.rs:1204`) wraps the identical query in `spawn_blocking` for exactly this reason. **Fix:** move lock + `search_chunks` into `spawn_blocking`.

4. **[Medium][Perf] `src-tauri/src/chat/commands.rs:126-128` — `restore_chat_checkpoint` holds the global DB mutex across a full git snapshot + tree restore.** `checkpoints::restore` runs `git add -A` over the whole repo inline under the lock (seconds on large repos), stalling all DB consumers. (The turn-start baseline was already fixed for this — D3 in `checkpoints.rs` — but restore wasn't.) **Fix:** drop the lock around git operations; re-acquire only for the DB writes.

5. **[Medium][Perf] `src-tauri/src/chat/commands.rs:342-357` — `delete_all_chat_sessions` runs per-session git worktree removal and ref pruning inside one held DB lock.** The batch loop calls `prune_session_refs` and `remove_worktree_for_session` (which deletes a whole directory tree) per session, serializing all DB consumers behind O(sessions × git) filesystem work. **Fix:** collect info under the lock; run git/file ops after releasing it.

6. **[Low][Leak] `src-tauri/src/chat/mod.rs:1118` — The `late_attach` slot (live connector MCP sessions) is never cleared on cancel or session delete.** `clear_late_attach(&sid)` is only called in the spawn tail; a cancelled/deleted session leaves its `Arc<Mutex<LateAttach>>` owning live vendor MCP sessions in the map forever. **Fix:** call `clear_late_attach(sid)` in `cancel()` alongside `drop_pending_for_session`.

7. **[Low][EdgeCase] `src-tauri/src/chat/dispatch.rs:1292-1296` (also `:1207-1215`, `:1223-1234`) — Subagent loop doesn't clamp network-controlled tool-call/block indices.** `tc.get("index")…unwrap_or(0)` feeds `oai_calls.entry(idx)`; the main rounds cap at `MAX_STREAM_BLOCK_INDEX = 64` because base URLs are user-configured, but the subagent `BTreeMap` grows one entry per distinct index a hostile endpoint sends. **Fix:** apply the same clamp.

8. **[Low][EdgeCase] `src-tauri/src/chat/streaming.rs:638` — `anthropic_stream_round` still requires the strict `"data: "` prefix, silently producing an empty answer on non-conformant SSE.** Every other reader was fixed to tolerate `data:` without a space (B-18); here all events are skipped, `blocks` stays empty, and the turn "succeeds" with an empty persisted message. **Fix:** `strip_prefix("data:").map(|s| s.trim_start())`.

9. **[Low][Bug] `src-tauri/src/chat/streaming.rs:1174-1177` (also `:1530-1533`) — Cache-rejection retry guard is a substring match that can fire after tokens already streamed, duplicating the round's text.** `is_cache_rejection` is `err.contains("cache_control") || err.contains("ephemeral")`; a mid-stream provider error whose message mentions those words (after deltas were already emitted and persisted) re-runs the whole round. **Fix:** only retry when nothing was emitted into `full`.

10. **[Low][Efficiency] `src-tauri/src/chat/commands.rs:5276-5364` — Cloud context-meter memoization is checked only AFTER the expensive work it exists to avoid.** The fingerprint hashes `system_str`, which requires first running `attach_availability` (DB + MCP defs), `build_system_prompt` (~55k chars) and serializing ~42k chars of tool specs on every 2 s poll; the cache hit then only skips the cheap arithmetic. **Fix:** key the cache on cheap inputs and check before assembling.

11. **[Low][Security] `src-tauri/src/chat/commands.rs:3644` (also `:4175`, `:4202`) — `read_artifact_preview` / `open_artifact_external` / `download_artifact` accept arbitrary absolute paths from the webview with no containment check.** Model-driven file access is carefully gated by `fs_roots` + approvals in `dispatch::run_tool`, but these IPC endpoints bypass that entirely — any script execution in the chat webview (which renders model-controlled content) becomes an arbitrary-file read primitive (up to 25 MB → base64). **Fix:** require the resolved path to sit inside the artifacts dir or a granted root (reuse `permission::path_within_scope`).

12. **Verified non-issues worth noting:** `ChatUsage` fields are `i64` so the `input_tokens - cache_read` math cannot underflow; `chain[0]` indexing is safe; `suppressed_from` byte-offset math maps correctly onto char boundaries; `ChatManager::send`'s cancel→spawn→insert is synchronous; block indices in main stream rounds are clamped.

---

## 2. Rust chat core B — tools, permission, providers, codeexec, office, pdfprint (direct review)

The permission model (`permission.rs`) is well-built: lexical canonicalization resolves `..`/`.` segments, requires segment-boundary prefixes (so `c:/projects/alpha2` doesn't match root `alpha`), and `path_within_scope` additionally resolves **filesystem** symlinks/junctions (with parent-fallback for not-yet-existing write targets) before the containment check. `citation_lint.rs` byte-slicing is boundary-safe throughout (indices from `find`/`len_utf8`). SQL everywhere interpolates only constant column lists. `codeexec.rs` is honest about no-sandbox (warns in output), has a timeout, `kill_on_drop`, and bounded output. `installed_skills.rs` resolves slugs by scanning, not by joining user input. Three findings:

13. **[Medium][Security] `src/lib/sanitize.ts:81-92` — `sanitizeSvg` allows `<style>`, enabling app-wide CSS injection into the privileged main window** *(cross-listed from §4)*. DOMPurify's `html`/`svg` tag lists both include `style`; output is injected via `dangerouslySetInnerHTML` (`MermaidDiagram.tsx:504`, `DiagramLightbox.tsx:371`). A `<style>` inside an SVG is *not* scoped — it applies to the whole document — and mermaid `%%{init: {"themeCSS": …}}%%` flows model-controlled CSS there (UI redress/overlay, forced remote loads via `url()`; no script execution). **Fix:** hook that strips `url(`/`@import`/`position` from `<style>` content, or render diagrams in a sandboxed iframe.

14. **[Medium][ErrorHandling] `src-tauri/src/chat/pdfprint.rs:299-308` — All twelve WebView2 print-settings `Result`s are discarded** (`SetPageWidth/Height/Margins/Scale/…`). Any failure silently produces a PDF with default page size/margins — a layout-corruption bug with no error path. (These are the cargo warnings at those lines.) **Fix:** `.map_err(…)?` each call.

15. **[Low][ErrorHandling] `src-tauri/src/browser.rs:2233` — `core.OpenDevToolsWindow()` result discarded** in the Windows arm; DevTools can silently fail to open. **Fix:** map the HRESULT to an error string like the surrounding code.

Also verified clean in this scope: `tools/mod.rs` tool dispatch (`run_blocking_tool` on `spawn_blocking`, arg validation, `open_file` absolute-path requirement), `providers.rs` request construction (correct header schemes per provider, B-15/B-17 stream handling), `artifacts/generator.rs` (no FS writes from model text), `github.rs` (token only in `Authorization` header, never logged), `pygen.rs`/`jsdocgen.rs` (temp dirs removed on all paths), `docs_images.rs` (read via `ok()?`).

---

## 3. Frontend state + hooks (`src/state/*`, `src/hooks/*`, `src/types.ts`)

Most of this area is unusually well-guarded (race/tombstone/ownership guards throughout). Five findings:

16. **[High][Bug] `src/state/chat.ts:2750` — `cancelStream` never refreshes the split-pane buffer after persisting a stopped turn's partial reply.** The final refetch is gated only on the *global* active session, so pressing Stop in the split pane deletes the `streaming` key and persists the partial, but the split view's live bubble vanishes and the persisted partial never lands in `splitMessages` until some later reload. `onDone` handles this exact case explicitly (`chat.ts:2998-3017`). **Fix:** mirror `onDone`'s `isSplitTarget` logic when `get().splitChatSessionId === streamingChatSessionId`.

17. **[Medium][Bug] `src/state/chat.ts:2441` — `deleteMessage`'s rollback refetch writes the message buffer without re-checking which session is active after the awaited IPC.** If the user switches chats while a failing delete is in flight, the catch writes the old session's rows into the buffer now displaying the new session, desyncing the `messagesSessionId` ownership invariant every sibling path maintains. **Fix:** re-derive `inSplit`/activeness after the refetch.

18. **[Medium][Bug] `src/state/chat.ts:2213` (and `:2252`) — `sendMessage`'s catch blocks write the shared global `error`/`errorCode` without the active-session gate `onError` uses.** A split-pane send failure surfaces the error banner in *every* open chat view (`ChatView.tsx:2071` renders `error` in both instances). **Fix:** gate both catch blocks (`get().activeChatSessionId === activeChatSessionId ? { error } : {}`).

19. **[Low][Efficiency] `src/state/chat.ts:3114` — `onArtifact` fires a full artifacts-library reload (`list_artifacts` IPC returning the whole 30-day list) on every single `chat:artifact` event.** A turn writing N files causes N redundant full-list queries and N gallery re-renders. **Fix:** debounce, or reload once from `onDone`.

20. **[Low][Leak] `src/state/browserTrust.ts:43` — Per-pane entries (up to 200 timeline entries each, plus `paused`/`timelineOpen`/`lastAgentActivity` maps) are never removed when a browser pane closes.** Pane ids are fresh UUIDs per pane; no removal path exists in `disposePaneResources`. Unbounded growth over a long session with pane churn. **Fix:** delete the four per-pane keys in `disposePaneResources`.

---

## 4. Frontend lib utilities (`src/lib/*` incl. `docdesign/`)

XSS surface verified clean: `ALLOWED_ATTR` whitelisting drops all `on*` handlers; protocols are default-blocked; `safeSlice.ts` is surrogate-safe; `diff.ts`/`fuzzy.ts`/`relativeTime.ts` logic correct; `contextWindow.ts` rule ordering holds for every prefix pair. Six findings:

21. **[Medium][Security] `src/lib/sanitize.ts:81-92` — SVG `<style>` pass-through** — see finding 13.

22. **[Medium][Bug] `src/lib/docdesign/irDoc.ts:202-209` — `kpi-strip` blocks are cast without shape validation, crashing the PDF compiler and corrupting the docx compiler.** The deck path (`ir.ts:198-213`) validates each kpi; the doc path only checks array length (`blocks.push({ type, kpis: kpis as Kpi[] })`). Numeric kpi values then hit `esc(k.value)` in `compilePdfHtml.ts:122-124` → `TypeError`, failing the whole document; `compileDoc.ts:204/210` emits `text: undefined` into the generated docx. **Fix:** validate each kpi like `ir.ts` does.

23. **[Low][Bug] `src/lib/releaseNotes.ts:34` — `_emphasis_` stripping fuses snake_case words** ("fix parse_plan_steps race" → "fix parseplansteps race"). `planParser.ts:13` already fixed this exact bug class with a word-boundary-guarded pattern. **Fix:** reuse that pattern.

24. **[Low][Bug] `src/lib/syntaxTheme.ts:30-31` — style cache keyed only on `data-theme` goes stale when switching custom themes sharing a base.** Two custom themes with `base: "dark"` leave `data-theme === "dark"` unchanged, so theme A's resolved syntax colors are served forever. **Fix:** include the active custom-theme id in the cache key.

25. **[Low][EdgeCase] `src/lib/chatCitations.ts:87` — source-title truncation `title.slice(0, 117)` can split a surrogate pair** → lone surrogate renders as U+FFFD. The codebase already has `sliceCodePoints` for exactly this. **Fix:** use it.

26. **[Low][EdgeCase] `src/lib/docdesign/compileDoc.ts:238`, `compileDeck.ts:341`, `compilePdfHtml.ts:168` — L2 invariant regexes scan model content, producing false QA errors on benign text.** Any document mentioning `#abcdef` (CSS colors) trips `l2/hex-hash`; prose containing `@import` trips `l2/external` in the PDF check. **Fix:** scan only the generated skeleton, or strip string-literal payloads before testing.

---

## 5. Chat UI core — `ChatComposer.tsx`, `ChatView.tsx`, `MessageBubble.tsx`

Context: with split view active, two `ChatView`s and two `ChatComposer`s are mounted simultaneously (`App.tsx:477,494`); several findings stem from that. Streaming memos, virtualizer cache-patching, and the voice pipeline verified correct; no `dangerouslySetInnerHTML` in these files.

27. **[High][Bug] `src/components/chat/ChatComposer.tsx:2005-2055` — Alt push-to-talk starts recording in BOTH composers in split view.** Each instance registers its own `window` keydown/keyup listeners guarded only by per-instance refs; one Alt press runs two `getUserMedia` captures, two `AudioContext`s, two partial-timers, and splices the dictated text into both panes. **Fix:** only register when this composer's session is the focused chat, or gate on a module-level "already recording" latch.

28. **[Medium][Bug] `src/components/chat/MessageBubble.tsx:2325-2341` — Memo comparator excludes `onRepeat`, leaving stale "Regenerate" buttons on every previous last-assistant bubble.** `ChatView` passes `onRepeat` only to the current last assistant row; when a newer turn lands the old rows' callback becomes `undefined`, but the comparator treats props as equal, so the stale button persists — and clicking it regenerates the *newest* turn, not the row it sits on. **Fix:** add `(a.onRepeat ?? null) === (b.onRepeat ?? null)` to the comparator.

29. **[Medium][Bug] `src/components/chat/ChatView.tsx:1375-1390`, `:899-904` — Module-singleton bridges (`chatScroll`, `chatSelection`) are clobbered by the split pane and nulled when it closes.** Last-writer-wins registration means the split pane wins TurnNavigator jumps and selection-toolbar "Ask"; worse, closing the split runs its cleanup `setChatScrollToMessage(null)` while the main view is still mounted — permanently disabling both features until remount. **Fix:** register only from the focused/main pane; in cleanup only null if the registration is still yours.

30. **[Medium][EdgeCase] `src/components/chat/ChatComposer.tsx:2471-2477` (also `:456`) — Enter sends the message mid-IME-composition.** No `isComposing` guard, so the Enter that commits a CJK composition sends the half-composed text / applies a slash-menu item. **Fix:** bail when `e.nativeEvent.isComposing` (or `keyCode === 229`).

31. **[Low][ErrorHandling] `ChatView.tsx:251,351,365,946` and `ChatComposer.tsx:1246-1253,1380,1395-1421` — voided IPC promises with no `.catch`.** `safeInvoke` rejects on backend errors; harness model discovery, local-model scan, session connectors, and the empty-session sweep all degrade silently as "Uncaught (in promise)". **Fix:** add `.catch` handlers.

32. **[Low][EdgeCase] `src/components/chat/ChatComposer.tsx:2327` — `/compact` matched by prefix** (`/^\/compact/`), so typing "/compaction strategy for…" clears the box and triggers a compaction instead of sending. **Fix:** `^\/compact\b`.

33. **[Low][Bug] `src/components/chat/ChatComposer.tsx:2523` — `setSelectionRange(-1, -1)` puts the caret at the START of inserted template text while `caret` state claims the end**, desyncing the slash/@ popup from the real caret. **Fix:** `setSelectionRange(next.length, next.length)`.

34. **[Low][EdgeCase] `src/components/chat/MessageBubble.tsx:1524-1530` — A single-line fenced code block (no language) renders with inline-code styling** because the inline/block decision is "no language class AND no newline". **Fix:** decide by whether the node is inside a `<pre>`.

35. **[Low][Bug] `src/components/chat/MessageBubble.tsx:1617` — Module-level markdown cache key omits `chatSessionId`, violating the cache's own "call-site independent" invariant.** The built tree closes over `chatSessionId` (mermaid "Fix with AI"), so identical content in main+split sessions routes the repair to whichever session cached first. **Fix:** include the session id in the key.

36. **[Low][Bug] `src/components/chat/ChatView.tsx:1339-1370` — Approval/question-card scroll-anchor restore snapshots the layout AFTER the mutation, so it restores nothing** (the "chat jumps when the approval card disappears" behavior remains unfixed). **Fix:** capture distance-from-bottom before the mutation (scroll-position ref or `useLayoutEffect` on a pending-mount predictor).

37. **[Low][Efficiency] `src/components/chat/ChatView.tsx:349-357` — Full local-GGUF disk rescan on every chat-session switch** (`scanLocalModels()` keyed on `[activeChatSessionId]` though its result doesn't depend on the session). **Fix:** run once on mount; rescan on a dedicated trigger.

---

## 6. Other chat UI components (`src/components/chat/*` except the three above)

All `dangerouslySetInnerHTML` sinks verified sanitized; JsxPreview/HtmlPreview iframes sandboxed (`allow-scripts` without `allow-same-origin`) with source-size caps; pdfjs documents destroyed in cleanup; object URLs revoked.

38. **[High][Bug] `src/components/chat/BranchDropdown.tsx:69-83` — `fetchAll` has no error handling; a failing git invoke leaves the dropdown stuck on "Loading branches…" forever** plus an unhandled rejection (repo deleted, git binary failure). **Fix:** try/catch that sets error state and always `setLoading(false)`.

39. **[Medium][ErrorHandling] `src/components/chat/GitToolsSidebar.tsx:272-289` — Same unguarded rejection in `poll()`; the +/- counters and branch list go permanently stale.** **Fix:** try/catch inside `poll`.

40. **[Medium][Bug] `src/components/chat/MermaidDiagram.tsx:419-527` — The render effect depends only on `[code]`, so switching the app theme never re-renders mounted diagrams**; they keep the old palette until a virtualized remount (init/cache are keyed on the token signature, but nothing re-triggers on signature change). **Fix:** subscribe to theme changes and add the key to effect deps.

41. **[Medium][Perf] `src/components/chat/DiagramLightbox.tsx:371-373` — DOMPurify runs on every render, and the component re-renders on every pan/zoom pointermove/wheel** — large SVGs re-parsed per mouse move. **Fix:** `useMemo` on `[html, isBareSvg]`.

42. **[Medium][Bug] `src/components/chat/docRunnerFrame.ts:77` — `userCode` interpolated into the `<script>` block without `scriptSafe()`, so a literal `</script` inside the model-authored program breaks the document run.** The helper is applied to `libs` but not the code `DocCodeRunner.tsx:80` passes verbatim. **Fix:** `scriptSafe(userCode)`.

43. **[Medium][Perf] `src/components/chat/GitToolsSidebar.tsx:344-362` — The `plans` memo re-runs regex-heavy `extractPlanSection` over every assistant message on every streaming token flush.** **Fix:** key on `messages.length` + last message id, or extract once per finalized message.

44. **[Medium][Efficiency] `src/components/chat/ArtifactPreviewPane.tsx:790-820` — Every artifact open performs two full `readArtifactPreview` calls:** the mtime poll's first tick flips `fileMtime` null→number, instantly firing the hot-reload effect's re-read while the initial load is in flight — a duplicated multi-MB read + base64 for office/PDF on every open. **Fix:** skip re-read when it's the first baseline.

45. **[Low][ErrorHandling] `src/components/chat/PdfViewer.tsx:205-211` — `pdf.getPage(1).then(...)` in the ResizeObserver path has no `.catch`**; after the document is destroyed the pending promise rejects unhandled. **Fix:** `.catch(() => {})`.

46. **[Low][ErrorHandling] `src/components/chat/PdfViewer.tsx:249-280` — `runSearch` uses try/finally with no catch**; a mid-scan rejection propagates unhandled from `void runSearch()`. **Fix:** catch that clears hits / shows "search failed".

47. **[Low][ErrorHandling] `src/components/chat/ArtifactsMenu.tsx:36-44` — `downloadAll` try/finally without catch; a zip failure rejects unhandled and the menu silently closes.** **Fix:** catch + `toastError`.

48. **[Low][Bug] `src/components/chat/MissingFieldsPrompt.tsx:151-160` — The initial-value lookup can never resolve:** `missingFields` paths carry a `spec.` prefix but the object passed is the spec itself, so `getValueByPath(proposal.spec, "spec.name")` always returns undefined — the prefill effect is dead code. **Fix:** strip the leading `spec.` segment (matching the submit side).

49. **[Low][Bug] `src/components/chat/DocxViewer.tsx:69-103` — `render` has no stale/race guard when `dataUri` changes:** two overlapping `renderAsync` calls interleave into the same container and can mix pages from two documents. **Fix:** epoch/stale guard.

50. **[Low][Perf] `src/components/chat/TurnNavigator.tsx:28-61` — `cleanPreview` runs four regex passes (incl. `/```[\s\S]*?```/g`) over every message's full content on every token flush**, then truncates to 120 chars. **Fix:** slice input before the regexes, or memoize per message id.

---

## 7. Non-chat UI — `App.tsx`, panes, settings, sidebar, automations, cost-dashboard, libraries, palette, onboarding, peek, common

Tauri `listen()` cleanup patterns verified correct; cost math divide-by-zero guarded; iframe feed blocks sandboxed.

51. **[High][Race] `src/components/skills-library/SkillsLibrary.tsx:142-148` — `openItem` has no stale guard: clicking skill A then B quickly lets A's slower `readInstalledSkill` resolve last, so the editor shows A's body while B is selected; a subsequent Save persists A's content under B's slug (data corruption).** Same failure mode PeekPanel already guards against (M26). **Fix:** discard the read when `item.slug` no longer matches `selected`.

52. **[High][ErrorHandling] `src/components/panes/BranchPanel.tsx:68-74` — `fetchLog` awaits `getGitLog` with no try/catch; any rejection is an unhandled rejection and `loading` stays `true` forever — a permanently blank panel.** `error` state exists but is never set. **Fix:** try/catch setting `setError`, `finally` clearing loading.

53. **[Medium][Bug] `src/components/sidebar/Sidebar.tsx:212-248` — The `chatRowData` useMemo reads `cwdOverrides[s.id]` but omits it from the dep array**, so changing a chat's folder notch leaves the row's folder/project labels stale until an unrelated dep changes. **Fix:** add `cwdOverrides` to deps.

54. **[Medium][Race] `src/components/sidebar/ProjectSettingsPanel.tsx:33-37` — Mount effect fetches quick actions and secret keys with neither `.catch` nor a stale guard**; switching projects A→B quickly lets A's slower response overwrite B's list. **Fix:** stale flag + catch.

55. **[Medium][ErrorHandling] `src/components/panes/DevDiffPanel.tsx:670-683` — `getChangedFiles(cwd)` in the `panePaths` effect has no `.catch`**, unlike the main poll effect a few lines above which documents that this call can reject. **Fix:** `.catch(() => {})`.

56. **[Medium][Bug] `src/components/common/Modal.tsx:25` — Shared `Modal` never registers with the webview-occlusion system (M22), and three App-level overlays also don't:** `WorktreeNudgeBanner`, `LocalModelModal`, and the sidebar pairing-QR popover. When a native browser webview is visible, these dialogs render *underneath* the OS-level webview window — clicks intercepted, content invisible. Other modals already register. **Fix:** register via `setModalOpen` (or have `Modal` do it automatically).

57. **[Medium][Perf] `src/App.tsx:140-147` — The split-resize handler writes `setSplitRatio(...)` on every raw `pointermove` (no rAF throttle)**; `App` subscribes to the ratio and `ChatView` isn't memoized, so up to ~1000 Hz re-renders of the entire App tree during drags. **Fix:** store latest X in a ref, apply once per frame.

58. **[Medium][Bug] `src/components/panes/TerminalPane.tsx:539-546` — The "Press R to resume" handler only checks `focusedPaneId === paneId`, not the event target.** Typing any "r" in Settings search / find bar / export dialog while the exited terminal is the focused pane silently restarts the pty. **Fix:** ignore when `e.target` is input/textarea/contenteditable; require the chat view active.

59. **[Medium][Bug] `src/components/onboarding/WorktreeNudgeBanner.tsx:44-48` — `canIsolate` is derived at render but the click handler uses `activeSession!.id` without re-checking**; if the active session changed between render and click, the worktree toggle runs against a project-less chat. **Fix:** guard inside the handler.

60. **[Low][EdgeCase] `App.tsx:148-156`, `panes/ToolPanel.tsx:244-253`, `panes/DevDiffPanel.tsx:383-392` — All three drag-resize handlers remove listeners only on `pointerup`; a `pointercancel` leaves them attached and `resizing` stuck `true`, killing the width transition until the next drag.** **Fix:** also handle `pointercancel` (share `onUp`).

61. **[Low][ErrorHandling] `src/components/settings/MemoryPanel.tsx:129-148` — `refresh` awaits `Promise.all([memoryStatus(), memoryList(true)])` with no try/catch**, invoked `void` on mount; failure = permanent spinner. **Fix:** try/catch with toast.

62. **[Low][ErrorHandling] `src/components/settings/RemotePanel.tsx:37-50` — `refresh` has no catch and runs every 5 s via `setInterval`** — a failing `getMobilePairingInfo` produces a repeating unhandled rejection for as long as the panel is open. **Fix:** catch inside `refresh`.

63. **[Low][ErrorHandling] `src/components/settings/SettingsView.tsx:765-802` — LocalModelsPanel mount IIFE awaits scan/status with no try/catch; a rejected `scanLocalModels()` leaves the panel never reaching `loaded`.** **Fix:** try/catch that still flips `loaded`/`loading`.

64. **[Low][ErrorHandling] `src/components/peek/PeekPanel.tsx:51-72` — All three content fetches use `.then` without `.catch`**; a rejected read leaves the panel stuck on "Loading…" forever. **Fix:** `.catch` setting the fallback text.

65. **[Low][ErrorHandling] `src/components/settings/KnowledgePanel.tsx:137-141` — `refresh` has no catch and `corpora` starts `null`, so a failed load is indistinguishable from an empty library** ("No corpora yet" shown as if nothing happened). **Fix:** `.catch` + error state.

66. **[Low][ErrorHandling] `src/components/sidebar/ProjectItem.tsx:76-80` — In `doCreateWorktree`, `listQuickActions`/`runQuickAction` awaited with no try/catch** even though the create step just above is guarded; a rejection aborts post-creation setup silently. **Fix:** try/catch with toast.

67. **[Low][ErrorHandling] `src/components/settings/SettingsView.tsx:2011-2025`, `:2176-2185` — `refreshSavedProviders` and `handleClear` await IPC with no catch**; failures leave `savedProviders`/form state half-updated. **Fix:** try/catch + toast.

68. **[Low][ErrorHandling] `src/components/automations/AutomationsView.tsx:684-691` — `handleOpenRunLog` awaits `selectSession` with no catch**, though sidebar and palette both explicitly catch this same call (it can reject on DB lock). **Fix:** `.catch` + toast, switch view only on success.

69. **[Low][Bug] `src/components/settings/ThemeGalleryPanel.tsx:120-122` — "View tokens.css" opens a placeholder URL that 404s** (`https://github.com/your-repo/blob/main/src/styles/tokens.css`). **Fix:** real repository URL.

70. **[Low][Perf] `src/components/documents-library/DocumentsLibrary.tsx:239-294` — Full-page grid renders every artifact with no virtualization**, and each card fires its own `readArtifactPreview` IPC; the sidebar's modal twin was virtualized for exactly this reason (F5/mi27) but this page wasn't. **Fix:** reuse the row-chunked `useVirtualizer` pattern.

71. **[Low][Perf] `src/components/sidebar/ArtifactLibrary.tsx:378-385` — `onRemove={(id) => void remove(id)}` creates a new closure every render, defeating the `ArtifactCardMemo` memoization the file deliberately set up.** **Fix:** `useCallback`.

---

## 8. DB / memory / commands (Rust)

SQL injection: **none found** (string-formatted queries interpolate only constant column lists). Secrets: stored in the **OS keychain** on all shipped platforms (the XOR-in-SQLite fallback is dead `cfg` code — but see finding 78). WAL/busy handling correct (`db/mod.rs:172-181`); multi-statement mutations properly transactional.

72. **[High][Security] `src-tauri/src/commands/local_model_market.rs:916-927`, `:1157-1164` — HF bearer token attached to any frontend-supplied URL.** `start_model_download` takes `download_url` straight from IPC and `run_download` unconditionally attaches the user's Hugging Face token; nothing validates the host. Any script execution in the main webview can exfiltrate the HF token via an attacker URL. The sibling `download_mmproj`/`fetch_model_file_sizes` paths are safe (URL rebuilt around `huggingface.co`), showing the gap is specific to this entry point. **Fix:** require `https` + host `huggingface.co` before attaching the token (better: derive the URL server-side from `repo_id`+`filename`).

73. **[Medium][Perf] `src-tauri/src/db/cost_v2.rs:141-163` — Rollup cache can never hit because the freshness marker is nondeterministic.** `rollup_freshness_marker` hashes with `RandomState::new()`, which uses fresh random SipHash keys per call, so the marker differs every invocation and the entire mi26 optimization is dead — every dashboard poll recomputes the full aggregation. **Fix:** use `DefaultHasher::new()` or fold sorted key/value bits into the marker string.

74. **[Medium][Bug] `src-tauri/src/commands/budget.rs:189-196` + `db/cost_v2.rs:194,262-271,405` — Budget alerts and per-project rollups ignore all in-app chat spend.** `per_project` is populated only in the `cost_events` loop; the `chat_messages` loop never touches it, so a project whose spend is entirely in-app chat always reads `spent = 0.0` and the alert never fires — contradicting the budget module's own doc. **Fix:** accumulate `by_project` in the chat loop too (via `chat_session_id → project_id`).

75. **[Medium][EdgeCase] `src-tauri/src/memory/worker.rs:987-998` (with `:327-340`) — Missing base URL silently commits the extraction cursor, permanently skipping messages.** For `openai_compatible`/`local_gguf`, `oneshot` returns `Ok(String::new())` when no base URL is configured; `extract_session` treats empty as "nothing memorable" and commits the cursor — every message permanently marked extracted with zero memories, silently. Real LLM errors correctly abort before the cursor moves. **Fix:** return `Err` so `?` aborts before the cursor advances.

76. **[Medium][Security] `src-tauri/src/commands/stt.rs:628-633`, `:690-712`, `:743-766` — One-click STT install downloads and executes a binary with no checksum or signature verification** (pinned tag + TLS only, unlike the app updater which verifies against a baked-in public key). Secondary: temp zip uses a fixed predictable name in the shared temp dir and is deleted only on success. **Fix:** pin + verify a SHA-256 before extraction; clean the temp zip on all paths.

77. **[Low][Bug] `src-tauri/src/db/source_ledger.rs:46-63` — Insert-detection compares `changes()` across different statements** (`conn.changes() > changes_before` compares against the *previous statement's* count, not a before/after delta). Currently harmless only because the else-branch re-queries the row. **Fix:** `conn.changes() > 0` alone is sufficient.

78. **[Low][Docs] `src-tauri/src/secrets.rs:15-17` + `Cargo.toml:151-152` — Stale docs claim Linux uses XOR-in-SQLite storage; the code actually uses the Secret Service everywhere.** **Fix:** update the comments.

79. **[Low][Perf] `src-tauri/src/db/artifacts.rs:41-46`, `:126-137` — `artifacts.path` has no index;** the dedupe-upsert `UPDATE … WHERE path = ?1` full-scans per insert and `list_artifacts`'s `NOT EXISTS` anti-join is O(n²) over the gallery view. **Fix:** `CREATE INDEX … ON artifacts(path)`.

80. **[Low][Leak] `src-tauri/src/commands/local_model_market.rs:136-174` — Catalog cache grows without bound** (keyed by raw query string, never evicted; every distinct search adds up to ~200 entries for the process lifetime). **Fix:** cap/LRU.

81. **[Low][Leak] `src-tauri/src/commands/speech.rs:176-205` — Cancel slot leaked on the error path:** if the HTTP send errors, the `?` propagates without `unregister_cancel_slot(tag)`, leaking a `Notify` Arc per failed tagged transcription. **Fix:** unregister before `?` or use a drop guard.

---

## 9. Harness / ACP / browser / connectors / PTY (Rust)

M12 prompt-transport, OAuth (PKCE + state + fixed-port loopback + single-flight refresh + no token logging), browser URL allowlist and nonce-gated actions, PTY char-safety, and waiter-thread ownership all verified correct. Residual findings:

82. **[Medium][Bug] `src-tauri/src/harness_config.rs:550-565` — On poll-timeout, `capture_cli_stdout` kills only the direct child then joins the drain thread unconditionally.** On Windows the spawn is `cmd.exe /C`, so `child.kill()` terminates only cmd.exe; the real CLI grandchild survives holding the stdout pipe, `read_to_string` never sees EOF, and `drain.join()` blocks the command thread **forever** — model listing in Settings hangs indefinitely, each retry leaking another process+thread. **Fix:** kill the whole process tree (`taskkill /T /F` semantics) before joining, or bounded non-blocking drain.

83. **[Medium][Security] `src-tauri/src/harness_adapters/mod.rs:552-562` — When `ensure_turn_wrappers()` fails (temp dir unwritable/disk full), `turn_spec` falls through to the legacy argv spec, which puts the untrusted prompt back on the `cmd.exe /C` command line on Windows** — the exact M12 injection the module otherwise treats as unacceptable; a hostile prompt containing `&`, `%VAR%`, `|` can execute. It silently degrades to RCE instead of failing the turn. **Fix:** return the oversized-prompt error (or use the Stdin transport) instead of argv fallback.

84. **[Medium][Bug] `src-tauri/src/agent_sessions.rs:3792` (also `:4318`) — `read_per_turn_stream` and the opencode turn thread clear `turn_in_flight` with an unconditional `store(false)` at thread end, no process-generation gate.** Cancel + immediate re-send lets the old turn's tail clobber the new turn's flag: the new turn runs unprotected, a second concurrent send spawns a second child for the same chat, and two `finish_turn` calls persist two assistant rows from interleaved streams. The claude/ACP readers already guard this with `should_clear_in_flight`. **Fix:** capture a generation and gate the clear.

85. **[Medium][PanicRisk] `src-tauri/src/agent_sessions.rs:6487-6489` — `truncate_output` byte-slices `&out[start..]` at an arbitrary byte offset; a multibyte character straddling the boundary panics.** This runs on the opencode turn thread, where the panic unwinds past the `in_flight`/perf cleanup tail — the chat wedges with `turn_in_flight` stuck true until cancel. The same file documents fixing this exact class elsewhere. **Fix:** use `util::truncate_chars` or snap to a char boundary.

86. **[Medium][Bug] `src-tauri/src/agent_sessions.rs:6015-6026` — In `harness_oneshot_blocking`, a failed stdin prompt write returns early via `?` without killing the child.** Dropping `Child` doesn't terminate it; on Windows the full-auto (`--dangerously-skip-permissions`) CLI grandchild can keep running. Sibling paths (`run_one_shot`, `spawn_per_turn`) call `kill_child_tree` on write failure per the E-7 contract. **Fix:** same here.

87. **[Medium][EdgeCase] `src-tauri/src/agent_sessions.rs:4595-4681` (liveness `:4144-4148`) — The opencode SSE reader exits permanently on any stream error (`Err(_) => break`) with no reconnect and no liveness flag.** `send_opencode_turn` only probes TCP liveness, which can't see a dead reader; if SSE drops while the server stays up, replies persist **empty** with no error. The claude/acp paths have `ReaderAliveGuard` for this class. **Fix:** add a reader-alive guard + respawn.

88. **[Low][EdgeCase] `src-tauri/src/connectors/config.rs:471`, `:602` — `YOUTUBE_CALLBACK_PORT` and `CANVA_CALLBACK_PORT` are both `45134`.** Canva is currently disabled, but re-enabling it (documented as a one-line append) makes the two flows fight over the fixed loopback port. **Fix:** assign a distinct port before re-enabling.

89. **[Low][Efficiency] `src-tauri/src/pty/mod.rs:980-993` — The reader sleeps 3 ms then flushes unconditionally, so every non-empty read produces its own frame;** the documented 16 ms coalescing budget is never realized — roughly one IPC frame per read during heavy TUI output. **Fix:** flush only when the budget elapsed.

90. **[Low][Leak] `src-tauri/src/agent_sessions.rs:4629-4637` — The opencode SSE reader's `tool_states`/`roles`/`part_kinds` HashMaps grow monotonically** with per-message/per-part ids, never pruned across a long-lived server. **Fix:** prune finished entries or cap with FIFO eviction.

91. **[Low][EdgeCase] `src-tauri/src/harness_adapters/mod.rs:699-717` — `installed_cli_version` has the same grandchild-pipe hang class** as finding 82: after killing only the direct child it does blocking `read_to_string` on pipes the surviving grandchild holds (update-checker path; cached 1 h but wedges that thread). **Fix:** tree-kill or bounded drain.

92. **[Low][Efficiency] `src-tauri/src/agent_sessions.rs:4447-4461` — `opencode_wait_ready` busy-polls with `std::thread::sleep` for up to 20 s inside an async command,** blocking a tokio worker for the full wait during server boot. **Fix:** `spawn_blocking` or async probe.

---

## 10. Build config & security config (direct review)

93. **[Medium][Config] `src-tauri/tauri.conf.json` (security.csp) — CSP weaknesses in the main window:**
    - `script-src 'self' https://cdnjs.cloudflare.com` — allows executing any script served from cdnjs. If any HTML render path (or an injected XSS) can create a `<script src="https://cdnjs.cloudflare.com/…">`, CSP won't stop it; cdnjs in `script-src` effectively whitelists a large third-party code surface.
    - `connect-src https:` — the webview may talk to **any** HTTPS host (understandable for user-configured providers, but it also means exfiltration of anything in the page is never CSP-blocked).
    - `img-src … https:` — same class, image-channel exfiltration allowed.
    **Fix:** drop cdnjs from `script-src` (bundle those libs); consider a proxy or explicit host list for `connect-src` if feasible.

94. **[Low][Config] `src-tauri/tauri.conf.json` (main window `additionalBrowserArgs`) — `--disable-features=…msSmartScreenProtection` disables WebView2 SmartScreen** (phishing/malware filtering) for the embedded browser panes, alongside occlusion/backgrounding flags that are legitimate for a multi-pane browser shell. **Fix:** document the tradeoff explicitly, or gate SmartScreen disabling to panes that need it.

95. **[Low][Config] `src-tauri/capabilities/default.json` — The capability set applies to `browser-*` and `oauth-*` windows too**, granting `fs:allow-read-text-file`, `dialog`, `opener:allow-open-path`, and `updater:default` to windows that load remote web content. Tauri v2 blocks IPC from remote origins unless a capability opts in via `remote`, so this is not currently exploitable — but it's a one-config-mistake footgun (any future `"remote": true`/`remote.url` addition hands visited pages the updater + fs read). **Fix:** split capabilities so `browser-*`/`oauth-*` windows get the minimum (`core:event` only), and add a comment stating the remote-IPC invariant.

96. **[Low][Config] `src/tsconfig.json` — `"noUnusedLocals": false, "noUnusedParameters": false`** while `strict: true` — disabled strictness hides dead code like the Rust warnings already surfaced. Minor. **Fix:** enable both and clean up.

97. **[Verified clean]** Updater signing: private key at `.tauri/relay-update.key` is **correctly gitignored** and never committed; `latest.json` endpoint uses the official GitHub releases URL with a baked-in minisign public key. `scripts/make-latest-json.mjs` validates bundle dir/key presence and exits non-zero on missing inputs. `vite.config.ts` chunking decisions are documented with measured rationale (entry 1,179 KB → ~460 KB). `git_watcher.rs` debouncer (300 ms/2 s cap, heartbeat, dual-key uninstall) is correct.

---

## 11. Repo hygiene

98. **[Low][Hygiene]** A 0-byte file named **`nul`** exists in the repo root — a Windows reserved device name that breaks some tooling (git clean/checkout on Windows, npm packs, some archivers). **Fix:** delete it (`rm '\\.\D:\projects\Ultimate-workspace\nul'` or from WSL/PowerShell `Remove-Item \\?\D:\projects\Ultimate-workspace\nul`).

99. **[Low][Hygiene]** `tauri_dev.log` (5.4 MB) sits in the repo root; root `.gitignore` covers `*.log` so it's not committed, but it bloats the workspace and IDE search. Also ~20 screenshots/PNGs and research markdown files at the root are untracked clutter — consider a `docs/` or `.local/` convention.

100. **[Low][Hygiene]** `Cargo.toml`/`secrets.rs` doc drift (finding 78) and the `automation_task.rs` `get_run_while_closed` semantics ("any schtasks error = not registered" — service-down reads as off; self-heals on toggle) are documented behaviors worth a comment each. Also `src/App.tsx:111-112` computes `focusedSessionId` that is never used (dead code), and `UpdateBanner` is exported but rendered nowhere.

---

## Areas verified clean (negative results, for future auditors)

- **SQL injection:** none anywhere (constant column lists only; all user data via `params!`).
- **Secrets at rest:** OS keychain on Windows/macOS/Linux; OAuth tokens never logged; PKCE + state + single-flight refresh in `connectors/oauth.rs`.
- **XSS in markdown rendering:** `react-markdown` without `rehype-raw`, default URL transform, all `dangerouslySetInnerHTML` sinks sanitized (the one gap is the SVG `<style>` pass-through, finding 13/21).
- **Sandboxed previews:** HTML/JSX/doc-runner iframes use `allow-scripts` without `allow-same-origin` + source-size caps.
- **Race guards:** chat store streaming/ownership guards, PeekPanel M26, pane-generation gates in claude/ACP harness readers, checkpoint baseline double-insert re-check (D3) — all correct.
- **Resource cleanup:** Tauri `listen()` unlistens, pdfjs destroy, object-URL revocation, interval/observer cleanup verified across the component tree (the exceptions are listed above).
- **Permissions model:** lexical + filesystem-resolved granted-roots with segment boundaries and `..` resolution (finding-free).
- **WAL/transactions:** configured and used correctly; multi-statement mutations transactional with tests.
- **Tests:** 847 frontend tests pass; substantial Rust unit/integration test coverage in checkpoints, codeexec, citation_lint, pygen, compaction, db modules.

## Suggested fix order

1. **Security:** #72 (HF token), #83 (argv fallback), #11 (artifact IPC path containment), #13 (SVG `<style>`), #93 (CSP cdnjs), #76 (STT checksum).
2. **User-facing hangs/wedges:** #82 (grandchild-pipe hang), #85 (panic wedging turn), #1 (uncancellable subagent), #84 (in-flight clobber), #86.
3. **Data correctness:** #51 (skill save corruption), #16 (split-pane stop), #74 (budget alerts), #73 (dead rollup cache), #22 (doc kpi crash), #75 (skipped memory extraction).
4. **Everything else** by area, lowest effort first (#69, #98, #78, #96 are one-liners).

---

## Fix log (2026-09-09)

Each fix was verified with the targeted test suite for its module, then the full suites: `cargo test --lib` **1011 passed / 0 failed**, `vitest run` **136 files / 857 tests passed**, `tsc --noEmit` clean, and a warning-set diff against the pre-fix baseline confirmed **zero new compiler warnings**.

| # | Fix | Tests added |
|---|---|---|
| **#72** | `local_model_market.rs` — new `token_allowed_for_url()` gate: the HF bearer token is attached only when the (frontend-supplied) URL is `https` + host `huggingface.co`/`*.huggingface.co`. Applied at the `run_download` choke point and `build_hf_request`. | `token_allowed_for_url_gates_by_host` (allow/deny matrix incl. lookalike hosts, http, garbage) |
| **#83** | `harness_adapters/mod.rs` — Windows `turn_spec` split into testable `turn_spec_windows(...)`; wrapper-write failure now **fails the turn** with a diagnosis instead of falling back to argv-prompt spawning (M12 injection exposure). Unix argv path unchanged (safe pre-execve). | `turn_spec_wrapper_unavailable_fails_instead_of_argv_prompt` |
| **#11** | `chat/commands.rs` — new `preview_scope_roots()` (artifacts dir + registered projects + chat worktrees + `permissions.grantedRoots` + remembered working folder) and `path_in_preview_scope()` gate on all six artifact IPC endpoints (`read_artifact_preview`, `get_file_mtime`, `find_file_by_basename`, `open_artifact_external`, `download_artifact`, `download_artifacts_zip`). `get_file_mtime` core extracted as `get_file_mtime_gated` for testability; pre-existing test updated to it. | `artifact_scope_gate_blocks_outside_paths` (in-root allow; sibling-root, `..` traversal, system path, empty-roots deny) + updated mtime test |
| **#13** | `sanitize.ts` — `sanitizeSvg` (the main-document sink) post-processes `<style>` blocks and `style=""` attributes: `@import`/`@charset` removed, non-fragment `url(` → invalid `refused-url(`, `position:` → `refused-position:`, `behavior`/`-moz-binding` mangled. Fragment refs (`url(#arrow)`) and benign themeCSS survive; the iframe sink (`sanitizeHtml`) is untouched so HTML previews keep full layout. | 4 new `sanitizeSvg.test.ts` cases (neutralize/keep-fragments/inline-attrs/benign-themeCSS) |
| **#76** | `stt.rs` — pinned `WHISPER_ZIP_SHA256` (computed from the tagged release zip); `sha256_file_hex()` (chunked) verifies **before extraction**; temp zip now deleted on verify-failure and mid-stream failure paths too. | `sha256_file_hex_matches_known_vector_and_rejects_missing` (empty-vector + multi-chunk equivalence + missing-file) and `pinned_whisper_zip_hash_is_well_formed` |
| **#82** | `harness_config.rs` — `capture_cli_stdout` drains into a shared byte buffer with an EOF signal; new `terminate_capture()` does a **tree kill** (reuses `agent_sessions::kill_child_tree`, now `pub(crate)`) then a **bounded (3 s) EOF wait** returning partial output — no more permanent wedge when a `cmd.exe` grandchild (or an orphan after child exit) holds the pipe. Same tree-kill applied to `installed_cli_version` (#91). | `capture_cli_stdout_recovers_when_grandchild_holds_the_pipe` (real `start /b ping` grandchild; output survives, returns in seconds not 30 s) + `capture_cli_stdout_timeout_path_returns_without_hanging` |
| **#85** | `agent_sessions.rs` — `truncate_output` tail-cap now uses char-safe `util::tail_chars` instead of byte-slicing (`&out[start..]` panicked on multibyte straddles, unwinding past the turn thread's cleanup). | `truncate_output_never_panics_on_multibyte_tail_boundary` (CJK/emoji straddles + line-cap path) |
| **#1** | `chat/mod.rs` + `dispatch.rs` — `ChatManager.child_tasks` registry: `spawn_run_tool` registers the subagent's `AbortHandle` (a reaper task unregisters by task id on completion); `cancel()`/`cancel_all()` abort all live children, and `send`'s superseding cancel inherits it. | `cancel_aborts_registered_subagent_children`, `child_unregister_removes_only_its_own_id` |
| **#51** | `SkillsLibrary.tsx` — `openItem` guarded by an open-request token ref: a slower earlier read no longer overwrites the editor for a newer selection (stale-save corruption). | token-ref pattern (M26-style); covered by full suite, no targeted harness |
| **#16** | `state/chat.ts` — `cancelStream` refetch now mirrors `onDone`'s split-target write-back: Stop in the split pane lands the persisted partial in `splitMessages` instead of leaving the bubble gone. | store-level; covered by full suite |
| **#74** | `db/cost_v2.rs` — the `chat_messages` rollup loop now selects `cs.project_id` and accumulates `by_project`, so budget alerts see in-app chat spend. | `chat_spend_counts_toward_per_project` |
| **#73** | `db/cost_v2.rs` — freshness marker hashed with deterministic `DefaultHasher` (was `RandomState::new()`, which made the marker unique per call and the cache dead). Test-isolation helpers added (`reset_rollup_cache_for_tests`, serialized `rollups_for_tests`) since the now-working global cache cross-served parallel test fixtures. | `freshness_marker_is_deterministic` |
| **#22** | `docdesign/irDoc.ts` — kpi-strip entries validated per-KPI (label/value presence, delta/trend types) with numeric `value` coercion instead of a bare cast that crashed the PDF compiler and emitted `undefined` docx runs. | `validates kpi-strip entries instead of blindly casting` in `docdesignDoc.test.ts` |
| **#75** | `memory/worker.rs` — missing base URL for `openai_compatible`/`local_gguf`/`anthropic_compatible` returns `Err` (aborting before the extraction cursor commits) instead of a fake-success empty string that permanently skipped messages. | verified the `?` abort contract at the `extract_session` call site; 61 memory tests green |
| **#69** | `ThemeGalleryPanel.tsx` — "View tokens.css" now opens the real `Sabbir505/Ultimate-workspace` blob URL. | — |
| **#78** | `secrets.rs` + `Cargo.toml` — stale "Linux uses XOR storage" docs corrected (Linux ships the keyring Secret Service backend; XOR is dead cfg code). | — |
| **#98** | Deleted the reserved-name `nul` file from the repo root. | — |

**Remaining from the fix order:** #93 (CSP cdnjs/`connect-src https:` — needs a bundle decision for the cdnjs scripts), #84/#86 (harness in-flight generation gates), and the rest of the Low findings by area.

---

## Fix log — second wave (2026-09-10): all remaining actionable findings

| # | Fix | Tests |
|---|---|---|
| **§1 Rust chat core A** |||
| #2 | `turn_perf::unregister` now also runs in `ChatManager::cancel` (and `delete_chat_session`, which routes through cancel) — an aborted turn no longer leaks its 500 ms `chat:perf` heartbeat for the process lifetime. | full suite |
| #3 | `search_docs` (dispatch.rs) moved to `spawn_blocking`: the brute-force cosine scan no longer runs under the global DB mutex on the async runtime. | full suite |
| #4 | `checkpoints::restore` now takes the shared `Arc<Mutex<Connection>>` and scopes the lock to the DB phases — the seconds-long pre-restore `git add -A` snapshot and the tree checkout run unlocked. | full suite |
| #5 | `delete_all_chat_sessions` split into 4 phases: harness/stream cleanup → DB reads + settings (lock) → git ref-pruning + worktree removal (NO lock) → pointer clears + row deletes (lock). New `checkpoints::collect_session_ref_groups` / `prune_ref_groups` split the DB and git halves. | full suite |
| #6 | `clear_late_attach` now runs in `cancel()` — live connector MCP sessions no longer stay parked in the map after cancel/delete. | full suite |
| #7 | Subagent OAI tool-call loop (dispatch.rs) clamps wire indices with the (now `pub(crate)`) `MAX_STREAM_BLOCK_INDEX`, matching the main rounds. | full suite |
| #8 | `anthropic_stream_round` tolerates `data:` without a trailing space — non-conformant endpoints no longer "succeed" with an empty message. | full suite |
| #9 | Both cache-rejection retry guards (`openai_stream_round` + `anthropic_stream_round`) additionally require `full.len()` unchanged — a mid-stream error merely *mentioning* "cache_control" can no longer re-run the round and duplicate streamed text. | full suite |
| #10 | `count_context_tokens` (cloud branch): the memoization fingerprint is now built from CHEAP inputs (harness flag, provider, model, custom system prompt, attached connector/MCP ids, last message id, count) and checked BEFORE the expensive `attach_availability` + `build_system_prompt` (~55k chars, skills-dir scan). The constant ~42k tool-spec JSON is built once (`OnceLock`). | full suite |
| **§2 chat core B / misc** |||
| #14 | `pdfprint.rs` — all 12 WebView2 print-settings Results are checked; a failed setter now errors instead of silently printing with default page size/margins. | compile |
| #15 | `browser.rs` `open_devtools` surfaces the `OpenDevToolsWindow` HRESULT as an error string. | compile |
| #77 | `db/source_ledger.rs` — insert detection is `conn.changes() > 0` (the old cross-statement comparison removed, with comment). | full suite |
| #79 | `CREATE INDEX idx_artifacts_path` — kills the per-insert full scan and the O(n²) gallery anti-join. | full suite |
| #80 | Model-market catalog cache capped at 32 entries (clear-on-full), instead of growing with every distinct search forever. | full suite |
| #81 | `speech.rs` — a failed tagged transcription now unregisters its cancel slot before erroring (no more leaked `Notify` Arc per failure). | full suite |
| #88 | `CANVA_CALLBACK_PORT` 45134 → **45135** (+ redirect_uri), ending the collision with YouTube's fixed loopback port. | full suite |
| #89 | PTY reader now holds the frame in 3 ms slices until the 16 ms `FRAME_BUDGET` elapses and only then flushes — the documented coalescing actually happens (was: one IPC frame per read). | full suite |
| #90 | `handle_opencode_sse_data` caps the three per-connection stream-state maps (8192 entries), bounding the long-lived SSE reader's memory growth. | full suite |
| **§9 agent_sessions** |||
| #84 | E-5 generation gates extended: `spawn_per_turn` bumps `proc_generation` per send and threads it into `read_per_turn_stream` (gated clear); `send_opencode_turn` does the same for its turn thread's two clears. A cancelled-and-superseded turn's tail can no longer clobber the new turn's `turn_in_flight`. | 61 agent_sessions tests |
| #86 | `harness_oneshot_blocking` kills the whole process tree on a failed stdin prompt write (E-7 contract, matching the sibling paths). | 61 agent_sessions tests |
| #87 | New `oc_reader_alive` flag on the session entry: `spawn_opencode_server` sets it, the reader clears it on every exit, and the turn thread — on a "successful" POST with an empty buffer and a dead reader — emits an actionable `chat:error` instead of silently persisting an empty reply. | 61 agent_sessions tests |
| **§5/§6 Chat UI (ChatComposer/ChatView/MessageBubble + chat components)** |||
| #27 | Alt push-to-talk handlers only act when this composer's session is the FOCUSED chat — split view no longer starts two recordings and splices text into both panes. | tsc + suites |
| #28 | MessageBubble memo comparator now compares `onRepeat` presence — stale Regenerate buttons gone. | suites |
| #29 | `chatScroll`/`chatSelection` bridges rewritten as session-keyed registries with owner-scoped cleanup; TurnNavigator and the selection toolbar dispatch to the focused session. Closing the split pane can no longer disable jump-to-message or selection-"Ask". | suites |
| #30 | IME guard (`isComposing` / keyCode 229) on both composer Enter paths and the queued-message edit textarea. | tsc + suites |
| #31 | `.catch` handlers on all voided IPC chains in ChatView + ChatComposer (skills/templates/connector lists, local-model scan/status, empty-session sweep). | tsc + suites |
| #32 | `/compact` regex: the committed source actually contained a raw **backspace byte** (`/^\/compact<0x08>/` — matched a literal backspace, so the command never fired). Replaced with the intended `\b` word boundary, which fixes both the dead command and the audit's prefix-over-match concern. | tsc + suites |
| #33 | Template insertion uses `setSelectionRange(next.length, next.length)` — caret no longer silently clamps to the start. | tsc + suites |
| #34 | Block-vs-inline code decided by a `pre`-context provider, not newline sniffing — single-line fenced blocks get code chrome. | suites |
| #35 | Markdown element cache key includes `chatSessionId` — mermaid "Fix with AI" can't route to the wrong session in split view. | suites |
| #36 | Approval/question-card anchor restore consumes a scroll-ref maintained by `handleScroll` (pre-mutation position) instead of reading post-commit layout — the restore actually restores. | suites |
| #37 | `scanLocalModels` no longer re-runs on every session switch; it runs on mount and when a local-model load settles. | tsc + suites |
| #38–#50 | BranchDropdown/GitToolsSidebar error handling; Mermaid theme-change re-render (MutationObserver on `data-theme`); DiagramLightbox sanitize memoized per HTML; `docRunnerFrame` `scriptSafe(userCode)`; plans memo keyed on length+last-id; ArtifactPreviewPane hot-reload baseline skip; PdfViewer/ArtifactsMenu catches; MissingFieldsPrompt `spec.` prefix strip; DocxViewer render epoch; TurnNavigator bounded preview input. | 58 chat-component tests |
| **§3/§4 State + lib** |||
| #17 | `deleteMessage` rollback refetch re-derives active/split after the await — no cross-chat buffer clobber. | 43 state tests |
| #18 | Both `sendMessage` catch blocks gate `error`/`errorCode` on the active session (mirrors `onError`). | 43 state tests |
| #19 | `onArtifact` library reload debounced (trailing 1.5 s) — N artifacts → one reload. | 43 state tests |
| #20 | `browserTrust.clearPane(paneId)` action called from `disposePaneResources` — per-pane trust timelines no longer accumulate forever. | browserTrust/panes tests |
| #23 | `releaseNotes` emphasis-strip uses the planParser word-boundary pattern — snake_case words no longer fuse. | releaseNotes coverage |
| #24 | Syntax-theme cache key includes the active custom-theme id — switching same-base custom themes rebuilds styles. | useSyntaxTheme coverage |
| #25 | Citation title truncation via `sliceCodePoints` — no more split surrogate pairs. | safeSlice/sessionTitle tests |
| #26 | docdesign L2 invariant checks run on a content-blanked skeleton view (color-slot literals preserved) — prose containing `#abcdef`/`@import` no longer produces false QA errors while real violations still fire. | docdesign + compile suites |
| **§7 Non-chat UI** |||
| #52 | BranchPanel `fetchLog` try/catch (dead `error` state revived, spinner always settles). | 18 UI tests |
| #53 | `Sidebar` `chatRowData` dep array includes `cwdOverrides`. | suites |
| #54 | ProjectSettingsPanel stale-guard + catch on both fetches. | suites |
| #55 | DevDiffPanel `panePaths` effect catches. | suites |
| #56 | Shared `Modal` auto-registers webview occlusion (`useId`); sidebar pairing-QR popover registered too — modals no longer render under native browser webviews. | modalOpen + browserOcclusion tests |
| #57 | Split-resize commits at most once per rAF (was: store write per pointermove re-rendering the whole app tree). | suites |
| #58 | Terminal "R to resume" ignores keystrokes targeting inputs and requires the chat view. | suites |
| #59 | WorktreeNudgeBanner re-checks `projectId` inside the click handler. | suites |
| #60 | `pointercancel` handled by ToolPanel/DevDiffPanel/App resize drags (App already had it). | suites |
| #61–#68 | Catch/toast handlers for MemoryPanel, RemotePanel (5 s poll), SettingsView LocalModelsPanel + provider refresh/clear, PeekPanel, KnowledgePanel (load-error state), ProjectItem quick actions, AutomationsView run-log open. | suites |
| #70 | DocumentsLibrary virtualized with the ArtifactLibrary row-chunk `useVirtualizer` pattern. | suites |
| #71 | `ArtifactLibrary` `onRemove` stabilized via `useCallback`, restoring card memoization. | suites |
| #11 | (first wave) artifact IPC path containment. | scope-gate tests |
| **§11 Hygiene** |||
| #99 | `tauri_dev.log` (5.4 MB) deleted from the workspace root. | — |
| #100 | Dead `focusedSessionId` computation removed from App.tsx (with its now-orphaned store subscription). | tsc |
| **Deliberately not code-changed** |||
| #93 | CSP `cdnjs` entries are a **test-guarded product decision**: `src/test/csp.test.ts` explicitly documents and asserts that interactive single-file artifacts (the Claude-artifact model) load scripts/styles/fonts from cdnjs — srcdoc iframes inherit the main-window CSP, so removing it would break the artifact preview feature. `connect-src https:` likewise serves live previews and user-configured providers. Tradeoff documented; not a bug. | csp.test.ts (green) |
| #94 | `msSmartScreenProtection` disabled in `additionalBrowserArgs` is part of the multi-pane native-webview browser design (the same args line carries the occlusion/backgrounding flags the panes need). Accepted tradeoff, documented here. | — |
| #95 | Capabilities granted to `browser-*`/`oauth-*` windows are **inert for remote content** (Tauri v2 blocks IPC from remote origins unless a capability opts in via `remote`). Splitting them is defense-in-depth against a future config mistake but risks breaking pane functionality that can't be runtime-tested here; left with this documented rationale. | — |
| #96 | Attempted: enabling `noUnusedLocals`/`noUnusedParameters` surfaces **124 pre-existing dead-symbol errors**. Mass-deleting them immediately after this fix wave, without runtime testing, contradicts the no-regressions requirement — deferred as a tracked standalone cleanup. tsconfig left unchanged. | baseline tsc green |

**Final verification (2026-09-10):** `cargo test --lib` **1011 passed / 0 failed** · `vitest run` **136 files / 857 tests passed** (twice; one transient parallel-load flake did not reproduce) · `tsc --noEmit` clean · cargo warnings **71 → 62** with zero new warnings introduced by any fix.
