// One-off repair: my earlier E2E runs accidentally ran against the user's
// REAL profile (the debug exe predated the RELAY_APP_DATA_DIR override), so
// test sessions/automations landed in the live DB and vault.root was
// overwritten. This launches the app on the real profile (CDP on, WebView2
// profile isolated) and uses the app's own deletion cascade to undo it.
import * as h from './harness.mjs';

// Sessions created by the E2E runs (title prefixes are the test prompts).
const E2E_TITLE_PREFIXES = [
  'Reply with the single word PINGPONG',
  'Reply with the single word TITLETEST',
  'Reply with the single word REOPENTEST',
  'Reply with the single word RENAMETEST',
  'Reply with the single word FORKTEST',
  'Reply with the single word TOMBSTONE',
  'Count from 1 to 200 slowly',
  'Count from 1 to 300 slowly',
  'draft line one',
];
const E2E_AUTO_NAMES = ['E2E Custom Cron', 'E2E Nightly Ping', 'E2E H14 Probe'];
// vault.root before any E2E run (it pointed at a folder that no longer
// exists — that predates the suite; we restore it verbatim).
const VAULT_ROOT_RESTORE = '\\\\?\\D:\\Vaultm';

try {
  await h.ensureFrontend();
  await h.launchApp({ realProfile: true }); // real profile ON PURPOSE
  await h.connect();

  // 1. Delete E2E sessions via the app's own cascade.
  const sessions = await h.invoke('list_chat_sessions');
  const victims = sessions.filter((s) =>
    E2E_TITLE_PREFIXES.some((p) => (s.title || '').startsWith(p)));
  console.log(`sessions to delete: ${victims.length} of ${sessions.length}`);
  for (const s of victims) {
    console.log(`  deleting ${s.id.slice(0, 8)} ${(s.title || '').slice(0, 50)}`);
    await h.invoke('delete_chat_session', { chatSessionId: s.id });
  }

  // 2. Delete E2E automations (slow: each delete syncs the Windows
  // scheduled task when "Run while closed" is on — allow up to 90s each).
  const autos = await h.invoke('list_automations');
  const autoVictims = autos.filter((a) => E2E_AUTO_NAMES.includes(a.name));
  console.log(`automations to delete: ${autoVictims.length} of ${autos.length}`);
  for (const a of autoVictims) {
    await h.invoke('delete_automation', { automationId: a.id }, { timeoutMs: 90000 });
  }

  // 3. Restore the pre-run vault.root.
  await h.invoke('set_setting', { key: 'vault.root', value: VAULT_ROOT_RESTORE });
  const check = await h.invoke('get_setting', { key: 'vault.root' });
  console.log('vault.root restored to:', check);

  // 4. Make sure the theme is left on dark (the appearance test toggles it).
  const theme = await h.invoke('get_setting', { key: 'theme' });
  console.log('theme setting:', theme);

  console.log('REPAIR DONE');
} catch (e) {
  console.error('REPAIR FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await h.shutdown();
}
