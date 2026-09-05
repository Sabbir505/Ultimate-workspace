// A8 (ISSUES.md): the PDF compiler emitted the deck KPI-strip gap token —
// which is measured in INCHES (space.deck.gapIn = 0.3) — with a `cm` unit:
// `gap: 0.3cm` instead of the correct 0.3in = 0.762cm. The doc renderer and
// the deck renderer thus used wildly different gaps for the same spec.
import { describe, expect, it } from "vitest";
import { compilePdfHtml } from "../lib/docdesign/compilePdfHtml";
import { validateDocPlan, type DocPlan } from "../lib/docdesign/irDoc";
import { getTheme, tokens } from "../lib/docdesign/tokens";

function docWithKpiStrip(): DocPlan {
  return {
    v: 1,
    kind: "doc",
    title: "Q3 Review",
    sections: [
      {
        id: "sec1",
        heading: "Numbers",
        blocks: [
          {
            type: "kpi-strip",
            kpis: [
              { label: "Uptime", value: "99.96%" },
              { label: "MTTR", value: "42 min" },
              { label: "Sev-1", value: "2" },
            ],
          },
        ],
      },
    ],
  };
}

describe("A8: kpi-strip gap is emitted in cm, converted from the inch token", () => {
  it("emits gap: (gapIn * 2.54)cm", () => {
    const { plan } = validateDocPlan(docWithKpiStrip());
    expect(plan).not.toBeNull();
    const { html } = compilePdfHtml(plan!, getTheme(null));

    const expected = (tokens.space.deck.gapIn * 2.54).toFixed(2); // 0.3in → "0.76" cm
    expect(html).toContain(`.kpi-grid { display: flex; gap: ${expected}cm`);
    // The raw inch value must not leak out wearing a cm unit.
    expect(html).not.toContain(`gap: ${tokens.space.deck.gapIn}cm`);
  });
});
