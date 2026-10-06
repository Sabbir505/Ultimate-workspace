# Relay mobile E2E harness

Black-box end-to-end tests for the **Relay mobile app** running in Expo Go on
a USB-connected Android phone, driving the real desktop relay over the USB
bridge. No test framework — plain Node (v18+) over `adb` (uiautomator dumps +
`input` taps + screenshots).

## What it needs

| Piece | Detail |
|---|---|
| Phone | Android with USB debugging, app open in **Expo Go** |
| adb | `platform-tools` (the setup script downloads it to `~/relay-e2e-tools`) |
| Bridges | `adb reverse tcp:8081 tcp:8081` (Metro) and `adb reverse tcp:50672 tcp:50672` (relay) — the suite re-adds them |
| Desktop | `relay.exe` (debug build) running; the relay port is read from `%APPDATA%/dev.relay.app/relay.db` (`mobile.relay_port`) |
| Token | `e2e/.pairing-token` — 43-char pairing token from the desktop keychain |

### One-time setup

```bash
# adb (via the working proxy on this machine)
mkdir -p ~/relay-e2e-tools && cd ~/relay-e2e-tools
curl -x http://127.0.0.1:17890 -L -o platform-tools.zip \
  https://dl.google.com/android/repository/platform-tools-latest-windows.zip
unzip -oq platform-tools.zip

# bridges + token (from the desktop keychain, service dev.relay.app,
# account relay:mobile:pairing-token)
export PATH="$HOME/relay-e2e-tools/platform-tools:$PATH"
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:50672 tcp:50672
```

The repo's `.gitignore` excludes `e2e/artifacts/`, `e2e/results.json` and
`e2e/.pairing-token` — never commit the token.

## Running

```bash
cd e2e
node run-e2e.mjs                 # full suite (≈35 tests)
node run-e2e.mjs --list          # list tests
node run-e2e.mjs --only 35       # name substring filter
```

Output: live pass/fail lines, `e2e/results.json` (structured), screenshots in
`e2e/artifacts/NNN-<test>.png` (plus `FAIL-<test>.png` on failure).

## Layout

```
e2e/
  harness.mjs        adb driver: dump/tap/type/swipe/screenshot, app control,
                     desktop start/stop/health, token reader
  app.mjs            Relay chrome navigation: Home detection (paired +
                     unpaired), drawer, Settings, Manage rows, dev-menu
                     handling, status pill
  tests/core.mjs     01-05  cold start, connection pill, pairing round-trip
                     (disconnect → wrong token rejected → reconnect), drawer, model sheet
  tests/chat.mjs     10-12  chat round-trip + streaming, drawer persistence,
                     search + reopen transcript
  tests/screens.mjs  20-29  every drawer/Settings destination: artifacts, cost,
                     automations, memory, skills, git, notifications, terminal,
                     wiki, vault
  tests/depth.mjs    40-49  INSIDE each section: memory record editor, vault
                     tree/note reader, wiki project→page, automation editor,
                     skill body, git diff panel, artifact preview,
                     notifications actions, budget editor, per-chat model
  tests/resilience.mjs 30-34  app-driven disconnect/reconnect, background/
                     foreground, deep-link pairing guard (M19), attach →
                     document picker, theme toggle
  tests/bugs.mjs     35-38  regression tests for the bugs in BUGS.md
  tests/util.mjs     chat/session helpers (cloud session, model selection on
                     the OpenCode free models, reply-token waits)
```

## Conventions & gotchas (learned the hard way)

- **A reply token is never a substring of its own prompt.** Tests ask for
  "the 5 letters Z E B R A run together" so the user bubble ("Z E B R A") can
  never satisfy the reply assertion (`ZEBRA`).
- **The composer's Enter inserts a newline** — the send path is the orange ↑
  button (content-desc `Send message`).
- **Home has no gear button**; Settings lives in the drawer footer. In dev
  builds Expo Go's floating dev-menu button sits at the same top-right spot —
  the harness detects and dismisses that overlay (`devMenuOpen`).
- **Never press system Back on Home** — it exits Expo Go; `goHome()` prefers
  the on-screen Back affordance, then drawer → "New chat", and only as a last
  resort (with app-relaunch verification) a guarded Back for modals.
- **Tests never kill the desktop app.** Earlier revisions did (to test
  reconnect); that closes the user's app if a run is interrupted. Restart
  testing is app-driven (Settings → Disconnect / Connect).
- **The local GGUF model does not complete phone turns** (BUG-4) — tests that
  need a working turn use an **OpenCode free model**
  (`ensureModelSelected` → OpenCode rail → `ling-3.1-flash-free`).
- Some tests are **expected to fail until the bug is fixed** — see BUGS.md;
  each failure message names the bug and the file:line.
