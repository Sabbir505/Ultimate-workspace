// Waits for the phone to reappear on USB, restores bridges, ensures the
// desktop relay is up, then runs the remaining verification tests.
// Runs until the device shows up (up to 4h) — safe to leave in the background.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADB = path.join(os.homedir(), 'relay-e2e-tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const LOG = path.join(HERE, 'resume-run.log');
const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; fs.appendFileSync(LOG, line + '\n'); console.log(line); };

const adbOut = (args) => {
  try { return execFileSync(ADB, args, { encoding: 'utf8', timeout: 20000 }); }
  catch (e) { return ''; }
};
const deviceOnline = () => /\bdevice\b/.test(adbOut(['devices']).split('\n').filter(l => l.includes('\t')).map(l => l.split('\t')[1] || '').join('\n'));

fs.writeFileSync(LOG, `=== resume watcher started ${new Date().toISOString()} ===\n`);
adbOut(['start-server']);

const deadline = Date.now() + 4 * 60 * 60 * 1000;
while (Date.now() < deadline) {
  if (deviceOnline()) { log('device online'); break; }
  await new Promise(r => setTimeout(r, 10000));
}
if (!deviceOnline()) { log('device never came back — exiting'); process.exit(1); }

await new Promise(r => setTimeout(r, 3000));
log('adb: ' + adbOut(['reverse', 'tcp:8081', 'tcp:8081']).trim());
log('adb: ' + adbOut(['reverse', 'tcp:50672', 'tcp:50672']).trim());
for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'])
  adbOut(['shell', 'settings', 'put', 'global', k, '0']);

// Desktop relay must be up before testing.
try {
  const h = await import('./harness.mjs');
  if (!h.desktopRunning()) { log('desktop relay down — starting it'); await h.startDesktop(); }
  else log('desktop relay already running');
} catch (e) { log('desktop check failed: ' + e.message); }

for (const t of ['02-home', '10-new-chat', '35-regression', '30-relay', '04-drawer']) {
  log(`--- running ${t} ---`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'run-e2e.mjs'), '--only', t], { cwd: HERE, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  log((r.stdout || '') + (r.stderr || ''));
}
log('=== DONE ===');
