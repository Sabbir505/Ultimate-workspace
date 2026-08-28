# How Claude Creates Diagrams — and What Relay Needs to Match That Fidelity

*Research report · 2026-08-26 · no code changes*

> **Naming note:** This document refers to the project as "Conduit" because it was written before the 2026-08-27 user-visible rebrand to "Relay" (commit `e9abc7c3`). The findings still apply; the name has not. See `README.md` and `AI CONTEXT/RELEASE.md` for the current naming.

## 1. How Claude actually does it

There are two distinct systems on claude.ai today:

### a) "Custom visuals" (beta, 2026) — interactive HTML built inline
Per Anthropic's help center ("Custom visuals in chat and Cowork", "Visual and interactive content"):

- When a visual explains better than text, Claude **builds one from scratch, right in the conversation — using HTML**. Flowcharts, charts from uploaded CSVs, comparisons, concept diagrams.
- They are **fully interactive inline**: clickable buttons, sliders, expand to fullscreen, and clicking inside the visual sends a follow-up prompt (e.g. drill into Q3). Claude rebuilds/updates it as you iterate conversationally.
- Ephemeral by default (whiteboard-style); can be copied as image, downloaded as **`.svg` or `.html`**, or saved as a persistent artifact.

### b) The Artifacts tool — five typed outputs with a guaranteed runtime
From the artifacts tool spec (system prompt, Sonnet 4.5 full, 2025-09-29 mirror):

| Type | MIME | Notes |
|---|---|---|
| Code | `application/vnd.ant.code` | any language |
| Document | `text/markdown` | |
| HTML | `text/html` | single file (HTML+JS+CSS); external scripts **only from cdnjs.cloudflare.com**; "create functional visual experiences with working features rather than placeholders" |
| SVG | `image/svg+xml` | rendered natively |
| **Mermaid** | `application/vnd.ant.mermaid` | **first-class type**, rendered by the UI |
| React | `application/vnd.ant.react` | the powerhouse for charts/dashboards |

The React runtime is the fidelity engine. It ships with a **pre-installed, version-pinned library set** the model can import with zero setup:

- **recharts** (charts), **d3**, **Plotly**, **Chart.js** (more charts), **three.js** (3D)
- **shadcn/ui** components + **lucide-react** icons + Tailwind core utilities (consistent design language, no compiler)
- **papaparse** (CSV), **SheetJS** (Excel), **lodash** (groupby etc.), **mathjs**, **Tone**, **mammoth**, **tensorflow**
- "NO OTHER LIBRARIES ARE INSTALLED OR ABLE TO BE IMPORTED."

Plus supporting machinery:

- **Authoring discipline in the prompt**: which type to use for which job, "build complete, functional experiences with meaningful interactivity", never localStorage, no required props / default export, concise identifiers.
- **Iteration protocol**: `update` (old_str/new_str, <20 lines & <5 locations, max 4 per message) vs `rewrite` — cheap conversational refinement without regenerating.
- **Data access**: `window.fs.readFile` for uploads, Papaparse for CSV, lodash for computation; a JS "analysis tool" for heavy calculations, with explicit guidance that most visualizations don't need it.
- Claude API access from inside artifacts ("Claude in Claude") for LLM-powered visuals.

**The key insight: Claude's diagram fidelity is not a better renderer — it is (1) a guaranteed runtime with professional libraries pre-installed, (2) strict prompt-level routing of each job to the right format, and (3) a tight iterate-on-the-artifact loop.** A flowchart is Mermaid (auto-layout — the model never positions pixels); a chart is Recharts (the model never draws an axis); an interactive explainer is single-file HTML with working controls.

## 2. Where Conduit stands today

