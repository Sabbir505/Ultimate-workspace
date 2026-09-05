#!/usr/bin/env node
// Stage a llama-server binary + its sibling shared libraries as an OPTIONAL,
// MANUALLY-INSTALLED sidecar. Run: node scripts/stage-llama-server.mjs
//
// llama.cpp ships a tiny launcher (`llama-server`) that dlopens several
// sibling shared libraries (`libllama-server-impl.so`, `libllama.so`,
// `libggml.so`, …, ~30MB total) using `RUNPATH: $ORIGIN`. The launcher must
// therefore ship with all its .so files in the same directory at runtime.
//
// NOTE: nothing consumes these files automatically today. tauri.conf.json has
// NO `externalBin` entry for llama-server, so a packaged install does not
// include it; the Rust side only finds it if the files are placed where its
// bundled-sidecar lookup probes (next to the main exe / under binaries/) or
// via LLAMA_SERVER_PATH. This script just stages the bits in that layout
// under src-tauri/binaries/ — to actually bundle it, add a matching
// `externalBin` entry + a `bundle.resources` glob for the sibling libs. At
// spawn time the Rust side sets the launcher's dir as current_dir so $ORIGIN
// resolves; nothing copies files around at first run.
//
// This script:
//   1. Detects host triple via rustc -vV.
//   2. Detects GPU: nvidia-smi → use Vulkan build; else CPU build.
//      (For now only Linux x86_64 is fully implemented; macOS/Windows use
//       placeholder downloads and warn.)
//   3. Downloads the official llama.cpp release archive from GitHub into
//      llama-cache/<RELEASE>/.
//   4. Extracts INSIDE llama-cache/<RELEASE>/ and copies the launcher + .so
//      files to `binaries/llama-server-<triple>/`.
//   5. Also stages a sibling `llama-server-<triple>[.exe]` flat copy at the
//      top of `binaries/` (the Tauri externalBin naming convention).
//
// Integrity (audit H2): llama.cpp releases ship no checksum asset, so this
// script bootstraps its own pin — the first download records the archive's
// SHA-256 in llama-cache/<RELEASE>/<asset>.sha256 and prints it (verify it
// against a trusted source); every later run (including cached reuse)
// verifies the archive against that pin and refuses to extract a mismatch.
// `--print-checksum` prints the digest and exits without staging.
// STRICT_CHECKSUM=1 fails closed when no checksum is on file yet (e.g. CI
// with a pre-provisioned cache that must not trust an unpinned download).
//
// Idempotent: re-running skips the download if already extracted.
// Pass `--force` to redownload.

import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcTauri = join(root, "src-tauri");
const binariesDir = join(srcTauri, "binaries");
const cacheDir = join(srcTauri, "target", "llama-cache");

const FORCE = process.argv.includes("--force");
const PRINT_CHECKSUM = process.argv.includes("--print-checksum");
// Fail closed when no checksum is on file (see the Integrity note in the header).
const STRICT_CHECKSUM = process.env.STRICT_CHECKSUM === "1";
const RELEASE = process.env.LLAMA_RELEASE || "b10199";

