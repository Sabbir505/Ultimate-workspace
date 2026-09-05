# Document Fidelity Research — Current State & Best-in-Class Architecture (Aug 2026)

> **Superseded (2026-09-04):** the engine migration this research recommended is implemented — see `DOCUMENT_DESIGN_ARCHITECTURE.md` (Status: Implemented). Part 1's "how the pipeline works today" describes the pre-migration stack (Python/`conduit_docgen`, no pdf.js/docx/pptxgenjs); the shipped pipeline now generates DOCX via the `docx` npm library, PPTX via PptxGenJS, PDF via HTML → WebView2 print (Paged.js), and previews with pdf.js/docx-preview. Kept as background/rationale.

Research question: what is the best way to **create** and **render** DOC / PPT / PDF with full fidelity, given our Tauri 2 local-first app (Windows-first, offline-capable, LLM as document author, currently bundles Python 3.12 + portable LibreOffice 26.2)?

---

## Part 1 — How the pipeline works today

### Generation (two paths)

| Path | What | Where | Fidelity |
|---|---|---|---|
| A: `generate_file` | Hand-rolled writers in Rust | `src-tauri/src/chat/artifacts.rs` | **Minimal.** PDF 1.4 = single Helvetica, Latin-1 only (Unicode → `?`, `artifacts.rs:205-224`), char-count wrapping. DOCX = flat paragraphs, no headings/tables/lists/colors (`artifacts.rs:354`). PPTX = fixed **4:3** (`artifacts.rs:533`), title + bullets only. XLSX = inline strings, no numbers/formulas. |
| B: `generate_document` | LLM-authored Python run on bundled interpreter with `conduit_docgen` helper | `src-tauri/src/chat/pygen.rs:63`, helper `docgen_helper.py` (794 lines) | Rich. python-docx (cover pages, themed tables), python-pptx (16:9, real bullet XML), ReportLab Platypus with embedded TTFs, 7 themes. |

- Tool dispatch: `tools/mod.rs:44,567` → `generate.rs:15,124`; prompt guide `tools/generate.rs:55-83`; schema `tools/specs.rs:261-284`.
- Bundles: `scripts/fetch-bundled-python.mjs` (python-docx, python-pptx, openpyxl, reportlab), `scripts/fetch-bundled-libreoffice.mjs` (portable LO 26.2.5) — **Windows x64 only**.

### Preview (`read_artifact_preview`, `src-tauri/src/chat/commands.rs:2495`)

