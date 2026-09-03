// docdesign — the content IR (the plan) and its validator (QA layer L1).
//
// The model authors a DeckPlan (structured JSON), never final layout code.
// This module validates a raw plan against the layout catalog: schema,
// required slots, and per-slot text budgets (CJK-aware), plus deck-level
// coherence (cover/closing bookends, layout repetition caps). Issues carry an
// IR pointer so revision patches a slide, not the whole deck.
import { DECK_LAYOUT_IDS, getLayout, textFits } from "./catalog";
import { cjkRatio, tokens } from "./tokens";

export interface Issue {
  severity: "error" | "warning";
  rule: string;
  message: string;
  /** IR pointer, e.g. "slides[3].slots.body" — lets revision patch in place. */
  pointer?: string;
}

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  series: { name: string; values: number[] }[];
  labels: string[];
  source?: string;
}

export interface Kpi {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down" | "flat";
}

export interface Step {
  label: string;
  caption?: string;
}

export interface DeckSlide {
  id: string;
  layout: string;
  slots: Record<string, unknown>;
  notes?: string;
}

export interface DeckPlan {
  v: 1;
  kind: "deck";
  title: string;
  subtitle?: string;
  theme?: string;
  language?: string;
  slides: DeckSlide[];
}

const MAX_SLIDES = 60;

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr);

export function issue(
  severity: Issue["severity"],
  rule: string,
  message: string,
  pointer?: string,
): Issue {
  return { severity, rule, message, pointer };
}

/** Validate + normalize a raw plan. Returns the typed plan only when no
 *  error-severity issues remain (warnings do not block compilation). */
