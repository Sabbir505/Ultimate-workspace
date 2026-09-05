// docdesign — deterministic document compiler: DocPlan + tokens → a docx
// (npm) program that runs in the app's document runner.
//
// Pure function, no model in the loop: same plan + theme in, same program
// out. Styles (fonts, sizes, spacing, colors) come exclusively from the
// shared tokens via document/heading default styles, so the model's content
// inherits the design system instead of hand-writing it.
import { facePrimary, tokens, type Theme } from "./tokens";
import type { DocPlan, DocSection } from "./irDoc";
import type { Issue } from "./ir";

export interface CompileChecks {
  issues: Issue[];
  passed: string[];
}

const J = JSON.stringify;

const HALF_PT = (pt: number): number => Math.round(pt * 2);
/** docx line spacing: 240ths of a line. */
const LINE = (leading: number): number => Math.round(leading * 240);

/** Compile a validated doc plan into the engine program + L2 checks. */
export function compileDoc(plan: DocPlan, theme: Theme): { code: string; checks: CompileChecks } {
  const doc = tokens.type.doc;
  const c = theme.color;
  const display = facePrimary("display");
  const body = facePrimary("body");
  const hasNumbered = plan.sections.some((s) =>
    s.blocks.some((b) => b.type === "numbered"),
  );

  const lines: string[] = [];
  lines.push(`// Compiled by docdesign from a plan — edit the plan, not this file.`);
  lines.push(`const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,`);
  lines.push(`  Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak } = docx;`);

  lines.push(`const doc = new Document({`);
  if (hasNumbered) {
    lines.push(`  numbering: { config: [{`);
    lines.push(`    reference: "dd-num",`);
    lines.push(`    levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START,`);
    lines.push(`      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },`);
  }
  lines.push(`  styles: { default: {`);
  lines.push(
    `    document: { run: { font: ${J(body)}, size: ${HALF_PT(doc.bodyPt)}, color: ${J(c.ink)} }, paragraph: { spacing: { line: ${LINE(doc.leadingDocx)}, after: 120 } } },`,
  );
  lines.push(
    `    heading1: { run: { font: ${J(display)}, size: ${HALF_PT(doc.h1Pt)}, color: ${J(c.ink)}, bold: true }, paragraph: { spacing: { before: 320, after: 160 } } },`,
  );
  lines.push(
    `    heading2: { run: { font: ${J(display)}, size: ${HALF_PT(doc.h2Pt)}, color: ${J(c.ink)}, bold: true }, paragraph: { spacing: { before: 280, after: 120 } } },`,
  );
  lines.push(
    `    heading3: { run: { font: ${J(body)}, size: ${HALF_PT(doc.h3Pt)}, color: ${J(c.muted)}, bold: true }, paragraph: { spacing: { before: 220, after: 100 } } },`,
  );
  lines.push(`  } },`);
  lines.push(`  sections: [{ children: [`);
  lines.push(...emitCover(plan, theme));
  for (const section of plan.sections) {
    lines.push(...emitSection(section, theme));
  }
  lines.push(`] }]`);
  lines.push(`});`);
  lines.push(`await relay.save(await Packer.toBlob(doc));`);

  const code = lines.join("\n");
  return { code, checks: checkDocInvariants(code, plan) };
}

