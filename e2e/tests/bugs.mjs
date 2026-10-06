// Regression tests for bugs found during E2E + reported by the user.
// These document EXPECTED behavior — several fail until the bug is fixed,
// which is exactly what a regression suite is for. Each carries a `bug` id
// that maps to the report in e2e/BUGS.md.

import * as h from '../harness.mjs';
import * as app from '../app.mjs';
import {
  enterCloudSession, sendInSession, waitForReplyToken, waitDesktopHealthy, ensureModelSelected,
  SPLIT_PROMPT, SPLIT_TOKEN,
} from './util.mjs';

const SCREEN_H = 2376; // device override resolution (wm size 1080x2376)

/** True when the desktop relay is healthy enough to answer a list op from
 *  the phone: the Memory screen paints content or an empty-state (not an
 *  eternal spinner / error bar). A deadlocked relay hangs here. */
async function relayHealthy(h, app) {
  try {
    await app.openSettings();
    await h.tapText('Memory', { exact: true });
    const start = Date.now();
    while (Date.now() - start < 30000) {
      h.dumpUi();
      if (h.findByText('Purge all memories').length) return true;         // manage rows painted
      if (h.findByText('Dismiss error').length) return true;              // explicit failure — relay ALIVE
      await h.sleep(1000);
    }
    return false; // eternal spinner → relay deadlocked
  } finally {
    await app.goHome().catch(() => {});
  }
}

