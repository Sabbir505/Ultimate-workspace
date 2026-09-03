// Tests for named design systems: preset integrity, theme resolution, and
// the layout-fit coherence check.
import { checkSystemFit, getSystem, resolveTheme, systemIds } from "../lib/docdesign/systems";
import { DECK_LAYOUT_IDS } from "../lib/docdesign/catalog";
import { getTheme, themeIds } from "../lib/docdesign/tokens";

describe("design systems", () => {
  it("ships four presets whose themes and layouts all exist", () => {
    expect(systemIds().sort()).toEqual(["consulting", "editorial", "minimal", "product"].sort());
    for (const id of systemIds()) {
      const sys = getSystem(id)!;
      expect(themeIds()).toContain(sys.defaultTheme);
      expect(getTheme(sys.defaultTheme).id).toBe(sys.defaultTheme);
      for (const layout of sys.layouts) {
        expect(DECK_LAYOUT_IDS).toContain(layout);
      }
      expect(sys.voice.length).toBeGreaterThan(10);
      expect(sys.kinds.length).toBeGreaterThan(0);
    }
  });

  it("unknown systems resolve to undefined", () => {
    expect(getSystem("nope")).toBeUndefined();
    expect(getSystem(undefined)).toBeUndefined();
  });

  it("resolves theme: explicit theme beats system default", () => {
    expect(resolveTheme("amber", "consulting")).toBe("amber");
    expect(resolveTheme(undefined, "consulting")).toBe("midnight");
    expect(resolveTheme(null, undefined)).toBe("ink");
    expect(resolveTheme("purple", "editorial")).toBe("plum");
  });

  it("warns when a plan strays outside the system layout subset", () => {
    const sys = getSystem("minimal")!;
    const slides = [
      { layout: "cover" },
      { layout: "bullets" },
      { layout: "kpi" }, // not in minimal
    ];
    const issues = checkSystemFit(slides, "minimal");
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("kpi");
    expect(issues[0].message).toContain("Minimal");

    // In-subset plans produce nothing; unknown systems produce nothing.
    expect(checkSystemFit([{ layout: "cover" }], "minimal")).toHaveLength(0);
    expect(checkSystemFit(slides, "nope")).toHaveLength(0);
    expect(checkSystemFit(slides, undefined)).toHaveLength(0);
    // Unknown layout ids are the catalog validator's job, not the system's.
    expect(checkSystemFit([{ layout: "wordcloud" }], "minimal")).toHaveLength(0);
  });
});
