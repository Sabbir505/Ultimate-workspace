#!/usr/bin/env node
// Copies pdf.js's WASM decoders into public/ so they are served under their
// ORIGINAL filenames.
//
// Why this can't just be a `?url` import: pdf.js fetches its decoders by
// APPENDING A LITERAL FILENAME to the `wasmUrl` directory you hand
// getDocument — `_filename = "jbig2.wasm"`. Vite emits `?url` imports of
// node_modules files with a content hash (`jbig2-<hash>.wasm`) into
// assets/, so every one of those requests would 404 and every JBIG2 image in
// a scanned PDF would silently paint as an empty box. Files under public/
// are copied verbatim, which is exactly the addressing pdf.js needs.
//
// Runs from `postinstall` and from the dev/build scripts, so a fresh clone
// and a fresh `npm install` both end up with the assets in place.
//
// Usage: node scripts/copy-pdfjs-wasm.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist", "wasm");
const dest = join(root, "public", "pdfjs-wasm");

if (!existsSync(src)) {
  // Not fatal: pdf.js only needs these for JBIG2/JPEG2000/QCMS images, and a
  // missing folder degrades to blank image boxes, not a crash. The asset
  // module in src/lib/pdfjsAssets.ts handles the empty case.
  console.warn("[pdfjs-wasm] node_modules/pdfjs-dist/wasm not found — skipped.");
  process.exit(0);
}

// Skip the copy when public/ already matches the INSTALLED pdf.js version, so
// a normal build doesn't rewrite the tree (rewriting it would churn file
// mtimes and nudge the dev server's watcher). Keying on the version rather
// than mtimes also means a `npm i` that bumps pdfjs re-copies automatically.
const { version } = JSON.parse(
  readFileSync(join(root, "node_modules", "pdfjs-dist", "package.json"), "utf8"),
);
const stamp = join(dest, ".version");
try {
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
    process.exit(0);
  }
} catch {
  // no stamp / unreadable — fall through to the copy
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

const copied = readdirSync(dest);
if (!copied.includes("jbig2.wasm")) {
  console.error("[pdfjs-wasm] copy finished but jbig2.wasm is missing — unexpected pdfjs layout.");
  process.exit(1);
}
writeFileSync(stamp, `${version}\n`);
console.log(`[pdfjs-wasm] copied ${copied.length} files (pdfjs ${version}) -> public/pdfjs-wasm/`);
