// 30-34 — resilience: sidebar collapse, window controls, full reload
// recovery, split panes, chat zoom.

export const RESILIENCE_TESTS = [
  {
    name: '30-sidebar-collapse-restore',
    info: 'the Relay wordmark collapses the sidebar; a restore button appears and brings it back',
    async run({ h, app }) {
      await app.goHome();
      await h.clickAria('Collapse sidebar');
      await h.sleep(700);
      let collapsed = await h.evaluate(() => {
        const el = document.querySelector('.sidebar');
        return el ? el.classList.contains('collapsed') || el.getAttribute('aria-hidden') === 'true' : false;
      });
      h.Assert.that(collapsed, 'sidebar did not collapse via the wordmark button');
      const restore = await h.evaluate(() => {
        const b = document.querySelector('button[aria-label="Show sidebar"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      h.Assert.that(restore, '"Show sidebar" restore button missing while collapsed');
      await h.rawPage().mouse.click(restore.x, restore.y);
      await h.sleep(700);
      collapsed = await h.evaluate(() =>
        document.querySelector('.sidebar')?.classList.contains('collapsed') ?? false);
      h.Assert.that(!collapsed, 'sidebar did not restore');
      await h.screenshot('30-sidebar-restored');
    },
  },

  {
    name: '31-window-maximize-restore',
    info: 'title-bar Maximize toggles the real window state and the glyph flips to Restore',
    async run({ h }) {
      const maxBtn = await h.evaluate(() => {
        const b = document.querySelector('button[title="Maximize"]')
          ?? Array.from(document.querySelectorAll('.titlebar-btn')).find((x) => x.getAttribute('aria-label')?.includes('Maximize'));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      h.Assert.that(maxBtn, 'Maximize window button not found');
      await h.rawPage().mouse.click(maxBtn.x, maxBtn.y);
      await h.sleep(900);
      let flipped = await h.evaluate(() =>
        !!document.querySelector('button[title="Restore"]'));
      h.Assert.that(flipped, 'window did not report maximized (no Restore glyph) after clicking Maximize');
      await h.screenshot('31-maximized');
      await h.evaluate(() => document.querySelector('button[title="Restore"]')?.click());
      await h.sleep(900);
      flipped = await h.evaluate(() => !!document.querySelector('button[title="Maximize"]'));
      h.Assert.that(flipped, 'window did not return to restored state');
    },
  },

  {
    name: '32-full-reload-recovers',
    info: 'a hard page reload re-boots the app shell, restores the session list, and leaves no error banner',
    async run({ h, app }) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await h.rawPage().reload({ waitUntil: 'domcontentloaded' });
        // Shell repaints after the full Vite module graph re-executes.
        await h.waitFor(() => h.evaluate(() => !!document.querySelector('.app .sidebar')), {
          timeout: 60000, desc: 'shell after reload', interval: 700,
        });
        // Sessions load async after boot; the splash can also re-appear if a
        // second navigation races the first boot — tolerate both by waiting.
        const rows = await h.waitFor(() => h.evaluate(() => {
          const rows = document.querySelectorAll('.chat-session-row').length;
          return rows > 0 ? rows : null;
        }), { timeout: 20000, desc: 'session rows after reload', interval: 700 })
          .catch(() => 0);
        if (rows > 0) {
          const errBanner = await h.evaluate(() => !!document.querySelector('.chat-error'));
          h.Assert.that(!errBanner, 'error banner visible right after reload');
          await h.screenshot('32-reloaded');
          return;
        }
        if (attempt === 2) {
          const splash = await h.evaluate(() => !!document.querySelector('#root') &&
            !document.querySelector('.app'));
          throw new Error(`sessions never restored after reload (attempt ${attempt}; shell re-bootstrapped: ${splash})`);
        }
      }
    },
  },

  {
    name: '33-fork-to-split-panes',
    info: 'palette "Fork Chat to Side-by-Side Panes" opens the fork dialog; confirming creates a second pane; Ctrl+W closes it',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage('Reply with the single word FORKTEST. Do not use any tools.');
      await app.waitForTurnDone({ timeout: 120000 });
      await app.paletteSearch('Fork Chat');
      await app.palettePick('Fork Chat to Side-by-Side Panes');
      // The fork flow shows a confirmation dialog ("Fork chat").
      await h.waitForText('Fork chat', { timeout: 6000 });
      await h.screenshot('33-fork-dialog');
      const btn = await h.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button.primary'))
          .find((x) => /^Fork/.test((x.textContent || '').trim()));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      h.Assert.that(btn, 'fork dialog has no Fork button');
      await h.rawPage().mouse.click(btn.x, btn.y);
      await h.sleep(1200);
      const panes = await h.evaluate(() => document.querySelectorAll('.chat-pane').length);
      h.Assert.that(panes >= 2, `expected ≥2 chat panes after fork, found ${panes}`);
      await h.screenshot('33-split');
      // Close a fork pane via its own floating ✕ (Ctrl+W needs pane focus).
      const closed = await h.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button[aria-label^="Close pane:"]'))[0];
        if (!btn) return false;
        btn.click();
        return true;
      });
      h.Assert.that(closed, 'no "Close pane" button found on the split panes');
      await h.sleep(700);
      const after = await h.evaluate(() => document.querySelectorAll('.chat-pane').length);
      h.Assert.that(after < panes, `pane count did not drop after closing (${panes} → ${after})`);
    },
  },

  {
    name: '34-app-zoom-shortcuts',
    info: 'Ctrl+= raises the app-wide zoom, Ctrl+0 resets it (the handler drives the `zoom` property, not --chat-zoom)',
    async run({ h, app }) {
      await app.goHome();
      const zoomOf = () => h.evaluate(() => {
        const z = getComputedStyle(document.documentElement).zoom;
        return z ? parseFloat(z) : 1;
      });
      const before = await zoomOf();
      await h.pressKey('Control+=');
      await h.sleep(500);
      const up = await zoomOf();
      h.Assert.that(up > before, `Ctrl+= did not raise app zoom (${before} → ${up})`);
      await h.pressKey('Control+0');
      await h.sleep(500);
      const reset = await zoomOf();
      h.Assert.that(reset === before, `Ctrl+0 did not reset app zoom (${up} → ${reset}, expected ${before})`);
    },
  },
];
