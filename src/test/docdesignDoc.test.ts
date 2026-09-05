// Tests for the document plan IR (L1) and both document compilers —
// compileDoc (docx npm program) and compilePdfHtml (print-engine HTML).
import { compileDoc } from "../lib/docdesign/compileDoc";
import { compilePdfHtml, utf8ToBase64 } from "../lib/docdesign/compilePdfHtml";
import { validateDocPlan, type DocPlan } from "../lib/docdesign/irDoc";
import { getTheme } from "../lib/docdesign/tokens";

function validDoc(): DocPlan {
  return {
    v: 1,
    kind: "doc",
    title: "Q3 Reliability Review",
    subtitle: "Incidents, fixes, and the path to 99.95%",
    author: "Platform Team",
    sections: [
      {
        id: "sec1",
        heading: "Overview",
        blocks: [
          { type: "paragraph", text: "Availability recovered to target in September after two Sev-1 incidents." },
          { type: "callout", text: "Both incident clusters map to fixes shipped in the same sprint." },
          { type: "bullets", items: ["Retry budgets shipped", "Cold-start latency cut"] },
        ],
      },
      {
        id: "sec2",
        heading: "Incident log",
        blocks: [
          {
            type: "table",
            columns: ["Date", "Severity", "Duration"],
            rows: [
              ["Aug 12", "Sev-1", "3h 10m"],
              ["Sep 3", "Sev-1", "1h 45m"],
            ],
            source: "Status page export",
          },
          {
            type: "kpi-strip",
            kpis: [
              { label: "Uptime", value: "99.96%", delta: "+0.04 pp" },
              { label: "MTTR", value: "42 min", delta: "-18 min" },
              { label: "Sev-1", value: "2" },
            ],
          },
          { type: "quote", text: "The retry budget was the single highest-leverage change.", attribution: "Postmortem 2026-09" },
        ],
      },
    ],
  };
}

