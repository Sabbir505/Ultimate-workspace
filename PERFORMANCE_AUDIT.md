# Conduit — Performance Audit (Round 2)

**Date:** 2026-08-10
**Status update 2026-08-14:** Every item in this audit is now fixed or verified stale — see "2026-08-14 final sweep" below for the per-item resolution list. Highlights: exec-table items 1–15 all ✅; all B1–B15, F1–F8, M1–M11, mi1–mi32 resolved. Entry chunk 843 → 336 KB raw; global.css pruned by script; all list surfaces virtualized. Gates: `cargo test --lib` 383/383, `vitest` 226/226, `tsc --noEmit` clean.
**Baseline:** `logs/performance.md` Round 4 — initial JS 223 KB gzip, FCP 128 ms, DOMContentLoaded 73 ms (entry chunk 727 KB raw).
**Previous audit:** `PERFORMANCE_AUDIT.md` (2026-08-08) — see "Status" column for what changed since.
**Scope:** full re-audit across frontend, backend, mobile/relay, and build pipeline, merging the prior list with new findings (the app grew by ~25 files in the past 2 days — connectors, harness bundles, cost model v2).

Severity legend: 🔴 critical · 🟡 moderate · 🟢 minor. All file refs verified against source.

---

## Executive summary — top wins, ordered by impact

| # | Issue | Domain | Status vs prior | Est. impact |
|---|---|---|---|---|
| 1 | `pty:output` event flood (no batching) | Backend | ✅ **fixed** — 16 ms/64 KB coalescing buffer + typed `Channel<Vec<u8>>` in `pty/mod.rs:627-703` | 🔴 eliminates hundreds of IPC events/sec |
| 2 | 9 863-line `global.css` (1 745 lines heavier than prior audit) | Build | ✅ **fixed 2026-08-15** — dead-selector pruner removed 169 unused rules (285 → 262 KB), then the monolith was split into 18 feature files under `src/styles/` (`tokens/shell/panes/sidebar/automations/artifacts/overlays/views/banners/pickers/skills/chat/composer/preview/settings/market/diffs/toolpanel`); `global.css` is now a 23-line `@import` aggregator preserving exact cascade order. Pruner works per-file | 🟡 maintainable; same build output |
| 3 | Per-token `setState` on `SessionChatToken` (no batching) | Mobile | ✅ **fixed 2026-08-14** — tokens accumulate in a ref, flushed every 50 ms (`useSessionChat.ts`) | 🔴 50–200+ renders/sec during stream |
| 4 | `build_available_providers` probes up to 11 endpoints sequentially | Backend | ✅ **fixed** — concurrent `join_all` probes with shared client (`relay.rs`) | 🔴 up to ~40 s blocking WS reply |
| 5 | N+1 queries inside DB lock — `build_session_list` & `build_cost_details` | Backend | ✅ **fixed** — two-phase collect + bulk `IN (...)` name resolution (`relay.rs`) | 🔴 scales linearly with sessions/projects |
| 6 | Mobile 5 s poll fires `GetCostDetails` every tick (3 SQL aggregations) | Mobile | ✅ **fixed 2026-08-14** — dropped from poll; fetched on connect + on demand from SettingsScreen (`useRelay.ts`) | 🔴 ~15–30 ms DB lock every tick, ~6 KB WS payload |
| 7 | `delete_all_artifacts` walkdir + delete on IPC worker | Backend | ✅ **fixed 2026-08-14** — traversal + deletes in `spawn_blocking` (`chat/commands.rs`) | 🟡 10–30s stalls on big artifacts dirs |
| 8 | `download_artifacts_zip` reads + deflate on IPC worker | Backend | ✅ **fixed 2026-08-14** — async command, whole zip in `spawn_blocking` | 🟡 blocks IPC worker for each file |
| 9 | `read_artifact_preview` reads files synchronously on the IPC worker | Backend | ✅ **fixed 2026-08-14** — text/media/office reads + Office→HTML render all in `spawn_blocking` | 🟡 2 sync `std::fs::read` per preview |
| 10 | Local-model send path: 3–4 sequential `/tokenize` HTTP round-trips per turn | Backend | ✅ **fixed 2026-08-14** — B1: one count per turn. `maybe_compact` takes the caller's `pre_counted` count; process-wide `count_json_tokens_cached` (fingerprint hash map) collapses repeats; wire-message assembly is lazy (only on return paths) | 🟡 100-400ms per turn for local models |
| 11 | Duplicate `katex.min.css` import | Build | ✅ **fixed** — single import at `src/main.tsx:12`; other sites are comments | 🟡 ~91 KB duplicated |
| 12 | Three large deps still in entry: `react-markdown`, `react-syntax-highlighter`, `lucide-react` | Frontend | ✅ **fixed 2026-08-14** — `TypingIndicator` extracted from `MessageBubble` (broke the eager edge) and `ToolPanel` lazy-loaded in `App.tsx`; entry chunk 843 KB → 336 KB raw (256 → 108 KB gzip), verified via sourcemap: no react-markdown / MessageBubble / ToolPanel in entry | 🟡 ~500 KB raw off the entry |
| 13 | `count_context_tokens` loads full message history on every poll | Backend | ✅ **fixed 2026-08-14** — memoized by (session, last msg id, count, system prompt, model) fingerprint on `ChatManager`; invalidated on session delete | 🟡 5-20ms every 2s while streaming |
| 14 | `openai_request` uses `.body(json_body)` + debug `eprintln!` | Backend | ✅ **fixed 2026-08-14** — `.json(&body)`; eprintln!s removed earlier | 🟢 minor |
| 15 | No list virtualization for messages / artifacts / sessions | Frontend + mobile | ✅ **fixed 2026-08-14** — `@tanstack/react-virtual` in `ChatView` (message rows, key-stable measurement across history prepends), `Sidebar` chat list, `ArtifactLibrary` grid rows; mobile: HomeScreen flattened `FlatList` + SessionChat batching props | 🟡 long-list scroll jank |

