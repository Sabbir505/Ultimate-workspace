// Structured visualization payloads (the renderer-registry layer):
// parsing + validation mirroring `build_viz_payload` in
// src-tauri/src/chat/tools/viz.rs. The model supplies typed data — never
// UI code — and Relay's own components render it (VizCard → registry).
// A payload that fails validation here renders as an explicit fallback,
// never as broken UI; the backend already rejected it model-side.

export type VizChart = {
  kind: "chart";
  title: string | null;
  style: VizStyle | null;
  unit: string | null;
  bars: { label: string; value: number }[];
};

export type VizTable = {
  kind: "table";
  title: string | null;
  style: VizStyle | null;
  columns: { label: string; align: "left" | "right" }[];
  rows: string[][];
};

export type VizBoard = {
  kind: "task-board";
  title: string | null;
  style: VizStyle | null;
  columns: { title: string; tasks: { title: string; meta?: string }[] }[];
};

export type VizTimeline = {
  kind: "timeline";
  title: string | null;
  style: VizStyle | null;
  events: { label: string; detail: string; at: string }[];
};

export type VizLine = {
  kind: "line";
  title: string | null;
  style: VizStyle | null;
  unit: string | null;
  area: boolean;
  points: { label: string; value: number }[];
};

export type VizDonut = {
  kind: "donut";
  title: string | null;
  style: VizStyle | null;
  unit: string | null;
  total: number;
  segments: { label: string; value: number }[];
};

export type VizStat = {
  kind: "stat";
  title: string | null;
  style: VizStyle | null;
  stats: { label: string; value: string; delta?: string; good?: boolean }[];
};

/** Agent-chosen look: every field optional, every color validated safe. */
export type VizStyle = {
  accent?: string;
  palette?: string[];
  tone?: "app" | "light" | "dark";
  radius?: "soft" | "sharp" | "pill";
};

/** Composition: a card whose sections are other (viz, payload) pairs. Mirrors
 *  `build_stack` in src-tauri/src/chat/tools/viz.rs — same caps, same counts,
 *  same intent. A section is a full request minus a title: a section carries no
 *  card chrome, so a `prose` section is its heading. */
export type VizStack = {
  kind: "stack";
  title: string | null;
  style: VizStyle | null;
  columns: 1 | 2;
  sections: VizPayload[];
};

/** Markdown rendered by the chat's own pipeline (headings, code with
 *  highlighting, KaTeX math, GFM tables, mermaid, `[1]` citation chips) — a
 *  delegation, so the XSS posture stays the chat body's rather than a new one. */
export type VizProse = {
  kind: "prose";
  title: string | null;
  style: VizStyle | null;
  markdown: string;
};

/** A hairline plus spacing between sections. */
export type VizDivider = {
  kind: "divider";
  title: string | null;
  style: VizStyle | null;
};

export type VizPayload =
  | VizChart
  | VizTable
  | VizBoard
  | VizTimeline
  | VizLine
  | VizDonut
  | VizStat
  | VizStack
  | VizProse
  | VizDivider;

export const VIZ_KINDS = [
  "chart",
  "table",
  "task-board",
  "timeline",
  "line",
  "donut",
  "stat",
  // Composition: a container whose sections are other cards + prose.
  "stack",
  // Leaf kinds that open the reference "rich content" and "pattern" cases
  // inside a typed card (markdown reuses the chat's own renderer).
  "prose",
  "divider",
] as const;

const MAX_BARS = 200;
const MAX_TABLE_COLS = 12;
const MAX_TABLE_ROWS = 500;
const MAX_BOARD_COLS = 8;
const MAX_BOARD_TASKS = 100;
const MAX_TIMELINE_EVENTS = 100;
const MAX_LINE_POINTS = 200;
const MAX_DONUT_SEGMENTS = 12;
const MAX_STATS = 8;
const MAX_PALETTE = 8;

// Composition caps — MUST match viz.rs (the aggregate budget is the only thing
// both validators share, so it is mirrored one-for-one; `src/test/viz-corpus.json`
// asserts the two agree).
const MAX_STACK_SECTIONS = 8;
const MAX_STACK_DEPTH = 3;
const MAX_STACK_LEAVES = 12;
const MAX_PROSE_CHARS = 4096;

