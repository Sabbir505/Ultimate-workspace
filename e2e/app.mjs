// App-level navigation helpers shared by the test flows. These encode the
// Relay app's chrome: hamburger → drawer, Settings gear, Manage rows.

import {
  tap, tapText, tapCenterOf, dumpUi, findByText, back, sleep, swipe, hasText, typeText,
  currentActivity, adb, ensureAppForeground, visibleNodes,
} from './harness.mjs';

/** True when the Relay HOME scene is on top — paired OR unpaired variant.
 *  Multiple markers because the composer placeholder disappears once text is
 *  typed, and the unpaired first-run Home has no greeting and no chips. */
export function homeVisible() {
  if (findByText('Write a message').length) return true;
  for (const g of ['Good morning', 'Good afternoon', 'Good evening', 'Good night'])
    if (findByText(g).length) return true;
  if (findByText('Research a topic').length) return true;
  // Unpaired first-run variant: logo + pairing explainer card.
  if (findByText('take your agent anywhere').length) return true;
  if (findByText('Scan pairing QR code').length) return true;
  return false;
}

/** Go to Home WITHOUT ending up outside the app.
 *  Preference order: an on-screen Back affordance (pushed screens), else the
 *  drawer's "New chat" (navigate HomeMain), else a guarded system Back (the
 *  only way out of modals, which carry no visible Back) — after which we
 *  verify Expo Go is still foreground and relaunch its experience if not, so
 *  the app never stays closed. */
export async function goHome() {
  let sysBacks = 0;
  for (let i = 0; i < 14; i++) {
    dumpUi();
    if (devMenuOpen()) { await dismissDevMenu(); continue; }
    if (findByText('Close menu').length) { await closeDrawer(); continue; }
    if (homeVisible()) return;
    if (!currentActivity().includes('host.exp.exponent')) { await ensureAppForeground(); continue; }

    // Back affordance: RN often marks only the wrapper as clickable, so the
    // icon node carrying content-desc "Back" reads clickable=false — accept
    // either; a center tap on the 88px square still hits the button.
    const backBtn = findByText('Back', { exact: true });
    if (backBtn.length) { await tapCenterOf(backBtn[0]); await sleep(650); continue; }

    const openMenu = findByText('Open sidebar').length ? findByText('Open sidebar')
      : findByText('Open menu');
    if (openMenu.length) {
      await tapCenterOf(openMenu[0]);
      await waitForDrawer();
      await waitAndTap('New chat', { expectText: 'Write a message' });
      continue;
    }
    // Modal (no Back, no drawer). Bound the system-Back attempts and always
    // restore the app if the press fell through to the launcher.
    if (sysBacks++ < 3) {
      await back();
      await sleep(500);
      if (!currentActivity().includes('host.exp.exponent')) {
        await ensureAppForeground();
        await sleep(2500);
      }
      continue;
    }
    throw new Error('goHome: could not reach Home after Back affordances, drawer, and 3 guarded system Backs');
  }
  throw new Error('could not return to Home');
}

export async function openDrawer() {
  await goHome();
  // The hamburger can vanish for a beat mid scene-transition — wait for it.
  let menu = [];
  for (let i = 0; i < 10; i++) {
    dumpUi();
    if (findByText('Close menu').length) return; // already open
    menu = findByText('Open menu').length ? findByText('Open menu') : findByText('Open sidebar');
    if (menu.length) break;
    await sleep(500);
  }
  if (!menu.length) throw new Error('openDrawer: no drawer button after 5s');
  await tapCenterOf(menu[0]);
  await waitForDrawer();
}

export async function waitForDrawer() {
  for (let i = 0; i < 10; i++) {
    dumpUi();
    if (findByText('Search chats and messages').length || findByText('Close menu').length) {
      await sleep(700); // let the slide-in finish — rows measured mid-slide tap wrong
      return;
    }
    await sleep(300);
  }
  throw new Error('drawer did not open');
}

export async function closeDrawer() {
  dumpUi();
  if (findByText('Close menu').length) {
    await tapText('Close menu');
    await sleep(400);
  }
}

/** Expo Go's floating dev-menu overlay (dev builds only). Its presence means
 *  a stray tap hit the FAB or something shook the device — dismiss it. */
export function devMenuOpen() {
  return findByText('Open DevTools').length > 0 || findByText('Fast Refresh').length > 0;
}

export async function dismissDevMenuIfOpen() {
  try {
    dumpUi();
    if (devMenuOpen()) await dismissDevMenu();
  } catch { /* best effort */ }
}

async function dismissDevMenu() {
  const close = findByText('Close', { exact: true });
  if (close.length) { await tapCenterOf(close[0]); await sleep(700); return; }
  // Back is consumed by the menu overlay — the app stays foregrounded.
  await back();
  await sleep(600);
}

/** Open the Settings screen. Home has NO gear button (Settings lives in the
 *  drawer footer; the top-right circle on Home is Expo Go's dev-menu FAB in
 *  dev builds). So: dismiss any dev menu, then drawer → Settings row. */
export async function openSettings() {
  await goHome();
  dumpUi();
  if (devMenuOpen()) {
    await dismissDevMenu();
    await goHome();
  }
  if (!findByText('Desktop connection').length) {
    await openDrawer();
    await tapText('Settings', { exact: true });
  }
  for (let i = 0; i < 10; i++) {
    dumpUi();
    if (findByText('Desktop connection').length) {
      await sleep(700); // settle the push transition before measuring rows
      return;
    }
    await sleep(300);
  }
  throw new Error('Settings screen did not open');
}

/** Wait for a row/label to be on screen (scrolling down to find it), tap it,
 *  and verify `expectText` appears — the safe primitive for nav rows. */
export async function waitAndTap(label, { expectText, scrolls = 2 } = {}) {
  for (let attempt = 0; attempt <= scrolls; attempt++) {
    dumpUi();
    const rows = findByText(label, { exact: true });
    if (rows.length) {
      await tapCenterOf(rows[0]);
      if (!expectText) return;
      const start = Date.now();
      while (Date.now() - start < 15000) {
        dumpUi();
        if (findByText(expectText).length) return;
        await sleep(400);
      }
      throw new Error(`tapped "${label}" but "${expectText}" never appeared`);
    }
    if (attempt < scrolls) {
      await swipe(540, 1800, 540, 700, 350);
      await sleep(500);
    }
  }
  throw new Error(`"${label}" not found on screen after scrolling`);
}

/** Settings → Manage → <label>. Returns when the screen's own chrome shows. */
export async function openManage(label, expectText) {
  await openSettings();
  await waitAndTap(label, { expectText });
}

/** The connection status pill in the top app bar. */
export function statusPill() {
  const connected = findByText('Connected', { exact: true });
  if (connected.length) return 'connected';
  const offline = findByText('Offline', { exact: true });
  if (offline.length) return 'offline';
  const connecting = findByText('Connecting', { exact: false });
  return connecting.length ? 'connecting' : 'unknown';
}

export async function waitForStatus(state, { timeout = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    dumpUi();
    if (statusPill() === state) return;
    await sleep(700);
  }
  throw new Error(`status never became "${state}" within ${timeout}ms`);
}

/** Type into the currently-focused input and dismiss the keyboard. */
export async function typeIntoFocus(text) {
  await typeText(text);
  await sleep(200);
}

/** Detect a React Native red-box / JS error overlay in the current dump. */
export function dumpHasErrorMarkers(xml) {
  return /TypeError|ReferenceError|Invariant Violation|Cannot read propert|RedBox/.test(xml);
}

export { tap, tapText, tapCenterOf, dumpUi, findByText, back, sleep, swipe, hasText };