// Detect host triple.
let target;
try {
  target = execSync("rustc -vV", { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    ?.split("host:")[1]
    ?.trim();
} catch {
  console.error("✗ rustc not found — cannot stage llama-server");
  process.exit(1);
}
if (!target) {
  console.error("✗ could not detect host target triple");
  process.exit(1);
}

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const dirName = `llama-server-${target}`;       // binaries/llama-server-<triple>/
const flatName = `llama-server-${target}${isWin ? ".exe" : ""}`;  // for externalBin

// ---- Asset selection ----
// Map (triple, hasNvidia) → the llama.cpp release asset filename.
function selectAsset(target, hasNvidia) {
  if (target === "x86_64-unknown-linux-gnu") {
    // Linux x86_64. The latest llama.cpp releases ship Vulkan + CPU builds
    // for Linux but not CUDA. Vulkan works on NVIDIA + AMD + Intel, so
    // that's our default. If no GPU, fall back to the smaller CPU build.
    return hasNvidia
      ? `llama-${RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`
      : `llama-${RELEASE}-bin-ubuntu-x64.tar.gz`;
  }
  if (target === "aarch64-unknown-linux-gnu") {
    return `llama-${RELEASE}-bin-ubuntu-arm64.tar.gz`;
  }
  if (target === "x86_64-apple-darwin") {
    return `llama-${RELEASE}-bin-macos-x64.tar.gz`;
  }
  if (target === "aarch64-apple-darwin") {
    return `llama-${RELEASE}-bin-macos-arm64.tar.gz`;
  }
  if (target === "x86_64-pc-windows-msvc") {
    return hasNvidia
      ? `llama-${RELEASE}-bin-win-cuda-12.4-x64.zip`
      : `llama-${RELEASE}-bin-win-cpu-x64.zip`;
  }
  return null;
}

function detectNvidia() {
  // Try `nvidia-smi -L`; non-zero exit or empty stdout means no NVIDIA driver.
  const r = spawnSync("nvidia-smi", ["-L"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim().length > 0;
}

const hasNvidia = detectNvidia();
const asset = selectAsset(target, hasNvidia);

if (!asset) {
  console.error(`✗ unsupported host triple for llama-server sidecar: ${target}`);
  console.error(`  Supported: x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu,`);
  console.error(`             x86_64-apple-darwin, aarch64-apple-darwin, x86_64-pc-windows-msvc`);
  console.error(`  Install llama.cpp manually and set LLAMA_SERVER_PATH.`);
  process.exit(1);
}

// The llama-server sidecar is not referenced by any externalBin entry in
// tauri.conf.json (it's an optional manual sidecar — see the header). Only
// Linux targets are staged; Windows/macOS have nothing useful to download —
// skip so CI/dev builds stay fast and don't pull 100+ MB zips.
if (isWin || isMac) {
  console.log(`ℹ llama-server sidecar is only bundled for Linux targets — skipping staging on ${target}`);
  process.exit(0);
}

console.log(`→ target: ${target}`);
console.log(`→ gpu:    ${hasNvidia ? "NVIDIA (vulkan build)" : "none (cpu build)"}`);
console.log(`→ asset:  ${asset}`);

// ---- Check if already staged ----
const finalDir = join(binariesDir, dirName);
const finalLauncher = join(finalDir, isWin ? "llama-server.exe" : "llama-server");
if (!FORCE && existsSync(finalLauncher)) {
  const st = statSync(finalLauncher);
  if (st.size > 1024) {
    console.log(`✓ already staged at binaries/${dirName}/ (${st.size} bytes) — skipping (use --force to redownload)`);
    stageFlatExternalBin();
    process.exit(0);
  }
}

// ---- Download ----
mkdirSync(cacheDir, { recursive: true });
const tarball = join(cacheDir, asset);

if (FORCE || !existsSync(tarball) || statSync(tarball).size < 1000) {
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}/${asset}`;
  console.log(`→ downloading ${url}`);
  // Use gh CLI to download — it handles auth/redirects/retry better than curl
  // on slow connections. Falls back to curl if gh isn't available.
  const gh = spawnSync("gh", ["release", "download", RELEASE, "--repo", "ggml-org/llama.cpp",
    "--dir", cacheDir, "--pattern", asset, "--clobber"], { stdio: "inherit" });
  if (gh.status !== 0) {
    console.error(`✗ download failed (gh exit ${gh.status})`);
    process.exit(1);
  }
}

if (!existsSync(tarball)) {
  console.error(`✗ tarball not found at ${tarball} after download`);
  process.exit(1);
}

// ---- Integrity (audit H2) ----
// llama.cpp releases ship NO checksum asset, so the pin is bootstrapped here:
// the first trusted download records its SHA-256 in a sidecar file and prints
// it; every later run verifies the archive (fresh or cached) against that pin
// before extraction and refuses a mismatch. Re-verify the digest manually
// whenever LLAMA_RELEASE is bumped.
async function sha256File(file) {
  const hash = createHash("sha256");
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

const checksumFile = `${tarball}.sha256`;
const actualDigest = await sha256File(tarball);
if (existsSync(checksumFile)) {
  const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
  if (actualDigest !== expected) {
    rmSync(tarball, { force: true });
    rmSync(checksumFile, { force: true });
    console.error(`✗ SHA-256 mismatch for ${asset}: expected ${expected}, got ${actualDigest}`);
    console.error(`  corrupt/truncated archive + stale pin deleted — re-run to redownload, then re-verify the new digest against a trusted source`);
    process.exit(1);
  }
  console.log(`✓ SHA-256 verified: ${actualDigest}`);
} else if (STRICT_CHECKSUM) {
  console.error(`✗ STRICT_CHECKSUM=1: no checksum on file for ${asset}.`);
  console.error(`  This archive's digest is: ${actualDigest}`);
  console.error(`  Verify it against a trusted source, then write it to:`);
  console.error(`    ${checksumFile}`);
  console.error(`  and re-run (or run --print-checksum once on a trusted connection).`);
  process.exit(1);
} else {
  writeFileSync(checksumFile, actualDigest + "\n");
  console.log(`⚠ no checksum on file for ${asset} — bootstrapped pin (VERIFY this digest against a trusted source):`);
  console.log(`  ${actualDigest}`);
  console.log(`  saved to ${checksumFile} — future runs verify against it`);
}

if (PRINT_CHECKSUM) {
  console.log(`${actualDigest}  ${asset}`);
  process.exit(0);
}

// ---- Extract ----
// Extract INSIDE a per-release subdir (llama-cache/<RELEASE>/) so a bumped
// LLAMA_RELEASE can never collide with — or pick up — a stale extraction from
// a previous release sitting in the shared cache dir.
const extractDir = join(cacheDir, RELEASE);
mkdirSync(extractDir, { recursive: true });

console.log(`→ extracting ${asset} into llama-cache/${RELEASE}/…`);
mkdirSync(finalDir, { recursive: true });

const isZip = asset.endsWith(".zip");
if (isZip) {
  // Windows-only asset. Prefer `tar` (the Windows 10+ built-in libarchive
  // handles zip); fall back to `unzip` (Git-for-Windows / Unix) if absent.
  let r = spawnSync("tar", ["xf", tarball, "-C", extractDir], { stdio: "inherit" });
  if (r.status !== 0) {
    r = spawnSync("unzip", ["-o", "-q", tarball, "-d", extractDir], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`✗ extract failed (tar and unzip both failed)`);
      process.exit(1);
    }
  }
} else {
  const r = spawnSync("tar", ["xzf", tarball, "-C", extractDir], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✗ tar extract failed`);
    process.exit(1);
  }
}

// Find the extracted top-level directory — matched EXACTLY against
// `llama-<RELEASE>` (no prefix matching, which could grab e.g.
// `llama-<RELEASE>-something` or a stale dir from another release).
// The win-cpu/win-cuda zips are FLAT (no parent dir) — fall back to the
// per-release extract dir itself.
const exactTop = join(extractDir, `llama-${RELEASE}`);
const extractedDir = existsSync(exactTop) && statSync(exactTop).isDirectory() ? exactTop : extractDir;

// Copy the launcher + all .so / .dylib / .dll siblings into binaries/llama-server-<triple>/.
const entries = readdirSync(extractedDir);
for (const name of entries) {
  if (name === "llama-server" || name === "llama-server.exe" || name.endsWith(".so") ||
      name.endsWith(".so.0") || name.endsWith(".dylib") || name.endsWith(".dll")) {
    copyFileSync(join(extractedDir, name), join(finalDir, name));
  }
}
if (!isWin && !isMac) {
  chmodSync(finalLauncher, 0o755);
}

console.log(`✓ staged launcher + libs at binaries/${dirName}/`);

// ---- Stage the flat sidecar copy ----
// Stage the launcher under the Tauri externalBin NAMING CONVENTION (a single
// file at binaries/<name>-<target-triple>[.exe]) — that's the layout the
// Rust side's bundled-sidecar lookup probes and what an `externalBin` entry
// would consume if one is ever added (none exists today — optional manual
// sidecar). The sibling .so files live in the SAME directory as the staged
// launcher; the Rust side passes that dir as spawn current_dir so $ORIGIN
// resolves.
const renamedInDir = join(finalDir, flatName);
try {
  copyFileSync(finalLauncher, renamedInDir);
  if (!isWin) chmodSync(renamedInDir, 0o755);
  console.log(`✓ staged flat externalBin at binaries/${dirName}/${flatName}`);
} catch (e) {
  console.error(`✗ failed to stage flat launcher: ${e}`);
  process.exit(1);
}

// Also copy the flat launcher to the top of binaries/ for easier inspection
// (if the sidecar is ever bundled, the installer layout will be
// `<exe_dir>/llama-server-<triple>` + bundled-resources for the .so files).
// On Linux the flat name `llama-server-<triple>` collides with the staged
// directory of the same name — skip the top-level copy there (it's only for
// inspection; externalBin uses the nested path).
const flatTop = join(binariesDir, flatName);
if (!existsSync(flatTop) || statSync(flatTop).isFile()) {
  copyFileSync(renamedInDir, flatTop);
  if (!isWin) chmodSync(flatTop, 0o755);
  console.log(`✓ staged flat launcher at binaries/${flatName}`);
} else {
  console.log(`ℹ flat launcher name collides with the staged dir on this target — skipping top-level copy`);
}

function stageFlatExternalBin() {
  // Already-staged path: just ensure the flat externalBin file exists.
  const flatTop = join(binariesDir, flatName);
  if (existsSync(finalLauncher) && (!existsSync(flatTop) || statSync(flatTop).isFile())) {
    copyFileSync(finalLauncher, flatTop);
    if (!isWin) chmodSync(flatTop, 0o755);
    console.log(`✓ staged flat externalBin at binaries/${flatName}`);
  }
}
