# Research survey: in-app visualization / custom UI in chat hosts

Point-in-time notes (2026-10) behind `docs/architecture/IN_APP_VISUALIZATION.md`.

## ChatGPT Apps SDK (OpenAI)

- Announced Oct 6, 2025 ("Introducing apps in ChatGPT and the new Apps SDK").
- Architecture: developer ships an MCP server; selected tools return
  `structuredContent` (visible to model AND widget) plus
  `_meta.ui.resourceUri` (compat alias `_meta["openai/outputTemplate"]`)
  pointing at a `ui://` resource with mimeType `text/html;profile=mcp-app`.
  The HTML bundle is served as a static asset (CORS) and rendered by ChatGPT
  inside a sandboxed iframe (default origin `web-sandbox.oaiusercontent.com`,
  `_meta.ui.domain` can pin a dedicated one).
- Bridge: JSON-RPC over postMessage ("MCP Apps bridge"). Widget state/context:
  `toolInput`, `toolOutput` (= structuredContent), `toolResponseMetadata`
  (result `_meta`, hidden from the model), `widgetState` +
  `setWidgetState()` (persisted UI snapshot; `widgetSessionId` for
  per-instance state).
- Methods: `callTool(name,args)`, `sendFollowUpMessage({prompt})`,
  `requestDisplayMode({mode})` for `inline|pip|fullscreen`,
  `openExternal({href})`, `requestModal`, `requestClose`,
  `notifyIntrinsicHeight`, `uploadFile/selectFiles/getFileDownloadUrl`.
  Globals: `theme`, `displayMode`, `maxHeight`, `safeArea`, `view`,
  `userAgent`, `locale`.
- Descriptor metadata: `_meta.ui.visibility` (`model`/`app`),
  `availableDisplayModes`, `prefersBorder`, `csp` (connectDomains /
  resourceDomains / frameDomains), `widgetDescription`,
  `openai/toolInvocation/invoking|invoked` strings, annotations
  (`readOnlyHint` required).
- Sources: developers.openai.com (Plugin UI reference.md),
  openai.github.io/apps-sdk-ui, github.com/openai/openai-apps-sdk-examples
  (pizzaz / kitchen-sink / shopping-cart servers).

## MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`)

- First official MCP extension (Jan 26, 2026), built on MCP-UI + the Apps SDK
  experience; spec draft lives at github.com/modelcontextprotocol/ext-apps
  (`specification/draft/apps.mdx`).
- Resource: `ui://` scheme, `text/html;profile=mcp-app`, content inline
  (`text`) or base64 (`blob`). `_meta.ui`: `csp` (connectDomains,
  resourceDomains, frameDomains, baseUriDomains), `permissions` (camera,
  microphone, geolocation, clipboardWrite), `domain`, `prefersBorder`.
- Tool descriptor links a widget via `_meta.ui.resourceUri` +
  `_meta.ui.visibility` (default `["model","app"]`).
- Handshake: View (iframe, acting as MCP client to `window.parent`) sends
  `ui/initialize {appInfo, appCapabilities}` → host responds
  `{protocolVersion, hostInfo, hostCapabilities, hostContext}` → View sends
  `ui/notifications/initialized`. Host MUST NOT message the View before that.
- HostContext: `theme`, `styles.variables` (standardized CSS custom
  properties), `locale`, `timeZone`, `displayMode`, `platform`,
  `userAgent`, `deviceCapabilities {touch,hover}`, `safeAreaInsets`,
  `containerDimensions` (`{width,maxHeight}` flexible or `{width,height}`
  fixed), `toolInfo`. Changes → `ui/notifications/host-context-changed`.
- Requests View→Host: `ui/open-link {url}` (error -32000 when refused),
  `ui/download-file {contents}` (embedded text/blob or resource links),
  `ui/message {role:"user", content}` (host adds to conversation context),
  `ui/update-model-context {content?, structuredContent?}` (overwrites prior;
  host MAY defer to next turn), `ui/request-display-mode {mode}`,
  `tools/call`, `tools/list`, `resources/read`, `sampling/createMessage`,
  `ping`.