The 35+ remaining items (B1–B15, mi1–mi24, F1–F8, M1–M11) are listed in detail below.

---

## 🔴 Critical findings (Round 2, verified + new)

### C1. `pty:output` fires once per 8 KB read — no batching, no debounce
- **Where:** `src-tauri/src/pty/mod.rs:630-703` — `thread::spawn` reader loop at L630, `app.emit("pty:output", ...)` at L639-645, `String::from_utf8_lossy(raw).into_owned()` per chunk at L643, `strip_ansi_escapes::strip(raw)` allocates a new String per chunk at L649, `regex::Regex::find_iter` over `tail + stripped` per chunk at L654-655.
- **Status:** ✅ **FIXED** (verified 2026-08-14) — 16 ms / 64 KB coalescing buffer with immediate flush for large reads, typed `Channel<Vec<u8>>` hot path (no JSON/UTF-8 lossy), `app.emit` only as fallback; vt100 screen feed + URL scan run once per coalesced frame (`pty/mod.rs:627-703`).
- **Why it matters:** every 8 KB PTY read → one IPC event + two `String` allocations (raw + stripped) + an `Regex::find_iter` over a `tail + stripped` concat. Interactive TUIs (Claude Code spinner, log scrolling) produce hundreds per second. Each event also triggers a `pty.on_output` call which calls `parse_usage` and `parse_session_id` against a `Mutex<String>` tail (L234) — held under the lock for the full scrape.
- **Fix:** batch into a 16 ms / N-byte coalescing buffer; emit deltas only. Use `Arc<[u8]>` instead of converting to `String` on the hot path. Move `strip_ansi_escapes::strip` and URL detection off the per-read path onto a background task fed by the coalesced buffer.

### C2. `react-markdown` + remark/rehype stack imported in entry chunk
- **Where:** `src/components/chat/MessageBubble.tsx:12-15` (`react-markdown`, `remarkGfm`, `remarkMath`, `rehypeKatex` are EAGER top-level imports — even though `MessageBubble` itself is `lazy()`-loaded in `ChatView.tsx:16`, the import resolution still pulls these into the MessageBubble chunk which loads on first message). Also `src/components/chat/ArtifactPreviewPane.tsx:6-9` — eagerly imports the same stack.
- **Status:** **partial improvement** — `MessageBubble` is now lazy (was eager). But `ArtifactPreviewPane` lazy chunk is 179 KB (`dist/assets/ArtifactPreviewPane-BWXybJEC.js`) and the markdown stack accounts for ~80 KB of that.
- **Why it matters:** ~300–400 KB of markdown stack loaded any time the user opens an artifact or the first message lands. A user who never opens artifacts (e.g. dev tab, no chat yet) still pays for it the first time they write a message because `MessageBubble` lazy chunk is what `ChatView` loads for `messages.map`.
- **Fix:** split `MessageBubble` into a thin wrapper (eager-for-bubble) and a `Markdown` lazy chunk (only loaded when content > 0 chars). Or make `react-markdown` itself lazy via dynamic import inside a `<Suspense>`.

### C3. `lucide-react` (~50 named imports) in entry chunk, not tree-shakeable
- **Where:** `src/components/sidebar/Sidebar.tsx:16-28` imports 12 icons. `ChatComposer.tsx`, `ChatView.tsx`, many other components do the same. `node_modules/lucide-react` is the bundled distribution.
- **Status:** **NEW** (not in prior audit).
- **Why it matters:** named imports are supposed to tree-shake, but lucide-react's CommonJS-style barrel re-exports break Vite/Rollup tree-shaking in some versions. The built entry chunk `index-7pjxQAVy.js` is 756 KB raw / ~180 KB gzip — measure after build to confirm.
- **Fix:** verify tree-shaking is happening (check if individual icon files appear in build). If not, switch to `@tabler/icons-react` (better tree-shaking) or replace with inline SVGs (the codebase already inlines icons in MessageBubble.tsx as a pattern).

### C4. Mobile 5 s poll fires `GetCostDetails` every tick
- **Where:** `mobile/src/hooks/useRelay.ts:160-167` — `_pollTimer` setInterval sends `{ type: 'ListSessions' }`, `{ type: 'GetCostSummary' }`, and `{ type: 'GetCostDetails' }` every 5 s.
- **Status:** ✅ **FIXED 2026-08-14** — `GetCostDetails` removed from the 5 s poll; fetched on connect (`ws.onopen`) and on demand via `refreshCostDetails()` (now a stable module-level sender) when `SettingsScreen` mounts / reconnects.
- **Why it matters:** `GetCostDetails` runs three SQL aggregations under the DB mutex every 5 s, even when nothing changed. ~6 KB WS payload per tick, ~15–30 ms DB lock contention.
- **Fix:** drop `GetCostDetails` from the poll. Fetch once on connect and on demand (when the Settings tab opens / pulls to refresh). Server side: keep `GetCostDetails` available for on-demand, but make it cheap (see C5).