export function validateDeckPlan(
  raw: unknown,
): { plan: DeckPlan; issues: Issue[] } | { plan: null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { plan: null, issues: [issue("error", "schema", "plan must be a JSON object")] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.v !== 1) issues.push(issue("error", "schema", `plan.v must be 1 (got ${JSON.stringify(obj.v)})`));
  if (obj.kind !== "deck") issues.push(issue("error", "schema", `plan.kind must be "deck" (got ${JSON.stringify(obj.kind)})`));
  if (!isStr(obj.title) || !obj.title.trim()) {
    issues.push(issue("error", "schema", "plan.title is required"));
  } else if (obj.title.length > 120) {
    issues.push(issue("warning", "budget", "plan.title is very long (cover titles read best under ~70 chars)"));
  }
  if (!Array.isArray(obj.slides) || obj.slides.length === 0) {
    issues.push(issue("error", "schema", "plan.slides must be a non-empty array"));
    return { plan: null, issues };
  }
  if (obj.slides.length > MAX_SLIDES) {
    issues.push(issue("error", "schema", `plan.slides exceeds ${MAX_SLIDES} slides`));
    return { plan: null, issues };
  }

  // Normalize slides (auto-assign ids), then per-slide checks.
  const slides: DeckSlide[] = obj.slides.map((s, i) => {
    const slide = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    return {
      id: isStr(slide.id) && slide.id.trim() ? slide.id : `s${i + 1}`,
      layout: isStr(slide.layout) ? slide.layout : "",
      slots: (typeof slide.slots === "object" && slide.slots !== null ? slide.slots : {}) as Record<string, unknown>,
      notes: isStr(slide.notes) ? slide.notes : undefined,
    };
  });

  const ids = new Set<string>();
  for (const slide of slides) {
    if (ids.has(slide.id)) issues.push(issue("error", "schema", `duplicate slide id "${slide.id}"`, `slides[id=${slide.id}]`));
    ids.add(slide.id);
    if (!DECK_LAYOUT_IDS.includes(slide.layout)) {
      issues.push(
        issue(
          "error",
          "catalog",
          `unknown layout "${slide.layout}" — pick one of: ${DECK_LAYOUT_IDS.join(", ")}`,
          `slides[id=${slide.id}]`,
        ),
      );
      continue;
    }
    validateSlideSlots(slide, issues);
    if (slide.notes && slide.notes.length > 500) {
      issues.push(issue("warning", "budget", `speaker notes on "${slide.id}" exceed 500 chars and will be trimmed`, `slides[id=${slide.id}].notes`));
    }
  }

  // Deck-level coherence.
  if (slides[0] && slides[0].layout !== "cover") {
    issues.push(issue("warning", "coherence", "decks should open with a cover slide", "slides[0]"));
  }
  const last = slides[slides.length - 1];
  if (last && last.layout !== "closing") {
    issues.push(issue("warning", "coherence", "decks should close with a closing slide", `slides[id=${last.id}]`));
  }
  let run = 1;
  for (let i = 1; i < slides.length; i++) {
    run = slides[i].layout === slides[i - 1].layout ? run + 1 : 1;
    if (run > 3) {
      issues.push(
        issue("warning", "coherence", `more than 3 consecutive "${slides[i].layout}" slides — vary the rhythm (identical layouts on every slide reads as templated)`, `slides[id=${slides[i].id}]`),
      );
      break;
    }
  }
  const kpiCount = slides.filter((s) => s.layout === "kpi").length;
  if (slides.length >= 10 && kpiCount > slides.length / 5) {
    issues.push(issue("warning", "coherence", "more than 1-in-5 slides are KPI grids — cap stat-card slides", ""));
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return hasErrors
    ? { plan: null, issues }
    : { plan: { v: 1, kind: "deck", title: obj.title as string, subtitle: isStr(obj.subtitle) ? obj.subtitle : undefined, theme: isStr(obj.theme) ? obj.theme : undefined, language: isStr(obj.language) ? obj.language : undefined, slides }, issues };
}

function validateSlideSlots(slide: DeckSlide, issues: Issue[]) {
  const layout = getLayout(slide.layout);
  if (!layout) return;
  const at = (slot: string) => `slides[id=${slide.id}].slots.${slot}`;

  for (const spec of layout.slots) {
    const value = slide.slots[spec.id];
    if (value === undefined || value === null || (isStr(value) && !value.trim())) {
      if (spec.required) {
        issues.push(issue("error", "slots", `layout "${slide.layout}" requires slot "${spec.id}"`, at(spec.id)));
      }
      continue;
    }
    switch (spec.content) {
      case "text":
        checkText(value, spec, slide, issues);
        break;
      case "bullets":
        if (!isStrArray(value)) {
          issues.push(issue("error", "slots", `slot "${spec.id}" must be an array of strings`, at(spec.id)));
          break;
        }
        if (spec.maxItems && value.length > spec.maxItems) {
          issues.push(issue("error", "budget", `${value.length} bullets exceed the max of ${spec.maxItems} — split the slide or trim`, at(spec.id)));
        }
        for (const [i, b] of value.entries()) {
          checkItemText(b, spec, slide, issues, `bullets[${i}]`);
        }
        break;
      case "chart":
        validateChart(value, issues, at("chart"));
        break;
      case "kpis": {
        if (!Array.isArray(value)) {
          issues.push(issue("error", "slots", `slot "${spec.id}" must be an array of {label, value, delta?, trend?}`, at(spec.id)));
          break;
        }
        if (value.length !== 3) {
          issues.push(issue("error", "budget", `KPI slides show exactly 3 stats (got ${value.length}) — use chart-text/table for other counts`, at(spec.id)));
        }
        for (const [i, k] of value.entries()) {
          const kpi = (typeof k === "object" && k !== null ? k : {}) as Record<string, unknown>;
          if (!isStr(kpi.label) || !isStr(kpi.value)) {
            issues.push(issue("error", "slots", `KPI ${i} needs a label and a value`, `${at("kpis")}[${i}]`));
            continue;
          }
          checkItemText(kpi.label, spec, slide, issues, `kpis[${i}].label`, 28);
          checkItemText(kpi.value, spec, slide, issues, `kpis[${i}].value`, 10);
          if (kpi.delta !== undefined && !isStr(kpi.delta)) {
            issues.push(issue("error", "slots", `KPI ${i} delta must be a string`, `${at("kpis")}[${i}].delta`));
          }
          if (kpi.trend !== undefined && !["up", "down", "flat"].includes(String(kpi.trend))) {
            issues.push(issue("error", "slots", `KPI ${i} trend must be up|down|flat`, `${at("kpis")}[${i}].trend`));
          }
        }
        break;
      }
      case "steps": {
        if (!Array.isArray(value)) {
          issues.push(issue("error", "slots", `slot "${spec.id}" must be an array of {label, caption?}`, at(spec.id)));
          break;
        }
        if (value.length < 2 || (spec.maxItems && value.length > spec.maxItems)) {
          issues.push(issue("error", "budget", `timeline needs 2–${spec.maxItems ?? 4} steps (got ${value.length})`, at(spec.id)));
        }
        for (const [i, st] of value.entries()) {
          const step = (typeof st === "object" && st !== null ? st : {}) as Record<string, unknown>;
          if (!isStr(step.label) || !step.label.trim()) {
            issues.push(issue("error", "slots", `step ${i} needs a label`, `${at("steps")}[${i}]`));
            continue;
          }
          checkItemText(step.label, spec, slide, issues, `steps[${i}].label`, 40);
          if (step.caption !== undefined) checkItemText(String(step.caption), spec, slide, issues, `steps[${i}].caption`, 120);
        }
        break;
      }
      case "table": {
        const rows = value as unknown;
        if (!Array.isArray(rows) || rows.length < 2 || !rows.every((r) => Array.isArray(r))) {
          issues.push(issue("error", "slots", `slot "${spec.id}" must be an array of at least 2 rows (header + data)`, at(spec.id)));
          break;
        }
        const width = (rows[0] as unknown[]).length;
        if (width < 2 || (spec.maxCols && width > spec.maxCols)) {
          issues.push(issue("error", "budget", `table needs 2–${spec.maxCols ?? 5} columns (got ${width})`, at(spec.id)));
        }
        if (spec.maxItems && rows.length > spec.maxItems) {
          issues.push(issue("error", "budget", `table exceeds ${spec.maxItems} rows — trim or split the slide`, at(spec.id)));
        }
        for (const [r, row] of rows.entries()) {
          const cells = row as unknown[];
          if (cells.length !== width) {
            issues.push(issue("error", "slots", `table row ${r} has ${cells.length} cells, expected ${width}`, `${at("table")}[${r}]`));
          }
          for (const [cIdx, cell] of cells.entries()) {
            checkItemText(String(cell ?? ""), spec, slide, issues, `table[${r}][${cIdx}]`, spec.maxItemChars ?? 60);
          }
        }
        break;
      }
    }
  }
}

function checkText(value: unknown, spec: { id: string; rect: [number, number, number, number]; style: string }, slide: DeckSlide, issues: Issue[]) {
  const at = `slides[id=${slide.id}].slots.${spec.id}`;
  if (!isStr(value)) {
    issues.push(issue("error", "slots", `slot "${spec.id}" must be a string`, at));
    return;
  }
  const { pt } = stylePointSize(spec.style);
  if (!textFits(value, spec.rect[2], spec.rect[3], pt)) {
    issues.push(
      issue(
        "error",
        "budget",
        `text does not fit slot "${spec.id}" (${value.length} chars at ${pt}pt) — shorten the copy`,
        at,
      ),
    );
  }
}

function checkItemText(
  text: string,
  spec: { id: string; rect: [number, number, number, number]; style: string; maxItemChars?: number },
  slide: DeckSlide,
  issues: Issue[],
  label: string,
  maxChars?: number,
) {
  const at = `slides[id=${slide.id}].slots.${label}`;
  const limit = maxChars ?? spec.maxItemChars ?? 110;
  // CJK glyphs are full-width: shrink the effective budget ~15% so CJK copy
  // is tightened sooner (matching the research guidance).
  const factor = cjkRatio(text) > 0.3 ? 0.85 : 1;
  if (text.length > limit * factor) {
    issues.push(
      issue(
        "error",
        "budget",
        `"${label}" is over its ${Math.floor(limit * factor)}-char budget (${text.length} chars) — tighten the copy`,
        at,
      ),
    );
  }
}

export function validateChart(value: unknown, issues: Issue[], at: string) {
  const chart = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const type = chart.type;
  if (type !== "bar" && type !== "line" && type !== "pie") {
    issues.push(issue("error", "chart", `chart.type must be bar|line|pie (got ${JSON.stringify(type)})`, at));
  }
  const labels = chart.labels;
  if (!isStrArray(labels) || labels.length === 0) {
    issues.push(issue("error", "chart", "chart.labels must be a non-empty array of strings", at));
  }
  if (!Array.isArray(chart.series) || chart.series.length === 0) {
    issues.push(issue("error", "chart", "chart.series must be a non-empty array of {name, values}", at));
    return;
  }
  if (type === "pie" && chart.series.length > 1) {
    issues.push(issue("error", "chart", "pie charts take exactly one series", at));
  }
  for (const [i, s] of chart.series.entries()) {
    const series = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    if (!isStr(series.name)) {
      issues.push(issue("error", "chart", `series ${i} needs a name`, at));
    }
    if (!Array.isArray(series.values) || series.values.some((v) => typeof v !== "number" || Number.isNaN(v))) {
      issues.push(issue("error", "chart", `series "${String(series.name ?? i)}" values must all be numbers`, at));
    } else if (labels && Array.isArray(labels) && (series.values as number[]).length !== labels.length) {
      issues.push(issue("error", "chart", `series "${String(series.name ?? i)}" has ${(series.values as number[]).length} values but there are ${labels.length} labels`, at));
    }
  }
}

/** Point size for a style, resolved from the deck type scale. Used by fit
 *  checks and by the compiler; single source so they can never diverge. */
export function stylePointSize(style: string): { pt: number; key: string } {
  const deck = tokens.type.deck as unknown as Record<string, number>;
  const map: Record<string, string> = {
    coverTitle: "titlePt",
    coverSubtitle: "bodyPt",
    coverMeta: "eyebrowPt",
    sectionKicker: "eyebrowPt",
    sectionTitle: "sectionTitlePt",
    contentTitle: "contentTitlePt",
    body: "bodyPt",
    subTitle: "contentTitlePt",
    bullets: "bodyPt",
    caption: "captionPt",
    kpiValue: "kpiValuePt",
    kpiLabel: "kpiLabelPt",
    quote: "quotePt",
    statement: "statementPt",
    table: "tablePt",
  };
  const key = map[style] ?? "bodyPt";
  return { pt: deck[key] ?? 16, key };
}
