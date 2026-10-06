# Relay desktop E2E — bug ledger

Conventions mirror `../e2e/BUGS.md`: each bug has an id, a severity, the
symptom, evidence (test + screenshot), and a `Tests:` line naming the
guarding test. Tests embed the bug id in their failure messages.

## Fixed by this suite

### AUTOMATIONS-CONFIRM — no delete confirmation ever appeared (window.confirm rejected) (P1, fixed)

Every `window.confirm` guard in the app silently acted as "yes". The webview
shim routes `window.confirm` through `plugin:dialog|confirm`, but
`dialog:default` grants only `allow-message/save/open` — no `allow-confirm` —
so the call rejected with `dialog.confirm not allowed. Command not found`
and returned a (truthy) rejected Promise, which every
`if (window.confirm(...))` test happily passed. Impact: automation, theme,
MCP server, knowledge-corpus, and vault file/folder deletes all executed
immediately with **no prompt at all** (vault deletes are trash-backed;
the others are not).

Found by the suite's console-error capture on a passing test
(`43-automation-pause-delete-cleans-up`):
`dialog.confirm not allowed. Command not found`.

Fix: a promise-based in-app confirm (`src/state/confirm.ts` +
`components/common/ConfirmDialogHost.tsx`, the app's own Modal), converted
at all 7 call sites (automations, themes, MCP gallery, knowledge, vault
tree ×3). This also makes the prompt black-box testable — the modal is DOM.

Tests: `43-automation-pause-delete-cleans-up` (modal appears → Cancel keeps
the row → confirm deletes), `knowledgePanel.test.tsx` (unit: accept removes,
deny does not).

### AUTOMATIONS-DB-DEADLOCK — deleting or toggling an automation froze all DB access (P1, fixed)

`delete_automation` and `set_automation_enabled` held the `DbState` mutex
guard (`let conn = db.0.lock();`) across a trailing
`.map(|_| automation_triggers::sync_fs_watchers(&app, &db.0))` — and
`sync_fs_watchers` takes the same mutex itself. `parking_lot::Mutex` is not
reentrant, so the same thread deadlocked holding the lock: the row write
committed, the command never returned, and **every later DB query in the
app parked forever** (stale lists, spinner-forever views) until restart.

Found by the suite's automation delete/toggle coverage: the E2E delete
click produced an uncaught page error, the row stayed, and subsequent
`list_automations`/`vault_*` IPC calls timed out — reproduced headlessly,
then traced to the lock re-entry (the sibling `create_automation` /
`update_automation` scope their guards, which is why creating always
worked and deleting never did).

Fix: both commands now scope the write's guard (`{ let conn = …; … }`) and
sync watchers after the guard drops, matching the sibling commands and the
repo's "take the DbState handle, not a held guard" lock rule.

Tests: `43-automation-pause-delete-cleans-up` (pause flip + delete),
`41-automation-edit-preserves-identity`, `50-regression-automation-edit-not-create`.

### AUTOMATIONS-STALE-LIST — the automations list never refreshed on re-entry (fixed)

`AutomationsView` gated its mount-time `load()` on `if (!loaded)`, but
`loaded` lives in the module-level `useAutomationsStore` that survives view
unmounts. Once the view had loaded once, every later mount showed the
stale snapshot until the app restarted — anything that mutates automations
behind the view's back (the chat's `create_automation` tool, trigger
bookkeeping, a second window) stayed invisible. Found by
`42-automation-custom-cron-preserved`: the IPC-created automation existed in
`list_automations` but the freshly-mounted view kept rendering the old list
(screenshot `032-FAIL-42-…png` from the first isolated run).

Fix: the mount effect now always calls `load()`; `loaded` keeps its
"trusted snapshot" meaning for other consumers.

Tests: `42-automation-custom-cron-preserved`, `43-automation-delete-cleans-up`.

## Open

### BUG-11 — turns can stall silently forever (P1, carried over from mobile BUG-4/BUG-11)

Send a chat turn on the OpenCode free rail (`opencode/fledge-alpha-free`) and
the request can wedge with **no Stop button, no error banner, no reply, and
no sidebar "Working" dot** — the turn simply never resolves. The desktop has
no per-turn timeout, so nothing ever surfaces the failure; the user must
guess and start a new chat. Observed repeatedly during E2E runs
(`12-stop-mid-stream-clears-state`, `51-`, `53-` on 2026-10-07), consistent
with the mobile finding that free-rail requests stall pre-first-token.

Fix direction: a per-turn deadline in `src-tauri/src/chat` (surface an
error event + persist partial state on expiry).

Tests: `12-stop-mid-stream-clears-state`, `51-regression-streaming-cancel-restores-composer`
(stall detection produces a distinct `turn stalled silently` failure).

## Guarded (fixed bugs kept as regressions)

### BUG_LIST-H14 — "Edit" on an automation opened the CREATE form (fixed)

Editing an automation pre-filled the create form; saving duplicated the row.
Fixed via the `__edit__:` selected-id prefix in `AutomationsView.tsx`.

Tests: `41-automation-edit-preserves-identity`, `50-regression-automation-edit-not-create`.

### ROUND2-A14 — editing an automation rewrote non-preset crons (fixed)

The schedule select lost the stored cron on edit and saved the default
`0 9 * * 1-5` instead. Fixed with the "Current: <cron>" option.

Tests: `42-automation-custom-cron-preserved`.

### ROUND2-A3 / BUG_LIST-L12 — cancel left the streaming state stuck (fixed)

A cancelled turn kept the sidebar "Working…" dot and the composer in the
stop state forever.

Tests: `12-stop-mid-stream-clears-state`, `51-regression-streaming-cancel-restores-composer`,
`52-regression-stop-button-vs-empty-composer`.

### ROUND2-A4 — deleted streaming chat resurrected (fixed)

Orphaned streaming tokens could resurrect a deleted session.

Tests: `53-regression-session-deleted-stays-deleted`.

## Observations (not yet bugs, watched by tests)

- **Session titles are prompt prefixes** ("Reply with the single word R…"),
  not LLM-generated titles, on the OpenCode free rail — auto-titling appears
  model-dependent. Watched by `13-session-row-appears-and-titles`.
- **The companion pet sprite intercepts clicks** on whatever it strolls
  over (its carrier div has `pointer-events: auto`). Charming, but on a UI
  this dense it can swallow a click on sidebar rows. The harness tolerates
  it; a `pointer-events: none` carrier with a dedicated drag handle would
  remove the risk.
- **A stale `vault.root`** (folder deleted elsewhere) surfaces a clean
  "folder no longer exists" error from the vault IPC (`current_root`), but
  the vault VIEW can keep showing a bound state from its store after a
  frontend crash — watched by `44-vault-note-lifecycle`'s bind-if-unbound
  guard.
- **Isolation incident (2026-10-07, resolved)**: the first runs executed
  against the user's REAL profile because `target/debug/relay.exe` was
  stale — locked by a running `tauri dev`, so it predated the
  `RELAY_APP_DATA_DIR` override in `user_dirs.rs`, and nothing failed
  loudly. Test sessions and automations landed in the live DB and
  `vault.root` was overwritten. Cleaned up with
  `repair-real-profile.mjs` (app-cascade deletes + setting restore), and
  the harness now refuses to launch a binary without the override literal
  plus asserts `get_chat_db_path()` resolves inside the sandbox at boot
  (see the Isolation contract in README.md).