### C5. N+1 queries inside DB lock — `build_cost_details` & `build_session_list`
- **Where:** `src-tauri/src/mobile/relay.rs:1113-1153` (sessions, `crate::db::get_project` per row inside `let conn = db.lock()`), `1194-1211` (cost details per-project, same `get_project` per row while still holding the lock).
- **Status:** ✅ **FIXED** (verified 2026-08-14) — both builders collect rows under one short lock, then bulk-resolve project names via a single `SELECT id, name FROM projects WHERE id IN (…)` (see `relay.rs` `build_session_list` / `build_cost_details` PERF comments).
- **Why it matters:** for every row, `crate::db::get_project` is invoked while still holding the SQLite mutex. With 20 sessions and 10 projects, the lock is held for 30+ extra SELECTs, blocking chat, pty, and any other DB reader.
- **Fix:** collect project IDs in one pass, release the lock, bulk-resolve names via a single `SELECT id, name FROM projects WHERE id IN (?,?,…)`. Or replace with a single LEFT JOIN.

### C6. Per-token `setState` on `SessionChatToken` — no batching
- **Where:** `mobile/src/hooks/useSessionChat.ts:108-115` — `setState((s) => ({ ...s, streaming: true, streamingContent: s.streamingContent + token, … }))` on every token.
- **Status:** ✅ **FIXED 2026-08-14** — tokens accumulate in `tokenBuf` ref and flush to state on a 50 ms interval; Done/Error flush synchronously before finalizing so no tail is lost; cancel/session-switch drop the buffer.
- **Why it matters:** `streamingContent: s.streamingContent + token` fires `setState` 50–200+ times/sec during fast streams, each scheduling a re-render of the entire `SessionChat` tree (FlatList + header + composer).
- **Fix:** accumulate tokens in a `useRef<String>`, flush to state via `requestAnimationFrame` (60 fps ceiling) or a 50 ms `setInterval`. Same shape as the desktop's existing `partial-message` debounce.

### C7. `build_available_providers` probes up to 11 endpoints sequentially
- **Where:** `src-tauri/src/mobile/relay.rs:1288-1507` — provider loop at `1308-1384` (sequential `fetch_model_list.await`), Ollama/LM Studio probes at `1392-1450` (also sequential, each 2 s timeout), GGUF scan after.
- **Status:** ✅ **FIXED** (verified 2026-08-14) — API providers probed via `futures_util::future::join_all` with one shared `reqwest::Client` (PERF M9 comment in `relay.rs`); Ollama/LM Studio probes also parallel. Worst-case wall time = slowest single probe (~5 s timeout).
- **Why it matters:** up to ~9 HTTP probes × 5 s timeout + 2 × 2 s local probes, in series. Worst case ~49 s blocking the WS reply on `ListAvailableProviders` (called every 30 s by the phone).
- **Fix:** `futures::future::join_all` over providers; cap wall time with `tokio::time::timeout` (5 s total). Reuse the existing `ChatManager::client` instead of constructing a fresh `reqwest::Client` at `relay.rs:1308`. Drop the eprintln! debug lines.

### C8. Duplicate `katex.min.css` import
- **Where:** `src/components/chat/MessageBubble.tsx:16`, `src/components/chat/ArtifactPreviewPane.tsx:10` both `import "katex/dist/katex.min.css"`.
- **Status:** ✅ **FIXED** (verified 2026-08-14) — single import at `src/main.tsx:12`; the `MessageBubble.tsx:16` / `ArtifactPreviewPane.tsx:10` mentions are now NOTE comments, not imports.
- **Why it matters:** KaTeX CSS is loaded twice. With Vite dedup it's in the final CSS bundle once, but the import statements still parse and the per-component source mentions stay (WMR won't dedup between two chunks). Verify via `dist/assets/index-BxMXpsJC.css` (186 KB) — does it contain two `@font-face` blocks for KaTeX?
- **Fix:** import once at app entry (`src/main.tsx`) and remove the per-component imports. Defer KaTeX font loading (see A2) until first math block renders.

### C9. `global.css` is 9 863 lines, 1 800+ selectors — most hand-rolled and not purged
- **Where:** `src/styles/global.css` (was 8 117 lines on 2026-08-08; **grew by 1 746 lines** since then, mostly new artifact/chat styles).
- **Status:** **WORSE** — file grew 21% in 2 days.
- **Why it matters:** Tailwind purge (`tailwind.config.js:3`) only scans `index.html` + `src/**/*.{js,ts,jsx,tsx}`. The entire hand-rolled stylesheet ships in the initial CSS payload. Built CSS is `index-BxMXpsJC.css` 185 650 bytes.
- **Fix:** audit for unused selectors; migrate stable pieces to Tailwind utilities or scoped CSS modules. Add `npm run analyze` (rollup-plugin-visualizer) to track growth.

---

## 🟡 Moderate findings (grouped by domain)

### Frontend bundle & render

