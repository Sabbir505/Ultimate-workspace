// Dev-only Tauri IPC stub for browser harnesses (attachments-harness).
// Defines `window.__TAURI_INTERNALS__` so ipcCore's tauriAvailable() guard
// passes and safeInvoke routes here; the fake backend answers the handful of
// commands the harness needs and resolves everything else with null (the same
// benign value safeInvoke returns outside Tauri).
//
// MUST be imported before anything that pulls lib/ipc — side effects only.

interface StubArtifactRecord {
  id: string;
  chatSessionId: string | null;
  chatMessageId: number | null;
  filename: string;
  path: string;
  kind: string;
  createdAt: number;
  expiresAt: number;
}

const HOUR = 3_600_000;
const now = Date.now();

const stubArtifacts: StubArtifactRecord[] = [
  { id: "a1", chatSessionId: "s1", chatMessageId: 12, filename: "memory-system.md", path: "C:/artifacts/memory-system.md", kind: "md", createdAt: now - 2 * HOUR, expiresAt: now + 30 * 24 * HOUR },
  { id: "a2", chatSessionId: "s1", chatMessageId: 14, filename: "traffic-graph.svg", path: "C:/artifacts/traffic-graph.svg", kind: "svg", createdAt: now - 5 * HOUR, expiresAt: now + 30 * 24 * HOUR },
  { id: "a3", chatSessionId: "s2", chatMessageId: 3, filename: "quarterly-report.pdf", path: "C:/artifacts/quarterly-report.pdf", kind: "pdf", createdAt: now - 26 * HOUR, expiresAt: now + 30 * 24 * HOUR },
  { id: "a4", chatSessionId: "s2", chatMessageId: 4, filename: "metrics.csv", path: "C:/artifacts/metrics.csv", kind: "csv", createdAt: now - 30 * HOUR, expiresAt: now + 30 * 24 * HOUR },
  { id: "a5", chatSessionId: "s3", chatMessageId: 7, filename: "architecture-diagram.html", path: "C:/artifacts/architecture-diagram.html", kind: "html", createdAt: now - 3 * 24 * HOUR, expiresAt: now + 27 * 24 * HOUR },
  { id: "a6", chatSessionId: "s3", chatMessageId: 9, filename: "budget-2026.xlsx", path: "C:/artifacts/budget-2026.xlsx", kind: "xlsx", createdAt: now - 4 * 24 * HOUR, expiresAt: now + 26 * 24 * HOUR },
  { id: "a7", chatSessionId: "s3", chatMessageId: 11, filename: "launch-deck.pptx", path: "C:/artifacts/launch-deck.pptx", kind: "pptx", createdAt: now - 6 * 24 * HOUR, expiresAt: now + 24 * 24 * HOUR },
  { id: "a8", chatSessionId: "s4", chatMessageId: 2, filename: "api-notes.docx", path: "C:/artifacts/api-notes.docx", kind: "docx", createdAt: now - 8 * 24 * HOUR, expiresAt: now + 22 * 24 * HOUR },
  { id: "a9", chatSessionId: "s4", chatMessageId: 5, filename: "export-bundle.zip", path: "C:/artifacts/export-bundle.zip", kind: "zip", createdAt: now - 12 * 24 * HOUR, expiresAt: now + 18 * 24 * HOUR },
  { id: "a10", chatSessionId: "s4", chatMessageId: 6, filename: "a-really-long-descriptive-artifact-filename-final-v2.tsx", path: "C:/artifacts/long.tsx", kind: "tsx", createdAt: now - 15 * 24 * HOUR, expiresAt: now + 15 * 24 * HOUR },
];