function emitCover(plan: DocPlan, theme: Theme): string[] {
  const doc = tokens.type.doc;
  const c = theme.color;
  const display = facePrimary("display");
  const body = facePrimary("body");
  const out: string[] = [];
  // Breathing room above the title (whitespace hierarchy, not decoration).
  for (let i = 0; i < 6; i++) out.push(`new Paragraph({ text: "" }),`);
  out.push(
    `new Paragraph({ children: [new TextRun({ text: ${J(plan.title)}, font: ${J(display)}, size: ${HALF_PT(doc.displayPt)}, bold: true, color: ${J(c.ink)} })], spacing: { after: 200 } }),`,
  );
  if (plan.subtitle) {
    out.push(
      `new Paragraph({ children: [new TextRun({ text: ${J(plan.subtitle)}, font: ${J(body)}, size: ${HALF_PT(doc.h3Pt)}, color: ${J(c.muted)} })], spacing: { after: 120 } }),`,
    );
  }
  const metaBits = [plan.author, dateLine()].filter(Boolean).join(" · ");
  if (metaBits) {
    out.push(
      `new Paragraph({ children: [new TextRun({ text: ${J(metaBits)}, font: ${J(body)}, size: ${HALF_PT(doc.captionPt)}, color: ${J(c.accent)} })] }),`,
    );
  }
  out.push(`new Paragraph({ children: [new PageBreak()] }),`);
  return out;
}

function emitSection(section: DocSection, theme: Theme): string[] {
  const out: string[] = [];
  out.push(`new Paragraph({ text: ${J(section.heading)}, heading: HeadingLevel.HEADING_1 }),`);
  for (const block of section.blocks) {
    switch (block.type) {
      case "paragraph":
        out.push(`new Paragraph({ text: ${J(block.text)} }),`);
        break;
      case "bullets":
        for (const item of block.items) {
          out.push(`new Paragraph({ text: ${J(item)}, bullet: { level: 0 } }),`);
        }
        break;
      case "numbered":
        for (const item of block.items) {
          out.push(`new Paragraph({ text: ${J(item)}, numbering: { reference: "dd-num", level: 0 } }),`);
        }
        break;
      case "callout":
        out.push(...emitCallout(block.text, theme));
        break;
      case "quote":
        out.push(...emitQuote(block.text, block.attribution, theme));
        break;
      case "table":
        out.push(...emitTable(block.columns, block.rows, block.source, theme));
        break;
      case "kpi-strip":
        out.push(...emitKpiStrip(block.kpis, theme));
        break;
      case "chart":
        // Blocked at validation; skip defensively.
        break;
    }
  }
  return out;
}

function emitCallout(text: string, theme: Theme): string[] {
  const c = theme.color;
  return [
    `new Paragraph({`,
    `  shading: { fill: ${J(c.tint)} },`,
    `  border: { left: { style: BorderStyle.SINGLE, size: 24, color: ${J(c.accent)}, space: 8 } },`,
    `  spacing: { before: 160, after: 160 }, indent: { left: 200, right: 200 },`,
    `  children: [new TextRun({ text: ${J(text)}, bold: true, color: ${J(c.ink)} })] }),`,
  ];
}

function emitQuote(text: string, attribution: string | undefined, theme: Theme): string[] {
  const c = theme.color;
  const out = [
    `new Paragraph({`,
    `  border: { left: { style: BorderStyle.SINGLE, size: 12, color: ${J(c.hair)}, space: 8 } },`,
    `  indent: { left: 480 }, spacing: { before: 160, after: ${attribution ? 40 : 160} },`,
    `  children: [new TextRun({ text: ${J(text)}, italics: true, color: ${J(c.muted)} })] }),`,
  ];
  if (attribution) {
    out.push(
      `new Paragraph({ indent: { left: 480 }, spacing: { after: 160 }, children: [new TextRun({ text: ${J("— " + attribution)}, size: ${HALF_PT(tokens.type.doc.captionPt)}, color: ${J(c.muted)} })] }),`,
    );
  }
  return out;
}

