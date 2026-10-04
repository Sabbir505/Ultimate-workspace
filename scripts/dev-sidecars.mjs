#!/usr/bin/env node
// Rebuild the MCP/automation sidecar binaries for the DEV layout before
// `tauri dev` launches the app.
//
// WHY THIS EXISTS: `tauri dev` cargo-builds only the app bin, so the
// sidecar targets (relay-browser-mcp, relay-automation) stay at whatever
// their last explicit build produced. Dev-resolved sidecars are the
// SIBLING files next to target/debug/relay.exe (mcp_binary_path() and
// automation_binary_path() layout 1), so a sidecar whose sources changed
// kept serving its WEEKS-OLD baked-in static tool list to every harness
// session — invisible while the live WS fetch worked, and exactly the
// "in capabilities but not in this session" break once it didn't.
//
// Wired as the first half of beforeDevCommand in tauri.conf.json. Debug
// profile on purpose: dev runs debug; release bundling stages its own
// binaries via scripts/stage-*.mjs.

import { execSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(__dirname, "..", "src-tauri");
const bins = ["relay-browser-mcp", "relay-automation"];

// Kill any RUNNING sidecar instances before cargo touches their exes. On
// Windows a running exe cannot be replaced ("Access is denied", os error 5),
// and both sidecars legitimately outlive the app: relay-browser-mcp is
// spawned by harness CLIs via mcp.json, relay-automation is fired headless
// by Windows Task Scheduler. An orphaned one therefore locks every dev
// launch until it is killed. Dev-only by construction: this script runs
// solely in `tauri dev`'s beforeDevCommand, where the binaries are about to
// be REPLACED — anything still running is serving the stale build this
// script exists to refresh. `taskkill` exits 128 when no process matches.
for (const bin of bins) {
  spawnSync("taskkill", ["/IM", `${bin}.exe`, "/F"], { stdio: "ignore" });
}

const started = Date.now();
const res = spawnSync(
  "cargo",
  ["build", "--manifest-path", join(srcTauri, "Cargo.toml"), ...bins.flatMap((b) => ["--bin", b])],
  { encoding: "utf8" },
);

if (res.error || res.status !== 0) {
  // Fail the dev launch loudly: a stale or missing sidecar is the exact
  // bug this script exists to prevent — never continue silently.
  if (res.stderr) process.stderr.write(res.stderr);
  console.error("✗ sidecar build failed — fix the error above before dev");
  process.exit(1);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
const rebuilt = /Compiling/.test(res.stderr);
console.log(rebuilt ? `✓ sidecars rebuilt (${secs}s)` : `✓ sidecars fresh (${secs}s)`);
