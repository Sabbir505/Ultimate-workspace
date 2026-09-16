// Dev-only visual harness: renders EVERY attachment variant exactly as it
// appears (1) on user messages — via the real parseAttachments +
// MessageAttachments/MessageConnectors components — and (2) in the Artifacts
// gallery — via the real ArtifactLibrary modal, fed by the Tauri IPC stub
// (tauriStub.ts). Serve `npx vite`, open
// http://localhost:1500/attachments-harness.html and flip the scenes with the
// floating switcher; the palette toggle previews both themes.
import "./tauriStub";
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
} from "docx";
import {
  MessageAttachments,
  MessageConnectors,
  parseAttachments,
  type ParsedAttachment,
} from "../components/chat/MessageAttachments";
import { Markdown } from "../components/chat/ActivitySteps";
import { ArtifactLibrary } from "../components/sidebar/ArtifactLibrary";
import { ArtifactPreviewPane } from "../components/chat/ArtifactPreviewPane";
import { stubState } from "./tauriStub";
import type { ChatAttachmentInput } from "../lib/ipc";

// ---- fake screenshot for the optimistic-image thumbnail (a real data URI so
// the card renders the same <img> path the app uses) ----
function makeScreenshotDataUri(): { dataUri: string; data: string; mediaType: string } {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 264;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 480, 264);
  grad.addColorStop(0, "#22303c");
  grad.addColorStop(1, "#101820");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 480, 264);
  ctx.fillStyle = "#88c0d0";
  ctx.font = "600 22px sans-serif";
  ctx.fillText("TypeError: undefined is not", 28, 90);
  ctx.fillText("a function at retry (l.42)", 28, 124);
  ctx.fillStyle = "#a0a0a0";
  ctx.font = "14px monospace";
  ctx.fillText("at retries.forEach (worker.js:42)", 28, 180);
  ctx.strokeStyle = "#3a3a3a";
  ctx.strokeRect(0.5, 0.5, 479, 263);
  const dataUri = canvas.toDataURL("image/png");
  return { dataUri, data: dataUri.slice(dataUri.indexOf(",") + 1), mediaType: "image/png" };
}

// A user-message row exactly as MessageBubble renders it: attachment cards
// above the bubble, connectors inline at the end of the text.
function UserMessage({
  content,
  liveAttachments,
  note,
}: {
  content: string;
  liveAttachments?: ChatAttachmentInput[];
  note?: string;
}) {
  const { attachments, connectors, text } = useMemo(
    () => parseAttachments(content, liveAttachments),
    [content, liveAttachments],
  );
  return (
    <div className="chat-bubble user">
      <MessageAttachments attachments={attachments} />
      <div className="chat-bubble-inner" dir="auto">
        <div className="msg-user-line">
          {text.trim().length > 0 && <Markdown content={text} />}
          <MessageConnectors connectors={connectors} />
        </div>
      </div>
      {note && <div className="harness-note">{note}</div>}
    </div>
  );
}

/** Force every variant through ONE parse so a parsing regression shows up
 *  here too. `live` maps ParsedAttachments by name onto ChatAttachmentInput. */
function parseAll(
  content: string,
  live?: ChatAttachmentInput[],
): { attachments: ParsedAttachment[]; connectors: string[]; text: string } {
  return parseAttachments(content, live);
}

const MSG_IMAGE_LIVE =
  "Hey, can you read the error text in this screenshot?\n\n[Attached image: Screenshot 2026-09-16 at 10.14.33.png]";
const MSG_IMAGE_PERSISTED =
  "What does this flow chart say about the retry path?\n\n[Attached image: retry-flow.png]";
const MSG_PDF = [
  "Summarize the key numbers for me.",
  "",
  "Attached file: quarterly-report.pdf",
  "```",
  "Q2 2026 Financial Summary",
  "",
  "Revenue grew 23% year over year to $14.2M, driven primarily by",
  "expansion in the platform tier. Gross margin held at 71% despite",
  "increased inference costs. Net burn decreased to $0.9M / month.",
  "Headcount finished the quarter at 63, up 8 from Q1.",
  "```",
].join("\n");
const MSG_LOG = [
  "The deploy kept failing — here's the tail of the log.",
  "",
  "Attached file: parse_errors.log",
  "```",
  "2026-09-16T09:41:02Z WARN  grammar fallback for lang=zig",
  "2026-09-16T09:41:03Z ERROR token stream ended mid-string at 42:18",
  "2026-09-16T09:41:03Z ERROR token stream ended mid-string at 42:19",
  "2026-09-16T09:41:04Z FATAL giving up after 3 attempts",
  "```",
].join("\n");
const MSG_UNREADABLE =
  "I'm installing this tool the docs linked — is it safe?\n\n[Attached file setup.exe could not be read as text.]";
