---
name: docx
description: "Use this skill whenever generating a Word document (.docx) in Relay's Chat tab sandbox. Triggers: any request for a report, memo, letter, proposal, or similar document deliverable as a .docx file."
---

# DOCX Generation (docx npm via the JavaScript engine)

The default engine is **JavaScript**: your `code` runs in the app's document
sandbox with the `docx` npm library preloaded as a global, and the produced
file is delivered through `await relay.save(...)`. It emits real, editable
Word OOXML (the same engine Anthropic's public docx skill uses) and needs no
Python runtime.

```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
        Table, TableRow, TableCell, WidthType } = docx;

const doc = new Document({
  styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
  sections: [{
    children: [
      new Paragraph({ text: "Quarterly Report", heading: HeadingLevel.TITLE }),
      new Paragraph({ text: "Overview", heading: HeadingLevel.HEADING_1 }),
      new Paragraph("Revenue grew 12% quarter over quarter."),
      new Paragraph({ text: "Demand maturing in EMEA", bullet: { level: 0 } }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: [
          new TableCell({ children: [new Paragraph("Metric")] }),
          new TableCell({ children: [new Paragraph("Value")] }),
        ]})],
      }),
    ],
  }],
});

await relay.save(await Packer.toBlob(doc));
```

## Structure first, content second

Decide the skeleton (title, H1/H2 sections, roughly how many paragraphs and
tables per section) before writing code. Documents that read as "AI slop" are
almost always ones that started writing paragraphs before deciding structure.

## Core rules

- **Headings MUST use `heading: HeadingLevel.HEADING_1/2/…`** — real Word
  styles are what make the navigation pane and TOC fields work. Never fake a
  heading with a bold enlarged run.
- **Bullets/numbering**: `new Paragraph({ text, bullet: { level: 0 } })` or a
  `numbering` config. Never insert literal `•` characters into text.
- **Tables**: set `width: { size: 100, type: WidthType.PERCENTAGE }` (or
  explicit `columnWidths`) so columns don't collapse.
- **Consistent typography**: set the document default run font/size in
  `styles.default.document.run`; give the title real visual weight (TITLE
  style, 24-28pt) rather than colored bars or underlines.
- **Clean white pages**; one restrained accent colour if any.
- Deliver with EXACTLY ONE `await relay.save(...)`. No network calls, no
  file-system access from the sandbox.
- Build genuinely useful content — several sections, real numbers where the
  user gave them.

## Python fallback

If the JavaScript engine is unavailable (e.g. headless automation runs),
re-call with `language: "python"`: python-docx or `relay_docgen`
(`cd.Doc(title=…, theme=…)`; `doc.heading/paragraph/bullets/table/save`) on
the bundled interpreter, saving to `os.environ["RELAY_OUTPUT"]`.
