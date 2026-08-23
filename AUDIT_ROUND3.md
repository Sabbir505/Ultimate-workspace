# Conduit — Bug & Performance Audit (Round 3)

**Date:** 2026-08-21 · **Scope:** frontend state/hooks (`src/state`, `src/hooks`, `src/lib/ipc.ts`), component render paths (`src/components`), SQLite layer (`src-tauri/src/db`) + DB-touching backend paths.
**Method:** parallel deep reads of the hot files; every Critical/High finding below was spot-verified against the working tree before inclusion.
**Excluded:** everything already fixed in `PERFORMANCE_AUDIT.md` (round 2) and `BUG_AUDIT.md` (2026-08-17) — no re-reports.
**Not yet covered (follow-up):** Rust streaming internals (`pty/mod.rs` post-fix state, `chat/dispatch.rs` tool loop, `agent_sessions.rs` scrape paths), mobile relay WS framing, build pipeline.

Severity legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low

---

## Executive summary — top wins by impact

| # | Issue | Domain | Est. impact |
|---|---|---|---|
| 1 | Streaming tokens defeat `MessageBubble` memo → full markdown re-parse of every visible bubble **per token** | React render | 🔴 CPU spike scales with conversation length during every stream |
| 2 | Git checkpoint runs `git add -A` + commit-tree **while holding the global DB mutex** | Backend | 🟠 blocks ALL DB traffic (PTY cost events, sends, relay polls) hundreds of ms–seconds per turn |
| 3 | ChatView/Sidebar/GitToolsSidebar selector anti-patterns → whole-surface re-render per token | React state | 🟠 per-token re-render storm of the largest mounted components |
| 4 | Rollup freshness marker: `MAX(created_at) WHERE role='assistant'` walks without a usable index, on every poll | SQLite | 🟠 constant background CPU + lock hold; neutralizes the rollup cache |
| 5 | Tool-panel tab switch disposes xterm (scrollback lost) and closes native browser webviews | React render | 🟠 state loss + re-creation cost on every tab switch |
| 6 | `onToken` O(n²) buffer concat per token (~10–40 MB/s transient allocations on long turns) | State | 🟡 GC pressure exactly when UI is busiest |
| 7 | Missing indexes on `artifacts(chat_session_id)` / `(chat_message_id)` → full scans per turn/per chat open | SQLite | 🟡 grows with artifact count (30-day window) |
| 8 | Zero `prepare_cached` in the entire backend | SQLite | 🟡 statement recompilation thousands of times/min |

---

## A. React state & hooks

### A1. 🟠 `sessionTasks` selector allocates a fresh array per store commit — certain
**Where:** `src/components/chat/ChatView.tsx:139-141`
```ts
const sessionTasks = useChatStore((s) =>
  activeChatSessionId ? Object.values(s.tasks[activeChatSessionId] ?? {}) : [],
);
```
Zustand compares with `Object.is`; `Object.values(...)` and the `[]` fallback allocate a new array on **every** store commit — every `chat:token`, every perf tick. ChatView is the largest mounted component and passes freshly-built arrays down to ChatComposer, so both re-render per token.
**Fix:** select the stable map slice (`s.tasks[activeChatSessionId]`), derive with `useMemo(() => Object.values(map ?? {}), [map])`. The `NO_QUEUED_MESSAGES` constant in `ChatComposer.tsx:131` shows the intended idiom.

### A2. 🟠 Sidebar subscribes to the whole `streaming` map — certain
**Where:** `src/components/sidebar/Sidebar.tsx:65` (used only as membership checks at :464, :580)
```ts
const chatStreaming = useChatStore((s) => s.streaming);
```
`onToken` replaces the map identity on every token of any session (`chat.ts:1948-1951`: `streaming: { ...s.streaming, [id]: next }`). Only *membership* is needed, but the entire sidebar body (projects tree, both virtualized lists, footer) re-executes per token — including background sessions streaming while the user reads another chat.
**Fix:** maintain a store-side derived primitive (e.g. a `streamingIds` string or set updated only on add/remove of keys in `sendMessage`/`onDone`/`onError`/`cancelStream`), or push `working: boolean` into memoized rows.

