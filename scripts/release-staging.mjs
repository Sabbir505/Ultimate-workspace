#!/usr/bin/env node
// Builds, signs and packages the STAGING channel of Relay (local, Windows-only).
//
// This is the "staging deployment target": same app identity and same source as
// production, but a prerelease version, its own updater endpoint (the separate
// public repo Sabbir505/relay-releases-staging) and its own signing keypair, so
// a staging build can never be served to — or verified by — a production
// install. See docs/ai-context/RELEASE.md ("Staging target") for the full story
// and for what is NOT isolated (app data, keychain, scheduled task).
//
// The ORDER below is load-bearing: tauri-build validates every
// `bundle.resources` glob and `externalBin` path on ANY cargo invocation in the
// package, so the bundled Python/LibreOffice trees and the sidecar placeholders
// must exist before the first cargo build.
//
// Usage: npm run release:staging
//        npm run release:latest-json:staging   (delegates here with
//        --latest-json-only: runs ONLY step 7, the sign + latest.json pass, so
//        the staging constants below stay defined in this one file)
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = join(root, "src-tauri");
const STAGING_CONFIG = "src-tauri/tauri.staging.conf.json";
const STAGING_REPO = "Sabbir505/relay-releases-staging";
const STAGING_KEY = ".tauri/relay-update-staging.key";

function run(cmd, cwd = root) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

// --- --latest-json-only mode ---
// Exactly what `npm run release:latest-json:staging` did when it inlined this
// same make-latest-json invocation (same args, same fail-fast behavior —
// make-latest-json itself errors if the config or key is missing). No build,
// no guards: it only signs the existing bundle and rewrites latest.json.
if (process.argv.includes("--latest-json-only")) {
  run(
    `node scripts/make-latest-json.mjs --config ${STAGING_CONFIG} ` +
      `--repo ${STAGING_REPO} --key ${STAGING_KEY}`,
  );
  process.exit(0);
}

// Fail fast on the two things that make the (long) build wasteful or hang.
if (!existsSync(join(root, STAGING_CONFIG))) {
  console.error(`Missing ${STAGING_CONFIG}.`);
  process.exit(1);
}
if (!existsSync(join(root, STAGING_KEY))) {
  console.error(`Missing staging signing key at ${STAGING_KEY}. Generate it with:`);
  console.error(`  npx @tauri-apps/cli signer generate -w ${STAGING_KEY} --ci`);
  process.exit(1);
}
// With these set, `tauri build` sits on an interactive password prompt that the
// env var does not suppress (see RELEASE.md troubleshooting).
if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  console.error("Unset TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD first —");
  console.error("`tauri build` hangs on a password prompt when they are set. Signing happens in step 7.");
  process.exit(1);
}

// 1-2. Bundled interpreters. ~70 MB and ~1.5 GB, so don't refetch what is
// already staged.
if (existsSync(join(srcTauri, "resources/python/python.exe"))) {
  console.log("(skip) bundled Python already staged");
} else {
  run("node scripts/fetch-bundled-python.mjs");
}
if (existsSync(join(srcTauri, "resources/libreoffice/program/soffice.exe"))) {
  console.log("(skip) bundled LibreOffice already staged");
} else {
  run("node scripts/fetch-bundled-libreoffice.mjs");
}

// 3. Placeholders for BOTH sidecars, before the first cargo build.
mkdirSync(join(srcTauri, "binaries"), { recursive: true });
for (const bin of ["relay-browser-mcp", "relay-automation"]) {
  const placeholder = join(srcTauri, "binaries", `${bin}-x86_64-pc-windows-msvc.exe`);
  if (!existsSync(placeholder)) writeFileSync(placeholder, "");
}

// 4-5. Real sidecars, staged into binaries/ for externalBin bundling.
run("cargo build --release --bin relay-browser-mcp", srcTauri);
run("node scripts/stage-browser-mcp.mjs");
run("cargo build --release --bin relay-automation", srcTauri);
run("node scripts/stage-automation.mjs");

// 6. The staging bundle. No signing env vars (see the guard above).
run(`npx tauri build --config ${STAGING_CONFIG}`);

// 7. Sign + write latest.json for the staging channel only.
run(
  `node scripts/make-latest-json.mjs --config ${STAGING_CONFIG} ` +
    `--repo ${STAGING_REPO} --key ${STAGING_KEY}`,
);

// 8. Never publish from here — pushing a release is a deliberate, visible act.
const { version } = JSON.parse(readFileSync(join(root, STAGING_CONFIG), "utf8"));
const tag = `v${version}`;
console.log("\n=== Built. To publish (staging repo — never relay-releases): ===");
console.log(`  gh release create ${tag} -R ${STAGING_REPO} \\`);
console.log(`    src-tauri/target/release/bundle/nsis/Relay_${version}_x64-setup.exe \\`);
console.log(`    src-tauri/target/release/bundle/latest.json`);
console.log("\nDo NOT mark that release prerelease: the endpoint resolves through");
console.log("/releases/latest, which skips the newest prerelease.");
console.log(`\nNext build: bump "version" in ${STAGING_CONFIG} to the next -staging.N.`);
