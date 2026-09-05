---
name: pptx
description: "Use this skill whenever generating a slide deck/presentation (.pptx) in Relay's Chat tab sandbox. Triggers: any request for a deck, slides, pitch deck, or presentation deliverable."
---

# PPTX Generation (PptxGenJS via the JavaScript engine)

The default engine is **JavaScript**: your `code` runs in the app's document
sandbox with `PptxGenJS` preloaded as a global, and the deck is delivered via
`await relay.save(...)`. It produces real, editable PowerPoint OOXML with
native charts — the same engine Anthropic's public pptx skill uses.

```js
const pptx = new PptxGenJS();
pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 }); // 16:9
pptx.layout = "WIDE";
pptx.defineSlideMaster({
  title: "BRAND",
  background: { color: "0B1220" },
  objects: [],
});

const s1 = pptx.addSlide({ masterName: "BRAND" });
s1.addText("Product Launch", { x: 0.6, y: 2.2, w: 12, h: 1.4, fontSize: 44, bold: true, color: "FFFFFF" });
s1.addText("FY2026 · Acme Inc", { x: 0.6, y: 3.6, w: 12, h: 0.6, fontSize: 18, color: "9FB3C8" });

const s2 = pptx.addSlide({ masterName: "BRAND" });
s2.addText("Why now", { x: 0.6, y: 0.5, w: 12, h: 1, fontSize: 32, bold: true, color: "FFFFFF" });
s2.addChart(pptx.ChartType.bar, [
  { name: "Revenue", labels: ["Q1", "Q2", "Q3"], values: [4.2, 5.1, 6.8] },
], { x: 0.6, y: 1.8, w: 7, h: 4.5 });
s2.addText("READY\nMATURE\nFUNDED", { x: 8.2, y: 1.8, w: 4.5, h: 4.5, fontSize: 16, color: "E6EDF3" });

await pptx.write({ outputType: "blob" }).then((blob) => relay.save(blob));
```

## Core rules

- **16:9 explicitly**: `defineLayout({ width: 13.33, height: 7.5 })` + `pptx.layout` —
  the library default is 10×5.63in, which reads as a web slide, not a deck.
- **Hex colors WITHOUT `#`** (`"0B1220"`, never `"#0B1220"` — a `#` silently
  corrupts the file so PowerPoint refuses to open it).
- **Positioning is absolute inches** (top-left origin): plan each slide's
  layout on paper before writing coordinates. Margins ≥ 0.5" from edges, ≥ 0.3"
  between elements.
- **Font size + color + bold on every `addText`** — nothing inherits theme
  sizing reliably. Titles 32-44pt, body 14-18pt.
- **Native charts** (`pptx.ChartType.bar/line/pie/doughnut` with
  `{ name, labels, values }` series) — never screenshot a chart as an image.
- **Speaker notes**: `slide.addNotes("...")` — never a visible text box.
- Deliver with EXACTLY ONE `await relay.save(...)` (a Blob from
  `pptx.write({ outputType: "blob" })`, or the base64 string from
  `pptx.write({ outputType: "base64" })`).

## Design rules — where generated decks usually fail

- Titles need real size contrast vs body (32pt+ vs 14-18pt).
- NEVER accent lines/underlines under titles, no decorative bars/stripes —
  the clearest "AI-made" tells. Use whitespace and type scale.
- Don't default to cream/beige. White, or a real brand palette for covers and
  section dividers (saturated colour is for cover/section/closing slides).
- Every slide needs some non-text visual: a chart, an image, a shape
  composition. Title-plus-bullets on every slide reads as minimum effort.
- One spacing unit across all slides; never overflow a text box — shorten the
  copy or split the slide.

## Python fallback

If the JavaScript engine is unavailable (headless automation runs), re-call
with `language: "python"`: python-pptx or `relay_docgen`
(`cd.Deck(title=…, theme=…)`; `deck.section/bullets/two_column/table_slide/
closing/save`) on the bundled interpreter, saving to
`os.environ["RELAY_OUTPUT"]`.