- **PDF** → base64 data URI → native `<embed>` (webview's built-in viewer) — `ArtifactPreviewPane.tsx:138`.
- **PPTX** → headless LibreOffice → PDF → `<embed>` (`office.rs:1081`, cache `%TEMP%\conduit-pptx-pdf`). Fallback: lossy `pptx_to_html` (positioned text boxes only, no images/charts/theme, `office.rs:701`).
- **DOCX/XLSX** → hand-rolled Rust HTML string-scanners (`office.rs:456,757`) — drops images, headers/footers, page breaks, numbering continuity, style inheritance; XLSX capped at 500 rows, `sheet1.xml` only.

### Known asymmetries & dead weight

- `office_to_pdf` supports `.docx/.doc` but only `pptx` is routed through it (`commands.rs:2596`) — DOCX preview always uses the approximate HTML renderer.
- `mammoth` is in `package.json` but **never imported** (dead dep; flagged stale in `types.rs:716`).
- DOCX `data_uri` raw bytes are sent to the frontend but never consumed (`commands.rs:2646`, `types.rs:701`).
- Local RAG (`chat/docs.rs:14-20`) can't index PDF/Office files.
- No pdf.js, docx npm, pptxgenjs anywhere in the stack today.

---

## Part 2 — Research findings (2025-2026 state of the art)

### 2.1 DOCX

**Generation**
| Option | Verdict |
|---|---|
| **`docx` npm (dolanmiu)** | Best-in-class API: full OOXML surface (tables, images, headers/footers, styles, numbering, TOC). MIT, v9.7.1, 5.5M downloads/wk, ~107 KB gzip, runs in browser or Node. |
| python-docx (current) | Good core, revived maintenance (v1.2.0 Jun 2025). Ceilings: no theme editing, limited numbering, no charts/SmartArt. Costs the Python bundle. |
| Pandoc + `--reference-doc` | Structure-preserving, styling from reference docx; GPL binary (aggregation, usually fine, some legal teams balk). Semantic ceiling — no floating images/text boxes. |
| docxtemplater | Template-fill only; **desktop redistribution = €6.5k–15k/yr appliance license**. Poor fit. |
| ONLYOFFICE Document Builder | Highest generation fidelity (real layout engine) but **AGPL** / paid Developer Edition; hundreds of MB. |
| HTML→DOCX (`@turbodocx/html-to-docx`) | Pragmatic pipe, low fidelity ceiling (no style system, font issues). |
| Rust crates (docx-rs, docx-rust) | Not at parity. |

**Preview**
| Option | Verdict |
|---|---|
| **docx-preview (docxjs)** | Apache-2.0, ~48 KB gzip, 1.4M downloads/wk, active (v0.4.0). Renders real styles, numbering, headers/footers, footnotes, images. Limits: no reflow pagination (explicit breaks only), no TOC fields. Massive upgrade over our string-scanner. |
| LibreOffice → PDF | Highest practical fidelity offline (full layout engine) but not Word-identical: pagination drift (39 vs 42 pages class), font-substitution reflow. We already bundle LO. |
| SuperDoc | Real pagination + edit path, but **AGPL dual-license** — closed-source needs commercial. |
| mammoth | Semantic extraction only — not a previewer (and we never even wired it up). |
| Apryse / Nutrient WebViewer | Client-side WASM, near-office fidelity, offline OK; quote-based, realistically $20–30k/yr. |
| MS Office web viewer / Collabora / LibreOfficeKit | Disqualified: online+public-URL requirement, server products, or Linux-centric DLL pain. |

**What the big AI apps do:** nobody parses DOCX by hand. ChatGPT previews its own canvas and converts at export (users report formatting loss). **Claude/Anthropic open-sourced the exact recipe as Agent Skills: the LLM writes code against docx-js / does raw OOXML surgery** — validating "LLM emits code against a good DOCX library" as the industry pattern. Copilot drafts in the real Word canvas. Notion doesn't even do DOCX.

### 2.2 PPTX

**Generation**
| Option | Verdict |
|---|---|
| **PptxGenJS** | MIT, active (v4.0.1 Jun 2025), native charts, slide masters, tables w/ auto-paging. Sharp edges: hex colors must omit `#` (file corrupts otherwise), default canvas 10×5.625" (set 16:9 explicitly), validate chart XML post-write. **It's literally what Anthropic's public pptx skill uses.** |
| python-pptx (current) | Correction: it *does* have a chart API (`add_chart`). Gaps: no theme/master authoring, no 3D/combo charts, series colors theme-bound. Stable but slow-moving. |
| Marp/Slidev/Reveal → pptx | **Images-in-slides** — not editable text. Wrong tool for real .pptx output. |
| Pandoc | 7 fixed layouts, styling only from reference doc. Weak design pipeline. |
| LibreOffice UNO authoring | Profile locks, headless flakiness. Fine for conversion, poor for authoring. |
| ONLYOFFICE Document Builder | Strongest engine-based generator; AGPL/commercial; same engine as best previewer (kills "generator vs previewer disagree" bugs). |

**AI tools:** Gamma, Copilot-in-PowerPoint, Gemini all generate **native editable pptx** from a structured model — never screenshots-in-slides for the editable tier.

**Preview**
| Option | Verdict |
|---|---|
| **LibreOffice → PDF → PDF.js (current base, harden it)** | Mature, zero new cost (LO already bundled). Gaps: shrink-autofit not fully replicated, SmartArt re-layout, chart re-render, font substitution. **Key lever: since WE generate the decks, we control the fidelity envelope** — explicit text sizes instead of autofit, native charts not SmartArt. |
| ONLYOFFICE x2t standalone | Biggest offline fidelity jump (real PowerPoint-engine clone: autofit, charts, SmartArt, themes). AGPL or paid Developer Edition; hundreds of MB of libs. WASM build exists (CryptPad). |
| Apryse WebViewer | Client-side WASM office viewing, air-gapped OK, commercial. |
| pptx-preview / PPTXjs | **Not production**: one has restrictive closed-ish license ("personal study only"), the other is hobby-grade (jQuery, stalled). |

### 2.3 PDF

**Generation**
| Option | Verdict |
|---|---|
| **Hidden webview `PrintToPdfStream` (WebView2 COM via `webview2-com`, ~50-100 lines)** | Browser-grade HTML/CSS, **zero new runtime** (WebView2 already in the app and on every Win10/11 box), fully offline, Evergreen upgrades free. `ICoreWebView2_16::PrintToPdfStream` returns bytes. Headers/footers are title/URI strings only → bake styled headers/footers/page numbers into the HTML via **Paged.js** (MIT: margin boxes, running headers, `counter(page)`, TOC page refs, footnotes). Proven pattern: `tauri-plugin-printer` does the COM dance. macOS: `WKWebView.createPDF`; Linux: `WebKitPrintOperation`. |
| **Typst** | Publication-grade typesetting (TOC, running heads, footnotes, math, PDF/A-2a + PDF/UA-1 in 0.15). Single Apache-2.0 ~40 MB binary, sub-second, superb CJK, LLM-writable markup (huge training corpus). Best with a fixed `template.typ` the LLM fills. |
| Headless Chromium (Puppeteer) | Same fidelity class as #1 but +100-160 MB browser download we don't need. |
| WeasyPrint v69 (bundled Python) | Best CSS paged-media engine outside browsers; BSD; slower; Windows Pango DLL packaging pain. Good engine-agnostic fallback. |
| LibreOffice HTML→PDF | **Poor** — Writer's HTML import is HTML4-era. But DOCX/ODT→PDF is good. |
| ReportLab/fpdf2 (current) | Precise but imperative — exactly today's failure mode (layout drift, manual font registration). fpdf2 HTML mode can't do custom fonts. |
| Dead ends | wkhtmltopdf (archived Jan 2023, org archived Jul 2024, unpatched CVEs), Prince ($495 desktop / $3.8k server), Tectonic/LaTeX (offline cache hassle, LaTeX brittleness — Typst dominates), jsPDF/pdfmake (invoice tier, below browser print). |

**Industry pattern:** ChatGPT/Claude/Notion all converge on **HTML + a print engine** for PDF (Notion's API has no PDF endpoint so the entire ecosystem renders its HTML via headless Chrome/WeasyPrint; Google Docs converts its internal model server-side).

### 2.4 PDF viewing

| Option | Verdict |
|---|---|
| Native `<embed>` (current) | Works on WebView2, minimal on WKWebView, **broken on WebKitGTK** (blank/download). Near-zero programmatic control (only toolbar-item hiding; hidden items reappear in overflow — WebView2Feedback #3244). Viewer ships with the Evergreen runtime → behavior varies per user. |
| **PDF.js** | Apache-2.0, Mozilla-funded, monthly releases (v6.2.108 Jul 2026), full viewer app (search, thumbnails, outline, selection, forms, annotation editing, print) or headless API for custom UI. 2–5 MB shipped. Proven: Obsidian bundles it; VS Code's PDF extension ecosystem is pdf.js. Tauri maintainers point everyone here (no official PDF plugin exists; discussion #10265). Gotcha: bundle `pdf.worker.mjs` as an asset and set `GlobalWorkerOptions.workerSrc`. |
| EmbedPDF (PDFium-WASM) | Modern Apache-2.0 newcomer; Chrome-engine fidelity; redaction/annotations; younger, less battle-tested. Watch-list. |
| MuPDF.js | Best-in-class engine but **AGPL/commercial**. |
| Apryse / Nutrient | $1.5k entry, realistically $20–30k/yr; only if the PDF pane is a monetized core feature. |

---

## Part 3 — Recommended target architecture

### The unifying insight

1. **The industry pattern for LLM-authored documents is: LLM writes code against a good library; preview is HTML/canvas approximation; PDF is the accurate-view currency.** Nobody hand-parses OOXML (what our `office.rs` does).
2. **PDF is the universal "accurate preview" format.** We already bundle the best offline converter (LibreOffice). Routing *all* office formats → PDF and rendering with PDF.js gives one high-fidelity, cross-platform, searchable preview surface.
3. Since **we are also the generator**, we can constrain generation to the intersection of features that convert well — closing most of the LibreOffice fidelity gap for free.

### Target stack (all permissively licensed, fully offline)

| Layer | Adopt | Replaces | License / size |
|---|---|---|---|
| **DOCX generation** | `docx` npm — LLM emits structured JSON mapped to the docx API (or JS snippet executed in webview), mirroring Anthropic's open-sourced docx skill | Path-A hand-rolled `write_docx`; eventually the Python rich path | MIT, ~107 KB gzip |
| **PPTX generation** | `PptxGenJS` + a small set of curated 16:9 **master/template .pptx files** seeded as themes; post-write OOXML validation | Path-A `write_pptx` (4:3, no theme); optionally python-pptx long-term | MIT, ~1 MB |
| **PDF generation** | LLM authors **HTML** → inject print stylesheet + **Paged.js** → hidden webview → `ICoreWebView2_16::PrintToPdfStream` via `webview2-com` in Rust (hidden `WebviewWindow`, bytes back over IPC). Optional quality tier: bundled **Typst** CLI for book-grade output. | Path-A `write_pdf` (Latin-1-only today) | MIT/Apache-2.0, Paged.js ~200 KB; Typst ~40 MB optional |
| **PDF viewing** | **PDF.js** (viewer app or custom React UI over the API), worker bundled as asset, bytes fed from Rust | Native `<embed>` | Apache-2.0, 2–5 MB |
| **DOCX/XLSX fast preview** | `docx-preview` for DOCX (instant, real styles/headers/footers); keep/improve the Rust XLSX renderer or move to SheetJS Community | `docx_to_html`/`pptx_to_html` string-scanners | Apache-2.0 / Apache-2.0 |
| **Accurate office preview** | Route **DOCX and PPTX** both through bundled LibreOffice → PDF → PDF.js (fix the asymmetry at `commands.rs:2596`) | PPTX-only LO routing + lossy HTML fallbacks | Already bundled (MPL-2.0) |

### Fidelity posture by format

- **DOCX**: generation = real OOXML via `docx` npm (headings, tables, images, headers/footers, numbering). Preview = docx-preview (instant) with "accurate view" via LO→PDF. Truth-telling escape hatch: "Open in Word" button.
- **PPTX**: generation = PptxGenJS on template masters (16:9, real charts). Preview = LO→PDF→PDF.js; constrain the generator (explicit font sizes, no SmartArt) so LO renders our decks near-perfectly. Upgrade path if needed: ONLYOFFICE x2t sidecar (licensing decision required: AGPL vs paid).
- **PDF**: generation = HTML+Paged.js via WebView2 print (Unicode/CJK/web fonts for free — fixes today's `?`-for-Unicode bug class) with Typst as a premium typesetting option. Viewing = PDF.js (search, thumbnails, outline, identical across Win/mac/Linux).

### Licensing watch-outs (all in one place)

- **Permissive, safe to bundle**: docx npm (MIT), PptxGenJS (MIT), docx-preview (Apache-2.0), PDF.js (Apache-2.0), Paged.js (MIT), Typst (Apache-2.0), EmbedPDF (Apache-2.0), pdf-lib (Apache-2.0), LibreOffice (MPL-2.0).
- **AGPL — needs commercial license for closed-source distribution**: ONLYOFFICE (Document Builder / x2t / Document Server), SuperDoc, MuPDF.
- **Quote-based commercial**: Apryse, Nutrient (~$20–30k/yr realistic), docxtemplater appliance (€6.5k+), Prince.

### Migration order (highest value, lowest risk first)

1. **PDF.js replaces `<embed>`** — self-contained frontend change, fixes WebKitGTK + programmatic control + consistency. Removes the "behavior varies with WebView2 runtime" class of bugs.
2. **Delete the hand-rolled PDF writer; generate PDFs via HTML+Paged.js+WebView2 `PrintToPdfStream`** (~100 lines of Rust via `webview2-com`; `tauri-plugin-printer` proves the COM path). Kills the Latin-1/Unicode bug at the root. Keep ReportLab path as fallback initially.
3. **docx-preview replaces `docx_to_html` for preview**; route DOCX through LO→PDF as the "accurate" mode alongside (fix the `commands.rs:2596` asymmetry).
4. **DOCX generation moves to `docx` npm** (LLM emits JSON/JS per the Anthropic skill pattern); retire Path-A `write_docx`.
5. **PPTX generation moves to PptxGenJS + template masters**; add post-write OOXML validation (Anthropic's skill ships validation scripts for exactly the PowerPoint-rejects-chart-XML class of bug).
6. **Cleanup**: remove dead `mammoth` dep and unconsumed `data_uri` docx bytes; retire `pptx_to_html` fallback once LO→PDF coverage is solid; consider WeasyPrint/Typst as the cross-platform print fallback when macOS/Linux builds resume.

### Non-goals / ruled out

- Headless Chromium bundle (WebView2 already gives browser-grade print for 0 MB).
- Marp/Slidev/Reveal for pptx output (images-in-slides).
- Collabora/OnlyOffice Document Server embeds (server products).
- Microsoft Graph/Office-online conversion (cloud-only, defeats local-first).
- wkhtmltopdf (dead, CVEs), Prince (cost), Tectonic (offline cache hassle).
- pptx-preview npm (restrictive license), PPTXjs (hobby-grade).

---

## Sources (selected)

- Anthropic skills (docx = docx-js + OOXML surgery; pptx = PptxGenJS + validation): https://github.com/anthropics/skills
- docx npm: https://github.com/dolanmiu/docx · docx-preview: https://github.com/VolodymyrBaydalka/docxjs · SuperDoc: https://www.superdoc.dev (AGPL)
- PptxGenJS: https://github.com/gitbrent/PptxGenJS · python-pptx charts: https://python-pptx.readthedocs.io/en/stable/user/charts.html · Slidev export=images: https://sli.dev/guide/exporting · Marp pptx: https://github.com/marp-team/marp-cli
- WebView2 printing: https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/print · Tauri COM workaround: https://stackoverflow.com/questions/78327694 · tauri-plugin-printer: https://github.com/chen-collab/tauri-plugin-printer · WKWebView createPDF: https://developer.apple.com/documentation/webkit/wkwebview/createpdf(configuration:completionhandler:)
- Paged.js: https://pagedjs.org/en/about/ · Typst 0.15 (PDF/A+UA): https://typst.app/blog/2026/typst-0.15/ · WeasyPrint: https://weasyprint.org/ · wkhtmltopdf EOL: https://github.com/wkhtmltopdf/wkhtmltopdf/issues/5160
- PDF.js: https://github.com/mozilla/pdf.js/releases · Tauri PDF discussion: https://github.com/orgs/tauri-apps/discussions/10265 · WebView2 PDF toolbar limits: https://github.com/MicrosoftEdge/WebView2Feedback/issues/3244 · WebKitGTK no inline PDF: https://webkitgtk.org/2025/03/14/webkitgtk2.48.0-released.html
- ONLYOFFICE x2t standalone: https://github.com/ONLYOFFICE-QA/x2t-testing · LibreOffice pagination drift: https://ask.libreoffice.org/t/how-to-retain-the-page-of-original-docx-document-when-opened-in-libreoffice/57621
- Apryse: https://www.apryse.com/webviewer · Nutrient Tauri guide: https://www.nutrient.io/blog/how-to-build-a-tauri-pdf-viewer-with-pspdfkit/ · EmbedPDF: https://www.embedpdf.com/