function emitTable(columns: string[], rows: string[][], source: string | undefined, theme: Theme): string[] {
  const c = theme.color;
  const bodyFace = facePrimary("body");
  const out: string[] = [];
  out.push(`new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [`);
  out.push(`  new TableRow({ tableHeader: true, cantSplit: true, children: [`);
  for (const col of columns) {
    out.push(
      `    new TableCell({ shading: { fill: ${J(c.tint)} }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: ${J(col)}, bold: true })] })] }),`,
    );
  }
  out.push(`  ] }),`);
  for (const row of rows) {
    out.push(`  new TableRow({ cantSplit: true, children: [`);
    for (const cell of row) {
      out.push(
        `    new TableCell({ margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: ${J(cell ?? "")}, font: ${J(bodyFace)} })] })] }),`,
      );
    }
    out.push(`  ] }),`);
  }
  out.push(`] });`);
  if (source) {
    out.push(
      `new Paragraph({ spacing: { before: 40, after: 160 }, children: [new TextRun({ text: ${J("Source: " + source)}, size: ${HALF_PT(tokens.type.doc.captionPt)}, color: ${J(c.muted)} })] }),`,
    );
  } else {
    out.push(`new Paragraph({ text: "", spacing: { after: 80 } }),`);
  }
  return out;
}

function emitKpiStrip(kpis: { label: string; value: string; delta?: string }[], theme: Theme): string[] {
  const c = theme.color;
  const display = facePrimary("display");
  const kpiPt = Math.max(tokens.type.doc.h1Pt, 22);
  const out: string[] = [];
  out.push(`new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [`);
  out.push(`  new TableRow({ cantSplit: true, children: [`);
  for (const k of kpis) {
    out.push(
      `    new TableCell({ margins: { top: 80, bottom: 20, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: ${J(k.value)}, font: ${J(display)}, size: ${HALF_PT(kpiPt)}, bold: true, color: ${J(c.accent)} })] })] }),`,
    );
  }
  out.push(`  ] }),`);
  out.push(`  new TableRow({ cantSplit: true, children: [`);
  for (const k of kpis) {
    const label = k.delta ? `${k.label} (${k.delta})` : k.label;
    out.push(
      `    new TableCell({ margins: { top: 0, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: ${J(label)}, size: ${HALF_PT(tokens.type.doc.captionPt)}, color: ${J(c.muted)} })] })] }),`,
    );
  }
  out.push(`  ] })`);
  out.push(`] });`);
  out.push(`new Paragraph({ text: "", spacing: { after: 80 } }),`);
  return out;
}

function dateLine(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// --- L2 invariants -----------------------------------------------------------

export function checkDocInvariants(code: string, plan: DocPlan): CompileChecks {
  const issues: Issue[] = [];
  const passed: string[] = [];

  const saves = code.match(/relay\.save\(/g)?.length ?? 0;
  if (saves !== 1) {
    issues.push({ severity: "error", rule: "l2/save-once", message: `program must call relay.save exactly once (found ${saves})` });
  } else {
    passed.push("single relay.save");
  }

  if (/#[0-9a-fA-F]{6}\b/.test(code)) {
    issues.push({ severity: "error", rule: "l2/hex-hash", message: "emitted program contains a '#'-prefixed hex color" });
  } else {
    passed.push("hex colors are bare (no #)");
  }

  // Every section must appear exactly once as a HEADING_1.
  const headings = code.match(/HeadingLevel\.HEADING_1/g)?.length ?? 0;
  if (headings !== plan.sections.length) {
    issues.push({ severity: "error", rule: "l2/sections", message: `compiled ${headings} section headings, plan has ${plan.sections.length}` });
  } else {
    passed.push(`all ${plan.sections.length} sections emitted`);
  }

  // Fonts from tokens only.
  const allowed = [facePrimary("display"), facePrimary("body"), facePrimary("mono")];
  const used = new Set((code.match(/font: "([^"]+)"/g) ?? []).map((m) => m.replace('font: "', "").replace('"', "")));
  const foreign = [...used].filter((f) => !allowed.includes(f));
  if (foreign.length) {
    issues.push({ severity: "error", rule: "l2/fonts", message: `emitted program uses non-token fonts: ${foreign.join(", ")}` });
  } else {
    passed.push("fonts resolved from tokens");
  }

  return { issues, passed };
}
