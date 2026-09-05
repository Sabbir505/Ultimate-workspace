// Tests for the deck plan IR (L1 validation) and the PptxGenJS compiler (L2).
import { charsPerLine, maxLines, textFits } from "../lib/docdesign/catalog";
import { compileDeck } from "../lib/docdesign/compileDeck";
import { validateDeckPlan, type DeckPlan } from "../lib/docdesign/ir";
import { getTheme } from "../lib/docdesign/tokens";

function validPlan(): DeckPlan {
  return {
    v: 1,
    kind: "deck",
    title: "Q3 Reliability Review",
    slides: [
      {
        id: "s1",
        layout: "cover",
        slots: {
          title: "Q3 Reliability Review",
          subtitle: "Incidents, fixes, and the path to 99.95%",
          meta: "Platform team · September 2026",
        },
      },
      {
        id: "s2",
        layout: "bullets",
        slots: {
          title: "What changed this quarter",
          bullets: ["Shipped the retry budget", "Cut cold-start latency", "Closed the cache stampede"],
        },
        notes: "Open with the two Sev-1s, then the trend.",
      },
      {
        id: "s3",
        layout: "chart-text",
        slots: {
          title: "Error budget burn tracked the incident clusters",
          chart: { type: "line", labels: ["Jul", "Aug", "Sep"], series: [{ name: "Burn rate", values: [0.4, 1.2, 0.7] }] },
          body: "Burn crossed 1.0 twice; both clusters map to fixes shipped in the same sprint.",
        },
      },
      {
        id: "s4",
        layout: "kpi",
        slots: {
          title: "Quarter at a glance",
          kpis: [
            { label: "Uptime", value: "99.96%", delta: "+0.04 pp", trend: "up" },
            { label: "Sev-1 incidents", value: "2", delta: "-3 vs Q2", trend: "down" },
            { label: "MTTR", value: "42 min", delta: "-18 min", trend: "down" },
          ],
        },
      },
      { id: "s5", layout: "closing", slots: { title: "Thank you", contact: "platform@acme.dev" } },
    ],
  };
}

