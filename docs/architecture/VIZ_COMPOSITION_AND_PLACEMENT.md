# Visualization: composition and placement

Companion to `IN_APP_VISUALIZATION.md` (which specifies the two existing
layers). This doc specifies the two changes that make the structured-renderer
layer (`visualize`) able to render the UI patterns the reference
implementations render, and to render them when the reference implementations
render them:

1. **Composition** — one card may contain other cards plus prose, so the
   "specialized patterns" (comparison, itinerary, research report, dashboard)
   become expressible instead of needing seven flat cards or an HTML escape
   hatch.
2. **Placement** — a card emitted mid-turn renders **in place**, between the
   tool calls around it, instead of always hoisting to the answer area.

Neither change alters the layer's core contract: the model proposes typed
data, Relay validates it, Relay renders it. No model-authored code enters
this layer.

## The gap, precisely

The reference catalog ("Intelligent UI"-style visuals) reads as one list but
is three different products, and Relay already owns two of the three:

| Reference material | Correct surface in Relay | Today |
| --- | --- | --- |
| Input/control elements, layout containers, specialized patterns (sections 2, 3, 5) | `render_widget` + `WidgetFrame` (model-authored HTML, MCP Apps bridge) | covered — a slider, a form, a carousel, a grid are expressible there today |
| Rich content: headings, code blocks with highlighting, math, citations, badges | the chat's markdown pipeline (`<Markdown>`, `ActivitySteps.tsx:1777`: gfm + breaks + katex + syntax highlighting, `[1]` citation chips, no raw-HTML plugin) | covered — **in prose only** |
| Data visualization (section 1) | the typed registry (`VizCard.tsx:23`) | bar, line, table, pie/donut, kanban, event rail, KPI row; **no scatter, map, image/carousel, video** |

Two conclusions follow, and they drive everything below.

