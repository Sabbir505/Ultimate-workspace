// docdesign — shared design-token layer for document/deck/PDF generation.
//
// `tokens.json` is the single source of truth for every generator in the app
// (the JS document engines, the HTML→PDF print CSS, and the bundled Python
// helper, which all embed or load the same file). Change a token here and it
// propagates to every engine; nothing else hardcodes fonts, sizes, or colors.
//
// Hex colors are stored WITHOUT a leading '#' (the PptxGenJS requirement —
// a '#' corrupts the OOXML). Use `hash()` at format boundaries that want it.
import raw from "./tokens.json";

export interface ThemeColors {
  ink: string;
  muted: string;
  accent: string;
  accent2: string;
  tint: string;
  surface: string;
  bg: string;
  hair: string;
  onAccent: string;
  coverBg: string;
  coverFg: string;
  coverMuted: string;
  coverAccent: string;
}

export interface Theme {
  id: string;
  name: string;
  color: ThemeColors;
  chartPalette: string[];
}

export interface DocTypeScale {
  displayPt: number;
  h1Pt: number;
  h2Pt: number;
  h3Pt: number;
  bodyPt: number;
  captionPt: number;
  codePt: number;
  leadingCss: number;
  leadingDocx: number;
}

export interface DeckTypeScale {
  titlePt: number;
  contentTitlePt: number;
  sectionTitlePt: number;
  eyebrowPt: number;
  bodyPt: number;
  captionPt: number;
  kpiValuePt: number;
  kpiLabelPt: number;
  quotePt: number;
  statementPt: number;
  tablePt: number;
  leading: number;
}

export interface DeckSpace {
  widthIn: number;
  heightIn: number;
  marginIn: number;
  gapIn: number;
}

export interface Tokens {
  version: number;
  defaultTheme: string;
  aliases: Record<string, string>;
  faces: { display: Face; body: Face; mono: Face };
  type: { doc: DocTypeScale; deck: DeckTypeScale };
  space: {
    pdfMarginMm: [number, number];
    docxMarginIn: [number, number, number, number];
    deck: DeckSpace;
  };
  chart: { sourceNotePt: number; axisLabelPt: number; legendPt: number };
  themes: Record<string, Theme>;
}

interface Face {
  primary: string;
  cssStack: string;
}

export const tokens = raw as unknown as Tokens;

/** Prepend '#' — for CSS contexts. Never use for PptxGenJS values. */
export const hash = (hex: string): string => (hex.startsWith("#") ? hex : `#${hex}`);

/** Resolve aliases ("blue" → "ink") and unknown names to the default theme. */
export function canonicalThemeId(name: string | null | undefined): string {
  const key = (name ?? "").trim().toLowerCase();
  if (key && tokens.themes[key]) return key;
  if (key && tokens.aliases[key]) return tokens.aliases[key];
  return tokens.defaultTheme;
}

export function getTheme(name: string | null | undefined): Theme {
  const id = canonicalThemeId(name);
  const t = tokens.themes[id];
  return { id, name: t.name, color: t.color, chartPalette: t.chartPalette };
}

export function themeIds(): string[] {
  return Object.keys(tokens.themes);
}

/** First font of a stack — OOXML/pptxgenjs take a single face name. */
export const facePrimary = (face: "display" | "body" | "mono"): string =>
  tokens.faces[face].primary;

const HEX_RE = /^[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

/** WCAG relative luminance of a 6-digit hex color. */
export function luminance(hex: string): number {
  const srgb = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/** WCAG contrast ratio between two 6-digit hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Rough CJK share of a string (used to shrink char budgets — CJK glyphs are
 *  full-width, so the same box fits ~15% fewer of them). */
export function cjkRatio(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? []).length;
  return cjk / text.length;
}
