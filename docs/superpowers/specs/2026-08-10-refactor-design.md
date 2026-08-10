# Conduit Architecture Refactor — Design Spec

**Date:** 2026-08-10
**Branch:** `master`
**Author:** Claude (research-driven end-state design session)
**Status:** Approved by user; pending spec review gate.

---

## 1. Premise

The Conduit codebase has grown to ~60k LOC across Rust + TypeScript. The
2026-08-10 performance audit (`PERFORMANCE_AUDIT.md` Round 2) surfaced 50+
findings across 6 critical, 30+ moderate, and 20+ minor items. The build
log shows the codebase has been growing ~25 files every 2 days for the
past two weeks. The instruction is to "refactor until you're happy with
the architecture, code quality, performance, data structure."

This spec is the result of a research-driven end-state design session
that:

1. Mapped the current structure (33.8k Rust LOC across 70+ files; 27k
   TS/TSX LOC across ~120 files; 168 IPC commands; 60 event emit sites;
   17 SQLite tables; 30 chat tools).
2. Researched current (2025-2026) best practices for Tauri 2 + React 18
   + Rust desktop apps across 8 architecture concerns (state, IPC,
   streaming render, bundle, DB, PTY, module structure, virtualization).
3. Proposed 5 binding architectural decisions and a tier-1-through-5
   refactor scope (Sections 2 + 3 of the design session).
4. Defined measurable acceptance criteria (Section 4 of the design
   session).

The goal is **no behavior change** for end users — every improvement is
either a perf win, a code-shape win, or both. No new features, no new
schema, no new dependencies (with two explicit exceptions for
virtualization libs).

---

## 2. Binding architectural decisions

These five decisions are the spine of the refactor. Every task in the
plan traces back to one or more of them.

### D1. IPC transport: `Channel<T>` for streams, `emit` for low-freq events

- **Stream channels (new):** PTY output (`Channel<PtyChunk>`),
  chat tokens (`Channel<ChatTokenEvent>`).
- **`emit` survives for:** `pty:exit`, `pty:state`, `cost:updated`,
  `oauth:callback`, `updater:*`, `mobile:*` (low-freq, broadcast).
- **Why:** `Channel<T>` is Tauri 2's typed, point-to-point, ordered
  stream with lower per-message overhead than the global `emit` bus.
  Eliminates the dominant per-event IPC cost (C1, C6).
- **Source:** Tauri v2 docs — Channels.

### D2. Streaming render: `useTransition` + rAF-batched append buffer

- New `useStreamingText(initial, incoming$)` hook. Accumulates tokens
  in a `useRef`, flushes to state once per `requestAnimationFrame`,
  wraps the state update in `useTransition`.
- Replaces the per-token `setState` in `mobile/src/hooks/useSessionChat.ts`
  (C6) and the per-token re-parse in `MessageBubble.tsx` (F8).
- **Why:** rAF is the actual render-rate limiter. 50-200 tokens/sec
  coalesce into ≤ 60 renders/sec with no perceived latency.
- **Source:** React 18 docs; community token-streaming patterns.

### D3. DB: `rusqlite` + `spawn_blocking` + WAL

- Enable WAL + `synchronous=NORMAL` + `busy_timeout=5000` at boot.
- Bulk-resolve project names via single `SELECT id, name FROM projects
  WHERE id IN (...)` — eliminates the N+1 in `mobile/relay.rs:1113-1259`.
- Move all file I/O off the IPC worker to `tokio::task::spawn_blocking`.
- Cache `count_context_tokens` by `(session_id, last_message_id)`.
- **Why:** 5 of the 6 critical findings in the audit trace to
  "sync work on the IPC worker while holding the SQLite mutex." WAL +
  bulk queries + `spawn_blocking` is the standard fix. `sqlx`
  rejected (overhead for local single-file DB).
- **Source:** rusqlite docs; SQLite WAL docs; tokio `spawn_blocking` guide.

### D4. Bundle: Vite `manualChunks` per-package + `lazy()` at feature boundaries

- `build.rollupOptions.output.manualChunks` as a function returning the
  npm package name (per-package vendor chunks → better long-term caching).
- `React.lazy()` for Settings, DocumentsLibrary, CostDashboard, Mermaid,
  SkillsLibrary, ModelMarket, JsxPreview.
- Audit `global.css` (9,863 lines) for dead selectors. Defer KaTeX
  fonts to first-math-render.
- Investigate the two-entry-chunk quirk (A6).
- **Why:** Per-package chunks + feature `lazy()` is the Vite 5+
  recommendation. Targets: initial JS < 200KB gzip, FCP < 50ms.
- **Source:** Vite docs; Rollup `manualChunks` reference.

### D5. Module boundaries: per-feature folders, narrow public APIs

Pure mechanical decomposition of the 13 hotspot files (each > 1000 LOC
on either side) into focused submodules with re-exports. The pattern
is already proven in the codebase: 2026-07-20 batches 1-4 and
2026-07-26 chat split (chat/mod.rs 2306→622, tools.rs 2394→628).
Re-export at every split boundary so caller sites don't churn.

