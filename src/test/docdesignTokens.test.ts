// Tests for the shared docdesign token layer: parse integrity, alias
// resolution, hex hygiene (no '#'), WCAG contrast floors, and the CJK ratio
// helper used by layout budgets.
import {
  canonicalThemeId,
  contrastRatio,
  cjkRatio,
  facePrimary,
  getTheme,
  hash,
  isHexColor,
  themeIds,
  tokens,
} from "../lib/docdesign/tokens";

describe("docdesign tokens", () => {
  it("ships seven themes with a stable default", () => {
    expect(themeIds().sort()).toEqual(
      ["amber", "crimson", "emerald", "ink", "midnight", "plum", "teal"].sort(),
    );
    expect(tokens.defaultTheme).toBe("ink");
    expect(tokens.version).toBe(1);
  });

  it("resolves aliases and unknown names to a real theme", () => {
    expect(canonicalThemeId("blue")).toBe("ink");
    expect(canonicalThemeId("purple")).toBe("plum");
    expect(canonicalThemeId("RED")).toBe("crimson");
    expect(canonicalThemeId("nonexistent")).toBe("ink");
    expect(canonicalThemeId(undefined)).toBe("ink");
    expect(getTheme("blue").id).toBe("ink");
    expect(getTheme("nope").id).toBe("ink");
  });

  it("stores colors as bare 6-digit hex (pptxgenjs corrupts on '#')", () => {
    for (const id of themeIds()) {
      const theme = getTheme(id);
      for (const [key, value] of Object.entries(theme.color)) {
        expect(isHexColor(value)).toBe(true);
        expect(value.startsWith("#")).toBe(false);
        expect(key.length).toBeGreaterThan(0);
      }
      expect(theme.chartPalette.length).toBeGreaterThanOrEqual(4);
      for (const c of theme.chartPalette) expect(isHexColor(c)).toBe(true);
    }
  });

  it("hash() adds exactly one '#'", () => {
    expect(hash("14161C")).toBe("#14161C");
    expect(hash("#14161C")).toBe("#14161C");
  });

  it("meets WCAG 4.5:1 for body and cover text in every theme", () => {
    for (const id of themeIds()) {
      const t = getTheme(id);
      expect(contrastRatio(t.color.ink, t.color.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.color.coverFg, t.color.coverBg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("exposes single face names for OOXML and CSS stacks for print", () => {
    expect(facePrimary("display")).toBe("Georgia");
    expect(facePrimary("body")).toBe("Calibri");
    expect(facePrimary("mono")).toBe("Consolas");
    expect(tokens.faces.body.cssStack).toContain("Calibri");
  });

  it("shares deck geometry with the 16:9 canvas and print margins", () => {
    expect(tokens.space.deck.widthIn).toBeCloseTo(13.333, 2);
    expect(tokens.space.deck.heightIn).toBe(7.5);
    expect(tokens.space.pdfMarginMm).toEqual([20, 17]);
    expect(tokens.space.docxMarginIn).toEqual([1.05, 1.0, 1.15, 1.15]);
  });

  it("estimates CJK share for budget scaling", () => {
    expect(cjkRatio("hello world")).toBe(0);
    expect(cjkRatio("")).toBe(0);
    expect(cjkRatio("测试测试")).toBe(1);
    expect(cjkRatio("abc测试")).toBeCloseTo(0.4, 5);
  });
});
