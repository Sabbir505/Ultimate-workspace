// docdesign — deterministic deck compiler: DeckPlan + tokens + catalog →
// a PptxGenJS program (JS source) that runs in the app's document runner.
//
// The compiler is pure and model-free: same plan + theme in, same program out,
// which makes the output unit-testable and the L2 invariant checks below
// meaningful. Generated programs use only known-safe PptxGenJS patterns:
// bare hex (no '#'), one `conduit.save`, native charts without `dLblPos`
// (the classic PowerPoint-repair trigger), option objects never shared.
import { DECK_LAYOUTS, getLayout, type SlideStyle } from "./catalog";
import type { DeckPlan, DeckSlide, Issue } from "./ir";
import { stylePointSize } from "./ir";
import { facePrimary, tokens, type Theme } from "./tokens";

export interface CompileChecks {
  issues: Issue[];
  passed: string[];
  slideCount: number;
}

interface TextStyle {
  fontSize: number;
  fontFace: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

function styleOpts(theme: Theme, style: SlideStyle): TextStyle {
  const { pt } = stylePointSize(style);
  const c = theme.color;
  const display = facePrimary("display");
  const body = facePrimary("body");
  switch (style) {
    case "coverTitle":
      return { fontSize: pt, fontFace: display, color: c.coverFg, bold: true };
    case "coverSubtitle":
      return { fontSize: pt, fontFace: body, color: c.coverMuted };
    case "coverMeta":
    case "sectionKicker":
      return { fontSize: pt, fontFace: body, color: c.coverAccent, bold: true };
    case "sectionTitle":
      return { fontSize: pt, fontFace: display, color: c.coverFg, bold: true };
    case "contentTitle":
      return { fontSize: pt, fontFace: display, color: c.ink, bold: true };
    case "subTitle":
      return { fontSize: pt, fontFace: body, color: c.ink, bold: true };
    case "kpiValue":
      return { fontSize: pt, fontFace: display, color: c.accent, bold: true };
    case "kpiLabel":
      return { fontSize: pt, fontFace: body, color: c.muted };
    case "quote":
      return { fontSize: pt, fontFace: display, color: c.ink, italic: true };
    case "statement":
      return { fontSize: pt, fontFace: display, color: c.accent, bold: true };
    case "table":
      return { fontSize: pt, fontFace: body, color: c.ink };
    case "caption":
      return { fontSize: pt, fontFace: body, color: c.muted };
    default:
      return { fontSize: pt, fontFace: body, color: c.ink };
  }
}

const J = JSON.stringify;
const rect = (r: [number, number, number, number]) =>
  `x: ${r[0]}, y: ${r[1]}, w: ${r[2]}, h: ${r[3]}`;
const baseOpts = (t: TextStyle, r: [number, number, number, number]) =>
  `${rect(r)}, fontSize: ${t.fontSize}, fontFace: ${J(t.fontFace)}, color: ${J(t.color)}` +
  (t.bold ? ", bold: true" : "") +
  (t.italic ? ", italic: true" : "") +
  `, align: "left", valign: "top", lineSpacingMultiple: ${tokens.type.deck.leading}`;

/** Compile a validated plan into the engine program + L2 checks. */
export function compileDeck(plan: DeckPlan, theme: Theme): { code: string; checks: CompileChecks } {
  const c = theme.color;
  const deck = tokens.space.deck;
  const lines: string[] = [];

  lines.push(`// Compiled by docdesign from a plan — edit the plan, not this file.`);
  lines.push(`const pptx = new PptxGenJS();`);
  lines.push(`pptx.defineLayout({ name: "DD_16x9", width: ${deck.widthIn}, height: ${deck.heightIn} });`);
  lines.push(`pptx.layout = "DD_16x9";`);
  lines.push(`pptx.author = "Relay";`);
  lines.push(`pptx.title = ${J(plan.title)};`);

  // One master per theme role; slide numbers only on the light master.
  lines.push(
    `pptx.defineSlideMaster({ title: "DD_light", background: { color: ${J(c.bg)} }, objects: [], slideNumber: { x: ${round(deck.widthIn - 0.9)}, y: ${round(deck.heightIn - 0.45)}, w: 0.6, h: 0.3, color: ${J(c.muted)}, fontFace: ${J(facePrimary("body"))}, fontSize: ${tokens.type.deck.captionPt} } });`,
  );
  lines.push(`pptx.defineSlideMaster({ title: "DD_dark", background: { color: ${J(c.coverBg)} }, objects: [] });`);

  const palette = theme.chartPalette;
  let paletteIndex = 0;

  for (const slide of plan.slides) {
    lines.push(`{`);
    lines.push(`const s = pptx.addSlide({ masterName: ${J(layoutMaster(slide.layout))} });`);
    emitSlide(lines, slide, theme, () => palette[paletteIndex++ % palette.length]);
    if (slide.notes) {
      lines.push(`s.addNotes(${J(slide.notes.slice(0, 500))});`);
    }
    lines.push(`}`);
  }

  lines.push(`await conduit.save(await pptx.write({ outputType: "blob" }));`);
  const code = lines.join("\n");

  return { code, checks: checkInvariants(code, plan) };
}

function layoutMaster(layoutId: string): "DD_light" | "DD_dark" {
  return getLayout(layoutId)?.master ?? "DD_light";
}

function emitSlide(
  lines: string[],
  slide: DeckSlide,
  theme: Theme,
  nextColor: () => string,
) {
  const layout = DECK_LAYOUTS[slide.layout];
  if (!layout) return;
  const specById = new Map(layout.slots.map((s) => [s.id, s]));
  const slotOf = (id: string) => specById.get(id);
  const text = (id: string): string => {
    const v = slide.slots[id];
    return typeof v === "string" ? v : "";
  };
  const style = (id: string): TextStyle => {
    const spec = slotOf(id);
    return styleOpts(theme, (spec?.style ?? "body") as SlideStyle);
  };
  const addText = (id: string, value?: string) => {
    const spec = slotOf(id);
    if (!spec) return;
    const v = value ?? text(id);
    if (!v) return;
    lines.push(`s.addText(${J(v)}, { ${baseOpts(style(id), spec.rect)} });`);
  };

  switch (slide.layout) {
    case "cover":
    case "section":
    case "closing": {
      for (const spec of layout.slots) addText(spec.id);
      break;
    }
    case "bullets":
    case "agenda": {
      addText("title");
      addText("eyebrow");
      const spec = slotOf("bullets") ?? slotOf("items");
      const items = slide.slots[spec?.id ?? ""];
      if (spec && Array.isArray(items) && items.length) {
        const runs = items
          .map((b) => `{ text: ${J(String(b))}, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } }`)
          .join(", ");
        lines.push(
          `s.addText([${runs}], { ${baseOpts(style(spec.id), spec.rect)} });`,
        );
      }
      break;
    }
    case "two-col": {
      addText("title");
      for (const side of ["left", "right"] as const) {
        addText(`${side}Title`);
        const spec = slotOf(`${side}Bullets`);
        const items = slide.slots[`${side}Bullets`];
        if (spec && Array.isArray(items) && items.length) {
          const runs = items
            .map((b) => `{ text: ${J(String(b))}, options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } }`)
            .join(", ");
          lines.push(`s.addText([${runs}], { ${baseOpts(style(spec.id), spec.rect)} });`);
        }
      }
      break;
    }
    case "chart-text":
    case "chart-full": {
      addText("title");
      addText("body");
      addText("source");
      const spec = slotOf("chart");
      if (spec) emitChart(lines, slide.slots.chart, spec.rect, theme, nextColor);
      break;
    }
    case "kpi": {
      addText("title");
      addText("source");
      const kpis = Array.isArray(slide.slots.kpis) ? slide.slots.kpis : [];
      const gap = tokens.space.deck.gapIn;
      const cardW = round((tokens.space.deck.widthIn - 2 * tokens.space.deck.marginIn - 2 * gap) / 3);
      kpis.slice(0, 3).forEach((rawK, i) => {
        const k = (typeof rawK === "object" && rawK !== null ? rawK : {}) as Record<string, unknown>;
        const x = round(tokens.space.deck.marginIn + i * (cardW + gap));
        const arrow = k.trend === "up" ? "↑ " : k.trend === "down" ? "↓ " : k.trend === "flat" ? "→ " : "";
        const delta = typeof k.delta === "string" && k.delta ? `${arrow}${k.delta}` : "";
        if (delta) {
          lines.push(
            `s.addText(${J(String(k.value))}, { ${rect([x, 2.1, cardW, 1.3])}, fontSize: ${stylePointSize("kpiValue").pt}, fontFace: ${J(facePrimary("display"))}, color: ${J(theme.color.accent)}, bold: true, align: "left", valign: "bottom" });`,
          );
          lines.push(
            `s.addText(${J(String(k.label))}, { ${rect([x, 3.55, cardW, 0.5])}, fontSize: ${stylePointSize("kpiLabel").pt}, fontFace: ${J(facePrimary("body"))}, color: ${J(theme.color.ink)}, align: "left", valign: "top" });`,
          );
          lines.push(
            `s.addText(${J(delta)}, { ${rect([x, 4.1, cardW, 0.45])}, fontSize: ${stylePointSize("kpiLabel").pt}, fontFace: ${J(facePrimary("body"))}, color: ${J(theme.color.muted)}, align: "left", valign: "top" });`,
          );
        } else {
          lines.push(
            `s.addText(${J(String(k.value))}, { ${rect([x, 2.4, cardW, 1.3])}, fontSize: ${stylePointSize("kpiValue").pt}, fontFace: ${J(facePrimary("display"))}, color: ${J(theme.color.accent)}, bold: true, align: "left", valign: "bottom" });`,
          );
          lines.push(
            `s.addText(${J(String(k.label))}, { ${rect([x, 3.85, cardW, 0.5])}, fontSize: ${stylePointSize("kpiLabel").pt}, fontFace: ${J(facePrimary("body"))}, color: ${J(theme.color.ink)}, align: "left", valign: "top" });`,
          );
        }
      });
      break;
    }
    case "quote": {
      addText("quote");
      addText("attribution");
      break;
    }
    case "statement": {
      addText("statement");
      addText("context");
      break;
    }
    case "timeline": {
      addText("title");
      const spec = slotOf("steps");
      const steps = Array.isArray(slide.slots.steps) ? slide.slots.steps : [];
      const n = Math.max(2, Math.min(steps.length || 2, spec?.maxItems ?? 4));
      const stepW = round((tokens.space.deck.widthIn - 2 * tokens.space.deck.marginIn) / n);
      lines.push(
        `s.addShape(pptx.ShapeType.line, { x: ${tokens.space.deck.marginIn}, y: 2.95, w: ${round(tokens.space.deck.widthIn - 2 * tokens.space.deck.marginIn)}, h: 0, line: { color: ${J(theme.color.hair)}, width: 1.5 } });`,
      );
      steps.slice(0, n).forEach((rawStep, i) => {
        const step = (typeof rawStep === "object" && rawStep !== null ? rawStep : {}) as Record<string, unknown>;
        const x = round(tokens.space.deck.marginIn + i * stepW);
        lines.push(
          `s.addShape(pptx.ShapeType.ellipse, { x: ${round(x + 0.05)}, y: 2.88, w: 0.14, h: 0.14, fill: { color: ${J(theme.color.accent)} } });`,
        );
        lines.push(
          `s.addText(${J(String(step.label ?? ""))}, { ${rect([x + 0.05, 3.2, round(stepW - 0.25), 0.6])}, ${`fontSize: ${stylePointSize("subTitle").pt}, bold: true`}, fontFace: ${J(facePrimary("body"))}, color: ${J(theme.color.ink)}, align: "left", valign: "top" });`,
        );
        if (step.caption) {
          lines.push(
            `s.addText(${J(String(step.caption))}, { ${rect([x + 0.05, 3.85, round(stepW - 0.25), 1.6])}, fontSize: ${stylePointSize("body").pt}, fontFace: ${J(facePrimary("body"))}, color: ${J(theme.color.muted)}, align: "left", valign: "top", lineSpacingMultiple: ${tokens.type.deck.leading} });`,
          );
        }
      });
      break;
    }
    case "table": {
      addText("title");
      addText("source");
      const spec = slotOf("table");
      const rows = slide.slots.table;
      if (spec && Array.isArray(rows) && rows.length) {
        const grid = rows as unknown[][];
        const cols = (grid[0] as unknown[]).length;
        const colW = Array.from({ length: cols }, () => round(spec.rect[2] / cols));
        const rendered = grid.map((row, r) =>
          `[${(row as unknown[])
            .map((cell) => {
              const v = J(String(cell ?? ""));
              return r === 0
                ? `{ text: ${v}, options: { bold: true, color: ${J(theme.color.ink)}, fill: { color: ${J(theme.color.tint)} } } }`
                : v;
            })
            .join(", ")}]`,
        );
        lines.push(
          `s.addTable([${rendered.join(", ")}], { ${rect(spec.rect)}, colW: [${colW.join(", ")}], fontSize: ${stylePointSize("table").pt}, fontFace: ${J(facePrimary("body"))}, color: ${J(theme.color.ink)}, border: { type: "solid", pt: 0.5, color: ${J(theme.color.hair)} }, valign: "middle" });`,
        );
      }
      break;
    }
    default:
      break;
  }
}

const CHART_TYPE: Record<string, string> = {
  bar: "pptx.ChartType.bar",
  line: "pptx.ChartType.line",
  pie: "pptx.ChartType.pie",
};

function emitChart(
  lines: string[],
  raw: unknown,
  rectSpec: [number, number, number, number],
  theme: Theme,
  nextColor: () => string,
) {
  const chart = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const kind = CHART_TYPE[String(chart.type)] ?? CHART_TYPE.bar;
  const series = Array.isArray(chart.series) ? chart.series : [];
  const data = series.map((s) => {
    const ser = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    return `{ name: ${J(String(ser.name ?? ""))}, labels: ${J((chart.labels as string[]) ?? [])}, values: ${J((ser.values as number[]) ?? [])} }`;
  });
  const isPie = kind === CHART_TYPE.pie;
  const colorCount = isPie ? Math.max(1, (chart.labels as string[])?.length ?? 1) : Math.max(1, series.length);
  const colors = Array.from({ length: colorCount }, () => nextColor());
  const opts: string[] = [rect(rectSpec)];
  opts.push(`chartColors: [${colors.map((c) => J(c)).join(", ")}]`);
  if (isPie) {
    opts.push(`showPercent: true`);
  } else {
    opts.push(`showValue: false`);
    opts.push(`catAxisLabelColor: ${J(theme.color.muted)}`);
    opts.push(`catAxisLabelFontSize: ${tokens.chart.axisLabelPt}`);
    opts.push(`valAxisLabelColor: ${J(theme.color.muted)}`);
    opts.push(`valAxisLabelFontSize: ${tokens.chart.axisLabelPt}`);
    opts.push(`valGridLine: { color: ${J(theme.color.hair)}, size: 0.5 }`);
  }
  if (series.length > 1 || isPie) {
    opts.push(`showLegend: true`);
    opts.push(`legendPos: ${isPie ? '"r"' : '"b"'}`);
    opts.push(`legendColor: ${J(theme.color.muted)}`);
    opts.push(`legendFontSize: ${tokens.chart.legendPt}`);
  } else {
    opts.push(`showLegend: false`);
  }
  lines.push(`s.addChart(${kind}, [${data.join(", ")}], { ${opts.join(", ")} });`);
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

// --- L2: compile-time invariant checks on the emitted program ----------------

export function checkInvariants(code: string, plan: DeckPlan): CompileChecks {
  const issues: Issue[] = [];
  const passed: string[] = [];

  // 1. No '#' in any hex color — a '#' corrupts the OOXML pptxgenjs writes.
  if (/#[0-9a-fA-F]{6}\b/.test(code)) {
    issues.push({ severity: "error", rule: "l2/hex-hash", message: "emitted program contains a '#'-prefixed hex color" });
  } else {
    passed.push("hex colors are bare (no #)");
  }

  // 2. Exactly one delivery.
  const saves = code.match(/conduit\.save\(/g)?.length ?? 0;
  if (saves !== 1) {
    issues.push({ severity: "error", rule: "l2/save-once", message: `program must call conduit.save exactly once (found ${saves})` });
  } else {
    passed.push("single conduit.save");
  }

  // 3. Slide count matches the plan.
  const slides = code.match(/addSlide\(/g)?.length ?? 0;
  if (slides !== plan.slides.length) {
    issues.push({ severity: "error", rule: "l2/slide-count", message: `compiled ${slides} slides, plan has ${plan.slides.length}` });
  } else {
    passed.push(`slide count matches plan (${slides})`);
  }

  // 4. No dLblPos — the chart option that passes LibreOffice but triggers
  //    PowerPoint's repair dialog.
  if (code.includes("dLblPos")) {
    issues.push({ severity: "error", rule: "l2/dlblpos", message: "emitted program sets dLblPos (PowerPoint repair trigger)" });
  } else {
    passed.push("charts avoid dLblPos");
  }

  // 5. Every referenced master is defined.
  const defined = new Set((code.match(/defineSlideMaster\(\{ title: "(DD_[a-z]+)"/g) ?? []).map((m) => m.replace(/.*title: "/, "").replace('"', "")));
  const referenced = new Set((code.match(/masterName: "(DD_[a-z]+)"/g) ?? []).map((m) => m.replace(/.*masterName: "/, "").replace('"', "")));
  const missing = [...referenced].filter((m) => !defined.has(m));
  if (missing.length) {
    issues.push({ severity: "error", rule: "l2/masters", message: `slides reference undefined masters: ${missing.join(", ")}` });
  } else {
    passed.push("all slide masters defined");
  }

  // 6. Fonts come only from the token faces.
  const allowed = [facePrimary("display"), facePrimary("body"), facePrimary("mono")];
  const used = new Set((code.match(/fontFace: "([^"]+)"/g) ?? []).map((m) => m.replace('fontFace: "', "").replace('"', "")));
  const foreign = [...used].filter((f) => !allowed.includes(f));
  if (foreign.length) {
    issues.push({ severity: "error", rule: "l2/fonts", message: `emitted program uses non-token fonts: ${foreign.join(", ")}` });
  } else {
    passed.push("fonts resolved from tokens");
  }

  return { issues, passed, slideCount: plan.slides.length };
}
