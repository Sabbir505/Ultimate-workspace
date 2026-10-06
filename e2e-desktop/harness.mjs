// Zero-framework CDP driver for E2E testing the **Relay desktop app**
// (Tauri v2 + WebView2) on Windows. The desktop counterpart of `e2e/`
// (the mobile adb harness): same philosophy — black-box, plain Node,
// numbered screenshots, structured results.
//
// How it talks to the app:
//   1. Launches the real `relay.exe` (debug build) with
//      `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`
//      and `RELAY_APP_DATA_DIR=<sandbox>` so the instance under test runs in
//      a throwaway profile — the user's real app data is never touched and
//      the two instances coexist (the mobile relay falls back to an
//      ephemeral port on bind failure).
//   2. Connects puppeteer-core over CDP to that WebView2 and drives the real
//      DOM (real mouse clicks + keyboard events, not JS .click()).
//
// The frontend comes from the Vite dev server (debug builds load
// `devUrl` = http://localhost:1500). If one is already running it is reused;
// otherwise this starts one.

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const ARTIFACTS = path.join(HERE, 'artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = process.env.RELAY_REPO_ROOT || ROOT;
// Prefer a build in target-e2e (the harness's own target dir — target/debug
// is frequently locked by a running `tauri dev` instance, which also makes
// its exe stale: a binary WITHOUT the RELAY_APP_DATA_DIR override would
// silently run the suite against the user's REAL profile).
function pickExe() {
  if (process.env.RELAY_EXE) return process.env.RELAY_EXE;
  const own = path.join(REPO, 'src-tauri', 'target-e2e', 'debug', 'relay.exe');
  if (fs.existsSync(own)) return own;
  return path.join(REPO, 'src-tauri', 'target', 'debug', 'relay.exe');
}
export const RELAY_EXE = pickExe();
/** Does the exe actually contain the sandbox override? A stale binary built
 *  before user_dirs.rs gained RELAY_APP_DATA_DIR would silently run against
 *  the user's real profile — check the literal, refuse to launch otherwise. */
export function exeHasSandboxOverride() {
  try {
    const fd = fs.openSync(RELAY_EXE, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(4096);
    let found = false;
    const needle = Buffer.from('RELAY_APP_DATA_DIR');
    for (let off = 0; off < size && !found; off += buf.length - needle.length) {
      const n = fs.readSync(fd, buf, 0, buf.length, off);
      if (n <= 0) break;
      if (buf.subarray(0, n).includes(needle)) found = true;
    }
    fs.closeSync(fd);
    return found;
  } catch {
    return false;
  }
}
export const FRONTEND_URL = process.env.RELAY_DEV_URL || 'http://localhost:1500';
const REAL_DATA_DIR =
  process.env.RELAY_REAL_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dev.relay.app');

export const KEEP_SANDBOX = process.env.RELAY_E2E_KEEP_SANDBOX === '1';

// ------------------------------------------------------------------ state ----

let page = null;            // main-window page (set by connect())
let browser = null;         // puppeteer browser handle
let appProc = null;         // relay.exe child process
let sandboxDir = null;
let cdpPort = 0;
let consoleErrors = [];     // errors collected since last markConsoleMark()
let consoleMark = 0;

export function sandboxPath(...p) {
  return path.join(sandboxDir ?? '', ...p);
}

/** Console errors recorded since the last mark (per-test error scan). */
export function takeConsoleErrors() {
  const errs = consoleErrors.slice(consoleMark);
  consoleMark = consoleErrors.length;
  return errs;
}

function noteConsole(kind, text) {
  consoleErrors.push({ kind, text: String(text || '<no message>').slice(0, 500) });
}

// ------------------------------------------------------------------ ports ----

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function httpOk(url, timeoutMs = 2000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ vite -----

let viteProc = null;

/** Make sure the Vite dev server (the debug build's frontend) is up. */
export async function ensureFrontend() {
  if (await httpOk(FRONTEND_URL)) return 'already-running';
  const vite = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) throw new Error('vite not installed — run `npm install` first');
  viteProc = spawn(process.execPath, [vite], {
    cwd: REPO,
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 60; i++) {
    if (await httpOk(FRONTEND_URL)) return 'started';
    await sleep(500);
  }
  throw new Error(`frontend did not come up on ${FRONTEND_URL}`);
}

// ---------------------------------------------------------------- sandbox ----

/** Throwaway app-data profile, seeded from the real relay.db so settings,
 *  providers, and history exist. Returns the dir; never touches the real one
 *  (the exe is launched with RELAY_APP_DATA_DIR pointing here). */
export function makeSandbox() {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
  const dataDir = path.join(sandboxDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // Scratch vault folder — vault_bind requires an existing directory.
  fs.mkdirSync(path.join(sandboxDir, 'vault'), { recursive: true });
  for (const f of ['relay.db', 'relay.db-wal', 'relay.db-shm']) {
    const src = path.join(REAL_DATA_DIR, f);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(dataDir, f)); } catch { /* WAL race — db alone is enough */ }
    }
  }
  return dataDir;
}

// ----------------------------------------------------------------- launch ----

/** Launch relay.exe (CDP on) and return the CDP port. By default the app is
 *  sandboxed (RELAY_APP_DATA_DIR → throwaway dir); pass { realProfile: true }
 *  for repair/maintenance runs that must operate on the user's real data —
 *  the WebView2 profile stays isolated either way. */
export async function launchApp({ realProfile = false } = {}) {
  if (!fs.existsSync(RELAY_EXE)) {
    throw new Error(`relay.exe not found at ${RELAY_EXE} — run: cd src-tauri && CARGO_TARGET_DIR=target-e2e cargo build --bin relay`);
  }
  if (!realProfile && !exeHasSandboxOverride()) {
    throw new Error(
      `${RELAY_EXE} does not contain the RELAY_APP_DATA_DIR override (stale build) — ` +
      'refusing to launch: the suite would run against the user\'s REAL profile. ' +
      'Rebuild: cd src-tauri && CARGO_TARGET_DIR=target-e2e cargo build --bin relay',
    );
  }
  cdpPort = await freePort();
  const dataDir = makeSandbox();
  const exeDir = path.dirname(RELAY_EXE);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    // Own WebView2 profile: no lock conflict with the user's running app.
    WEBVIEW2_USER_DATA_FOLDER: path.join(sandboxDir, 'webview2'),
  };
  if (!realProfile) {
    env.RELAY_APP_DATA_DIR = dataDir;
  }
  appProc = spawn(RELAY_EXE, [], {
    cwd: exeDir, // sidecar lookup is exe-relative
    stdio: 'ignore',
    env,
  });
  const url = `http://127.0.0.1:${cdpPort}/json/version`;
  for (let i = 0; i < 120; i++) {
    if (appProc.exitCode !== null) {
      throw new Error(`relay.exe exited early (code ${appProc.exitCode}) — sandbox: ${sandboxDir}`);
    }
    if (await httpOk(url)) return cdpPort;
    await sleep(500);
  }
  throw new Error(`CDP did not come up on port ${cdpPort} within 60s — sandbox: ${sandboxDir}`);
}

