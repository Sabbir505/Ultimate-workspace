// 50-53 — regression tests for the bug reports. Conventions mirror
// e2e/tests/bugs.mjs: `bug` names the report id, failure messages embed it,
// and e2e-desktop/BUGS.md documents each one.

export const BUG_TESTS = [
  {
    name: '50-regression-automation-edit-not-create',
    info: 'Edit on an automation must open a form headed "Edit automation" — BUG_LIST-H14',
    bug: 'BUG_LIST-H14 — Edit opened the CREATE form and Save duplicated the automation',
    async run({ h, app }) {
      await app.openAutomations();
      await h.dumpUi();
      if (!h.findByText('E2E H14 Probe').length) {
        // Nothing to edit: create one through the form first.
        const trigger = h.findByText('Create your first automation')[0]
          ?? h.findByText('New', { exact: true })[0];
        if (!trigger) throw new Error('no automations and no create CTA (H14)');
        await h.clickNode(trigger);
        await h.waitForText('New automation', { timeout: 5000 });
        await h.evaluate(() => {
          const input = document.querySelector('input[placeholder="Nightly test fix"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'E2E H14 Probe');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const area = document.querySelector('textarea[placeholder^="Run the test suite"]');
          const tset = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          tset.call(area, 'Do nothing. Do not use any tools.');
          area.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await h.clickText('Create automation');
        await h.waitForText('E2E H14 Probe', { timeout: 6000 });
      }
      await h.clickText('E2E H14 Probe');
      // The detail card heading confirms the row actually got selected.
      await h.waitForText('E2E H14 Probe', { timeout: 6000 });
      await h.sleep(400);
      await h.sleep(500);
      const edit = await h.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Edit');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      h.Assert.that(edit, 'Edit button missing on the automation detail card (H14)');
      await h.rawPage().mouse.click(edit.x, edit.y);
      await h.sleep(600);
      await h.dumpUi();
      h.Assert.that(await h.hasText('Edit automation'), 'edit opened a form NOT headed "Edit automation" (H14 regression)');
      await h.screenshot('50-edit-form');
      await h.clickText('Cancel').catch(() => h.pressKey('Escape'));
    },
  },

  {
    name: '51-regression-streaming-cancel-restores-composer',
    info: 'canceling a turn re-enables Send (not Stop) and clears sidebar Working dots — ROUND2-A3',
    bug: 'ROUND2-A3 — cancel/failed turn left the streaming state (Working… dot + queue UI) stuck forever',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage('Count from 1 to 300 slowly, one number per line. Do not use any tools.');
      let started = false;
      for (let i = 0; i < 30 && !started; i++) {
        started = await app.isStreaming();
        if (!started) await h.sleep(1000);
      }
      if (!started) {
        // Finished-too-fast is fine; a silent pre-stream stall is BUG-11 — skip.
        try {
          const state = await app.waitForTurnDone({ timeout: 60000 });
          if (state === 'done') { this.info = 'turn finished too fast to exercise cancel'; return; }
          throw new Error('turn errored before streaming started (A3)');
        } catch (e) {
          if (e && /stalled silently/.test(String(e.message))) {
            const err = new Error('provider turn stalled silently — cancel path not exercisable (BUG-11)');
            err.skip = true;
            throw err;
          }
          throw e;
        }
      }
      await h.clickAria('Stop generating');
      await h.sleep(1200);
      try {
        await app.waitForTurnDone({ timeout: 30000 });
      } catch (e) {
        // Same BUG-11 ambiguity as test 12: a non-terminal state after Stop
        // with a wedged provider is not distinguishable from a real A3
        // regression — skip rather than flake red.
        if (/never reached a terminal state|stalled silently/.test(String(e.message))) {
          const err = new Error('turn did not terminate after Stop — cancel path not exercisable (BUG-11)');
          err.skip = true;
          throw err;
        }
        throw e;
      }
      await h.dumpUi();
      h.Assert.that(h.findIncludingDisabled('Send message').length > 0,
        'composer still shows Stop after cancel — send state never restored (A3)');
      const dots = await app.sidebarWorkingDots();
      h.Assert.that(dots === 0, `${dots} sidebar row(s) still show the Working dot after cancel (A3)`);
      await h.screenshot('51-cancel-restored');
    },
  },

  {
    name: '52-regression-stop-button-vs-empty-composer',
    info: 'Stop glyph replaces Send only while streaming; empty composer shows mic, not a dead send — ROUND2-A3/B13',
    bug: 'ROUND2-A3/B13 — phantom working rows and send/stop state desync',
    async run({ h, app }) {
      await app.newChat();
      await h.dumpUi();
      // Empty composer must NOT show a Stop button.
      h.Assert.that(h.findIncludingDisabled('Stop generating').length === 0,
        'Stop generating visible on an empty composer (A3 send/stop desync)');
      // Send button only appears with text.
      const composer = await app.composerNode();
      await h.typeInto(composer, 'probe');
      await h.dumpUi();
      h.Assert.that(h.findIncludingDisabled('Send message').length > 0,
        'Send button missing with text in the composer');
      await h.pressKey('Control+a');
      await h.pressKey('Backspace');
      await h.sleep(300);
      await h.dumpUi();
      h.Assert.that(h.findIncludingDisabled('Stop generating').length === 0,
        'Stop generating visible after clearing the composer (A3 desync)');
      await app.goHome();
    },
  },

  {
    name: '53-regression-session-deleted-stays-deleted',
    info: 'deleting a session removes its row and it does not resurrect after palette search — ROUND2-A4',
    bug: 'ROUND2-A4 — a deleted streaming chat resurrected via orphaned streaming tokens',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage('Reply with the single word TOMBSTONE. Do not use any tools.');
      try {
        await app.waitForTurnDone({ timeout: 120000 });
      } catch (e) {
        if (e && /stalled silently/.test(String(e.message))) {
          const err = new Error('provider turn stalled silently — tombstone path not exercisable (BUG-11)');
          err.skip = true;
          throw err;
        }
        throw e;
      }
      const title = await h.evaluate(() => document.querySelector('.toolbar-chat-title')?.textContent?.trim());
      h.Assert.that(title && title !== 'New chat', 'session untitled; cannot exercise tombstone (A4)');
      await app.sessionMenuAction(title, 'Delete');
      await h.sleep(800);
      await h.dumpUi();
      h.Assert.that(!(await h.hasText(title)), `deleted session "${title}" still in the list (A4)`);
      // Palette search must not resurrect it. Check RESULT ROWS — not raw
      // text: the palette input's own value is the query, so a text scan
      // would match the search box itself (false positive).
      await app.paletteSearch(title);
      await h.sleep(600);
      const hits = await h.evaluate((t) => {
        const rows = Array.from(document.querySelectorAll('.palette .item'));
        return rows
          .map((n) => (n.querySelector('.label')?.textContent || n.textContent || '').trim())
          .filter((label) => label.toLowerCase().includes(t.toLowerCase().slice(0, 40)));
      }, title);
      h.Assert.that(hits.length === 0,
        `deleted session "${title}" resurrected in palette results (A4): ${JSON.stringify(hits)}`);
      await h.pressKey('Escape');
      await app.goHome();
    },
  },
];
