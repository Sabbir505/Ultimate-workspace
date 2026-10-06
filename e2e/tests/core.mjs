// Core flows: cold start, pairing round-trip, drawer/history.

import * as h from '../harness.mjs';
import * as app from '../app.mjs';

export const CORE_TESTS = [
  {
    name: '01-cold-start-launches-expo-go',
    info: 'App bundle loads from Metro over adb reverse; Home renders; no red box',
    async run({ h, app, shot }) {
      await h.launchApp();
      // Cold bundle build can take a while on first load.
      await h.waitForText('Good morning', { timeout: 90000 }).catch(
        () => h.waitForText('Good afternoon', { timeout: 20000 }))
        .catch(() => h.waitForText('Good evening', { timeout: 20000 }))
        .catch(() => h.waitForText('Good night', { timeout: 20000 }));
      await app.closeDrawer();
      const xml = h.dumpUi();
      if (app.dumpHasErrorMarkers(xml)) throw new Error('error markers on Home after cold start');
      for (const expected of ['Write a message', 'Attach photo or file']) {
        if (!h.findByText(expected).length) throw new Error(`Home missing "${expected}"`);
      }
      await shot('01-home-cold-start');
      return { composer: 'ok', statusPill: app.statusPill() };
    },
  },

  {
    name: '02-home-shows-connection-status',
    info: 'Status pill reflects the live relay socket (expect connected)',
    async run({ h, app, shot }) {
      await app.waitForStatus('connected', { timeout: 45000 });
      await shot('02-connected-pill');
      // Home subtitle flips from "Connecting to your desktop…" to a
      // connected prompt — which is TIME-AWARE ("What are we working on?"
      // by day, "How can I help you tonight?" in the evening). Assert the
      // connecting line is GONE rather than pinning one greeting.
      h.dumpUi();
      if (h.findByText('Connecting to your desktop').length)
        throw new Error('Home still shows "Connecting to your desktop…" while the pill says connected');
      return { pill: 'connected', subtitleIsTimeAware: true };
    },
  },

  {
    name: '03-pairing-roundtrip-settings-ui',
    info: 'Disconnect → bad token rejected → correct token reconnects (challenge-response pairing)',
    async run({ h, app, shot }) {
      await app.openSettings();
      if (!h.findByText('Desktop connection').length) throw new Error('Desktop connection section missing');
      await h.waitForText('Connected to desktop', { timeout: 15000 });
      await shot('03a-settings-connected');

      // -- disconnect
      await h.tapText('Disconnect', { exact: true });
      await h.waitForText('Desktop unreachable', { timeout: 20000 });
      await shot('03b-disconnected');
      if (!h.findByText('ws://host:port').length && !h.findByText('Connect', { exact: true }).length)
        throw new Error('URL input / Connect button did not appear after disconnect');

      // -- wrong token must be rejected (single attempt — lockout threshold is 5)
      await h.tapCenterOf(h.findEditText()[0]);
      await h.clearFocusedField(300);
      const badUrl = `ws://localhost:${h.RELAY_PORT}/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
      await h.typeText(badUrl);
      await h.tapText('Connect', { exact: true });
      await h.sleep(6000);
      h.dumpUi();
      if (h.findByText('Connected to desktop').length)
        throw new Error('SECURITY: app connected with a WRONG pairing token');
      await shot('03c-bad-token-rejected');

      // -- correct token reconnects through the same UI path
      await h.tapCenterOf(h.findEditText()[0]);
      await h.clearFocusedField(300);
      const goodUrl = `ws://localhost:${h.RELAY_PORT}/#${h.readToken()}`;
      await h.typeText(goodUrl);
      await h.tapText('Connect', { exact: true });
      // The connect handshake can lose a race to the retry backoff — give it
      // a generous window (and re-press Connect if the field is still there).
      let re = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        h.dumpUi();
        if (h.findByText('Connected to desktop').length) { re = true; break; }
        const btn = h.findByText('Connect', { exact: true });
        if (btn.length) await h.tapCenterOf(btn[0]);
        await h.sleep(4000);
      }
      if (!re) throw new Error('reconnect did not land within 90s of tapping Connect');
      await shot('03d-reconnected');
      return { pairing: 'disconnect/reject/reconnect all ok' };
    },
  },

  {
    name: '04-drawer-history-and-links',
    info: 'Drawer lists history buckets, Projects, Artifacts, Settings',
    async run({ h, app, shot }) {
      await app.openDrawer();
      await shot('04-drawer');
      const need = ['Search chats and messages', 'Projects', 'Artifacts', 'Settings'];
      for (const label of need)
        if (!h.findByText(label).length) throw new Error(`drawer missing "${label}"`);
      // At least one time bucket header or one session row — history exists.
      const buckets = h.findByText('Today').length + h.findByText('Yesterday').length +
        h.findByText('Previous 7 days').length + h.findByText('Earlier').length;
      if (!buckets && !h.findByText('New chat').length)
        throw new Error('drawer shows no history buckets and no New chat');
      await app.closeDrawer();
    },
  },

  {
    name: '05-model-picker-sheet',
    info: 'Composer model chip opens the model sheet with providers/models; closes cleanly',
    async run({ h, app, shot }) {
      await app.goHome();
      h.dumpUi();
      const chip = h.findByText('Model:');
      if (!chip.length) throw new Error('model chip not found in composer');
      await h.tapCenterOf(chip[0]);
      await h.sleep(800);
      h.dumpUi();
      const sheetHasModels = h.findByText('local_gguf').length ||
        h.findByText('Model', { exact: false }).length > 1;
      if (!sheetHasModels) throw new Error('model sheet did not open or shows no models');
      await shot('05-model-sheet');
      await h.back(); // close sheet
      await h.ensureAppForeground();
      await h.sleep(400);
      h.dumpUi();
      if (app.dumpHasErrorMarkers(h.lastDumpRaw())) throw new Error('error markers after model sheet');
    },
  },
];
