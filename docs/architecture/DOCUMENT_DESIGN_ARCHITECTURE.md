# Document Design Architecture — High-Quality DOC/PPT/PDF Generation for Relay

**Status:** Implemented (Phases 0–4; see §15) · **Date:** 2026-09-04 · **Supersedes the open items in** `DOCUMENT_FIDELITY_RESEARCH.md` (its engine migration is done; this covers the missing design/validation layers)

---

## 1. Executive summary

Relay can already *produce* DOCX/PPTX/PDF files reliably: the model writes JavaScript against `docx` npm and PptxGenJS in a sandboxed iframe, HTML for the Paged.js→WebView2 PDF path, with a bundled-Python fallback. What it cannot yet do is guarantee documents look **designed**. Today every font, margin, color, and layout decision is re-invented by the model inside one tool call — content, structure, and visual design are fused into a single code blob. There is no planning stage, no design system the model must obey, no layout compiler, and no validation loop: the model declares a document "done" sight-unseen, and the first entity that ever *sees* the document is the human.

This document specifies a **Document Design Layer** inserted between the LLM and the existing render engines, built on five new concepts:

1. **Design tokens & primitives** — one JSON source of truth for color roles, type scales, spacing rhythm, page geometry, and chart palettes, compiled into every engine (replaces `docgen_helper.py THEMES` and the 5 scattered style guides).
2. **A layout catalog** — a fixed taxonomy of document regions and slide layouts (cover, section divider, chart+text, KPI, quote…), each specified as slots with geometry and **character budgets**.
3. **A content IR + planning stage** — the LLM plans a `DocumentPlan` (structured JSON) first; content planning is fully separated from visual realization.
4. **A deterministic layout compiler** — Plan + tokens + layout spec → engine code (docx-npm JS / PptxGenJS JS / HTML+Paged.js). The model never hand-writes final styling code on the default path.
5. **A layered visual validation loop** — deterministic QA (budgets, bounds, overlap, placeholders) on every generation, then render → rasterize → one VLM critique pass → targeted IR edits → recompile, max 2 revision rounds, reported to the UI like `citation-report` already is.

The design is grounded in (a) a full map of the current pipeline (§2) and (b) state-of-the-art systems and 2025–26 research (§3): Gamma's outline→cards→blocks spine, PPTBench's finding that template constraints raise generation quality by ~18 points, DeepPresenter's "state mismatch" render-feedback loop, AutoPresent's proof that programmatic output beats image generation, and Anthropic's production pptx-skill discipline (authoring-time text budgets, deterministic validators first, VLM last).

The existing engines, preview stack, LibreOffice bridge, artifact DB, and hot-reload loop are **kept as-is**; this layer sits above them.

---

## 2. Current state (what we're building on)

### 2.1 The pipeline today

```
LLM tool call: generate_document { format, language: js|html|python, code }
  │
  ├─ javascript → chat/jsdocgen.rs → "docgen://run" event → DocCodeRunner.tsx
  │     (sandboxed iframe with inlined docx / pptxgenjs UMD, window.conduit.save)
  ├─ html       → chat/pdfprint.rs → hidden WebView2 + BASE_CSS + Paged.js
  │               → poll __renderState → ICoreWebView2_7::PrintToPdf
  └─ python     → chat/pygen.rs → bundled Python 3.12 + conduit_docgen (docgen_helper.py)
  │
  ▼
dispatch.rs run_tool → db::insert_artifact (SQLite, 30-day TTL) → "chat:artifact" event
  ▼
ArtifactPreviewPane.tsx → read_artifact_preview (commands.rs:3008)
  ├─ docx → docx-preview (DocxViewer.tsx), "PDF view" = LibreOffice → pdf.js
  ├─ pptx → auto LibreOffice → PDF → pdf.js   (fallback: lossy pptx_to_html scanner)
  └─ pdf  → pdf.js (PdfViewer.tsx)
  ↺ hot-reload: 2 s getFileMtime poll re-reads preview while the model edits
```

Key files: `src-tauri/src/chat/tools/generate.rs` (tool impls + style guides), `artifacts.rs` (legacy minimal writers), `jsdocgen.rs`, `pygen.rs`, `docgen_helper.py`, `pdfprint.rs`, `office.rs`, `python_runtime.rs`; frontend `src/components/chat/DocCodeRunner.tsx`, `ArtifactPreviewPane.tsx`, `DocxViewer.tsx`, `PdfViewer.tsx`, `ArtifactExportMenu.tsx`, `MermaidDiagram.tsx`, `JsxPreview.tsx`.

### 2.2 What's already good

- **Engine migration is complete** per `DOCUMENT_FIDELITY_RESEARCH.md`: docx npm, PptxGenJS 16:9, Paged.js PDF, pdf.js, docx-preview, LO→PDF bridge with a bundled portable LibreOffice.
- **One real validation loop exists** — `validate_diagram_html` (structural checks + in-turn model self-correction). It is the template for the QA loop designed here.
- **Mechanical QA precedent exists** — `citation_lint.rs` (zero-model-call checks → `chat:citation-report` event → UI strip). The document QA report reuses this exact pattern.
- **A plan→validate→confirm pipeline exists** in `src-tauri/src/artifacts/` (workflow artifacts) — a structural reference, though it targets skills/automations, not documents.
- **Preview fidelity is strong**: real pagination (docx-preview `breakPages`), pdf.js with lazy page canvases, LO conversion with an mtime-keyed cache.
- **The only design-token system** lives in `docgen_helper.py THEMES` (7 themes × 9 color roles + display/body font pair + a type scale) — good instincts, wrong layer (Python fallback only).

