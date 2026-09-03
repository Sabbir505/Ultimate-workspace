// Plan-compiled document runner: the Rust `plan_document` tool emits a
// `docdesign://compile` event with the model's structured plan; this
// component validates it (QA layer L1), compiles it deterministically against
// the design tokens and layout catalog, executes the generated program in the
// shared sandboxed frame, and posts the produced file back — together with
// the full QA issue list — through the `docdesign_complete` IPC command.
//
// The model never authors engine code on this path: compile errors and
// budget overflows surface as structured issues the model patches in the
// plan, not as runtime failures to debug.
import { useEffect, useRef } from "react";
import { docdesignComplete, docdesignQaComplete, officeAccuratePdf } from "../../lib/ipc";
import { compileDeck } from "../../lib/docdesign/compileDeck";
import { compileDoc } from "../../lib/docdesign/compileDoc";
import { compilePdfHtml, utf8ToBase64 } from "../../lib/docdesign/compilePdfHtml";
import { validateDeckPlan, type Issue } from "../../lib/docdesign/ir";
import { validateDocPlan } from "../../lib/docdesign/irDoc";
import { getTheme } from "../../lib/docdesign/tokens";
import { checkSystemFit, resolveTheme } from "../../lib/docdesign/systems";
import { dataUriToBytes, probePdf } from "../../lib/docdesign/rasterize";
import { buildRunnerFrame, loadLibs } from "./docRunnerFrame";

interface CompilePayload {
  requestId: string;
  format: string;
  filename: string;
  theme?: string;
  system?: string;
  plan: unknown;
}

interface QaPayload {
  requestId: string;
  path: string;
  format: string;
}

interface RunnerResult {
  ok: boolean;
  base64?: string;
  error?: string;
  payloadKind?: string;
}

/** The in-flight run: which request the next postMessage belongs to, plus the
 *  QA issues accumulated for it (L1 warnings + L2 results travel with the
 *  completion so the tool can narrate them). */
interface PendingRun {
  requestId: string;
  issues: Issue[];
  payloadKind?: string;
}

const RUN_TIMEOUT_MS = 90_000;

