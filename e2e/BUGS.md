# Relay mobile — E2E bug report (2026-10-06)

## FIX STATUS (updated after the fix pass)

| Bug | Status | Fix | Verified |
|---|---|---|---|
| BUG-1 Worked-chip duration | **FIXED** | `protocol.rs` now carries `started_at`/`completed_at`; phone normalizes the snake_case wire (`useRelay.normalizeSessionMessage`) and stamps live turns; the fold chip is a plain row (no card/border) | Visual: "Worked for 8s"/"Worked for 36s" chips render (`artifacts/state-now2.png`) |
| BUG-2 composer clipped | **FIXED** | bottom inset + breathing room reserved under the composer (`SessionChat.tsx`, `useSafeAreaInsets`) | `36-regression-composer-bottom-clearance` **PASSES** (was 26px clearance) |
| BUG-3 watchdog re-send storm | **FIXED** | `useSessionChat.armTurnWatchdog` waits & reconciles (`getSessionMessages`) instead of cancel+re-dispatch; banner "Still waiting for the model — N/10…"; no duplicate bubbles, no duplicate sends | Live: one bubble + banner, no duplicates (`artifacts/state-now2.png`) |
| BUG-4 desktop self-deadlock | **FIXED** | `session_chat.rs:762` used `artifacts_dir(app)` **while holding `db.lock()`** — a documented non-reentrant self-deadlock; now `artifacts_dir_locked(&conn, app)` | **LOCAL MODEL turn verified**: phone → Spark-X2.5-4B → reply "ZEBRA" in 1m9s (`artifacts/001-38-local-model-state.png`), log shows `5d: fs_roots listed` completing; cloud turn "HELLO7" in 10s |
| BUG-5 request storm | **FIXED** | `_sendCoalesced` (2s window) for ListAcpAgents/ListConnectors/GetSessionConnectors + ref-guarded fetch effects in SessionChat/HomeScreen | Relay log rate **~1,070 lines/8s → 6 lines/10s** |
| BUG-8 update-depth loop | **MITIGATED** | the effects that re-fired per render pass are now ref-guarded; storm gone. No dedicated repro test yet | Indirect (storm + dup refetch gone) |
| BUG-10 stuck-loading chat | **IMPROVED** | root cause was BUG-4 half-committed turns; with the deadlock fixed new turns don't strand sessions. Old poisoned rows still loading | New sends complete; legacy stuck rows not repairable in place |
| BUG-6/7 artifact preview refusal | **FIXED** | `ListArtifacts` (mobile/relay.rs) filters to the same containment roots the preview arm enforces | `46-depth-artifact-preview` **PASSES** — tile opens the Markdown reader |

### New finding from the fix pass — BUG-11: opencode free-model turns can stall the agent spawn

`opencode/mimo-v2.6-flash-free` wedged a phone turn *before* "provider resolved"
(the desktop log shows `harness check done` with nothing after; the turn never
errors out — no per-turn timeout). `opencode/ling-3.1-flash-free` replies with a
billing/quota notice instead of an answer. **`opencode/fledge-alpha-free`
responds in ~10s and is the suite's default free model now.**

Device: Tecno **PJX110** (Android 16), app in **Expo Go**, connected over USB
(`adb reverse tcp:8081` + `tcp:50672`) to the desktop relay (debug build,
`relay.exe`, loopback 127.0.0.1:50672). Suite: `e2e/` (see README.md).
Evidence for every item is a screenshot in `e2e/artifacts/` or a log line with
a file:line reference.

Severity: P0 = blocks all phone usage · P1 = core flow degraded ·
P2 = cosmetic/UX · P3 = dev-noise.

---

## BUG-3 — the watchdog re-sends the last message into the transcript (P0)

**Symptom (as observed live):** after a turn gets no token, the phone shows a
status banner *"Model is slow to respond — retrying (attempt 1/10)…"* **and
appends the same user message as a NEW bubble each attempt** — the transcript
fills with duplicates instead of a quiet background retry.

**Evidence:** `artifacts/EVIDENCE-BUG3-retry-storm.png` — the ZEBRA prompt is
present **4×** (1 original + 3 re-dispatches) with the banner visible, plus
`artifacts/003-FAIL-10-new-chat-roundtrip-streaming.png` from an earlier run.

**Root cause:** `mobile/src/hooks/useSessionChat.ts:601-639` (`armTurnWatchdog`).
On no-first-token it calls `cancelSessionStream()` then
`dispatchRef.current?.(t.text, t.attachments, true)` — a full re-dispatch, which
prepends a fresh user message (`dispatchTurn`, line ~583) and posts a **new
`SendChatMessage`** to the desktop. Wait is 75s (cloud) / 180s (`local_gguf`),
up to 10 attempts.

**Expected:** retry silently (no new bubble; ideally re-attach to the same
turn/message id) and surface only the progress banner the user described
("reconnecting x/10").

**Tests:** `37-regression-retry-storm` (observer mode; fails when duplicates
appear).

---

## BUG-4 — phone-originated turn wedges the desktop relay (P0)

