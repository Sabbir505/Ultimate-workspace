# In-App Visualization — two layers

Design doc for Relay's in-app visualization: tool results that render as
visual cards inside the chat. There are TWO deliberate layers, mirroring the
two mechanisms ChatGPT ships ("Intelligent UI" for common cases, Apps SDK for
developer widgets):

1. **Structured renderers (`visualize` tool)** — the model returns a typed
   presentation request (chart / table / task-board / timeline) with a data
   payload; Relay validates it and renders it with its OWN components. The
   model never authors UI.
2. **Model-authored widgets (`render_widget` tool)** — the model writes a
   self-contained HTML mini-app; Relay renders it as a themed, sandboxed
   iframe speaking the MCP Apps bridge. The escape hatch for bespoke visuals
   no fixed renderer anticipates.

Companion research notes: `docs/research/in-app-visualization-survey.md`.

Companion design doc: `VIZ_COMPOSITION_AND_PLACEMENT.md` — composable cards
(`stack`, `prose`, `divider`) and mid-turn in-place placement.

## What we researched

Three production systems implement "the model produces visual output that the
host renders as an interactive widget inside the chat thread":

1. **ChatGPT Apps SDK** (OpenAI, Oct 2025). An MCP tool returns
   `structuredContent` (data for model + UI) plus `_meta.ui.resourceUri`
   (`ui://widget/...`, mimeType `text/html;profile=mcp-app`). ChatGPT renders
   the HTML in a sandboxed iframe on `web-sandbox.oaiusercontent.com` and
   bridges it over JSON-RPC postMessage. Widget APIs: `callTool`,
   `sendFollowUpMessage`, `requestDisplayMode`, `openExternal`,
   `setWidgetState`; context globals `theme`, `displayMode`, `maxHeight`,
   `safeArea`. Display modes `inline | pip | fullscreen`.
2. **MCP Apps** (SEP-1865, `io.modelcontextprotocol/ui`, the open
   standardization of the above — first official MCP extension, Jan 2026).
   Same shape, standardized: `ui://` resources, `ui/initialize` handshake →
   `hostContext` (theme, styles.variables, displayMode, containerDimensions,
   platform, locale, safeAreaInsets) → `ui/notifications/initialized`;
   app→host requests `ui/open-link`, `ui/message`, `ui/update-model-context`,
   `ui/request-display-mode`, `ui/download-file`, `tools/call`,
   `resources/read`; host→app notifications `ui/notifications/tool-input`,
   `tool-result`, `host-context-changed`; app→host `ui/notifications/size-changed`
   (ResizeObserver-driven auto-height), `request-teardown`; host→app
   `ui/resource-teardown`. Restrictive default CSP; iframe sandbox
   `allow-scripts` (+`allow-same-origin` only via a sandbox proxy origin).
3. **T3 Code** (pingdotgg/t3code, MIT): `html_render` MCP tool — the agent
   authors a self-contained HTML page; the server stores it as a thread
   attachment and injects a **bootstrap** into its head (theme as CSS custom
   properties applied before first paint, base CSS, link interception →
   `ui/open-link`, ResizeObserver → `ui/notifications/size-changed`). The web
   app hosts it in an opaque-origin sandboxed iframe (`McpAppFrame`) speaking
   the MCP Apps bridge, with fullscreen via the Popover API (same frame, no
   reload), approval dialogs for non-read-only tool calls / messages /
   downloads, navigation-away detection, and teardown on unmount. Their
   `visualize` variant (a Codex skill emitting a
   `<visualize>{"path":…,"mode":"wide"}</visualize>` marker) renders the same
   pages from a path reference — and T3's own bug tracker shows the failure
   mode when the marker parser and the renderer drift apart.

Relay already had the primitive: `generate_diagram` writes a marked HTML file →
`chat:artifact` → `InlineDiagram` renders interactive HTML live in an
allow-scripts sandboxed iframe with a postMessage height handshake. What was
missing is everything that makes it a *widget platform*: theming injected
before first paint, a real bidirectional bridge, display modes, and a
model-facing tool contract that teaches the model how to author for the frame.

## Design

### Tool: `render_widget` (Rust)

