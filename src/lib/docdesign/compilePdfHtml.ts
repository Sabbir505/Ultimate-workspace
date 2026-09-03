// docdesign — deterministic PDF compiler: DocPlan + tokens → a complete,
// print-ready HTML document rendered by the app's Paged.js print engine.
//
// The Rust print host (pdfprint.rs) injects the token-generated BASE_CSS and
// Paged.js; because that sheet is spliced BEFORE ours, the theme CSS below
// wins the cascade wherever they overlap (matching how the legacy
// model-authored path works). Layout primitives: @page rules for margins and
// page numbers, `break-inside: avoid` on tables/callouts, a full-bleed dark
// cover via @page:first, and typographic hierarchy straight from the tokens.
import { facePrimary, tokens, type Theme } from "./tokens";
import type { DocPlan } from "./irDoc";
import type { Issue } from "./ir";

export interface CompileChecks {
  issues: Issue[];
  passed: string[];
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function compilePdfHtml(plan: DocPlan, theme: Theme, now: Date = new Date()): { html: string; checks: CompileChecks } {
  const doc = tokens.type.doc;
  const c = theme.color;
  const display = facePrimary("display");
  const body = facePrimary("body");
  const mono = facePrimary("mono");
  const [marginTB, marginLR] = tokens.space.pdfMarginMm;

  const css = `
    @page { @bottom-center { content: counter(page); font-family: ${body}; font-size: ${doc.captionPt}pt; color: #${c.muted}; } }
    @page:first { margin: 0; @bottom-center { content: none; } }
    body { font-family: ${body}; color: #${c.ink}; }
    h1, h2, h3 { font-family: ${display}; color: #${c.ink}; }
    code, pre { font-family: ${mono}; }
    a { color: #${c.accent}; }
    blockquote { border-left: 3px solid #${c.hair}; color: #${c.muted}; font-style: italic; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; break-inside: avoid; }
    th, td { border: 1px solid #${c.hair}; padding: 6px 10px; text-align: left; }
    th { background: #${c.tint}; color: #${c.ink}; }
    tr { break-inside: avoid; }
    .cover { page-break-after: always; width: 100%; height: 297mm; box-sizing: border-box;
             background: #${c.coverBg}; color: #${c.coverFg}; display: flex;
             flex-direction: column; justify-content: flex-end; padding: 18mm 16mm; }
    .cover .meta { font-size: ${doc.captionPt + 1}pt; color: #${c.coverAccent}; margin: 0 0 4mm; letter-spacing: 0.08em; text-transform: uppercase; }
    .cover h1 { font-size: ${doc.displayPt}pt; margin: 0 0 5mm; line-height: 1.15; }
    .cover .sub { font-size: ${doc.h3Pt}pt; color: #${c.coverMuted}; margin: 0; }
    .doc-section { margin-bottom: 1.6em; }
    h2.sec { break-after: avoid; }
    .callout { background: #${c.tint}; border-left: 4px solid #${c.accent};
               padding: 8px 14px; margin: 1.1em 0; font-weight: 600; break-inside: avoid; }
    .doc-quote { break-inside: avoid; }
    .source-note { font-size: ${doc.captionPt}pt; color: #${c.muted}; margin-top: -0.6em; }
    .kpi-grid { display: flex; gap: ${tokens.space.deck.gapIn}cm; margin: 1.2em 0; break-inside: avoid; }
    .kpi { flex: 1; }
    .kpi .v { font-family: ${display}; font-size: ${Math.max(doc.h1Pt, 22)}pt; font-weight: 700; color: #${c.accent}; }
    .kpi .l { font-size: ${doc.captionPt + 1}pt; color: #${c.muted}; }
    ul, ol { padding-left: 1.4em; }
    li { margin: 0.25em 0; }
  `;

  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="en">');
  parts.push("<head>");
  parts.push('<meta charset="utf-8">');
  parts.push(`<title>${esc(plan.title)}</title>`);
  parts.push(`<style>${css}</style>`);
  parts.push("</head>");
  parts.push("<body>");

  const metaBits = [plan.author, formatDate(now)].filter(Boolean).join(" · ");
  parts.push('<section class="cover">');
  if (metaBits) parts.push(`<p class="meta">${esc(metaBits)}</p>`);
  parts.push(`<h1>${esc(plan.title)}</h1>`);
  if (plan.subtitle) parts.push(`<p class="sub">${esc(plan.subtitle)}</p>`);
  parts.push("</section>");

  for (const section of plan.sections) {
    parts.push('<section class="doc-section">');
    parts.push(`<h2 class="sec">${esc(section.heading)}</h2>`);
    for (const block of section.blocks) {
      switch (block.type) {
        case "paragraph":
          parts.push(`<p>${esc(block.text)}</p>`);
          break;
        case "bullets":
          parts.push(`<ul>${block.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`);
          break;
        case "numbered":
          parts.push(`<ol>${block.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`);
          break;
        case "callout":
          parts.push(`<div class="callout">${esc(block.text)}</div>`);
          break;
        case "quote":
          parts.push('<div class="doc-quote"><blockquote>');
          parts.push(`<p>${esc(block.text)}</p>`);
          parts.push("</blockquote>");
          if (block.attribution) {
            parts.push(`<p class="source-note">— ${esc(block.attribution)}</p>`);
          }
          parts.push("</div>");
          break;
        case "table": {
          parts.push('<table>');
          parts.push(`<thead><tr>${block.columns.map((col) => `<th>${esc(col)}</th>`).join("")}</tr></thead>`);
          parts.push('<tbody>');
          for (const row of block.rows) {
            parts.push(`<tr>${row.map((cell) => `<td>${esc(cell ?? "")}</td>`).join("")}</tr>`);
          }
          parts.push("</tbody></table>");
          if (block.source) parts.push(`<p class="source-note">Source: ${esc(block.source)}</p>`);
          break;
        }
        case "kpi-strip":
          parts.push('<div class="kpi-grid">');
          for (const k of block.kpis) {
            const label = k.delta ? `${k.label} (${k.delta})` : k.label;
            parts.push(`<div class="kpi"><div class="v">${esc(k.value)}</div><div class="l">${esc(label)}</div></div>`);
          }
          parts.push("</div>");
          break;
        case "chart":
          // Blocked at validation; skip defensively.
          break;
      }
    }
    parts.push("</section>");
  }

  parts.push("</body></html>");
  const html = parts.join("\n");

  const checks = checkPdfInvariants(html, plan, c.coverBg);
  return { html, checks };
}

function formatDate(now: Date): string {
  return now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// --- L2 invariants -----------------------------------------------------------

export function checkPdfInvariants(html: string, plan: DocPlan, coverBg: string): CompileChecks {
  const issues: Issue[] = [];
  const passed: string[] = [];

  // The document must carry the themed cover and one section per plan entry.
  const sections = html.match(/class="doc-section"/g)?.length ?? 0;
  if (sections !== plan.sections.length) {
    issues.push({ severity: "error", rule: "l2/sections", message: `compiled ${sections} sections, plan has ${plan.sections.length}` });
  } else {
    passed.push(`all ${plan.sections.length} sections emitted`);
  }

  if (!html.includes(`#${coverBg}`)) {
    issues.push({ severity: "error", rule: "l2/cover", message: "cover does not carry the theme cover background" });
  } else {
    passed.push("themed cover present");
  }

  // Self-contained: no external fetches (the sandboxed print host is offline).
  if (/<link\s|src="http|@import/i.test(html)) {
    issues.push({ severity: "error", rule: "l2/external", message: "compiled HTML references external resources" });
  } else {
    passed.push("no external resources");
  }

  if (/<script/i.test(html)) {
    issues.push({ severity: "error", rule: "l2/scripts", message: "compiled HTML must not contain scripts" });
  } else {
    passed.push("no scripts");
  }

  // Margin boxes + counter need Paged.js; assert the page-number hook exists.
  if (!html.includes("counter(page)")) {
    issues.push({ severity: "error", rule: "l2/pagenum", message: "page-number margin box missing" });
  } else {
    passed.push("page numbers wired");
  }

  return { issues, passed };
}
/** Re-exported so the runner can base64 the HTML payload uniformly. */
export const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
};