---

## 3. Scope: 30 tasks across 6 phases + 2 deps

Phases in order. Each task is a self-contained commit. Tasks within a
phase may run in parallel (no dependencies). Full dependency graph
captured in `docs/superpowers/plans/2026-08-10-refactor.md` Section 3.

### Phase 0 — Foundations (no behavior change, unblock everything else)

| Task | What | Files | Decision |
|------|------|-------|----------|
| 0.1 | WAL + busy_timeout wiring at boot | `db/mod.rs` | D3 |
| 0.2 | `bulk_load_projects` helper | new `db/bulk.rs` | D3 |

### Phase 1 — Streaming primitives (the perf foundation)

| Task | What | Files | Decision |
|------|------|-------|----------|
| 1.1 | `Channel<T>` for PTY output (16ms/16KB coalescing) | new `pty/stream.rs`, `lib/channels.ts` | D1 |
| 1.2 | `Channel<T>` for chat tokens | new `chat/stream_events.rs` | D1 |
| 1.3 | `useStreamingText` hook + rAF batching | new hook, mod MessageBubble, mod useSessionChat | D2 |

### Phase 2 — Decompose the largest Rust files

Independent. 2.1 should run before 4.3/4.4/4.5 (those land in
commands/context.rs etc.). 2.4 should run after 0.2.

| Task | Split | LOC before |
|------|-------|------------|
| 2.1 | `chat/commands.rs` → 5 submodules | 2371 |
| 2.2 | `browser.rs` → 4 submodules | 2069 |
| 2.3 | `agent_sessions.rs` → 3 submodules | 1790 |
| 2.4 | `mobile/relay.rs` → 3 submodules | 1701 |
| 2.5 | `connectors/oauth.rs` → 3 submodules | 1426 |
| 2.6 | `chat/local_models.rs` → 2 submodules | 1412 |
| 2.7 | `chat/office.rs` → per-format submodules | 1291 |
| 2.8 | `commands/local_model_market.rs` → 2 submodules | 1508 |

### Phase 3 — Decompose the largest frontend files

3.2 depends on 1.3 (the streaming hook).

| Task | Split | LOC before |
|------|-------|------------|
| 3.1 | `state/chat.ts` → 3 slices | 1321 |
| 3.2 | `MessageBubble.tsx` → shell + parts | 1274 |
| 3.3 | `SettingsView.tsx` → 7 category files | 1715 |
| 3.4 | `state/panes.ts` browser-tabs slice | 612 |
| 3.5 | `lib/ipc.ts` → base/chat/dev | 1127 |

### Phase 4 — Backend perf fixes

4.1 needs 0.2 + 2.4. 4.3/4.4/4.5 need 2.1.

| Task | Fix | Audit ID |
|------|-----|----------|
| 4.1 | N+1 in `build_session_list` + `build_cost_details` | C5 |
| 4.2 | Drop `GetCostDetails` from 5s mobile poll | C4 |
| 4.3 | `count_context_tokens` cache by (session, last_msg_id) | B11 |
| 4.4 | `spawn_blocking` for file I/O on IPC commands | B2/B3/B4/B14 |
| 4.5 | `list_chat_messages` pagination | M7 |

### Phase 5 — Frontend bundle + render perf

5.3 needs 3.2.

| Task | Fix | Audit ID |
|------|-----|----------|
| 5.1 | Vite `manualChunks` per-package | A6, C3 |
| 5.2 | `lazy()` at feature boundaries | F1, F2, M1 |
| 5.3 | List virtualization (virtuoso + tanstack) | F5, M2, M3, mi27 |
| 5.4 | Dead-CSS audit + defer KaTeX fonts | C9, A2 |
| 5.5 | Lucide-react tree-shaking fix | C3 |

### Phase 6 — Cleanup + docs

| Task | What |
|------|------|
| 6.1 | Update AI_CONTEXT + CONTRACT + BUILD_LOG for new structure |
| 6.2 | `mi` minor cleanups batch (mi1-mi32 small wins) |

---

## 4. Acceptance criteria

The refactor is "done" when every item in the table below is verified.
A Round-4 performance audit entry is written to `PERFORMANCE_AUDIT.md`
as the permanent regression baseline.

### 4.1 Performance targets (P1–P14)

| # | Metric | Baseline | Target |
|---|--------|----------|--------|
| P1 | Initial JS gzip (entry) | 234 KB | < 150 KB |
| P2 | First Contentful Paint | 128 ms | < 50 ms |
| P3 | DOMContentLoaded | 73 ms | < 40 ms |
| P4 | Entry chunk (raw) | 773 KB | < 400 KB |
| P5 | `global.css` | 213 KB / 9,863 lines | < 120 KB, 0 dead selectors |
| P6 | PTY output events/sec | 50-200+ | ≤ 60 |
| P7 | Chat token renders/sec | 50-200+ | ≤ 60 |
| P8 | Mobile 5s poll payload | 3 msgs incl. GetCostDetails (~6 KB) | 2 msgs, ≤ 2 KB |
| P9 | `build_session_list` SQL queries (N=20) | 21+ | ≤ 2 |
| P10 | `build_cost_details` SQL queries (N=10) | 11+ | ≤ 2 |
| P11 | Artifact read IPC worker stall | 2 sync fs::read | 0 |
| P12 | Long chat load (200 messages) | full list | paged, 50/page |
| P13 | Lucide-react tree-shaking | full bundle in entry | per-icon or inlined |
| P14 | Cold-start to interactive (Dev tab) | ~600 ms | < 300 ms |