**Symptom:** the phone shows "Working for Xs" forever; the model picker never
lists models; other relay ops (memory/git/…) stop answering. The desktop UI
shows a running turn with **no agent selected**.

**Evidence (logs + screens):**
- `%APPDATA%/dev.relay.app/logs/relay-stderr.log` line 25117:
  `SendChatMessage[fd766f5d…]: 5d: fs_roots start` — and **nothing after it**;
  the log stops growing entirely (checked at 6s and 10s intervals).
- Sister stall during the first incident: same file, msg
  `SendChatMessage[8617d534…]: 5d: fs_roots start`.
- `artifacts/debug-ling.png` (4:20) — model sheet spinner with zero rows while
  the relay is in this state (the harness-model catalog never answers).
- `artifacts/debug-now.png` and log line
  `SendChatMessage[fd766f5d…]: user message persisted` — the user message IS
  persisted, so the session is left with a half-committed turn.

**Root cause (pinpointed):** `src-tauri/src/mobile/session_chat.rs:762`
(`step_trace("5d: fs_roots start")`) — the block takes `db.lock()` (line 764)
and never reaches `step_trace("5d: fs_roots listed")` (line 773). The desktop
is single-threaded on the DB mutex for relay work, and **BUG-5's request storm
hammers `db.lock()` ~60×/s**; combined with BUG-3's duplicate sends (each a
second concurrent `SendChatMessage` on the same session), the send path stalls
with the lock held. Everything else queues behind it.

**Expected:** the send path must not hold the DB mutex across project/root
resolution (read the data, drop the lock, then proceed), and concurrent sends
on one session must be rejected/serialized explicitly.

**Tests:** `38-regression-local-model-turn` (reproduces; report-only — never
restarts the desktop), `10-new-chat-roundtrip-streaming` (recovers only by
manual restart).

---

## BUG-10 — a session touched by a failed turn is stuck "loading" forever (P0)

**Symptom (user-reported, reproduced):** "that specific chat starts in a
loading step, so it doesn't work anymore" — reopening the session shows the
spinner and never paints the transcript; the composer never appears.

**Evidence:** `artifacts/001-FAIL-12-session-reopen-renders-transcript.png`
(session body only shows a spinner after 25s+). The new
`enterCloudSession` helper needed an explicit retry loop precisely because
entering such a row leaves a composer-less loading scene.

**Cause:** the same half-committed turn from BUG-4 (message persisted, no
`ChatDone`) — `GetSessionMessages` either never answers (relay wedged) or the
phone's transcript loader waits on a turn state that never resolves.

**Expected:** a session with a dangling turn must still render its transcript;
the in-flight turn should be marked failed/aborted and the composer usable.

**Tests:** regression is implicit in every test that opens a session
(`enterCloudSession` throws `every commandcode session stayed in the loading
state (BUG-10)` when this happens).

---

## BUG-1 — process fold chip shows plain "Worked" instead of "Worked for Xs" (P2)

**Symptom (user-reported, reproduced visually):** completed turns read
**"Worked"** — the desktop shows "Worked for 12s".

**Evidence:** `artifacts/003-FAIL-10-new-chat-roundtrip-streaming.png` (2:29)
and `artifacts/EVIDENCE-BUG3-retry-storm.png` — both chips read "Worked" with
the chevron.

**Root cause:** `mobile/src/components/chat/MessageBubble.tsx:223` —
`workedForSec != null && workedForSec > 0 ? 'Worked for …' : 'Worked'`. The
duration never reaches the phone, so it always takes the plain-label fallback.
(Widget styling is separate: the chip also carries `borderColor`/`background`
at line 229 — the user asked for no background/border.)

**Tests:** `35-regression-worked-chip-parity`.

---

## BUG-2 — chat composer clipped by the gesture bar (P2)

**Symptom (user-reported):** the chat composer sits too low and clashes with
the home-indicator/gesture area.

**Evidence (measured):** `artifacts/36-composer-clearance.png` and the test
output — the composer input's bottom edge is at **y=2350 of 2376** →
**26 px** clearance. The keyboard-avoiding wrapper passes a literal
`keyboardVerticalOffset={0}` on Android (`SessionChat.tsx:578`).

**Expected:** lift the composer and reserve bottom space (≥96 px) so it never
touches the gesture zone. **Tests:** `36-regression-composer-bottom-clearance`.

---

## BUG-5 — continuous relay request storm from the phone (P1)

**Symptom:** the desktop relay log grows continuously with
`<- ListConnectors` / `<- ListAcpAgents` / `<- GetSessionConnectors` even when
the user does nothing.

**Evidence:** measured **1 070 log lines in 8 s (~134/s)** on Home and 995/8s
inside a session (both scenes — it is app-global). Log line 92 348 onward in
`relay-stderr.log`.

**Root cause (prime suspect):** `SessionChat.tsx:88-109` — the effects that
`listAcpAgents()` / `listConnectors()` / `getSessionConnectors(sid)` run on
`[connected, sessionId, …]`; when the component re-renders in a loop the
subscribing effect re-fires each pass (see BUG-8). Each pass sends three relay
requests. This storm is also what makes BUG-4's `db.lock()` stall likely.

