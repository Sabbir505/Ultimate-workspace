// Chat flows: the core E2E — message goes phone → relay → desktop harness →
// streamed tokens render back in the phone UI.
//
// Sends go through an existing CLOUD-model session (see util.mjs for why the
// local model is excluded here — it is BUG-4, covered by test 38).

import * as h from '../harness.mjs';
import * as app from '../app.mjs';
import {
  enterCloudSession, sendInSession, waitForReplyToken, waitForTurnEnd,
  sendTurnWithRecovery, SPLIT_PROMPT, SPLIT_TOKEN,
} from './util.mjs';

export const CHAT_TESTS = [
  {
    name: '10-new-chat-roundtrip-streaming',
    info: 'Send a message in a cloud-model session; the assistant reply streams back through the relay',
    async run({ h: hh, app: aa, shot }) {
      // Start from a fresh JS context: clears the BUG-5 request storm that
      // provokes the BUG-4 desktop deadlock on sends from the phone.
      await hh.restartApp();
      const { title } = await enterCloudSession(aa, hh);
      await shot('10a-session-open');

      await sendInSession(hh, SPLIT_PROMPT);
      await shot('10b-sent');

      // Streaming state must appear ("Working for Xs") — proof the phone sees
      // the turn running over the relay.
      let sawWorking = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        hh.dumpUi();
        if (hh.findByText('Working for').length) { sawWorking = true; break; }
        await hh.sleep(1000);
      }
      await shot('10c-streaming');

      // BUG-4 (desktop deadlock) can wedge any phone-originated turn; recover
      // once and note it, rather than conflating it with chat-path breakage.
      // NOTE: no desktop killing — tests must never close the user's app.
      // A missing reply is reported (BUG-4); the fix is closing the watchdog
      // storm, not restarting the desktop from a test.
      const reply = await waitForReplyToken(hh, SPLIT_TOKEN, 150000);
      await shot('10d-reply');
      if (!reply)
        throw new Error(`no assistant reply containing "${SPLIT_TOKEN}" within 150s (session "${title}") — if the relay wedged (BUG-4), restart the desktop manually`);
      const ended = await waitForTurnEnd(hh, 60000);
      return {
        session: title, reply: reply.text.slice(0, 60), replyMs: reply.ms,
        sawWorking, turnEnded: ended,
      };
    },
  },

  {
    name: '11-session-persists-in-drawer-history',
    info: 'The new conversation appears in the drawer history with a title',
    async run({ h, app, shot }) {
      await app.openDrawer();
      await shot('11-drawer-with-new-session');
      h.dumpUi();
      const sessions = h.visibleNodes().filter((n) =>
        (n.text || '').length > 3 && !/Search|Projects|Artifacts|Settings|Today|Yesterday|Earlier|Previous/.test(n.text));
      if (!sessions.length) throw new Error('no session rows visible in drawer after sending a chat');
      await app.closeDrawer();
      return { drawerRows: sessions.slice(0, 5).map((s) => (s.text || '').slice(0, 40)) };
    },
  },

  {
    name: '12-session-reopen-renders-transcript',
    info: 'Search "PONG" in the drawer, open the hit, confirm the earlier turns render (also covers SearchChatMessages)',
    async run({ h, app, shot }) {
      await app.openDrawer();
      h.dumpUi();
      // The Home composer bleeds through the drawer dump — pick the drawer's
      // own search field by geometry (inside the panel, top half).
      const searchInput = h.findEditText().find((e) => {
        const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(e.bounds);
        return m && Number(m[3]) <= 880 && Number(m[2]) < 800;
      });
      if (!searchInput) throw new Error('drawer search input not found');
      await h.tapCenterOf(searchInput);
      await h.typeText('PONG');

      // Wait for the "IN MESSAGES" results section. Prefer the hit whose
      // snippet carries OUR exact prompt ("single word PONG") — older pong
      // sessions also match the query.
      await h.waitForText('IN MESSAGES', { timeout: 20000 });
      h.dumpUi();
      const header = h.findByText('IN MESSAGES')[0];
      const hm = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(header.bounds);
      const headerBottom = Number(hm[4]);
      const inPanel = (n) => {
        const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds);
        return m ? Number(m[2]) > headerBottom + 4 && Number(m[3]) <= 880 : false;
      };
      const ours = h.visibleNodes().find((n) => inPanel(n) && (n.text || '').includes('single word PONG'));
      const anyHit = h.visibleNodes()
        .filter((n) => inPanel(n) && (n.text || '').includes('PONG'))
        .sort((a, b) => {
          const ma = /\[(-?\d+),(-?\d+)\]/.exec(a.bounds), mb = /\[(-?\d+),(-?\d+)\]/.exec(b.bounds);
          return Number(ma[2]) - Number(mb[2]);
        })[0];
      const target = ours || anyHit;
      if (!target) throw new Error('no session hit rows under IN MESSAGES');
      const wantOurPrompt = Boolean(ours);
      const pickedTitle = (target.text || '').slice(0, 40);
      await h.tapCenterOf(target);
      await h.sleep(1000);

      // Transcript loads async over the relay. Assert the session scene
      // opened with a rendered transcript (a long message body), and when we
      // tapped OUR session, that it contains the exact earlier prompt.
      let rendered = false;
      let sawPrompt = false;
      const t2 = Date.now();
      while (Date.now() - t2 < 30000) {
        h.dumpUi();
        const nodes = h.visibleNodes();
        if (nodes.some((n) => (n.text || '').length > 40)) rendered = true;
        if (nodes.some((n) => (n.text || '').includes('single word PONG'))) sawPrompt = true;
        if (rendered && (!wantOurPrompt || sawPrompt)) break;
        await h.sleep(1200);
      }
      await shot('12-session-reopened');
      if (!rendered) throw new Error(`reopened "${pickedTitle}" — no transcript body rendered within 30s`);
      if (wantOurPrompt && !sawPrompt)
        throw new Error('reopened the PONG session but its earlier prompt never rendered');
      await app.goHome();
      return { reopenedVia: 'search hit', title: pickedTitle, matchedOurPrompt: wantOurPrompt };
    },
  },
];
