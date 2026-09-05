#!/usr/bin/env node
// Signs the built installer(s) and generates latest.json for the Tauri updater,
// in one step.
//
// Platform support:
//   windows-x86_64  → signs the .exe with the updater key
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
const keyPath = join(root, ".tauri/relay-update.key");

// --- parse args ---
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const PLATFORMS = {
  "windows-x86_64": {
    dir: "nsis",
    // Accept both the pre-rebrand `Conduit_` installer name and the current
    // `Relay_` one (productName in tauri.conf.json drives the NSIS filename).
    pattern: new RegExp(`^(?:Conduit|Relay)_${version.replace(/\./g, "\\.")}_x64-setup\\.exe$`),
    fallbackPattern: /^(?:Conduit|Relay)_[\d.]+_x64-setup\.exe$/,
    sign: true,
  },
};

if (!existsSync(bundleDir)) {
  console.error(`No bundle directory at ${bundleDir}. Run \`npm run tauri build\` first.`);
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`Missing signing key at ${keyPath}. See RELEASE.md.`);
  process.exit(1);
}

// --- changelog notes ---
// The update banner renders this markdown directly, so it must contain ONLY
// the released version's section — never the whole file (header, naming note,
// legend and all). Keep a Changelog sections look like `## [0.4.2] — 2026-08-31`.
function extractSection(md, ver) {
  const versionHeading = new RegExp(`^##\\s\\[${ver.replace(/\./g, "\\.")}\\]`);
  const clean = (body) =>
    body
      .filter((line) => !/^-{3,}\s*$/.test(line))
      .join("\n")
      .trim();

  // Split the file into `## ` sections, ignoring any preamble before them.
  const sections = [];
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^##\s/.test(line)) {
      sections.push({ title: line, body: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].body.push(line);
    }
  }

  // Prefer this version's section; fall back to the first non-empty one
  // (e.g. a release cut straight from a still-populated [Unreleased]).
  const wanted = sections.find((s) => versionHeading.test(s.title));
  return (
    (wanted && clean(wanted.body)) ||
    sections.map((s) => clean(s.body)).find(Boolean) ||
    md.trim()
  );
}

let notes = argValue("--notes");
const notesFile = argValue("--notes-file");
if (!notes && notesFile) {
  const p = join(root, notesFile);
  if (existsSync(p)) {
    notes = extractSection(readFileSync(p, "utf8"), version);
  }
}
if (!notes) {
  notes = `Relay ${version}. See release notes on GitHub.`;
}

const pubDate = new Date().toISOString();

const platforms = {};

// --- iterate platforms ---
for (const [key, spec] of Object.entries(PLATFORMS)) {
  const platformDir = join(bundleDir, spec.dir);
  if (!existsSync(platformDir)) {
    console.log(`(skip) ${key}: no ${spec.dir} bundle at ${platformDir}`);
    continue;
  }

  // Find the artifact for THIS version, fall back to the newest present.
  let fileName;
  const exact = readdirSync(platformDir).filter((f) => spec.pattern.test(f));
  if (exact.length > 0) {
    fileName = exact.sort().pop();
  } else {
    const candidates = readdirSync(platformDir).filter((f) => spec.fallbackPattern.test(f));
    if (candidates.length === 0) {
      console.log(`(skip) ${key}: no matching artifact in ${platformDir}`);
      continue;
    }
    fileName = candidates.sort().pop();
    console.log(`(note) ${key}: no exact-version artifact, using newest: ${fileName}`);
  }

  const filePath = join(platformDir, fileName);
  let signature = "";

  // Non-interactive sign with tauri signer.
  const sigPath = `${filePath}.sig`;
  console.log(`Signing ${fileName} …`);
  try {
    execSync(
      `npx @tauri-apps/cli signer sign -f "${keyPath}" -p "" "${filePath}"`,
      { stdio: "inherit", cwd: root },
    );
  } catch {
    console.error(`Signing failed for ${fileName}. See error above.`);
    process.exit(1);
  }
  if (!existsSync(sigPath)) {
    console.error(`Expected signature at ${sigPath} but it wasn't created.`);
    process.exit(1);
  }
  signature = readFileSync(sigPath, "utf8").trim();
  console.log(`✓ Signed ${fileName}`);

  platforms[key] = {
    signature,
    url: `https://github.com/${repo}/releases/download/v${version}/${fileName}`,
  };
}

if (Object.keys(platforms).length === 0) {
  console.error(
    `\nNo platform artifacts found under ${bundleDir}.\n` +
      `Expected: nsis/ (run \`npm run tauri build\` first).`,
  );
  process.exit(1);
}

const latest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};

const outPath = join(bundleDir, "latest.json");
writeFileSync(outPath, JSON.stringify(latest, null, 2) + "\n");

console.log(`\n✓ Wrote ${outPath}`);
console.log(`  version: ${version}`);
console.log(`  pub_date: ${pubDate}`);
for (const [key, p] of Object.entries(platforms)) {
  console.log(`  ${key}: ${p.url}`);
}
console.log("");
console.log("Next steps (see RELEASE.md):");
console.log(`  1. Create a GitHub Release tagged v${version} on`);
console.log(`     https://github.com/${repo}/releases/new`);
console.log(`  2. Attach these files:`);
for (const [key, p] of Object.entries(platforms)) {
  const dir = PLATFORMS[key].dir;
  console.log(`     - ${p.url.split("/").pop()}  (src-tauri/target/release/bundle/${dir}/)`);
}
console.log(`     - latest.json  (src-tauri/target/release/bundle/)`);
console.log("  3. Paste your changelog into the release description.");
console.log("  4. Publish. Updates roll out within 4 hours.");