export const BUG_TESTS = [
  {
    name: '35-regression-worked-chip-parity',
    bug: 'BUG-1 — fold chip shows plain "Worked"; desktop shows "Worked for Xs"',
    info: 'Cloud-model turn completes; the process fold must read "Worked for <duration>"',
    async run({ h: hh, app: aa, shot }) {
      await hh.restartApp(); // fresh JS context — clears the BUG-5 storm
      await enterCloudSession(aa, hh);
      await sendInSession(hh, SPLIT_PROMPT);

      // No desktop killing (tests must not close the user's app).
      const reply = await waitForReplyToken(hh, SPLIT_TOKEN, 150000);
      if (!reply) throw new Error('turn never replied within 150s — cannot judge the fold chip (if the relay wedged: BUG-4)');
      // The fold header paints after ChatDone; poll for either variant.
      let workedFor = null;
      let plainWorked = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        hh.dumpUi();
        workedFor = hh.visibleNodes().find((n) => /^Worked for /i.test((n.text || '').trim()));
        plainWorked = hh.visibleNodes().find((n) => (n.text || '').trim() === 'Worked');
        if (workedFor || (plainWorked && !hh.findByText('Working for').length)) break;
        await hh.sleep(1500);
      }
      await shot('35-worked-chip');
      if (workedFor) return { chip: workedFor.text.trim() };
      throw new Error(
        `fold chip reads "${plainWorked ? 'Worked' : '(none)'}" — the desktop shows "Worked for Xs"; ` +
        'workedForSec never reaches the phone (MessageBubble.tsx:223 falls back to the plain label)');
    },
  },

  {
    name: '36-regression-composer-bottom-clearance',
    bug: 'BUG-2 — chat composer clipped by the gesture bar; needs lift + bottom space',
    info: 'Composer bottom edge must clear the gesture area (>=96px from the screen bottom)',
    async run({ h: hh, app: aa, shot }) {
      // enterCloudSession guarantees a session whose composer actually mounts
      // (a BUG-10-stuck row never paints one — that is a different failure).
      await enterCloudSession(aa, hh);
      await hh.sleep(1500);
      hh.dumpUi();
      const input = hh.findEditText().slice(-1)[0]; // session composer
      if (!input) throw new Error('chat composer input not found');
      const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(input.bounds);
      const bottom = Number(m[4]);
      const clearance = SCREEN_H - bottom;
      await shot('36-composer-clearance');
      if (clearance < 96)
        throw new Error(`composer bottom edge is ${bottom}/${SCREEN_H} — only ${clearance}px clearance above the gesture bar (needs lift + bottom space)`);
      return { composerBottom: bottom, clearancePx: clearance };
    },
  },

  {
    name: '37-regression-retry-storm',
    bug: 'BUG-3 — when a turn gets no token the app RE-SENDS the same message up to 10× (watchdog, useSessionChat.ts:601-639): duplicate user bubbles pile up in the transcript instead of a quiet background retry',
    info: 'OBSERVER MODE (never kills the desktop): send on a slow free model and watch ~3.5 min for duplicate bubbles + a "retrying (attempt x/10)" banner',
    async run({ h: hh, app: aa, shot }) {
      const MARKER = 'MARKERSEVENTHREE';
      await hh.restartApp();
      await enterCloudSession(aa, hh);
      const model = await ensureModelSelected(hh);
      await sendInSession(hh, `Reply with one word containing ${MARKER}.`);
      await shot('37a-sent');

      // Watch for the watchdog firing. It re-dispatches the SAME turn when no
      // token arrives (75s cloud / 180s local), which lands ANOTHER user
      // bubble. No killing — the storm is observed in situ.
      let worst = 0;
      let banner = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 210000) {
        await hh.sleep(5000);
        hh.dumpUi();
        const dups = hh.visibleNodes().filter((n) => (n.text || '').includes(MARKER)).length;
        worst = Math.max(worst, dups);
        banner = hh.visibleNodes().map((n) => n.text || '').find((t) => /retrying \(attempt/i.test(t)) || banner;
        const replied = hh.visibleNodes().some((n) => (n.text || '').toUpperCase().includes('MARKERSEVENTHREE') &&
          !(n.text || '').includes('one word containing'));
        if (replied && !banner) break;      // normal completion — nothing to see
        if (worst > 2 && banner) break;     // storm captured, no need to wait longer
      }
      await shot('37b-storm-observation');
      if (worst > 2)
        throw new Error(`BUG-3 CONFIRMED: the same message is on screen ${worst}×${banner ? ` with banner "${banner}"` : ''} (model: ${model}). Expected: ONE bubble + a background retry indicator only (watchdog re-dispatch, useSessionChat.ts:630).`);
      return {
        visibleCopies: worst,
        banner,
        model,
        note: 'storm not reproduced this run (needs >75s of zero tokens on a slow model)',
      };
    },
  },

  {
    name: '38-regression-local-model-turn',
    bug: 'BUG-4 — a phone-originated turn on the LOCAL model (local_gguf) never completes: the phone spins and the desktop can deadlock (session_chat.rs:762 fs_roots db.lock())',
    info: 'Send from HOME with the local model selected; require a reply AND a healthy relay afterwards',
    async run({ h: hh, app: aa, shot }) {
      // The Home composer's model chip is whatever was last committed — at
      // the time of writing that is the local GGUF (Spark-X2.5-4B). Verify
      // and, if it ever reverts, skip rather than mis-attribute the failure.
      await aa.goHome();
      hh.dumpUi();
      const chip = hh.visibleNodes().find((n) => (n['content-desc'] || '').startsWith('Model:'));
      const chipDesc = chip ? chip['content-desc'] : '';
      if (!/local_gguf|\.gguf/i.test(chipDesc)) {
        const skip = new Error(`SKIP: Home composer model is "${chipDesc}" — pick the local GGUF to exercise BUG-4`);
        skip.skip = true;
        throw skip;
      }

      const input = hh.findEditText()[0];
      if (!input) throw new Error('home composer input not found');
      await hh.tapCenterOf(input);
      await hh.typeText('Reply with only the 5 letters Z E B R A run together as one word, nothing else.');
      hh.dumpUi();
      const send = hh.findByText('Send message');
      if (!send.length) throw new Error('Send message button did not appear');
      await hh.tapCenterOf(send[0]);
      for (let i = 0; i < 12; i++) { hh.dumpUi(); if (!aa.homeVisible()) break; await hh.sleep(500); }

      const reply = await waitForReplyToken(hh, SPLIT_TOKEN, 150000);
      await shot('38-local-model-state');
      // Report-only: this test NEVER restarts the desktop (tests must not
      // close the user's app). A wedged relay is reported for manual restart.
      const healthy = await relayHealthy(hh, aa);
      if (!reply && !healthy)
        throw new Error('BUG-4 CONFIRMED: local-model turn never replied in 150s AND the relay stopped answering list ops (deadlock). RESTART THE DESKTOP to recover.');
      if (!reply)
        throw new Error('BUG-4 CONFIRMED (partial): local-model turn never replied in 150s (relay still answered list ops).');
      if (!healthy)
        throw new Error('relay deadlocked AFTER a local-model turn — list ops hang. RESTART THE DESKTOP to recover.');
      return { replied: true, relayHealthyAfter: true, chip: chipDesc };
    },
  },
];