describe("deck plan validation (L1)", () => {
  it("accepts a well-formed plan with only benign warnings", () => {
    const { plan, issues } = validateDeckPlan(validPlan());
    expect(plan).not.toBeNull();
    expect(plan!.slides).toHaveLength(5);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("rejects non-objects, wrong kinds, and empty slide lists", () => {
    expect(validateDeckPlan(null).plan).toBeNull();
    expect(validateDeckPlan("nope").plan).toBeNull();
    expect(validateDeckPlan({ v: 1, kind: "doc", slides: [] }).plan).toBeNull();
    const bad = validateDeckPlan({ v: 1, kind: "deck", title: "x", slides: [] });
    expect(bad.plan).toBeNull();
    expect(bad.issues.some((i) => i.message.includes("non-empty"))).toBe(true);
  });

  it("rejects unknown layouts with the catalog list", () => {
    const plan = validPlan();
    (plan.slides[1] as { layout: string }).layout = "wordcloud";
    const { plan: out, issues } = validateDeckPlan(plan);
    expect(out).toBeNull();
    expect(issues.some((i) => i.rule === "catalog" && i.message.includes("wordcloud"))).toBe(true);
  });

  it("flags missing required slots with an IR pointer", () => {
    const plan = validPlan();
    delete (plan.slides[2].slots as Record<string, unknown>).body;
    const { plan: out, issues } = validateDeckPlan(plan);
    expect(out).toBeNull();
    const missing = issues.find((i) => i.rule === "slots" && i.message.includes('"body"'));
    expect(missing?.pointer).toBe("slides[id=s3].slots.body");
  });

  it("enforces bullet count budgets", () => {
    const plan = validPlan();
    plan.slides[1].slots.bullets = Array.from({ length: 8 }, (_, i) => `Point ${i}`);
    const { plan: out, issues } = validateDeckPlan(plan);
    expect(out).toBeNull();
    expect(issues.some((i) => i.rule === "budget" && i.message.includes("max of 6"))).toBe(true);
  });

  it("enforces per-item char budgets, tightened for CJK", () => {
    const plan = validPlan();
    const latin = "x".repeat(140);
    plan.slides[1].slots.bullets = [latin];
    const latinResult = validateDeckPlan(plan);
    expect(latinResult.issues.some((i) => i.rule === "budget")).toBe(true);

    // 110 CJK glyphs count ~15% heavier than 110 latin chars: must also fail.
    const cjkPlan = validPlan();
    cjkPlan.slides[1].slots.bullets = ["测".repeat(105)];
    expect(validateDeckPlan(cjkPlan).issues.some((i) => i.rule === "budget")).toBe(true);
  });

  it("validates chart series/label alignment", () => {
    const plan = validPlan();
    (plan.slides[2].slots.chart as { series: { values: number[] }[] }).series[0].values = [1, 2];
    const { plan: out, issues } = validateDeckPlan(plan);
    expect(out).toBeNull();
    expect(issues.some((i) => i.rule === "chart" && i.message.includes("2 values but there are 3"))).toBe(true);
  });

  it("requires exactly three KPIs", () => {
    const plan = validPlan();
    (plan.slides[3].slots.kpis as unknown[]).push({ label: "Extra", value: "4" });
    const { plan: out, issues } = validateDeckPlan(plan);
    expect(out).toBeNull();
    expect(issues.some((i) => i.message.includes("exactly 3 stats"))).toBe(true);
  });

  it("warns on missing cover/closing bookends and layout runs", () => {
    const plan = validPlan();
    plan.slides = plan.slides.slice(1, 4); // bullets, chart-text, kpi
    const { plan: out, issues } = validateDeckPlan(plan);
    expect(out).not.toBeNull();
    expect(issues.some((i) => i.rule === "coherence" && i.message.includes("open with a cover"))).toBe(true);
    expect(issues.some((i) => i.rule === "coherence" && i.message.includes("close with a closing"))).toBe(true);

    const runny = validPlan();
    runny.slides = [
      runny.slides[0],
      { id: "b1", layout: "bullets", slots: { title: "t", bullets: ["a"] } },
      { id: "b2", layout: "bullets", slots: { title: "t", bullets: ["a"] } },
      { id: "b3", layout: "bullets", slots: { title: "t", bullets: ["a"] } },
      { id: "b4", layout: "bullets", slots: { title: "t", bullets: ["a"] } },
      runny.slides[4],
    ];
    const runResult = validateDeckPlan(runny);
    expect(runResult.issues.some((i) => i.message.includes("consecutive"))).toBe(true);
  });

  it("auto-assigns slide ids when missing and rejects duplicates", () => {
    const plan = validPlan();
    for (const s of plan.slides) delete (s as { id?: string }).id;
    const { plan: out } = validateDeckPlan(plan);
    expect(out?.slides.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    const dup = validPlan();
    dup.slides[1].id = "s1";
    expect(validateDeckPlan(dup).issues.some((i) => i.message.includes("duplicate slide id"))).toBe(true);
  });
});

describe("text-fit math", () => {
  it("fits and overflows predictably", () => {
    // Content-title slot: one 28pt line fits ~63 latin chars.
    const perLine = charsPerLine(12.33, 28);
    expect(perLine).toBeGreaterThan(20);
    expect(maxLines(0.95, 28)).toBe(1);
    expect(textFits("x".repeat(perLine), 12.33, 0.95, 28)).toBe(true);
    expect(textFits("x".repeat(perLine + 10), 12.33, 0.95, 28)).toBe(false);
    // CJK glyphs count double-width, so the same slot overflows sooner.
    expect(textFits("测".repeat(Math.floor(perLine / 2)), 12.33, 0.95, 28)).toBe(true);
    expect(textFits("测".repeat(Math.floor(perLine / 2) + 4), 12.33, 0.95, 28)).toBe(false);
    // Body slot fits many lines.
    expect(maxLines(4.8, 16)).toBeGreaterThanOrEqual(15);
  });
});

describe("deck compiler (L2)", () => {
  it("emits a deterministic, token-styled PptxGenJS program", () => {
    const theme = getTheme("ink");
    const { code, checks } = compileDeck(validateDeckPlan(validPlan()).plan!, theme);
    // Canvas + layout
    expect(code).toContain('pptx.defineLayout({ name: "DD_16x9", width: 13.333, height: 7.5 })');
    expect(code).toContain('pptx.layout = "DD_16x9"');
    // Masters from theme colors
    expect(code).toContain(`background: { color: "${theme.color.bg}" }`);
    expect(code).toContain(`background: { color: "${theme.color.coverBg}" }`);
    // Slide count + closing save
    expect(code.match(/addSlide\(/g)?.length).toBe(5);
    expect(code.match(/relay\.save\(/g)?.length).toBe(1);
    // Charts: native, no dLblPos, palette colors bare
    expect(code).toContain("pptx.ChartType.line");
    expect(code).not.toContain("dLblPos");
    expect(code).toContain(`chartColors: ["${theme.chartPalette[0]}"]`);
    // Fonts come from tokens
    expect(code).toContain('fontFace: "Georgia"');
    expect(code).toContain('fontFace: "Calibri"');
    // Notes survive
    expect(code).toContain("addNotes");
    // All L2 invariants pass
    expect(checks.issues).toHaveLength(0);
    expect(checks.passed.length).toBeGreaterThanOrEqual(6);
  });

  it("renders KPI values, labels and trend deltas", () => {
    const { code } = compileDeck(validateDeckPlan(validPlan()).plan!, getTheme("ink"));
    expect(code).toContain('"99.96%"');
    expect(code).toContain("↑ +0.04 pp");
    expect(code).toContain("↓ -3 vs Q2");
    expect(code).toContain('"Sev-1 incidents"');
  });

  it("renders tables with header styling and even column widths", () => {
    const plan = validPlan();
    plan.slides.splice(4, 0, {
      id: "t1",
      layout: "table",
      slots: {
        title: "Incident log",
        table: [
          ["Date", "Severity", "Duration"],
          ["Aug 12", "Sev-1", "3h 10m"],
          ["Sep 3", "Sev-1", "1h 45m"],
        ],
        source: "Status page export",
      },
    });
    const { code, checks } = compileDeck(validateDeckPlan(plan).plan!, getTheme("ink"));
    expect(code).toContain("addTable");
    expect(code).toContain('options: { bold: true, color: "14161C", fill: { color: "EEF2FE" } }');
    expect(checks.issues).toHaveLength(0);
  });

  it("uses different palettes per theme", () => {
    const ink = compileDeck(validateDeckPlan(validPlan()).plan!, getTheme("ink"));
    const emerald = compileDeck(validateDeckPlan(validPlan()).plan!, getTheme("emerald"));
    expect(ink.code).toContain('"2F55E0"');
    expect(emerald.code).toContain('"0E9F6E"');
    expect(emerald.code).not.toContain('"2F55E0"');
  });

  it("emits bullet arrays with breakLine runs", () => {
    const { code } = compileDeck(validateDeckPlan(validPlan()).plan!, getTheme("ink"));
    expect(code).toContain("{ text: \"Shipped the retry budget\", options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } }");
  });

  it("truncates over-long speaker notes at compile time", () => {
    const plan = validPlan();
    plan.slides[0].notes = "n".repeat(900);
    const { code } = compileDeck(plan, getTheme("ink"));
    const notes = code.match(/addNotes\("(.+)"\)/);
    expect(notes).not.toBeNull();
    expect(notes![1].length).toBeLessThanOrEqual(500);
  });
});