- `generate_diagram` tool: the model **hand-authors inline-SVG HTML** → marker-prefixed, structurally validated (`validate_diagram_html` rejects `<script>`/`<iframe>` and feeds a style guide + issue report back to the model), rendered **statically** (sanitized, scripts blocked) inline and in the preview pane, PNG/SVG export. ✔ validation loop is a genuine strength; ✘ every visual is hand-drawn SVG.
- **Mermaid already first-class for fenced ```mermaid blocks** in chat (`MermaidDiagram.tsx`: lazy-loaded, theme-aware via CSS tokens, streaming-safe, sanitized). ✔ but only in chat, not a preview-tab artifact type.
- **Live HTML preview** (post-2026-08-26 change): interactive html now renders with `allow-scripts allow-forms allow-modals allow-popups` in artifact tabs — but with **no curated library story** (external CDN scripts are unreliable/blocked under the production CSP).
- **JSX/TSX live preview** (`JsxPreview`): Babel-compiles into an iframe with **bare React inlined** — no Recharts/d3/shadcn, so chart quality depends entirely on the model hand-rolling SVG.
- Interactive content routes to tabs (safe), not inline in chat — Claude's custom visuals are inline *and* live.

## 3. Fidelity gap — recommended changes (in priority order)

1. **Bundle a curated lib set into the JSX live-preview runtime** (biggest win). Extend `JsxPreview`'s inlined iframe bundle with pinned **recharts + lucide-react + d3** (+ Tailwind core stylesheet; optionally a few shadcn-style primitives) served from app assets, and tell the model (tool description/system prompt) that charts/dashboards should be `.tsx` artifacts importing them. Charts stop being hand-drawn SVG overnight. *Effort: medium — the Babel+iframe pipeline already exists.*

2. **Promote Mermaid to a preview-tab artifact type + steer flowcharts to it.** Reuse the `MermaidDiagram` pipeline for `.mmd`/mermaid artifacts opened in tabs; rewrite `DIAGRAM_STYLE_GUIDE` so flowcharts/sequence/ER/state diagrams default to **Mermaid (auto-layout)** and hand-positioned SVG is reserved for freeform illustration. *Effort: low–medium.*

3. **Curated-CDN support for live HTML artifacts.** Allow `cdnjs.cloudflare.com` scripts in the live iframe (Claude's exact rule). Requires CSP work for production builds (`script-src`/`frame-src` additions, or serve previews via `blob:` URLs which don't inherit CSP) — in dev it already works. Then single-file interactive explainers get real libraries. *Effort: medium (CSP is the fiddly part).*

4. **Rewrite the authoring guidance to route by job** (mirroring Claude's type table): flow/sequence/ER → Mermaid · charts/dashboards → React+Recharts artifact · interactive explainer → single-file HTML (cdnjs only) · freeform static → SVG. *Effort: small — prompt/tool-description text only; compounds with 1–3.*

5. **Hot-reload artifact tabs + refine loop.** Watch the artifact file and re-read the preview when `edit_file` touches it, so "make the bars blue" style iterations apply instantly — Claude's update/rewrite UX. *Effort: medium.*

6. **Optional, later: inline live visuals in chat** (Claude's custom-visuals layer) — allow `allow-scripts` iframes inline for interactive content instead of routing to tabs, with content sizing + a click-to-follow-up hook. Bigger security/UX tradeoff; the tab routing we shipped is the safer intermediate step. *Effort: large.*

7. **Already at parity:** PNG/SVG export (`ArtifactExportMenu`) ≈ Claude's copy-as-image/download; structural validation with model self-correction is something Claude doesn't have — keep it.

## Sources

- support.claude.com — "Custom visuals in chat and Cowork" (art. 13979539); "Visual and interactive content" (art. 13641943)
- Artifacts tool spec mirror (claude.ai system prompt, 2025-09-29): github.com/jujumilk3/leaked-system-prompts (`anthropic-claude-sonnet-4.5-full_20250929.md`)
- Conduit code: `src-tauri/src/chat/tools/generate.rs` (`generate_diagram`, `DIAGRAM_STYLE_GUIDE`, `validate_diagram_html`), `src/components/chat/MermaidDiagram.tsx`, `src/components/chat/JsxPreview.tsx`, `src/components/chat/ArtifactPreviewPane.tsx`
