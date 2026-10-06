// Relay desktop chrome navigation — the DOM counterpart of e2e/app.mjs.
// Encodes the app shell's anatomy: sidebar footer buttons, overlay views
// (Settings/Skills/Cost — closed via the header ✕), full-page views
// (Automations/Vault/Wiki/Logs — closed via "Back to chat"), the composer,
// and the command palette.

import {
  dumpUi, findByText, findIncludingDisabled, findEditable, clickNode, clickText, clickAria,
  waitFor, waitForText, waitForGone, hasText, typeText, pressKey, typeInto, sleep,
  evaluate, rawPage,
} from './harness.mjs';

// ------------------------------------------------------------ view state ----

/** Chat view is on screen AND interactive: the composer textarea is visible
 *  and not covered by an overlay (the Settings/Skills/Cost modals keep the
 *  grid mounted behind them, so presence alone would false-positive). */
export async function chatVisible() {
  await dumpUi();
  const candidates = findIncludingDisabled('Write a message')
    .concat(findIncludingDisabled('keep typing to queue follow-up changes'))
    .concat(findIncludingDisabled('Ask anything, or select an agent'));
  return candidates.some((n) => !n.occluded);
}

/** Close whatever surface is open and land back on the chat view.
 *  Overlays (Settings/Skills/Cost) close via their header ✕; full-page
 *  views (Automations/Vault/Wiki/Logs) via the sidebar's "Back to chat";
 *  stray popups/modals via Escape. Never navigates the app away. */
export async function goHome() {
  for (let i = 0; i < 10; i++) {
    if (await chatVisible()) return;
    await dumpUi();
    // Notification panel / palette / menus: Escape first.
    if (findByText('You’re all caught up').length || findByText('You\'re all caught up').length) {
      await pressKey('Escape');
      await sleep(250);
      continue;
    }
    // Full-page views have a "Back to chat" affordance in the sidebar header.
    const backToChat = findByText('Back to chat');
    if (backToChat.length) {
      await clickNode(backToChat[0]);
      await sleep(500);
      continue;
    }
    // Overlay views (settings/skills/cost): the ✕ ghost button in the
    // header. JS click — deterministic even while the panel is re-rendering.
    // NB: match by glyph — the header also holds other .ghost buttons (the
    // cost range toggle "7d/30d/90d").
    const closed = await evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.view-overlay .view-header button.ghost'))
        .find((b) => (b.textContent || '').trim() === '✕');
      if (btn) {
        btn.click();
        return 'close-btn';
      }
      // Fallback: the overlay closes on a pointerdown that lands on the
      // backdrop itself — dispatching on the overlay element makes
      // e.target === e.currentTarget exactly like a real backdrop click.
      const overlay = document.querySelector('.view-overlay');
      if (overlay) {
        overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        return 'backdrop';
      }
      return false;
    });
    if (closed) {
      await sleep(500);
      continue;
    }
    await pressKey('Escape');
    await sleep(400);
  }
  throw new Error('goHome: could not reach the chat view');
}

export async function newChat() {
  await goHome();
  await clickAria('New Chat');
  await waitFor(() => chatVisible(), { desc: 'composer after New Chat' });
  await sleep(400);
}

// -------------------------------------------------------------- overlays ----

/** Wait for the Settings overlay to actually mount (lazy chunk). */
export async function waitForSettingsOpen() {
  await waitFor(() => evaluate(() => !!document.querySelector('.settings-modal')), {
    timeout: 15000, desc: 'settings modal (lazy chunk)',
  });
  await sleep(400);
}

export async function openSettings() {
  await clickAria('Settings');
  await waitForSettingsOpen();
}

export async function closeSettings() {
  await goHome();
}

/** Open a Settings category by its nav label (e.g. "Appearance"). */
export async function openSettingsCategory(label) {
  await clickText(label, { exact: true });
  await sleep(500);
}

export async function openSkills() {
  await clickAria('Skills Library');
  await waitForText('Skills & Loops Library', { timeout: 10000 });
  await sleep(400);
}

export async function openCost() {
  await clickAria('Cost');
  await waitFor(() => evaluate(() => !!document.querySelector('.view-overlay .view-panel')), {
    timeout: 15000, desc: 'cost overlay (lazy chunk)',
  });
  await waitForText('Usage', { exact: true, timeout: 15000 });
  await sleep(600); // rollups fetch
}

