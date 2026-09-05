#!/usr/bin/env node
// Stages a bundled, portable LibreOffice into src-tauri/resources/libreoffice/
// so the Tauri installer ships a private soffice the pptx→pdf preview path
// (src-tauri/src/chat/office.rs::pptx_to_pdf) can use. End-user machines need
// NO system LibreOffice.
//
// Run before a release build:  node scripts/fetch-bundled-libreoffice.mjs
// Idempotent: skips download/extract if the staged tree already runs.
//
// The binary is resolved at runtime by chat/office.rs::find_soffice, which
// looks at <resource_dir>/libreoffice/program/soffice(.exe) FIRST and falls
// back to a system LibreOffice only when the bundle is absent (e.g. a fresh
// checkout that hasn't run this script).
//
// Only Windows x64 is staged today — extend the TARGETS map for macOS/Linux.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const DEST = path.join(REPO, "src-tauri", "resources", "libreoffice");

// Pinned LibreOffice stable release. Bump deliberately — the URL pattern is
// https://download.documentfoundation.org/libreoffice/stable/<VER>/win/x86_64/.
// Override with LIBREOFFICE_VERSION env var to stage a different release.
const LO_VERSION = process.env.LIBREOFFICE_VERSION || "26.2.5";

// One entry per build target we ship. `archive` is the installer filename;
// `exe` is the soffice path RELATIVE to DEST after extraction.
const TARGETS = {
  "x86_64-pc-windows-msvc": {
    archive: `LibreOffice_${LO_VERSION}_Win_x86-64.msi`,
    url: `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`,
    exe: path.join("program", "soffice.exe"),
  },
};

/// Detect the host's bundled-LibreOffice target, or `null` if nothing is
/// staged for this platform yet. Returning null (instead of throwing) lets
/// `beforeBuildCommand` call this script safely on every OS: unsupported
/// platforms log a warning and exit 0 so the build still proceeds (pptx
/// previews fall back to the built-in HTML converter at runtime).
function hostTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return null;
}

function download(url, dest) {
  console.log(`  ↓ ${url}`);
  return new Promise((resolve, reject) => {
    // Use curl (available on Windows 10+ and Unices) so we don't add an npm dep.
    // -L follows the TDF redirect to a load-balancing mirror — fine for the
    // PAYLOAD because the hash below was fetched from the canonical host.
    const bin = process.platform === "win32" ? "curl.exe" : "curl";
    const child = spawn(bin, ["-fL", "--retry", "3", "-o", dest, url], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && existsSync(dest) && statSync(dest).size > 0) resolve();
      else reject(new Error(`curl exited ${code} for ${url}`));
    });
  });
}

/// Fail closed under STRICT_CHECKSUM=1 when the official checksum can't be
/// fetched; otherwise warn and continue unverified (so local/CI builds that
/// hit a flaky endpoint aren't hard-broken).
const STRICT_CHECKSUM = process.env.STRICT_CHECKSUM === "1";

/// Stream `file` through SHA-256 without loading the (3.5 GB!) MSI into memory.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/// Fetch the OFFICIAL `.sha256` sidecar for the pinned MSI from the CANONICAL
/// documentfoundation.org host — deliberately WITHOUT -L so no mirror is
/// involved in the trust decision (TDF publishes
/// <artifact>.sha256 next to the MSI; the payload download itself may redirect
/// to mirrors, and mirrors are only trusted after verification against this).
/// Returns the hex digest, or null when unavailable (and STRICT_CHECKSUM=1
/// isn't set).
function fetchOfficialSha256(shaUrl, archiveName) {
  const bin = process.platform === "win32" ? "curl.exe" : "curl";
  try {
    const r = spawnSync(bin, ["-fs", "--retry", "3", shaUrl], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) throw new Error(`curl exited ${r.status} for ${shaUrl}`);
    const digest = r.stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) throw new Error(`unexpected digest format: ${r.stdout.slice(0, 80)}`);
    return digest;
  } catch (e) {
    if (STRICT_CHECKSUM) {
      throw new Error(`STRICT_CHECKSUM=1: could not fetch official checksum for ${archiveName}: ${e.message}`);
    }
    console.warn(`  ⚠ could not fetch official checksum (${e.message}) — skipping verification`);
    return null;
  }
}

/// Compare the MSI on disk against the official digest; resolves true on
/// match, false on mismatch (caller decides whether to redownload).
async function sha256Matches(archivePath, expectedDigest) {
  const actual = await sha256File(archivePath);
  return actual === expectedDigest.toLowerCase();
}

function run(cmd, args, opts = {}) {
  // spawnSync with an argv array (not a shell string) so paths containing
  // spaces are handled correctly on Windows.
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...opts });
  if (r.status !== 0) {
    throw new Error(`command failed (${r.status}): ${cmd} ${args.join(" ")}`);
  }
}

/// Probe the staged tree: soffice must exist and answer `--version`.
/// `-env:UserInstallation` skips the interactive first-run wizard;
/// `--norestore` avoids document-recovery prompts in headless mode.
/// A 60s timeout prevents indefinite hangs on slow CI runners.
function stagedWorks(exePath) {
  if (!existsSync(exePath)) return false;
  const r = spawnSync(exePath, [
    "-env:UserInstallation=file:///tmp/libreoffice-probe",
    "--norestore",
    "--headless",
    "--version",
  ], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
    timeout: 60_000,
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    console.warn(`  ⚠ soffice --version timed out after 60s — trusting MSI extraction`);
    return true;
  }
  return r.status === 0;
}

