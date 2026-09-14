# Relay — Performance Audit (Round 3)

**Date:** 2026-08-27
**Scope:** full project (frontend `src/`, Rust backend `src-tauri/src/`, mobile `mobile/`)

> **STATUS: GREEN (2026-09-06, updated same day).** The 2026-08-27 regressions are fixed: `tsc --noEmit` clean (root + mobile), `npx vitest run` 128 files / 798 tests all passing, `cargo test --lib` 898 passed / 0 failed / 12 ignored, `vite build` passes. The previously-resolved Round 2 findings (PTY batching, react-markdown lazy load, lucide tree-shaking, mobile poll → on-demand, N+1 cost queries, token batching, parallel probes, KaTeX dedup, CSS split) remain resolved. What is *not* green: the entry chunk tripled since the 2026-08-27 audit (459 KB → 1,179 KB raw) and several async chunks remain > 500 KB — see Key Metrics and Remaining Recommendations.

---

## Summary — what changed since the 2026-08-23 audit

| Category | Finding | Status |
|---|---|---|
| Command count | 2026-08-23 audit reported 226 commands | **SUPERSEDED** — 235 at the 2026-08-27 audit; **296 registered** in `generate_handler!` (`src-tauri/src/lib.rs`), 298 `#[tauri::command]` attributes total, as of 2026-09-06 |
| Database tables | 2026-08-23 audit reported 21 tables | **SUPERSEDED** — 21 at 2026-08-27; **42 distinct tables** as of 2026-09-06 (research caches, citation reports, knowledge/MCP/memory growth) |
| Test files | 2026-08-23 audit reported 59 vitest files / 407 tests | **SUPERSEDED** — 68 files / 460 tests at the 2026-08-27 audit; **128 files / 798 tests, all passing** as of 2026-09-06 |
| Cargo lib tests | 2026-08-23 audit reported 502 passing | **RESOLVED** — was 539 passed / 1 FAILED at 2026-08-27; **898 passed, 0 failed, 12 ignored** as of 2026-09-06 |
| `tsc --noEmit` | 2026-08-23 audit reported clean | **RESOLVED** — had regressed to 34 `TS18046` errors (BUG_AUDIT N5); clean again since 2026-09-05 |
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

## Key metrics (current, 2026-09-06)

| Metric | Value | Note |
|---|---|---|
| Vitest tests | **798 / 798 passing** | 128 files, 52s |
| Cargo lib tests | **898 passed, 0 failed, 12 ignored** | 30s |
| `tsc --noEmit` | **clean** | root and `mobile/` |
| Vite build | passes (1m 18s) | Multiple chunks > 500 KB trigger warning |
| Entry chunk (raw) | **1,178.98 kB** ⚠ | `dist/assets/index-Bwht6bAb.js` — was 458.96 KB at the 2026-08-27 audit (~2.5× growth) |
| Entry chunk (gzip) | **357.31 kB** ⚠ | same; was 141.47 KB |
| Entry HTML modulepreload | babel (2,983.88 kB) + syntax (1,593.03 kB) eagerly preloaded | `dist/index.html` modulepreloads both at startup |
| Largest async chunk | 2,983.88 kB raw / 683.80 kB gzip | `dist/assets/babel-BpHB7C9N.js` (unchanged since 2026-08-27) |
| Mermaid core | 597.24 kB / 141.43 kB gzip | `dist/assets/mermaid.core-DqKC7jbH.js` — was 236.91 kB at 2026-08-27 |
| KaTeX | 258.47 kB / 77.57 kB gzip | `dist/assets/katex-HP8lGamR.js` (unchanged) |

---

## Remaining recommendations (non-blocking)

1. ~~**Shrink the entry chunk**~~ **ADDRESSED 2026-09-06** — root causes found and fixed: (a) the `babel`/`syntax` `manualChunks` buckets made Rollup hoist shared module-loader helpers into the `syntax` chunk, so the ENTRY statically imported it (and `syntax → babel`) and index.html modulepreloaded ~4.5 MB at startup — rules removed, default chunking restored, **0 modulepreload tags**; (b) `DocDesignRunner` (statically imported from `App.tsx`) pulled `pdfjs-dist` (~834 KB source) into the entry via `docdesign/rasterize.ts` — the runners are now `React.lazy` and pdf.js is a dynamic import on first probe; (c) KaTeX CSS (~500 KB of fonts) moved from the entry to the lazy `MessageBubble`/`ArtifactPreviewPane` chunks (still one emitted copy). Entry: **1,179 KB → 707 KB raw / 357 KB → 210 KB gzip**. Remaining headroom (optional, next pass): the react-markdown/micromark stack (~450 KB source) rides in the entry via the chat surface's static imports.
2. **Code-split `babel-standalone` and `flowchart-elk`** — both are > 1 MB async chunks that are only needed on certain artifact paths. A `manualChunks` rule would push them behind the artifact dialog.
3. ~~**KaTeX font loading**~~ **ADDRESSED 2026-09-06** — `katex.min.css` now imports from the lazy `MessageBubble`/`ArtifactPreviewPane` chunks instead of the app entry; the CSS (and the font assets it references) arrives with the first chunk that can render math. Vite dedup keeps a single emitted copy (C8 holds).
4. **Terminal pane size** — xterm.js still ~200 KB on first use. Currently lazy-loaded via `React.lazy` in `App.tsx`.
5. **Document embedding** — full-vector search for RAG adds ~1-2 MB per 1k docs. Acceptable for local-first use case.
6. **Idle DB connection count** — single `Arc<Mutex<Connection>>` is fine for low write volume. Keep under observation if user has 100+ projects with daily activity.

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

> **Current exit codes (2026-09-06):** `npx tsc --noEmit` exits 0; `npx vitest run` exits 0; `npm run build` exits 0; `cargo test --lib` exits 0.
