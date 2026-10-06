// Relay mobile E2E runner — drives the app in Expo Go on a USB-connected
// phone through adb. Zero external deps.
//
//   node run-e2e.mjs [--only name1,name2] [--list] [--fast]
//
// Produces:
//   e2e/artifacts/<NNN>-<test>.png        screenshots along the way
//   e2e/results.json                      structured results
//   console summary table

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from './harness.mjs';
import * as app from './app.mjs';
import { CORE_TESTS } from './tests/core.mjs';
import { CHAT_TESTS } from './tests/chat.mjs';
import { SCREEN_TESTS } from './tests/screens.mjs';
import { DEPTH_TESTS } from './tests/depth.mjs';
import { RESILIENCE_TESTS } from './tests/resilience.mjs';
import { BUG_TESTS } from './tests/bugs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();
if (argv.includes('--list')) {
  for (const t of [...CORE_TESTS, ...CHAT_TESTS, ...SCREEN_TESTS, ...DEPTH_TESTS, ...RESILIENCE_TESTS, ...BUG_TESTS])
    console.log(t.name);
  process.exit(0);
}

const ALL = [...CORE_TESTS, ...CHAT_TESTS, ...SCREEN_TESTS, ...DEPTH_TESTS, ...RESILIENCE_TESTS, ...BUG_TESTS]
  .filter((t) => !onlyArg || t.name.toLowerCase().includes(onlyArg.toLowerCase()));

const results = [];
let shotIdx = 0;

async function shot(label) {
  const name = `${String(++shotIdx).padStart(3, '0')}-${label.replace(/[^\w-]+/g, '-')}.png`;
  try { return await h.screenshot(name); } catch { return null; }
}

async function preflight(h, app) {
  try {
    await h.ensureAppForeground();
    await app.dismissDevMenuIfOpen();
    // If the desktop is up, give the phone a moment to (re)connect — sends
    // made while offline just error out and muddy the test that follows.
    if (h.desktopRunning()) {
      await h.dumpUi();
      for (let i = 0; i < 10 && app.statusPill() !== 'connected'; i++) {
        await h.sleep(3000);
        await h.dumpUi();
      }
    }
  } catch { /* preflight is best-effort */ }
}

async function runTest(t) {
  const started = Date.now();
  const entry = { name: t.name, status: 'pass', ms: 0, error: null, info: t.info || null };
  if (t.bug) entry.bug = t.bug;
  process.stdout.write(`\n▶ ${t.name}\n`);
  try {
    await preflight(h, app);
    const info = await t.run({ h, app, shot });
    if (info) entry.info = typeof info === 'string' ? info : JSON.stringify(info);
  } catch (e) {
    if (e && e.skip) {
      entry.status = 'skip';
      entry.error = String(e.message || e);
    } else {
      entry.status = 'fail';
      entry.error = String(e.message || e).slice(0, 2000);
      const f = await shot(`FAIL-${t.name}`);
      if (f) entry.errorShot = path.basename(f);
      process.stdout.write(`  ✗ ${entry.error.split('\n')[0]}\n`);
    }
  } finally {
    entry.ms = Date.now() - started;
    results.push(entry);
    const mark = entry.status === 'pass' ? '✓' : entry.status === 'skip' ? '⊘' : '✗';
    process.stdout.write(`  ${mark} ${t.name} (${(entry.ms / 1000).toFixed(1)}s)\n`);
  }
}

// ------------------------------------------------------------------ boot ----

console.log(`Relay mobile E2E — device: ${h.DEVICE || '(default)'}, relay: 127.0.0.1:${h.RELAY_PORT}`);
h.adb(['shell', 'svc', 'power', 'stayon', 'usb']);          // keep screen awake
h.adb(['shell', 'input', 'keyevent', '224']);               // wake
h.adb(['shell', 'settings', 'put', 'system', 'screen_off_timeout', '600000']);
h.adb(['shell', 'cmd', 'statusbar', 'collapse']);           // clear any shade
await h.ensureAppForeground();                              // gentle bring-up, no force-stop
h.clearLogcat();

// Safety net: a cancelled/failed run must never leave the desktop closed
// (tests 30/37/38 kill relay.exe on purpose; an interrupted hold used to
// strand it down).
const repair = () => { try { h.restoreDesktopIfDown(); } catch { /* best effort */ } };
process.on('exit', repair);
process.on('SIGINT', () => { repair(); process.exit(130); });
process.on('SIGTERM', () => { repair(); process.exit(143); });

// Every run starts from a healthy desktop: if relay.exe is not running
// (a previous interrupted run may have killed it), start it now.
try {
  h.adb(['shell', 'echo', 'ping']); // adb sanity
  if (!h.desktopRunning()) {
    console.log('desktop relay not running — starting it before the suite…');
    await h.startDesktop();
  }
} catch (e) { console.log('desktop startup check failed:', e.message); }

const t0 = Date.now();
for (const t of ALL) await runTest(t);

// ------------------------------------------------------------ crash scan ----
let crashScan = '';
try {
  const lc = h.adb(['logcat', '-d']);
  const fatals = lc.split('\n').filter((l) =>
    /FATAL EXCEPTION|AndroidRuntime.*Process: host.exp.exponent|ReactNativeJS.*Error/.test(l));
  crashScan = fatals.slice(0, 20).join('\n');
} catch { /* logcat best-effort */ }

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skip = results.filter((r) => r.status === 'skip').length;
const total = ((Date.now() - t0) / 1000).toFixed(0);

console.log(`\n${'='.repeat(64)}`);
for (const r of results) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '⊘' : '✗';
  console.log(`${mark} ${r.name}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
}
console.log('='.repeat(64));
console.log(`${pass} passed, ${fail} failed, ${skip} skipped (${total}s)${crashScan ? '\n⚠ CRASHES FOUND:\n' + crashScan : '\nno fatal crashes in logcat'}`);

fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify({ results, crashScan, finishedAt: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);
