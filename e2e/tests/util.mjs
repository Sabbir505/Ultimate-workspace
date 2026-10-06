// Shared helpers for chat-flow tests.
//
// Why these exist: the LOCAL model (local_gguf / Spark-X2.5-4B) does not
// complete phone-originated turns (BUG-4 — the desktop relay deadlocks at
// session_chat.rs:762 and the phone spins forever). Tests that mean to verify
// CHAT MECHANICS therefore send from an existing CLOUD-model session (the
// drawer's "commandcode" rows), and the local-model failure is covered
// separately by test 38.
//
// Reply assertions use a token split inside the prompt ("Z E B R A") so the
// prompt itself never contains the literal reply ("ZEBRA") — a naive
// findByText('ZEBRA') would otherwise match the user's own bubble.

import * as h from '../harness.mjs';
import * as app from '../app.mjs';

export const SPLIT_TOKEN = 'ZEBRA';
export const SPLIT_PROMPT =
  'Reply with only the 5 letters Z E B R A run together as one word, nothing else.';

/** Open a session whose harness is 'commandcode' (cloud, replies reliably)
 *  from the drawer. Returns the session title for logging.
 *  Drawer row anatomy: title node, then a harness node ("commandcode"), then
 *  an age node (" · 12m") — all separate text nodes.
 *  NOTE: BUG-10 can wedge a session in a permanent loading state after a
 *  failed turn — if the composer never appears, try the NEXT commandcode row. */
export async function enterCloudSession(app, h, { maxTries = 2 } = {}) {
  await app.openDrawer();
  h.dumpUi();
  // Cloud harnesses only — never local/local_gguf (their turns don't run,
  // BUG-4). Prefer opencode (the free-model source the user picked).
  const CLOUD = ['opencode', 'commandcode', 'openrouter', 'claude_code', 'kimi_code'];
  const harnessNodes = h.visibleNodes()
    .filter((n) => CLOUD.includes((n.text || '').trim()))
    .sort((a, b) => CLOUD.indexOf((a.text || '').trim()) - CLOUD.indexOf((b.text || '').trim()));
  if (!harnessNodes.length) throw new Error('no cloud-harness session row in the drawer (need a non-local chat)');
  for (const node of harnessNodes.slice(0, maxTries)) {
    await h.tapCenterOf(node);
    await h.sleep(1800);
    h.dumpUi();
    if (app.homeVisible()) { await app.openDrawer(); h.dumpUi(); continue; }
    // A session composer's placeholder is "Message".
    let ready = false;
    for (let i = 0; i < 10; i++) {
      h.dumpUi();
      if (h.findByText('Message').length && h.findEditText().length) { ready = true; break; }
      await h.sleep(700);
    }
    if (ready) return { title: harnessNodes[0].text.trim() + ' session' };
    // Stuck loading (BUG-10) — back out and try another row.
    const back = h.findByText('Back', { exact: true });
    if (back.length) { await h.tapCenterOf(back[0]); await h.sleep(1000); }
    await app.openDrawer();
    h.dumpUi();
  }
  throw new Error('every commandcode session stayed in the loading state (BUG-10) — no sendable session');
}

/** Send `text` from the currently-open session's composer (send BUTTON, not
 *  Enter — the multiline composer's Enter inserts a newline). */
export async function sendInSession(h, text) {
  const input = h.findEditText().slice(-1)[0]; // session composer is the last EditText
  if (!input) throw new Error('session composer input not found');
  // Clear anything stale first.
  await h.tapCenterOf(input);
  await h.clearFocusedField(400);
  await h.typeText(text);
  h.dumpUi();
  const send = h.findByText('Send message');
  if (!send.length) throw new Error('Send message button did not appear after typing');
  await h.tapCenterOf(send[0]);
  await h.sleep(600);
}

/** Poll until a node carries the literal token (not the prompt's spaced form). */
export async function waitForReplyToken(h, token, timeoutMs = 150000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    h.dumpUi();
    const hit = h.visibleNodes().find((n) => {
      const t = (n.text || '').toUpperCase();
      return t.includes(token) && !t.includes(token.split('').join(' '));
    });
    if (hit) return { text: hit.text, ms: Date.now() - start };
    await h.sleep(2500);
  }
  return null;
}

