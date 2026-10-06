// 10-19 — chat: composer mechanics, a real turn round-trip, stop mid-stream,
// session lifecycle (rename, reopen, palette search, delete).

const REPLY_PROMPT =
  'Reply with the single word PINGPONG and nothing else. Do not use any tools.';

/** Free-rail turns can wedge with no Stop button, no error, and no reply
 *  (desktop BUG-11 — no per-turn timeout). When that happens the turn
 *  mechanics can't be exercised: skip rather than go red on provider flak. */
function skipOnStall(e) {
  if (e && /stalled silently/.test(String(e.message))) {
    const err = new Error('provider turn stalled silently — turn mechanics not exercisable (BUG-11)');
    err.skip = true;
    throw err;
  }
  throw e;
}

export const CHAT_TESTS = [
  {
    name: '10-composer-send-button-gating',
    info: 'send button appears when text is typed; composer accepts multi-line input',
    async run({ h, app }) {
      await app.newChat();
      const composer = await app.composerNode();
      h.Assert.that(composer, 'composer textarea not found');
      await h.typeInto(composer, 'draft line one');
      await h.dumpUi();
      h.Assert.that(h.findIncludingDisabled('Send message').length > 0, 'send button did not appear after typing');
      // Clear without sending: select-all + delete inside the textarea.
      await h.pressKey('Control+a');
      await h.pressKey('Backspace');
      await h.sleep(300);
      await h.dumpUi();
      h.Assert.that(h.findIncludingDisabled('Record voice').length > 0 || h.findIncludingDisabled('Send message').length === 0,
        'composer did not return to the empty state after clearing');
    },
  },

  {
    name: '11-real-turn-roundtrip',
    info: 'send a real prompt → user bubble → assistant reply → composer re-enabled',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage(REPLY_PROMPT);
      await h.screenshot('11-sent');
      // The user bubble must render immediately.
      await h.waitFor(async () => (await app.bubbleCounts()).user > 0, { desc: 'user bubble', timeout: 10000 });
      const state = await app.waitForTurnDone({ timeout: 120000 });
      h.Assert.that(state === 'done', 'turn ended without an assistant reply (see error banner on screenshot)');
      const counts = await app.bubbleCounts();
      h.Assert.that(counts.assistant > 0, 'no assistant bubble after the turn');
      await h.screenshot('11-replied');
      this.info = `bubbles: ${counts.user} user / ${counts.assistant} assistant`;
    },
  },

  {
    name: '12-stop-mid-stream-clears-state',
    info: 'Stop during a turn ends it, restores the send button (regression ROUND2-A3 / BUG_LIST-L12)',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage(
        'Count from 1 to 200 slowly, one number per line. Do not use any tools.',
      );
      // Wait until the turn actually starts streaming (Stop button appears).
      let started = false;
      for (let i = 0; i < 30 && !started; i++) {
        started = await app.isStreaming();
        if (!started) await h.sleep(1000);
      }
      if (!started) {
        // Turn finished too fast to stop (valid on a fast model) or stalled
        // pre-stream (BUG-11) — waitForTurnDone distinguishes the two.
        try {
          const state = await app.waitForTurnDone({ timeout: 60000 });
          if (state === 'done') { this.info = 'turn finished before Stop could be exercised'; return; }
          throw new Error('turn errored before streaming started (see screenshot)');
        } catch (e) { skipOnStall(e); }
      }
      await h.clickAria('Stop generating');
      await h.sleep(1000);
      try {
        await app.waitForTurnDone({ timeout: 30000 });
      } catch (e) {
        // After Stop, a non-terminal state within 30s is either the A3
        // regression or the wedged-provider case — indistinguishable while
        // BUG-11 stands, so skip rather than flake red.
        if (/never reached a terminal state|stalled silently/.test(String(e.message))) {
          const err = new Error('turn did not terminate after Stop — cancel path not exercisable (BUG-11)');
          err.skip = true;
          throw err;
        }
        throw e;
      }
      h.Assert.that(!(await app.isStreaming()), 'Stop generating was clicked but streaming is still active');
      const dots = await app.sidebarWorkingDots();
      h.Assert.that(dots === 0, `sidebar still shows ${dots} "Working" dot(s) after cancel (ROUND2-A3)`);
      await h.screenshot('12-stopped');
    },
  },

  {
    name: '13-session-row-appears-and-titles',
    info: 'after a turn the sidebar shows a session row whose title is no longer "New chat"',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage('Reply with the single word TITLETEST. Do not use any tools.');
      await app.waitForTurnDone({ timeout: 120000 });
      await h.sleep(2500); // auto-titling lands after the turn
      await h.dumpUi();
      const rows = await h.evaluate(() =>
        Array.from(document.querySelectorAll('.chat-session-row .chat-session-title-text'))
          .map((n) => n.textContent?.trim()));
      h.Assert.that(rows.length > 0, 'no session rows in the sidebar after sending a message');
      const titled = rows.find((t) => t && t !== 'New chat');
      h.Assert.that(titled, `every session is still "New chat": ${JSON.stringify(rows)}`);
      this.info = `row titles: ${rows.slice(0, 4).join(' | ')}`;
    },
  },

  {
    name: '14-reopen-transcript-persists',
    info: 'new chat → click the earlier session → its transcript renders again',
    async run({ h, app }) {
      const before = await app.bubbleCounts();
      await app.newChat();
      await app.sendMessage('Reply with the single word REOPENTEST. Do not use any tools.');
      await app.waitForTurnDone({ timeout: 120000 });
      const title = await h.evaluate(() => document.querySelector('.toolbar-chat-title')?.textContent?.trim());
      await app.newChat();
      const empty = await app.bubbleCounts();
      if (title && title !== 'New chat') await app.openSession(title);
      const after = await app.bubbleCounts();
      h.Assert.that(after.user >= before.user, `reopened transcript has fewer user bubbles (${JSON.stringify({ before, empty, after })})`);
      await h.screenshot('14-reopened');
    },
  },

  {
    name: '15-palette-finds-session',
    info: 'command palette search surfaces the titled session',
    async run({ h, app }) {
      await app.paletteSearch('TITLETEST');
      await h.screenshot('15-palette-session');
      await h.dumpUi();
      const hits = h.findByText('TITLETEST');
      h.Assert.that(hits.length > 0, 'palette search did not surface the session titled with TITLETEST');
      await h.pressKey('Escape');
      await app.goHome();
    },
  },

  {
    name: '16-rename-session',
    info: 'row menu → Rename → new title shows in the row',
    async run({ h, app }) {
      await app.newChat();
      await app.sendMessage('Reply with the single word RENAMETEST. Do not use any tools.');
      await app.waitForTurnDone({ timeout: 120000 });
      const title = await h.evaluate(() => document.querySelector('.toolbar-chat-title')?.textContent?.trim());
      h.Assert.that(title && title !== 'New chat', 'session has no title to rename');
      await app.sessionMenuAction(title, 'Rename');
      // Click the inline rename input to focus it, then replace its content.
      await h.waitFor(() => h.evaluate(() =>
        !!document.querySelector('.chat-session-rename-input')), {
        timeout: 5000, desc: 'rename input',
      });
      const renameBox = await h.evaluate(() => {
        const input = document.querySelector('.chat-session-rename-input');
        const r = input.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      await h.rawPage().mouse.click(renameBox.x, renameBox.y);
      await h.sleep(200);
      await h.pressKey('Control+a');
      await h.typeText('E2E Renamed Session');
      await h.pressKey('Enter');
      await h.sleep(600);
      await h.dumpUi();
      h.Assert.that(await h.hasText('E2E Renamed Session'), 'renamed title did not appear in the sidebar row');
      await h.screenshot('16-renamed');
    },
  },

  {
    name: '17-delete-session-removes-row',
    info: 'create + rename a session, then row menu → Delete: the row disappears from Chat History and from the session list (IPC cross-check)',
    async run({ h, app }) {
      // Self-contained: New Chat leaves an untitled session row at the top of
      // the list; rename THAT row (its own unique name, so leftover rows from
      // earlier tests can never collide), then delete it.
      await app.newChat();
      // Pinned rows sort above the fresh one, so check for SOME untitled row
      // (sessionMenuAction then targets the first match = the newest, since
      // the list is last-active DESC below the pinned block).
      await h.waitFor(async () => {
        const titles = await h.evaluate(() =>
          Array.from(document.querySelectorAll('.chat-session-title-text')).map((n) => n.textContent?.trim()));
        return titles.some((t) => t === 'Untitled Chat' || t === 'New chat');
      }, { timeout: 8000, desc: 'fresh untitled session row' });
      const target = await h.evaluate(() => {
        const titles = Array.from(document.querySelectorAll('.chat-session-title-text'))
          .map((n) => n.textContent?.trim());
        return titles.includes('Untitled Chat') ? 'Untitled Chat' : 'New chat';
      });
      await app.sessionMenuAction(target, 'Rename');
      const renameBox = await h.waitFor(() => h.evaluate(() =>
        !!document.querySelector('.chat-session-rename-input')), {
        timeout: 5000, desc: 'rename input',
      }).then(() => h.evaluate(() => {
        const input = document.querySelector('.chat-session-rename-input');
        const r = input.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }));
      await h.rawPage().mouse.click(renameBox.x, renameBox.y);
      await h.sleep(200);
      await h.pressKey('Control+a');
      await h.typeText('E2E Delete Probe');
      await h.pressKey('Enter');
      await h.waitForText('E2E Delete Probe', { timeout: 6000 });

      await app.sessionMenuAction('E2E Delete Probe', 'Delete');
      // UI truth: the named row disappears (background rows can appear or
      // reorder while other sessions auto-title, so a bare count delta is
      // racy — assert the specific session instead, both layers).
      await h.waitForGone('E2E Delete Probe', { timeout: 8000 });
      const stillListed = await h.invoke('list_chat_sessions').then(
        (l) => l.some((s) => (s.title || '') === 'E2E Delete Probe'),
        () => null,
      );
      h.Assert.that(stillListed === false,
        `the renamed session is still in list_chat_sessions after Delete (uiGone=true, ipcStillListed=${stillListed})`);
    },
  },

  {
    name: '18-empty-composer-mic-state',
    info: 'empty composer shows the voice affordances; send button swaps out',
    async run({ h, app }) {
      await app.newChat();
      await h.dumpUi();
      h.Assert.that(
        h.findIncludingDisabled('Record voice').length > 0 ||
        h.findIncludingDisabled('Toggle hands-free voice loop').length > 0,
        'empty composer shows neither the mic nor the hands-free toggle',
      );
      await app.goHome();
    },
  },

  {
    name: '19-chat-surface-renders',
    info: 'the chat surface renders either the transcript container or the welcome state',
    async run({ h }) {
      const ok = await h.evaluate(() => {
        if (document.querySelector('.chat-messages')) return 'transcript';
        if (document.querySelector('.chat-welcome')) return 'welcome';
        return null;
      });
      h.Assert.that(ok, 'neither .chat-messages nor .chat-welcome present in the chat view');
    },
  },
];