const MSG_PENDING = "Can you turn these notes into a checklist?\n\n[Attached file: sprint-notes.txt]";
const MSG_CONNECTORS = "Sync my open PRs and today's standup notes into this chat";
const MSG_CONNECTORS_CONTENT = MSG_CONNECTORS + "\n\n[Connected: GitHub, Notion]";
const MSG_MULTI = [
  "Here's everything from yesterday — the screenshot is the one that matters, the old chart is just context, and the PDF has the full breakdown.",
  "",
  "[Attached image: crash-on-open.png]",
  "",
  "[Attached image: old-usage-chart.png]",
  "",
  "Attached file: breakdown.pdf",
  "```",
  "Breakdown of yesterday's incident, page 1 of 12. Timeline begins at",
  "02:14 UTC with the first failed health probe on eu-west-1.",
  "```",
].join("\n");
const MSG_LONG_NAME =
  "Can you port this one?\n\n[Attached file: a-very-long-descriptive-component-file-name-with-no-spaces-final-v2.tsx]";

function MessagesScene() {
  const shot = useMemo(makeScreenshotDataUri, []);
  const liveShot: ChatAttachmentInput[] = useMemo(
    () => [{ name: "Screenshot 2026-09-16 at 10.14.33.png", kind: "image", data: shot.data, mediaType: shot.mediaType }],
    [shot],
  );
  return (
    <div className="chat-grid-wrap" style={{ height: "100vh" }}>
      <div className="chat-view" style={{ height: "100vh" }}>
        <div className="chat-messages">
          <UserMessage
            content={MSG_IMAGE_LIVE}
            liveAttachments={liveShot}
            note="variant 1 — image just sent (live base64 thumbnail)"
          />
          <UserMessage
            content={MSG_IMAGE_PERSISTED}
            note="variant 2 — image from history (no stored thumbnail → glyph tile)"
          />
          <UserMessage content={MSG_PDF} note="variant 3 — document with extracted text preview (PDF)" />
          <UserMessage content={MSG_LOG} note="variant 4 — text file with preview" />
          <UserMessage content={MSG_UNREADABLE} note="variant 5 — unreadable binary" />
          <UserMessage content={MSG_PENDING} note="variant 6 — optimistic pre-persist marker" />
          <UserMessage content={MSG_CONNECTORS_CONTENT} note="variant 7 — connector chips" />
          <UserMessage content={MSG_MULTI} note="variant 8 — mixed multi-attachment wrap" />
          <UserMessage content={MSG_LONG_NAME} note="variant 9 — unbroken long filename" />
          <div style={{ height: 40, flexShrink: 0 }} />
        </div>
      </div>
    </div>
  );
}

function GalleryScene() {
  return (
    <div style={{ height: "100vh", background: "var(--bg-tint)" }}>
      <ArtifactLibrary externalOpen onClose={() => undefined} />
    </div>
  );
}

const PRICING_COLS = ["Model", "In / 1M", "Out / 1M", "Cache / 1M", "Deal / Note", "Best on $10"];
const PRICING_ROWS: string[][] = [
  ["MiniMax 2.0 (FREE)", "$0.10", "$0.20", "$0.002", "Free, 100/day", "~13,000"],
  ["Grok 3 Mini (99% off)", "$0.435", "$0.87", "$0.0036", "~$50 effective", "~4,000"],
  ["DeepSeek V4.1 Flash", "$0.15", "$0.60", "$0.003", "Off-peak, 2x peak", "~22,000"],
  ["GLM-5.3 Flash", "$0.14", "$0.28", "$0.0028", "<$100 effective", "~13,900"],
  ["Kimi K3", "$3.00", "$15.00", "$0.30", "Most expensive on Go", "~140"],
];