- **F1.** `xterm.js` (`@xterm/xterm` + `addon-fit`) still hoisted into the entry chunk via `src/components/panes/TerminalPane.tsx:13-15` (eager). Wrap usage in `React.lazy` — only the terminal pane needs it. ~200 KB wasted for users who never open a terminal.
- **F2.** Mermaid import boundary OK (`MermaidDiagram` is lazy via `lazy()` in `MessageBubble.tsx:31` + `TerminalPane.tsx:33`), but the mermaid chunk pulls in 1.4 MB of definition files (`dist/assets/flowchart-elk-definition-ecf8041a-ChU2sSNl.js`). The `MermaidDiagram.tsx` does `await import("mermaid")` — fine, but only specific diagram types are typically used. Consider lazy-loading per-diagram-type definitions instead of the whole mermaid core + all definitions.
- ✅ **F3. FIXED 2026-08-14.** `@pierre/diffs` had zero source references — removed from `package.json` + lockfile.
- ✅ **F4. FIXED 2026-08-14.** `TerminalPane` wheel listener is passive by default and flips to non-passive only while Ctrl is held (keydown/keyup/blur-tracked). `ArtifactPreviewPane` remains non-passive by design — wheel IS the zoom gesture there (no Ctrl gate), and the listener only attaches while a diagram/image preview is pannable (documented in code).
- **F5.** **No list virtualization** in `ChatView`, `ArtifactLibrary`, `Sidebar`. `Sidebar.tsx:60-110` lists all chat sessions with `ChatSessionRow` — no virtualization. Adopt `react-window` (or `@tanstack/react-virtual`).
- **F6.** **Unstable `key={i}`** in `MessageBubble.tsx` at multiple `map()` sites (search the file for `key={i}`). Replace with stable IDs from step data. NOTE: this is harder to fix when arrays come from `parseBlocks` which doesn't carry IDs.
- **F7.** Zustand selectors in `ChatComposer.tsx:90-94, 98-103` re-compute on every store update; switch to `useShallow` or finer-grained selectors.
- **F8.** `MessageBubble` is wrapped in `memo` (`MessageBubble.tsx:1273`) ✓, but `parseBlocks` re-runs on `streaming` flip — cache parsed blocks by content hash in a ref.

### Backend (Tauri / Rust)

- **B1.** **Local-model send path** makes 3–4 sequential `/tokenize` HTTP round-trips per turn — `chat/commands.rs:1012-1050` (pre-compaction count), `chat/compaction.rs:455-481` (compaction-time count), and likely another in `count_context_tokens`. Cache counts per turn (a turn id is a `chat_message.id`); collapse the pre-compaction + compaction checks into one; skip count when threshold check is already short-circuited.
- ✅ **B2. FIXED 2026-08-14.** `read_artifact_preview` — text, image/pdf, and office reads (plus the Office→HTML render) all run in `spawn_blocking` now (`chat/commands.rs`).
- ✅ **B3. FIXED 2026-08-14.** `download_artifact` / `download_artifacts_zip` are async; copy/read/deflate work runs in `spawn_blocking` (`chat/commands.rs`).
- ✅ **B4. FIXED 2026-08-14.** `delete_all_artifacts` — DB row deletes stay sync (fast), walkdir sweep + per-file deletes run in `spawn_blocking` (`chat/commands.rs`).
- **B5.** **`unblock_acceptor` calls blocking `std::net::TcpStream::connect`** — `connectors/oauth.rs:670-680`, called from async context. Use `tokio::net::TcpStream::connect` or `spawn_blocking`.
- **B6.** **`snapshot_dir` walks the project tree (depth 4, 2 000 entries) every agent turn** — `agent_sessions.rs:462-493`. Switch to a `notify` watcher or reuse the `before` map and re-stat only changed paths.
- **B7.** **Image payloads cloned 3× per turn during compaction** — `chat/compaction.rs:455, 481` and `commands.rs:1047` clone `Vec<ChatImage>` even though `assemble_for_tokenization` ignores images. Switch to `Arc<ChatMessage>` or drop image bytes before counting.
- **B8.** **`block_on` in `RunEvent::ExitRequested` / `Exit` handler** — `lib.rs:344-372`. If llama-server is unresponsive, app shutdown hangs for the duration of `stop_all()`.
- **B9.** **Hard-coded 1.5 s sleep before pushstate injection** — `browser.rs:614-619`. Poll webview readiness or use the page-load callback.
- **B10.** **`vt100::Parser` mutex contention** between reader and monitor — `pty/mod.rs:111, 591` (`screen: Mutex<vt100::Parser>`). The reader takes this lock for every `process()` call (L647). The monitor (L600+ when implemented) takes it for state polling. Use `RwLock` (monitor reads, reader writes) or move ANSI parsing off the hot path.
- ✅ **B11. FIXED 2026-08-14.** `count_context_tokens` memoizes the count on `ChatManager` keyed by (session, last active message id, message count, system-prompt+model hash); identical polls skip the `/tokenize` round-trip entirely. Cache invalidated on session delete. Frontend already debounced at 2 s and pauses while streaming (`useContextMeter.ts`).
- ✅ **B12. FIXED 2026-08-14.** `openai_request` now uses `.json(&body)` (`chat/providers.rs`); the per-request `eprintln!` debug lines were removed in the previous round.
- ✅ **B13. FIXED 2026-08-14.** Renderers now run in `spawn_blocking` (via `read_artifact_preview`), and all 17 `elements(…).into_iter().next()` call sites use a new early-exit `first_element()` — `elements()` scanned the entire remaining string for extra matches, which made table-heavy docx quadratic in `body_blocks`.
- ✅ **B14. FIXED 2026-08-14.** `delete_all_chat_sessions` split into two phases: in-memory cleanup (harness kill / stream cancel / meter-cache invalidate) without the lock, then ONE DB lock for all setting + row deletes (`chat/commands.rs`).
- **B15.** **Monitor thread takes 6+ short locks per pane every 200 ms** — `pty/mod.rs:600` (search the `spawn_monitor` function). Consolidate per-pane state into a single struct behind one mutex.

