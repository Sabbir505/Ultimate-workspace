#!/usr/bin/env node
// Signs the built installer(s) and generates latest.json for the Tauri updater,
// in one step.
//
// Platform support:
//   windows-x86_64  → signs the .exe with the updater key
//   linux-x86_64    → AppImage artifact (signature not required by Tauri
//                      updater plugin on Linux; metadata is included so the
//                      client knows a newer version is available)
//   linux-aarch64   → deb artifact (same)
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
const keyPath = join(root, ".tauri/conduit-update.key");

// --- parse args ---
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// --- platform discovery ---
// Each entry: where to find the artifact in bundleDir, what filename pattern to
// match, and whether it needs to be signed (only the Windows NSIS installer is
// signed today; Linux artifacts are not signed because the Tauri updater
// plugin on Linux uses a different signature mechanism — AppImage verifies via
// its embedded update-info JSON, and the apt repository flow doesn't apply
// here). The latest.json still includes the Linux platform entries so the
// updater client can surface "a new version is available" and link to the
// release.
const PLATFORMS = {
  "windows-x86_64": {
    dir: "nsis",
    pattern: new RegExp(`^Conduit_${version.replace(/\./g, "\\.")}_x64-setup\\.exe$`),
    fallbackPattern: /^Conduit_[\d.]+_x64-setup\.exe$/,
    sign: true,
  },
  "linux-x86_64": {
    dir: "appimage",
    pattern: new RegExp(`^Conduit_${version.replace(/\./g, "\\.")}_amd64\\.AppImage$`),
    fallbackPattern: /^Conduit_[\d.]+_amd64\.AppImage$/,
    sign: false,
  },
  "linux-aarch64": {
    dir: "deb",
    pattern: new RegExp(`^Conduit_${version.replace(/\./g, "\\.")}_arm64\\.deb$`),
    fallbackPattern: /^Conduit_[\d.]+_arm64\.deb$/,
    sign: false,
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

  if (spec.sign) {
    // Windows: non-interactive sign with tauri signer.
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
  } else {
    console.log(`(note) ${key}: artifact not signed (Tauri updater does not verify Linux signatures today)`);
  }

  platforms[key] = {
    signature,
    url: `https://github.com/${repo}/releases/download/v${version}/${fileName}`,
  };
}

if (Object.keys(platforms).length === 0) {
  console.error(
    `\nNo platform artifacts found under ${bundleDir}.\n` +
      `Expected: nsis/, appimage/, deb/ (run \`npm run tauri build\` first).`,
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
