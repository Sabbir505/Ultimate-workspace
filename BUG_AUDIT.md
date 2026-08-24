# BUG AUDIT — Conduit

**Last verified:** 2026-08-23
**Branch:** `master`
**Working tree:** All H/M items from the 2026-08-17 audit are resolved. Re-ran `vitest` (59 files / 407 tests), `tsc`, and `cargo test` — all green.

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
| `N3` | L | `test/themeGallery.test.tsx` | 5 tests said to fail on import/edit/export | **RESOLVED** — `vitest` now passes all 59 files / 407 tests; import/edit/export paths verified |
| `N4` | L | `test/activityGrouping.test.tsx` | 1 test said to fail on fallback labels | **RESOLVED** — current suite green |

**No currently-open Sev H or M items.**

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

## Regression-suite health

* **Unit tests:** 59 files · 407 tests · **all passing**
* **TypeScript:** `tsc --noEmit` clean
* **Rust:** `cargo test` clean

New test files added since the last audit (2026-08-17): `acpAgents`, `agentModelPicker`, `apiKeysPanel`, `approvalRules`, `artifactProposalCard`, `automationRunClosed`, `broadcast`, `chatSessionRowExport`, `chatStreamLifecycle`, `checkpointChip`, `commandPaletteChats`, `composerHud`, `costDashboard`, `costRollups`, `deletedChatTombstone`, `knowledgePanel`, `localModelAdvanced`, `messageBranching`, `modalOpen`, `modelMarket`, `permissionModeMenu`, `permissionModeStore`, `projectBindingSwitch`, `promptTemplates`, `pullsPanel`, `releaseNotes`, `safeSlice`, `sanitizeSvg`, `toasts`, `updaterDismiss`, `useCostRollups`, `vramRecommendations`, `workspaceRestore`, `worktreeSessions`.