// In-app document generation runner: the Rust half of `generate_document`
// (language: "javascript") emits a `docgen://run` event; this component
// executes the model's program against the real `docx` (npm) and
// `PptxGenJS` bundles inside a sandboxed iframe and posts the produced file
// back through the `docgen_complete` IPC command.
//
// The iframe is sandboxed to "allow-scripts" only (opaque origin — no DOM,
// cookie, storage, or Tauri access); the libraries are inlined from the
// node_modules bundles so generation is fully offline. The script's contract
// is `await conduit.save(blob | bytes | dataUrl)` — exactly one delivery.
import { useEffect, useRef } from "react";
import { docgenComplete } from "../../lib/ipc";

// Raw UMD/browser bundles, imported by relative path (the packages' exports
// maps only expose their ESM entry, which can't run inside a plain script
// tag). Loaded lazily on first run; cached at module scope afterwards.
type RawSource = { default: string };
let docxSource: string | null = null;
let pptxSource: string | null = null;
async function loadLibs(format: string): Promise<string> {
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

interface RunPayload {
  requestId: string;
  format: string;
  filename: string;
  code: string;
}

/** Neutralize `</script>` sequences inside inlined source so the iframe HTML
 *  can't be broken out of (inside JS strings/regexes `<\/script` is equal). */
function scriptSafe(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

const RUNNER_TEMPLATE = (libs: string, requestId: string, userCode: string) => `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script>${scriptSafe(libs)}</script>
<script>
"use strict";
(function () {
  var REQUEST_ID = ${JSON.stringify(requestId)};
  var settled = false;
  function toBase64(data) {
    if (data == null) return Promise.reject(new Error("conduit.save received nothing"));
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
    if (!bytes) return Promise.reject(new Error("conduit.save got an unsupported type: " + typeof data));
    var binary = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return Promise.resolve(btoa(binary));
  }
  window.conduit = {
    save: function (data) {
      return toBase64(data).then(function (b64) {
        if (settled) throw new Error("conduit.save called more than once");
        settled = true;
        parent.postMessage({ source: "conduit-docgen", requestId: REQUEST_ID, ok: true, base64: b64 }, "*");
      });
    }
  };
  window.addEventListener("error", function (e) {
    if (!settled) {
      settled = true;
      parent.postMessage({ source: "conduit-docgen", requestId: REQUEST_ID, ok: false,
        error: String((e && e.error && e.error.stack) || e.message || "script error") }, "*");
    }
  });
  try {
    Promise.resolve((async function () {
      ${userCode}
    })()).catch(function (err) {
      if (!settled) {
        settled = true;
        parent.postMessage({ source: "conduit-docgen", requestId: REQUEST_ID, ok: false,
          error: String((err && err.stack) || err) }, "*");
      }
    });
  } catch (err) {
    if (!settled) {
      settled = true;
      parent.postMessage({ source: "conduit-docgen", requestId: REQUEST_ID, ok: false,
        error: String((err && err.stack) || err) }, "*");
    }
  }
})();
</script>
</body></html>`;

const RUN_TIMEOUT_MS = 90_000;

export function DocCodeRunner() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const activeRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const messageHandler = (event: MessageEvent) => {
      const data = event.data as
        | { source?: string; requestId?: string; ok?: boolean; base64?: string; error?: string }
        | null;
      if (!data || data.source !== "conduit-docgen" || !data.requestId) return;
      if (data.requestId !== activeRef.current) return;
      activeRef.current = null;
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void docgenComplete({
        requestId: data.requestId,
        base64: data.ok ? data.base64 : undefined,
        error: data.ok ? undefined : data.error ?? "unknown document runner error",
      });
    };
    window.addEventListener("message", messageHandler);

    void (async () => {
      try {
        const listen = await import("../../lib/ipc").then((m) => m.safeListen<RunPayload>);
        const off = await listen("docgen://run", (payload) => {
          void handleRun(payload);
        });
        if (disposed) off();
        else unlisten = off;
      } catch (err) {
        console.warn("[DocCodeRunner] listener setup failed", err);
      }
    })();

    const handleRun = (payload: RunPayload) => {
      // One run at a time; a second overlapping run rejects the first's
      // waiter on the Rust side via timeout. (Generation is sequential per
      // turn in practice.)
      void (async () => {
        try {
          if (activeRef.current != null) {
            void docgenComplete({
              requestId: payload.requestId,
              error: "another document run was already in progress",
            });
            return;
          }
          activeRef.current = payload.requestId;
          const libs = await loadLibs(payload.format);
          if (activeRef.current !== payload.requestId) return;
          const frame = frameRef.current;
          if (!frame) throw new Error("runner frame unavailable");
          frame.srcdoc = RUNNER_TEMPLATE(libs, payload.requestId, payload.code);
          timerRef.current = window.setTimeout(() => {
            if (activeRef.current === payload.requestId) {
              activeRef.current = null;
              void docgenComplete({
                requestId: payload.requestId,
                error: `the document script did not call conduit.save within ${RUN_TIMEOUT_MS / 1000}s`,
              });
            }
          }, RUN_TIMEOUT_MS);
        } catch (err) {
          activeRef.current = null;
          void docgenComplete({
            requestId: payload.requestId,
            error: String(err),
          });
        }
      })();
    };

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("message", messageHandler);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Hidden, sandboxed execution frame.
  return (
    <iframe
      ref={frameRef}
      title="Conduit document runner"
      sandbox="allow-scripts"
      style={{ display: "none" }}
    />
  );
}
