// One-off CPU profiler for a single screen's warm open.
// node scripts/profile-screens.mjs <screen> [url] [runs]
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const SCREEN = process.argv[2] || "settings";
const URL = process.argv[3] || "http://localhost:4173";
const RUNS = Number(process.argv[4] || "5");

const SCREENS = {
  settings: { button: '[aria-label="Settings"]', root: ".settings-modal", close: '[aria-label="Settings"]' },
  skills: { button: '[aria-label="Skills Library"]', root: ".view-overlay", close: '[aria-label="Back"]' },
  cost: { button: '[aria-label="Cost"]', root: ".view-overlay", close: '[aria-label="Cost"]' },
  automations: { button: '[aria-label="Open automations"]', root: ".automations-view", close: '[aria-label="Back"]' },
  vault: { button: '[aria-label="Open vault"]', root: ".vault-view", close: '[aria-label="Open vault"]' },
  wiki: { button: '[aria-label="Open project wiki"]', root: ".wiki-view", close: '[aria-label="Open project wiki"]' },
  bots: { button: '[aria-label="Open bots"]', root: ".bots-view", close: '[aria-label="Open bots"]' },
  logs: { button: '[aria-label="Model request log"]', root: ".logs-view", close: '[aria-label="Model request log"]' },
};
const s = SCREENS[SCREEN];
if (!s) throw new Error("unknown screen " + SCREEN);

function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error("no browser");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".bottom-bar", { timeout: 30000 }).catch(() => {});
await sleep(2200);

const click = (sel) => page.evaluate((x) => { const e = document.querySelector(x); if (e) e.click(); return !!e; }, sel);

const COLD = process.argv[5] === "cold";
// Warm up (load lazy chunk) unless we're profiling the first-ever open.
if (!COLD) { await click(s.button); await sleep(600); await click(s.close); await sleep(400); }

const client = await page.target().createCDPSession();
await client.send("Profiler.enable");
await client.send("Profiler.setSamplingInterval", { interval: 100 });

const agg = new Map();
const R = COLD ? 1 : RUNS;
for (let i = 0; i < R; i++) {
  await client.send("Profiler.start");
  const t = await page.evaluate(
    ({ button, root }) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        document.querySelector(button).click();
        const check = () => {
          if (document.querySelector(root)) return resolve(performance.now() - t0);
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
    s,
  );
  const { profile } = await client.send("Profiler.stop");
  const dt = 200; // us per sample
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const n of profile.nodes) {
    const hits = n.hitCount || 0;
    if (!hits) continue;
    const cf = n.callFrame;
    const fn = cf.functionName || "(anonymous)";
    const url = (cf.url || "").replace("http://localhost:4173/assets/", "");
    const key = `${fn} @ ${url}:${(cf.lineNumber ?? 0) + 1}`;
    agg.set(key, (agg.get(key) || 0) + hits * dt);
  }
  await sleep(150);
  await click(s.close);
  await sleep(250);
}

await browser.close();
const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`\nTop self-time for [${SCREEN}] across ${RUNS} warm opens (microseconds):`);
for (const [k, v] of rows) console.log(`  ${(v / 1000).toFixed(1).padStart(8)} ms   ${k}`);