// Per-path fake previews matching the backend's ArtifactPreview shape.
const stubPreviews: Record<string, unknown> = {
  "C:/artifacts/memory-system.md": {
    path: "C:/artifacts/memory-system.md", filename: "memory-system.md", ext: "md", kind: "markdown",
    text: "# Memory System\n\nThe memory subsystem keeps long-lived notes in SQLite:\n\n- recall() runs before every turn\n- save() fires on explicit requests\n- forget() deletes by tag or id\n\n## Architecture\n\nThe store lives behind `MemoryStore`, an interface with two\nimplementations: a local SQLite-backed one and a mesh-replicated one.\n\nEach note carries a tag list and an expiry; the sweeper removes\nexpired notes on startup.",
    speechText: null, dataUri: null, size: 1420, truncated: false,
  },
  "C:/artifacts/traffic-graph.svg": {
    path: "C:/artifacts/traffic-graph.svg", filename: "traffic-graph.svg", ext: "svg", kind: "diagram",
    text: "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>",
    speechText: null, dataUri: null, size: 8600, truncated: false,
  },
  "C:/artifacts/quarterly-report.pdf": {
    path: "C:/artifacts/quarterly-report.pdf", filename: "quarterly-report.pdf", ext: "pdf", kind: "pdf",
    text: null, speechText: "Q2 2026 Financial Summary. Revenue grew 23 percent year over year.",
    dataUri: null, size: 284_112, truncated: false,
  },
  "C:/artifacts/metrics.csv": {
    path: "C:/artifacts/metrics.csv", filename: "metrics.csv", ext: "csv", kind: "csv",
    text: "date,p95_ms,error_rate\n2026-09-14,182,0.4\n2026-09-15,177,0.2",
    speechText: null, dataUri: null, size: 312, truncated: false,
  },
  "C:/artifacts/architecture-diagram.html": {
    path: "C:/artifacts/architecture-diagram.html", filename: "architecture-diagram.html", ext: "html", kind: "diagram",
    text: "<div>diagram</div>", speechText: null, dataUri: null, size: 15_400, truncated: false,
  },
  "C:/artifacts/budget-2026.xlsx": {
    path: "C:/artifacts/budget-2026.xlsx", filename: "budget-2026.xlsx", ext: "xlsx", kind: "office",
    text: "<table><tr><th>Team</th><th>Budget</th></tr><tr><td>Platform</td><td>$1.2M</td></tr></table>",
    speechText: "Platform 1.2 million. Apps 0.8 million.", dataUri: null, size: 44_800, truncated: false,
  },
  "C:/artifacts/launch-deck.pptx": {
    path: "C:/artifacts/launch-deck.pptx", filename: "launch-deck.pptx", ext: "pptx", kind: "office",
    text: "<div>slide</div>", speechText: "Launch readiness review.", dataUri: null, size: 1_820_000, truncated: false,
  },
  "C:/artifacts/api-notes.docx": {
    path: "C:/artifacts/api-notes.docx", filename: "api-notes.docx", ext: "docx", kind: "office",
    text: "<p>API notes</p>", speechText: "API notes draft.", dataUri: null, size: 92_100, truncated: false,
  },
  "C:/artifacts/export-bundle.zip": {
    path: "C:/artifacts/export-bundle.zip", filename: "export-bundle.zip", ext: "zip", kind: "binary",
    text: null, speechText: null, dataUri: null, size: 9_140_000, truncated: false,
  },
  "C:/artifacts/long.tsx": {
    path: "C:/artifacts/long.tsx", filename: "a-really-long-descriptive-artifact-filename-final-v2.tsx", ext: "tsx", kind: "code",
    text: "export function App() {\n  return <h1>Hello</h1>;\n}",
    speechText: null, dataUri: null, size: 1_240, truncated: false,
  },
};

// Mutable harness state: the doc-preview scene generates a real .docx
// (docx npm package) and registers its data URI here before opening the pane.
export const stubState: { docxDataUri: string | null } = { docxDataUri: null };

