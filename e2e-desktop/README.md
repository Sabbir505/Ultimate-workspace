# Relay desktop E2E harness

Black-box end-to-end tests for the **Relay desktop app** (Tauri v2 + WebView2)
on Windows, driving the real app window over the Chrome DevTools Protocol.
No test framework — plain Node (v18+) with `puppeteer-core` (already a
devDependency). The desktop counterpart of `../e2e/` (the mobile adb
harness): same conventions — numbered screenshots, structured results,
depth tests inside every surface, bug regression tests.

## How it works

1. **Sandboxed instance.** The suite launches the real `relay.exe` (debug
   build) with:
   - `RELAY_APP_DATA_DIR=<temp-sandbox>/data` — a repo feature added for
     this harness (`src-tauri/src/user_dirs.rs`): the whole app-data
     profile (relay.db, settings) is redirected to a throwaway dir. The
     sandbox DB is **seeded from the real one** so providers, settings and
     history exist, but every write the tests make lands in the sandbox —
     the user's real app data is never touched and their running instance
     is unaffected (the mobile relay falls back to an ephemeral port on
     bind failure).
   - `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<free>`
     — CDP on the WebView2.
   - `WEBVIEW2_USER_DATA_FOLDER=<temp-sandbox>/webview2` — isolated
     WebView2 profile (no lock conflict with a running app).
2. **Frontend.** Debug builds load `devUrl` (`http://localhost:1500`), so a
   Vite dev server must be up. The harness reuses a running one or starts
   its own.
3. **Drive the DOM.** puppeteer-core connects over CDP to the main window.
   Clicks are real mouse events at atomically-located coordinates (fresh
   measure + `scrollIntoView` + topmost hit-test in the same tick, so
   re-renders, scroll clipping, overlay coverage, and the walking pet
   sprite can't cause stale-coordinate mis-clicks). Setup that native OS
   dialogs block (vault folder pick) uses Tauri IPC directly, clearly
   marked setup-only; every assertion goes through the UI.

## What it needs

| Piece | Detail |
|---|---|
| OS | Windows (WebView2); the app itself must build |
| relay.exe | `src-tauri/target-e2e/debug/relay.exe` — `cd src-tauri && CARGO_TARGET_DIR=target-e2e cargo build --bin relay` (override with `RELAY_EXE`; the harness refuses to launch a binary without the sandbox override) |
| Frontend | Vite dev server on :1500 (auto-started if absent; override with `RELAY_DEV_URL`) |
| node_modules | `npm install` at the repo root once (puppeteer-core + vite) |
| Keys | Chat provider keys live in the **OS keychain** (machine-global), so sandboxed instances resolve them; real-turn tests use whatever provider the cloned profile has |

## Isolation contract (read before touching the harness)

The suite launches the app with `RELAY_APP_DATA_DIR` pointing at a throwaway
dir (feature added in `src-tauri/src/user_dirs.rs`), seeded from a copy of
the real DB, plus its own `WEBVIEW2_USER_DATA_FOLDER`. Three layers of
defense, added after the suite once ran against the user's **real** profile
because `target/debug/relay.exe` was stale (locked by a running
`tauri dev`, so it predated the override) — the clone's `storage.dbDir`
redirect and identical-looking seed data made it non-obvious:

1. **Binary check** — the harness greps the exe for the
   `RELAY_APP_DATA_DIR` literal and refuses to launch without it.
2. **Boot guard** — after connect, the runner invokes `get_chat_db_path`
   and aborts the whole suite unless the resolved DB is inside the sandbox.
3. **Repair tool** — `repair-real-profile.mjs` launches the app on the real
   profile and removes E2E artifacts via the app's own cascade (sessions by
   title prefix, `E2E *` automations) and restores `vault.root`. It was used
   once for real; keep it for the next incident.

Never "temporarily" bypass these. The mobile suite's rule applies doubly
here: tests never kill the user's app, and they never write to the user's
profile.

## Running

