import * as h from './harness.mjs';
import * as app from './app.mjs';
process.on('SIGINT', async () => { await h.shutdown(); process.exit(130); });
try {
  await h.ensureFrontend();
  await h.launchApp();
  await h.connect();
  await h.invoke('vault_bind', { path: h.sandboxPath('vault') });
  await h.invoke('set_run_while_closed', { enabled: false });
  await app.newChat();
  const labels = await h.evaluate(() => [...document.querySelectorAll('button, [role="tab"], [aria-label]')]
    .map((b) => b.getAttribute('aria-label') || (b.textContent || '').trim().slice(0, 40))
    .filter((t) => t && /agent|model|deepseek|glm/i.test(t))
    .slice(0, 25));
  console.log(JSON.stringify(labels, null, 1));
  await h.shutdown();
  process.exit(0);
} catch (e) {
  console.error('probe failed:', e.message);
  await h.shutdown();
  process.exit(1);
}
