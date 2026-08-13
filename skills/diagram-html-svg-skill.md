---
name: diagram-html-svg
description: "Use this skill when the user wants a STANDALONE, exportable diagram artifact (a downloadable SVG/PNG file, a large canvas, or a layout Mermaid can't model). For a normal in-chat diagram, you do NOT need this skill — just emit a ` ```mermaid ` fenced block in your reply and it renders inline. Triggers for this skill: explicit ask for an exportable diagram file, a large standalone schematic, or a node layout that doesn't fit a Mermaid lexer."
---

# HTML/SVG Diagram Generation (full manual control)

This skill produces a **standalone, exportable diagram artifact** via the `generate_diagram` tool. For a normal diagram that should appear inline in your reply, use a fenced ` ```mermaid ` block instead — the frontend renders it inline as a live vector diagram inside the message (no tool call, no artifact). Reach for this path (`generate_diagram` with hand-authored markup) only when Mermaid genuinely can't model the layout, the user wants a downloadable SVG/PNG file, or the diagram needs hand-placed visual structure that an auto-layout can't deliver.

A clean hand-authored SVG reads better than auto-layout output at any complexity level — even a simple flowchart benefits from deliberate spacing, a title that sits outside the flow, and color-coding by meaning. Reach for HTML/CSS boxes (instead of pure SVG) only when a node genuinely needs multi-line text reflow.

## Default: inline diagrams use ```mermaid