/** Same contract as safe_color in the backend: hex / rgb() / rgba() /
 *  hsl() / hsla() only — the value is dropped into a CSS custom property. */
function safeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > 40) return null;
  const hex =
    s.startsWith("#") &&
    [4, 5, 7, 9].includes(s.length) &&
    [...s.slice(1)].every((c) => /[0-9a-fA-F]/.test(c));
  const fn = /^(rgb|rgba|hsl|hsla)\([^()<{};]*\)$/.test(s);
  return hex || fn ? s : null;
}

function parseStyle(o: Obj): VizStyle | null {
  const style = o.style;
  if (style == null) return {};
  if (!isObj(style)) return null;
  const out: VizStyle = {};
  if (style.accent != null) {
    const accent = safeColor(style.accent);
    if (accent === null) return null;
    out.accent = accent;
  }
  if (style.palette != null) {
    if (!Array.isArray(style.palette) || style.palette.length === 0 || style.palette.length > MAX_PALETTE)
      return null;
    const palette: string[] = [];
    for (const c of style.palette) {
      const color = safeColor(c);
      if (color === null) return null;
      palette.push(color);
    }
    out.palette = palette;
  }
  if (style.tone != null) {
    if (style.tone !== "app" && style.tone !== "light" && style.tone !== "dark") return null;
    out.tone = style.tone;
  }
  if (style.radius != null) {
    if (style.radius !== "soft" && style.radius !== "sharp" && style.radius !== "pill") return null;
    out.radius = style.radius;
  }
  return out;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// The backend's marker sanitizer neutralizes `</tool>`/`<tool>`/`<think>`
// with a literal backslash; JSON then encodes that backslash, so a parsed
// payload carries `<\\/tool>`. Undo it so hostile-free data renders exactly
// as the model authored it (same convention as the code-block escapes).
const MARKER_UNESCAPE = /<\\(\/?tool|think)>/g;
function unescapeMarkerStrings(value: unknown): unknown {
  if (typeof value === "string") return value.replace(MARKER_UNESCAPE, "<$1>");
  if (Array.isArray(value)) return value.map(unescapeMarkerStrings);
  if (isObj(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, unescapeMarkerStrings(v)]),
    );
  }
  return value;
}

const bounded = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > max) return null;
  return s;
};

/** The backend's `bounded_string(required = false)`: an ABSENT optional
 *  field normalizes to "" — a timeline event with no `detail`, a line point
 *  with no `label` — so an empty string is a legitimate normalized value and
 *  only an over-long one is rejected. Distinct from `bounded`, which demands
 *  content. Rejecting "" here made the frontend refuse exactly the payloads
 *  its own normalizer emits. */
const boundedOptional = (v: unknown, max: number): string | null => {
  if (v == null) return "";
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > max ? null : s;
};

const finite = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
};

function parseChart(o: Obj): VizChart | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  const unit = o.unit == null ? null : bounded(o.unit, 24);
  if (o.unit != null && unit === null) return null;
  if (!Array.isArray(o.bars) || o.bars.length === 0 || o.bars.length > MAX_BARS) return null;
  const bars: { label: string; value: number }[] = [];
  for (const bar of o.bars) {
    if (!isObj(bar)) return null;
    const label = bounded(bar.label, 120);
    const value = finite(bar.value);
    if (label === null || value === null) return null;
    bars.push({ label, value });
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "chart", title, unit, style, bars };
}

function parseTable(o: Obj): VizTable | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  if (!Array.isArray(o.columns) || o.columns.length === 0 || o.columns.length > MAX_TABLE_COLS)
    return null;
  const columns: { label: string; align: "left" | "right" }[] = [];
  for (const col of o.columns) {
    if (typeof col === "string") {
      const label = bounded(col, 80);
      if (label === null) return null;
      columns.push({ label, align: "left" });
      continue;
    }
    if (!isObj(col)) return null;
    const label = bounded(col.label, 80);
    if (label === null) return null;
    // The backend normalizer ALWAYS emits an explicit align ("left" for a
    // plain string column too), so "left" must be accepted as written.
    const align = col.align == null || col.align === "left" ? "left" : col.align === "right" ? "right" : null;
    if (align === null) return null;
    columns.push({ label, align });
  }
  if (!Array.isArray(o.rows) || o.rows.length > MAX_TABLE_ROWS) return null;
  const rows: string[][] = [];
  for (const row of o.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return null;
    const cells: string[] = [];
    for (const cell of row) {
      if (typeof cell === "string") {
        if (cell.length > 300) return null;
        cells.push(cell);
      } else if (typeof cell === "number" && Number.isFinite(cell)) {
        cells.push(String(cell));
      } else if (cell === null) {
        cells.push("");
      } else {
        return null;
      }
    }
    rows.push(cells);
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "table", title, style, columns, rows };
}