**Expected:** these fetches are mount/connect-scoped (guard with a ref or
`useEffect` on `[connected]` with a `sessionId` ref), and the storm disappears.

---

## BUG-8 — persistent "Maximum update depth exceeded" toast (P1)

**Symptom:** a red toast *"Maximum update depth exceeded. This can happen…"*
appears on the app and stays for minutes (RN dev overlay; in release it would
be a CPU-burning render loop).

**Evidence:** `artifacts/debug-gear.png` (3:57) and
`artifacts/003-FAIL-46-depth-artifact-preview.png` (3:51) — the toast visible
over Home/Artifacts.

**Cause:** a component calls `setState` inside a render/effect loop — the
`SessionChat` connector effects (BUG-4/BUG-5 area) and `screenCache` writers
are the likely sites.

**Expected:** no render loop; the overlay never appears in a clean run.

---

## BUG-6 / BUG-7 — artifact tiles the desktop refuses to preview (P2)

**Symptom:** tapping some artifacts surfaces the red relay error bar
**"artifact path is outside the artifacts directory"** instead of a preview.

**Evidence:** `artifacts/003-FAIL-46-depth-artifact-preview.png` (3:51).

**Cause:** the artifact library lists entries recorded from paths outside the
artifacts directory (e.g. project-relative outputs); the phone previews them
via `ArtifactPreview` and the desktop's path guard rejects them — a raw error
bar for a library item the app itself listed.

**Expected:** either don't list un-previewable entries, or disable their tap,
or preview from the recorded absolute path with a clear message.

**Tests:** `46-depth-artifact-preview` (flags the error explicitly).

---

## Notes — not bugs, but worth knowing

1. **The desktop "closing" during test runs was the test harness**, not the
   app: tests 30/37/38 deliberately stopped `relay.exe` to test reconnect
   paths, and an interrupted run could leave it down. All desktop-killing has
   been **removed from the tests**; the runner also auto-starts the relay at
   suite start and repairs it on exit.
2. Windows logged ONE `RADAR_PRE_LEAK_64` heuristic warning for `relay.exe`
   (2026-09-30, `0.6.0.0`). No crashes (`Application Error`) events and no Rust
   panics were found on 2026-10-06. If the storm (BUG-5) runs for hours, the
   leak heuristic is worth re-checking — but on the tested build the "closing"
   was the harness.
3. The **local GGUF model** (`local_gguf` / Spark-X2.5-4B) never completed a
   phone-originated turn during testing — it is the trigger for BUG-3's
   watchdog storm (180 s window, then re-sends). Treat local turns as blocked
   until BUG-3/BUG-4 are fixed.
4. The model sheet's catalog is served by the desktop; while the relay is in
   the BUG-4 stall it shows an eternal spinner and the session chip degrades
   to a bare "Model" (no name) — both symptoms of the same wedge.

---

## Reproduction quick-start

```bash
# 1) USB: phone in Expo Go, `adb reverse tcp:8081 tcp:8081` + `tcp:50672`
# 2) Desktop relay running (start it if not)
cd e2e && node run-e2e.mjs --list
node run-e2e.mjs --only 35-regression   # Worked chip        (BUG-1)
node run-e2e.mjs --only 36-regression   # composer clearance (BUG-2)
node run-e2e.mjs --only 37-regression   # retry storm        (BUG-3, observer)
node run-e2e.mjs --only 38-regression   # local model wedge  (BUG-4/10)
```


---

## Post-fix verification run (2026-10-06 evening)

| Test | Result | Note |
|---|---|---|
| 10-new-chat-roundtrip-streaming | ✓ 107s | full phone→relay→desktop→stream pipeline on the rebuilt desktop |
| 35-regression-worked-chip-parity | ✓ 142s | "Worked for Xs" from wire timestamps |
| 36-regression-composer-bottom-clearance | ✓ | clearance restored |
| 37-regression-retry-storm | ✓ 301s | fast model → no watchdog window, no storm |
| 30-relay-drop-shows-offline | ✓ 107s | Disconnect → unreachable → Connect → Connected (manual Disconnect stays offline by design) |
| 03-pairing-roundtrip-settings-ui | ✓ 176s | disconnect / wrong-token rejected / reconnect |
| 11, 12 (history + search reopen) | ✓ | |
| 46-depth-artifact-preview | ✓ 136s | previously-refused tiles now filtered/previewable |
| 02-home-shows-connection-status | ✓ | subtitle is time-aware; test asserts the connecting line is gone |
| 38-regression-local-model-turn | ✓ 133s | **LOCAL MODEL**: Spark-X2.5-4B replied "ZEBRA" in 1m9s from a phone-originated send; relay healthy after |

**Desktop-side regression tests:** `cargo test -p relay --lib mobile` → 44 passed, 0 failed.
**Storm before/after:** ~1,070 relay log lines / 8s → 6 lines / 10s.
