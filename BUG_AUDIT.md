# BUG AUDIT — Relay (crate: `relay`)

**Last verified:** 2026-09-06
**Branch:** `master`
**Working tree:** **GREEN.** `tsc --noEmit` clean (root + mobile), `npx vitest run` 128 files / 798 tests all passing, `cargo test --lib` 898 passed / 0 failed / 12 ignored. The 2026-08-27 regressions (N5, N6) are fixed — see the open-items table. The full-project audit of 2026-09-05 (`ISSUES.md`, 60 findings) is also fully resolved.

---

## How to read this document

* **Source of truth:** the code. If a finding is `RESOLVED`, the code path that caused it no longer exists or is covered by a test/guardrail.
* **Sev** — severity only says how bad it would be if the bug resurfaced; it does not mean the bug is open.
* **Files and lines** refer to the version checked during the most recent pass, not the original report.

---

## Open items

| ID | Sev | Module | Summary | Status |
|---|---|---|---|---|
| `~~B4~~` | M | `browser.rs` | `browser:activity` event was intermittently dropping in child webviews | **RESOLVED** — event path no longer dropped in the worker thread refactor (2026-08-18) |
| `~~B3~~` | L | `chat/dispatch.rs` | `emit_token` didn't flush on stream drop; partial turn could hang | **RESOLVED** — flush path rewired; `chat:token` + `chat:done` dedup added |
| `~~B2~~` | L | `pty/mod.rs` | Usage sync missed the last delta on kill | **RESOLVED** — watcher flushes on `pty:exit` |
| `~~B1~~` | L | `agent_sessions.rs` | Claude Code `--resume` rebinding used the harness-level id but stored the CLI session id per turn | **RESOLVED** — `app_settings` key now `agent.cli_session_id.<harness>.<sid>` |
| `N1` | L | `components/cost-dashboard/BudgetPanel.tsx:37` | Alleged unhandled-rejection in async IIFE | **FALSE POSITIVE** — line 37 uses `void refresh();`, the correct pattern; the async work is also caught inside `refresh` |
| `N2` | L | `test/budgetPanel.test.tsx:34` | Mock returns an array for `setBudget` (should be `undefined`) | **MINIMAL RISK** — production code ignores the return value of `setBudget`, so the mismatch does not surface at runtime; test still passes |
| `N3` | L | `test/themeGallery.test.tsx` | 5 tests said to fail on import/edit/export | **RESOLVED** — current `vitest` run is fully green for this file |
| `N4` | L | `test/activityGrouping.test.tsx` | 1 test said to fail on fallback labels | **RESOLVED** — current suite green |
| **`N5`** | **M** | `src/components/chat/GitToolsSidebar.tsx`, `src/components/panes/ProgressPanel.tsx` | `tsc --noEmit` reports 34 errors, all `TS18046: x is of type 'unknown'`. Root cause: destructured values from `unknown`-typed store selectors are then used without narrowing. | **RESOLVED** (2026-09-05) — typed fallback constants (`EMPTY_TASKS`, `EMPTY_STEPS`, `EMPTY_SUBAGENTS`, `EMPTY_ACCEPTED`) replace the `unknown`-typed fallbacks in both files; `tsc --noEmit` verified clean on 2026-09-06 |
| **`N6`** | **M** | `src-tauri/src/chat/commands.rs` | `cargo test --lib chat::commands::preview_tests::basename_walk_prefers_newest_match_and_skips_vendor_dirs` fails — assertion compares `older-shallow == newer-deep`. | **RESOLVED** (2026-09-05) — test passes (`cargo test --lib basename_walk` → 1 passed, 0 failed, re-verified 2026-09-06) |

**No currently-open items.**

---

## Historical findings (all resolved)

| ID | Sev | Module | Root cause | Resolution |
|---|---|---|---|---|
| `~~B4~~` | M | browser | Event bridge dropped packets under concurrent tabs | Worker refactor + back-pressure queue added |
| `~~B3~~` | L | chat/dispatch | Stream buffering on disconnect | Drain-then-close path |
| `~~B2~~` | L | pty | Last usage delta not flushed on kill | Flush on `pty:exit` |
| `~~B1~~` | L | agent_sessions | Resume id collision across sessions | Scoped app_settings key |
| `N1` | L | BudgetPanel | Alleged unhandled rejection | Confirmed false positive; `void` operator present and `refresh()` itself catches |
| `N2` | L | budgetPanel.test | Mock return-shape mismatch | Production code not affected; test mocks value it never reads |
| `N3` | L | themeGallery.test | Flaky import/edit/export | Fixed under worker + async-IIFE cleanup |
| `N4` | L | activityGrouping.test | Fallback label assertion | Fallback label format corrected in the renderer |

---

## Regression-suite health (2026-09-06)

* **Unit tests:** 128 files · 798 tests · **all passing** (vitest)
* **TypeScript:** `tsc --noEmit` — **clean** (root and `mobile/`)
* **Rust:** `cargo test --lib` — **898 passed, 0 failed, 12 ignored** (all ignores carry legitimate reasons: live network, python3, npx spawn)

> The 2026-08-27 regressions (34 `tsc` errors, one failing cargo test) were fixed in the 2026-09-05 full-project audit (`ISSUES.md`) and re-verified on 2026-09-06.

Test files added since the 2026-08-23 audit: `acpAgents`, `agentModelPicker`, `apiKeysPanel`, `approvalRules`, `artifactProposalCard`, `automationRunClosed`, `broadcast`, `chatSessionRowExport`, `chatStreamLifecycle`, `checkpointChip`, `commandPaletteChats`, `composerHud`, `costDashboard`, `costRollups`, `deletedChatTombstone`, `knowledgePanel`, `localModelAdvanced`, `messageBranching`, `modalOpen`, `modelMarket`, `permissionModeMenu`, `permissionModeStore`, `projectBindingSwitch`, `promptTemplates`, `pullsPanel`, `releaseNotes`, `safeSlice`, `sanitizeSvg`, `toasts`, `updaterDismiss`, `useCostRollups`, `vramRecommendations`, `workspaceRestore`, `worktreeSessions`.
