// docdesign — deck layout catalog.
//
// A fixed taxonomy of slide layouts (synthesized from consulting-deck
// archetypes, PowerPoint's built-ins, and PPTAgent's role map). Each layout is
// a set of SLOTS with geometry (inches on the 13.333×7.5 canvas), a text
// style, and the content kinds it accepts. The model never positions
// anything — it picks a layout and fills slots; validation enforces the
// budgets that keep text inside its box.
//
// Non-negotiables baked into these specs (the research "avoid-list"): no
// decorative bars/stripes/underlines, top-left aligned titles, one gap value
// (space.gapIn) across all layouts, no card grid on more than 1-in-5 slides
// (enforced by the plan validator, not here).
import { tokens } from "./tokens";

export type SlideStyle =
  | "coverTitle"
  | "coverSubtitle"
  | "coverMeta"
  | "sectionKicker"
  | "sectionTitle"
  | "contentTitle"
  | "body"
  | "subTitle"
  | "bullets"
  | "caption"
  | "kpiValue"
  | "kpiLabel"
  | "quote"
  | "statement"
  | "table";

export type SlotContent =
  | "text"
  | "bullets"
  | "chart"
  | "kpis"
  | "table"
  | "steps";

export interface SlotSpec {
  id: string;
  /** [x, y, w, h] in inches on the deck canvas. */
  rect: [number, number, number, number];
  style: SlideStyle;
  content: SlotContent;
  required: boolean;
  /** Max item count for multi-item slots (bullets, kpis, steps, table rows). */
  maxItems?: number;
  /** Max characters per item for multi-item slots. */
  maxItemChars?: number;
  /** Max table columns (table slots only). */
  maxCols?: number;
}

export interface DeckLayout {
  id: string;
  /** Content master ("DD_light") or dark master ("DD_dark"). */
  master: "DD_light" | "DD_dark";
  /** Slots that default to empty-optional when the model omits them. */
  slots: SlotSpec[];
  /** One-line hint shown in the planner guide. */
  hint: string;
}

const M = tokens.space.deck.marginIn;
const W = tokens.space.deck.widthIn;
const CONTENT_W = W - 2 * M;

const titleSlot = (required = true): SlotSpec => ({
  id: "title",
  rect: [M, 0.4, CONTENT_W, 0.95],
  style: "contentTitle",
  content: "text",
  required,
});

const sourceSlot = (): SlotSpec => ({
  id: "source",
  rect: [M, 6.95, CONTENT_W, 0.35],
  style: "caption",
  content: "text",
  required: false,
});