// The xlsx "Formatted" fallback document — byte-for-byte the CSS the backend
// converter emits (office.rs doc_shell + sheet_css, appended into the same
// <style> block) over a deliberately wide pricing table, mirroring the report
// that exposed the left-clip bug.
const XLSX_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>\
*{margin:0;padding:0;box-sizing:border-box}\
html,body{background:#f1f5f9}\
body{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#1e293b;padding:28px}\
.sheet{margin:0 auto 34px;max-width:100%;overflow-x:auto}\
.sheet h2{font-size:13pt;font-weight:600;color:#334155;margin:0 0 10px}\
table{border-collapse:collapse;margin:0 auto;background:#fff;font-size:11pt;\
box-shadow:0 1px 4px rgba(15,23,42,.12)}\
th,td{border:1px solid #e2e8f0;padding:7px 12px;text-align:left;vertical-align:top}\
th{background:#2563eb;color:#fff;font-weight:600}\
tr:nth-child(even) td{background:#f8fafc}\
</style></head><body>\
<div class="sheet"><h2>Pricing</h2>\
<table><colgroup><col style="width:190px"/><col style="width:90px"/><col style="width:90px"/><col style="width:90px"/><col style="width:170px"/><col style="width:120px"/></colgroup>\
<tr><th>Model</th><th>In / 1M</th><th>Out / 1M</th><th>Cache / 1M</th><th>Deal / Note</th><th>Best on $10</th></tr>\
<tr><td>MiniMax 2.0 (FREE)</td><td>$0.10</td><td>$0.20</td><td>$0.002</td><td>Free, 100/day</td><td>~13,000</td></tr>\
<tr><td>Grok 3 Mini (99% off)</td><td>$0.435</td><td>$0.87</td><td>$0.0036</td><td>~$50 effective</td><td>~4,000</td></tr>\
<tr><td>DeepSeek V4.1 Flash</td><td>$0.15</td><td>$0.60</td><td>$0.003</td><td>Off-peak, 2x peak</td><td>~22,000</td></tr>\
<tr><td>GPT-5.6 Luna</td><td>$2.00</td><td>$8.00</td><td>$0.25</td><td>Geo-blocked</td><td>~200</td></tr>\
<tr><td>Sources</td><td colspan="5">commandcode.ai/pricing, commandcode.ai/docs/resources/pricing-limits, commandcode.ai/docs/plans/go, commandcode.ai/models. Checked 2026-09-14.</td></tr>\
</table></div></body></html>`;

const XLSX_DOCX_FALLBACK = XLSX_HTML;

// A minimal but valid single-page LANDSCAPE PDF (1600×900pt) with markers at
// both horizontal edges, so PDF-view zoom overflow (and its left-edge
// reachability) is visually obvious. Built with explicit xref offsets.
function buildWidePdf(): string {
  const text = (x: number, y: number, size: number, str: string) =>
    `BT /F1 ${size} Tf ${x} ${y} Td (${str.replace(/[\\()]/g, " ")}) Tj ET\n`;
  const content =
    "0.31 0.39 0.92 rg 0 0 1600 900 re f 0 g\n" +
    text(20, 820, 40, "LEFT EDGE MARKER") +
    text(20, 740, 56, "commandCode $1 Go Plan - models & usage") +
    text(20, 60, 32, "Sources: commandcode.ai/pricing, commandcode.ai/docs/resources/pricing-limits") +
    text(1240, 820, 40, "RIGHT EDGE MARKER") +
    text(200, 420, 72, "1  [Model]   In/1M   Out/1M   Cache/1M   Deal/Note") +
    text(200, 300, 72, "2  MiniMax    $0.10   $0.20    $0.002    Free, 100/day") +
    text(200, 180, 72, "3  DeepSeek   $0.15   $0.60    $0.003    Off-peak, 2x peak");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1600 900] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  const pdf = body + xref + trailer;
  // Encode every byte as a character so btoa sees a Latin-1 string.
  let binary = "";
  for (const ch of pdf) binary += String.fromCharCode(ch.charCodeAt(0));
  return `data:application/pdf;base64,${btoa(binary)}`;
}

export function installTauriStub(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return;
  const callbacks: Record<string, unknown> = {};
  let cbId = 0;
  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => {
      const id = `cb${cbId++}`;
      callbacks[id] = cb;
      return id;
    },
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "list_artifacts":
          return Promise.resolve([...stubArtifacts]);
        case "read_artifact_preview": {
          const path = String((args as { path?: string })?.path ?? "");
          if (path === "C:/artifacts/pricing.xlsx") {
            return Promise.resolve({
              path, filename: "pricing.xlsx", ext: "xlsx", kind: "office",
              text: XLSX_HTML, speechText: "Pricing sheet.", dataUri: null,
              size: 24_800, truncated: false,
            });
          }
          if (path === "C:/artifacts/pricing.docx") {
            return Promise.resolve({
              path, filename: "pricing.docx", ext: "docx", kind: "office",
              text: XLSX_DOCX_FALLBACK, speechText: "Pricing document.",
              dataUri: stubState.docxDataUri,
              size: 38_400, truncated: false,
            });
          }
          if (path === "C:/artifacts/pricing.pdf") {
            return Promise.resolve({
              path, filename: "pricing.pdf", ext: "pdf", kind: "pdf",
              text: null, speechText: "Pricing document.",
              dataUri: buildWidePdf(), size: 18_200, truncated: false,
            });
          }
          return Promise.resolve(stubPreviews[path] ?? null);
        }
        case "delete_artifact": {
          const id = String((args as { id?: string })?.id ?? "");
          const i = stubArtifacts.findIndex((a) => a.id === id);
          if (i >= 0) stubArtifacts.splice(i, 1);
          return Promise.resolve(null);
        }
        case "delete_all_artifacts":
          stubArtifacts.length = 0;
          return Promise.resolve(stubArtifacts.length);
        case "plugin:event|listen":
        case "plugin:event|unlisten":
          return Promise.resolve(0);
        default:
          console.debug(`[tauriStub] invoke("${cmd}") → null`);
          return Promise.resolve(null);
      }
    },
    metadata: { currentWindow: { label: "stub" }, currentWebview: { label: "stub" } },
  };
}

installTauriStub();
