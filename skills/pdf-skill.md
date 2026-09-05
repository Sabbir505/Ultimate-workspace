---
name: pdf
description: "Use this skill whenever generating a PDF in Relay's Chat tab sandbox. Triggers: any request for a PDF deliverable — reports, one-pagers, invoices, or any document explicitly requested as PDF rather than docx."
---

# PDF Generation

Default path: **HTML → PDF** (`language: "html"`). Your HTML is rendered by a
real browser engine (the app's hidden WebView2 print pipeline with Paged.js)
and printed to PDF — so full CSS, flex/grid, SVG, inline images and every
Unicode language (CJK, Arabic, emoji) "just work". No font registration, no
manual wrapping, no Latin-1 limits.

## Path A — HTML → PDF (default; `language: "html"`)

Write a complete, self-contained HTML document in `code`:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 20mm 17mm;
          @bottom-center { content: counter(page); font-size: 9pt; color: #666; } }
  body  { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; line-height: 1.6; }
  h1, h2 { font-family: "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 26pt; margin: 0 0 0.3em; }
  h2 { font-size: 15pt; margin-top: 1.6em; }
  .cover { page: cover; break-after: page; padding-top: 80mm; text-align: center; }
  section { break-before: page; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
</style>
</head>
<body>
  <div class="cover"><h1>Research Brief</h1><p>Acme Labs · 2026</p></div>
  <section><h2>Summary</h2><p>…</p></section>
</body>
</html>
```

Rules:

- **Inline everything** — all CSS in `<style>` tags; images as data URIs or
  absolute local `file:///` paths. No external `<link>`, no `<script>`.
- **Page structure via `@page`** — Paged.js is preloaded: margin boxes
  (`@bottom-center { content: counter(page) }`), running headers
  (`string-set`), `counter(pages)`, `break-before: page`, named pages all
  work. The paper is A4 portrait; size the layout for it.
- **Full-bleed cover**: `@page cover { margin: 0 }` + a named-page cover div
  with the accent colour of the document.
- **Editorial look**: serif display face + clean sans body, generous
  whitespace, strong type hierarchy, ONE restrained accent colour, clean
  white pages. No decorative bars/stripes/underlines.
- The tool result arrives after the PDF is rendered — if it reports a render
  error, fix the HTML and re-call.

## Path B — Python + `relay_docgen` (fallback; `language: "python"`)

When the HTML engine is unavailable (headless runs) use the bundled Python
toolkit (reportlab under the hood):

```python
import relay_docgen as cd
pdf = cd.Pdf(title="Research Brief", subtitle="2026", theme="plum", author="Acme Labs")
pdf.heading("Summary"); pdf.paragraph("Body…"); pdf.bullets(["a", "b"])
pdf.table(["Key", "Value"], [["x", "1"]]); pdf.callout("Bottom line.")
pdf.save()  # writes to os.environ["RELAY_OUTPUT"]
```

Drop to raw reportlab only for pixel-exact print layouts (forms, label
sheets): remember y grows upward, units are points, `Platypus` for wrapping
text, register TTF fonts explicitly.

## Design principles (both paths)

Real size/weight contrast for headings; generous margins (≥ 0.5"); no
decorative accent bars; consistent spacing; tables for genuinely tabular
data; a wall of unbroken text is a readability failure even when correct.

## Verify

PDFs preview in-app — open the artifact and check pagination, overflow, and
font rendering before declaring the task done.
