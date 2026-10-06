// Zero-dependency adb/uiautomator driver for E2E testing the Relay mobile
// app running in Expo Go on a USB-connected Android phone.
//
// Prereqs (setup-e2e.ps1 does all of this):
//   - platform-tools/adb.exe available (ADOPT path in TOOLS_DIR)
//   - `adb reverse tcp:8081 tcp:8081`   (Metro)
//   - `adb reverse tcp:<relay> tcp:<relay>` (desktop relay)
//   - e2e/.pairing-token holds the desktop pairing token

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = path.join(os.homedir(), 'relay-e2e-tools', 'platform-tools');
const ADB = path.join(TOOLS_DIR, process.platform === 'win32' ? 'adb.exe' : 'adb');
export const ARTIFACTS = path.join(HERE, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

export const DEVICE = process.env.ADB_SERIAL || '';      // single-device setups need none
export const RELAY_PORT = process.env.RELAY_PORT || '50672';
export const METRO_PORT = process.env.METRO_PORT || '8081';

function adb(args, opts = {}) {
  const full = DEVICE ? ['-s', DEVICE, ...args] : args;
  return execFileSync(ADB, full, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 20000,
    ...opts.execOpts,
    ...(opts.encoding ? { encoding: opts.encoding } : {}),
  });
}
export { adb };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- input ----

export async function tap(x, y) {
  adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  await sleep(450); // default transition ~350ms
}

export async function doubleTap(x, y) {
  adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  await sleep(120);
  adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  await sleep(450);
}

export async function swipe(x1, y1, x2, y2, ms = 300) {
  adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);
  await sleep(400);
}

export async function back() {
  adb(['shell', 'input', 'keyevent', '4']);
  await sleep(400);
}

export async function hideKeyboard() {
  adb(['shell', 'input', 'keyevent', '111']); // KEYCODE_ESCAPE dismisses IME
  await sleep(300);
}

/** Type text into the focused field. `input text` cannot take newlines and
 *  the adb remote shell would eat `#`/quotes — send ONE pre-quoted command
 *  line so characters survive to the IME intact. */