export function DocDesignRunner() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pendingRef = useRef<PendingRun | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const settle = (result: RunnerResult) => {
      const pending = pendingRef.current;
      if (!pending) return; // already settled (timeout) or foreign message
      pendingRef.current = null;
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void docdesignComplete({
        requestId: pending.requestId,
        base64: result.ok ? result.base64 : undefined,
        error: result.ok ? undefined : result.error ?? "unknown compiled-document error",
        issuesJson: pending.issues.length ? JSON.stringify(pending.issues) : undefined,
        payloadKind: result.ok ? pending.payloadKind : undefined,
      });
    };

    const fail = (error: string, issues: Issue[] = []) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void docdesignComplete({
        requestId: pending?.requestId ?? "",
        error,
        issuesJson: issues.length ? JSON.stringify(issues) : undefined,
      });
    };

    const messageHandler = (event: MessageEvent) => {
      const data = event.data as (RunnerResult & { source?: string; requestId?: string }) | null;
      if (!data || data.source !== "conduit-docgen") return;
      if (!pendingRef.current || data.requestId !== pendingRef.current.requestId) return;
      settle({ ok: data.ok, base64: data.base64, error: data.error });
    };
    window.addEventListener("message", messageHandler);

    void (async () => {
      try {
        const { safeListen } = await import("../../lib/ipc");
        const off = await safeListen<CompilePayload>("docdesign://compile", (payload) => {
          void handleCompile(payload);
        });
        // Render probes (L4): the host asks us to inspect the RENDERED
        // artifact after it is written to disk. Best-effort.
        const offQa = await safeListen<QaPayload>("docdesign://qa", (payload) => {
          void handleQa(payload);
        });
        if (disposed) {
          off();
          offQa();
        } else {
          unlisten = () => {
            off();
            offQa();
          };
        }
      } catch (err) {
        console.warn("[DocDesignRunner] listener setup failed", err);
      }
    })();

    const handleQa = (payload: QaPayload) => {
      void (async () => {
        try {
          // pdf artifacts: read the file's own bytes via the preview IPC.
          // Office artifacts: reuse the cached LibreOffice→PDF bridge so the
          // probe measures what the preview shows.
          const dataUri =
            payload.format === "pdf"
              ? (await import("../../lib/ipc").then((m) => m.readArtifactPreview(payload.path)))
                  ?.dataUri ?? null
              : await officeAccuratePdf(payload.path);
          if (!dataUri) {
            void docdesignQaComplete({
              requestId: payload.requestId,
              issuesJson: JSON.stringify([
                { rule: "probe/skipped", message: "rendered PDF unavailable for probes" },
              ]),
              pageCount: 0,
            });
            return;
          }
          const probe = await probePdf(dataUriToBytes(dataUri), payload.format === "pptx" ? "deck" : "doc");
          void docdesignQaComplete({
            requestId: payload.requestId,
            issuesJson: JSON.stringify(probe.issues),
            pageCount: probe.pageCount,
          });
        } catch (err) {
          void docdesignQaComplete({
            requestId: payload.requestId,
            issuesJson: JSON.stringify([
              { rule: "probe/skipped", message: `render probes failed: ${String(err)}` },
            ]),
            pageCount: 0,
          });
        }
      })();
    };

    const handleCompile = (payload: CompilePayload) => {
      void (async () => {
        try {
          if (pendingRef.current != null) {
            // One run at a time; the Rust waiter times out and retries.
            void docdesignComplete({
              requestId: payload.requestId,
              error: "another document run was already in progress",
            });
            return;
          }
          pendingRef.current = { requestId: payload.requestId, issues: [] };

          // L1: validate the plan against the catalog. Errors block the run
          // and go straight back to the model for an in-turn patch.
          const planKind =
            typeof payload.plan === "object" && payload.plan !== null
              ? (payload.plan as { kind?: string }).kind
              : undefined;
          let code: string;
          let htmlPayload: string | undefined;
          const issues: Issue[] = [];

          const theme = getTheme(resolveTheme(payload.theme, payload.system));

          if (payload.format === "pptx" || planKind === "deck") {
            const validated = validateDeckPlan(payload.plan);
            if (!validated.plan) {
              fail("plan validation failed — fix these issues and call plan_document again with the revised plan", validated.issues);
              return;
            }
            issues.push(...validated.issues, ...checkSystemFit(validated.plan.slides, payload.system));
            const compiled = compileDeck(validated.plan, theme);
            issues.push(...compiled.checks.issues);
            if (compiled.checks.issues.some((i) => i.severity === "error")) {
              fail("compiled program failed invariant checks", issues);
              return;
            }
            code = compiled.code;
          } else if (payload.format === "docx" || planKind === "doc") {
            const validated = validateDocPlan(payload.plan);
            if (!validated.plan) {
              fail("plan validation failed — fix these issues and call plan_document again with the revised plan", validated.issues);
              return;
            }
            issues.push(...validated.issues);
            const compiled = compileDoc(validated.plan, theme);
            issues.push(...compiled.checks.issues);
            if (compiled.checks.issues.some((i) => i.severity === "error")) {
              fail("compiled program failed invariant checks", issues);
              return;
            }
            code = compiled.code;
          } else if (payload.format === "pdf") {
            const validated = validateDocPlan(payload.plan);
            if (!validated.plan) {
              fail("plan validation failed — fix these issues and call plan_document again with the revised plan", validated.issues);
              return;
            }
            issues.push(...validated.issues);
            const compiled = compilePdfHtml(validated.plan, theme);
            issues.push(...compiled.checks.issues);
            if (compiled.checks.issues.some((i) => i.severity === "error")) {
              fail("compiled HTML failed invariant checks", issues);
              return;
            }
            // PDF plans deliver HTML, which Rust renders via the print engine.
            code = "";
            htmlPayload = compiled.html;
            pendingRef.current.payloadKind = "html";
          } else {
            fail(`unsupported format "${payload.format}" for the plan-compiled path`);
            return;
          }
          pendingRef.current.issues = issues;

          if (htmlPayload != null) {
            // No iframe needed: the payload is HTML text for the print engine.
            settle({ ok: true, base64: utf8ToBase64(htmlPayload) });
            return;
          }

          const libs = await loadLibs(payload.format);
          const frame = frameRef.current;
          if (!frame) throw new Error("runner frame unavailable");

          frame.srcdoc = buildRunnerFrame(libs, payload.requestId, code);
          timerRef.current = window.setTimeout(() => {
            settle({
              ok: false,
              error: `the compiled program did not call conduit.save within ${RUN_TIMEOUT_MS / 1000}s`,
            });
          }, RUN_TIMEOUT_MS);
        } catch (err) {
          fail(String(err));
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

  // Hidden, sandboxed execution frame (own iframe — never contends with the
  // legacy DocCodeRunner's active run).
  return (
    <iframe
      ref={frameRef}
      title="Relay plan-compiled document runner"
      sandbox="allow-scripts"
      style={{ display: "none" }}
    />
  );
}
