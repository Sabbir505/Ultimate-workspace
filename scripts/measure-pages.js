// Repeatable page-load measurement across every page (view) of the app.
// Run in the Playwright browser context via browser_evaluate. Measures the
// PRODUCTION build (vite preview on :4173) so results reflect real users.
//
// Usage from Claude: navigate to http://localhost:4173/?m=N then call this.
// Returns one row per page: chat (initial), settings, skills, cost, plus
// the lazy-chunk fetch each view triggers.
async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nav = () => performance.getEntriesByType("navigation")[0];
  const fcp = () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
  const lcpList = () => performance.getEntriesByType("largest-contentful-paint");
  const resources = () => performance.getEntriesByType("resource");

  // For SPA view switches there's no navigation entry, so measure the time
  // from click → next paint via requestAnimationFrame polling.
  const timeUntilMutated = async (mutator, timeoutMs = 4000) => {
    const start = performance.now();
    const body = document.body;
    const before = body.innerHTML.length;
    mutator();
    const deadline = start + timeoutMs;
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      if (document.body.innerHTML.length !== before) {
        return Math.round(performance.now() - start);
      }
    }
    return Math.round(performance.now() - start);
  };

  const measureInitial = () => ({
    page: "chat (initial load)",
    type: "full navigation",
    domContentLoadedMs: Math.round(nav()?.domContentLoadedEventEnd - nav()?.startTime),
    loadMs: Math.round(nav()?.loadEventEnd - nav()?.startTime),
    fcpMs: fcp() ? Math.round(fcp()) : null,
    lcpMs: lcpList().length ? Math.round(lcpList().slice(-1)[0].startTime) : null,
    transferKb: Math.round((nav()?.transferSize || 0) / 1024),
    resourceCount: resources().length,
    resourceKb: Math.round(resources().reduce((s, e) => s + (e.transferSize || 0), 0) / 1024),
  });

  const results = [measureInitial()];

  // Switch to each overlay view via the sidebar footer buttons, measuring
  // the render time + the lazy chunk the view downloads.
  const views = [
    { name: "settings", label: "Settings" },
    { name: "skills", label: "Skills Library" },
    { name: "cost", label: "Cost" },
  ];
  for (const v of views) {
    const beforeCount = resources().length;
    const beforeKb = resources().reduce((s, e) => s + (e.transferSize || 0), 0);
    const ms = await timeUntilMutated(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === v.label || b.getAttribute("title") === v.label
      );
      btn?.click();
    });
    await wait(600); // let lazy chunk + render settle
    const after = resources();
    const newChunks = after.slice(beforeCount).map((e) => ({
      name: e.name.replace("http://localhost:4173", "").split("?")[0],
      kb: Math.round((e.transferSize || 0) / 1024),
    })).filter((c) => c.kb > 0);
    results.push({
      page: v.name + " (view switch)",
      type: "SPA lazy",
      renderMs: ms,
      chunksDownloadedKb: Math.round(after.reduce((s, e) => s + (e.transferSize || 0), 0) - beforeKb) / 1024,
      chunks: newChunks,
    });
    // Return to chat
    await timeUntilMutated(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === v.label || b.getAttribute("title") === v.label
      );
      btn?.click();
    });
    await wait(300);
  }
  return results;
}