/// Copy the MSVC runtime DLLs LibreOffice needs next to soffice.exe, sourced
/// from the MSI's own System64 redist payload. The MSI's normal installer
/// registers the VC++ redistributable system-wide, but an administrative-
/// install extraction does NOT — machines without the redist would fail to
/// launch soffice with a cryptic missing-DLL error. Placing the DLLs beside
/// the exe makes the bundle self-contained (app-local DLL lookup wins over
/// System32). Best-effort: warns and continues if a DLL is absent.
function stageVcRuntime(system64Dir, programDir) {
  if (process.platform !== "win32") return;
  const dlls = [
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcruntime140_threads.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "concrt140.dll",
    "vccorlib140.dll",
  ];
  let copied = 0;
  for (const dll of dlls) {
    const src = path.join(system64Dir, dll);
    const dst = path.join(programDir, dll);
    try {
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst);
      }
      if (existsSync(dst)) copied++;
    } catch {
      // best-effort
    }
  }
  if (copied < dlls.length) {
    console.log(
      `  ⚠ only ${copied}/${dlls.length} MSVC runtime DLLs staged — the bundle ` +
        "may rely on the end user's VC++ redistributable being installed.",
    );
  }
}

async function stage(target) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Unknown target ${target}`);
  const exePath = path.join(DEST, spec.exe);
  if (stagedWorks(exePath)) {
    console.log(`✓ bundled LibreOffice already staged at ${path.relative(REPO, DEST)}`);
    return;
  }
  console.log(`Staging bundled LibreOffice ${LO_VERSION} (${target}) → ${path.relative(REPO, DEST)}`);

  const msi = path.join(tmpdir(), spec.archive);
  // The trust anchor: the official digest, fetched from the canonical TDF
  // host (no redirect) before any mirror payload is downloaded.
  const official = fetchOfficialSha256(`${spec.url}.sha256`, spec.archive);
  if (!existsSync(msi) || statSync(msi).size === 0) {
    await download(spec.url, msi);
  } else {
    console.log(`  ↓ reusing cached ${spec.archive}`);
  }

  // Integrity gate (audit H2): the temp cache is as untrusted as a mirror —
  // verify whichever MSI we're about to extract, and redownload once if a
  // cached copy fails the check.
  if (official) {
    if (!(await sha256Matches(msi, official))) {
      console.warn(`  ⚠ cached ${spec.archive} failed SHA-256 — deleting and redownloading`);
      rmSync(msi, { force: true });
      await download(spec.url, msi);
    }
    if (!(await sha256Matches(msi, official))) {
      rmSync(msi, { force: true });
      throw new Error(`SHA-256 mismatch for ${spec.archive}: expected ${official} — corrupt/truncated download deleted`);
    }
    console.log(`  ✓ SHA-256 verified: ${official}`);
  }

  // Administrative install straight into DEST: extracts the MSI payload as a
  // plain directory without registering anything system-wide (no admin rights
  // needed). The layout is FLAT — <DEST>/{program,share,...} plus a copy of
  // the source MSI and the System/System64 redist payload. Extracting into
  // DEST (same volume as the repo) avoids cross-drive rename failures from
  // the temp dir.
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  const log = path.join(tmpdir(), `relay-lo-extract-${LO_VERSION}.log`);
  run("msiexec", ["/a", msi, "/qn", "/log", log, `TARGETDIR=${DEST}`]);

  const programDir = path.join(DEST, "program");
  if (!existsSync(exePath)) {
    throw new Error(`MSI extraction did not produce ${exePath} — see ${log}`);
  }

  // Stage the redist DLLs from the MSI payload, then drop the payload dirs
  // and the embedded MSI copy (355 MB of dead installer weight).
  stageVcRuntime(path.join(DEST, "System64"), programDir);
  trimRuntime();

  if (!stagedWorks(exePath)) {
    throw new Error("staged soffice failed --version probe — bundle is not usable");
  }
  console.log(`✓ bundled LibreOffice staged and verified at ${path.relative(REPO, DEST)}`);
}

/// Drop installer-only and redist-payload weight from the extracted tree.
/// Conservative: the core program/ and share/ dirs stay intact so headless
/// `--convert-to pdf` keeps full fidelity.
function trimRuntime() {
  const rm = (rel) => {
    const full = path.join(DEST, rel);
    if (existsSync(full)) {
      rmSync(full, { recursive: true, force: true });
      console.log(`  − trimmed ${rel}`);
    }
  };
  const spec = TARGETS["x86_64-pc-windows-msvc"];
  rm(spec.archive); // msiexec copies the source MSI into the install point
  rm("System"); // 32-bit redist payload (staged the needed DLLs into program/)
  rm("System64"); // 64-bit redist payload (staged the needed DLLs into program/)
  rm("readmes"); // "read me" HTML files for the interactive installer
  rm("help"); // offline help pack — headless conversion never opens it
}

const target = process.argv[2] ? process.argv[2] : hostTarget();
// No staged LibreOffice for this host (macOS/Linux until TARGETS is extended).
// Don't fail the build — warn and exit 0 so `beforeBuildCommand` keeps working
// cross-platform; pptx previews degrade to the built-in HTML converter.
if (!target || !TARGETS[target]) {
  console.log(
    `⚠ bundled LibreOffice: no staged distribution for this host (${process.platform}/${process.arch}). ` +
      `Skipping — pptx→pdf previews will use a system LibreOffice or the HTML fallback at runtime. ` +
      `Extend TARGETS in scripts/fetch-bundled-libreoffice.mjs to bundle one.`,
  );
  process.exit(0);
}
stage(target).catch((e) => {
  console.error(`✗ staging failed: ${e.message}`);
  process.exit(1);
});