export const DECK_LAYOUTS: Record<string, DeckLayout> = {
  cover: {
    id: "cover",
    master: "DD_dark",
    hint: "Title slide — full-bleed dark background, title/subtitle lower-left.",
    slots: [
      { id: "meta", rect: [0.7, 4.0, W - 1.4, 0.4], style: "coverMeta", content: "text", required: false },
      { id: "title", rect: [0.7, 4.5, W - 1.4, 1.6], style: "coverTitle", content: "text", required: true },
      { id: "subtitle", rect: [0.7, 6.2, W - 1.4, 0.7], style: "coverSubtitle", content: "text", required: false },
    ],
  },
  section: {
    id: "section",
    master: "DD_dark",
    hint: "Section divider — numbered kicker + section name on dark background.",
    slots: [
      { id: "kicker", rect: [0.7, 2.7, W - 1.4, 0.5], style: "sectionKicker", content: "text", required: false },
      { id: "title", rect: [0.7, 3.3, W - 1.4, 1.3], style: "sectionTitle", content: "text", required: true },
    ],
  },
  bullets: {
    id: "bullets",
    master: "DD_light",
    hint: "Workhorse content slide — headline + up to 6 bullets.",
    slots: [
      titleSlot(),
      { id: "eyebrow", rect: [M, 1.42, CONTENT_W, 0.35], style: "caption", content: "text", required: false },
      { id: "bullets", rect: [M, 1.9, CONTENT_W, 4.8], style: "bullets", content: "bullets", required: true, maxItems: 6, maxItemChars: 110 },
    ],
  },
  agenda: {
    id: "agenda",
    master: "DD_light",
    hint: "Agenda — numbered list of the deck's sections.",
    slots: [
      titleSlot(),
      { id: "items", rect: [M, 1.7, CONTENT_W, 5.0], style: "bullets", content: "bullets", required: true, maxItems: 7, maxItemChars: 90 },
    ],
  },
  "two-col": {
    id: "two-col",
    master: "DD_light",
    hint: "Comparison — two labeled bullet columns (options, before/after, pros/cons).",
    slots: [
      titleSlot(),
      { id: "leftTitle", rect: [M, 1.55, 5.87, 0.55], style: "subTitle", content: "text", required: true },
      { id: "leftBullets", rect: [M, 2.2, 5.87, 4.5], style: "bullets", content: "bullets", required: true, maxItems: 5, maxItemChars: 90 },
      { id: "rightTitle", rect: [6.96, 1.55, 5.87, 0.55], style: "subTitle", content: "text", required: true },
      { id: "rightBullets", rect: [6.96, 2.2, 5.87, 4.5], style: "bullets", content: "bullets", required: true, maxItems: 5, maxItemChars: 90 },
    ],
  },
  "chart-text": {
    id: "chart-text",
    master: "DD_light",
    hint: "Chart left, takeaway prose right — the analysis workhorse.",
    slots: [
      titleSlot(),
      { id: "chart", rect: [M, 1.6, 7.6, 5.1], style: "caption", content: "chart", required: true },
      { id: "body", rect: [8.4, 1.6, 4.43, 5.1], style: "body", content: "text", required: true },
      sourceSlot(),
    ],
  },
  "chart-full": {
    id: "chart-full",
    master: "DD_light",
    hint: "Full-width chart for a single dense visual.",
    slots: [
      titleSlot(),
      { id: "chart", rect: [M, 1.6, CONTENT_W, 5.1], style: "caption", content: "chart", required: true },
      sourceSlot(),
    ],
  },
  kpi: {
    id: "kpi",
    master: "DD_light",
    hint: "Exactly 3 big numbers with labels and deltas — the stats slide.",
    slots: [
      titleSlot(),
      { id: "kpis", rect: [M, 1.9, CONTENT_W, 4.4], style: "kpiValue", content: "kpis", required: true, maxItems: 3 },
      sourceSlot(),
    ],
  },
  quote: {
    id: "quote",
    master: "DD_light",
    hint: "A single quote with attribution — breathing room between dense slides.",
    slots: [
      { id: "quote", rect: [1.2, 2.2, W - 2.4, 2.7], style: "quote", content: "text", required: true },
      { id: "attribution", rect: [1.2, 5.1, W - 2.4, 0.5], style: "caption", content: "text", required: false },
    ],
  },
  timeline: {
    id: "timeline",
    master: "DD_light",
    hint: "3–4 milestones on a horizontal line.",
    slots: [
      titleSlot(),
      { id: "steps", rect: [M, 2.6, CONTENT_W, 3.4], style: "body", content: "steps", required: true, maxItems: 4, maxItemChars: 90 },
    ],
  },
  table: {
    id: "table",
    master: "DD_light",
    hint: "Data table — short cells, header row auto-styled.",
    slots: [
      titleSlot(),
      { id: "table", rect: [M, 1.6, CONTENT_W, 5.0], style: "table", content: "table", required: true, maxItems: 8, maxItemChars: 60, maxCols: 5 },
      sourceSlot(),
    ],
  },
  statement: {
    id: "statement",
    master: "DD_light",
    hint: "One bold sentence, centered space — use for the single takeaway.",
    slots: [
      { id: "statement", rect: [1.2, 2.5, W - 2.4, 2.5], style: "statement", content: "text", required: true },
      { id: "context", rect: [1.2, 5.2, W - 2.4, 0.6], style: "caption", content: "text", required: false },
    ],
  },
  closing: {
    id: "closing",
    master: "DD_dark",
    hint: "Thank-you / contact slide on dark background — always the last slide.",
    slots: [
      { id: "title", rect: [0.7, 3.1, W - 1.4, 1.3], style: "sectionTitle", content: "text", required: true },
      { id: "contact", rect: [0.7, 4.5, W - 1.4, 0.6], style: "coverSubtitle", content: "text", required: false },
    ],
  },
};

export const DECK_LAYOUT_IDS = Object.keys(DECK_LAYOUTS);

export function getLayout(id: string): DeckLayout | undefined {
  return DECK_LAYOUTS[id];
}

// --- text-fit math -----------------------------------------------------------
// Average glyph width for Calibri/Segoe at a given pt size, as a fraction of
// the point size. ~0.50 covers mixed-case prose.
export const AVG_GLYPH_EM = 0.5;
/** Line height multiple used for fit estimates (matches deck leading). */
export const FIT_LINE_HEIGHT = 1.25;

/** How many characters fit on one line of `widthIn` inches at `pt`. */
export function charsPerLine(widthIn: number, pt: number): number {
  return Math.max(4, Math.floor((widthIn * 72) / (pt * AVG_GLYPH_EM)));
}

/** How many rendered lines of `pt` text fit in `heightIn` inches. */
export function maxLines(heightIn: number, pt: number): number {
  return Math.max(1, Math.floor((heightIn * 72) / (pt * FIT_LINE_HEIGHT)));
}

const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Width of `text` in em units: latin ≈ 0.5 em, CJK/full-width = 1 em. */
export function weightedEmLength(text: string): number {
  let em = 0;
  for (const ch of text) em += CJK_RE.test(ch) ? 1 : AVG_GLYPH_EM;
  return em;
}

/** True when `text` fits its slot. CJK glyphs count double-width, so CJK
 *  copy overflows earlier — the same signal as the char-budget factor. */
export function textFits(text: string, widthIn: number, heightIn: number, pt: number): boolean {
  const linesNeeded = Math.ceil((weightedEmLength(text) * pt) / (widthIn * 72));
  return linesNeeded <= maxLines(heightIn, pt);
}
