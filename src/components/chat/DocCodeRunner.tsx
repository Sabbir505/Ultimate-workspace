// In-app document generation runner: the Rust half of `generate_document`
// (language: "javascript") emits a `docgen://run` event; this component
// executes the model's program against the real `docx` (npm) and
// `PptxGenJS` bundles inside a sandboxed iframe and posts the produced file
// back through the `docgen_complete` IPC command. The iframe template and
// library loading live in `docRunnerFrame.ts`, shared with the plan-compiled
// `DocDesignRunner`.
import { useEffect, useRef } from "react";
import { docgenComplete } from "../../lib/ipc";
import { buildRunnerFrame, loadLibs } from "./docRunnerFrame";

interface RunPayload {
  requestId: string;
  format: string;
  filename: string;
  code: string;
}

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
          frame.srcdoc = buildRunnerFrame(libs, payload.requestId, payload.code);
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
