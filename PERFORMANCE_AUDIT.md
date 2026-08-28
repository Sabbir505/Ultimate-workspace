# Relay — Performance Audit (Round 3)

**Date:** 2026-08-27
**Scope:** full project (frontend `src/`, Rust backend `src-tauri/src/`, mobile `mobile/`)

> **STATUS: NOT GREEN.** The 2026-08-23 pass claimed `tsc --noEmit clean`, `vitest 407/407`, `cargo test` 502 lib + 4 browser-mcp + 1 smoke = 507 total, `vite build` 336 KB / 108 KB. None of those exact numbers are still true on 2026-08-27 — see the Key Metrics table below for current values, and `BUG_AUDIT.md` for the open Sev M items (`tsc` errors, one failing cargo test). The previously-resolved Round 2 findings (PTY batching, react-markdown lazy load, lucide tree-shaking, mobile poll → on-demand, N+1 cost queries, token batching, parallel probes, KaTeX dedup, CSS split) remain resolved.

---

## Summary — what changed since the 2026-08-23 audit

| Category | Finding | Status |
|---|---|---|
| Command count | 2026-08-23 audit reported 226 commands | **SUPERSEDED** — actual is 235 commands (`tauri::generate_handler!` at `src-tauri/src/lib.rs:239-494`); 236 `#[tauri::command]` attributes total |
| Database tables | 2026-08-23 audit reported 21 tables | **CONFIRMED** — 21 real tables, 22 `CREATE TABLE` lines (one duplicate in a test) |
| Test files | 2026-08-23 audit reported 59 vitest files / 407 tests | **SUPERSEDED** — 68 vitest files / 460 tests, all passing |
| Cargo lib tests | 2026-08-23 audit reported 502 passing | **SUPERSEDED** — 539 passed, 1 FAILED, 11 ignored |
| `tsc --noEmit` | 2026-08-23 audit reported clean | **REGRESSED** — 34 errors, all `TS18046: x is of type 'unknown'` |
| Entry chunk | 2026-08-23 audit reported 336 KB raw / 108 KB gzip | **CHANGED** — `dist/assets/index-C98R2Vls.js` is now 458.96 KB raw / 141.47 KB gzip |
| Async chunks >500 KB | n/a in 2026-08-23 audit | **NEW OBSERVATION** — babel 2.98 MB, syntax 1.59 MB, flowchart-elk 1.45 MB, ArtifactPreviewPane 1.24 MB, mindmap 544 KB all > 500 KB; build emits chunk-size warning |
| PTY output batching | C1 — `pty:output` event flood | **FIXED** — 16 ms coalescing buffer |
| React-markdown stack | C2 — eager import in entry | **FIXED** — lazy-loaded via `React.lazy` |
| Lucide-react icons | C3 — tree-shaking broken | **FIXED** — replaced with `@tabler/icons-react` where possible |
| Mobile 5s poll | C4 — `GetCostDetails` every tick | **FIXED** — on-demand fetch |
| N+1 queries | C5 — `build_cost_details` | **FIXED** — bulk `IN (?)` resolution |
| Token batching | C6 — per-token `setState` | **FIXED** — 50 ms flush interval |
| Parallel probes | C7 — sequential provider probes | **FIXED** — `join_all` concurrent probes |
| Katex CSS dup | C8 — duplicate imports | **FIXED** — single import at entry |
| global.css size | C9 — 9 863 lines monolith | **PARTIAL** — split to 18 feature files + 23-line aggregator (169 dead rules pruned) |

---

## Key metrics (current, 2026-08-27)

| Metric | Value | Note |
|---|---|---|
| Vitest tests | **460 / 460 passing** | 68 files, 16.08s |
| Cargo lib tests | **539 passed, 1 FAILED, 11 ignored** | `chat::commands::preview_tests::basename_walk_prefers_newest_match_and_skips_vendor_dirs` (see BUG_AUDIT N6) |
| `tsc --noEmit` | **34 errors** | All `TS18046` in `GitToolsSidebar.tsx` + `ProgressPanel.tsx` (see BUG_AUDIT N5) |
| Vite build | passes (36.08s) | Multiple chunks > 500 KB trigger warning |
| Entry chunk (raw) | **458.96 KB** | `dist/assets/index-C98R2Vls.js` |
| Entry chunk (gzip) | **141.47 KB** | same |
| Largest async chunk | 2 983.88 KB raw / 683.80 KB gzip | `dist/assets/babel-BpHB7C9N.js` (Babel standalone) |
| Mermaid core | 236.91 KB / 64.29 KB gzip | `dist/assets/mermaid.core-Cys9e5J0.js` |
| KaTeX | 258.47 KB / 77.57 KB gzip | `dist/assets/katex-HP8lGamR.js` |

---

## Remaining recommendations (non-blocking)

1. **Fix the `tsc` regressions** (Sev M) — narrow the unknown-typed destructures in `GitToolsSidebar.tsx` and `ProgressPanel.tsx`. The pattern is consistent enough to be a one-shot PR.
2. **Fix the failing cargo test** (Sev M) — `preview_tests::basename_walk_prefers_newest_match_and_skips_vendor_dirs`. Either the walk logic regressed or the test fixture is misordered; a 10-line patch.
3. **Code-split `babel-standalone` and `flowchart-elk`** — both are > 1 MB async chunks that are only needed on certain artifact paths. A `manualChunks` rule would push them behind the artifact dialog.
4. **KaTeX font loading** — fonts still eager (≈500 KB). Consider loading via `rel=preload` with `as=font` or lazy loading on first math render.
5. **Terminal pane size** — xterm.js still ~200 KB on first use. Currently lazy-loaded via `React.lazy` in `App.tsx`.
6. **Document embedding** — full-vector search for RAG adds ~1-2 MB per 1k docs. Acceptable for local-first use case.
7. **Idle DB connection count** — single `Arc<Mutex<Connection>>` is fine for low write volume. Keep under observation if user has 100+ projects with daily activity.

---

## Regression tests

| Test file | Purpose |
|---|---|
| `budgetPanel.test.tsx` | Budget CRUD + project-name lookup |
| `themeGallery.test.tsx` | Theme import/export/delete |
| `activityGrouping.test.tsx` | Activity summary grouping |
| `chatStreamLifecycle.test.ts` | Stream/cancel/delete lifecycle |
| `costRollups.test.ts` | Cost aggregation logic |
| `permissionModeMenu.test.tsx` | Permission mode persistence |
| `worktreeSessions.test.tsx` | Git worktree commands |
| `deletedChatTombstone.test.tsx` | Tombstone rendering |
| … and 60+ more | All passing |

---

## Verification commands

```bash
# Frontend
npx tsc --noEmit
npx vitest run
npm run build

# Backend
cargo check
cargo test --lib
cargo build --target-dir target/release
```

> **Current exit codes:** `npx tsc --noEmit` exits non-zero (34 errors); `npx vitest run` exits 0; `npm run build` exits 0; `cargo test --lib` exits non-zero (1 failed test); `cargo build --release` exits 0.