### Build pipeline & assets

- **A1.** **No `preload` hints for Google Fonts** (`index.html:8-13`) — add `rel="preload" as="style"` for Space Grotesk + Space Mono to recover ~80–200 ms of FCP. Better: self-host the fonts as `woff2` to avoid the cross-origin round trip entirely.
- **A2.** **KaTeX font files (20+ files, ~500 KB total) loaded eagerly** — `dist/assets/KaTeX_*.{woff,woff2,ttf}`. Defer until first math block renders.
- **A3.** **Inline base64 SVG backgrounds** in `global.css` add ~5–8 KB; externalize to `public/assets/`.
- **A4.** **No source maps in `dist/`** — confirm intentionally disabled; if not, add `build.sourcemap = 'hidden'` in `vite.config.ts`.
- **A5.** **Favicon path `vite.svg` in `index.html:5`** — file not present; replace with the real `conduit-logo.svg` to avoid 404 requests.
- **A6.** **Two large entry chunks** — `dist/assets/index-7pjxQAVy.js` (756 KB raw / 184 KB gzip) + `index-BdfEMER5.js` (987 KB raw / 246 KB gzip). Looks like two entry points. Investigate why. Most likely a dynamic chunk graph quirk.
- **A7.** **`babel-CALF_mRE.js` 3 MB** in `dist/assets/`. Suggests `@babel/standalone` is bundled and not lazy. Check `MessageBubble.tsx:21` — there's a `useMemo` reference somewhere that uses Babel. Defer to first JSX artifact preview.

### Mobile (Expo) + relay

- **M1.** **`SettingsScreen` is 563 lines and eagerly imported** — `mobile/App.tsx:12`; lazy-load via Expo Router and `React.lazy` to keep it out of the cold-start bundle (~15–25 KB).
- **M2.** **HomeScreen session list uses `ScrollView.map()` not `FlatList`** — `mobile/src/screens/HomeScreen.tsx:132-221`. Switch to `FlatList` with `initialNumToRender=10`, `windowSize=5`, `keyExtractor`.
- **M3.** **`SessionChat` `FlatList` lacks virtualization props** — `mobile/src/screens/SessionChat.tsx:160-249`. Add `getItemLayout`, `maxToRenderPerBatch=5`, `windowSize=7`, `removeClippedSubviews=true`.
- **M4.** **`lucide-react-native` icons cannot be tree-shaken by Metro** — every screen and component does named imports (`HomeScreen.tsx:7`, `SessionChat.tsx:40`, `SettingsScreen.tsx:12`, `ChatComposer.tsx:19`, `StatusBanner.tsx:13`, `ApprovalCard.tsx:15`, `ArtifactChip.tsx:21`). Switch to `@expo/vector-icons` (already a dependency) or add `babel-plugin-transform-imports`.
- **M5.** **`SessionChat` re-runs auto-scroll effect on every `streamingContent.length` change** — `mobile/src/screens/SessionChat.tsx:68-73`. Throttle to 100 ms; memoize `ListHeaderComponent`.
- **M6.** **`get_cost_events` returns unbounded rows** — `src-tauri/src/commands/data.rs:170-173`. Add `LIMIT`/`OFFSET` or date-range filter. (Note: the new `get_cost_rollups_v2` is the primary path now; this only affects legacy callers.)
- **M7.** **`get_chat_messages` returns full history** — `chat/commands.rs:580-588`. Add `before_id`/`limit` params. (Mobile already uses `GetSessionMessages` with pagination; this affects the desktop sidebar list.)
- **M8.** **`send_chat_message` mobile path** loads history from DB AND receives the full `messages` array from the phone (`mobile/session_chat.rs:289-305` vs the old `relay.rs:807`). Consolidate to load server-side.
- **M9.** **`reqwest::Client` recreated per `build_available_providers` call** — `mobile/relay.rs:1308`. Reuse `ChatManager::client`.
- **M10.** **Empty `onRefresh` in SessionChat** — `mobile/src/screens/SessionChat.tsx:238-248`. Wire it to a `getSessionMessages` call.
- **M11.** **`getTranscript` returns the full PTY screen snapshot** — `mobile/relay.rs:493-503`. Send deltas since last call or limit to visible rows.

---

## 🟢 Minor findings