### A3. 🟠 GitToolsSidebar: three selectors with `?? {}` / `?? []` fallbacks — certain
**Where:** `src/components/chat/GitToolsSidebar.tsx:35-43`
In the common case (no tasks/plans/subagents) each call returns a brand-new `{}`/`[]`, so this permanently-mounted panel re-renders on every store commit. Same pattern in `ProgressPanel.tsx:9-11` and `SubagentPanel.tsx:49-51`.
**Fix:** module-level `EMPTY_TASKS`/`EMPTY_STEPS` constants (or select possibly-undefined slices and default at usage).

### A4. 🟡 `regenerate` / `editMessage` can send the follow-up turn into the wrong session — certain path
**Where:** `src/state/chat.ts:1558-1592`
Both await `supersedeChatTail` + `loadMessages` (IPC round-trips), then call `sendMessage(clean)` which re-reads `get().activeChatSessionId`. If the user switches chats during that window, the old tail is retired but the regenerated turn lands in the unrelated chat.
**Fix:** capture `sid = activeChatSessionId` up front; bail/restore if it changed after the awaits; route through a session-scoped send helper.

### A5. 🟡 `artifactProposals` never cleaned — missed by both H3 cleanups — certain
**Where:** `src/state/chat.ts:334-398` (`clearSessionState`) and `1161-1186` (`deleteAllChats`)
Every per-session map is stripped except `artifactProposals`; entries hold full `ArtifactProposal` specs and survive create/delete cycles and "Delete all chats".
**Fix:** delete the session's entry in `clearSessionState` and reset the map in `deleteAllChats`.

### A6. 🟡 BranchDropdown leaks its `project:fs-changed` listener on fast close — certain
**Where:** `src/components/chat/BranchDropdown.tsx:73-88`
No `cancelled` guard: unmount before the `safeListen` promise resolves ⇒ resolver assigns `unlisten` after cleanup ran; the handler (two IPC round-trips + setState) stays registered for the app lifetime, accumulating per open/close. The correct pattern already exists in `DevDiffPanel.tsx:264-279`.
**Fix:** `const listenReady = safeListen(...); return () => { cancelled = true; void listenReady.then((u) => u()); };`

### A7. 🟡 `onToken` rebuilds the full buffer string per token — O(n²) allocation churn — certain
**Where:** `src/state/chat.ts:1940-1946`
`tailCodePoints(prev + token, 200_000)` concatenates + copies up to a 400 KB UTF-16 buffer per token at 30–100 tokens/sec ≈ 10–40 MB/s transient allocations, sustained for minutes.
**Fix:** accumulate chunks in a plain mutable ref inside the store module; materialize the capped tail on a throttle (rAF or 50–100 ms). `useStreamingText.ts` already implements this pattern but is wired nowhere.

### A8. 🟡 Subagent output re-parses full markdown per chunk — likely impact
**Where:** `src/state/chat.ts:2308-2319` + `src/components/panes/SubagentPanel.tsx:140-144`
Each `chat:subagent-tokens` event commits the whole (≤200K-char) output; the open Agents tab re-runs react-markdown over all of it per chunk. No cap on subagent streams either.
**Fix:** throttle commits (rAF/100 ms flush); render plain text while `status === "running"`, markdown on completion.

### A9. ⚪ Queued-message ids from `Date.now()` can collide — certain code, rare occurrence
**Where:** `chat.ts:1308-1319` (enqueue) / `783-789` (remove). Two messages queued in the same millisecond share an id; removing one removes both. Fix: monotonic counter like `nextToastId` in `ui.ts:222`.

### A10. ⚪ `deleteMessage` cleans `artifactsByMessage` but not `checkpointsByMessage` — certain
**Where:** `chat.ts:1599-1614`. Stale "restore" chip for a deleted message until reopen. Delete both maps' entries together.

### A11. ⚪ PR detail cache grows unbounded for the app run — possible impact
**Where:** `src/state/pullRequests.ts:28,67-107`. Full PR patches retained per project until explicit invalidate. LRU-cap (~20 bundles).

### A12. ⚪ Ctrl+wheel terminal zoom refits + IPC-resizes per wheel tick — certain
**Where:** `src/components/panes/TerminalPane.tsx:281-291`. ResizeObserver path is debounced (50 ms) but zoom calls `refit` synchronously per event. Route through the same `scheduleRefit()`.

---

## B. Component render paths

