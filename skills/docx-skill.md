---
name: docx
description: "Use this skill whenever generating a Word document (.docx) in Conduit's Chat tab sandbox. Triggers: any request for a report, memo, letter, proposal, or similar document deliverable as a .docx file."
---

# DOCX Generation (python-docx)

`python-docx` is preinstalled in the sandbox. Build the document programmatically — never hand-write XML for creation tasks.

## Structure first, content second

Before writing code, decide the document's skeleton: title, section headings (H1/H2), and roughly how many paragraphs/tables/images per section. Documents that read as "AI slop" are almost always ones where the model started writing paragraphs before deciding the structure.

## Core gotchas

- **Use built-in heading styles** (`doc.add_heading(text, level=1)`), not manually bolded/enlarged paragraphs. Built-in styles are what makes a Table of Contents field work later, and what makes the doc look like a real Word document instead of a text dump with big bold lines.
- **Page size defaults to US Letter in python-docx** — if you need A4, set explicitly: `section.page_width = Cm(21)`, `section.page_height = Cm(29.7)`. Don't assume; check what the user needs.
- **Never insert literal bullet characters** (`•`, `-`) into paragraph text. Use the `List Bullet` / `List Number` built-in styles: `doc.add_paragraph(text, style='List Bullet')`. Literal bullets break Word's list numbering/indent behavior and look wrong the moment someone edits the list.
- **Tables need explicit column widths set on every cell**, not just the table — python-docx does not auto-distribute width. Set `table.autofit = False` and assign `cell.width` per column for predictable layout.
- **Table shading**: use `OxmlElement` shading with a real hex fill, never leave default (renders as no shading, which is fine) but never use black/near-black as a "subtle" shade — check contrast against text color.
- **Images**: `doc.add_picture(path, width=Inches(x))` — always pass an explicit width. An unscaled image at native resolution frequently overflows the page width and is the single most common visual defect in generated docs.
- **Page breaks**: `doc.add_page_break()` as its own call, never embedded inside a paragraph of unrelated text.
- **Never concatenate multiple logical paragraphs with `\n`** inside one `add_paragraph()` call — Word paragraphs are the unit of structure; each real paragraph needs its own call.
- **Styling consistency**: pick a font (or accept the default Calibri/Aptos) and a small set of heading sizes, and use them uniformly. Don't mix styling approaches (some headings via `add_heading`, others via manually bolded runs) within one document.

## Design principles (carried over from general document design — apply even to plain reports)

- Titles need real visual weight (H1, 24-28pt equivalent) — don't let the title blend into H2 text.
- Use whitespace and section breaks to create hierarchy — don't rely on horizontal-rule tables or accent-colored bars under headings; these read as AI-generated filler, same as in slide decks.
- Default to a clean white background and standard black/dark-gray body text unless the user has specified a brand palette. Don't reach for cream/beige defaults.
- Keep paragraphs to a reasonable length (3-6 sentences); a wall of unbroken text is a readability failure even if the content is correct.
- Use tables for genuinely tabular data only — don't use a table as a layout hack to force two-column text side by side; that's fragile and renders inconsistently across Word versions.

## Verify the output — required, not optional

After generating, render it and actually look at it before calling the task done:

```bash
soffice --headless --convert-to pdf output.docx
pdftoppm -jpeg -r 100 output.pdf page
ls page-*.jpg   # inspect these — do not skip this step
```

Look specifically for: text overflowing page margins, images bleeding past the page edge, inconsistent heading sizes, tables with misaligned columns, orphaned single lines at the top/bottom of a page.

## Dependencies

`python-docx` (pip) · LibreOffice (`soffice`, for the PDF-conversion verification step) · `pdftoppm` (Poppler, for rendering verification images)