**Most of the catalog is not registry work.** Adding sliders, checkboxes,
date pickers, grids and carousels as typed `visualize` kinds would replace a
capability Relay already has (arbitrary HTML) with a weaker one (a fixed
component), while doubling the validation surface — Rust validator plus a TS
mirror per kind. That mirror is the thing that has already drifted twice
(marker/tool disagreement on stringified payloads; the gate rejecting the
normalizer's own `align: "left"` and `""` outputs).

**The real gap is composition.** Every reference pattern is a *combination*:
a chart next to a table, prose with citations under a KPI row, headings
around a comparison grid, math beside a slider. `vizRenderers` is flat — one
kind, one data shape, one card — so no combination is expressible. This is
the structural gap, and it is worth more than any individual renderer.

## Part 1 — composition

### Decision: a container kind, not fixed-slot patterns

Three designs were considered.

*Rejected: fixed-slot pattern kinds* (`dashboard {chart, table, stats}`,
`comparison {columns[], rows[]}`, `itinerary {stops[]}`, …). Each pattern is a
new kind in both validators plus a new renderer, the model must learn each
one's slots, and every future pattern repeats the work. It optimizes for the
reference list instead of for the space of things a model will actually ask
for.

*Rejected: keep it flat and route patterns to `render_widget`.* Loses type
checking, Relay-native theming, and the renderer registry's whole reason for
existing. It is the correct answer for genuinely interactive patterns (see
below) and the wrong one for "show me this data well".

*Chosen: a container kind whose children are `(viz, payload)` pairs.* A child
is literally the same shape as a top-level call, so recursion is free: a child
is validated by the same per-kind builder and rendered by the same registry
entry.

### Payload shape

```json
{
  "viz": "stack",
  "title": "Deploy health — sprint 42",
  "payload": {
    "sections": [
      { "viz": "stat",     "payload": { "stats": [ … ] } },
      { "viz": "chart",    "payload": { "unit": "deploys", "bars": [ … ] } },
      { "viz": "prose",    "payload": { "markdown": "The W3 spike is the **release train** … [1]" } },
      { "viz": "table",    "payload": { "columns": [ … ], "rows": [ … ] } },
      { "viz": "divider",  "payload": {} },
      { "viz": "stack",    "payload": { "sections": [ … ] } }
    ]
  }
}
```

`viz: "stack"` on the marker; the transport is unchanged (`kind: "viz-data"`,
`viz`, `payload` riding inside the `<tool>` marker, sanitized, stripped from
re-sent history).

### Two new leaf kinds

**`prose`** — `{ markdown }`, rendered with the chat's own `<Markdown>`. This
is what opens reference section 4 inside a card: headings, code blocks with
syntax highlighting, KaTeX math, mermaid, GFM tables, and interactive
`[1]`-style citation chips. It costs one renderer that delegates to a
component that already exists.

**`divider`** — `{}`, a hairline plus spacing between sections. Ten lines,
and it is what makes multi-section cards readable.

Deliberately *not* added: `scatter`, `map`, `image`, `video`, `grid`
(`grid` is the same machinery as `stack` plus a CSS grid wrapper; it is the
first thing to add if two-column composition is wanted). Scatter is the one
genuine data-viz gap worth a kind; map/image/video need external assets or a
renderer Relay does not have and belong to `render_widget` until they don't.

### Validation contract

`build_stack` (Rust) recurses into the existing `build_chart` / `build_table` /
… functions — it does not reimplement any child's checks. The TS mirror
recurses into the same per-kind parsers (`src/lib/viz.ts`). A child is either
wholly valid or the whole card is refused, with the precise child error
(`sections[2].payload: rows[0]: has 1 cells, expected 2`).

Composition must not become a way around per-card bounds, so the budget is
**aggregate**, computed over the whole tree:

- ≤8 sections per stack; ≤2 levels of nesting (depth 3 counting the root);
  ≤12 leaf renderers across the entire stack.
- Aggregate data budgets across the whole stack: ≤500 table rows, ≤100 tasks,
  ≤100 events, ≤200 bars/line points — the same per-kind limits, summed, so
  `stack` cannot smuggle eight 200-bar charts into one card.
- `VIZ_MAX_PAYLOAD_CHARS` (32 KB) continues to apply to the whole normalized
  stack; prose is the new way to approach it, so prose gets its own cap
  (4 KB) with the same precise error.

**Style inheritance runs through the CSS cascade, but only if every renderer
resolves colors through it.** `styleVars` (`VizCard.tsx:36`) sets
`--viz-accent`, `--viz-c1..c8`, tone (`--viz-bg/fg/dim/border`) and
`--viz-radius` on a card root, and custom properties cascade to descendants.
The two renderers that resolve categorical colors in JavaScript disagree
about that today:

- donut (`VizCard.tsx:264-265`) falls back correctly —
  `palette?.[i] ?? var(--viz-c${i+1}, var(--accent))`;
- chart (`VizCard.tsx:77-80`, `barColor`) stops at the JS value —
  `palette?.[i] ?? accent ?? "var(--accent)"`, so it never reads the cascade.

So composition ships with the one-line `barColor` fix to match `segColor`.
Consequences, which are the point of doing it this way:

- a container's palette and accent reach every child that does not set its
  own, with **no inheritance logic in either validator** — the frontend stays
  a per-kind parser and the two mirrors keep agreeing;
- each child is rendered through the registry inside a section wrapper that
  gets its own `styleVars`, so a child's own style overrides locally while
  inheriting the rest;
- the aggregate-budget math below is the only thing the two validators share,
  and it is pure numeric counting.

### What it unlocks

| Reference pattern | Composition |
| --- | --- |
| Product comparison | `stack` → `prose` (heading) → `table` (features) |
| Research report | `stack` → `prose` (sections + `[1]` citations) → `chart` → `prose` |
| Dashboard | `stack` → `stat` → `chart` → `table` |
| Travel itinerary | `timeline` (+ `stack` when a map is wanted → `render_widget`) |
| Interactive calculator / questionnaire | **`render_widget`** — interactive by definition |
| File browser / agent workflow | `task-board` / `timeline` + `prose` narration |

The last two rows are the point of the split: patterns that are *data plus
prose* join the registry; patterns that are *stateful* stay in the escape
hatch.

## Part 2 — placement

### Today

`MessageBubble.tsx:458-469` computes the last process block, filters every
`viz` block out of the region, and prepends them to the outside content — the
comment at `:450-457` states the rule: a completed visualization is the turn's
result and renders in the answer area **always**, even when the model emitted
it before later tool calls. That hoisting was itself a fix: cards used to be
swallowed by the collapsed "Worked for Xs" region.

`groupSegments` (`ActivitySteps.tsx:2099-2104`) only turns a marker whose
close tag has arrived into a `viz` block, so while a call is still streaming
the card is a live "Visualizing" step row. That part is correct and unchanged.

### The rule change

Split on whether process activity follows the card:

```
viz block with a later tool call  → render IN PLACE, inside the process
                                    region, in source position
viz block with nothing after it   → hoist to the answer area (unchanged)
```

Implementation is one predicate over `blocks` (`hasFollowingProcess`); the
existing `renderProcessBlock` `case "viz"` (`ActivitySteps.tsx:1214-1219`)
already renders a card inside a region, so the mid-turn path is a routing
change, not new rendering code.

During a live turn this is what the user already sees, because
`ProcessSummary` takes `live` and stays expanded — so an in-place card is
visible the moment its marker completes, between the tool rows around it.
Cards now also survive the collapse at turn end.

### The cost of putting cards back in the region

The original bug returns unless the collapsed region is honest about what it
holds. Two mitigations, both cheap:

1. The collapsed summary names the cards, not just the count —
   "Worked for 2m 5s · Deploy health · Sprint 42" (titles are already in the
   marker's `detail`).
2. An in-place card keeps its own header row inside the region, so it is never
   an unlabeled block.

The contract therefore changes from "cards never live in the process region"
to "cards in the region are named in the collapsed summary and one click from
visible" — the same disclosure contract every tool row already has.

*Rejected: re-hoist in-place cards when the turn settles.* It keeps the card
out of the region entirely, but the card visibly teleports when the turn ends,
while the user may be reading it. A moving card is worse than a disclosed one.

### Tool policy

`VISUALIZE_DESC` (`src-tauri/src/chat/tools/mod.rs:884-906`) currently
instructs: *"Use AFTER data-gathering tools finish, ONCE per result"*. That
instruction is the reason cards can only ever arrive at the end — it forbids
the mid-turn case by policy. Replace that paragraph with:

- several cards per turn are fine, and a card may follow any data step;
- group related results into one card with `stack` rather than emitting
  several flat ones;
- keep the existing guard — one card per data result, never per tool
  response, and only when a visual genuinely helps.

## Drift: the thing to fix structurally

Both bugs found while debugging real turns were the same bug: the Rust
validator and the TS mirror disagreed, so a card the backend accepted
rendered "Visualization unavailable" (and vice versa). Two more kinds plus
recursion doubles that surface. So this change ships with:

- a **shared corpus** — one JSON file of markers that must be accepted by
  both `build_viz_payload` and `parseVizPayload`, and one of markers both must
  reject, asserted from both languages. New kinds add to the corpus, not to a
  second hand-written test.
- the corpus includes the seven markers of the live turn that exposed the
  bug, so the regression is pinned end-to-end.

## Open questions

Numbers that need a decision before implementation (recommendations above):

- the aggregate budgets (8 sections / depth 3 / 12 leaves / 4 KB prose);
- whether `grid` ships with `stack` or follows it;
- whether an in-place card that stays in a collapsed region is enough, or a
  region containing a card should refuse to collapse on turn end.

## Tests

- **Rust** (`tools/viz.rs`): `build_stack` recursion (each child kind, nesting
  to the depth limit, one past it), aggregate budget enforcement, precise
  child errors, prose cap, `stack` marker round-trip through `tool_block`.
- **Vitest** (`vizRenderers.test.tsx`): corpus acceptance in both languages,
  every reference pattern composed and rendered, prose delegating to
  `<Markdown>` (math + citation chip + code highlighting), in-place vs
  hoisted placement for all four orderings (card alone / card last / card
  mid-run / two cards), and the collapsed summary naming cards.
- **Shared corpus** (`src/test/viz-corpus.json`, asserted by both
  `tools/viz.rs` and `vizRenderers.test.tsx`): accept + reject sets, with the
  seven live markers pinned. New kinds add rows; neither side writes a
  hand-rolled second opinion.

## Files

| File | Change |
| --- | --- |
| `src-tauri/src/chat/tools/viz.rs` | `build_stack`, `build_prose`, `build_divider`, aggregate budgets |
| `src/lib/viz.ts` | `VizStack`/`VizProse`/`VizDivider` types, recursive `parseVizPayload` |
| `src/test/viz-corpus.json` | shared accept/reject marker corpus |
| `src/components/chat/viz/VizCard.tsx` | `stack` + `prose` + `divider` renderers; `sources`/`onPreviewArtifact`/`chatSessionId` threaded in for prose; `barColor` reads the `--viz-c*` cascade |
| `src/components/chat/MessageBubble.tsx` | `hasFollowingProcess` split; pass markdown props to `VizCard` |
| `src/components/chat/ActivitySteps.tsx` | collapsed `ProcessSummary` names card titles |
| `src-tauri/src/chat/tools/mod.rs` | `VISUALIZE_DESC` policy paragraph |
| `src-tauri/src/chat/proto.rs`, `agent_sessions/tracker.rs` | marker emitters — unchanged shape, covered by corpus |
| `docs/architecture/IN_APP_VISUALIZATION.md` | link this doc |