`render_widget { title, html }` — the model authors a complete self-contained
HTML document (scripts allowed and expected: dashboards, data explorers,
calculators, playable demos — the interactive counterpart of the static
`generate_diagram`). The backend:

1. Prepends the sentinel `<!-- relay:widget -->` (same pattern as
   `DIAGRAM_MARKER`), writes it via `artifacts::generate` into the artifacts
   dir, and returns `ToolOutcome { text: guide + confirmation,
   artifact: Some(ArtifactRef) }`.
2. The artifact flows through the existing `chat:artifact` event →
   `artifactsByMessage` → `MessageArtifacts` pipeline. No new transport.
3. `read_artifact_preview` classifies files starting with the widget marker as
   `kind: "widget"` (like `"diagram"`), so the frontend can route.
4. `tool_block` narration: `kind: "viz"`, "Building interactive widget …",
   with the HTML in the expandable code view (matches generate_diagram's step).

The tool description (fed to the model) carries the **theme + layout guide**
(T3's insight: teach the author the frame contract):
Relay injects `--background/--foreground/--card/--muted/--border/--accent/
--chart-1..6/--radius/--font-sans/--font-mono` etc. as CSS custom properties;
the page should sit transparent on the thread background, size fluidly, give
charts fixed pixel heights, avoid viewport units, and never set its own page
background.

### Renderer: `WidgetFrame` (React)

Routed from `InlineDiagram` when `preview.kind === "widget"` (lazy chunk).
The iframe is `sandbox="allow-scripts allow-forms allow-modals allow-popups"`
with `srcDoc` — opaque origin, no Tauri access, same posture as every other
live-visual frame in the app.

Before the page's own markup, the frame document gets an injected
**bootstrap**:

- **Theme before first paint**: a `:root` rule with the mapped Relay theme
  variables (resolved from `getComputedStyle` on `documentElement` — custom
  themes included), `color-scheme`, and the base stylesheet (margin 0, hidden
  scrollbar, in-set focus outlines). Because it is inline in `<head>` before
  the page's styles, the first paint is already on-theme and the page's own
  `:root` rules still win.
- **App-side MCP Apps shim**: speaks JSON-RPC 2.0 over `postMessage` to the
  parent — sends `ui/initialize` (with `appCapabilities.availableDisplayModes`),
  then `ui/notifications/initialized`; re-applies theme on
  `ui/notifications/host-context-changed`; reports content height via
  `ui/notifications/size-changed` (ResizeObserver, dedup); intercepts trusted
  `<a>` clicks and asks the host with `ui/open-link`; answers
  `ui/resource-teardown`. Exposes `window.relayWidget` for opt-in pages:
  `openLink(url)`, `sendMessage(text)`, `requestDisplayMode(mode)`,
  `downloadFile(contents)`, `onTheme(cb)`.

The **host side** lives in `src/lib/mcpApps.ts` (framework-free, unit-tested):

- Message scoping: only `event.source === frame.contentWindow` is accepted;
  replies target that window. Message size capped (256 KB) and concurrent
  app requests capped (16), mirroring T3's hardening.
- `ui/initialize` → responds `protocolVersion`, `hostInfo {name:"relay"}`,
  `hostCapabilities` (openLinks, message, updateModelContext, downloadFile,
  sandbox), and the full `hostContext`: theme + `styles.variables`,
  `displayMode`, `availableDisplayModes: ["inline","fullscreen"]`,
  `containerDimensions {width, maxHeight}`, `platform: "desktop"`, locale,
  timeZone, userAgent, deviceCapabilities, safeAreaInsets.
- `ui/open-link` → http(s) only → `openInBrowserPane(url)` (Relay's own
  browser pane, consistent with chat markdown links).
- `ui/message` → draft into the composer (`setComposerDraft` for the active
  session) + toast. Draft, not auto-send: the user reviews and presses send,
  which is safer than ChatGPT's auto-send and needs no confirmation-dialog
  plumbing. Ack `{}`.
- `ui/update-model-context` → accepted and acked; the payload is stored on
  the host instance and surfaced to the model in a later phase (documented
  below).
- `ui/request-display-mode` → `fullscreen` (or back to `inline`), echoed.
- `ui/download-file` → embedded contents saved through a Blob anchor
  download (25 MB cap); linked URIs are refused in v1.
- `tools/call`, `resources/read` → refused (`-32001`) in v1: built-in widgets
  have no server to call back into. The refusal is a clear error the widget
  can show, not silent breakage.
- `ui/notifications/size-changed` → clamped auto-height (120–640 px inline;
  no clamp in fullscreen), same clamp discipline as the diagram frames.
- `ui/notifications/request-teardown` → the card collapses to
  "Widget closed · Show" (T3's pattern: keep the box height, offer reopen).

**Fullscreen**: a CSS-class toggle on the block container
(`position: fixed; inset: 0; z-index`) — the iframe DOM node is never
reparented, so the widget keeps its state (T3's key insight; the Popover API
is just their mechanism for the same). A slim header shows the title with an
exit button; Escape and outside focus exit; body scroll locks while open.

**Theme changes**: a `MutationObserver` on `documentElement` (`data-theme` +
inline custom-property overrides, mirroring `useSyntaxTheme`) recomputes the
variable map and pushes `ui/notifications/host-context-changed`.

### Persistence & history

The widget HTML lives on disk in the artifacts dir (30-day sweep, same as all
artifacts); the message stores only the `<tool>` narration marker and the
artifact path association — no HTML in the DB, no history bloat, nothing new
to strip from re-sent context. After a reload the card re-renders by reading
the file, exactly like diagrams.

### Security posture

- Opaque-origin sandbox (`allow-scripts`, **no** `allow-same-origin`) — the
  frame cannot touch Tauri IPC, cookies, or the parent DOM.
- No sanitization of widget HTML: it is model-authored code the user asked
  for, sandboxed the same way every interactive preview already is
  (`InlineDiagram` live path, `ArtifactPreviewPane` live path).
- Bridge allowlists: open-link is scheme-checked http(s) and lands in the
  in-app browser pane (never `file:`, never OS shell); download-file is
  embedded-bytes-only with a size cap; tool calls are refused outright.
- Parent verifies `event.source` per instance; widgets cannot resize or
  message each other's hosts.

### Deliberately out of scope (phase 2+)

- **MCP server apps** (third-party MCP tools with `ui://` widget resources):
  the bridge is spec-shaped so a later change can map MCP tool results with
  `_meta.ui.resourceUri` onto `WidgetFrame` (the hook site is the MCP result
  fan-out in `dispatch.rs`), plus a `resources/read` implementation.
- **`ui/update-model-context` injection**: accepted today; wiring the stored
  payload into the next turn's context needs a dispatch-layer hook.
- **Widget→tool calls with approval** (T3 allows read-only calls to the
  owning MCP server): becomes meaningful with MCP apps.
- **PiP mode**: fullscreen covers the use case on desktop.

## Layer 2: structured renderers (`visualize`)

The renderer-registry layer, per the renderer-vs-authoring distinction: the
model proposes data + a presentation type; Relay decides what renders.

**Tool contract.** `visualize { viz, title?, payload }` — `viz` ∈ `chart |
table | task-board | timeline | line | donut | stat` (seven kinds: bar chart,
grid, kanban, event rail, trend line, parts-of-a-whole donut, KPI row).
Every payload may carry an **agent-chosen `style`**: `{ accent, palette
(≤8 colors), tone ("app"|"light"|"dark"), radius ("soft"|"sharp"|"pill") }` —
the model art-directs the card when the data deserves it, and the renderer
applies it as scoped CSS custom properties layered over the theme. Colors are
validated to plain hex/rgb()/hsl() (CSS injection rejected), style is
accepted at payload OR top level (models flatten), and unset fields fall
back to the app theme. `build_viz_payload`
(`src-tauri/src/chat/tools/viz.rs`) is the single validator/normalizer:
per-type structural checks with hard bounds (chart ≤200 bars, table ≤12
columns × ≤500 rows with width-matched cells, board ≤8 columns × ≤100 tasks,
timeline ≤100 events), length caps on every string, and a 32 KB normalized
payload cap. Invalid payloads NEVER reach the screen: `execute_tool` returns
a precise, retryable error to the model ("rows[3]: has 1 cells, expected 2"),
and the marker emitter falls back to a plain step row.

**Transport.** The normalized payload rides INSIDE the `<tool>` marker
(`kind: "viz-data"`, `viz`, `payload`), with every string recursively
sanitized against the marker-structural tags (`sanitize_marker_value` in
`proto.rs`). Markers are display-only and stripped from re-sent history, so
nothing bloats model context; persistence is free (the marker lives in the
message content and re-renders on reload).

**Rendering.** `groupSegments` turns a completed viz-data marker into its own
`viz` block; `MessageBubble` EXCLUDES that kind from the process region, so
the card renders in the answer area, in source order alongside the trailing
prose (a viz is the turn's result, like an inline artifact — it must not hide
inside the collapsed "Worked for Xs" region). A viz emitted before a later
tool call still renders inside an expanded region via the defensive
`renderProcessBlock` case. `VizCard` (`src/components/chat/viz/VizCard.tsx`)
routes through the registry (`chart → ChartRenderer`, …) of pure Relay
components styled from the app tokens — no sandbox, no theme bootstrap, no
model code. Unknown kinds and malformed payloads render an explicit
"Visualization unavailable" fallback (`parseVizPayload` in `src/lib/viz.ts`
mirrors the backend validation as the rendering gate, since markers stream
before execution finishes).

**Policy.** The tool description carries the data-gathering-before-rendering
rule: run data tools first, call `visualize` once per result, only when a
visual genuinely helps — never per tool response.

**State ownership** (three boundaries, per the ChatGPT/T3 Code research):
authoritative state stays in Relay's backend/DB (the viz payload in the
message is display data, not truth); presentation state lives in the
renderer components; model-visible context is what `execute_tool` feeds back
(the confirmation line telling the model the card is visible and its contents
should not be restated).

### Tests

- Rust: `tools/viz.rs` (per-type builds, precise errors, bounds + size cap,
  `visualize()` result text), `tools/mod.rs` (spec listed in both wire
  formats with the payload-shape contract, marker sanitization + fallback
  narration), bridge registry test.
- Vitest: `src/test/vizRenderers.test.tsx` — `parseVizPayload` gate (all
  rejection shapes), registry rendering per kind with data-driven assertions
  (bar counts, alignment, column counts, event rows), explicit fallbacks,
  and `groupSegments` placement (completed → `viz` block; streaming → live
  step; viz never folds into an activity run).

## Files

| File | Role |
|---|---|
| `src-tauri/src/chat/tools/generate.rs` | `render_widget` + `WIDGET_MARKER` + unit tests |
| `src-tauri/src/chat/tools/viz.rs` | `visualize` validator/normalizer + unit tests |
| `src-tauri/src/chat/tools/mod.rs` | tool name consts, descriptions, dispatcher arms, tests |
| `src-tauri/src/chat/tools/specs.rs` | OpenAI + Anthropic schemas with the authoring guides |
| `src-tauri/src/chat/proto.rs` | `tool_block` narration (kinds `viz` / `viz-data`) + marker sanitization |
| `src-tauri/src/chat/commands/preview.rs` | classify widget marker → `kind: "widget"` |
| `src/lib/mcpApps.ts` | MCP Apps JSON-RPC host bridge (pure, tested) |
| `src/lib/widgetTheme.ts` | Relay theme → widget CSS variable map + observer |
| `src/components/chat/WidgetFrame.tsx` | the model-authored widget card |
| `src/lib/viz.ts` | viz payload types + frontend validation gate |
| `src/components/chat/viz/VizCard.tsx` | renderer registry + the four native renderers |
| `src/components/chat/ActivitySteps.tsx` | `viz` block kind + grouping + icon |
| `src/components/chat/MessageBubble.tsx` | answer-area placement for viz blocks |
| `src/lib/ipc/artifacts.ts` | `ArtifactPreview.kind` gains `"widget"` |
| `src/test/widgetFrame.test.tsx` | widget card + bridge behavior |
| `src/test/vizRenderers.test.tsx` | viz validation gate + renderers + placement |
