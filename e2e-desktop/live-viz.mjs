// One-off LIVE-TURN driver: launches the sandboxed Relay instance (real exe,
// real profile clone), switches a new chat to the free
// `opencode/deepseek-v4-flash-free` model the profile already uses, sends a
// prompt that exercises the `visualize` tool, waits for the turn, and
// screenshots the native cards. This is the end-to-end proof for the
// structured-renderer layer — same machinery as run-e2e.mjs, one turn.
//
//   node live-viz.mjs
//
import * as h from './harness.mjs';
import * as app from './app.mjs';

const MODEL_SEARCH = 'deepseek';
const MODEL_ROW = 'deepseek-v4-flash-free';
const PROMPT =
  'Call the visualize tool TWICE: (1) viz "donut", title "Spend by team", payload {segments: ' +
  '[{label: "Compute", value: 45}, {label: "Storage", value: 30}, {label: "Network", value: 15}, ' +
  '{label: "Other", value: 10}], unit "$k", style {accent "#e07a5f", palette ["#e07a5f", "#3d5a80", ' +
  '"#81b29a", "#f2cc8f"], tone "dark", radius "pill"}}; (2) viz "stat", title "This week", payload ' +
  '{stats: [{label: "Deploys", value: "14", delta: "+3", good: true}, {label: "Error rate", value: ' +
  '"0.4%", delta: "-0.1%", good: true}, {label: "Uptime", value: "99.98%"}], style {tone "light"}}. ' +
  'Use my colors exactly as given. One short sentence after.';

process.on('SIGINT', async () => { await h.shutdown(); process.exit(130); });

const die = async (e) => {
  console.error('live-viz failed:', (e && (e.stack || e.message)) || String(e));
  try { await h.screenshot('live-viz-failure'); } catch { /* best effort */ }
  await h.shutdown();
  process.exit(1);
};

try {
  await h.ensureFrontend();
  await h.launchApp();
  await h.connect();
  // ISOLATION GUARD (same as run-e2e): never touch the real profile.
  const dbPath = await h.invoke('get_chat_db_path');
  const sandboxData = h.sandboxPath('data');
  if (!String(dbPath).toLowerCase().startsWith(sandboxData.toLowerCase())) {
    throw new Error(`ISOLATION BROKEN: db "${dbPath}" outside sandbox "${sandboxData}"`);
  }
  await h.invoke('vault_bind', { path: h.sandboxPath('vault') });
  await h.invoke('set_run_while_closed', { enabled: false });
  console.log('sandbox app up; isolation verified');

  // openrouter/free (already set by the user) is an auto-router: it draws a
  // free model per request and not all of them support tool calling — one run
  // hallucinated success with TOOLS 0ms. Retry up to 3 turns, stop on cards.
  let counts = null;
  for (let attempt = 1; attempt <= 3 && (counts === null || (counts.vizCards === 0 && counts.widgets === 0)); attempt++) {
    console.log(`--- attempt ${attempt} ---`);
    await app.newChat();
    // The free model is already set by the user — log the chip and send.
    const chip = await h.evaluate(
      () => document.querySelector('.agent-chip .agent-chip-label')?.textContent ?? '(unknown)',
    );
    console.log('active model chip:', chip);

    await app.sendMessage(PROMPT);
    await h.screenshot(`live-viz-sent-${attempt}`);
    await h.waitFor(async () => (await app.bubbleCounts()).user > 0, { desc: 'user bubble', timeout: 10000 });
    // Free models with tool loops are SLOW — periodic progress shots while the
    // turn runs, and generous stall windows (the 30s default tripped on a turn
    // that was actively streaming tool calls at 91s).
    let shooting = true;
    const shutter = (async () => {
      while (shooting) {
        await h.sleep(30000);
        if (shooting) { try { await h.screenshot(`live-viz-progress`); } catch { /* mid-turn */ } }
      }
    })();
    const state = await app.waitForTurnDone({ timeout: 600000, stallAfterMs: 150000, streamingHangMs: 300000 });
    shooting = false;
    console.log('turn state:', state);

    await h.sleep(800);
    counts = await h.evaluate(() => ({
      vizCards: document.querySelectorAll('.chat-viz-card').length,
      fallbacks: document.querySelectorAll('.chat-viz-fallback').length,
      charts: document.querySelectorAll('[data-testid="viz-chart"]').length,
      boards: document.querySelectorAll('[data-testid="viz-board"]').length,
      tables: document.querySelectorAll('[data-testid="viz-table"]').length,
      timelines: document.querySelectorAll('[data-testid="viz-timeline"]').length,
      widgets: document.querySelectorAll('.chat-widget-block').length,
    }));
    console.log('DOM result:', JSON.stringify(counts, null, 2));
  }

  // Scroll the first card into view and capture it, then the turn end.
  await h.evaluate(() => {
    const cards = document.querySelectorAll('.chat-viz-card, .chat-widget-block');
    (cards.length ? cards[0] : document.body).scrollIntoView({ block: 'start' });
  });
  await h.sleep(400);
  await h.screenshot('live-viz-cards');
  await h.evaluate(() => {
    const el = document.querySelector('[class*="composer"]') || document.body;
    el.scrollIntoView({ block: 'end' });
  });
  await h.sleep(300);
  await h.screenshot('live-viz-end');

  if (counts.vizCards === 0 && counts.widgets === 0) {
    throw new Error('no visualization cards rendered — see screenshots');
  }
  console.log(`LIVE TURN OK — ${counts.vizCards} native card(s), ${counts.widgets} widget(s)`);
  await h.shutdown();
  process.exit(0);
} catch (e) {
  await die(e);
}