### 2.3 The gaps (each is closed by a section of this design)

| # | Gap | Closed by |
|---|-----|-----------|
| G1 | Content + structure + styling fused in one model-authored code blob on the primary path | §5 IR + §7 compiler |
| G2 | No content-planning stage; no outline/revision protocol — iteration = full regeneration | §6 planning stage |
| G3 | No design tokens on the JS/PDF paths; themes only in the Python fallback; engines diverge visually | §4 tokens |
| G4 | Style guidance duplicated in 5 places (mod.rs desc, specs.rs, generate.rs guides, skills/*.md, docgen_helper docstring); `GENERATE_DOCUMENT_DESC` is stale (still says "Python program") | §9 prompt consolidation |
| G5 | No post-write validation for DOCX/PPTX (OOXML corruption guarded only by prompt warnings, e.g. "hex without `#`") | §8.1 deterministic QA |
| G6 | No render-and-inspect loop — the model never sees the document | §8.2–8.4 visual loop |
| G7 | No text-fit measurement; overflow prevented only by prompt advice | §4.5 budgets + §8.1 |
| G8 | Slide masters re-defined in code every run; no reusable layout library | §5.2 layout catalog |
| G9 | Platform/serialization constraints: JS engine needs the main window; one global `RENDER_LOCK` print window; DocCodeRunner rejects concurrency | §7.4, §11 |
| G10 | Naming hazard: `src-tauri/src/artifacts/` (workflow specs) vs `chat/artifacts.rs` (writers) | new modules named `docdesign` / `docqa` |

---

## 3. Research foundation (what the evidence says)

Full source list in §14. The load-bearing findings:

1. **The universal spine is plan → IR → layout → render.** Gamma: prompt → outline → per-card generation → block-level elements, with "themes handle styling, fully decoupled from generation." Microsoft Copilot's Narrative Builder writes an editable outline *before* any slide is generated. STORM separates perspective-guided pre-writing (outline + grounded references) from writing. LlamaIndex's report blocks use researcher → writer (structured Pydantic blocks) → editor. **None** of the strong systems let raw LLM tokens be the layout engine's input.
2. **Constrain generation with a design system, not taste.** PPTBench (958 decks, 17 atomic PowerPoint APIs): free-form slide *generation* is by far the weakest capability (GPT-4o 30.25/100) but **template-guided generation lifts it massively** (Gemini-2.0-Flash 37.91 → 55.97). Beautiful.ai's entire product is a deterministic 300+ layout engine with fixed content slots.
3. **Programmatic output beats image generation.** AutoPresent (CVPR 2025): models trained to emit slide *code* produce higher-quality, editable slides than end-to-end image generation — Relay's code-emitting engines are the right substrate; keep them.
4. **"State mismatch" is the core failure mode — render before you judge.** DeepPresenter: agents editing raw HTML/markdown can't see overflow, overlap, or low contrast; its `inspect_slide` (headless render → pixels) + structured diagnostics loop beats Gamma on quality (4.44 vs 4.36) and ablations show removing grounded reflection costs −0.12…−0.37. VFLM ("Seeing is Improving"): render→reflect→revise training reaches OCR F1 0.9376 vs Claude 3.7's 0.8672 on layout tasks.
5. **Layer validation cheap-first.** Anthropic's production pptx skill: deterministic python-pptx checks (estimated text height vs box, shape-outside-slide, bounding-box overlap, leftover-placeholder grep, image rId resolution) run always; VLM QA "at most once." PPTBench's 0–5 VLM rubric correlates with humans at ρ = 0.86–0.89 — good enough to drive a loop, not good enough to skip rule checks. DOCR-Inspector operationalizes 28 fine-grained document error categories.
6. **Budget text at authoring time; never trust autofit.** OOXML autofit flags are resolved by the *viewer*, invisibly to build-time checks. The pptx skill's mitigation order: trim to budget → widen box (collision-checked) → shrink font (last resort). CJK gets ~15% more width; font substitution in previews warrants ~10% slack.
7. **Edit/template inheritance beats from-scratch layout.** PPTAgent (EMNLP 2025): analyze reference decks → role classification (cover/section/content/stats/quote/closing) → emit *editing actions* on reference slides; layout quality preserved by construction. Its PPTEval rubric — **Content / Design / Coherence** — is the evaluation taxonomy adopted here.
8. **The "AI look" is a known, enumerable failure list**: accent stripes and color bars, decorative title underlines, centered body text, card grids on >1-in-5 slides, default blue/cream, identical layout on every slide. Anthropic's token discipline: BG/PRIMARY/ACCENT/TEXT/MUTED as literal constants; 60–70% background / 5–10% accent; one repeated motif; one consistent gap (0.3–0.5") across all slides.
9. **OOXML already has a design-token layer** — the ECMA-376 Theme Part (dk1/lt1/dk2/lt2/accent1–6/hlink, majorFont/minorFont). Our token schema must compile down to it rather than bake hex into shapes, so files remain re-themeable in Office.
10. **Engine choice per locale**: browsers (and thus our WebView2 Paged.js path) handle bidi/RTL and CJK correctly; WeasyPrint's RTL is "known to be broken in many ways" — one more reason to keep HTML→WebView2 as the PDF engine rather than adding a native one.

---

## 4. Design principles

- **P1 — The model plans content; code renders design.** LLM output on the default path is structured JSON (a plan), never final engine code. Styling decisions are made by tokens + layout specs, applied by a deterministic compiler.
- **P2 — One source of truth per concern.** Tokens: one JSON. Layouts: one catalog. Style guidance for prompts: generated from those, not hand-written per engine.
- **P3 — Validate in layers, cheapest first.** Plan schema → compile-time invariants → post-write deterministic geometry checks → render probes → one VLM pass. Each layer can veto.
- **P4 — Errors route back to the IR, not to regeneration.** Every QA issue carries an IR pointer (`slideId`/`sectionId`/`blockId`); revision is a targeted patch turn, max 2.
- **P5 — Everything stays editable.** Native OOXML (real text boxes, native charts, theme-referenced colors), selectable PDF text via real HTML — never rasterized pages.
- **P6 — Keep the escape hatches.** The raw-code path (`language: "javascript"`) and the Python fallback remain, for power users and headless runs — but they read the same tokens, and the default is the compiled path.
- **P7 — PDF is the QA currency** (per the 2025 research doc): every artifact type is rendered to PDF for validation, reusing the existing LO bridge and pdf.js.

---

## 5. Architecture overview

```
                    ┌────────────────────────────────────────────────────────┐
                    │                    CHAT / AGENT LAYER                  │
                    │   generate_document (new staged contract)  §9          │
                    └───────────────┬────────────────────────────────────────┘
                                    │ 1. PLAN
      ┌─────────────────────────────▼───────────────────────────────┐
      │  CONTENT PLANNER (LLM, JSON mode)              §6            │
      │  outline → DocumentPlan (doc.plan.v1 | deck.plan.v1)        │
      │  inputs: user intent, research ledger, format, theme hint   │
      └───────────────┬─────────────────────────────────────────────┘
                      │ 2. VALIDATE PLAN (schema + budgets + evidence)   §8.1a
      ┌───────────────▼─────────────────────────────────────────────┐
      │  DOCDESIGN CORE (deterministic, no LLM)                      │
      │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐ │
      │  │ DesignTokens │   │ LayoutCatalog│   │ DesignSystems    │ │
      │  │ tokens.json  │   │ layouts.json │   │ (named bundles)  │ │
      │  └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘ │
      │         └──────────────┬───┴────────────────────┘           │
      │                        ▼  3. COMPILE                          │
      │              Layout Compiler  §7                              │
      │      Plan + tokens + layout spec → engine program             │
      └───────┬──────────────┬──────────────┬────────────────────────┘
              ▼              ▼              ▼
      ┌────────────┐ ┌─────────────┐ ┌──────────────┐
      │ docx npm JS│ │ PptxGenJS JS│ │ HTML+Paged.js│   (existing engines §2)
      └─────┬──────┘ └──────┬──────┘ └──────┬───────┘
            ▼               ▼               ▼
        .docx           .pptx           .pdf          ◄── 4. RENDER (unchanged)
            └───────────────┴───────────────┘
                            ▼
      ┌─────────────────────────────────────────────────────────────┐
      │  DOCQA — LAYERED VALIDATION & REVISION  §8                   │
      │  L1 plan checks · L2 compile invariants · L3 post-write     │
      │  geometry · L4 render probes (PDF raster via pdf.js)        │
      │  L5 VLM critique (once) ──issues w/ IR pointers──┐          │
      └──────────────────────────────────────┬──────────┼──────────┘
                                             │  5. REPATCH (≤2 loops)
                                             ▼          │
                                    planner patches IR ─┘ → recompile
                            QA report → "chat:doc-qa" event → UI strip
```

Module naming: everything new lives under **`docdesign`** (tokens, catalog, compiler, IR — TS + Rust mirror) and **`docqa`** (validation), deliberately avoiding a third collision with `src-tauri/src/artifacts/`.

---

## 6. Stage 1 — Content planning (the IR)

### 6.1 New tool: `plan_document`

The model no longer calls `generate_document` with code first. It calls:

```
plan_document {
  intent: string,            // what the user asked for, verbatim gist
  format: "docx" | "pptx" | "pdf" | "xlsx",
  audience?: string,         // e.g. "executives", tone
  depth?: "brief" | "standard" | "deep",
  outline?: Section[],       // optional — model may propose; planner may revise
}
```

The tool result is the **plan JSON** (or validation errors for the model to fix). A second implicit stage compiles and renders it — the model is told the artifact is produced and given the QA report. `generate_document` keeps its current signature as the legacy path.

### 6.2 `DocumentPlan` schema (`docdesign/ir.ts`, mirrored in Rust for validation)

Two projections, one shared block vocabulary. Versioned: `doc.plan.v1`, `deck.plan.v1`.

```jsonc
// deck.plan.v1 (report/doc is analogous: sections instead of slides)
{
  "v": 1,
  "kind": "deck",
  "title": "Q3 Reliability Review",
  "subtitle": "Incidents, fixes, and the path to 99.95%",
  "system": "consulting",          // design system id (§4 tokens / §10)
  "language": "en",                 // drives CJK/RTL rules
  "slides": [
    {
      "id": "s1",                   // stable id — QA issues point here
      "role": "cover",              // drives layout selection
      "layout": "cover",            // optional explicit layout from §7 catalog
      "slots": {
        "title": "Q3 Reliability Review",
        "subtitle": "Incidents, fixes, and the path to 99.95%",
        "meta": "Platform team · September 2026"
      },
      "notes": "Open with the 2 Sev-1s, then trend."
    },
    {
      "id": "s2",
      "role": "stats",
      "layout": "kpi-3",
      "slots": {
        "headline": "Availability recovered to target",
        "kpis": [
          { "label": "Uptime", "value": "99.96%", "delta": "+0.04 pp", "trend": "up" },
          { "label": "Sev-1 incidents", "value": "2", "delta": "-3 vs Q2", "trend": "down" },
          { "label": "MTTR", "value": "42 min", "delta": "-18 min", "trend": "down" }
        ],
        "footnote": "Source: status page, Jul 1–Sep 30"
      }
    },
    {
      "id": "s5",
      "role": "content",
      "layout": "chart-text",
      "slots": {
        "title": "Error budget burn tracked the incident clusters",
        "chart": {
          "type": "line",            // native chart — P5 editability
          "series": [{ "name": "Burn rate", "values": [ /* … */ ] }],
          "labels": ["Jul", "Aug", "Sep"],
          "highlight": { "index": 1, "label": "Sev-1 cluster" },
          "source": "SLO export 2026-09-30"
        },
        "body": "Burn crossed 1.0 twice: the Aug 12 deploy and the Sep 3 cache stampede. Both map to fixes shipped in the same sprint."
      }
    }
  ]
}
```

Rules encoded in the schema validator (L1):

- Every slide carries a `role` from the catalog taxonomy; the planner must not invent layouts.
- **Density budgets per role** (from the layout spec): e.g. `bullets` ≤ 6 bullets × ~90 chars; `title` ≤ 60 chars; CJK text gets ×0.85 char budget (≈15% more effective width, per research finding).
- Deck coherence checks: no more than 3 consecutive identical layouts; ≥1 `section` divider per ~5 content slides for `deep`; `cover` and `closing` mandatory; speaker notes required for `deep` briefs.
- Citation fields (`footnote`, `source`) must reference the research-mode source ledger when one exists — reusing the `check_sufficiency` gate before planning starts.
- The plan is what the **user can inspect/edit**: the preview pane shows an outline view (future UI; the JSON already supports it, mirroring Copilot's outline-first UX).

### 6.3 Why plans, not prompts

The plan is the artifact every later stage operates on: the compiler renders it, QA points its findings into it (`slideId` + slot), revision patches it. This is exactly the structure that made PPTAgent and DeepPresenter's revision loops effective — and it converts "regenerate the whole document" into "patch slide s5's body copy."

---

## 7. Stages 2–3 — Design tokens, layout catalog, and the compiler

### 7.1 Design tokens (`docdesign/tokens/*.json`)

One JSON file per theme, embedded at build time (`include_str!` for Rust, Vite import for TS) and compiled into three targets. The schema unifies and extends `docgen_helper.py THEMES`:

```jsonc
{
  "id": "ink",
  "name": "Ink",
  "color": {
    "bg": "#FFFFFF", "surface": "#F6F5F2", "ink": "#1A1A1A", "muted": "#6B6B6B",
    "accent": "#2F5D8C", "accent2": "#7A9E7E", "tint": "#E8EEF5", "hairline": "#D9D9D4",
    "onAccent": "#FFFFFF"
  },
  "type": {                       // modular scale, ratio 1.25, body 11pt
    "display": { "size": 38, "face": "display" },
    "h1": { "size": 24 }, "h2": { "size": 17 }, "h3": { "size": 13.5 },
    "body": { "size": 11, "leading": 1.42 }, "caption": { "size": 9 },
    "kpi": { "size": 44, "face": "display" }
  },
  "faces": {
    "display": { "stack": ["Georgia", "Times New Roman", "serif"] },
    "body":    { "stack": ["Calibri", "Segoe UI", "Arial", "sans-serif"] },
    "mono":    { "stack": ["Consolas", "Courier New", "monospace"] }
  },
  "space": { "unit": 8, "pageMargin": [20, 17, 20, 17], "slideMargin": 36,
             "gap": 24, "gutter": 16 },          // px/pt; slideMargin in px @96dpi ≈ 0.5in
  "page": { "pdf": { "size": "A4" }, "deck": { "size": [13.333, 7.5] } },  // 16:9
  "chart": { "palette": ["#2F5D8C", "#7A9E7E", "#C9A227", "#8C4A5D", "#5B7F9E", "#B0B0AA"],
             "gridline": "#E3E3DE", "sourceNotePt": 10 },
  "ooxml": {                      // §3.9: compile to the Theme Part, not baked hex
    "dk1": "#1A1A1A", "lt1": "#FFFFFF", "dk2": "#2F5D8C", "lt2": "#F6F5F2",
    "accent1": "#2F5D8C", "accent2": "#7A9E7E", "accent3": "#C9A227",
    "accent4": "#8C4A5D", "accent5": "#5B7F9E", "accent6": "#B0B0AA",
    "majorFont": "Georgia", "minorFont": "Calibri"
  },
  "rules": { "accentDominance": [0.05, 0.10], "bgDominance": [0.60, 0.70],
             "minContrast": 4.5 }
}
```

**Compile targets** (all generated at build time or lazily by the compiler):
1. **PptxGenJS**: `defineSlideMaster` background/colors + `pptx.theme = {...}` head values; every color the compiler emits is `tokens.color.x.replace('#','')` — the `#`-corruption class of bugs becomes structurally impossible.
2. **docx npm**: `styles.default` (document/heading/quote/caption paragraph styles) built once from tokens.
3. **Paged.js CSS**: `:root { --dd-ink: …; --dd-gap: … }` custom properties + `@page` margins from `space.pageMargin` — replacing `pdfprint.rs BASE_CSS` hardcodes with token-generated CSS (BASE_CSS becomes the token-rendered fallback).
4. **Python fallback**: `docgen_helper.py` loads the same JSON (shipped alongside) instead of its private `THEMES` dict — the two engines stop diverging (closes G3).

**7 themes** ship at v1 (porting the existing `ink/midnight/emerald/plum/amber/crimson/teal` plus font pairing variants), each also validated programmatically for WCAG contrast of ink/bg, muted/bg, onAccent/accent pairs.

### 7.2 Layout catalog (`docdesign/catalog/*.json`)

A **fixed taxonomy** synthesizing the consulting-deck archetypes, PowerPoint's built-ins, and PPTAgent's role map — ~16 deck layouts, ~12 document regions. Each entry is a **slot spec** with geometry and budgets:

```jsonc
{
  "id": "chart-text",
  "roles": ["content"],
  "deck": {
    "canvas": [13.333, 7.5],
    "slots": [
      { "id": "title",  "rect": [0.5, 0.4, 12.33, 0.9],  "style": "h2",
        "budget": { "chars": 80, "lines": 2 } },
      { "id": "chart",  "rect": [0.5, 1.6, 7.4, 5.2],    "kind": "chart" },
      { "id": "body",   "rect": [8.3, 1.6, 4.5, 5.2],    "style": "body",
        "budget": { "chars": 420, "lines": 14, "cjkFactor": 0.85 } },
      { "id": "footnote","rect": [0.5, 7.0, 12.33, 0.3], "style": "caption" }
    ]
  },
  "doc": { "analog": "figure-caption" }
}
```

Deck catalog v1: `cover`, `agenda`, `section`, `bullets`, `two-col`, `comparison`, `chart-text`, `chart-full`, `kpi-3`, `kpi-4`, `quote`, `timeline`, `table`, `image-text`, `statement`, `closing`.
Document regions v1: `cover`, `toc`, `section-divider`, `heading-body`, `two-col`, `callout`, `data-table`, `figure-caption`, `quote`, `kpi-strip`, `code-block`, `appendix`.

Non-negotiables baked into every spec (from the research avoid-list): no decorative stripes/bars/underlines; title top-left aligned; one gap value across slides; card grids capped at 1-in-5 slides (a plan-level L1 check); no centered body text.

### 7.3 The layout compiler (`docdesign/compile.ts` + `compile.rs` mirror for plan validation)

Deterministic: `compile(plan, tokens, catalog) → EngineProgram`. No model in the loop; fully unit-testable with vitest (harness already set up).

- **Deck → PptxGenJS program**: one `defineSlideMaster` per layout (background, logo region, footer/pagination margin boxes), then per slide: `addSlide({ masterName })` + `addText/addChart/addTable` with slot rects and token-derived styles; native charts with schema-valid label positions (no `dLblPos` on stacked series — the #1 PowerPoint-repair trap); option objects never shared (pptxgenjs mutates in place).
- **Doc → docx-npm program**: styles from tokens; heading hierarchy `HeadingLevel.*`; tables with `cantSplit` rows + repeated header; keep-with-next on headings; cover/TOC/section dividers from regions; footers with page numbers.
- **Doc → Paged.js HTML**: semantic HTML + token CSS custom properties; `@page` rules, `break-inside: avoid` on tables/figures/callouts, `string-set` running heads, `target-counter` for TOC page numbers.
- **Fallback Python**: the same plan + tokens drive `conduit_docgen` (headless automations where the main window isn't available).

The compiler emits the same `docgen://run` payload as today, so **DocCodeRunner, jsdocgen.rs, and the write path are untouched**. The only change: the JS payload is compiler output rather than model output.

### 7.4 Serialization

The compiler runs per-generation in the existing single-runner iframe, but the print pipeline gets a **pool of 2 hidden print windows** replacing the single window + `RENDER_LOCK` (QA rasterization doubles print traffic; §8). DocCodeRunner concurrency stays 1 — a compiled deck renders in milliseconds, so this is not the bottleneck.

---

## 8. Stage 4–5 — Layered validation & the visual revision loop (`docqa`)

Modeled on `validate_diagram_html` (in-turn self-correction) and `citation_lint.rs` (mechanical report → UI event). Five layers, cheapest first:

### 8.1 Deterministic checks (always run, zero model calls)

| Layer | When | Checks |
|---|---|---|
| **L1 plan** | after `plan_document` | JSON schema; budgets per slot; role/catalog conformance; layout repetition caps; cover/closing presence; citation-ledger coverage; CJK budget factors |
| **L2 compile** | compiler output | structural AST assertions: every slot filled or explicitly `null`; no `#` in hex; chart label positions legal; no shared option objects; page/slide count == plan count |
| **L3 post-write geometry** | after engine write | **pptx**: python-pptx/JS walk — estimated text height vs slot rect (using budget math), shapes within canvas, bounding-box overlap of text-bearing shapes, leftover placeholders (`xxx`, `TODO`, `lorem`, `[insert`), every image rId resolves, chart XML parses. **docx**: heading hierarchy monotonic, tables ≤ page width, `cantSplit`+header set, no empty sections. **pdf**: `__renderState` error capture (exists), page count vs plan, unrendered `target-counter`s |
| **L4 render probes** | on the QA PDF | pdf.js text layer: per-page glyph bounding boxes vs page box → real overflow detection (this sees what LibreOffice *actually laid out*, including font substitution, so budgets keep ~10% slack); contrast sampling of rendered pixels vs token pairs; blank-page detection; near-empty page detection (widow content) |

Every issue: `{ severity, rule, irPointer: {slideId|sectionId, slotId}, message, suggestedFix }`. L1–L3 failures loop back to the model **in-turn** (same pattern as diagram validation) for a plan patch; they do not abort the run.

### 8.2 Render → rasterize

The artifact is converted to PDF (direct for the PDF engine; LibreOffice bridge for docx/pptx — the existing `office_to_pdf` mtime-cached path) and pages are rasterized **by the already-running pdf.js** (`PdfViewer` renders canvases today; headless equivalent renders at ~110 dpi into PNGs in a temp dir). No new rendering engine is introduced.

### 8.3 VLM critique (once per document, at the end)

One multimodal pass over page thumbnails (batched, e.g. 8 pages/image grid) with a rubric fixed to **Content / Design / Coherence** (PPTEval) plus the DOCR-Inspector-style defect checklist: overflow, overlap, low contrast, density (clutter/emptiness — GAD-style), orphan headings, inconsistent spacing, unreadable charts, "AI-look" tells. Output: score 0–5 per axis + defect list, each tagged with the page → mapped to IR pointers via the L4 geometry map.

Calibration note: VLM judges correlate with humans at ρ ≈ 0.86–0.89 on this rubric — strong enough to *rank* revisions, so the loop trusts it for prioritization but L1–L4 rule checks remain the veto layer.

### 8.4 The revision loop

```
compile → write → L1–L4 checks ──fail──► patch request to planner (in-turn, ≤2)
                                   │            (targeted: patch slideId s5 body,
                                   │             NOT regenerate the deck)
                                   ▼ pass
                              rasterize → VLM critique (once)
                                   │
                score < threshold AND loops < 2 ──► targeted IR patch → recompile
                                   ▼
                    done: artifact + "chat:doc-qa" report event
```

The QA report reuses the citation-report UI pattern: a dismissible strip above the artifact card — "QA: 12 checks passed · 1 fixed (slide 5 body overflow) · VLM 4.4/5" with an expandable issue list. Design intent: the **user sees the system looked at the document**, and the transcript records what was fixed.

Cost control: L1–L4 are free; L5 is exactly one VLM call for typical decks (≤2 for big reports). DeepPresenter's ablations put the whole loop's value at +0.12…+0.37 quality — the cheapest quality win in the pipeline.

---

## 9. Tool contract & prompt consolidation

**New/changed tools** (`chat/tools/specs.rs` + `mod.rs`):

- `plan_document` (new) — the default entry point for docx/pptx/pdf.
- `revise_document { artifactPath, patches: IRPatch[] }` (new) — targeted revision; also exposed to the user as an editing affordance later.
- `generate_document` — kept, marked legacy in its description; **`GENERATE_DOCUMENT_DESC` rewritten** (it still claims "writing a complete Python program").
- `generate_file` / `generate_diagram` — unchanged (`artifacts.rs` minimal writers stay only for `generate_file`).

**Single-source style guidance:** the per-engine style guides in `generate.rs` (`DOC_STYLE_GUIDE`, `JS_DOCGEN_GUIDE`, `HTML_PDF_GUIDE`) are **generated from tokens + catalog** at build time (a small codegen step emitting a markdown digest). The embedded skills (`skills/docx-skill.md`, `pptx-skill.md`, `pdf-skill.md`) keep engine-idiom content (API pitfalls) but drop anything token-derived. The planner prompt documents the plan schema and the design-system rules (dominance ratios, avoid-list) — one place, not five (closes G4).

---

## 10. Reusable design systems

A **design system** = one tokens file + a curated layout subset + typographic voice + cover treatment + chart rules + an explicit avoid-list. Shipped in `docdesign/systems/*.json`, selectable via `plan_document.system`:

| System | Fonts | Voice | Signature layouts | For |
|---|---|---|---|---|
| **Editorial** | Georgia display / Calibri body | long-form prose, generous margins | `heading-body`, `figure-caption`, `quote`, `section-divider` | reports, briefs, documentation (docx/pdf) |
| **Consulting** | Segoe Semibold display / Segoe body | dense, action-titles, every slide has a takeaway | `kpi-3`, `chart-text`, `comparison`, `timeline`, `action-title` variants | analysis decks, reviews |
| **Product** | Segoe UI display+body, tight scale | punchy headlines, big numbers, 1 message/slide | `statement`, `kpi-4`, `image-text`, `chart-full` | launches, status updates |
| **Minimal** | one family, two weights | maximal whitespace, hairline rules | `bullets`, `quote`, `statement` | memos, one-pagers |

Each system compiles to all engines, so a DOCX report and its companion deck from the same system share brand (the current Python-fallback themes become data files under this scheme, unifying the two engines' look — closes G3 fully). Later: user-defined systems as plain JSON in the workspace, plus `.pptx`/`.dotx` template masters as an alternate token source (import theme part → tokens) for org branding.

---

## 11. File/module map

**New (frontend, `src/lib/docdesign/`)** — `ir.ts` (schemas + zod-style validation), `tokens.ts` + `tokens/*.json`, `catalog/*.json`, `compile-deck.ts`, `compile-doc.ts`, `compile-pdf.ts`, `qa.ts` (L1–L2 + geometry helpers), `systems/*.json`. Tests alongside (vitest).

**New (Rust, `src-tauri/src/chat/docdesign/`)** — `mod.rs` (plan validation mirror + IR types w/ serde), `plan.rs` (the `plan_document`/`revise_document` tool impls, planner prompt), `qa.rs` (L3 geometry checks, QA report assembly, `chat:doc-qa` event), `tokens.rs` (embed JSON, emit theme-part XML for OOXML).

**Modified** — `chat/tools/mod.rs` + `specs.rs` (new tool schemas, rewritten descriptions); `chat/dispatch.rs` (route plan tool); `chat/pdfprint.rs` (BASE_CSS ← tokens; print-window pool of 2); `pygen.rs`/`docgen_helper.py` (load token JSON); `skills/*.md` (drop token-derived rules, keep idioms); `ArtifactPreviewPane.tsx` (outline/plan view + QA strip); `src/state/chat.ts` + `useChatEvents.ts` (`doc-qa` event, mirroring `citation-report`).

**Untouched** — `jsdocgen.rs`, `DocCodeRunner.tsx`, `office.rs`, `db/artifacts.rs` (a `qa_status` column is the only candidate addition), preview components, LO bridge.

---

## 12. Migration plan

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 — Tokens** (≈2–3 d) | tokens JSON + 7 themes; Python reads JSON; BASE_CSS generated from tokens; style-guide codegen; fix `GENERATE_DOCUMENT_DESC` | one theme change propagates to all 3 engines with no hand edits |
| **1 — Plan + compile: decks** (≈1 wk) | `plan_document`, `deck.plan.v1`, deck catalog, PptxGenJS compiler, L1–L3 deck checks | default deck path is plan→compile; legacy `generate_document` still works; overflow issues < baseline in a 10-deck eyeball suite |
| **2 — Compile: documents + PDF** (≈1 wk) | doc regions, docx compiler, Paged.js template compiler, L1–L4 doc checks | docx/pdf join the compiled path; tables/figures survive pagination in the suite |
| **3 — Visual loop** (≈1 wk) | rasterize pipeline, VLM critic, revision loop, `doc-qa` UI strip | a seeded bad deck (overflow, low contrast) is detected and fixed without user involvement |
| **4 — Systems + polish** (≈3–4 d) | 4 design systems; system picker in UI; plan outline view; `revise_document` tool; print-window pool; Python compiler parity | system switch re-brands an existing artifact in one action |

Rollback safety: the compiled path ships behind a setting (`docgen.mode: "staged" | "legacy"`, default staged); the legacy tool contract remains functional throughout.

## 13. Risks & open questions

- **Planner JSON quality from local models.** Relay explicitly supports local models; strict JSON mode is weaker there. Mitigation: schema-repair retry + the existing "STRICT addendum" pattern for local providers; legacy path remains their fallback.
- **Compiler capability ceiling.** A compiled path can't express arbitrary bespoke layouts. Accepted: the catalog covers the high-frequency 90%; the legacy raw-code path remains for the tail (and `revise_document` nudges users back to plans).
- **LibreOffice-dependent QA truth.** L4 measures LO's layout, not PowerPoint's (font substitution ≠ user's render). Mitigation: ship only Office-ubiquitous faces; keep ~10% width slack; treat L4 as a lower bound on overflow.
- **VLM availability.** The critic needs a vision-capable model; when the active provider lacks vision, the loop degrades gracefully to L1–L4 and says so in the QA strip.
- **pptxgenjs OOXML quirks** (rich-text `<a:pPr>` per run, `dLblPos` traps) are compiler-test fixtures, not runtime risks — the compiler emits known-good patterns and L2 asserts them.
- **Naming**: `docdesign`/`docqa` chosen to avoid the `artifacts` collision; do not add document concepts under `src-tauri/src/artifacts/`.

---

## 14. Sources (research foundation)

- Gamma — how it works / card-based editor: help.gamma.app, gamma.app/blog/card-based-editor
- Beautiful.ai DesignerBot & Smart Slides: prnewswire.com, beautiful.ai/smart-slides
- Microsoft Copilot Narrative Builder: support.microsoft.com, microsoft.com Wave-2 blog
- Anthropic Agent Skills & skills repo (pptx/docx/pdf skill practices): anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills, github.com/anthropics/skills
- OpenAI Code Interpreter: developers.openai.com/api/docs/guides/tools-code-interpreter
- STORM: arXiv:2402.14207; LlamaIndex report-generation blocks: llamaindex.ai blog
- PPTBench: arXiv:2512.02624 (template lift 37.91→55.97; generation 30.25; judge ρ 0.86–0.89)
- PPTAgent / PPTEval: arXiv:2501.03936 (EMNLP 2025) — Content/Design/Coherence, edit-based generation
- AutoPresent / SlidesBench: arXiv:2501.00912 (CVPR 2025) — programmatic > image generation
- DeepPresenter: arXiv:2602.22839 — state mismatch, inspect_slide loop, beats Gamma 4.44 vs 4.36
- VFLM "Seeing is Improving": arXiv:2603.22187 — render-feedback, OCR F1 0.9376 vs 0.8672
- SlideGen / GAD metric: arXiv:2512.04529; Talk-to-Your-Slides: arXiv:2505.11604
- DOCR-Inspector (28-category VLM document judge): arXiv:2512.10619
- TeXpert (LLM-LaTeX failure modes): arXiv:2506.16990
- ECMA-376 Theme Part: c-rex.net OOXML samples; brandwares.com theme/font hacking; Templafy brand distribution
- Paged.js: pagedjs.org; Chrome 131 page margin boxes: developer.chrome.com/blog/print-margins
- WeasyPrint RTL/CJK limitations: github.com/Kozea/WeasyPrint #106, #2372, #2298; W3C clreq-gap
- Typst vs LaTeX perf: emikru.com labs case study (40× gen, 7× memory); justinpombrio.net; InfoWorld
- Prince XML pricing: princexml.com/purchase; Slide layout taxonomies: strategyu.co, deckary.com, linia-presentations.com

---

## 15. Implementation status (2026-09-04)

The architecture is built and tested. What shipped, and the two deliberate deviations from this document:

| Piece | Status | Where |
|---|---|---|
| Token source of truth (7 themes, type scales, spacing, chart palettes, faces) | ✅ Shipped | `src/lib/docdesign/tokens.json` — imported by TS, `include_str!`-ed by Rust, staged to the Python helper by `pygen.rs` |
| Print CSS generated from tokens (`BASE_CSS` constant deleted) | ✅ Shipped | `chat/docdesign/mod.rs::base_css()` consumed by `pdfprint.rs` |
| Deck catalog (13 layouts, slot rects, CJK-aware text-fit math) | ✅ Shipped | `src/lib/docdesign/catalog.ts` |
| Deck plan IR + L1 validation (budgets, coherence, repetition caps) | ✅ Shipped | `src/lib/docdesign/ir.ts` |
| Deck compiler (PptxGenJS programs) + L2 invariants (bare hex, single save, no `dLblPos`, token fonts, master integrity) | ✅ Shipped | `src/lib/docdesign/compileDeck.ts` |
| Document IR + L1 (sections/blocks, prose budgets) + docx compiler + PDF-HTML compiler | ✅ Shipped | `irDoc.ts`, `compileDoc.ts`, `compilePdfHtml.ts` |
| `plan_document` tool (pptx/docx/pdf; plan sanity steer, PLAN_GUIDE, QA narration) | ✅ Shipped | `chat/docdesign/plan.rs`, registered in `tools/mod.rs` + `specs.rs` |
| Compile/execute round trip (`docdesign://compile` → sandboxed runner) | ✅ Shipped | `DocDesignRunner.tsx` + shared `docRunnerFrame.ts`; `docdesign_complete` IPC |
| L4 render probes (pdf.js: text-outside-page, blank pages, page count; LibreOffice bridge for office files) | ✅ Shipped | `rasterize.ts`, `chat/docdesign/qa.rs`, `docdesign://qa` + `docdesign_qa_complete` |
| Design-QA report to UI (`chat:doc-qa` → strip in the artifact preview pane) | ✅ Shipped | `state/docQa.ts`, `useChatEvents.ts`, `DocQaStrip` in `ArtifactPreviewPane.tsx`, `.doc-qa-strip*` CSS |
| Named design systems (editorial/consulting/product/minimal: theme default + layout subset + fit warning) | ✅ Shipped | `systems.json` + `systems.ts`, `system` arg on `plan_document` |
| `revise_document` tool (plan sidecar `<file>.plan.json`, slot/block patches, recompile + re-QA) | ✅ Shipped | `plan.rs::revise_document` + `apply_patches`, registered tool + schema |
| Harness bridge exposure (`conduit-tools` MCP: routing, advertised schemas, app-side whitelist, INSTRUCTIONS.md preamble) | ✅ Shipped — harness agents (Claude Code, Pi, Omp, OpenCode, Kimi…) get `plan_document`/`revise_document` and are told to prefer them | `bin/conduit_browser_mcp.rs`, `mcp_tools_bridge.rs`, `harness_bundle.rs` |
| VLM visual critique (L5) | ⏸ Seam only — `QaReport.critic` carries "not-run"; a vision-model call needs the provider stack threaded into tool context (future work; the deterministic L1–L4 loop ships the core value) | `qa.rs` |
| Print-window pool (2 windows) | ❌ Intentionally not built — `with_webview` COM calls are UI-thread-affine, so prints cannot overlap anyway; the lock only orders them | — |
| Python plan compiler (headless parity) | ❌ Not built — headless runs steer to `generate_document language="python"` (existing behavior); full Python compiler deferred | — |

Tests: Rust `chat::docdesign` (24) + token/contrast/CSS tests, TS `docdesignTokens/Deck/Doc/Qa/Systems` (~50), plus the full pre-existing suites (`cargo test --lib` 734, `vitest` 663) green.
