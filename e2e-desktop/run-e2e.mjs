// Relay desktop E2E runner — drives the real Tauri app (WebView2) over CDP
// with puppeteer-core. Zero test framework — the desktop counterpart of the
// mobile suite's run-e2e.mjs.
//
//   node run-e2e.mjs [--only name] [--list] [--keep-sandbox]
//
// Produces:
//   e2e-desktop/artifacts/<NNN>-<label>.png   screenshots along the way
//   e2e-desktop/results.json                  structured results
//   console summary

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
const ALL = [...CORE_TESTS, ...CHAT_TESTS, ...SCREEN_TESTS, ...RESILIENCE_TESTS, ...DEPTH_TESTS, ...BUG_TESTS];

if (argv.includes('--list')) {
  for (const t of ALL) console.log(`${t.name}${t.bug ? `  [${t.bug.split('—')[0].trim()}]` : ''}`);
  process.exit(0);
}

const results = [];

async function preflight() {
  // A failed test can leave an overlay/view open; the next test must start
  // from a known place. Best-effort: never mask the test's own failure.
  try { await app.goHome(); } catch { /* preflight is best-effort */ }
}

async function runTest(t) {
  const started = Date.now();
  const entry = { name: t.name, status: 'pass', ms: 0, error: null, info: t.info || null };
  if (t.bug) entry.bug = t.bug;
  process.stdout.write(`\n▶ ${t.name}\n`);
  try {
    await preflight();
    const info = await t.run({ h, app, shot: h.screenshot });
    if (info) entry.info = typeof info === 'string' ? info : JSON.stringify(info);
    if (t.info && t.info !== entry.info) entry.info = t.info;
  } catch (e) {
    if (e && e.skip) {
      entry.status = 'skip';
      entry.error = String(e.message || e);
    } else {
      entry.status = 'fail';
      entry.error = String(e.message || e).slice(0, 2000);
      // Console/page errors observed up to this point often name the culprit
      // (a failed lazy import, an unhandled rejection) — record them.
      const errs = h.takeConsoleErrors();
      if (errs.length) {
        entry.consoleErrors = errs.map((e) => `${e.kind}: ${e.text.slice(0, 300)}`);
      }
      const f = await h.screenshot(`FAIL-${t.name}`);
      if (f) entry.errorShot = path.basename(f);
      process.stdout.write(`  ✗ ${entry.error.split('\n')[0]}\n`);
    }
  } finally {
    // Console/page errors observed during THIS test only.
    const errs = h.takeConsoleErrors();
    const serious = errs.filter((e) => e.kind === 'pageerror');
    if (serious.length && entry.status === 'pass') {
      entry.consoleErrors = serious.map((e) => e.text.slice(0, 300));
    }
    entry.ms = Date.now() - started;
    results.push(entry);
    const mark = entry.status === 'pass' ? '✓' : entry.status === 'skip' ? '⊘' : '✗';
    process.stdout.write(`  ${mark} ${t.name} (${(entry.ms / 1000).toFixed(1)}s)\n`);
  }
}

// ------------------------------------------------------------------ boot ----

console.log(`Relay desktop E2E — exe: ${h.RELAY_EXE}, frontend: ${h.FRONTEND_URL}`);
process.on('exit', () => { /* shutdown is async; best effort below */ });
process.on('SIGINT', async () => { await h.shutdown(); process.exit(130); });

try {
  await h.ensureFrontend();
  await h.launchApp();
  await h.connect();
  // ISOLATION GUARD — the last line of defense. Whatever the exe claims,
  // verify the app's resolved DB actually lives inside the sandbox before a
  // single test writes anything. (A stale exe without the RELAY_APP_DATA_DIR
  // override once ran this suite against the user's REAL profile.)
  const dbPath = await h.invoke('get_chat_db_path');
  const sandboxData = h.sandboxPath('data');
  if (!String(dbPath).toLowerCase().startsWith(sandboxData.toLowerCase())) {
    throw new Error(
      `ISOLATION BROKEN: app DB resolved to "${dbPath}" but the sandbox is "${sandboxData}". ` +
      'Aborting before any writes. Rebuild the exe with the override: ' +
      'cd src-tauri && CARGO_TARGET_DIR=target-e2e cargo build --bin relay',
    );
  }
  // Vault isolation: the cloned profile carries the user's real vault.root —
  // rebind to a scratch folder inside the sandbox BEFORE any test runs, so
  // note writes can never land in real user data. Setup-only IPC; the vault
  // tests themselves assert through the UI.
  await h.invoke('vault_bind', { path: h.sandboxPath('vault') });
  // Sandbox hygiene: automation create/delete syncs a Windows scheduled task
  // when "Run while closed" is on — each write then takes 30-90s of
  // schtasks time and wedges the UI mid-test. Turn it off for the run.
  await h.invoke('set_run_while_closed', { enabled: false });
  console.log('isolation verified (db inside sandbox); vault bound, run-while-closed off');
} catch (e) {
  console.error('boot failed:', (e && (e.stack || e.message)) || String(e));
  await h.shutdown();
  process.exit(2);
}
h.resetShotIdx();

const t0 = Date.now();
try {
  for (const t of ALL.filter((t) => !onlyArg || t.name.toLowerCase().includes(onlyArg.toLowerCase()))) {
    await runTest(t);
  }
} finally {
  await h.shutdown();
}

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skip = results.filter((r) => r.status === 'skip').length;
const total = ((Date.now() - t0) / 1000).toFixed(0);
const withConsole = results.filter((r) => r.consoleErrors?.length);

console.log(`\n${'='.repeat(64)}`);
for (const r of results) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '⊘' : '✗';
  console.log(`${mark} ${r.name}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
}
console.log('='.repeat(64));
console.log(`${pass} passed, ${fail} failed, ${skip} skipped (${total}s)`);
if (withConsole.length) {
  console.log(`\n⚠ page errors captured during passing tests (${withConsole.length} tests):`);
  for (const r of withConsole) {
    console.log(`  ${r.name}:`);
    for (const e of r.consoleErrors.slice(0, 3)) console.log(`    - ${e.split('\n')[0]}`);
  }
}

fs.writeFileSync(
  path.join(HERE, 'results.json'),
  JSON.stringify({ results, finishedAt: new Date().toISOString() }, null, 2),
);
process.exit(fail ? 1 : 0);