### B1. 🔴 Streaming defeats `MessageBubble` memo — every visible bubble re-parses markdown per token — certain
**Where:** `src/components/chat/ChatView.tsx:1038-1084` (deps at :1084 include `activeStream`), `MessageBubble.tsx:1816`
The `items` useMemo depends on `activeStream`, so it rebuilds per token: all N persisted messages get new object identities plus new `onDelete`/`onEdit` closures, so `memo(MessageBubble)` fails shallow compare for every mounted bubble. react-markdown v9 has zero internal caching (`processor.runSync(processor.parse(file))` per render), so each token re-runs `remarkParse → gfm → math → katex` over the full content of every visible completed bubble. The comment at `MessageBubble.tsx:1811-1815` claims reference stability — false during streaming.
**Fix (either):**
1. Custom comparator: `memo(Inner, (a,b) => a.message.id === b.message.id && a.message.content === b.message.content && a.superseded === b.superseded && …)`, or
2. Keep persisted-item identities stable (memo over `[messages, handleDelete, handleSubmitEdit]` only) and append the live bubble as a separate `<LiveBubble>` keyed off `activeStream`.
Also hoist inline arrows passed to bubbles (`ChatView.tsx:1158-1159`).

### B2. 🟠 Tool-panel tab switch unmounts terminals/browsers — xterm disposed, webviews closed — certain
**Where:** `src/components/panes/ToolPanel.tsx:357-437`; cleanup at `TerminalPane.tsx:471-489` (`term.dispose()`) and `BrowserPane.tsx:270-283` (`browserClosePane`)
The header comment claims inactive tabs "stay MOUNTED with display:none", but pane slots render only inside the active kind's conditional. Switching to Files/Canvas/Pulls/Agents destroys scrollback and kills the OS webview; switching back re-creates xterm and reloads the page from scratch. Keep-alive machinery only works within a kind.
**Fix:** hoist both pane slots out of the per-kind conditionals; toggle via the existing `hidden`/`visible` props.

### B3. 🟠 Canvas keeps every `ArtifactPreviewPane` mounted-hidden; they re-run markdown+Prism on unrelated panes churn — likely
**Where:** `ToolPanel.tsx:494-509`, `ArtifactPreviewPane.tsx` (statically imports ReactMarkdown+Prism, not memoized)
ToolPanel subscribes to the whole panes array; every `setPaneActivity` tick re-renders every hidden preview, each re-running the uncached pipeline over artifact text.
**Fix:** `memo(ArtifactPreviewPane)`; mount only the active preview or defer hidden ones until first activation.

### B4. 🟡 `PlanPreview` runs regexes over the last message on every ChatView render — certain
**Where:** `ChatView.tsx:1246-1251, 1517-1563, 1581-1588`
`detectPlanSection` does a full-content `<think>` strip + up to 8 pattern execs + splits, unmemoized, per render (i.e., per token of any session). `[...items].reverse()` copies at :1104-1106 too.
**Fix:** `useMemo` keyed on last assistant message id/content; derive `lastAssistantKey` inside the existing items memo.

### B5. 🟡 GitToolsSidebar plan scan walks full history with no early exit — certain
**Where:** `GitToolsSidebar.tsx:164-182, 474-504`
Loop scans every assistant message (7 regexes + paragraph split each) even after 10 plans found; recomputes whenever messages change — hitches right when a reply completes.
**Fix:** `if (found.length >= 10) break;`; cache extraction per message id.

### B6. 🟡 Mermaid diagrams re-run `mermaid.render` on every remount — certain
**Where:** `MermaidDiagram.tsx:209-272`; virtualization (overscan 5) makes remounts frequent
Scroll away and back = full parse/layout (50–300 ms) per diagram, synchronously on the main thread.
**Fix:** module-level LRU `Map<source+theme, svg>` shared across instances.

### B7. 🟡 Drag-resize writes width to the store per pointermove — certain mechanism
**Where:** `DevDiffPanel.tsx:304-324` (+ `ToolPanel.tsx:169-187`)
Each move re-renders panels holding up to `DIFF_LINE_CAP = 2000` row divs per file. Janky splitter dragging with large diffs open.
**Fix:** CSS variable/ref during drag (or rAF-throttled local state); commit to store once on pointerup.

