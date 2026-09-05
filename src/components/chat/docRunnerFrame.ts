// Shared sandboxed-runner frame for document generation. Both the legacy
// `DocCodeRunner` (model-authored code from `generate_document`) and the
// `DocDesignRunner` (plan-compiled programs from `plan_document`) execute JS
// through this template: the library bundle is inlined, the script's only
// contract is exactly one `await relay.save(...)`, and the result comes
// back to the parent as base64 via postMessage.
//
// The iframe is sandboxed to "allow-scripts" only (opaque origin — no DOM,
// cookie, storage, or Tauri access); libraries are inlined from the
// node_modules bundles so generation is fully offline.

/** Neutralize `</script>` sequences inside inlined source so the iframe HTML
 *  can't be broken out of (inside JS strings/regexes `<\/script` is equal). */
export function scriptSafe(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/** The complete iframe document for one run. */
export function buildRunnerFrame(libs: string, requestId: string, userCode: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>${scriptSafe(libs)}</script>
<script>
"use strict";
(function () {
  var REQUEST_ID = ${JSON.stringify(requestId)};
  var settled = false;
  function toBase64(data) {
    if (data == null) return Promise.reject(new Error("relay.save received nothing"));
    if (typeof data === "string") {
      // A data URL or a bare base64 string both pass through.
      var comma = data.indexOf(",");
      var prefix = data.slice(0, comma >= 0 && data.startsWith("data:") ? comma + 1 : 0);
      if (prefix) return Promise.resolve(data.slice(prefix.length));
      return Promise.resolve(data);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var result = String(reader.result || "");
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = function () { reject(new Error("could not read the generated blob")); };
        reader.readAsDataURL(data);
      });
    }
    var bytes = data instanceof Uint8Array ? data
      : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : (data instanceof ArrayBuffer ? new Uint8Array(data) : null));
    if (!bytes) return Promise.reject(new Error("relay.save got an unsupported type: " + typeof data));
    var binary = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return Promise.resolve(btoa(binary));
  }
  window.relay = {
    save: function (data) {
      return toBase64(data).then(function (b64) {
        if (settled) throw new Error("relay.save called more than once");
        settled = true;
        parent.postMessage({ source: "relay-docgen", requestId: REQUEST_ID, ok: true, base64: b64 }, "*");
      });
    }
  };
  window.addEventListener("error", function (e) {
    if (!settled) {
      settled = true;
      parent.postMessage({ source: "relay-docgen", requestId: REQUEST_ID, ok: false,
        error: String((e && e.error && e.error.stack) || e.message || "script error") }, "*");
    }
  });
  try {
    Promise.resolve((async function () {
      ${userCode}
    })()).catch(function (err) {
      if (!settled) {
        settled = true;
        parent.postMessage({ source: "relay-docgen", requestId: REQUEST_ID, ok: false,
          error: String((err && err.stack) || err) }, "*");
      }
    });
  } catch (err) {
    if (!settled) {
      settled = true;
      parent.postMessage({ source: "relay-docgen", requestId: REQUEST_ID, ok: false,
        error: String((err && err.stack) || err) }, "*");
    }
  }
})();
</script>
</body></html>`;
}

// Raw UMD/browser bundles, imported by relative path (the packages' exports
// maps only expose their ESM entry, which can't run inside a plain script
// tag). Loaded lazily on first run; cached at module scope afterwards.
type RawSource = { default: string };
let docxSource: string | null = null;
let pptxSource: string | null = null;

export async function loadLibs(format: string): Promise<string> {
  if (format === "pptx") {
    if (pptxSource == null) {
      pptxSource = ((await import("../../../node_modules/pptxgenjs/dist/pptxgen.min.js?raw")) as RawSource).default;
    }
    return pptxSource;
  }
  if (docxSource == null) {
    docxSource = ((await import("../../../node_modules/docx/dist/index.umd.cjs?raw")) as RawSource).default;
  }
  return docxSource;
}
