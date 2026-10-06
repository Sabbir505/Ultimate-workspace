// Smoke probe: launch the sandboxed exe, connect over CDP, dump the shell.
import * as h from './harness.mjs';
import * as app from './app.mjs';

try {
  console.log('frontend…', await h.ensureFrontend());
  const port = await h.launchApp();
  console.log('cdp port', port);
  await h.connect();
  console.log('connected; shell =', await h.evaluate(() => !!document.querySelector('.app')));
  await h.dumpUi();
  console.log('visible nodes:', h.dumpRaw().length);
  for (const label of ['New Chat', 'Settings', 'Cost', 'Chat History']) {
    console.log(`  ${label}:`, h.findIncludingDisabled(label).length);
  }
  console.log('chat visible:', await app.chatVisible());
  console.log('theme:', await app.documentTheme());
  await h.screenshot('smoke');
  console.log('SMOKE OK');
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await h.shutdown();
}
