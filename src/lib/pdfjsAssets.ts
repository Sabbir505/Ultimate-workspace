// pdf.js runtime assets — the worker, and the WASM decoders it fetches.
//
// pdf.js decodes JBIG2 (scanned-document images), JPEG2000 and colour-managed
// images with WebAssembly modules it loads AT RUNTIME, by appending a literal
// filename to the `wasmUrl` directory handed to getDocument
// (`_filename = "jbig2.wasm"`). Left unset, that URL is null and the loader
// tries to resolve "nulljbig2_nowasm_fallback.js" — so every JBIG2 image in a
// scanned PDF fails with "JBig2 failed to initialize" and silently paints as
// an empty box.
//
// The decoders therefore cannot be a `?url` import: Vite would content-hash
// them (jbig2-<hash>.wasm) and every filename-based request would 404. They
// are copied verbatim into public/pdfjs-wasm by scripts/copy-pdfjs-wasm.mjs
// (run from postinstall + the dev/build scripts), which is the one addressing
// scheme that matches how pdf.js looks them up.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Worker script URL. Set `GlobalWorkerOptions.workerSrc` from this. */
export const PDFJS_WORKER_URL: string = workerUrl;

/**
 * Directory URL for pdf.js's WASM decoders — trailing slash required (pdf.js
 * throws "Invalid factory url" without it). `import.meta.env.BASE_URL` keeps
 * this correct if the app is ever served from a sub-path.
 */
export const PDFJS_WASM_URL: string = `${import.meta.env.BASE_URL}pdfjs-wasm/`;