// A REAL .docx built with the docx package — a styled heading + a wide,
// shaded pricing table like the generated research reports — so the
// doc-preview scene exercises the actual DocxViewer (docx-preview) path.
async function buildPricingDocx(): Promise<string> {
  const headerShade = { type: ShadingType.CLEAR, fill: "2563EB" };
  const cell = (text: string, header = false) =>
    new TableCell({
      width: { size: 100 / PRICING_COLS.length, type: WidthType.PERCENTAGE },
      shading: header ? headerShade : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: [
            new TextRun({ text, bold: header, color: header ? "FFFFFF" : undefined }),
          ],
        }),
      ],
    });
  const doc = new Document({
    styles: {
      default: {
        heading1: { run: { color: "2563EB", size: 32 }, paragraph: { spacing: { after: 120 } } },
      },
    },
    sections: [
      {
        children: [
          new Paragraph({ text: "weekends fully off-peak.", spacing: { after: 60 } }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Go model table (44 models, incl. deals)" }),
          new Table({
            width: { size: 11250, type: WidthType.DXA },
            columnWidths: [2850, 1350, 1350, 1350, 2550, 1800],
            rows: [
              new TableRow({ tableHeader: true, children: PRICING_COLS.map((c) => cell(c, true)) }),
              ...PRICING_ROWS.map(
                (r) => new TableRow({ children: r.map((v) => cell(v)) }),
              ),
              new TableRow({
                children: [
                  cell("Sources"),
                  new TableCell({
                    columnSpan: 5,
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun(
                            "commandcode.ai/pricing, commandcode.ai/docs/resources/pricing-limits, commandcode.ai/docs/plans/go, commandcode.ai/models. Checked 2026-09-14.",
                          ),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, text: "Provider ranking (Nanjing / China)" }),
          new Table({
            width: { size: 11250, type: WidthType.DXA },
            columnWidths: [4650, 6600],
            rows: [
              new TableRow({ tableHeader: true, children: [cell("Model", true), cell("Verdict", true)] }),
              ...PRICING_ROWS.slice(0, 4).map(
                (r) =>
                  new TableRow({
                    children: [cell(r[0]), cell(`${r[4]}. Run off-peak for 2x value.`)],
                  }),
              ),
            ],
          }),
        ],
      },
    ],
  });
  const b64 = await Packer.toBase64String(doc);
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${b64}`;
}

function DocPreviewScene() {
  const [paneWidth, setPaneWidth] = useState(560);
  const [doc, setDoc] = useState<"docx" | "xlsx" | "pdf">("docx");
  // Build the real .docx BEFORE the pane's first read — ArtifactPreviewPane
  // loads the preview once per path, so a late dataUri would be missed.
  const [docxReady, setDocxReady] = useState(!!stubState.docxDataUri);
  useMemo(() => {
    if (!docxReady) {
      void buildPricingDocx().then((uri) => {
        stubState.docxDataUri = uri;
        setDocxReady(true);
      });
    }
  }, [docxReady]);
  const artifact = useMemo(
    () => ({
      path:
        doc === "docx"
          ? "C:/artifacts/pricing.docx"
          : doc === "xlsx"
            ? "C:/artifacts/pricing.xlsx"
            : "C:/artifacts/pricing.pdf",
      filename:
        doc === "docx" ? "pricing.docx" : doc === "xlsx" ? "pricing.xlsx" : "pricing.pdf",
    }),
    [doc],
  );
  return (
    <div style={{ height: "100vh", display: "flex", background: "var(--bg-tint)" }}>
      <div style={{ width: paneWidth, flex: "none", display: "flex", flexDirection: "column" }}>
        {docxReady ? (
          <ArtifactPreviewPane artifact={artifact} onClose={() => undefined} />
        ) : (
          <div className="artifact-preview-loading">building docx…</div>
        )}
      </div>
      <div
        style={{
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 12,
          color: "var(--text-dim)",
        }}
      >
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>pane width</div>
        {[420, 560, 760].map((w) => (
          <button key={w} onClick={() => setPaneWidth(w)} style={{ width: 90 }}>
            {w}px
          </button>
        ))}
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, marginTop: 10 }}>document</div>
        <button onClick={() => setDoc("docx")} style={{ width: 90 }}>
          docx
        </button>
        <button onClick={() => setDoc("xlsx")} style={{ width: 90 }}>
          xlsx
        </button>
        <button onClick={() => setDoc("pdf")} style={{ width: 90 }}>
          pdf
        </button>
      </div>
    </div>
  );
}

function Harness() {
  const [scene, setScene] = useState<"messages" | "gallery" | "doc">("messages");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const pill = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: 11.5,
        borderRadius: 99,
        border: "1px solid " + (active ? "var(--border-strong)" : "transparent"),
        background: active ? "var(--surface-glass-2)" : "transparent",
        color: active ? "var(--text)" : "var(--text-dim)",
        cursor: "pointer",
        boxShadow: "none",
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      {/* Harness-only chrome (not app CSS) */}
      <div
        style={{
          position: "fixed",
          top: 10,
          right: 12,
          zIndex: 999,
          display: "flex",
          gap: 4,
          padding: 4,
          borderRadius: 12,
          background: "var(--surface-glass)",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--glass-drop)",
        }}
      >
        {pill("User messages", scene === "messages", () => setScene("messages"))}
        {pill("Artifact gallery", scene === "gallery", () => setScene("gallery"))}
        {pill("Doc preview", scene === "doc", () => setScene("doc"))}
        <span style={{ width: 1, background: "var(--border)", margin: "2px 3px" }} />
        {pill(theme === "dark" ? "Dark" : "Light", true, () =>
          setTheme(theme === "dark" ? "light" : "dark"),
        )}
      </div>
      {scene === "messages" ? <MessagesScene /> : scene === "gallery" ? <GalleryScene /> : <DocPreviewScene />}
      <style>{`
        .harness-note {
          margin: 2px 4px 0 0;
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-dim);
          opacity: 0.65;
          text-align: right;
          user-select: none;
        }
      `}</style>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

// parseAll is kept referenced so the "all variants through one parse" claim
// stays testable from the console during review.
void parseAll;