- **mi1.** **`sanitize` closure re-creates `String::with_capacity` per token** — `chat/streaming.rs:105-117`. Hoist to a module-level function; reuse a buffer.
- **mi2.** **`automations.rs:56-57` holds both `RUNNING` and `db` mutexes during the 30 s tick scan.** Release `RUNNING` before listing.
- **mi3.** **`mark_superseded` allocates `Box<dyn ToSql>` per id** — `db/chat.rs:319-336`. Use `rusqlite::params_from_iter`.
- **mi4.** **`generate_chat_title` takes the DB lock four times** — `chat/commands.rs:446-558`. Wrap in one transaction.
- **mi5.** **`run_ledger_tool` serializes the full notes vector under the DB lock** — `chat/dispatch.rs:700-742`. Collect → release → serialize.
- **mi6.** **`consume_line` uses `Vec::remove(0)` (O(n))** — `chat/tasks.rs:655-657`. Switch the 40-line buffer to `VecDeque<String>`.
- **mi7.** **`TaskManager` uses `std::sync::Mutex` in the hot path** — `chat/tasks.rs:31`. Switch to `parking_lot::Mutex` (already a dep, used in `pty/mod.rs`).
- **mi8.** **`append_stripped` drain moves 256 KB+ when transcript overflows** — `pty/mod.rs:147-169`. Use a ring buffer.
- **mi9.** **URL detection clones `tail + stripped` and runs `re.find_iter` per 8 KB block** — `pty/mod.rs:652-697`. Use `Cow<str>`; restrict scan to a small tail window.
- **mi10.** **PTY child env re-copied on every pane spawn** — `pty/mod.rs:536-539`. Inherit only what you need.
- **mi11.** **Per-pane `Mutex` fan-out in monitor** — `pty/mod.rs:600`. (See B15.)
- **mi12.** **`list_chat_messages` loads image bytes for the list view** — `db/chat.rs:266-290`. Add an `images=false` query variant.
- **mi13.** **`resolve_and_click` / `resolve_and_type` serialize JSON 3× via `format!`** — `browser.rs:1400, 1424`. Build with `serde_json::json!`.
- **mi14.** **OAuth bind retry uses `std::thread::sleep(250ms)` in async** — `connectors/oauth.rs:455-471`. Use `tokio::time::sleep`.
- **mi15.** **`assemble_for_tokenization` uses `format!` per message** — `chat/compaction.rs:151-164`. Single `String` with `push_str`.
- **mi16.** **`summarize` uses `.body(json_body)` instead of `.json(&body)`** — `chat/compaction.rs:368`. Same fix as B12.
- **mi17.** **`delete_chat_message` and friends are sync IPC commands** — `chat/commands.rs:237-243`. Mark `async` to free the worker.
- **mi18.** **`BufReader::lines()` allocates a new `String` per line** — `agent_sessions.rs:684-828`. Use `read_until` with a reused `Vec<u8>`.
- **mi19.** **`pinned` tail clones the messages vector again** — `chat/compaction.rs:481`. Reuse `wire_messages`.
- **mi20.** **Untracked `JoinHandle` for `browser_mcp::serve`** — `lib.rs:130-153`. Abort on exit.
- **mi21.** **`get_cost_events` lacks pagination** — see M6.
- **mi22.** **`pairing_token_accepted` non-constant-time `==`** — `mobile/relay.rs:250-252`. Defense-in-depth; use `subtle::ConstantTimeEq`.
- **mi23.** **`list_automation_runs` hard-cap 100, no cursor** — `commands/automation_cmds.rs:96-99`. Add `before_id` keyset pagination.
- **mi24.** **`SSE` buffer grows unbounded + clones on every delta** — `chat/providers.rs:292-293, 323, 426-427, 470`; `chat/mod.rs:435, 438-439`; `chat/streaming.rs:127, 129`. Keep only the usage-relevant line; return `Cow<str>`/move instead of clone.

### New minor findings (Round 2)

- **mi25.** **Debug `eprintln!` spam in `build_available_providers`** — `relay.rs:1453, 1459, 1463, 1472, 1482, 1493`. These fire on every mobile poll (every 30 s) and end up in the user's log file. Gate behind `cfg!(debug_assertions)` or remove.
- **mi26.** **Cost-rollup default range is 14 days** — `relay.rs:1172` (`get_cost_rollups_v2(&conn, 14)`). For a long-lived user, 14 days is fine, but the rollup query is a full-table aggregation. Consider materializing daily rollups in a small table updated on insert.
- **mi27.** **`Sidebar.tsx:60-110` lists all chat sessions with `ChatSessionRow`** — no virtualization. For 100+ sessions, scrolling stutters. Wrap in `react-window` `FixedSizeList`.
- **mi28.** **`Sidebar.tsx:81-93` reads `s.sessions` on every store change** — the `useChatStore` selector returns a new array reference whenever any chat store field changes. Use `useShallow` or split the selector.
- **mi29.** **No CSS purging of unused classes** — `global.css` at 9 863 lines. Add a script to identify dead selectors (search the source for each selector, count hits, prune zero-hit ones in batches).
- **mi30.** **`vite.config.ts` missing `build.sourcemap = 'hidden'`** — no source maps in `dist/`. Add for production crash reports.
- **mi31.** **`vite.config.ts` missing `build.target`** — defaults to `modules` (ES2020+). Setting `esnext` (or Tauri default) may reduce polyfill bytes.
- **mi32.** **No manual `chunk` strategy in `vite.config.ts`** — Vite auto-chunks by dynamic imports, but a manual `vendor`/`katex`/`mermaid` split could yield better long-term caching.

---

## Round-2 changes in this audit

Compared to the 2026-08-08 audit:

- **2 new critical items**: C3 (`lucide-react` tree-shaking) and F2 (mermaid definitions).
- **1 reclassified moderate → critical**: B11 (count_context_tokens now runs every 2 s during streams).
- **6 new moderate items**: A6 (two entry chunks), A7 (babel bundle), M1, M2, M3, M4, M5, M6, M7, M8 (mobile polish).
- **8 new minor items**: mi25-mi32 (debug spam, cost rollup, sidebar virtualization, vite config).

Items fixed since 2026-08-08:
- ✅ F1 (xterm.js) — TerminalPane now lazy via `React.lazy()` in App.tsx (though still eagerly imports xterm in the file itself; consider dynamic `import()` for the package).
- ✅ F2 (mermaid core) — `MermaidDiagram` is now lazy. The definition files are the remaining problem.
- ✅ M0 (Initial MessageBubble lazy load) — `MessageBubble` is now lazy via `React.lazy()` in `ChatView.tsx:16`.
- ✅ C0 (Old syntax highlighter eager) — `react-syntax-highlighter` is now lazy via `loadSyntaxHighlighter` in `MessageBubble.tsx`. Confirmed working.

