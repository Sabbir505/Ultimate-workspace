#!/usr/bin/env node
// Stage the relay-browser-mcp binary for Tauri 2's externalBin bundling.
// Tauri 2 expects externalBin entries at binaries/<name>-<target-triple>[.exe]
// relative to src-tauri/. This script copies the Cargo-built binary there so
// the installer picks it up.
//
// Called automatically by `beforeBuildCommand` in tauri.conf.json, after
// `cargo build --release` has produced the binary.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcTauri = join(root, "src-tauri");
const targetDir = join(srcTauri, "target", "release");

// Detect the host target triple from rustc.
let target;
try {
  target = execSync("rustc -vV", { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    ?.split("host:")[1]
    ?.trim();
} catch {
  console.error("✗ rustc not found — cannot stage browser MCP binary");
  process.exit(1);
}
if (!target) {
  console.error("✗ could not detect host target triple");
  process.exit(1);
}

const isWin = process.platform === "win32";
const srcName = isWin ? "relay-browser-mcp.exe" : "relay-browser-mcp";
const destName = `relay-browser-mcp-${target}${isWin ? ".exe" : ""}`;

// Check both release and debug target directories.
const releaseSrc = join(targetDir, srcName);
const debugSrc = join(srcTauri, "target", "debug", srcName);
let src;
if (existsSync(releaseSrc)) {
  src = releaseSrc;
} else if (existsSync(debugSrc)) {
  src = debugSrc;
} else {
  console.error(
    `✗ ${srcName} not found in target/release/ or target/debug/. Run \`cargo build\` first.`
  );
  process.exit(1);
}
const destDir = join(srcTauri, "binaries");
const dest = join(destDir, destName);

if (!existsSync(src)) {
  console.error(
    `✗ ${srcName} not found at ${src}. Run \`cargo build --release\` first.`
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`✓ staged ${destName} → binaries/`);