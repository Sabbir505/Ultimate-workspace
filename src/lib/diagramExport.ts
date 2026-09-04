// Pure helpers for diagram raster export (PNG/JPG) — shared by the export
// menu UI and unit-tested in isolation (see src/test/diagramExport.test.ts).

/** Scale factors offered for raster export. 3× is the default: Retina- and
 *  slide-safe without the file size of 4×. (The old hardcode was 2×, which
 *  came out soft on projectors and in print.) */
export const EXPORT_SCALES = [1, 2, 3, 4] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];
export const DEFAULT_EXPORT_SCALE: ExportScale = 3;

/** Raster canvas size for a diagram of intrinsic size w×h at `scale` —
 *  rounded and clamped to at least 1px per side. */
export function computeRasterSize(
  w: number,
  h: number,
  scale: number,
): { w: number; h: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    w: Math.max(1, Math.round(w * s)),
    h: Math.max(1, Math.round(h * s)),
  };
}

/** Intrinsic pixel size of a standalone SVG string, from its width/height or
 *  viewBox. Returns 0s when neither is present (caller falls back to the
 *  loaded image's natural size). */
export function svgPixelSize(svg: string): { w: number; h: number } {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const w = tag.match(/\bwidth="([\d.]+)(?:px)?"/i);
  const h = tag.match(/\bheight="([\d.]+)(?:px)?"/i);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = tag.match(/viewBox="([^"]+)"/i);
  if (vb) {
    const p = vb[1].split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) return { w: p[2], h: p[3] };
  }
  return { w: 0, h: 0 };
}

/** The background actually painted for an export. PNG honors "transparent"
 *  (alpha preserved); JPEG has no alpha channel — a transparent backdrop
 *  would encode as solid black — so it is forced to opaque white. */
export function effectiveExportBackground(
  fallbackBg: string,
  format: "png" | "jpeg",
  transparent: boolean,
): string {
  if (transparent && format === "png") return "transparent";
  return fallbackBg || "#ffffff";
}
