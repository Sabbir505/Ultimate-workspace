// Management screens: every drawer/Settings destination loads real data over
// the relay and shows no error bar / red box.

import * as h from '../harness.mjs';
import * as app from '../app.mjs';

/** Shared body for a management-screen visit: navigate, assert the header,
 *  assert no error bar and no error markers, screenshot, come back. */
async function visitManage({ h, app, shot }, label, header, extra) {
  await app.openSettings();
  await app.waitAndTap(label, { expectText: header });
  // Wait for the screen header (or its empty state) to paint.
  await h.waitForText(header, { timeout: 20000 });
  await h.sleep(1200); // let the list land
  h.dumpUi();
  if (h.findByText('Dismiss error').length)
    throw new Error(`"${header}" surfaced the relay error bar`);
  if (app.dumpHasErrorMarkers(h.lastDumpRaw()))
    throw new Error(`"${header}" shows error markers`);
  await shot(`screen-${header.replace(/\s+/g, '-').toLowerCase()}`);
  let info;
  if (extra) info = await extra();
  await app.goHome();
  return info;
}

/** Shared body for a drawer-navigated screen: open drawer, tap link, assert
 *  the header, no error bar, no error markers, screenshot, back home. */
async function visitDrawer({ h, app, shot }, label, header, extra) {
  await app.openDrawer();
  await h.tapText(label, { exact: true });
  await h.waitForText(header, { timeout: 20000 });
  await h.sleep(1200);
  h.dumpUi();
  if (h.findByText('Dismiss error').length)
    throw new Error(`"${header}" surfaced the relay error bar`);
  if (app.dumpHasErrorMarkers(h.lastDumpRaw()))
    throw new Error(`"${header}" shows error markers`);
  await shot(`screen-${header.replace(/\s+/g, '-').toLowerCase()}`);
  const info = extra ? await extra() : undefined;
  await app.goHome();
  return info;
}

export const SCREEN_TESTS = [
  {
    name: '20-artifacts-library',
    async run(ctx) {
      return visitDrawer(ctx, 'Artifacts', 'Artifacts', () => ({
        state: h.findByText('No artifacts yet.').length ? 'empty' : 'artifact rows rendered',
      }));
    },
  },
  {
    name: '21-cost-dashboard',
    async run(ctx) {
      return visitManage(ctx, 'Cost dashboard', 'Cost dashboard', () => ({
        state: h.findByText('No project budgets').length ? 'no budgets (loaded)'
          : h.findByText('Loading').length ? 'still loading' : 'rollups rendered',
      }));
    },
  },
  {
    name: '22-automations',
    async run(ctx) {
      return visitManage(ctx, 'Automations', 'Automations', () => ({
        newButton: h.findByText('New automation').length > 0,
      }));
    },
  },
  {
    name: '23-memory',
    async run(ctx) {
      return visitManage(ctx, 'Memory', 'Memory', () => ({
        purgeButton: h.findByText('Purge all memories').length > 0,
      }));
    },
  },
  {
    name: '24-skills-and-loops',
    async run(ctx) {
      return visitManage(ctx, 'Skills & loops', 'Skills', () => ({
        state: h.findByText('installed yet').length ? 'empty state' : 'installed skills listed',
      }));
    },
  },
  {
    name: '25-git-panel',
    async run(ctx) {
      return visitManage(ctx, 'Git', 'Git', () => ({
        state: h.findByText('No projects registered').length ? 'no projects'
          : h.findByText('Commit').length || h.findByText('Push').length ? 'status + actions rendered' : 'header only',
      }));
    },
  },
  {
    name: '26-notifications-center',
    async run(ctx) {
      return visitManage(ctx, 'Notifications', 'Notifications', () => ({
        state: h.findByText('Nothing yet').length ? 'empty state' : 'entries listed',
      }));
    },
  },
  {
    name: '27-terminal-mirror',
    info: 'Terminal lives in the chat header — opened from a session scene',
    async run({ h, app, shot }) {
      // Open the most recent session from the drawer, then the terminal view.
      await app.openDrawer();
      h.dumpUi();
      const bucket = h.findByText('Today')[0] || h.findByText('Earlier')[0];
      if (!bucket) throw new Error('no drawer bucket');
      const bm = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bucket.bounds);
      const by = Number(bm[2]);
      const rows = h.visibleNodes().filter((n) => {
        if (!n.text || n.text.length < 2) return false;
        const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds);
        if (!m) return false;
        const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        return x1 >= 30 && x2 <= 855 && y1 > by + 10 && y2 < 2300 &&
          !/^(Today|Yesterday|Earlier|Pinned|Projects|Artifacts|Settings|New chat|Search chats and messages|Relay|Connected)$/i.test(n.text.trim());
      }).sort((a, b) => {
        const ma = /\[(-?\d+),(-?\d+)\]/.exec(a.bounds), mb = /\[(-?\d+),(-?\d+)\]/.exec(b.bounds);
        return Number(ma[2]) - Number(mb[2]);
      });
      if (!rows.length) throw new Error('no session in drawer to open Terminal from');
      await h.tapCenterOf(rows[0]);
      await h.sleep(2000);
      h.dumpUi();
      let term = h.findByText('Open terminal view');
      if (!term.length) {
        // scene may still be settling — one re-dump + retry
        await h.sleep(2000);
        h.dumpUi();
        term = h.findByText('Open terminal view');
      }
      if (!term.length) throw new Error('Open terminal view button not in chat header');
      await h.tapCenterOf(term[0]);
      await h.waitForText('Terminal', { timeout: 15000 });
      await h.sleep(1500);
      h.dumpUi();
      if (h.findByText('Dismiss error').length) throw new Error('Terminal surfaced the error bar');
      await shot('screen-terminal');
      await app.goHome();
      return { state: h.findByText('No terminal output yet').length ? 'no live pane' : 'transcript rendered' };
    },
  },
  {
    name: '28-wiki',
    async run(ctx) {
      return visitManage(ctx, 'Project wiki', 'Wiki', () => ({
        state: h.findByText('No pages yet').length ? 'no pages' : 'pages listed',
      }));
    },
  },
  {
    name: '29-vault',
    async run(ctx) {
      return visitManage(ctx, 'Vault', 'Vault', () => ({
        state: h.findByText('No vault bound').length ? 'no vault bound'
          : h.findByText('Vault is offline').length ? 'offline' : 'tree rendered',
      }));
    },
  },
];