function parseBoard(o: Obj): VizBoard | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  if (!Array.isArray(o.columns) || o.columns.length === 0 || o.columns.length > MAX_BOARD_COLS)
    return null;
  const columns: { title: string; tasks: { title: string; meta?: string }[] }[] = [];
  for (const col of o.columns) {
    if (!isObj(col)) return null;
    const colTitle = bounded(col.title, 80);
    if (colTitle === null) return null;
    if (!Array.isArray(col.tasks) || col.tasks.length > MAX_BOARD_TASKS) return null;
    const tasks: { title: string; meta?: string }[] = [];
    for (const task of col.tasks) {
      if (!isObj(task)) return null;
      const taskTitle = bounded(task.title, 160);
      if (taskTitle === null) return null;
      let meta: string | undefined;
      if (task.meta != null) {
        const m = bounded(task.meta, 120);
        if (m === null) return null;
        meta = m;
      }
      tasks.push(meta ? { title: taskTitle, meta } : { title: taskTitle });
    }
    columns.push({ title: colTitle, tasks });
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "task-board", title, style, columns };
}

function parseTimeline(o: Obj): VizTimeline | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  if (!Array.isArray(o.events) || o.events.length === 0 || o.events.length > MAX_TIMELINE_EVENTS)
    return null;
  const events: { label: string; detail: string; at: string }[] = [];
  for (const ev of o.events) {
    if (!isObj(ev)) return null;
    const label = bounded(ev.label, 160);
    if (label === null) return null;
    // Optional fields normalize to "" when absent — an event with no detail
    // or timestamp still renders.
    const detail = boundedOptional(ev.detail, 300);
    const at = boundedOptional(ev.at, 40);
    if (detail === null || at === null) return null;
    events.push({ label, detail, at });
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "timeline", title, style, events };
}

function parseLine(o: Obj): VizLine | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  const unit = o.unit == null ? null : bounded(o.unit, 24);
  if (o.unit != null && unit === null) return null;
  const area = o.area == null ? true : o.area === true;
  if (o.area != null && typeof o.area !== "boolean") return null;
  if (!Array.isArray(o.points) || o.points.length < 2 || o.points.length > MAX_LINE_POINTS)
    return null;
  const points: { label: string; value: number }[] = [];
  for (const pt of o.points) {
    if (!isObj(pt)) return null;
    // A point's label is optional in the backend too (normalized to "").
    const label = boundedOptional(pt.label, 80);
    if (label === null) return null;
    const value = finite(pt.value);
    if (value === null) return null;
    points.push({ label, value });
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "line", title, unit, area, style, points };
}

function parseDonut(o: Obj): VizDonut | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  const unit = o.unit == null ? null : bounded(o.unit, 24);
  if (o.unit != null && unit === null) return null;
  if (!Array.isArray(o.segments) || o.segments.length === 0 || o.segments.length > MAX_DONUT_SEGMENTS)
    return null;
  const segments: { label: string; value: number }[] = [];
  let total = 0;
  for (const seg of o.segments) {
    if (!isObj(seg)) return null;
    const label = bounded(seg.label, 120);
    const value = finite(seg.value);
    if (label === null || value === null || value < 0) return null;
    total += value;
    segments.push({ label, value });
  }
  if (total <= 0) return null;
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "donut", title, unit, style, total, segments };
}

function parseStat(o: Obj): VizStat | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  if (!Array.isArray(o.stats) || o.stats.length === 0 || o.stats.length > MAX_STATS) return null;
  const stats: { label: string; value: string; delta?: string; good?: boolean }[] = [];
  for (const st of o.stats) {
    if (!isObj(st)) return null;
    const label = bounded(st.label, 80);
    const value = bounded(st.value, 24);
    if (label === null || value === null) return null;
    let delta: string | undefined;
    if (st.delta != null) {
      const d = bounded(st.delta, 24);
      if (d === null) return null;
      delta = d;
    }
    let good: boolean | undefined;
    if (st.good != null) {
      if (typeof st.good !== "boolean") return null;
      good = st.good;
    }
    stats.push(delta || good !== undefined ? { label, value, ...(delta ? { delta } : {}), ...(good !== undefined ? { good } : {}) } : { label, value });
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "stat", title, style, stats };
}