```bash
cd e2e-desktop
node run-e2e.mjs                 # full suite (48 tests)
node run-e2e.mjs --list          # list tests
node run-e2e.mjs --only vault    # name substring filter
RELAY_E2E_KEEP_SANDBOX=1 node run-e2e.mjs   # keep the sandbox for debugging
node repair-real-profile.mjs     # incident tool: see "Isolation contract"
```

Output: live pass/fail lines, `e2e-desktop/results.json` (structured,
including per-test console/page errors), screenshots in
`e2e-desktop/artifacts/NNN-<label>.png` (plus `FAIL-<test>.png`).

Latest full run: **46 passed, 0 failed, 2 skipped** (~4.5 min). The two
skips are honest: the free-rail provider turn wedged mid-stream (BUG-11 —
no per-turn timeout), so the cancel path could not be exercised; the tests
skip with the bug named instead of flaking red.

## Layout

```
e2e-desktop/
  harness.mjs        CDP driver: sandbox+launch+connect, exe-override check,
                     DOM dump, atomic specificity-ranked clicks, waits,
                     screenshots, Tauri IPC escape hatch
  app.mjs            Relay chrome navigation: goHome, overlays, full-page
                     views, palette, composer/send/turn-state helpers
  repair-real-profile.mjs  one-off repair for the isolation incident (see
                     "Isolation contract"); deletes E2E residues via the
                     app's own cascade and restores settings
  tests/core.mjs     01-09  cold start paints shell, console-clean boot,
                     new chat, command palette, settings categories,
                     notification bell, tool panel terminal tab, hotkey overlay
  tests/chat.mjs     10-19  composer gating, REAL turn round-trip, stop
                     mid-stream, session titling, reopen transcript,
                     palette session search, rename, delete (IPC
                     cross-check), empty-composer
  tests/screens.mjs  20-29  every destination: skills, cost, automations,
                     vault (sandbox-bound), wiki, logs, projects panel,
                     pairing QR, artifacts modal, quiet updater
  tests/resilience.mjs 30-34 sidebar collapse, window maximize/restore,
                     full page reload recovery, fork to split panes, app zoom
  tests/depth.mjs    40-49  INSIDE each surface: automation create/edit/
                     pause/delete roundtrip (incl. H14 + A14 + confirm),
                     vault note lifecycle + search, memory/subagents/
                     local-models panels, git sidebar, theme switching
  tests/bugs.mjs     50-53  regression tests, one per bug id in BUGS.md
  BUGS.md            desktop bugs the suite found / guards
```

## Conventions & gotchas (learned the hard way)

- **Atomic clicks only.** Reading coordinates in one `dumpUi` and clicking
  in the next tick loses races against React re-renders and slide-in
  menus. `clickText`/`clickAria` locate + hit-test + click in one
  evaluate, and prefer a *topmost* candidate so a button behind an overlay
  (e.g. the toolbar bell behind Settings) is never clicked through it.
- **The pet sprite is a click-blocker.** The companion pet's carrier div
  intercepts real clicks wherever it's strolling. The locator prefers
  topmost candidates and falls back to a covered one only when there is no
  alternative (what a patient user would do).
- **Modifier chords.** puppeteer's `press()` takes single keys; the
  harness's `pressKey("Control+k")` chords it (down → press → up).
- **A reply token is never a substring of its prompt** (inherited from the
  mobile suite): tests ask for e.g. "the single word TITLETEST".
- **Turns can stall silently** — a free-provider request can wedge with no
  Stop button, no error banner, and no reply, because turns have no
  per-turn timeout (BUG-11 in `BUGS.md`). `waitForTurnDone` detects this
  and fails with a distinct stall message instead of burning the timeout.
- **Settings overlays are lazy chunks** — wait for `.settings-modal`, not
  for the word "Settings" (the footer gear button matches first).
- **Vault writes go to the sandbox**: the runner rebinds `vault.root` to a
  scratch folder at boot (`vault_bind`, setup-only) because the cloned DB
  carries the user's real vault path. Do not remove that boot step.
- **Tests never kill the app or log the user out**; everything destructive
  happens inside the sandbox profile, which is deleted after the run
  (keep it with `RELAY_E2E_KEEP_SANDBOX=1`).
- `window.confirm` (automation delete) is auto-accepted by the harness.