### 4.2 Architecture targets (A1–A9)

| # | Criterion | Baseline | Target |
|---|-----------|----------|--------|
| A1 | No Rust file > 1200 LOC | 8 files | 0 |
| A2 | No TS/TSX file > 800 LOC | 5 files | 0 |
| A3 | Every split has re-exports | n/a | 100% |
| A4 | Test count never drops | 366 Rust + 176 Vitest | ≥ those |
| A5 | No new `unsafe` blocks | 0 | 0 |
| A6 | No new `TODO`/`FIXME`/`HACK`/`XXX` | 0 | 0 |
| A7 | No god-stores (> 500 LOC, 1 concern) | `state/chat.ts` 1321 LOC, 7 jobs | every store < 500 LOC, 1 concern |
| A8 | Public APIs documented | mixed | every public fn in new modules has `///` doc comment |
| A9 | All `Channel<T>` users unit-tested | n/a | 100% |

### 4.3 Live behavior (L1–L10)

10 end-to-end scenarios covering every major surface. Pass criteria
captured in the implementation plan §6. Manual run on the actual
running app for each.

### 4.4 Build/docs hygiene (D1–D10)

`cargo check`/`cargo test`/`tsc`/`vitest`/`vite build` all clean; no
new warnings; test counts not less than baseline; AI_CONTEXT +
CONTRACT + BUILD_LOG updated; spec + plan committed.

### 4.5 Non-goals (explicit)

- No new features
- No new schema (existing migrations stay)
- No test framework swap
- No new dependencies (exception: `react-virtuoso` + `@tanstack/react-virtual` for P5.3, called out per task)
- No "while I'm here" cleanups outside the listed `mi` items
- No mobile-only refactor beyond P8/P9

---

## 5. Risk register

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `Channel<T>` semantics differ across Tauri 2 versions | Low | Pin Tauri 2 minor version; smoke-test 1.1 + 1.2 in isolation before Phase 2 |
| `react-virtuoso` sticky-bottom breaks the existing ChatView auto-scroll | Medium | Write the 5.3 task with a scroll-behavior test before/after; rollback path is `npm uninstall` + revert |
| WAL breaks existing tooling (sqlite3 CLI) | Low | Document in BUILD_LOG; tools still work on WAL files |
| Pure-mechanical split breaks a hidden import | Medium | Every Phase 2 + Phase 3 task runs `cargo check` + `tsc` BEFORE the live-verify step |
| Autoreview finds non-trivial changes hiding inside a "mechanical" split | Medium | Autoreview runs after every task; the rule is "if a reviewer flags it, fix the split, not the flagged code" |
| Performance target P2 (FCP < 50ms) is not reachable from code-shape alone | High | Acknowledge: P2 is a stretch goal. We aim for it, but the user-visible win is P1 + P4 + P6 + P7. If P2 lands at 80ms, that's still a 38% improvement. |
| Phase 4 changes the IPC contract in a way the live app doesn't expect | Medium | Every Phase 4 task keeps the wire-level IPC surface identical (just internal SQL + dispatch). The frontend only sees new commands added, never changed signatures. |

---

## 6. Open questions deferred

- **CARGO workspace?** Currently 1 binary + 2 bin targets + 1 lib. ~33.8k LOC total. Workspace would slow compile times unless we hit ~50k LOC. Decision: stay single-crate, revisit if we cross 50k.
- **Frontend build to `esnext` target?** Audit mi31. Tiny win, defer to a follow-up.
- **Image payload cloning during compaction (B7)?** Out of scope — chat/compaction.rs split is not in the 30-task list. Defer to a future refactor.
- **Sidebar virtualization (mi27)?** Folded into 5.3.

---

## 7. Out-of-spec follow-ups (for a future plan)

These are NOT in this refactor. Captured here so they don't get lost.

- Cargo workspace at ~50k LOC
- `chat/compaction.rs` image-payload clone (B7)
- `chat/tasks.rs` parking_lot mutex swap (mi7) — could be folded into 6.2
- `pty/mod.rs` `vt100::Parser` lock contention (B10) — needs design beyond a split
- `connectors/google_rest.rs` 1306 LOC split (not in the top-13 hotspot list but worth doing)
- `chat/tools/search.rs` 849 LOC split (worth a future look)
- Mobile `useContextMeter` recursive setTimeout (B11 frontend side)
- React 19 upgrade (if/when Tauri 2 supports it)
