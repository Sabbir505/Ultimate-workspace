// 40-49 — INSIDE each surface: automation create/edit/delete roundtrip,
// vault note lifecycle, memory/subagents/local-models panels, git sidebar,
// model market, appearance depth (theme + fonts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function openAutomationForm(h, app) {
  await app.openAutomations();
  await h.dumpUi();
  const newBtn = h.findByText('New', { exact: true })[0];
  const emptyBtn = h.findByText('Create your first automation')[0];
  const trigger = newBtn ?? emptyBtn;
  if (!trigger) throw new Error('no "New" button or "Create your first automation" CTA in Automations');
  await h.clickNode(trigger);
  await h.waitForText('New automation', { timeout: 5000 });
  await h.sleep(300);
}

async function fillAutomationForm(h, { name, prompt, scheduleLabel }) {
  await h.evaluate((n) => {
    const input = document.querySelector('input[placeholder="Nightly test fix"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, n);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, name);
  await h.evaluate((p) => {
    const area = document.querySelector('textarea[placeholder^="Run the test suite"]');
    if (!area) throw new Error('automation prompt textarea missing');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, p);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
  if (scheduleLabel) {
    await h.evaluate((label) => {
      // The form has several selects (trigger type first) — the schedule one
      // is the select whose options include the preset label.
      const selects = Array.from(document.querySelectorAll('select'));
      const select = selects.find((s) =>
        Array.from(s.options).some((o) => o.textContent.trim() === label));
      if (!select) throw new Error(`no select offers schedule option "${label}"`);
      const opt = Array.from(select.options).find((o) => o.textContent.trim() === label);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, opt.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, scheduleLabel);
  }
  await h.sleep(300);
}

async function saveAutomation(h, expect) {
  await h.clickText(expect);
  await h.sleep(700);
}

export const DEPTH_TESTS = [
  {
    name: '40-automation-create-roundtrip',
    info: 'create an automation through the form → row + detail card render with the chosen schedule',
    async run({ h, app }) {
      await openAutomationForm(h, app);
      await fillAutomationForm(h, {
        name: 'E2E Nightly Ping',
        prompt: 'Say hi and nothing else. Do not use any tools.',
        scheduleLabel: 'Daily at 9:00 AM',
      });
      await h.screenshot('40-form-filled');
      await saveAutomation(h, 'Create automation');
      await h.waitForText('E2E Nightly Ping', { timeout: 6000 });
      await h.dumpUi();
      h.Assert.that(await h.hasText('Daily at 9:00 AM'), 'detail card does not show the chosen schedule');
      await h.screenshot('40-created');
      this.info = 'created "E2E Nightly Ping" (cron daily)';
    },
  },

  {
    name: '41-automation-edit-preserves-identity',
    info: 'Edit opens the form pre-filled; saving renames the SAME row (no duplicate) — regression BUG_LIST-H14',
    bug: 'BUG_LIST-H14 — "Edit" on an automation opened the CREATE form; Save duplicated it',
    async run({ h, app }) {
      await app.openAutomations();
      await h.clickText('E2E Nightly Ping');
      await h.sleep(500);
      const edit = await h.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Edit');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      h.Assert.that(edit, 'detail card "Edit" button not found');
      await h.rawPage().mouse.click(edit.x, edit.y);
      await h.waitForText('Edit automation', { timeout: 5000 });
      await h.screenshot('41-edit-prefilled');
      // Pre-filled regression check (name input carries the current name).
      const prefill = await h.evaluate(() =>
        document.querySelector('input[placeholder="Nightly test fix"]')?.value || '');
      h.Assert.that(prefill === 'E2E Nightly Ping', `edit form was not pre-filled (got "${prefill}") — H14 regression`);
      await saveAutomation(h, 'Save changes');
      await h.sleep(700);
      const rows = await h.evaluate(() =>
        Array.from(document.querySelectorAll('.automations-list-row'))
          .map((n) => n.textContent || '')
          .filter((t) => t.includes('E2E Nightly Ping')));
      h.Assert.that(rows.length === 1, `expected exactly 1 "E2E Nightly Ping" row after edit-save, got ${rows.length} — H14 duplicate`);
    },
  },

  {
    name: '42-automation-custom-cron-preserved',
    info: 'editing an automation with a non-preset cron keeps that cron — regression ROUND2-A14',
    bug: 'ROUND2-A14 — editing an automation silently rewrote non-preset crons to 0 9 * * 1-5',
    async run({ h, app }) {
      // Seed a custom-cron automation directly through IPC (setup-only);
      // everything asserted below is UI-level.
      await h.invoke('create_automation', {
        input: {
          name: 'E2E Custom Cron',
          prompt: 'Say hi. Do not use any tools.',
          harness: 'claude_code',
          schedule: '23 4 * * 1',
          enabled: true,
          triggerType: 'cron',
          triggerConfig: JSON.stringify({ schedule: '23 4 * * 1' }),
        },
      });
      const viewBefore = await h.evaluate(() => !!document.querySelector('.automations-view'));
      await app.goHome();
      const viewAfterGoHome = await h.evaluate(() => !!document.querySelector('.automations-view'));
      await app.openAutomations();
      const viewAfterOpen = await h.evaluate(() => !!document.querySelector('.automations-view'));
      const appeared = await h.waitForText('E2E Custom Cron', { timeout: 8000 }).then(() => true).catch(() => false);
      if (!appeared) {
        // Diagnose: does the backend have it while the UI doesn't?
        const ipcNames = await h.invoke('list_automations').then(
          (l) => l.map((a) => a.name), () => ['<list_automations rejected>']);
        const uiRows = await h.evaluate(() =>
          Array.from(document.querySelectorAll('.automations-list-row'))
            .map((n) => (n.textContent || '').trim().slice(0, 40)));
        throw new Error(`viewBefore=${viewBefore} afterGoHome=${viewAfterGoHome} afterOpen=${viewAfterOpen} | IPC: ${JSON.stringify(ipcNames)} | UI: ${JSON.stringify(uiRows)}`);
      }
      await h.clickText('E2E Custom Cron');
      await h.sleep(500);
      const before = await h.evaluate(() =>
        document.querySelector('.automation-detail-schedule-cron')?.textContent?.trim());
      h.Assert.that(before === '23 4 * * 1', `custom cron not stored as seeded (got "${before}")`);
      const edit = await h.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Edit');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      await h.rawPage().mouse.click(edit.x, edit.y);
      await h.waitForText('Edit automation', { timeout: 5000 });
      await h.screenshot('42-edit-custom-cron');
      await saveAutomation(h, 'Save changes');
      await h.sleep(700);
      // After a save the view may drop the selection — re-select the row so
      // the detail card is guaranteed to be the edited automation.
      await h.clickText('E2E Custom Cron');
      await h.waitFor(() => h.evaluate(() =>
        !!document.querySelector('.automation-detail-schedule-cron')), {
        timeout: 6000, desc: 'detail card cron after save',
      });
      const after = await h.evaluate(() =>
        document.querySelector('.automation-detail-schedule-cron')?.textContent?.trim() ?? '<no cron element>');
      h.Assert.that(after === '23 4 * * 1', `custom cron was rewritten on edit: "${before}" → "${after}" (ROUND2-A14)`);
    },
  },

  {
    name: '43-automation-pause-delete-cleans-up',
    info: 'Pause/Resume toggle flips state and Delete removes the rows — both used to deadlock the DB (lock re-entry while sync_fs_watchers ran)',
    async run({ h, app }) {
      // Self-sufficient: 40 normally creates these; when 43 runs alone, seed
      // via IPC (setup-only — every assertion below stays UI-level).
      const existing = await h.invoke('list_automations').then((l) => l.map((a) => a.name), () => []);
      for (const seed of ['E2E Nightly Ping', 'E2E Custom Cron']) {
        if (existing.includes(seed)) continue;
        await h.invoke('create_automation', {
          input: {
            name: seed,
            prompt: 'Say hi. Do not use any tools.',
            harness: 'claude_code',
            schedule: '2 9 * * *',
            enabled: true,
          },
        });
      }
      // Pause/Resume exercises set_automation_enabled — the second command
      // that used to hold the DB guard across sync_fs_watchers (self-deadlock:
      // the UI froze and every later IPC timed out).
      await app.openAutomations();
      await h.clickText('E2E Nightly Ping');
      await h.sleep(500);
      const clickToggle = async (label) => {
        const pt = await h.evaluate((want) => {
          const b = Array.from(document.querySelectorAll('.automation-detail-controls button'))
            .find((x) => (x.textContent || '').trim() === want);
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }, label);
        if (!pt) throw new Error(`no "${label}" button in the automation detail controls`);
        await h.rawPage().mouse.click(pt.x, pt.y);
        await h.sleep(600);
      };
      const toggleText = () => h.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.automation-detail-controls button'))
          .find((x) => /^(Pause|Resume)$/.test((x.textContent || '').trim()));
        return b ? b.textContent.trim() : null;
      });
      const beforeToggle = await toggleText();
      h.Assert.that(beforeToggle, 'no Pause/Resume button in the automation detail card');
      await clickToggle(beforeToggle);
      // The command must RETURN (a deadlock would hang here until the IPC
      // timeout) and the button must flip to the other label.
      await h.waitFor(async () => {
        const t = await toggleText();
        return t && t !== beforeToggle;
      }, { timeout: 10000, desc: 'Pause/Resume flip (times out under the old deadlock)' });
      const afterToggle = await toggleText();
      // Flip back so the delete below starts from the original state.
      await clickToggle(afterToggle);
      await h.sleep(400);

      for (const name of ['E2E Nightly Ping', 'E2E Custom Cron']) {
        await app.goHome();
        await app.openAutomations();
        await h.clickText(name);
        await h.sleep(400);
        const del = await h.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Delete');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        if (!del) { this.info = `${name} already gone`; continue; }
        await h.rawPage().mouse.click(del.x, del.y);
        // The delete must ASK first: an in-app confirm modal (window.confirm
        // is rejected by this webview — see AUTOMATIONS-CONFIRM in BUGS.md).
        const asked = await h.waitFor(() => h.evaluate(() =>
          /delete this automation/i.test(document.body.innerText || '') &&
          !!Array.from(document.querySelectorAll('.modal button')).find((b) => /cancel/i.test(b.textContent || '')),
        ), { timeout: 6000, desc: 'in-app delete confirm' }).then(() => true).catch(() => false);
        h.Assert.that(asked, `deleting "${name}" did not ask for confirmation`);
        await h.screenshot(`43-confirm-${name.replace(/\W+/g, '-')}`);
        if (name === 'E2E Nightly Ping') {
          // Two-phase round: CANCEL must keep the row (the pre-fix behavior
          // was a silent truthy window.confirm — no prompt at all), then the
          // prompt must be re-openable and Confirm must delete.
          await h.clickText('Cancel');
          await h.sleep(500);
          h.Assert.that(await h.hasText(name), `Cancel did not abort the delete of "${name}"`);
          h.Assert.that(!(await h.evaluate(() => !!document.querySelector('.modal'))),
            'the confirm modal stayed open after Cancel');
          const del2 = await h.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Delete');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          });
          h.Assert.that(del2, `Delete button vanished after Cancel on "${name}"`);
          await h.rawPage().mouse.click(del2.x, del2.y);
          await h.waitFor(() => h.evaluate(() => !!document.querySelector('.modal')), {
            timeout: 6000, desc: 'confirm reopened',
          });
        }
        // The prompt is open — confirm the deletion.
        const confirmBtn = await h.evaluate(() => {
          const b = Array.from(document.querySelectorAll('.modal button')).find((x) => /delete/i.test(x.textContent || ''));
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        h.Assert.that(confirmBtn, 'confirm modal has no Delete button');
        await h.rawPage().mouse.click(confirmBtn.x, confirmBtn.y);
        await h.sleep(800);
        await app.goHome();
        await app.openAutomations();
        await h.waitForGone(name, { timeout: 6000 });
        h.Assert.that(!(await h.hasText(name)), `${name} still listed after confirming Delete`);
      }
      await h.screenshot('43-deleted');
    },
  },

  {
    name: '44-vault-note-lifecycle',
    info: 'create a note via the UI, see it in the tree, search finds its content, then delete it',
    async run({ h, app }) {
      // Belt & braces: the runner binds the scratch vault at boot, but an
      // earlier test's frontend crash can leave the store showing unbound.
      const bound = await h.evaluate(async () =>
        (await window.__TAURI_INTERNALS__.invoke('vault_get_state'))?.root ?? null);
      if (!bound) {
        await h.invoke('vault_bind', { path: h.sandboxPath('vault') });
        await h.sleep(800);
      }
      await app.openVault();
      const newNote = await h.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) =>
          (x.getAttribute('title') || '').startsWith('New note'));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      h.Assert.that(newNote, '"New note" button not found in the vault header');
      await h.rawPage().mouse.click(newNote.x, newNote.y);
      await h.sleep(700);
      await h.screenshot('44-note-created');
      // The note lands in the file tree.
      await h.dumpUi();
      const treeHasNote = await h.evaluate(() =>
        !!Array.from(document.querySelectorAll('.vault-view button, .vault-view [role="treeitem"]'))
          .find((n) => /untitled|note/i.test(n.textContent || '')));
      h.Assert.that(treeHasNote, 'new note did not appear in the vault tree');
      // Search finds the note once it has content: write content via the
      // editor if focused, else via IPC (setup-only) and re-search in UI.
      const notePath = await h.evaluate(async () => {
        const tree = await window.__TAURI_INTERNALS__.invoke('vault_tree');
        const walk = (n) => [n, ...(n.children ?? []).flatMap(walk)];
        const hit = walk({ children: tree }).find((n) => n.kind === 'note' && /untitled|note/i.test(n.name));
        return hit?.path ?? null;
      });
      h.Assert.that(notePath, 'vault tree IPC returned no note path');
      await h.invoke('vault_write_note', { path: notePath, content: 'ZZE2EVAULTMARKER unique haystack needle\n' });
      await h.clickText('Search');
      await h.sleep(400);
      await h.evaluate(() => {
        const box = document.querySelector('.vault-rail-search-box input, input[placeholder*="Search" i]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(box, 'ZZE2EVAULTMARKER');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await h.sleep(900);
      h.Assert.that(await h.hasText('ZZE2EVAULTMARKER'), 'vault search did not surface the note with the marker');
      await h.screenshot('44-vault-search');
      await h.invoke('vault_delete_note', { path: notePath });
    },
  },

  {
    name: '45-settings-memory-panel',
    info: 'Settings → Memory renders the memory panel with its document surface',
    async run({ h, app }) {
      await app.openSettings();
      await app.openSettingsCategory('Memory');
      const panel = await h.evaluate(() => !!document.querySelector('[data-testid="memory-panel"]'));
      h.Assert.that(panel, '[data-testid="memory-panel"] missing');
      await h.screenshot('45-memory');
      await app.goHome();
    },
  },

  {
    name: '46-settings-subagents-panel',
    info: 'Settings → Subagents renders the declarative subagent registry surface',
    async run({ h, app }) {
      await app.openSettings();
      await app.openSettingsCategory('Subagents');
      await h.sleep(500);
      h.Assert.that(await h.hasText('Subagents'), 'Subagents panel heading missing');
      await h.screenshot('46-subagents');
      await app.goHome();
    },
  },

  {
    name: '47-settings-local-models-panel',
    info: 'Settings → Local Models renders the GGUF market surface (list may need network)',
    async run({ h, app }) {
      await app.openSettings();
      await app.openSettingsCategory('Local Models');
      await h.sleep(800);
      await h.screenshot('47-local-models');
      const surface = await h.evaluate(() => {
        const text = document.querySelector('.settings-panel')?.textContent || '';
        return /model|gguf|llama/i.test(text);
      });
      h.Assert.that(surface, 'Local Models panel shows no model-related content');
      await app.goHome();
    },
  },

  {
    name: '48-git-sidebar-expands',
    info: 'the chat pane git sidebar expands and shows the Git tools header + rows',
    async run({ h, app }) {
      await app.goHome();
      await h.dumpUi();
      const expand = h.findIncludingDisabled('Expand git tools')[0];
      if (expand) await h.clickNode(expand);
      await h.sleep(500);
      await h.dumpUi();
      h.Assert.that(h.findByText('Git tools').length > 0 || h.findIncludingDisabled('Collapse git tools').length > 0,
        'git sidebar header "Git tools" not visible after expanding');
      await h.screenshot('48-git-sidebar');
    },
  },

  {
    name: '49-appearance-theme-and-fonts',
    info: 'theme cards apply dark/light to <html> and switch back; font pickers exist',
    async run({ h, app }) {
      await app.openSettings();
      await app.openSettingsCategory('Appearance');
      await h.sleep(400);
      const before = await app.documentTheme();
      await h.clickText('Light');
      await h.sleep(600);
      const light = await app.documentTheme();
      h.Assert.that(light === 'light', `clicking the Light card left the document theme at "${light}"`);
      await h.screenshot('49-light-theme');
      await h.clickText('Dark');
      await h.sleep(600);
      const dark = await app.documentTheme();
      h.Assert.that(dark === 'dark' || dark === before, `clicking Dark left the document theme at "${dark}"`);
      // Font settings surface present ("Fonts" section title).
      const fonts = await h.evaluate(() => {
        const titles = Array.from(document.querySelectorAll('.settings-section-title'))
          .map((n) => n.textContent?.trim());
        return titles.some((t) => /font/i.test(t || ''));
      });
      h.Assert.that(fonts, 'no Font settings section on the Appearance panel');
      await app.goHome();
    },
  },
];
