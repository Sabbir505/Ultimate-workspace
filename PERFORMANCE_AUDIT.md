# Conduit — Performance Audit (Round 3)

**Date:** 2026-08-23
**Scope:** full project (frontend `src/`, Rust backend `src-tauri/src/`, mobile `mobile/`)

> **STATUS: VERIFIED CLEAN** — All items from the 2026-08-14 audit are now verified against current codebase. Gates: `tsc --noEmit clean`, `vitest` 407/407, `cargo test` 502 lib + 4 browser-mcp + 1 smoke = 507 total, `vite build` passes. Entry chunk: 336 KB raw, 108 KB gzip.

---

## Summary — what changed since the last audit (2026-08-14)

| Category | Finding | Status |
|---|---|---|
| Command count | `AI_CONTEXT.md` claimed 134 commands | **UPDATED** → 226 commands |
| Database tables | `AI_CONTEXT.md` listed 15 tables | **UPDATED** → 21 tables |
| Test files | Listed 22 vitest files | **UPDATED** → 59 vitest files / 407 tests |
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

## Key metrics (current)

| Metric | Value |
|---|---|
| Vitest tests | 407 / 407 passing |
| Cargo lib tests | 502 / 502 passing |
| tsc --noEmit | clean |
| Vite build | passes |
| Entry chunk (raw) | 336 KB |
| Entry chunk (gzip) | 108 KB |
| Companion chunk (raw) | ~500 KB |
| Vendor chunk | ~350 KB |

---

## Remaining recommendations (non-blocking)

1. **KaTeX font loading** — fonts still eager (≈500 KB). Consider loading via `rel=preload` with `as=font` or lazy loading on first math render.
2. **Terminal pane size** — xterm.js still ~200 KB on first use. Currently lazy-loaded via `React.lazy` in `App.tsx`.
3. **Document embedding** — full-vector search for RAG adds ~1-2 MB per 1k docs. Acceptable for local-first use case.
4. **Idle DB connection count** — single `Arc<Mutex<Connection>>` is fine for low write volume. Keep under observation if user has 100+ projects with daily activity.

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
| … and 50+ more | All passing |

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

All commands exit with code 0.