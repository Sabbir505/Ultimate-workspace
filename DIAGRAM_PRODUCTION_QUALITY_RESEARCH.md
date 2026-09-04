# Making Relay Diagrams Production-Grade — Current State & Research

*Research report · 2026-09-05 · no code changes*

Follow-up to `diagram_fidelity_report_2026-08-26.md` (which covered *which formats* to route to; this one covers *render quality* — making whatever we render look clear and professional).

## 1. What exists today (verified in code)

Solid foundations already in place:

- **Mermaid pipeline** (`src/components/chat/MermaidDiagram.tsx`): lazy-loaded Mermaid 10.9.6, streaming-safe 250 ms debounce, parse-first error strategy, DOMPurify sanitization, LRU cache of rendered SVGs, theme re-init on theme flip. Rendered in chat (`MessageBubble.tsx:1465`), artifact tabs (`ArtifactPreviewPane.tsx`), and terminal feeds (`TerminalPane.tsx:681`).
- **Lightbox** (`DiagramLightbox.tsx`): cursor-anchored zoom 25 %–800 %, drag pan, viewBox-sized paper.
- **Export** (`ArtifactExportMenu.tsx`): PNG/JPG/SVG/copy-image, SVG-first raster path (`svgToRaster`) with `html-to-image` fallback, theme-aware export background.
- **generate_diagram** (`src-tauri/src/chat/tools/generate.rs`): hand-authored SVG with structural validation + model self-correction loop, style-guide routing (`DIAGRAM_STYLE_GUIDE`).
- **Prompt routing** (`src-tauri/src/chat/prompts.rs` ~line 186): mermaid fences by default, ASCII art forbidden.

## 2. Concrete defects found (these are why output looks "not quite professional")

1. **Broken font: `fontFamily: "var(--font-sans)"`** (`MermaidDiagram.tsx:49`). `--font-sans` is **defined nowhere** — `tokens.css` only defines `--font-ui` (Space Grotesk) and `--font-mono`. Every diagram renders in the webview default font (Segoe UI), silently mismatching the app's typography. The single biggest "looks off" cause for a one-line fix.
2. **Grey-only palette**: `--accent` is `#6e706f` (grey) in both themes, and the cyan fallbacks in code (`#88C0D0`, `#0078a8`) are dead. Node fills, borders, and highlights are all grey — diagrams read as washed-out wireframes instead of structured visuals.
3. **Fixed 2× export** (`ArtifactExportMenu.tsx:175,249,264`): no scale choice, no transparent-background toggle. Slide/print use wants 3–4× PNG or true vector SVG.
4. **480 px height clamp** (`chat.css:2080,2103`): tall flowcharts are shrunk until text is unreadable inline; the lightbox is the only escape.
5. **Two-bucket theming**: every non-light theme in the theme gallery gets the same "dark" diagram palette — no per-theme diagram accent, so custom themes don't reach diagrams.
6. **No Mermaid 11**: v10.9.6 predates the v11 overhaul — `look: classic | neo | handDrawn`, the `layout:` config API, ~30 new flowchart shapes, and significantly better default rendering.
7. **No layout/spacing config**: default `nodeSpacing`/`rankSpacing`/`curve` → cramped nodes, squiggly `basis` edges. Professional output uses deliberate spacing and edge style.
8. **No model-side authoring rules**: the prompts never tell the model how to write a *good* diagram (label length, node count, grouping, direction) — so we get spaghetti layouts and paragraph-length node labels.
9. **Dead-end error UX**: on a parse failure the user sees raw source + error text with no "retry/repair" affordance.
10. **Garbled sentence** in `prompts.rs` "## Artifacts & diagrams" section ("surface in the. For PowerPoint decks prefer…") — worth fixing while in there.

## 3. Research: what "production-grade" Mermaid looks like

### a) ELK layout engine (the biggest rendering win)
Mermaid's default dagre layout degrades on complex graphs — crossing edges, uneven ranks. The official [`@mermaid-js/layout-elk`](https://www.npmjs.com/package/@mermaid-js/layout-elk) package registers the Eclipse Layout Kernel (elkjs): draw.io's docs note it yields "neater orthogonal connector paths and tighter shape spacing on large or deeply-nested graphs", and Docmost, Trilium and others adopted it for exactly this. Cost: ~1.5–2 MB — so **lazy-load it** the way `mermaid` itself is already lazy-imported, and default flowcharts to `layout: elk` (per-diagram frontmatter can override).

