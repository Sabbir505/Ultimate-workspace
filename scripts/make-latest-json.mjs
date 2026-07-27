#!/usr/bin/env node
// Signs the built NSIS installer and generates latest.json for the Tauri
// updater, in one step.
//
// WHY THIS EXISTS: `tauri build` hangs on an interactive password prompt during
// its built-in signing phase (the TAURI_SIGNING_PRIVATE_KEY_PASSWORD env var is
// not honored in that flow). The reliable path is: build WITHOUT signing env
// vars (so it won't hang), then sign the produced installer with
// `tauri signer sign -f <key> -p "" <file>` — which IS non-interactive. This
// script does the sign step + assembles latest.json.
//
// Usage:
//   npm run release:latest-json                       # uses a default changelog
//   npm run release:latest-json -- --notes "..."      # inline changelog
//   npm run release:latest-json -- --notes-file CHANGELOG.md   # from a file
//
// Run AFTER `npm run tauri build` (no signing env vars needed).
// See RELEASE.md for the full workflow.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const repo = "Sabbir505/Ultimate-workspace";
const bundleDir = join(root, "src-tauri/target/release/bundle");
const nsisDir = join(bundleDir, "nsis");
const keyPath = join(root, ".tauri/conduit-update.key");

// --- parse args ---
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

if (!existsSync(nsisDir)) {
  console.error(`No NSIS bundle found at ${nsisDir}. Run \`npm run tauri build\` first.`);
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`Missing signing key at ${keyPath}. See RELEASE.md.`);
  process.exit(1);
}

// Find the -setup.exe for this version (fall back to any present).
let exeName = `Conduit_${version}_x64-setup.exe`;
if (!existsSync(join(nsisDir, exeName))) {
  const candidates = readdirSync(nsisDir).filter((f) =>
    /Conduit_[\d.]+_x64-setup\.exe$/.test(f),
  );
  if (candidates.length === 0) {
    console.error(`No Conduit_*_x64-setup.exe found in ${nsisDir}.`);
    process.exit(1);
  }
  exeName = candidates.sort().pop(); // newest by sort order
}
const exePath = join(nsisDir, exeName);
const sigPath = `${exePath}.sig`;

// --- sign (non-interactive) ---
console.log(`Signing ${exeName} …`);
try {
  execSync(
    `npx @tauri-apps/cli signer sign -f "${keyPath}" -p "" "${exePath}"`,
    { stdio: "inherit", cwd: root },
  );
} catch {
  console.error("Signing failed. See error above.");
  process.exit(1);
}
if (!existsSync(sigPath)) {
  console.error(`Expected signature at ${sigPath} but it wasn't created.`);
  process.exit(1);
}
const signature = readFileSync(sigPath, "utf8").trim();
console.log(`✓ Signed`);

// --- changelog notes ---
let notes = argValue("--notes");
const notesFile = argValue("--notes-file");
if (!notes && notesFile) {
  const p = join(root, notesFile);
  if (existsSync(p)) {
    const cl = readFileSync(p, "utf8");
    const top = cl.match(/^##\s.*\n([\s\S]*?)(?=\n##\s|$)/);
    notes = top ? top[1].trim() : cl.trim();
  }
}
if (!notes) {
  notes = `Conduit ${version}. See release notes on GitHub.`;
}

const pubDate = new Date().toISOString();

const latest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/v${version}/${exeName}`,
    },
  },
};

const outPath = join(bundleDir, "latest.json");
writeFileSync(outPath, JSON.stringify(latest, null, 2) + "\n");

console.log(`✓ Wrote ${outPath}`);
console.log(`  version: ${version}`);
console.log(`  pub_date: ${pubDate}`);
console.log(`  installer: ${exeName}`);
console.log("");
console.log("Next steps (see RELEASE.md):");
console.log(`  1. Create a GitHub Release tagged v${version} on`);
console.log(`     https://github.com/${repo}/releases/new`);
console.log(`  2. Attach these files:`);
console.log(`     - ${exeName}  (src-tauri/target/release/bundle/nsis/)`);
console.log(`     - latest.json  (src-tauri/target/release/bundle/)`);
console.log("  3. Paste your changelog into the release description.");
console.log("  4. Publish. Updates roll out within 4 hours.");
