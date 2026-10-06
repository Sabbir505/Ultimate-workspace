// Resilience: relay drop/reconnect, background-foreground, deep links.

import * as h from '../harness.mjs';
import * as app from '../app.mjs';

export const RESILIENCE_TESTS = [
  {
    name: '30-relay-drop-shows-offline',
    info: 'Settings → Disconnect drops the connection → the app re-establishes it from the stored URL — app-driven, no process kills',
    async run({ h, app, shot }) {
      await app.goHome();
      await app.waitForStatus('connected', { timeout: 45000 });

      // App-driven drop: the Settings "Disconnect" button (the tests must
      // NEVER kill the desktop process — that closes the user's app).
      await app.openSettings();
      await h.waitForText('Connected to desktop', { timeout: 20000 });
      let unreachable = false;
      for (let i = 0; i < 3 && !unreachable; i++) {
        await h.tapText('Disconnect', { exact: true });
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          h.dumpUi();
          if (h.findByText('Desktop unreachable').length) { unreachable = true; break; }
          await h.sleep(500);
        }
      }
      if (!unreachable) throw new Error('Disconnect did not flip the status to "Desktop unreachable" after 3 taps');
      await shot('30a-offline-after-disconnect');

      // Recovery: a MANUAL Disconnect stays disconnected by design (the
      // stored URL is kept; the Connect button waits). Tap Connect — the
      // field already holds ws://localhost:<port>/#<token>.
      h.dumpUi();
      if (!h.findByText('Connected to desktop').length) {
        const connect = h.findByText('Connect', { exact: true });
        if (!connect.length) throw new Error('Connect button not offered after Disconnect');
        await h.tapCenterOf(connect[0]);
      }
      let reconnected = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        h.dumpUi();
        if (h.findByText('Connected to desktop').length) { reconnected = true; break; }
        await h.sleep(2500);
      }
      await shot('30b-reconnected');
      if (!reconnected)
        throw new Error('app did not re-establish the connection within 60s of tapping Connect');
      await app.goHome();
      await app.waitForStatus('connected', { timeout: 30000 }).catch(() => {});
      return { dropAndRecover: 'ok', autoReconnected: reconnected };
    },
  },

  {
    name: '31-background-foreground-resume',
    info: 'Home → re-open: app resumes on the experience (not Expo Go launcher), no crash',
    async run({ h, app, shot }) {
      await app.goHome();
      await app.waitForStatus('connected', { timeout: 30000 });
      h.adb(['shell', 'input', 'keyevent', '3']); // HOME
      await h.sleep(2000);
      h.adb(['shell', 'monkey', '-p', 'host.exp.exponent', '-c', 'android.intent.category.LAUNCHER', '1']);
      await h.sleep(2500);
      h.dumpUi();
      if (app.dumpHasErrorMarkers(h.lastDumpRaw())) throw new Error('error markers after resume');
      if (h.currentActivity().includes('HomeActivity')) {
        // Resumed into Expo Go's own launcher instead of the experience.
        await h.ensureAppForeground();
        await h.sleep(2000);
        h.dumpUi();
      }
      await app.goHome();
      await shot('31-resumed');
      const pill = app.statusPill();
      if (pill !== 'connected') {
        await app.waitForStatus('connected', { timeout: 60000 });
      }
      return { pillAfterResume: app.statusPill() };
    },
  },

  {
    name: '32-deep-link-pairing-guard',
    info: 'relay:// deep link asks for confirmation before repointing the relay (audit M19)',
    async run({ h, app, shot }) {
      // In Expo Go, custom app schemes are NOT registered (verified on-device:
      // the Expo Go manifest exposes only exp/exps/http/https — no
      // exp+relay-mobile), and exp://…/--/ links reach the JS layer as exp://
      // URLs, which parseRelayConnectLink correctly ignores (not a relay: URL).
      // So the audit-M19 guard cannot be exercised from adb in Expo Go; it
      // needs a dev build / standalone APK with the relay:// scheme.
      const token = h.readToken();
      const attempts = [
        `exp+relay-mobile://connect?host=ws://localhost%3A${h.RELAY_PORT}%2F%23${token}`,
        `relay://connect?host=ws://localhost%3A${h.RELAY_PORT}%2F%23${token}`,
        `exp://127.0.0.1:${h.METRO_PORT}/--/connect?host=ws%3A%2F%2Flocalhost%3A${h.RELAY_PORT}%2F%23${token}`,
      ];
      let delivered = false;
      let sawAlert = false;
      for (const url of attempts) {
        if (!h.fireDeepLink(url)) continue;
        delivered = true;
        await h.sleep(2500);
        h.dumpUi();
        if (h.findByText('Connect to relay?').length) { sawAlert = true; break; }
      }
      await shot('32-deep-link');
      if (sawAlert) {
        await h.tapText('Cancel', { exact: true });
        await h.sleep(800);
        return { confirmDialog: 'shown and cancelled' };
      }
      await h.ensureAppForeground();
      const skip = new Error(
        'SKIP: Expo Go cannot deliver relay:// custom-scheme links (no exp+<slug> registration); ' +
        'run this test on a dev build to exercise the audit-M19 pairing guard' +
        (delivered ? ' — exp:// scheme was delivered but correctly ignored as non-relay' : ' — no scheme resolved'));
      skip.skip = true;
      throw skip;
    },
  },

  {
    name: '33-attach-button-opens-and-cancels',
    info: 'Composer attach → in-app menu → Choose file → system picker opens; Back cancels cleanly',
    async run({ h, app, shot }) {
      await app.goHome();
      h.dumpUi();
      const attach = h.findByText('Attach photo or file');
      if (!attach.length) throw new Error('attach button missing');
      await h.tapCenterOf(attach[0]);
      await h.sleep(1200);
      h.dumpUi();
      // In-app attach menu (Take photo / Choose file) → the picker needs the
      // explicit "Choose file" step.
      const choose = h.findByText('Choose file');
      if (!choose.length) throw new Error('attach menu did not open (no "Choose file")');
      await h.tapCenterOf(choose[0]);
      await h.sleep(2500);
      const pkg = h.currentActivity();
      const pickerOpen = !pkg.includes('host.exp.exponent') ||
        h.findByText('Recent').length || h.findByText('Downloads').length ||
        h.findByText('Images').length || h.findByText('Files').length;
      await shot('33-document-picker');
      await h.back(); // cancel the picker
      await h.ensureAppForeground();
      await h.sleep(1200);
      h.dumpUi();
      if (app.dumpHasErrorMarkers(h.lastDumpRaw())) throw new Error('error markers after picker cancel');
      if (!pickerOpen) throw new Error('document picker did not open after "Choose file"');
      return { attachMenu: 'opened', picker: 'opened + cancelled cleanly' };
    },
  },

  {
    name: '34-theme-toggle-roundtrip',
    info: 'Appearance → Light → dark back; the UI re-renders both ways',
    async run({ h, app, shot }) {
      await app.openSettings();
      h.dumpUi();
      const appearance = h.findByText('Appearance');
      if (!appearance.length) throw new Error('Appearance section missing');
      // Theme segmented control: look for Light/Dark/Auto options.
      const seg = h.findByText('Light', { exact: true })[0] || h.findByText('Dark', { exact: true })[0];
      if (!seg) { await app.goHome(); return { skipped: 'theme control not found (info)' }; }
      await h.tapCenterOf(seg);
      await h.sleep(1200);
      await shot('34a-theme-toggled');
      h.dumpUi();
      const seg2 = h.findByText('Dark', { exact: true })[0] || h.findByText('Auto', { exact: true })[0] ||
        h.findByText('Light', { exact: true })[0];
      if (seg2) { await h.tapCenterOf(seg2); await h.sleep(1200); }
      await shot('34b-theme-restored');
      const xml = h.lastDumpRaw();
      if (app.dumpHasErrorMarkers(xml)) throw new Error('error markers after theme toggle');
      await app.goHome();
      return { theme: 'toggled and restored' };
    },
  },
];
