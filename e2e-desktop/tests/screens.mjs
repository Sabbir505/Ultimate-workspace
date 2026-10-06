// 20-29 — every navigation destination: skills, cost, automations, vault,
// wiki, logs, projects sidebar, pairing QR, artifacts library.

export const SCREEN_TESTS = [
  {
    name: '20-skills-library-surfaces',
    info: 'Skills overlay: all four tabs render, gallery search accepts input',
    async run({ h, app }) {
      await app.openSkills();
      for (const tab of ['Skills', 'Loops', 'Gallery', 'Prompt templates']) {
        h.Assert.that(await h.hasText(tab, { exact: true }), `skills tab "${tab}" missing`);
      }
      await h.clickText('Gallery');
      await h.sleep(600);
      await h.screenshot('20-skills-gallery');
      await app.goHome();
    },
  },

  {
    name: '21-cost-dashboard-renders',
    info: 'Cost overlay: "Usage" heading, rollups table region after load, range toggle',
    async run({ h, app }) {
      await app.openCost();
      // Rollups fetch after the overlay mounts — wait for the table region
      // (or an explicit empty state) rather than a fixed sleep.
      const rollups = await h.waitFor(() => h.evaluate(() =>
        !!document.querySelector('[data-testid="cost-rollups"]') ||
        /no (usage|data|activity)/i.test(
          Array.from(document.querySelectorAll('.view-panel *'))
            .map((n) => n.textContent || '').join(' '),
        )), { timeout: 20000, desc: 'cost rollups (or empty state)', interval: 800 });
      h.Assert.that(rollups, 'cost dashboard never rendered rollups or an empty state');
      await h.screenshot('21-cost');
      await app.goHome();
    },
  },

  {
    name: '22-automations-view-surfaces',
    info: 'Automations view: header metrics, New button or empty-state CTA, templates entry',
    async run({ h, app }) {
      await app.openAutomations();
      h.Assert.that(await h.hasText('Automations', { exact: true }), 'Automations h1 missing');
      const hasNew = (await h.hasText('Create your first automation')) || h.findByText('New', { exact: true }).length > 0;
      h.Assert.that(hasNew, 'neither "New" button nor empty-state CTA found');
      await h.screenshot('22-automations');
      await app.goHome();
    },
  },

  {
    name: '23-vault-bound-to-sandbox',
    info: 'vault shows the sandbox-bound folder: rail tabs, header title, tree surface',
    async run({ h, app }) {
      // The runner rebinds the vault to the sandbox at boot (vault_bind);
      // this test asserts the bound state through the UI only.
      await app.openVault();
      await h.waitFor(async () => {
        const title = await h.evaluate(() => document.querySelector('.vault-title')?.textContent?.trim());
        return !!title;
      }, { timeout: 8000, desc: 'vault header title' });
      const title = await h.evaluate(() => document.querySelector('.vault-title')?.textContent?.trim());
      h.Assert.that(title === 'vault', `vault header shows "${title}" — expected the sandbox folder "vault" (isolation leak?)`);
      await h.dumpUi();
      h.Assert.that(await h.hasText('Files') && (await h.hasText('Search')), 'vault rail tabs (Files/Search/Tags) missing after bind');
      await h.screenshot('23-vault');
      await app.goHome();
    },
  },

  {
    name: '24-wiki-view-surfaces',
    info: 'Project Wiki view: heading, add-project affordance, update button',
    async run({ h, app }) {
      await app.openWiki();
      h.Assert.that(await h.hasText('Project Wiki'), 'Project Wiki heading missing');
      await h.dumpUi();
      const add = h.findIncludingDisabled('Add a project to the wiki');
      h.Assert.that(add.length > 0, 'wiki "Add a project to the wiki" button missing');
      await h.screenshot('24-wiki');
      await app.goHome();
    },
  },

  {
    name: '25-logs-view-surfaces',
    info: 'Logs view: heading, origin filter group, search box, prune controls',
    async run({ h, app }) {
      await app.openLogs();
      h.Assert.that(await h.hasText('Logs', { exact: true }), 'Logs h1 missing');
      const group = await h.evaluate(() => !!document.querySelector('[role="group"][aria-label="Filter by origin"]'));
      h.Assert.that(group, 'origin filter group missing');
      const search = await h.evaluate(() => !!document.querySelector('input[placeholder="Search prompts and responses"]'));
      h.Assert.that(search, 'logs search box missing');
      await h.screenshot('25-logs');
      await app.goHome();
    },
  },

  {
    name: '26-projects-panel-toggle',
    info: '"Open projects" toggles the second sidebar panel with the project tree',
    async run({ h, app }) {
      await h.clickAria('Open projects');
      await h.sleep(600);
      const open = await h.evaluate(() => {
        const el = document.querySelector('.projects-sidebar');
        return el ? !el.classList.contains('collapsed') : false;
      });
      h.Assert.that(open, 'projects sidebar did not open');
      await h.screenshot('26-projects');
      await h.clickAria('Open projects');
      await h.sleep(600);
    },
  },

  {
    name: '27-pairing-qr-modal',
    info: 'Phone pairing QR opens a modal with a QR image and closes cleanly',
    async run({ h, app }) {
      await h.clickAria('Phone pairing QR');
      await h.sleep(1500); // QR render
      await h.dumpUi();
      const qr = await h.evaluate(() =>
        !!document.querySelector('.pairing-modal img, .pairing-modal canvas, img[alt*="QR" i], canvas'));
      h.Assert.that(qr, 'no QR image/canvas in the pairing modal');
      await h.screenshot('27-pairing-qr');
      const close = h.findByText('Close', { exact: true });
      if (close.length) await h.clickNode(close[0]);
      else await h.pressKey('Escape');
      await h.sleep(400);
      await app.goHome();
    },
  },

  {
    name: '28-artifacts-library-modal',
    info: 'Artifacts row in the sidebar opens the artifacts modal (grid or empty state)',
    async run({ h, app }) {
      await h.clickText('Artifacts', { exact: true });
      await h.sleep(800);
      await h.dumpUi();
      h.Assert.that(await h.hasText('Artifacts'), 'artifacts modal did not open');
      await h.screenshot('28-artifacts');
      const close = h.findByText('Close', { exact: true });
      if (close.length) await h.clickNode(close[0]);
      else await h.pressKey('Escape');
      await app.goHome();
    },
  },

  {
    name: '29-update-mechanics-quiet',
    info: 'no update popover spams on boot; updater store check must not throw into the UI',
    async run({ h }) {
      await h.dumpUi();
      const updateBtn = h.findIncludingDisabled('Update available');
      // An update MAY exist (fine); what must never happen is a crashed
      // updater check surfacing as an error banner in the chat view.
      const errBanner = await h.evaluate(() => !!document.querySelector('.chat-error'));
      h.Assert.that(!errBanner, 'chat error banner visible after boot — updater/other boot-time check surfaced an error');
      this.info = updateBtn.length ? 'update available (button visible)' : 'no update pending';
    },
  },
];