- Notifications: View→Host `ui/notifications/size-changed {width,height}`
  (ResizeObserver-debounced; THE auto-height mechanism),
  `ui/notifications/request-teardown {}`. Host→View:
  `ui/notifications/tool-input` (once, before result),
  `tool-input-partial` (streaming), `tool-result` (full CallToolResult),
  `tool-cancelled {reason}`, `ui/resource-teardown {reason}` (host SHOULD
  await the View's response before removing the iframe).
- Sandboxing: web hosts wrap the View in a Sandbox proxy on a different
  origin (`allow-scripts allow-same-origin` on the proxy); direct hosts use
  an opaque origin. Default CSP when none declared:
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; media-src 'self' data:;
  object-src 'none'; connect-src 'none'`.
- Capability negotiation: host advertises
  `capabilities.extensions["io.modelcontextprotocol/ui"] {mimeTypes}`.

## T3 Code (pingdotgg/t3code, MIT, ~27k stars)

Two layers, same protocol:

1. **`html_render` tool + bootstrap injection** (`packages/shared/src/htmlRender.ts`):
   the agent authors a full HTML page; the server stores it as a thread
   attachment and injects into `<head>` (position-sensitive, comments/raw-text
   blanked so offsets stay aligned): a `<style id="t3-theme">` default
   (dark + `prefers-color-scheme: light` fallback), and a bootstrap script
   that (a) applies theme from the `#t3-theme=` URL fragment before first
   paint (then strips the fragment), (b) re-applies theme on
   `ui/notifications/host-context-changed`, (c) intercepts trusted link clicks
   → `ui/open-link` request (top-level pages open new windows instead),
   (d) reports `ui/notifications/size-changed` via ResizeObserver.
   Theme contract: ~30 CSS variables (`--background`, `--foreground`,
   `--card`, `--accent`, `--chart-1..6`, `--radius`, `--font-sans/mono`, …)
   documented in `HTML_RENDER_THEME_GUIDE`; layout guide teaches fluid width,
   transparent page background, fixed chart heights, no viewport units.
   Server pre-measures page heights at 9 widths with headless Chrome so the
   client can reserve the right box before paint.
2. **`McpAppFrame`** (`apps/web/src/components/chat/McpAppFrame.tsx`) + host
   runtime (`packages/client-runtime/src/mcpApps/host.ts`): full MCP Apps
   host. Notable engineering details:
   - iframe `sandbox="allow-scripts allow-forms"`, NEVER `allow-same-origin`
     (opaque origin; `postMessage` target `'*'` is then the only option and
     scoping is by `event.source === frame.contentWindow`).
   - Host callbacks + approvals: non-read-only `tools/call`, `ui/message`,
     and `ui/download-file` all require a confirm dialog; fullscreen steps
     aside (returns inline) before dialogs/approvals render.
   - Fullscreen via the Popover API (`popover="manual"` + `showPopover()`):
     the SAME iframe node stays mounted — no reload, app state preserved.
     Escape / outside focus exits; the row keeps its inline height so the
     timeline doesn't jump.
   - Navigation-away detection: a second `load` event on the frame disposes
     the host and shows "app left its page and was stopped".
   - Sizing: `MCP_APP_DEFAULT_HEIGHT`/`clampMcpAppHeight`; inline
     `containerDimensions` carries `{width, maxHeight}`.
   - Protocol hardening: 256 KB max message, 16 max in-flight app requests,
     2 s teardown timeout, `_meta: null` normalization (providers sending
     null break the SDK).
   - `ui/update-model-context` flows server-side into the conversation
     thread's next turn (`conversationThreadId`).

Their `visualize` variant is a Codex skill that writes an HTML file and emits
a `<visualize>{"path":…,"mode":"wide"}</visualize>` marker in the reply;
issue #7191 (open) shows the marker rendering raw when the desktop parser
misses it — the cautionary tale for marker-based transport.

## Relay's prior art

- `generate_diagram` → `<!-- relay:diagram -->` marker → `kind:"diagram"` →
  `InlineDiagram` live path (allow-scripts sandbox, token-verified
  postMessage height, clamp 120–520).
- `ArtifactPreviewPane` live HTML preview; DOMPurify static path.
- `app_ui.rs` injected bridge (Relay self-control) — the no-eval bridge
  discipline.
- Theme: `data-theme` on `documentElement` + inline custom-property
  overrides (custom themes) — `useTheme.ts`, `KNOWN_THEME_TOKENS`.

## Decision

Build the widget surface on Relay's own artifact pipeline (file + marker +
kind routing), shape the bridge to the MCP Apps protocol (so phase-2 MCP
server apps can reuse it verbatim), and adopt T3's field-proven UX details:
theme-before-first-paint bootstrap, link interception, clamped auto-height,
state-preserving fullscreen, teardown flow, and the model-facing
theme/layout guide in the tool description.