Before reading further: if the user just asks "show me a diagram of X", "draw the flow", "what does the architecture look like" — emit a fenced ` ```mermaid ` block in your reply. The frontend renders it inline in the message markdown via the Mermaid integration (`graph TD`/`flowchart LR`, `sequenceDiagram`, `erDiagram`, `gantt`, `mindmap`, `stateDiagram-v2`, `classDiagram`). One diagram per block. The rest of this skill is only for the case where that won't work or the user wants an exportable artifact.

## Output format (for `generate_diagram`)

**Prefer pure inline SVG.** Author the diagram as ONE root `<svg>` element with an explicit `xmlns="http://www.w3.org/2000/svg"`, a `viewBox`, and `width`/`height` — nodes as `<rect rx="10">`, labels as `<text>`, connectors as `<path>`/`<line>` with an arrowhead `<marker>`, and the title as a `<text>` near the top (outside the flow). A pure-SVG diagram is true vector, so the artifact panel exports it crisply to **both SVG and PNG** (the panel extracts the root `<svg>` for the SVG download; if the diagram is HTML/CSS instead, SVG export falls back to wrapping the DOM in a `<foreignObject>`, which is lower fidelity). Only fall back to HTML/CSS boxes (flexbox/grid, positioned divs) when a node genuinely needs multi-line text reflow that hand-placed `<text>` can't handle.

Wrap the single `<svg>` in a minimal complete HTML document and call `generate_diagram(filename, title, html)` with that document in the `html` argument — no external assets (no CDN fonts, no scripts), inline presentation only, system font families. The file is written to the artifacts directory and surfaced in the artifact panel as a diagram. Don't reach for a charting/diagramming JS library; this is hand-authored markup, not a rendered chart. Do not call `emit_artifact` — that tool does not exist; `generate_diagram` is the correct one.

## Structure pattern (matches the reference style)

- **Title** sits above the diagram as a plain heading, outside any box — not inside the flow itself.
- **Nodes** are rounded-rectangle SVG `<rect rx="10">` elements (or rounded `div`s with `border-radius: 8-10px` when you're in the HTML/CSS fallback), each with a **bold `<text>`/label line** and an optional **smaller, dimmer description line** underneath (label = what it is, description = one short clarifying detail — never more than one line each). Prefer SVG primitives; use `div` nodes only when a node needs multi-line text reflow.
- **Color = category, applied consistently.** Pick a small palette (3-5 colors max) and assign each color to a *meaning* (e.g. entry point, processing step, data store, output) — use that mapping consistently across every node in the diagram, not decoratively per-node.
- **Grouping via nested containers**: a lighter/duller-toned outer box can contain a grid of smaller, brighter inner boxes when several items belong to one parent concept (e.g. "6 dimensions captured" as one container holding a 2×3 grid of category boxes). The outer container needs its own label at the top, separate from the inner nodes' labels.
- **Connectors**: simple straight or elbowed lines between node edges (CSS borders positioned absolutely, or SVG `<path>`/`<line>` elements) with a small arrowhead (CSS triangle or SVG `<marker>`). Avoid curved/bezier connectors unless a specific line needs to route around another element (e.g. a dashed feedback line looping back — see below).
- **Feedback/secondary flows** (e.g. a "profile updates" loop back into an earlier stage) get a **dashed line**, visually distinct from the primary solid-line flow, optionally with a small rotated label alongside the line itself.
- **Bottom/exit label**: a plain text line below the last node (not boxed) is fine for "feeds into X" style continuations — don't force every piece of text into a box.

## Color and contrast rules

- The diagram renders inside the artifact panel, which uses a light/white canvas by default and adapts to the app's theme. Don't bake in a hard dark background — let the panel's canvas show through, or pick a background that matches the user's stated context (dark canvas for a "dark mode / presentation" ask, light/white for print or default).
- Text inside colored boxes must stay high-contrast — white or near-white text on saturated fills; never place mid-tone text on a mid-tone background.
- Description sub-lines use a lighter-weight/dimmer variant of the box's own text color (e.g. `opacity: 0.75`), not a completely different color — keeps them visually subordinate without looking disconnected.
- Container/grouping boxes should be a duller, less saturated version of a color, with the nested boxes inside using the fuller-saturation versions — this is what creates the "grouping" read at a glance.

## Sizing and spacing

- Fixed-width canvas appropriate to content (don't let it sprawl edge-to-edge with no margin) — a max-width around 700-900px reads well for most feature/architecture diagrams.
- Consistent gap unit between all elements (16-24px) — don't let spacing vary node to node.
- Grid groupings (like the 2×3 example) use CSS grid with equal gaps, not manually positioned boxes that happen to line up.

## Export affordances (optional, only if the app's artifact panel requests it)

If the artifact panel provides its own copy/export menu chrome, don't duplicate it inside the generated HTML — that's the panel's job, not the diagram's. Only include an in-diagram menu if explicitly asked to replicate that exact UI pattern as part of the diagram's own content (e.g., mocking up a UI, not producing a real diagram to be exported).

## Verify before calling it done

After you call `generate_diagram`, the tool runs a lightweight structural check on your HTML and reports any issues back to you (missing `<html>`/`<body>`, a `<script>` or `<iframe>` tag — both blocked by the sandboxed preview — external resource references that can't load, unbalanced structural tags like `<div>`/`<svg>`, or an empty body). If it reports issues, fix them and regenerate before treating the diagram as done. This static check catches the most common breakage but is not a visual render: also self-review your HTML for text overflowing its box, nodes overlapping, connectors not actually touching the nodes they're meant to connect, inconsistent spacing, and low-contrast text — the same failure modes called out in the docx/pptx skills apply here too.

## What to avoid

- Don't reach for a JS diagramming library (D3, GoJS) inside `generate_diagram`'s `html` argument — that path is for hand-authored markup only. Inline diagrams in the chat reply have a different, Mermaid-rendered path: emit a fenced ` ```mermaid ` block there if a Mermaid lexer fits the structure.
- Don't default to rounded pill shapes for everything — vary shape subtly by role only if it aids clarity (e.g. a data-store node as a slightly different shape), not decoratively.
- Don't add drop shadows, gradients, or glow effects unless the diagram is explicitly meant to match Conduit's own Liquid Glass brand identity — plain flat fills read cleanest for informational diagrams.