export async function typeText(text) {
  for (const chunk of text.split('\n')) {
    if (chunk.length) {
      const quoted = "'" + chunk.replace(/'/g, `'\\''`).replace(/\\/g, '\\\\') + "'";
      adb(['shell', `input text ${quoted}`]);
    }
    if (text.includes('\n')) {
      adb(['shell', 'input', 'keyevent', '66']); // ENTER between lines
      await sleep(120);
    }
  }
  await sleep(250);
}

/** Clear the focused TextInput (MOVE_END + DELs) — RN inputs ignore CTRL+A. */
export async function clearFocusedField(maxChars = 260) {
  adb(['shell', 'input', 'keyevent', '123']); // MOVE_END
  await sleep(150);
  for (let i = 0; i < maxChars; i++) {
    const out = adb(['shell', 'input', 'keyevent', '67']); // DEL
    void out;
  }
  await sleep(200);
}

export async function keyEvent(code) {
  adb(['shell', 'input', 'keyevent', String(code)]);
  await sleep(300);
}

// ----------------------------------------------------------------- dump ----

let lastDump = '';

/** uiautomator dump of the current window. Retries — the dumper refuses to
 *  run while the UI is mid-animation ("could not get idle state"). */
export async function dumpUi({ retries = 7 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      adb(['shell', 'rm', '-f', '/sdcard/uidump.xml']);
      adb(['shell', 'uiautomator', 'dump', '/sdcard/uidump.xml'], { timeout: 15000 });
      const xml = adb(['shell', 'cat', '/sdcard/uidump.xml'], { timeout: 15000 });
      if (xml.includes('<hierarchy')) { lastDump = xml; return xml; }
      throw new Error(xml.slice(0, 200));
    } catch (e) {
      if (attempt >= retries) throw new Error(`uiautomator dump failed: ${e.message}`);
      await sleep(900 + attempt * 700);
    }
  }
}

export function parseNodes(xml = lastDump) {
  const nodes = [];
  const re = /<node[^>]*?\/?>(?:.*?<\/node>)?/g; // uiautomator xml is one flat-ish tree; regex-scan attrs
  const attrRe = /(\w[\w-]*)="([^"]*)"/g;
  for (const tag of xml.matchAll(/<node\b[^>]*(?:\/>|>)/g)) {
    const attrs = {};
    for (const m of tag[0].matchAll(attrRe)) attrs[m[1]] = m[2];
    if (attrs.text) attrs.text = decodeXml(attrs.text);
    if (attrs['content-desc']) attrs['content-desc'] = decodeXml(attrs['content-desc']);
    nodes.push(attrs);
  }
  return nodes;
}

function center(bounds) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds || '');
  if (!m) return null;
  return { x: (Number(m[1]) + Number(m[3])) / 2, y: (Number(m[2]) + Number(m[4])) / 2 };
}

/** XML entity decode — uiautomator escapes &, <, >, quotes in labels, so
 *  "Skills & loops" arrives as "Skills &amp; loops". */
function decodeXml(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function visibleNodes() {
  return parseNodes().filter((n) => {
    if (!n.bounds || n.enabled === 'false') return false;
    const c = center(n.bounds);
    if (!c) return false;
    const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds);
    // Skip zero-area nodes — tapping them degenerates to (0,0), which pulls
    // down the notification shade.
    return m && (Number(m[3]) - Number(m[1])) > 2 && (Number(m[4]) - Number(m[2])) > 2;
  });
}

/** All nodes whose visible text OR content-desc matches (substring, case-insensitive). */
export function findByText(text, { exact = false } = {}) {
  const needle = text.toLowerCase();
  return visibleNodes().filter((n) => {
    const hay = `${n.text || ''}\n${n['content-desc'] || ''}`.toLowerCase();
    return exact ? hay.split('\n').some((s) => s === needle) : hay.includes(needle);
  });
}

export async function tapText(text, opts = {}) {
  const nodes = findByText(text, opts);
  if (!nodes.length) throw new Error(`tapText: "${text}" not on screen`);
  return tapCenterOf(nodes[0]);
}

export async function tapCenterOf(node) {
  if (!node) throw new Error('tapCenterOf: null node');
  const { x, y } = center(node.bounds);
  return tap(x, y);
}

export async function hasText(text, opts = {}) {
  dumpUi();
  return findByText(text, opts).length > 0;
}

/** Poll until `predicate` (given a fresh dump) is true. */
export async function waitFor(pred, { timeout = 10000, interval = 600, desc = 'condition' } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      dumpUi();
      if (pred()) return true;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`waitFor timeout (${desc})${lastErr ? ` — last: ${lastErr.message}` : ''}`);
}

export const waitForText = (text, opts = {}) =>
  waitFor(() => findByText(text, opts).length > 0, { desc: `text "${text}"`, ...opts });

export const waitForGone = (text, opts = {}) =>
  waitFor(() => findByText(text, opts).length === 0, { desc: `text "${text}" to disappear`, ...opts });

// ----------------------------------------------------------- app control ----

export function currentActivity() {
  return adb(['shell', 'dumpsys', 'activity', 'activities'])
    .split('\n').find((l) => l.includes('topResumedActivity'))
    ?.trim() || 'unknown';
}

/** The desktop pairing token, read once from e2e/.pairing-token. */
let tokenCache = null;
export function readToken() {
  if (!tokenCache) {
    tokenCache = fs.readFileSync(path.join(HERE, '.pairing-token'), 'utf8').trim();
    if (tokenCache.length !== 43) throw new Error('.pairing-token is not 43 chars — re-run setup');
  }
  return tokenCache;
}

/** The single visible EditText (url field, composer, search…), if any. */
export function findEditText() {
  return visibleNodes().filter((n) => (n.class || '').includes('EditText'));
}

/** Raw XML of the last successful dump. */
export function lastDumpRaw() { return lastDump; }

/** BRING the Relay experience to the foreground WITHOUT killing anything.
 *  Two states to recover from: Expo Go not foreground at all (monkey), and
 *  Expo Go foreground but on ITS OWN launcher (HomeActivity) instead of the
 *  experience (ExperienceActivity) — re-enter via the exp:// deep link. */
export async function ensureAppForeground() {
  const act = () => currentActivity();
  if (!act().includes('host.exp.exponent')) {
    adb(['shell', 'monkey', '-p', 'host.exp.exponent', '-c', 'android.intent.category.LAUNCHER', '1']);
    await sleep(2500);
  }
  if (act().includes('HomeActivity')) {
    try {
      adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
           '-d', `exp://127.0.0.1:${METRO_PORT}`]);
    } catch { /* some devices need the monkey fallback only */ }
    await sleep(4000);
  }
}

/** Cold-start the experience (force-stop + deep link). Use sparingly — this
 *  visibly closes the app on the phone. */
export async function launchApp() {
  adb(['shell', 'am', 'force-stop', 'host.exp.exponent']);
  await sleep(800);
  // exp://127.0.0.1:8081 rides the adb reverse tunnel so no LAN is needed.
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
       '-d', `exp://127.0.0.1:${METRO_PORT}`]);
  await sleep(1500);
  if (!currentActivity().includes('host.exp.exponent')) {
    adb(['shell', 'monkey', '-p', 'host.exp.exponent', '-c', 'android.intent.category.LAUNCHER', '1']);
  }
}

