// pdf.js asset wiring — the contract that decides whether scanned PDFs
// render at all.
//
// pdf.js fetches its decoders by APPENDING A LITERAL FILENAME to `wasmUrl`
// (`_filename = "jbig2.wasm"`), so two things must both hold: the URL ends in
// a slash (pdf.js throws "Invalid factory url" otherwise), and the file is
// reachable at exactly `wasmUrl + filename`. A `?url` import cannot satisfy
// the second — Vite content-hashes node_modules assets — which is why the
// decoders are copied verbatim into public/ instead.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PDFJS_WASM_URL, PDFJS_WORKER_URL } from "../lib/pdfjsAssets";

/** The exact filenames pdf.js's decoder classes ask for (pdf.worker source:
 *  `_filename` / `_noWasmFilename`). */
const PDFJS_FETCHES = [
  "jbig2.wasm",
  "jbig2_nowasm_fallback.js",
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm",
  "quickjs-eval.wasm",
  "quickjs-eval.js",
];

describe("pdfjs asset wiring", () => {
  it("hands pdf.js a directory URL with the trailing slash it requires", () => {
    // getFactoryUrlProp throws on a missing trailing slash.
    expect(PDFJS_WASM_URL.endsWith("/")).toBe(true);
  });

  it("points at the copied public/ folder, not at hashed assets", () => {
    expect(PDFJS_WASM_URL).toContain("pdfjs-wasm/");
    expect(PDFJS_WASM_URL).not.toMatch(/-[A-Za-z0-9_-]{8}\./);
  });

  it("has every file pdf.js will request, under its literal name", () => {
    const dir = resolve("public", "pdfjs-wasm");
    for (const name of PDFJS_FETCHES) {
      expect(
        existsSync(join(dir, name)),
        `missing ${name} — run: node scripts/copy-pdfjs-wasm.mjs`,
      ).toBe(true);
    }
  });

  it("serves a worker script URL", () => {
    expect(PDFJS_WORKER_URL).toBeTruthy();
  });
});