export async function openAutomations() {
  await clickAria('Open automations');
  await waitFor(() => evaluate(() => !!document.querySelector('.automations-view')), {
    timeout: 10000, desc: 'automations view',
  });
  await sleep(400);
}

export async function openVault() {
  await clickAria('Open vault');
  await waitFor(() => evaluate(() => !!document.querySelector('.vault-view')), {
    timeout: 10000, desc: 'vault view',
  });
  await sleep(500);
}

export async function openWiki() {
  await clickAria('Open project wiki');
  await waitFor(() => evaluate(() => !!document.querySelector('[data-testid="wiki-view"]')), {
    timeout: 10000, desc: 'wiki view',
  });
  await sleep(400);
}

export async function openLogs() {
  await clickAria('Model request log');
  await waitFor(() => evaluate(() => !!document.querySelector('.logs-view')), {
    timeout: 10000, desc: 'logs view',
  });
  await sleep(400);
}

// ------------------------------------------------------------------ palette --

export async function openPalette() {
  await pressKey('Control+k');
  await waitForText('Search sessions, chats, projects, actions', { timeout: 6000 });
}

export async function paletteSearch(query) {
  await openPalette();
  await typeText(query);
  await sleep(500);
}

/** Pick a palette row by visible label. Palette rows are plain divs (no
 *  button semantics), so they need their own locator — a text search over
 *  the general selector would hit the palette input (its VALUE equals the
 *  query) instead of a result row. */
export async function palettePick(label) {
  const ok = await evaluate((lbl) => {
    const items = Array.from(document.querySelectorAll('.palette .item'));
    const needle = lbl.toLowerCase();
    const hit = items.find((n) =>
      (n.querySelector('.label')?.textContent || '').trim().toLowerCase() === needle)
      ?? items.find((n) => (n.textContent || '').toLowerCase().includes(needle));
    if (!hit) return false;
    const r = hit.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    hit.click();
    return true;
  }, label);
  if (!ok) throw new Error(`palettePick: no palette row "${label}"`);
  await sleep(600);
}

// ------------------------------------------------------------------- chat ----

/** The composer textarea node (from a fresh dump). */
export async function composerNode() {
  await dumpUi();
  const editable = findEditable().filter(
    (n) => n.tag === 'textarea' && n.placeholder,
  );
  return editable[0] ?? null;
}

/** Type a message into the composer and send it via the send button.
 *  Captures the pre-send assistant-bubble count so waitForTurnDone can tell
 *  a NEW reply from an old one even when the turn finishes instantly. */
let lastSendBaseline = null;
export async function sendMessage(text) {
  const composer = await composerNode();
  if (!composer) throw new Error('sendMessage: composer not visible');
  lastSendBaseline = await evaluate(() => ({
    bubbles: document.querySelectorAll('.chat-bubble.assistant').length,
  }));
  await typeInto(composer, text);
  await dumpUi();
  const send = findByText('Send message');
  if (!send.length) throw new Error('sendMessage: send button not enabled/visible');
  await clickNode(send[0]);
  await sleep(400);
}

/** Wait for the turn to reach a terminal state: the Stop button disappears
 *  (streaming over) AND at least one NEW assistant bubble exists, or an
 *  error banner shows. Returns 'done' | 'error'.
 *  Throws a distinct stall error when the turn neither streams, errors, nor
 *  replies — the desktop app has no per-turn timeout, so a wedged provider
 *  request otherwise just hangs the test (BUG-11). */
export async function waitForTurnDone({ timeout = 120000, stallAfterMs = 30000, streamingHangMs = 90000 } = {}) {
  const start = Date.now();
  const baseline = lastSendBaseline ?? (await evaluate(() => ({
    bubbles: document.querySelectorAll('.chat-bubble.assistant').length,
  })));
  let sawStop = false;
  while (Date.now() - start < timeout) {
    const s = await evaluate(() => ({
      stop: !!Array.from(document.querySelectorAll('button'))
        .find((b) => b.getAttribute('aria-label') === 'Stop generating'),
      err: !!document.querySelector('.chat-error'),
      bubbles: document.querySelectorAll('.chat-bubble.assistant').length,
    }));
    if (s.stop) sawStop = true;
    if (s.err) return 'error';
    if (!s.stop && s.bubbles > baseline.bubbles) return 'done';
    if (!sawStop && !s.stop && Date.now() - start > stallAfterMs) {
      throw new Error(
        `turn stalled silently: no Stop button, no error banner, and no assistant reply ` +
        `${Math.round((Date.now() - start) / 1000)}s after send (desktop BUG-11 — wedged provider turn with no per-turn timeout)`,
      );
    }
    // Mid-stream variant: the Stop button has been up (streaming) for far
    // longer than any sane completion window with no terminal state.
    if (s.stop && Date.now() - start > streamingHangMs) {
      throw new Error(
        `turn stalled mid-stream: Stop button up ${Math.round((Date.now() - start) / 1000)}s ` +
        `with no completion and no error (desktop BUG-11 — no per-turn timeout)`,
      );
    }
    await sleep(800);
  }
  throw new Error('waitForTurnDone: turn never reached a terminal state');
}

