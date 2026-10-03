#!/usr/bin/env node
// Stage a Cargo-built sidecar binary for Tauri 2's externalBin bundling.
// Tauri 2 expects externalBin entries at binaries/<name>-<target-triple>[.exe]
// relative to src-tauri/. This script copies the Cargo-built binary there so
// the installer picks it up.
//
// Usage:
//   node scripts/stage-sidecar.mjs <binary-name> [--allow-debug]
//
//   <binary-name>    e.g. relay-browser-mcp or relay-automation (the Cargo
//                    bin target name; -<target-triple>[.exe] is appended).
//   --allow-debug    Opt-in: fall back to target/debug/ when no release
//                    binary exists. DEFAULT IS OFF — a debug build silently
//                    staged into a release installer ships unoptimized and
//                    unstripped (debug-assertion) code to users.
//
// Shared by stage-browser-mcp.mjs / stage-automation.mjs (thin wrappers kept
// for release-staging.mjs and the RELEASE.md docs), and called directly with
// the binary name from CI.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcTauri = join(root, "src-tauri");
const targetDir = join(srcTauri, "target", "release");

const args = process.argv.slice(2);
const allowDebug = args.includes("--allow-debug");
const binaryName = args.find((a) => !a.startsWith("--"));

if (!binaryName) {
  console.error("✗ usage: node scripts/stage-sidecar.mjs <binary-name> [--allow-debug]");
  process.exit(1);
}

// Detect the host target triple from rustc.
let target;
try {
  target = execSync("rustc -vV", { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    ?.split("host:")[1]
    ?.trim();
} catch {
  console.error(`✗ rustc not found — cannot stage ${binaryName} binary`);
  process.exit(1);
}
if (!target) {
  console.error("✗ could not detect host target triple");
  process.exit(1);
}

const isWin = process.platform === "win32";
const srcName = isWin ? `${binaryName}.exe` : binaryName;
const destName = `${binaryName}-${target}${isWin ? ".exe" : ""}`;

// Prefer the release binary; target/debug/ only with --allow-debug.
const releaseSrc = join(targetDir, srcName);
const debugSrc = join(srcTauri, "target", "debug", srcName);
let src;
if (existsSync(releaseSrc)) {
  src = releaseSrc;
} else if (allowDebug && existsSync(debugSrc)) {
  console.log(`(note) --allow-debug: no release binary; staging the DEBUG ${srcName}`);
  src = debugSrc;
} else {
  console.error(
    `✗ ${srcName} not found in target/release/${allowDebug ? "" : " (or target/debug/ without --allow-debug)."}` +
      ` Run \`cargo build --release --bin ${binaryName}\` first.`
  );
  process.exit(1);
}
const destDir = join(srcTauri, "binaries");
const dest = join(destDir, destName);

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`✓ staged ${destName} → binaries/`);