/** The deduped reply text for the LAST user turn only — used to keep
 *  duplicate-bubble counting honest (BUG-3) and to fetch the reply text. */
export function countTokenNodes(h, token) {
  return h.visibleNodes().filter((n) => (n.text || '').toUpperCase().includes(token)).length;
}

/** Wait until the desktop relay is fully up and answering: loopback port
 *  listening AND the phone's status pill reaches "connected". The desktop
 *  boots sidecars/model catalogs slowly — do not send before this. */
export async function waitDesktopHealthy(app, h, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await h.dumpUi();
      if (app.statusPill() === 'connected') return true;
    } catch { /* mid-reload */ }
    await h.sleep(3000);
  }
  throw new Error('desktop never became healthy (phone never showed "connected")');
}

/** Make sure the OPEN session has a model committed. A bare "Model" chip
 *  (no name) means the session would fall back to the last-remembered model
 *  — on this device that is the local GGUF, whose turns do not run (BUG-4).
 *  Opens the picker, uses the OpenCode harness (the user's chosen source of
 *  FREE models), prefers a `-free` row, and verifies the chip updated. */
// Preferred free models in order of observed reliability (2026-10-06):
// fledge replies in ~10s; mimo-v2.6 stalls the opencode spawn; ling-3.1
// answers with a billing/quota notice. Falls back to any '-free' row.
const FREE_MODEL_PREFS = ['fledge-alpha-free', 'muse-spark', 'longcat', 'ling-3.0-flash-fin-free'];
export async function ensureModelSelected(h, { timeoutMs = 90000 } = {}) {
  const readChip = () => {
    const chip = h.visibleNodes().find((n) => (n['content-desc'] || '').startsWith('Model'));
    return chip ? chip['content-desc'] : '';
  };
  h.dumpUi();
  const chipDesc = readChip();
  // Keep it only when the CURRENT model is already an OpenCode (free) one —
  // otherwise switch, even if some other model is committed.
  if (FREE_MODEL_PREFS.some((p) => chipDesc.includes(p))) return chipDesc;
  const chip = h.visibleNodes().find((n) => (n['content-desc'] || '').startsWith('Model'));
  if (!chip) throw new Error('model chip not found in the session header');
  await h.tapCenterOf(chip);
  await h.sleep(2000);
  // OpenCode rail — the FREE-model source. The catalog needs the desktop, so
  // allow up to `timeoutMs` for the rows.
  h.dumpUi();
  const rail = h.findByText('OpenCode models')[0] || h.findByText('CommandCode models')[0];
  if (rail) { await h.tapCenterOf(rail); await h.sleep(1500); }
  const start = Date.now();
  let rows = [];
  while (Date.now() - start < timeoutMs) {
    h.dumpUi();
    rows = h.visibleNodes().filter((n) => (n['content-desc'] || '').startsWith('Model '));
    if (rows.length) break;
    await h.sleep(2000);
  }
  if (!rows.length)
    throw new Error('model picker listed no models (desktop catalog never answered) — refusing to send without a model');
  const pick =
    FREE_MODEL_PREFS.map((p) => rows.find((r) => r['content-desc'].includes(p))).find(Boolean) ||
    rows.find((r) => /free/i.test(r['content-desc'])) ||
    rows[0];
  await h.tapCenterOf(pick);
  await h.sleep(2000);
  h.dumpUi();
  const after = readChip();
  if (!after || /^Model: select/.test(after))
    throw new Error(`model pick did not commit (chip still "${after}")`);
  return after;
}

/** Send + wait for reply. NEVER kills the desktop (tests must not close the
 *  user's app): a missing reply is REPORTED, not "fixed". */
export async function sendTurnWithRecovery(h, app, prompt, token, { perTryMs = 120000 } = {}) {
  await ensureModelSelected(h);
  await sendInSession(h, prompt);
  const reply = await waitForReplyToken(h, token, perTryMs);
  if (!reply) {
    return { reply: null, recovered: false, note: 'no reply within the window — if the relay wedged (BUG-4), restart the desktop manually' };
  }
  return { reply, recovered: false };
}

/** Wait for the turn to finish: "Working for" must disappear. */
export async function waitForTurnEnd(h, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    h.dumpUi();
    if (!h.findByText('Working for').length && !h.findByText('Stop generating').length) return true;
    await h.sleep(2000);
  }
  return false;
}