### B8. ⚪ `ChatImage` refetches bytes + rebuilds base64 per mount; no lazy/dimensions — likely
**Where:** `MessageBubble.tsx:1060-1103`. Virtualization re-mounts images on every scroll out/in. Module-level `Map<path, dataUri>` cache + `loading="lazy" decoding="async"` + reserved aspect ratio.

### B9. 🔴→🛑 Bonus correctness: DevDiffPanel declares hooks after conditional returns — crash risk — certain
**Where:** `DevDiffPanel.tsx:482-492, 498-515` early returns precede `useState/useCallback/useEffect` at `562-601`. Mounting the embedded empty state then selecting a project adds 7 hooks ⇒ "Rendered more hooks than during the previous render" crash. Shipping-critical despite being a bug, not perf.

---

## C. SQLite & backend DB paths

Context: `DbState(Arc<Mutex<Connection>>)` — ONE shared connection (lib.rs:50); everything below serializes app-wide. WAL + NORMAL + busy_timeout=5000 are set. FTS is trigger-synced with LIMIT'd queries (good).

### C1. 🟠 Git subprocesses run while holding the global DB mutex — verified
**Where:** `chat/mod.rs:514-525` (lock acquired first, then `checkpoints::after_turn` shells out `git add -A` + write-tree + commit-tree + diff under the lock); same shape at `agent_sessions.rs:192-193, 2828-2829`.
On any project-bound turn in a real repo (thousands of tracked files, cold FS cache, AV scanning `.git`), EVERY DB touchpoint — PTY cost inserts, chat sends, settings reads, mobile relay polls — stalls hundreds of ms–seconds, per turn. The spawned thread helps nothing while it holds the mutex.
**Fix:** scope the lock: read `repo_path` + insert row under a short lock, drop it, run git, re-lock for `set_checkpoint_ref`.

### C2. 🟠 Rollup freshness marker lacks a usable index — verified (severity softened)
**Where:** `db/cost_v2.rs:115-122`
```sql
SELECT MAX(created_at) FROM chat_messages WHERE role = 'assistant'
```
The comment claims "cheap O(indexed MAX)", but the index is `idx_chat_messages_created(created_at)` alone; with the `role` filter SQLite must walk the index and probe tables until a matching row appears — degrading toward O(N) whenever recent rows don't match. Runs on every dashboard poll, every mobile `GetCostDetails`, and `check_budgets`, under the global mutex — neutralizing the cache it protects.
**Fix:** `CREATE INDEX idx_chat_messages_role_created ON chat_messages(role, created_at);` (also speeds `count_distinct_chat_sessions` at cost_v2.rs:439-447), or drop the `role` filter from the marker.

### C3. 🟠 Session metrics materializes full message bodies to sum integers
**Where:** `chat/commands.rs:1050-1055` then sums at :1069-1102
`list_chat_messages` clones every message's full TEXT into Rust Strings just to ignore them — tens of MB on long sessions, holding the single DB lock for the transfer, per invocation.
**Fix:** one aggregate SELECT (`SUM(input_tokens), SUM(output_tokens), … , SUM(tokens_per_second*output_tokens)`).

### C4. 🟡 Missing indexes on `artifacts(chat_session_id)` and `artifacts(chat_message_id)`
**Where:** schema `db/mod.rs:618-627` (only created/expires indexes exist)
Unindexed hot queries: `list_artifacts_for_chat` (full scan every chat reopen, db/artifacts.rs:59-61); `attach_artifacts_to_message` UPDATE (full scan every completed turn, artifacts.rs:73-77); detach-on-delete UPDATEs (db/chat.rs:508-536).
**Fix:**
```sql
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(chat_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(chat_message_id) WHERE chat_message_id IS NOT NULL;
```

### C5. 🟡 Mobile GetCostDetails: uncached aggregation + query-in-loop N+1, per phone poll
**Where:** `mobile/relay.rs:1534-1576`
GROUP BY over all assistant messages joined to sessions (no index on `cs.provider`), uncached unlike the desktop path, plus a nested `SELECT date(?1,'unixepoch')` per result row — all under one lock hold, on a timer.
**Fix:** cache alongside `ROLLUP_CACHE` (marker exists); compute dates in Rust.

