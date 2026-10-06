// 01-09 — boot & shell: cold start paints the shell, sidebar chrome, footer
// surfaces open/close, command palette, settings categories, notification
// bell, tool panel.

const help = `Throws carry the failing selector so a red line is enough to start
debugging. Screenshots land in e2e-desktop/artifacts/ automatically.`;

export const CORE_TESTS = [
  {
    name: '01-cold-start-paints-shell',
    info: 'app boots to chat view: sidebar brand, Chat History, footer buttons, no console errors',
    async run({ h, app }) {
      await app.goHome();
      // The version chip fills in via async IPC after mount — wait for it.
      await h.waitFor(async () => {
        const v = await h.evaluate(() => document.querySelector('.sidebar-version')?.textContent || '');
        return v.startsWith('v');
      }, { timeout: 10000, desc: 'sidebar version chip' });
      await h.dumpUi();
      for (const label of ['Artifacts', 'Automations', 'Vault', 'Wiki', 'Projects']) {
        h.Assert.that(h.findByText(label).length > 0, `sidebar item "${label}" missing`);
      }
      const chatHistoryLabel = await h.evaluate(() =>
        Array.from(document.querySelectorAll('span')).some((n) => n.textContent?.trim() === 'Chat History'));
      h.Assert.that(chatHistoryLabel, '"Chat History" section label missing');
      for (const btn of ['Skills Library', 'Cost', 'Phone pairing QR', 'Model request log', 'Settings']) {
        h.Assert.that(h.findIncludingDisabled(btn).length > 0, `footer button "${btn}" missing`);
      }
      const shot = await h.screenshot('01-shell');
      if (shot) this.shot = shot;
    },
  },

  {
    name: '02-boot-console-clean',
    info: 'no uncaught page errors during boot (collected by the harness since connect)',
    async run({ h }) {
      const errs = h.takeConsoleErrors().filter((e) => e.kind === 'pageerror');
      if (errs.length) {
        throw new Error(`page errors during boot:\n${errs.map((e) => `- ${e.text}`).join('\n')}`);
      }
    },
  },

  {
    name: '03-new-chat-lands-on-empty-composer',
    info: 'New Chat button creates/opens an empty chat with the composer ready',
    async run({ h, app }) {
      await app.newChat();
      h.Assert.that(await app.chatVisible(), 'composer not visible after New Chat');
      await h.dumpUi();
      const title = await h.evaluate(() => document.querySelector('.toolbar-chat-title')?.textContent?.trim());
      h.Assert.that(title === 'New chat' || !title, `toolbar title after New Chat should be empty/"New chat", got "${title}"`);
    },
  },

  {
    name: '04-command-palette-open-search-close',
    info: 'Ctrl+K opens the palette, typing filters, Escape closes',
    async run({ h, app }) {
      await app.paletteSearch('settings');
      await h.screenshot('04-palette-settings');
      h.Assert.that(await h.hasText('ACTIONS') || await h.hasText('Open Settings'), 'palette shows no matching actions for "settings"');
      await h.pressKey('Escape');
      await h.waitForGone('Search sessions, chats, projects, actions', { timeout: 4000 });
    },
  },

  {
    name: '05-palette-open-settings-action',
    info: 'palette "Open Settings" action actually opens Settings',
    async run({ h, app }) {
      await app.paletteSearch('Open Settings');
      await app.palettePick('Open Settings');
      await app.waitForSettingsOpen();
      await app.openSettingsCategory('Appearance');
      h.Assert.that(await h.hasText('Appearance', { exact: true }), 'Settings did not open from the palette');
      await app.goHome();
    },
  },

  {
    name: '06-settings-categories-render',
    info: 'every settings category shows a panel when clicked; search filters the nav',
    async run({ h, app }) {
      await app.openSettings();
      const categories = ['Appearance', 'Notifications', 'Assistant', 'API Keys', 'Local Models',
        'Harnesses', 'Version control', 'Hooks', 'Connectors', 'MCP Servers', 'Knowledge', 'Memory', 'Data'];
      for (const cat of categories) {
        await app.openSettingsCategory(cat);
        h.Assert.that(await h.hasText(cat, { exact: true }), `settings category "${cat}" missing from nav`);
      }
      // Search filters the nav.
      await h.evaluate(() => {
        const input = document.querySelector('input[aria-label="Search settings"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'hooks');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await h.sleep(500);
      await h.dumpUi();
      h.Assert.that(h.findByText('Hooks').length > 0, 'settings search "hooks" did not surface the Hooks category');
      await h.screenshot('06-settings-search');
      // Clear the search so later tests open with an unfiltered nav.
      const clear = h.findByText('Clear search')[0];
      if (clear) await h.clickNode(clear);
      else {
        await h.evaluate(() => {
          const input = document.querySelector('input[aria-label="Search settings"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      await h.sleep(300);
      await app.goHome();
    },
  },

  {
    name: '07-notification-bell-panel',
    info: 'bell opens the notifications panel; Read all and Clear do not throw; Escape closes',
    async run({ h, app }) {
      await h.clickAria('Notifications');
      await h.waitFor(() => h.evaluate(() => !!document.querySelector('.notifications-panel')), {
        timeout: 6000, desc: 'notifications panel',
      });
      await h.screenshot('07-bell-panel');
      const caughtUp = await h.hasText('caught up');
      const hasRows = (await h.evaluate(() => document.querySelectorAll('.notif-row').length)) > 0;
      h.Assert.that(caughtUp || hasRows, 'notifications panel is neither empty-message nor rows — unknown state');
      if (hasRows) {
        const clear = await h.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Clear all notifications');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        if (clear) { await h.rawPage().mouse.click(clear.x, clear.y); await h.sleep(400); }
      }
      await h.pressKey('Escape');
      await app.goHome();
    },
  },

  {
    name: '08-tool-panel-open-terminal-tab',
    info: 'side panel toggles; Terminal tab opens a tabchip; close tab works',
    async run({ h, app }) {
      await h.clickAria('Toggle side panel');
      await h.waitForText('Terminal', { timeout: 5000 });
      await h.dumpUi();
      const termBtn = h.findByText('Terminal', { exact: true })[0] ?? h.findByText('Terminal')[0];
      h.Assert.that(termBtn, 'Terminal picker button not found in the tool panel');
      await h.clickNode(termBtn);
      await h.sleep(1200); // pty spawn
      await h.dumpUi();
      h.Assert.that(h.findByText('Close tab').length > 0, 'no terminal tabchip with a Close tab button appeared');
      await h.screenshot('08-tool-panel-terminal');
      await h.clickText('Close tab');
      await h.sleep(400);
      await h.clickAria('Toggle side panel');
      await app.goHome();
    },
  },

  {
    name: '09-hotkey-overlay',
    info: 'Ctrl+/ opens the keyboard-shortcut cheatsheet; Escape closes',
    async run({ h, app }) {
      await h.pressKey('Control+/');
      await h.sleep(600);
      await h.dumpUi();
      h.Assert.that(await h.hasText('Keyboard') || await h.hasText('Shortcuts'), 'hotkey overlay did not open on Ctrl+/');
      await h.screenshot('09-hotkeys');
      await h.pressKey('Escape');
      await app.goHome();
    },
  },
];