describe("doc plan validation (L1)", () => {
  it("accepts a well-formed plan", () => {
    const { plan, issues } = validateDocPlan(validDoc());
    expect(plan).not.toBeNull();
    expect(plan!.sections).toHaveLength(2);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("rejects wrong kinds and empty sections with pointers", () => {
    expect(validateDocPlan({ v: 1, kind: "deck", sections: [] }).plan).toBeNull();
    const bad = validateDocPlan({ v: 1, kind: "doc", title: "x", sections: [] });
    expect(bad.plan).toBeNull();
    expect(bad.issues.some((i) => i.message.includes("non-empty"))).toBe(true);
    const noHeading = validateDocPlan({
      v: 1, kind: "doc", title: "x",
      sections: [{ id: "a", heading: "", blocks: [{ type: "paragraph", text: "hi" }] }],
    });
    expect(noHeading.plan).toBeNull();
    expect(noHeading.issues.some((i) => i.pointer === "sections[id=a]")).toBe(true);
  });

  it("steers charts to tables (docx cannot embed live charts)", () => {
    const plan = validDoc();
    (plan.sections[0].blocks as unknown[]).push({
      type: "chart",
      chart: { type: "bar", labels: ["a"], series: [{ name: "x", values: [1] }] },
    });
    const { plan: out, issues } = validateDocPlan(plan);
    expect(out).toBeNull();
    expect(issues.some((i) => i.message.includes("table or kpi-strip"))).toBe(true);
  });

  it("enforces prose budgets", () => {
    const plan = validDoc();
    (plan.sections[0].blocks[0] as { text: string }).text = "x".repeat(1600);
    expect(validateDocPlan(plan).issues.some((i) => i.rule === "budget" && i.message.includes("1500"))).toBe(true);

    const callout = validDoc();
    (callout.sections[0].blocks[1] as { text: string }).text = "x".repeat(400);
    expect(validateDocPlan(callout).issues.some((i) => i.message.includes("callout"))).toBe(true);
  });

  it("enforces table shape", () => {
    const plan = validDoc();
    const table = plan.sections[1].blocks[0] as { rows: string[][] };
    table.rows[0] = ["only", "two"];
    const { issues } = validateDocPlan(plan);
    expect(issues.some((i) => i.message.includes("expected 3"))).toBe(true);
  });

  it("warns when a report has a single section", () => {
    const plan = validDoc();
    plan.sections = [plan.sections[0]];
    const { plan: out, issues } = validateDocPlan(plan);
    expect(out).not.toBeNull();
    expect(issues.some((i) => i.rule === "coherence" && i.message.includes("memo"))).toBe(true);
  });
});

describe("docx compiler (L2)", () => {
  it("emits a styled Document program with token-driven styles", () => {
    const theme = getTheme("ink");
    const { code, checks } = compileDoc(validateDocPlan(validDoc()).plan!, theme);
    expect(code).toContain("new Document({");
    // Token styles on the document defaults
    expect(code).toContain('font: "Calibri", size: 22, color: "14161C"');
    expect(code).toContain('heading1: { run: { font: "Georgia", size: 48');
    expect(code).toContain("spacing: { line: 341");
    // Cover + sections + closing save
    expect(code.match(/HeadingLevel\.HEADING_1/g)?.length).toBe(2);
    expect(code.match(/relay\.save\(/g)?.length).toBe(1);
    expect(code).toContain("new PageBreak()");
    // Numbering config not emitted (no numbered lists in fixture)
    expect(code).not.toContain("dd-num");
    expect(checks.issues).toHaveLength(0);
    expect(checks.passed.length).toBeGreaterThanOrEqual(4);
  });

  it("emits numbering config only when numbered lists exist", () => {
    const plan = validDoc();
    plan.sections[0].blocks.splice(2, 1, { type: "numbered", items: ["First", "Second"] });
    const { code } = compileDoc(plan, getTheme("ink"));
    expect(code).toContain('reference: "dd-num"');
    expect(code).toContain('numbering: { reference: "dd-num", level: 0 }');
  });

  it("renders tables with tinted headers and repeat/cantSplit rows", () => {
    const theme = getTheme("ink");
    const { code } = compileDoc(validateDocPlan(validDoc()).plan!, theme);
    expect(code).toContain("tableHeader: true, cantSplit: true");
    expect(code).toContain(`shading: { fill: "${theme.color.tint}" }`);
    expect(code).toContain('"Source: Status page export"');
  });

  it("renders KPI strips with accent values", () => {
    const { code } = compileDoc(validateDocPlan(validDoc()).plan!, getTheme("ink"));
    expect(code).toContain('"99.96%"');
    expect(code).toContain("bold: true, color: \"2F55E0\"");
    expect(code).toContain('"Uptime (+0.04 pp)"');
  });
});

describe("pdf HTML compiler (L2)", () => {
  it("emits themed, self-contained print HTML", () => {
    const theme = getTheme("emerald");
    const fixed = new Date("2026-09-04T12:00:00Z");
    const { html, checks } = compilePdfHtml(validateDocPlan(validDoc()).plan!, theme, fixed);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`#${theme.color.coverBg}`);
    expect(html).toContain(`#${theme.color.accent}`);
    expect(html).toContain(`class="doc-section"`);
    expect(html.match(/class="doc-section"/g)?.length).toBe(2);
    expect(html).toContain("counter(page)");
    expect(html).toContain("Q3 Reliability Review");
    expect(html).toContain("September 4, 2026");
    // Invariants
    expect(checks.issues).toHaveLength(0);
    expect(/<script/i.test(html)).toBe(false);
    expect(/src="http|<link\s|@import/i.test(html)).toBe(false);
  });

  it("escapes model content so prose cannot break the markup", () => {
    const plan = validDoc();
    plan.sections[0].blocks[0] = { type: "paragraph", text: "Use <b> carefully & \"quotes\"." };
    const { html } = compilePdfHtml(plan, getTheme("ink"));
    expect(html).toContain("&lt;b&gt; carefully &amp; &quot;quotes&quot;.");
    expect(html).not.toContain("<b> carefully");
  });

  it("base64-encodes the HTML payload as UTF-8", () => {
    const b64 = utf8ToBase64("<p>héllo 测试</p>");
    const decoded = decodeURIComponent(escape(atob(b64)));
    expect(decoded).toBe("<p>héllo 测试</p>");
  });
});