### C6. 🟡 Zero `prepare_cached` in the entire backend
Worst offenders called constantly: `get_setting`/`set_setting` (db/settings.rs:9-25 — multiple times per send, twice per PTY cost event), `insert_cost_event`, `touch_chat_session`, both freshness markers, `read_rate_overrides`. Single shared connection means a statement cache persists and pays fully.
**Fix:** mechanical swap to `conn.prepare_cached(` in db/* and the two relay closures.

### C7. 🟡 Startup migration work scales with data size, every boot
**Where:** `db/mod.rs:94-107` (two full O(N) COUNTs over chat_messages + FTS shadow table to decide FTS rebuild), ~20 error-string-matched ALTER attempts (:144-232, :317-455), unconditional NULL-backfill UPDATE scan (:201-213).
At 100k messages the COUNT pair alone costs real startup latency.
**Fix:** gate post-initial migrations behind `PRAGMA user_version` (or a schema_migrations row).

### C8. 🟡 Transaction hygiene: multi-statement writes run as autocommit
- `remove_project` (db/projects.rs:49-62): seven separate DELETEs — also a **correctness** hole (crash mid-sequence leaves orphans).
- Docs indexing: `replace_file_chunks` = 1 DELETE + N INSERTs each its own transaction, per file in a loop (docs.rs:190-206, docs_index.rs:569-576) — tens of thousands of tiny commits per folder index.
**Fix:** `conn.unchecked_transaction()` (pattern exists at chat.rs:322); batch chunk inserts.

### C9. 🟡 `is_path_allowed` holds the DB lock across `canonicalize()` syscalls
**Where:** `commands/data.rs:411-459` — lock taken first, canonicalize per project/session/worktree inside, dropped only at :459. Every `read_file_text` can stall all DB traffic dozens of ms+ on slow storage.
**Fix:** copy path strings out, drop the lock, canonicalize; memoize canonical roots.

### C10. ⚪ Artifact sweep: startup-only, main thread, inline deletes
**Where:** lib.rs:100-101 → chat/commands.rs:178-188. Hundreds of `remove_file` calls (AV/network drives) before first paint after a month away; never re-runs while the process stays open. Move to `spawn_blocking` post-setup + daily timer.

### C11. ⚪ Assorted load-everything-filter-in-Rust queries
- `delete_empty_chat_sessions` (db/chat.rs:184-190): `NOT IN (SELECT DISTINCT …)` over the whole messages table → rewrite as `NOT EXISTS` probe.
- `generate_chat_title` (chat/commands.rs:632-653): loads all messages for a ≤4 KB transcript → `ORDER BY id LIMIT k`.
- `get_recent_messages` (artifacts/context.rs:103-110): full SELECT * then keeps 15 → use `list_chat_messages_page(sid, None, 15)`.
- Mobile `GetCostSummary` (relay.rs:795-843): two overlapping range scans re-pricing identical rows per poll → one pass bucketing by day (reuse cached daily rollups).

---

## Verified clean (no action)
- All other hooks' listener lifecycles (usePtyEvents/useChatEvents/useBrowserMcpEvents/useGitStatusPolling/useAutomationEvents/useBudgetEvents/useModelDownloadEvents/useCostRollups)
- ipc.ts invoke wrappers (no payload cloning, no per-event parsing); settings persistence writes only on explicit setters
- App.tsx overlays genuinely unmount when closed; TerminalPane resize fit debounced; DevDiffPanel diff parsing memoized; CommandPalette debounces FTS; syntax theme cached
- Paging queries use `idx_chat_messages_session(chat_session_id, id)` correctly; automation_runs keyset-paginated; busy_timeout present; single-connection design makes self-SQLITE_BUSY impossible

## Suggested fix order
1. **B1** (custom memo comparator or LiveBubble split) + **A1/A2/A3** (selector fixes) — small diffs, removes the per-token storm end-to-end
2. **C1** (checkpoint lock scoping) + **C2/C4** (two CREATE INDEXes) — tiny diffs, big backend win
3. **B9** (hooks-after-return crash) — shipping-critical correctness
4. **B2** (keep-alive across tool tabs) — user-visible state loss
5. **A7/A8** (token-buffer throttling) — GC pressure
6. **C6/C7/C8** (prepare_cached sweep, user_version gating, transactions) — mechanical
7. Remaining 🟡/⚪ as capacity allows