/** Composition: match `build_stack` in viz.rs. Sections are full requests
 *  minus a title, parsed by the SAME per-kind parsers the top level uses — that
 *  is what keeps the two validators from drifting (a nested chart is validated
 *  by parseChart, not a copy of it). The aggregate budget is counted across the
 *  whole tree, so nesting cannot be used to sneak past the per-kind caps. */
function parseStack(o: Obj, budget: VizBudget, depth: number): VizStack | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  if (depth > MAX_STACK_DEPTH) return null;
  if (!Array.isArray(o.sections) || o.sections.length === 0) return null;
  if (o.sections.length > MAX_STACK_SECTIONS) return null;
  const columns = o.columns == null ? 1 : o.columns === 1 || o.columns === 2 ? o.columns : null;
  if (columns === null) return null;
  const sections: VizPayload[] = [];
  for (const section of o.sections) {
    if (!isObj(section)) return null;
    const parsed = parseSection(section, budget, depth);
    if (parsed === null) return null;
    sections.push(parsed);
  }
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "stack", title, style, columns, sections };
}

/** One section: a `(viz, payload)` pair. A section carries no title (a `prose`
 *  section is the heading) and no arg-level flattening — its style comes from
 *  its payload or its own top level. */
function parseSection(section: Obj, budget: VizBudget, depth: number): VizPayload | null {
  const viz = typeof section.viz === "string" ? section.viz : undefined;
  const payload = section.payload;
  if (viz === undefined || !isObj(payload)) return null;
  const data = unescapeMarkerStrings(payload);
  if (!isObj(data)) return null;
  // A section's style may ride the payload (documented) or the section itself
  // (the flattening mistake models actually make) — same leniency as the top
  // level, so a valid section never fails only on where its style sits.
  const styleFromSection = section.style === undefined ? undefined : section.style;
  if (styleFromSection !== undefined) data.style = styleFromSection;
  const parsed = parseKnownViz(viz, data, budget, depth);
  if (parsed === null) return null;
  tallyBudget(budget, parsed.kind, parsed);
  return parsed;
}

/** The aggregate budget: leaf count plus every data element summed over the
 *  whole tree. `tally` mirrors `VizBudget::tally` in viz.rs. */
type VizBudget = {
  leaves: number;
  bars: number;
  points: number;
  rows: number;
  tasks: number;
  events: number;
  segments: number;
  stats: number;
};

const newBudget = (): VizBudget => ({
  leaves: 0,
  bars: 0,
  points: 0,
  rows: 0,
  tasks: 0,
  events: 0,
  segments: 0,
  stats: 0,
});

function tallyBudget(b: VizBudget, kind: string, parsed: VizPayload): boolean {
  if (kind !== "stack") b.leaves += 1;
  const len = (a: unknown[] | undefined) => (Array.isArray(a) ? a.length : 0);
  if (parsed.kind === "chart") b.bars += len(parsed.bars);
  if (parsed.kind === "line") b.points += len(parsed.points);
  if (parsed.kind === "table") b.rows += len(parsed.rows);
  if (parsed.kind === "timeline") b.events += len(parsed.events);
  if (parsed.kind === "donut") b.segments += len(parsed.segments);
  if (parsed.kind === "stat") b.stats += len(parsed.stats);
  if (parsed.kind === "task-board") {
    b.tasks += parsed.columns.reduce((n, c) => n + len(c.tasks), 0);
  }
  if (b.leaves > MAX_STACK_LEAVES) return false;
  return !(
    b.bars > MAX_BARS ||
    b.points > MAX_LINE_POINTS ||
    b.rows > MAX_TABLE_ROWS ||
    b.tasks > MAX_BOARD_TASKS ||
    b.events > MAX_TIMELINE_EVENTS ||
    b.segments > MAX_DONUT_SEGMENTS ||
    b.stats > MAX_STATS
  );
}

