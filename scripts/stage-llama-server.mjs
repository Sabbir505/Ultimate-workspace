#!/usr/bin/env node
// Stage the llama-server binary + its sibling .so files for Tauri 2 bundling.
//
// llama.cpp ships a tiny 18KB launcher (`llama-server`) that dlopens several
// sibling shared libraries (`libllama-server-impl.so`, `libllama.so`,
// `libggml.so`, …, ~30MB total) using `RUNPATH: $ORIGIN`. The launcher must
// therefore ship with all its .so files in the same directory at runtime.
//
// Tauri 2's `externalBin` only supports single-file sidecars, so the launcher
// goes through `externalBin` and the .so files go through `bundle.resources`.
// The Rust resolver (resolve_llama_server_binary) places the .so files
// alongside the binary at first run by copying from the resource dir if
// needed, and sets `current_dir` so $ORIGIN resolves correctly.
//
// This script:
//   1. Detects host triple via rustc -vV.
//   2. Detects GPU: nvidia-smi → use Vulkan build; else CPU build.
//      (For now only Linux x86_64 is fully implemented; macOS/Windows use
//       placeholder downloads and warn.)
//   3. Downloads the official llama.cpp release archive from GitHub.
//   4. Extracts the launcher + .so files to `binaries/llama-server-<triple>/`.
//   5. Also stages a sibling `llama-server-<triple>` file at the top of
//      `binaries/` so Tauri's externalBin can find it (Tauri renames it to
//      `llama-server-<target-triple>` next to the main exe).
//
// Idempotent: re-running skips the download if already extracted.
// Pass `--force` to redownload.

import { copyFileSync, existsSync, mkdirSync, statSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcTauri = join(root, "src-tauri");
const binariesDir = join(srcTauri, "binaries");
const cacheDir = join(srcTauri, "target", "llama-cache");

const FORCE = process.argv.includes("--force");
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

// The llama-server sidecar is only bundled on Linux targets (see the
// externalBin entry in tauri.conf.json). Windows/macOS builds have nothing to
// stage — skip so CI/dev builds stay fast and don't download 100+ MB zips.
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

// ---- Extract ----
console.log(`→ extracting ${asset}…`);
mkdirSync(finalDir, { recursive: true });

const isZip = asset.endsWith(".zip");
if (isZip) {
  // Windows-only asset. Prefer `tar` (the Windows 10+ built-in libarchive
  // handles zip); fall back to `unzip` (Git-for-Windows / Unix) if absent.
  let r = spawnSync("tar", ["xf", tarball, "-C", cacheDir], { stdio: "inherit" });
  if (r.status !== 0) {
    r = spawnSync("unzip", ["-o", "-q", tarball, "-d", cacheDir], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`✗ extract failed (tar and unzip both failed)`);
      process.exit(1);
    }
  }
} else {
  const r = spawnSync("tar", ["xzf", tarball, "-C", cacheDir], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✗ tar extract failed`);
    process.exit(1);
  }
}

// Find the extracted top-level directory (usually `llama-<RELEASE>/`).
// The win-cpu/win-cuda zips are FLAT (no parent dir) — fall back to the
// cache dir itself in that case.
const topCandidates = readdirSync(cacheDir, { withFileTypes: true });
const extractedTop = topCandidates.find((d) => d.isDirectory() && d.name.startsWith("llama-"))?.name;
const extractedDir = extractedTop ? join(cacheDir, extractedTop) : cacheDir;

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

// ---- Stage the flat externalBin ----
// Tauri 2's externalBin needs the launcher as a SINGLE FILE at
// binaries/<name>-<target-triple>[.exe] — it does NOT support passing a
// directory. The .so files are picked up separately via bundle.resources.
//
// We rename the launcher in the staged dir (e.g. `llama-server` →
// `llama-server-x86_64-unknown-linux-gnu`) to match Tauri's externalBin
// naming convention, and the runtime resolver finds the sibling .so files
// in the SAME directory by setting current_dir = launcher_dir.
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
// (the actual bundled layout inside the installer will be
// `<exe_dir>/llama-server-<triple>` + bundled-resources for .so files).
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