/** Full JS-state reset: cold-start, then wait for the Home scene to paint.
 *  Clears in-memory loops (the BUG-8 update-depth state / BUG-5 request
 *  storm persist until the JS context is recreated). */
export async function restartApp() {
  await launchApp();
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try {
      await dumpUi();
      for (const g of ['Good morning', 'Good afternoon', 'Good evening', 'Good night'])
        if (findByText(g).length) return true;
      if (findByText('Write a message').length) return true;
      if (findByText('take your agent anywhere').length) return true;
    } catch { /* mid-reload */ }
    await sleep(2000);
  }
  return false;
}

export async function screenshot(name) {
  const file = path.join(ARTIFACTS, name.endsWith('.png') ? name : `${name}.png`);
  const out = adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
  fs.writeFileSync(file, out);
  return file;
}
export function logcat({ since = 0, filter = '' } = {}) {
  const args = ['logcat', '-d', '-t', String(since)];
  if (filter) args.push(filter);
  return adb(args);
}

export function clearLogcat() {
  adb(['logcat', '-c']);
}

// --------------------------------------------------------------- assert ----

export class Assert {
  constructor(name) { this.name = name; }
  static that(cond, msg) {
    if (!cond) throw new Error(msg);
  }
}

/** Deep-link into the app with a relay:// pairing/connect URL. In Expo Go the
 *  custom scheme is addressable as `exp+relay://…`; try both spellings.
 *  Returns false when nothing on the device handles the scheme. */
export function fireDeepLink(url) {
  try {
    const out = adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
    return !/Error|Exception|ActivityNotFound/i.test(out);
  } catch (e) {
    return false;
  }
}

/** Kill the desktop relay process. The WS drops immediately — this is what a
 *  phone sees on a desktop restart (cutting `adb reverse` alone does NOT
 *  close established sockets). Sets `desktopWasKilled` so a cancelled run can
 *  be repaired by restoreDesktopIfDown(). */
let desktopWasKilled = false;
export function desktopDownByTests() { return desktopWasKilled; }

export async function killDesktop() {
  const { execFileSync } = await import('node:child_process');
  execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-Process relay -ErrorAction SilentlyContinue | Stop-Process -Force'],
    { timeout: 60000, encoding: 'utf8' });
  desktopWasKilled = true;
  return true;
}

/** Synchronous, best-effort repair: if a test killed the desktop and never
 *  restarted it (cancelled run), bring it back. Safe to call from process
 *  'exit' handlers. */
export function restoreDesktopIfDown() {
  if (!desktopWasKilled) return false;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `if (-not (Get-Process relay -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'D:\\projects\\Ultimate-workspace\\src-tauri\\target\\debug\\relay.exe' -WorkingDirectory 'D:\\projects\\Ultimate-workspace\\src-tauri\\target\\debug' }`],
      { timeout: 30000, encoding: 'utf8' });
    desktopWasKilled = false;
    return true;
  } catch { return false; }
}

/** Start the desktop relay and wait (up to 90s) for its loopback port. */
export async function startDesktop() {
  const { execFileSync } = await import('node:child_process');
  desktopWasKilled = false;
  const ps = (c) => execFileSync('powershell', ['-NoProfile', '-Command', c], { timeout: 60000, encoding: 'utf8' });
  ps(`Start-Process -FilePath 'D:\\projects\\Ultimate-workspace\\src-tauri\\target\\debug\\relay.exe' -WorkingDirectory 'D:\\projects\\Ultimate-workspace\\src-tauri\\target\\debug'`);
  const start = Date.now();
  while (Date.now() - start < 90000) {
    try {
      const out = ps(`if (Get-NetTCPConnection -State Listen -LocalPort ${RELAY_PORT} -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`);
      if (out.includes('YES')) return true;
    } catch { /* retry */ }
    await sleep(2000);
  }
  return false;
}

/** Full restart: kill + start, with the desktop held down briefly. */
export async function restartDesktop(holdMs = 3000) {
  await killDesktop();
  await sleep(holdMs);
  return startDesktop();
}

/** Is relay.exe currently running? (Sync, cheap.) */
export function desktopRunning() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "if (Get-Process relay -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }"],
      { timeout: 20000, encoding: 'utf8' });
    return out.includes('YES');
  } catch { return false; }
}