### b) Mermaid 11 `look` + `layout` APIs
v11 adds [`look: "classic" | "neo" | "handDrawn"`](https://mermaid.ai/open-source/config/schema-docs/config.html) (`neo` is the modern flat-professional rendering; `handDrawn` is a Rough.js sketch style nice for whiteboard-mode) and the unified `layout: "dagre" | "elk"` config. Upgrading is a prerequisite for ELK and unlocks the new shapes the model may already try to emit.

### c) Theming done right
Official guidance: start from the **`base`** theme and override `themeVariables` for full control (the current code inherits `default`/`dark` and only overrides some vars — that's why odd colors bleed through). Keep `neutral` in mind for print/B&W exports. Deliberate `flowchart` config matters as much as color: `nodeSpacing` (default 50), `rankSpacing` (default 50), `curve` (`basis` squiggles vs `linear`/`step` orthogonal business look), `padding`, and label wrapping (`wrappingWidth`).

### d) Model-side authoring discipline
Research on LLM-generated Mermaid (e.g. the [sequence-diagram benchmark on arXiv](https://arxiv.org/html/2511.14967v1), practitioner writeups like [smcleod.net](https://smcleod.net/2024/10/generating-diagrams-with-with-ai-/-llms/)) converges on: **constrain labels** (short, ≤ ~5 words), **cap node count per diagram** (split big systems into multiple diagrams), **use subgraphs for grouping**, **state direction explicitly**, and **show in-context examples** of well-formed output. Self-correction (validate → feed errors back) measurably improves validity — Relay already has this pattern for `generate_diagram` HTML; mermaid parse errors should feed the same loop (auto-retry once, or a one-click "Fix with AI" on the error card).

### e) Export quality bar
SVG is the professional deliverable (already supported — make it the prominent option); raster PNG should default to **3×** (Retina/slide-safe) with a scale picker (1×/2×/4×) and an explicit **transparent vs opaque background** toggle. Relay's SVG-first raster path already avoids the classic foreignObject-blank bug; it just needs the controls.

## 4. Recommended changes (priority order)

**P0 — small diffs, immediate visible lift**
1. `fontFamily: "var(--font-ui)"` (or resolve the Space Grotesk stack to a literal string) + keep `fontSize` in themeVariables. *(1 line)*
2. Add a flowchart/sequence config block: `flowchart: { nodeSpacing: 55, rankSpacing: 60, curve: "linear", padding: 12, useMaxWidth: true }`, `sequence: { … }` tuning. *(small)*
3. Per-theme diagram palette: give each theme a real diagram accent (extend `tokens.css` with e.g. `--diagram-accent`, `--diagram-accent-2`) instead of the grey-only `--accent`; remove dead fallbacks. *(small)*
4. Export controls: scale picker (1×/2×/3×/4×, default 3×) + transparent-background toggle; promote SVG export. *(medium-small)*
5. Prompt-side authoring rules in `DIAGRAM_STYLE_GUIDE` + system prompt: short labels, ≤ ~15 nodes per diagram (split otherwise), subgraphs for grouping, explicit direction, `classDef` category colors, no styling inside labels. Also fix the garbled prompts.rs sentence. *(text only)*

**P1 — structural**
6. Upgrade mermaid → v11 (API-compatible for our usage; verify `parse`/`render` and the error-SVG regex still hold). Prerequisite for the rest.
7. Register ELK (`registerLayoutLoaders`, dynamic import) and default `layout: "elk"` for flowcharts; let per-diagram frontmatter override.
8. Error-recovery UX: on parse failure offer "Fix with AI" that resends source + mermaid error to the active agent; if the diagram came from the agent mid-conversation, auto-feed the error back once.
9. Raise inline clamp (480 → ~600 px) with a subtle "expand" affordance; keep lightbox for full-size.
10. Wire the theme gallery to diagram tokens so every theme renders diagrams in its own palette.

**P2 — polish / later**
11. Optional `look: "handDrawn"` toggle (whiteboard mode).
12. PDF export of diagrams (print-quality vector path via pagedjs, which is already a dependency).
13. Regression corpus: keep sample `.mmd` files (like `traffic.mmd`) and add render smoke tests to vitest so theme/config changes can't silently break rendering.

## 5. Sources

- [@mermaid-js/layout-elk (npm)](https://www.npmjs.com/package/@mermaid-js/layout-elk) · [Eclipse ELK](https://eclipse.dev/elk/)
- [draw.io — Mermaid layout engines](https://www.drawio.com/docs/manual/mermaid/mermaid-layout-engine/) · [Obsidian forum — ELK request](https://forum.obsidian.md/t/mermaid-support-elk-layout-system-in-core-obsidian/95700) · [Docmost PR #1723](https://github.com/docmost/docmost/pull/1723)
- [Mermaid config schema (`look`, `layout`, `handDrawnSeed`)](https://mermaid.ai/open-source/config/schema-docs/config.html) · [Mermaid theming docs](https://mermaid.ai/open-source/config/theming.html)
- [LLM-to-Mermaid sequence diagram benchmark (arXiv 2511.14967)](https://arxiv.org/html/2511.14967v1) · [Generating diagrams with LLMs (smcleod.net)](https://smcleod.net/2024/10/generating-diagrams-with-with-ai-/-llms/) · [Self-correcting Mermaid generator (Medium)](https://djajafer.medium.com/i-built-an-ai-mermaid-diagram-generator-that-fixes-its-own-mistakes-26552047c37a)
- Relay code: `MermaidDiagram.tsx`, `ArtifactExportMenu.tsx`, `DiagramLightbox.tsx`, `chat.css`, `generate.rs`, `prompts.rs`, `tokens.css` (line numbers in §2)