// ---------------------------------------------------------------- connect ----

/** Connect puppeteer-core over CDP and latch onto the main window page. */
export async function connect() {
  const { default: puppeteer } = await import('puppeteer-core');
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${cdpPort}`,
    defaultViewport: null,
    protocolTimeout: 180000,
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const main = pages.find(
      (p) => p.url().startsWith(FRONTEND_URL) && !p.url().includes('popout='),
    );
    if (main) {
      page = main;
      page.on('pageerror', (e) => noteConsole('pageerror',
        [e && e.name, e && e.message, e && e.stack].filter(Boolean).join(' | ') || String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') noteConsole('console', m.text());
      });
      // Native window.confirm/alert (e.g. automation Delete) — a test harness
      // always confirms; the assertion lives in the UI state that follows.
      page.on('dialog', (d) => { void d.accept().catch(() => {}); });
      // Wait for the shell to paint something.
      for (let i = 0; i < 120; i++) {
        const ready = await page.evaluate(() => !!document.querySelector('.app'));
        if (ready) return page;
        await sleep(500);
      }
      throw new Error('app shell (.app) never rendered');
    }
    await sleep(500);
  }
  throw new Error('main window target never appeared over CDP');
}

// ------------------------------------------------------------------- quit ----

export async function shutdown() {
  try { if (browser) browser.disconnect(); } catch { /* already gone */ }
  if (appProc && appProc.exitCode === null) {
    try { appProc.kill(); } catch { /* best effort */ }
    await sleep(800);
    if (appProc.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(appProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
  }
  if (viteProc) { try { viteProc.kill(); } catch { /* best effort */ } }
  if (sandboxDir && !KEEP_SANDBOX) {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may still hold a handle */ }
  }
}

// -------------------------------------------------------------------- dom ----

// NOTE: everything passed to page.evaluate is serialized WITHOUT its
// closure — the selector string and hit-test logic below are duplicated
// verbatim inside DUMP_FN / LOCATE_FN on purpose.

/** Is `el` the topmost thing at its own center? Elements behind an overlay
 *  (e.g. the toolbar bell behind the Settings modal) read "visible" via
 *  getComputedStyle but a click would land on the overlay — this catches
 *  them. Clipped-inside-scroll-container elements also fail the hit test. */
const topmost = (el) => {
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const stack = document.elementsFromPoint(x, y);
  if (!stack.length) return false;
  return stack[0] === el || el.contains(stack[0]) || stack[0].contains(el);
};

/** Selector used to dump "everything visible with text" — the DOM analogue
 *  of the mobile harness's uiautomator dump. */
const DUMP_FN = () => {
  const SEL = (
    'button, a, input, textarea, [role="button"], [role="tab"], [role="menuitem"], ' +
    '[role="option"], [role="menuitemradio"], [role="checkbox"], [contenteditable="true"], ' +
    'select, h1, h2, h3, h4, label, summary, [aria-label], [title]'
  );
  const topmostAt = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const stack = document.elementsFromPoint(x, y);
    for (const s of stack) {
      // Pointer-transparent layers (decorative art, aria-hidden overlays)
      // let clicks fall through to the element beneath them.
      if (getComputedStyle(s).pointerEvents === 'none') continue;
      return s === el || el.contains(s) || s.contains(el);
    }
    return false;
  };
  const out = [];
  const seen = new Set();
  const els = document.querySelectorAll(SEL);
  for (const el of els) {
    if (seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const ownText = (el.innerText || el.value || el.placeholder || '').trim().slice(0, 200);
    const tag = el.tagName.toLowerCase();
    if (!aria && !ownText && !title) continue;
    out.push({
      tag,
      aria,
      title,
      text: ownText,
      placeholder: el.getAttribute('placeholder') || '',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      cx: el.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      occluded: !topmostAt(el),
    });
  }
  return out;
};

/** In-page locator for atomic clicks: fresh coordinates + scrollIntoView +
 *  occlusion hit-test in the SAME tick the coordinates are read. Returns
 *  {x, y, tag} of the topmost match, or null. */
const LOCATE_FN = (needle, exact) => {
  const SEL = (
    'button, a, input, textarea, [role="button"], [role="tab"], [role="menuitem"], ' +
    '[role="option"], [role="menuitemradio"], [role="checkbox"], [contenteditable="true"], ' +
    'select, h1, h2, h3, h4, label, summary, [aria-label], [title]'
  );
  const n = needle.toLowerCase();
  // Collect matches, then prefer SPECIFICITY: an exact trimmed match beats
  // a container whose innerText merely contains the needle (clicking the
  // .modal box instead of its Cancel button was a real mis-click). Among
  // substring matches, the shortest haystack wins — the innermost element.
  const cands = [];
  for (const el of document.querySelectorAll(SEL)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const text = (el.innerText || el.value || el.placeholder || '').trim().toLowerCase();
    const hay = [text, aria, title].filter(Boolean);
    let score = 2; // 0 = exact, 1 = exact line, 2 = substring
    if (exact) {
      if (!hay.some((s) => s.split('\n').some((line) => line.trim() === n))) continue;
      score = 0;
    } else {
      if (!hay.some((s) => s.includes(n))) continue;
      if (hay.some((s) => s === n)) score = 0;
      else if (hay.some((s) => s.split('\n').some((line) => line.trim() === n))) score = 1;
    }
    const r0 = el.getBoundingClientRect();
    if (r0.width < 3 || r0.height < 3) continue;
    cands.push({ el, score, len: hay.join(' ').length });
  }
  cands.sort((a, b) => a.score - b.score || a.len - b.len);
  let fallback = null;
  for (const { el } of cands) {
    // Bring scrolled-away items into view, then re-measure.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const stack = document.elementsFromPoint(x, y);
    let top = null;
    for (const s of stack) {
      if (getComputedStyle(s).pointerEvents === 'none') continue;
      top = s;
      break;
    }
    const clear = top && (top === el || el.contains(top) || top.contains(el));
    if (clear) {
      return { x: Math.round(x), y: Math.round(y), tag: el.tagName.toLowerCase(), occluded: false };
    }
    // Something transient sits on this candidate (the walking pet sprite,
    // a tooltip). Remember it — a topmost candidate elsewhere wins, but if
    // there is none, clicking here matches what a patient user would do.
    if (!fallback) {
      fallback = { x: Math.round(x), y: Math.round(y), tag: el.tagName.toLowerCase(), occluded: true };
    }
  }
  return fallback;
};

let lastDump = [];

/** Fresh dump of visible interactive/text elements. */
export async function dumpUi() {
  if (!page) throw new Error('dumpUi: not connected');
  try {
    lastDump = await page.evaluate(DUMP_FN);
  } catch (e) {
    // Mid-navigation evaluation can throw; one retry after a beat.
    await sleep(400);
    lastDump = await page.evaluate(DUMP_FN);
  }
  return lastDump;
}

function match(node, text, { exact = false } = {}) {
  const hay = [node.text, node.aria, node.title, node.placeholder]
    .join('\n')
    .toLowerCase();
  const needle = text.toLowerCase();
  return exact ? hay.split('\n').some((s) => s === needle) : hay.includes(needle);
}

/** Visible nodes matching text (substring, case-insensitive). The `occluded`
 *  flag marks elements currently covered by something else (an overlay, or
 *  the walking pet sprite) — kept in the list because existence assertions
 *  should not flake on the pet; click targeting resolves occlusion itself. */
export function findByText(text, opts = {}) {
  return lastDump.filter((n) => match(n, text, opts));
}

export function findIncludingDisabled(text, opts = {}) {
  return lastDump.filter((n) => match(n, text, opts));
}

/** Real-mouse click at a node's center (coordinates from the last dump).
 *  Prefer clickText/clickAria which re-locate atomically. */
export async function clickNode(node) {
  if (!node) throw new Error('clickNode: null node');
  await page.mouse.click(node.x, node.y);
  await sleep(350);
}

/** Atomic text click: locate (fresh coords, scrollIntoView, topmost check)
 *  and click in immediate succession — no stale-dump race. When the only
 *  candidate is covered by something transient (the walking pet sprite), the
 *  click is retried a few times — the pet moves on, a static overlay does
 *  not, and the failure message then says so. */
export async function clickText(text, opts = {}) {
  const attempts = 3;
  let lastPt = null;
  for (let i = 0; i < attempts; i++) {
    const pt = await page.evaluate(LOCATE_FN, text, !!opts.exact);
    if (!pt) {
      await dumpUi();
      const why = findByText(text, opts);
      const hint = why.length
        ? `found ${why.length} candidate(s) but none clickable`
        : 'not on screen';
      throw new Error(`clickText: "${text}" — ${hint}`);
    }
    await page.mouse.click(pt.x, pt.y);
    await sleep(350);
    if (!pt.occluded) return pt;
    lastPt = pt;
    await sleep(400);
  }
  return lastPt;
}

export async function clickAria(label, opts = {}) {
  try {
    return await clickText(label, { ...opts, exact: true });
  } catch (e) {
    // Fall back to substring matching (labels are often decorated, e.g.
    // "Notifications (2 unseen)").
    return clickText(label, opts);
  }
}

/** Is `text` currently visible? (Uses a fresh dump.) */
export async function hasText(text, opts = {}) {
  await dumpUi();
  return findByText(text, opts).length > 0;
}

/** Poll until `pred` is true. `pred` runs against a fresh dump unless it
 *  ignores its argument (raw-page predicates). */
export async function waitFor(pred, { timeout = 10000, interval = 400, desc = 'condition' } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      if (await pred()) return true;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`waitFor timeout (${desc})${lastErr ? ` — last: ${lastErr.message}` : ''}`);
}

export const waitForText = (text, opts = {}) =>
  waitFor(async () => {
    await dumpUi();
    return findByText(text, opts).length > 0;
  }, { desc: `text "${text}"`, ...opts });

export const waitForGone = (text, opts = {}) =>
  waitFor(async () => {
    await dumpUi();
    return findByText(text, opts).length === 0;
  }, { desc: `text "${text}" to disappear`, ...opts });

/** Click a node then wait for `expectText` to appear. */
export async function waitAndTap(text, { expectText, timeout = 8000 } = {}) {
  await clickText(text);
  if (expectText) await waitForText(expectText, { timeout });
}

/** Type into the currently focused editable, with a small settle delay. */
export async function typeText(text, { delay = 8 } = {}) {
  await page.keyboard.type(text, { delay });
  await sleep(200);
}

export async function pressKey(key, opts = {}) {
  // Accept Chromium combos like "Control+k", "Control+/", "Control+=" —
  // puppeteer's press() only takes a single key, so chord it manually.
  const parts = String(key).split('+');
  const base = parts.pop();
  const modifiers = parts.map((m) =>
    m === 'Cmd' || m === 'Meta' ? 'Meta' : m === 'Shift' ? 'Shift' : m === 'Alt' ? 'Alt' : 'Control');
  for (const m of modifiers) await page.keyboard.down(m);
  await page.keyboard.press(base, opts);
  for (const m of modifiers.reverse()) await page.keyboard.up(m);
  await sleep(300);
}

/** Focus an editable node (from the last dump) and type into it. */
export async function typeInto(node, text) {
  if (!node) throw new Error('typeInto: null node');
  await page.mouse.click(node.x, node.y);
  await sleep(200);
  await typeText(text);
}

/** The single visible composer/editor textarea or contenteditable. */
export function findEditable() {
  return lastDump.filter((n) => n.cx && n.tag !== 'select');
}

// -------------------------------------------------------------- screenshots --

let shotIdx = 0;
export function resetShotIdx() { shotIdx = 0; }

export async function screenshot(label) {
  const name = `${String(++shotIdx).padStart(3, '0')}-${String(label).replace(/[^\w-]+/g, '-')}.png`;
  const file = path.join(ARTIFACTS, name);
  try {
    await page.screenshot({ path: file });
    return file;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- raw page I/O --

/** Evaluate an expression in the main window (escape hatch for setup IPC). */
export async function evaluate(fn, ...args) {
  return page.evaluate(fn, ...args);
}

/** Raw puppeteer page handle (use sparingly). */
export function rawPage() {
  return page;
}

/** Invoke a Tauri IPC command from the app's own context — used ONLY for
 *  setup that native dialogs block (vault folder pick) and seed data, never
 *  for assertions. Timeouts loudly: a command that never resolves must fail
 *  the test with its own name, not burn the CDP protocol timeout. */
export async function invoke(cmd, args = {}, { timeoutMs = 15000 } = {}) {
  const op = page.evaluate(
    async (c, a) => window.__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  );
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`invoke("${cmd}") timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ assert ----

export class Assert {
  static that(cond, msg) {
    if (!cond) throw new Error(msg);
  }
}

export function dumpRaw() {
  return lastDump;
}