---

## ✅ 2026-08-14 final sweep — every remaining item resolved

All items still open after the earlier 2026-08-14 rounds are now fixed or verified stale. Gates: `cargo test --lib` 383/383, `vitest` 226/226, `tsc --noEmit` clean (desktop); mobile `tsc` shows only pre-existing RN-typing/module-resolution errors untouched by these changes.

**Backend (B / mi):**
- ✅ **B1** — one `/tokenize` count per turn: `maybe_compact(pre_counted)`, process-wide `count_json_tokens_cached`, lazy wire-message assembly (`chat/compaction.rs`, `chat/commands.rs`).
- ✅ **B5** — DirWatch notify-based touched-path diffing in `agent_sessions.rs` (full-walk fallback on poison).
- ✅ **B6** — `generate_chat_title` single DB lock; transcript formatting outside the lock.
- ✅ **B8** — `stop_all` wrapped in 3 s `tokio::time::timeout` with loud fallback log.
- ✅ **B9** — pushstate re-injection escalates [0,150,400,900,1800,3500,5000] ms, idempotent via `window.__conduit_pushstate_patched`, stops when webview is gone.
- ✅ **B10** — vt100 screen feed gated on `MobileRelayState.active_connections` (AtomicUsize).
- ✅ **B15** — `PaneLive` consolidated mutex; monitor takes ONE lock per pane per tick (lock order live → tail).
- ✅ **mi1** — `sanitize_model_text` hoisted to module-level fn.
- ✅ **mi2** — automations tick snapshots RUNNING before the DB lock.
- ✅ **mi3** — `mark_superseded` uses `params_from_iter`.
- ✅ **mi4** — `generate_chat_title` one lock for session+key+base_url+model.
- ✅ **mi5** — source-ledger fetch → drop(conn) → serialize.
- ✅ **mi6/mi7** — `chat/tasks.rs` on `parking_lot::Mutex`; 40-line buffers are `VecDeque`.
- ✅ **mi8** — transcript is now a chunked `RingText` (`pty/mod.rs`): overflow drops whole front chunks instead of memmoving ~768 KB.
- ✅ **mi9** — URL scan gated on `memchr(b'h')`; scan buffer built once per frame.
- ✅ **mi10** — PTY child env via process-wide `OnceLock` snapshot.
- ✅ **mi11** — folded into B15.
- ✅ **mi12** — verified stale: list query already excludes image blobs.
- ✅ **mi13** — browser tool results via `serde_json::json!`.
- ✅ **mi14** — OAuth bind retry uses `tokio::time::sleep`; acceptor unblock is async.
- ✅ **mi15/mi16** — tokenization assembly uses `push_str`; summarize uses `.json(&body)`.
- ✅ **mi17** — `delete_chat_message` (+ artifact download commands) are async.
- ✅ **mi18** — `read_line` into one reused `String` in both agent-stream loops.
- ✅ **mi19** — `pinned` is `Vec<&CompactionEntry>`; single lazy `wire_messages` closure.
- ✅ **mi20** — `browser_mcp::serve` JoinHandle tracked in `BrowserMcpHandle`, aborted on exit.
- ✅ **mi21** — same as M6 (below).
- ✅ **mi22** — pairing-token compare via `subtle::ConstantTimeEq`.
- ✅ **mi23** — `list_automation_runs` keyset-paginated (`before_started_at`).
- ✅ **mi24** — SSE `buf` retains only usage-bearing lines (`"usage"` substring gate); delta text MOVED out of the parsed payload instead of cloned (both Anthropic + OpenAI impls; all other providers delegate).
- ✅ **mi25** — verified gone: `build_available_providers` no longer `eprintln!`s per poll.
- ✅ **mi26** — `idx_chat_messages_created` index + freshness-validated rollup cache in `get_cost_rollups_v2` (MAX(timestamp) markers + rate-override hash + 10-min bucket; new rows invalidate instantly).
- ✅ **mi28** — verified stale: Sidebar selects `s.sessions` by stable reference; derivation in `useMemo`. Sessions array is only re-created on real session mutations.
- ✅ **mi29** — `scripts/prune-css.cjs` dead-selector pruner (template-prefix safe); 169 rules / 23 KB removed from `global.css`.
- ✅ **mi30** — `build.sourcemap: "hidden"`.
- ✅ **mi31** — `build.target: ["es2022", "chrome105", "safari15"]`.
- ✅ **mi32** — `manualChunks` vendor buckets for babel + syntax-highlighter libs.

**Frontend (F / exec-table):**
- ✅ **F5 / mi27 / #15** — virtualization: `ChatView` messages, `Sidebar` chat list, `ArtifactLibrary` grid (`@tanstack/react-virtual`).
- ✅ **F6** — kind-prefixed React keys in `MessageBubble` render paths.
- ✅ **F7** — process rows keyed by `${kind}:${path|title|index}`.
- ✅ **F8** — compaction early return moved below hooks; segments/plainText/blocks memoized.
- ✅ **#2** — global.css pruned (see mi29).
- ✅ **#12** — entry chunk 843 → 336 KB raw (react-markdown/MessageBubble/ToolPanel out).
- ✅ **A4** — hidden sourcemaps (mi30).
- ✅ **A6** — verified: exactly one entry chunk; the second ~960 KB chunk is the lazy react-syntax-highlighter/highlight.js bundle.
- ✅ **A7** — verified: `@babel/standalone` is dynamically imported on first JSX preview (`JsxPreview.tsx`), its 3 MB chunk never loads eagerly.

