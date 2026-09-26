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
// Flags (all optional; the defaults are the production channel):
//   --config <path>   Tauri config to read `version` from. Default
//                     src-tauri/tauri.conf.json. A partial override file (e.g.
//                     src-tauri/tauri.staging.conf.json, which `tauri build
//                     --config` merges over the base) is merged the same way here.
//   --repo <owner/name>  Releases repo the asset URLs point at. Default
//                     Sabbir505/relay-releases.
//   --key <path>      Signing key. Default .tauri/relay-update.key.
//   --tag <ref>       Release tag the assets are attached to. Default v<version>.
//   --dry-run         Resolve config/repo/key/tag and print them without
//                     signing or writing anything. Use this to confirm the
//                     channel before committing to a full bundle build.
//
// Run AFTER `npm run tauri build` (no signing env vars needed).
// See RELEASE.md for the full workflow.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// --- parse args ---
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Production channel defaults — a bare invocation must behave exactly as before.
const BASE_CONFIG = "src-tauri/tauri.conf.json";
const DEFAULT_REPO = "Sabbir505/relay-releases";
const DEFAULT_KEY = ".tauri/relay-update.key";

const baseConfPath = join(root, BASE_CONFIG);
const confPath = join(root, argValue("--config") ?? BASE_CONFIG);

// The staging config is a PARTIAL override that `tauri build --config` merges
// over the base config, so mirror that merge here (top-level keys, override
// wins). `version` then resolves from either file.
const conf = { ...JSON.parse(readFileSync(baseConfPath, "utf8")) };
if (confPath !== baseConfPath) {
  if (!existsSync(confPath)) {
    console.error(`No config at ${confPath}.`);
    process.exit(1);
  }
  Object.assign(conf, JSON.parse(readFileSync(confPath, "utf8")));
}
const version = conf.version;

// Releases live in a public releases-only repo so downloads keep working while
// the source repo (Ultimate-workspace) stays private. Staging points at its OWN
// repo so the two channels can't serve each other's builds.
const repo = argValue("--repo") ?? DEFAULT_REPO;
const tag = argValue("--tag") ?? `v${version}`;
const keyPath = join(root, argValue("--key") ?? DEFAULT_KEY);
const dryRun = args.includes("--dry-run");

const bundleDir = join(root, "src-tauri/target/release/bundle");

const PLATFORMS = {
  "windows-x86_64": {
    dir: "nsis",
    // Accept both the pre-rebrand `Conduit_` installer name and the current
    // `Relay_` one (productName in tauri.conf.json drives the NSIS filename).
    pattern: new RegExp(`^(?:Conduit|Relay)_${version.replace(/\./g, "\\.")}_x64-setup\\.exe$`),
    fallbackPattern: /^(?:Conduit|Relay)_[\d.]+(?:-[0-9A-Za-z.-]+)?_x64-setup\.exe$/,
    sign: true,
  },
};

if (!dryRun && !existsSync(bundleDir)) {
  console.error(`No bundle directory at ${bundleDir}. Run \`npm run tauri build\` first.`);
  process.exit(1);
}
if (!dryRun && !existsSync(keyPath)) {
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

  if (dryRun) {
    console.log(`(dry run) would sign ${fileName}`);
  } else {
    // Non-interactive sign with tauri signer.
    const sigPath = `${filePath}.sig`;
    console.log(`Signing ${fileName} …`);
    try {
      execSync(
        // Pinned to the repo's @tauri-apps/cli major (devDependencies: "^2"):
        // the CI release job runs without `npm ci`, so an unpinned `npx
        // @tauri-apps/cli` would silently pick up a future, possibly
        // breaking major from the registry.
        `npx @tauri-apps/cli@^2 signer sign -f "${keyPath}" -p "" "${filePath}"`,
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
  }

  platforms[key] = {
    signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${fileName}`,
  };
}

if (Object.keys(platforms).length === 0) {
  if (dryRun) {
    console.log("\n(dry run) resolved channel settings:");
    console.log(`  config  : ${confPath}`);
    console.log(`  version : ${version}`);
    console.log(`  repo    : ${repo}`);
    console.log(`  tag     : ${tag}`);
    console.log(`  key     : ${keyPath}`);
    console.log(`  expected: ${join(bundleDir, "nsis", `Relay_${version}_x64-setup.exe`)}`);
    console.log("\nNo artifacts present yet — build first, then re-run without --dry-run.");
    process.exit(0);
  }
  console.error(
    `\nNo platform artifacts found under ${bundleDir}.\n` +
      `Expected: nsis/ (run \`npm run tauri build\` first).`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log("\n(dry run) resolved channel settings:");
  console.log(`  config  : ${confPath}`);
  console.log(`  repo    : ${repo}`);
  console.log(`  tag     : ${tag}`);
  console.log(`  key     : ${keyPath}`);
  for (const [key, p] of Object.entries(platforms)) {
    console.log(`  ${key}: ${p.url}`);
  }
  console.log("\nNothing was signed or written. Re-run without --dry-run to sign.");
  process.exit(0);
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
console.log(`  1. Create a GitHub Release tagged ${tag} on`);
console.log(`     https://github.com/${repo}/releases/new`);
console.log(`  2. Attach these files:`);
for (const [key, p] of Object.entries(platforms)) {
  const dir = PLATFORMS[key].dir;
  console.log(`     - ${p.url.split("/").pop()}  (src-tauri/target/release/bundle/${dir}/)`);
}
console.log(`     - latest.json  (src-tauri/target/release/bundle/)`);
console.log("  3. Paste your changelog into the release description.");
console.log("  4. Publish. Updates roll out within 4 hours.");
const assetPaths = Object.entries(platforms).map(
  ([key, p]) => `src-tauri/target/release/bundle/${PLATFORMS[key].dir}/${p.url.split("/").pop()}`,
);
console.log("");
console.log("  5. Or publish from the CLI:");
console.log(`     gh release create ${tag} -R ${repo} ${assetPaths.join(" ")} src-tauri/target/release/bundle/latest.json`);
