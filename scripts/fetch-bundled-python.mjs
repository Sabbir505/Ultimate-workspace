#!/usr/bin/env node
// Stages a bundled, relocatable Python (python-build-standalone) with the
// document-generation libraries (python-docx, python-pptx, openpyxl,
// reportlab) pre-installed into src-tauri/resources/python/ so the Tauri
// installer ships a private runtime. End-user machines need NO system Python.
//
// Run before a release build:  node scripts/fetch-bundled-python.mjs
// Idempotent: skips download/extract if the tree already resolves and imports.
//
// The runtime is resolved at runtime by src-tauri/src/chat/python_runtime.rs,
// which points pygen/codeexec at <resource_dir>/python first and falls back to
// a system Python only when the bundle is absent (e.g. `cargo run` from source).
//
// Only Windows x64 is staged today — extend the TARGETS map for macOS/Linux.

import { execSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const DEST = path.join(REPO, "src-tauri", "resources", "python");

// python-build-standalone release tag. Pinned for reproducibility — bump
// deliberately. See https://github.com/astral-sh/python-build-standalone/releases
// (formerly indygreg/python-build-standalone — the old URLs redirect).
const PBS_TAG = "20240726";
const PBS_PY = "3.12.4";

// The four libraries generate_document depends on. Kept in sync with the
// GENERATE_DOCUMENT_DESC tool description in src-tauri/src/chat/tools.rs and
// the test fixtures in src-tauri/src/chat/pygen.rs.
//
// Pinned to exact versions for supply-chain reproducibility (audit H2) — an
// unpinned `pip install` re-resolves whatever is latest at build time, so two
// release builds can ship different library code. Bump deliberately.
// NOTE (follow-up): `pip --require-hashes` is deliberately NOT enabled yet —
// hashing wheels here is a bigger follow-up (needs per-platform wheel
// digests); exact pins already pin the version, which is the main win.
const LIBS = [
  "python-docx==1.2.0",
  "python-pptx==1.0.2",
  "openpyxl==3.1.5",
  // Held on the 4.x line: the staged tree + generate_document fixtures were
  // built and verified against reportlab 4.x. Re-validate before jumping to 5.x.
  "reportlab==4.5.1",
];

// One entry per build target we ship. `archive` is the python-build-standalone
// tarball filename; `exe`/`pip` are the interpreter path RELATIVE to DEST after
// extraction. The tarball's leading `python/` dir is stripped with
// --strip-components=1; Windows lands at <DEST>/python.exe, Linux at
// <DEST>/bin/python3. python_runtime.rs looks for the right path per OS.
const TARGETS = {
  "x86_64-pc-windows-msvc": {
    archive: `cpython-${PBS_PY}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
    exe: "python.exe",
    pip: "python.exe",
  },
  "x86_64-unknown-linux-gnu": {
    archive: `cpython-${PBS_PY}+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    exe: "bin/python3",
    pip: "bin/python3",
  },
  "aarch64-unknown-linux-gnu": {
    archive: `cpython-${PBS_PY}+${PBS_TAG}-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    exe: "bin/python3",
    pip: "bin/python3",
  },
};

/// Detect the host's bundled-Python target, or `null` if no build-standalone
/// distribution is staged for this platform yet. Returning null (instead of
/// throwing) lets `beforeBuildCommand` call this script safely on every OS:
/// on an unsupported platform it logs a warning and exits 0 so the Tauri
/// build still proceeds (document generation falls back to a system Python at
/// runtime). Extend TARGETS to add macOS/Linux.
function hostTarget() {
  const platform = process.platform; // win32 | darwin | linux
  const arch = process.arch; // x64 | arm64
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  return null;
}

function download(url, dest) {
  console.log(`  ↓ ${url}`);
  return new Promise((resolve, reject) => {
    // Use curl (available on Windows 10+ and Unices) so we don't add an npm dep.
    const bin = process.platform === "win32" ? "curl.exe" : "curl";
    const child = spawnCurl(bin, url, dest);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && existsSync(dest) && statSync(dest).size > 0) resolve();
      else reject(new Error(`curl exited ${code} for ${url}`));
    });
  });
}

function spawnCurl(bin, url, dest) {
  return spawn(bin, ["-fL", "--retry", "3", "-o", dest, url], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/// Fail closed under STRICT_CHECKSUM=1 when the official checksum can't be
/// fetched; otherwise warn and continue unverified (so local/CI builds that
/// hit a flaky endpoint aren't hard-broken).
const STRICT_CHECKSUM = process.env.STRICT_CHECKSUM === "1";

/// Stream `file` through SHA-256 (1MB+ chunks — never loads the archive into
/// memory). Resolves the hex digest.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/// Fetch a small text file with curl (no content-type assumptions) and return
/// its body as a string. Throws on non-zero exit / empty body.
function fetchText(url) {
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  const r = spawnSync(bin, ["-fsSL", "--retry", "3", url], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`curl exited ${r.status} for ${url}`);
  }
  return r.stdout;
}

/// Fetch the OFFICIAL SHA-256 for `archiveName` from the python-build-standalone
/// GitHub release (the primary trusted origin — same release as the tarball,
/// which itself redirects to a CDN). Each release publishes a per-asset
/// `<archive>.sha256` containing the bare hex digest. Returns null when the
/// checksum can't be fetched (and STRICT_CHECKSUM isn't set).
async function fetchOfficialSha256(archiveName) {
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${archiveName}.sha256`;
  try {
    const body = fetchText(url);
    const digest = body.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) throw new Error(`unexpected digest format: ${body.slice(0, 80)}`);
    return digest;
  } catch (e) {
    if (STRICT_CHECKSUM) {
      throw new Error(`STRICT_CHECKSUM=1: could not fetch official checksum for ${archiveName}: ${e.message}`);
    }
    console.warn(`  ⚠ could not fetch official checksum (${e.message}) — skipping verification`);
    return null;
  }
}

/// Compare the archive on disk against the official digest; on mismatch,
/// delete the archive so a corrupt copy is never extracted or reused.
async function verifySha256(archivePath, expectedDigest, label) {
  const actual = await sha256File(archivePath);
  if (actual !== expectedDigest.toLowerCase()) {
    rmSync(archivePath, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${label}: expected ${expectedDigest}, got ${actual} — corrupt/truncated download deleted`,
    );
  }
  console.log(`  ✓ SHA-256 verified: ${actual}`);
}

function run(cmd, args, opts = {}) {
  // spawnSync with an argv array (not a shell string) so paths/args containing
  // spaces ("D:\Projects\Main project\...") are handled correctly on Windows.
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...opts });
  if (r.status !== 0) {
    throw new Error(`command failed (${r.status}): ${cmd} ${args.join(" ")}`);
  }
}

// Verify the staged tree actually imports the four libs — the gate that makes
// this script idempotent and catches a half-extracted tree. Uses spawnSync
// with an argv array (not a shell string) so a DEST path containing spaces
// (e.g. "D:\Projects\Main project\...") is handled correctly on Windows.
function stagedWorks(exe, pipExe) {
  const probe = pipExe;
  const r = spawnSync(probe, ["-c", "import docx,pptx,openpyxl,reportlab"], {
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  return r.status === 0;
}

async function stage(target) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Unknown target ${target}`);
  const exePath = path.join(DEST, spec.exe);
  const pipPath = path.join(DEST, spec.pip);
  if (existsSync(exePath) && stagedWorks(exePath, pipPath)) {
    console.log(`✓ bundled Python already staged at ${path.relative(REPO, DEST)}`);
    return;
  }
  console.log(`Staging bundled Python (${target}) → ${path.relative(REPO, DEST)}`);
  mkdirSync(DEST, { recursive: true });

  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${spec.archive}`;
  const tgz = path.join(tmpdir(), spec.archive);
  await download(url, tgz);

  // Integrity gate (audit H2): verify the archive against the official
  // release checksum BEFORE it is extracted or pip-installed from.
  const official = await fetchOfficialSha256(spec.archive);
  if (official) await verifySha256(tgz, official, spec.archive);

  // Extract into DEST, stripping the tarball's leading `python/` dir so the
  // interpreter lands at <DEST>/python.exe (matching python_runtime.rs).
  // Forward slashes: bsdtar mangles backslash path arguments (the `-C` dir
  // "cannot be opened" otherwise), so normalize both paths on Windows.
  const tarBin = process.platform === "win32" ? "tar.exe" : "tar";
  // Forward slashes only — tar.exe on Windows mangles backslashes.
  // No --force-local or ./ prefix: the Windows built-in tar.exe doesn't
  // support the flag and doesn't misinterpret C:/... as a remote host.
  const toFwd = (p) => p.replaceAll("\\", "/");
  run(tarBin, [
    "-xzf",
    toFwd(tgz),
    "--strip-components=1",
    "-C",
    toFwd(DEST),
  ]);

  if (!existsSync(exePath)) {
    throw new Error(`extracted tree missing interpreter at ${spec.exe}`);
  }
  console.log(`  installing ${LIBS.length} libraries into bundled Python…`);
  // --no-warn-script-location: the Scripts dir isn't on PATH and we don't need
  // the entry-point exes; suppress the noise. --no-input: never block.
  run(pipPath, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-warn-script-location",
    "--no-input",
    ...LIBS,
  ]);

  if (!stagedWorks(exePath, pipPath)) {
    throw new Error("post-install import probe failed — bundled Python is not usable");
  }
  trimRuntime();
  // Re-verify after trimming: confirm nothing the four libs need was removed.
  if (!stagedWorks(exePath, pipPath)) {
    throw new Error("post-trim import probe failed — trim removed a needed module");
  }
  console.log(`✓ bundled Python staged and verified at ${path.relative(REPO, DEST)}`);
}

/// Remove install-time-only and unused weight from the staged tree so the
/// installer stays lean (~70 MB instead of ~120 MB). Conservative: only drops
/// things none of python-docx / python-pptx / openpyxl / reportlab need at
/// runtime. Re-verifies imports after trimming via the caller's stagedWorks.
function trimRuntime() {
  console.log("  trimming install-time/unused weight…");
  const rm = (p) => {
    const full = path.join(DEST, p);
    if (existsSync(full)) rmSync(full, { recursive: true, force: true });
  };
  // pip / setuptools / ensurepip / pkg_resources: install-time only.
  rm("Lib/site-packages/pip");
  rm("Lib/site-packages/setuptools");
  rm("Lib/site-packages/pkg_resources");
  rm("Lib/site-packages/pip-24.1.2.dist-info");
  rm("Lib/site-packages/setuptools-70.3.0.dist-info");
  rm("Lib/ensurepip");
  // Tk/Tcl + idlelib: no document lib uses the GUI toolkit.
  rm("tcl");
  rm("Lib/tkinter");
  rm("Lib/idlelib");
  // Bytecode caches: regenerated lazily at runtime if absent.
  for (const cache of findPycache(DEST)) rmSync(cache, { recursive: true, force: true });
  // Link-time-only static lib stubs.
  rm("libs");
}

/// Recursively collect every __pycache__ directory under `root`.
function findPycache(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readDirSyncAll(dir);
    } catch {
      continue;
    }
    for (const { name, isDir, full } of entries) {
      if (!isDir) continue;
      if (name === "__pycache__") out.push(full);
      else stack.push(full);
    }
  }
  return out;
}

function readDirSyncAll(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((e) => ({
    name: e.name,
    isDir: e.isDirectory(),
    full: path.join(dir, e.name),
  }));
}

const target = process.argv[2] ? process.argv[2] : hostTarget();
// No staged build-standalone for this host (e.g. macOS/Linux until TARGETS is
// extended). Don't fail the build — warn and exit 0 so `beforeBuildCommand`
// keeps working cross-platform; document generation degrades to system Python.
if (!target || !TARGETS[target]) {
  console.log(
    `⚠ bundled Python: no staged distribution for this host (${process.platform}/${process.arch}). ` +
      `Skipping — document generation will use a system Python at runtime. ` +
      `Extend TARGETS in scripts/fetch-bundled-python.mjs to bundle one.`,
  );
  process.exit(0);
}
stage(target).catch((e) => {
  console.error(`✗ staging failed: ${e.message}`);
  process.exit(1);
});
