#!/usr/bin/env node
// Stage the relay-automation binary for Tauri 2's externalBin bundling.
// Same contract as stage-browser-mcp.mjs: copies the Cargo-built headless
// automation runner to binaries/relay-automation-<target-triple>[.exe]
// so the installer ships it next to the main exe (the "Run while closed"
// Task Scheduler toggle points at this binary).
//
// Called from CI after `cargo build --release --bin relay-automation`.

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
  console.error("✗ rustc not found — cannot stage automation binary");
  process.exit(1);
}
if (!target) {
  console.error("✗ could not detect host target triple");
  process.exit(1);
}

const isWin = process.platform === "win32";
const srcName = isWin ? "relay-automation.exe" : "relay-automation";
const destName = `relay-automation-${target}${isWin ? ".exe" : ""}`;

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
    `✗ ${srcName} not found in target/release/ or target/debug/. Run \`cargo build --bin relay-automation\` first.`
  );
  process.exit(1);
}
const destDir = join(srcTauri, "binaries");
const dest = join(destDir, destName);

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`✓ staged ${destName} → binaries/`);