/** Is a turn currently streaming? (Stop button visible.) */
export async function isStreaming() {
  return evaluate(() =>
    !!Array.from(document.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Stop generating'));
}

/** The sidebar "Working…" spinner — regression sentinel for stuck states. */
export async function sidebarWorkingDots() {
  await dumpUi();
  return findIncludingDisabled('Working').filter((n) => n.aria === 'Working').length;
}

/** Click a chat session row by its title. */
export async function openSession(title) {
  await dumpUi();
  const rows = await evaluate((t) => {
    const rows = Array.from(document.querySelectorAll('.chat-session-row'));
    const hit = rows.find((r) =>
      r.querySelector('.chat-session-title-text')?.textContent?.trim() === t)
      ?? rows.find((r) => (r.getAttribute('title') || r.textContent || '').includes(t));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 20)) };
  }, title);
  if (!rows) throw new Error(`openSession: session "${title}" not in the list`);
  await rawPage().mouse.click(rows.x, rows.y);
  await sleep(600);
}

/** Row menu → action. The menu is a position:fixed portal; a JS click on
 *  the exact menuitem is deterministic (a real-mouse click at coordinates
 *  measured even 100ms earlier loses to the menu's entrance animation). */
export async function sessionMenuAction(sessionTitle, action) {
  const clicked = await evaluate((t, a) => {
    const rows = Array.from(document.querySelectorAll('.chat-session-row'));
    const hit = rows.find((r) =>
      r.querySelector('.chat-session-title-text')?.textContent?.trim() === t)
      ?? rows.find((r) => (r.getAttribute('title') || r.textContent || '').includes(t));
    if (!hit) return 'no-row';
    const btn = hit.querySelector('button[aria-label="Chat options"]');
    if (!btn) return 'no-menu-btn';
    const openMenu = document.querySelector('.chat-session-menu[role="menu"]');
    const alreadyOpen = !!openMenu;
    if (!alreadyOpen) btn.click();
    return 'ok';
  }, sessionTitle, action);
  if (clicked === 'no-row') throw new Error(`sessionMenuAction: row "${sessionTitle}" not found`);
  if (clicked === 'no-menu-btn') throw new Error(`sessionMenuAction: "Chat options" button missing on "${sessionTitle}"`);
  // Wait for the portal menu and click the item by its own text.
  const done = await waitFor(() => evaluate((a) => {
    const menu = document.querySelector('.chat-session-menu[role="menu"]');
    if (!menu) return false;
    const item = Array.from(menu.querySelectorAll('button[role="menuitem"]'))
      .find((b) => (b.textContent || '').trim().toLowerCase().includes(a.toLowerCase()));
    if (!item) return false;
    item.click();
    return true;
  }, action), { timeout: 5000, desc: `menu item "${action}"` });
  if (!done) throw new Error(`sessionMenuAction: menu item "${action}" never appeared`);
  await sleep(400);
}

// ------------------------------------------------------------------ window ----

/** Read the current document theme class (dark/light) from <html>. */
export async function documentTheme() {
  return evaluate(() => {
    const el = document.documentElement;
    if (el.classList.contains('dark')) return 'dark';
    if (el.classList.contains('light')) return 'light';
    return el.getAttribute('data-theme') || 'unknown';
  });
}

/** Count assistant/user bubbles in the active transcript. */
export async function bubbleCounts() {
  return evaluate(() => ({
    user: document.querySelectorAll('.chat-bubble.user').length,
    assistant: document.querySelectorAll('.chat-bubble.assistant').length,
  }));
}
