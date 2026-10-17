// Screen open-time harness: measures click -> committed DOM (render cost) and
// click -> next paint for every app screen on the PRODUCTION build.
//
// Usage:
//   node scripts/measure-screens.mjs [--url http://localhost:4173] [--runs 10]
//                                    [--screens settings,skills,...] [--json out.json]
//
// The app degrades gracefully outside Tauri (safeInvoke resolves null), so the
// real shell + every lazily-loaded view mounts and renders here; only the
// data payloads are empty. That is exactly what we want to time: the frontend
// mount/render cost the developer controls, independent of IPC latency.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const URL = arg("url", "http://localhost:4173");
const RUNS = Number(arg("runs", "10"));
const JSON_OUT = arg("json", null);
const ONLY = arg("screens", null);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("no Chrome/Edge executable found; set CHROME_PATH");
}

// name -> how to open, what root marks "the screen is committed", how to close.
const SCREENS = [
  {
    name: "settings",
    button: '[aria-label="Settings"]',
    root: ".settings-modal",
    close: "toggle",
  },
  {
    name: "skills",
    button: '[aria-label="Skills Library"]',
    root: ".view-overlay",
    text: "Skills",
    close: "back",
  },
  {
    name: "cost",
    button: '[aria-label="Cost"]',
    root: ".view-overlay",
    text: "Usage",
    close: "toggle",
  },
  {
    name: "automations",
    button: '[aria-label="Open automations"]',
    root: ".automations-view",
    close: "back",
  },
  {
    name: "vault",
    button: '[aria-label="Open vault"]',
    root: ".vault-view",
    close: "toggle",
  },
  {
    name: "wiki",
    button: '[aria-label="Open project wiki"]',
    root: ".wiki-view",
    close: "toggle",
  },
  {
    name: "bots",
    button: '[aria-label="Open bots"]',
    root: ".bots-view",
    close: "toggle",
  },
  {
    name: "logs",
    button: '[aria-label="Model request log"]',
    root: ".logs-view",
    close: "toggle",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inPage = {
  // Open a screen and time click -> synchronous DOM commit + click -> paint.
  open: async ({ button, root, text }) => {
    const match = () => {
      const el = document.querySelector(root);
      if (!el) return false;
      return !text || (el.textContent || "").includes(text);
    };
    const btn = document.querySelector(button);
    if (!btn) return { error: `button not found: ${button}` };
    const t0 = performance.now();
    let commitMs = null;
    // Microtask-precise commit detection (a MutationObserver callback runs as
    // a microtask right after the DOM mutation) instead of frame-quantized rAF.
    const obs = new MutationObserver(() => {
      if (commitMs == null && match()) commitMs = performance.now() - t0;
    });
    obs.observe(document.body, { childList: true, subtree: true });
    btn.click();
    if (commitMs == null && match()) commitMs = performance.now() - t0;
    if (commitMs == null) {
      // Lazy chunk still loading — poll frames until it mounts.
      const deadline = t0 + 8000;
      while (performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
        if (match()) { commitMs = performance.now() - t0; break; }
      }
    }
    obs.disconnect();
    // Next paint after the commit.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const paintMs = performance.now() - t0;
    return {
      commitMs: commitMs == null ? null : commitMs,
      paintMs,
    };
  },
  closeToggle: async ({ button, root, text }) => {
    const btn = document.querySelector(button);
    if (btn) btn.click();
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const el = document.querySelector(root);
      const shown = el && (!text || (el.textContent || "").includes(text));
      if (!shown) return true;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return false;
  },
  closeBack: async ({ root, text }) => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const el = document.querySelector(root);
      const shown = el && (!text || (el.textContent || "").includes(text));
      if (!shown) return true;
      const back = document.querySelector('[aria-label="Back"]');
      if (!back) return false;
      back.click();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return false;
  },
  atChat: () =>
    !document.querySelector(
      ".settings-modal, .vault-view, .wiki-view, .bots-view, .logs-view, .automations-view",
    ) && !document.querySelector(".view-overlay"),
};

function stats(samples) {
  if (!samples.length) return { n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    median: +med.toFixed(2),
    mean: +mean.toFixed(2),
    p90: +p90.toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

(async () => {
  const exe = findChrome();
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: "new",
    args: [
      "--no-sandbox",
      ...(process.argv.includes("--gpu") ? [] : ["--disable-gpu"]),
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.stack || String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for the shell + boot effects to settle.
  await page.waitForSelector(".bottom-bar", { timeout: 30000 }).catch(() => {});
  await sleep(2500);

  const screens = ONLY ? SCREENS.filter((s) => ONLY.split(",").includes(s.name)) : SCREENS;
  const results = [];

  for (const s of screens) {
    // Fresh page per screen: no error-boundary / history contamination
    // between measurements, and a deterministic starting chat view.
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(".bottom-bar", { timeout: 30000 }).catch(() => {});
    await sleep(4200);

    // Cold open (fetches the lazy chunk), then close for a clean slate.
    const cold = await page.evaluate(inPage.open, s);
    await sleep(400);
    if (s.close === "toggle") await page.evaluate(inPage.closeToggle, s).catch(() => {});
    else await page.evaluate(inPage.closeBack, s).catch(() => {});
    await sleep(250);

    // Warm opens: module cached, pure mount/render.
    const commitSamples = [];
    const paintSamples = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await page.evaluate(inPage.open, s);
      if (r?.commitMs != null) {
        commitSamples.push(r.commitMs);
        paintSamples.push(r.paintMs);
      }
      await sleep(120);
      if (s.close === "toggle") await page.evaluate(inPage.closeToggle, s).catch(() => {});
      else await page.evaluate(inPage.closeBack, s).catch(() => {});
      await sleep(150);
    }

    results.push({
      screen: s.name,
      coldCommitMs: cold?.commitMs == null ? null : +cold.commitMs.toFixed(2),
      coldPaintMs: cold?.paintMs == null ? null : +cold.paintMs.toFixed(2),
      error: cold?.error ?? null,
      warm: stats(commitSamples),
      warmPaint: stats(paintSamples),
    });
    process.stdout.write(`  measured ${s.name}\n`);
  }

  await browser.close();

  // Report
  const pad = (v, n) => String(v ?? "-").padEnd(n);
  console.log("\n=== Screen open times (production build) ===");
  console.log(
    pad("screen", 14) + pad("cold(ms)", 11) + pad("warm med", 11) + pad("warm p90", 11) +
      pad("warm max", 11) + pad("paint med", 11) + "status",
  );
  let worst = 0;
  for (const r of results) {
    const med = r.warm.median ?? 0;
    worst = Math.max(worst, med);
    console.log(
      pad(r.screen, 14) +
        pad(r.coldCommitMs, 11) +
        pad(r.warm.median, 11) +
        pad(r.warm.p90, 11) +
        pad(r.warm.max, 11) +
        pad(r.warmPaint.median, 11) +
        (med <= 50 ? "OK" : "SLOW") +
        (r.error ? ` (${r.error})` : ""),
    );
  }
  console.log(`\nworst warm median: ${worst.toFixed(2)} ms (budget 50 ms)`);

  if (errors.length) {
    console.log(`\npage errors (${errors.length}):`);
    for (const e of [...new Set(errors)].slice(0, 10)) console.log("  - " + e);
  }

  if (JSON_OUT) {
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify({ url: URL, runs: RUNS, results }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
