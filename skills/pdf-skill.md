---
name: pdf
description: "Use this skill whenever generating a PDF in Conduit's Chat tab sandbox. Triggers: any request for a PDF deliverable — reports, one-pagers, invoices, or any document explicitly requested as PDF rather than docx."
---

# PDF Generation

Two real paths — pick based on what's actually being asked for, don't default to one blindly.

## Path 0 — `conduit_docgen` helper (preferred for styled PDFs)

A styling toolkit named `conduit_docgen` is pre-installed in every `generate_document("pdf", ...)` run (it ships reportlab under the hood). For a styled report/one-pager/brief, prefer it over hand-rolling reportlab — it handles fonts, spacing, headings, tables, and callouts with consistent typography:

```python
import conduit_docgen as cd
pdf = cd.Pdf(title="Report", subtitle="Q2", theme="plum", author="Acme")
pdf.heading("Overview")
pdf.paragraph("Body text…")
pdf.bullets(["a", "b"])
pdf.table(["Key", "Value"], [["x", "1"]])
pdf.callout("Bottom line.")
pdf.save()  # writes to os.environ["CONDUIT_OUTPUT"]
```

This is the preferred path for styled PDFs — it avoids the `soffice` conversion step (Path A) and the low-level reportlab gotchas (Path B). Drop down to Path B only when you need pixel-exact layout the helper can't express (form fields, label sheets, fixed-position flyers).

## Path A — Generate via docx/pptx, then convert (preferred for most requests)

If the content is a normal document or slide deck and the user just wants the final format to be PDF, it is almost always easier and higher-quality to build it with `python-docx` or `python-pptx` (see those skills) and convert at the end:

```bash
soffice --headless --convert-to pdf output.docx
# or
soffice --headless --convert-to pdf output.pptx
```

This path gets you all the layout/typography quality of Word or PowerPoint's own rendering engine for free, rather than manually positioning every element yourself. Default to this path unless the request specifically needs PDF-native features (form fields, precise print-layout control, page-level programmatic control) that docx/pptx generation doesn't give you.

## Path B — Generate directly with reportlab (when precise layout control is needed)

Use `reportlab` when the user needs exact print-layout control (e.g. a one-page flyer with fixed element positions, a form, a label sheet) that a word-processor-style flow document can't guarantee.

### Core gotchas

- **Coordinate origin is bottom-left**, not top-left — this trips up anyone used to screen/web coordinates. `y` increases upward. Plan positions accordingly or work in a helper coordinate system and flip before drawing.
- **Units default to points** (72pt = 1 inch) — use `reportlab.lib.units.inch`/`cm` explicitly rather than hand-converting, to avoid off-by-a-fraction errors that are hard to spot visually.
- **Text does not auto-wrap** with the low-level `canvas.drawString()` API — for any paragraph of real length, use `Platypus` (`Paragraph`, `Frame`, `SimpleDocTemplate`) which handles wrapping and flow across pages, rather than manually computing line breaks.
- **Page size defaults to US Letter** — set `pagesize=A4` explicitly from `reportlab.lib.pagesizes` if needed.
- **Fonts**: built-in fonts are limited (Helvetica, Times, Courier + bold/italic variants). For anything else (matching Conduit's Space Grotesk brand type), register a TTF font explicitly with `pdfmetrics.registerFont()` before use — it will silently fall back to Helvetica if you reference an unregistered font name, which is easy to miss visually at a glance.
- **Images**: `canvas.drawImage(path, x, y, width=, height=, preserveAspectRatio=True)` — always pass explicit dimensions and set `preserveAspectRatio=True` unless deliberately stretching.

## Design principles

Same rules as docx/pptx generation apply: real size/weight contrast for headings, generous margins (≥0.5"), no decorative accent bars/stripes, consistent spacing units, and — for anything data-heavy — prefer a clean table over a wall of text.

## Verify the output — required

Whichever path was used, render pages to images and inspect them before calling the task done:

```bash
pdftoppm -jpeg -r 100 output.pdf page
ls page-*.jpg   # inspect these
```

Check for: text running off the page edge, overlapping elements, inconsistent margins between pages, images at the wrong aspect ratio.

## Dependencies

`reportlab` (pip, for Path B) · LibreOffice (`soffice`, for Path A conversion) · `pdftoppm` (Poppler, for rendering verification images)