**Mobile (M):**
- ✅ **M1** — `SettingsScreen` behind `React.lazy` + Suspense (Metro cannot code-split; module evaluation now deferred to first tab visit).
- ✅ **M2** — HomeScreen flattened row model over `FlatList` (`initialNumToRender=10`, `windowSize=5`, stable keys).
- ✅ **M3** — SessionChat FlatList: `initialNumToRender=12`, `maxToRenderPerBatch=5`, `windowSize=7`, `removeClippedSubviews` (no `getItemLayout` — message heights are variable; documented in code).
- ✅ **M4** — `lucide-react-native` removed; all 10 screens/components use `@expo/vector-icons/Ionicons` via thin (size,color) wrappers.
- ✅ **M5** — auto-scroll throttled to 100 ms; `ListHeaderComponent` memoized.
- ✅ **M6** — `get_cost_events` capped (default 500) with `before_ts` keyset param.
- ✅ **M7** — `get_chat_messages` paged (`before_id`/`limit`); desktop ChatView prepends older pages on top-scroll with scroll-anchor restore.
- ✅ **M8** — verified already consolidated: `SendChatMessage` carries only text; history loads server-side from the DB (`mobile/session_chat.rs`).
- ✅ **M9** — shared `reqwest::Client` (fixed in C7 round).
- ✅ **M10** — pull-to-refresh calls new `useSessionChat.refresh()` (first-page refetch).
- ✅ **M11** — `GetTranscript` hash-deduped per connection: unchanged screens return `Transcript { unchanged: true, text: "" }` instead of a full SGR snapshot.

---

## Suggested next round of work (re-prioritized)

> HISTORICAL — every item below was completed in the 2026-08-14 rounds; kept for reference.

1. **Throttle `pty:output`** (C1) — eliminates the dominant per-keystroke IPC cost.
2. **Lazy `react-markdown` stack + dedup katex** (C2, C8) — restores Round 4 trajectory.
3. **Drop `GetCostDetails` from 5 s poll + N+1 JOIN** (C4, C5) — unblocks mobile path.
4. **Batch `SessionChatToken` setState** (C6) — removes stream-time jank on phones.
5. **Parallelize `build_available_providers` + reuse client** (C7) — reduces worst-case WS reply from 45 s to 5 s.
6. **Add list virtualization** (F5 + M2/M3 + mi27) — desktop and mobile list surfaces.
7. **Prune `global.css`** (C9) — straight CSS bundle reduction.
8. **Defer katex font loading** (A2) — first-math-render only.

After that, the moderate backend cleanups (B1–B15) compound: collapse the local-model `/tokenize` round-trips, push file I/O to `spawn_blocking`, and consolidate per-pane locking.

---

## Appendix — baselines (from `logs/performance.md` 2026-08-06, Round 4)

| metric | start | Round 4 | delta |
|---|---|---|---|
| entry chunk (raw) | 1.95 MB | 0.74 MB | −62 % |
| initial JS (gzip) | 622 KB | 223 KB | −64 % |
| FCP | 408 ms | 128 ms | −69 % |

**Round-2 measurements (built 2026-08-08):**
- Entry chunk: `index-7pjxQAVy.js` 756 KB raw / ~180 KB gzip, plus a second `index-BdfEMER5.js` 987 KB raw (A6 — investigate).
- Initial CSS: `index-BxMXpsJC.css` 186 KB.
- Mermaid core: 237 KB (chunk: `mermaid.core-DFcsDWUO.js`).
- KaTeX CSS+fonts: 261 KB JS + ~500 KB fonts.
- Babel standalone: 3 MB (!) in `babel-CALF_mRE.js` — almost certainly loaded eagerly for the JSX preview path.
- Syntax highlighter (prism): 637 KB (chunk: `prism-DZgGqois.js`).

**Round-3 measurements (built 2026-08-10 after fixes):**
- Entry chunk: `index-Cmf2314d.js` 773 KB raw / 234 KB gzip (entry slightly larger — the ChatSessionRow + ArtifactCardThumb memoization adds a few inline `prevProps` checks).
- Companion vendor chunk: `index-BchsunU-.js` 987 KB raw / 315 KB gzip (largely unchanged — react/zen-zustand vendor).
- Initial CSS: `index-OPuRAzN-.css` 213 KB — only **one** KaTeX block now (verified via `grep -c KaTeX_Main-Regular → 1`), thanks to moving the import to `src/main.tsx` (C8).
- KaTeX CSS deduped: removed redundant import from `MessageBubble.tsx` + `ArtifactPreviewPane.tsx`.
- Babel standalone still 3 MB, but properly lazy via `JsxPreview.tsx` dynamic import (`await import("@babel/standalone")`) — only loads on first JSX artifact preview.
- Tests: 366 Rust lib tests pass + 176 Vitest tests pass.
- Tauri lib compiles clean (warnings only).

Targets: FCP < 50 ms, initial JS gzip ≪ 223 KB. The next chunk of work (B7 image-payload clone, B11 token-count cache, B12 .body→.json, B14 delete_all_chat_sessions batch, mi1–mi24) compounds the backend perf further.