function parseProse(o: Obj): VizProse | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  const markdown = boundedOptional(o.markdown, MAX_PROSE_CHARS);
  if (markdown === null || markdown.length === 0) return null;
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "prose", title, style, markdown };
}

function parseDivider(o: Obj): VizDivider | null {
  const title = o.title == null ? null : bounded(o.title, 120);
  if (o.title != null && title === null) return null;
  const style = parseStyle(o);
  if (style === null) return null;
  return { kind: "divider", title, style };
}

/**
 * Validate a tool marker's `viz` + `payload` fields into a typed payload.
 * Returns null for ANY structural violation — the caller renders an explicit
 * fallback instead of partial UI (the backend validates too; this is the
 * rendering gate, since markers stream before execution finishes).
 */
export function parseVizPayload(
  viz: string | undefined,
  payload: unknown,
): VizPayload | null {
  if (viz === undefined || !isObj(payload)) return null;
  const data = unescapeMarkerStrings(payload);
  if (!isObj(data)) return null;
  return parseKnownViz(viz, data, newBudget(), 1);
}

/** Dispatch on a known kind, threading the composition budget and depth.
 *  Unknown kinds return null (the registry's "unavailable" fallback). */
function parseKnownViz(
  viz: string,
  data: Obj,
  budget: VizBudget,
  depth: number,
): VizPayload | null {
  switch (viz) {
    case "chart":
      return parseChart(data);
    case "table":
      return parseTable(data);
    case "task-board":
      return parseBoard(data);
    case "timeline":
      return parseTimeline(data);
    case "line":
      return parseLine(data);
    case "donut":
      return parseDonut(data);
    case "stat":
      return parseStat(data);
    case "stack":
      return parseStack(data, budget, depth);
    case "prose":
      return parseProse(data);
    case "divider":
      return parseDivider(data);
    default:
      return null;
  }
}

/** True when a ToolData marker is a completed, renderable visualization. */
export function isRenderableViz(data: { kind?: string; viz?: string; payload?: unknown } | null): boolean {
  return !!data && data.kind === "viz-data" && parseVizPayload(data.viz, data.payload) !== null;
}

/** Minimal RFC-4180 field escaping: quote when needed, double inner quotes. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Flatten any visualization payload to CSV for the card's copy action.
 * Chart → label,value; table → its own grid; board → column,task,meta;
 * timeline → label,at,detail; line/donut → series; stat → KPI rows.
 */
export function vizToCsv(payload: VizPayload): string | null {
  const row = (cells: string[]) => cells.map(csvField).join(",");
  switch (payload.kind) {
    case "chart": {
      const header = payload.unit ? `label,value (${csvField(payload.unit)})` : "label,value";
      return [header, ...payload.bars.map((b) => row([b.label, String(b.value)]))].join("\n");
    }
    case "line":
      return [
        row(["label", "value"]),
        ...payload.points.map((p) => row([p.label, String(p.value)])),
      ].join("\n");
    case "donut":
      return [
        row(["segment", `value${payload.unit ? ` (${csvField(payload.unit)})` : ""}`]),
        ...payload.segments.map((s) => row([s.label, String(s.value)])),
      ].join("\n");
    case "stat":
      return [
        row(["label", "value", "delta"]),
        ...payload.stats.map((s) => row([s.label, s.value, s.delta ?? ""])),
      ].join("\n");
    case "table":
      return [
        row(payload.columns.map((c) => c.label)),
        ...payload.rows.map((cells) => row(cells)),
      ].join("\n");
    case "task-board":
      return [
        row(["column", "task", "meta"]),
        ...payload.columns.flatMap((col) =>
          col.tasks.map((t) => row([col.title, t.title, t.meta ?? ""])),
        ),
      ].join("\n");
    case "timeline":
      return [
        row(["label", "at", "detail"]),
        ...payload.events.map((e) => row([e.label, e.at, e.detail])),
      ].join("\n");
    case "stack":
      // A composed card exports each section's own CSV, separated — the data
      // is all local, and a section with nothing tabular simply contributes
      // nothing (prose/divider have no CSV form).
      return payload.sections
        .map((section) => vizToCsv(section))
        .filter((csv): csv is string => csv !== null)
        .join("\n\n") || null;
    case "prose":
    case "divider":
      // Neither is tabular; the copy action stays hidden rather than lying.
      return null;
  }
}
