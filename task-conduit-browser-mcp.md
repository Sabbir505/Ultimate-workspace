# Task: `conduit-browser-mcp` — Agent-Driven Control of the Dev Tab Browser Pane

## Context

Dev tab agent panes (Claude Code / Kimi Code sessions) currently have no way to drive the built-in browser pane — Playwright MCP, the standard approach, would spawn its own separate Chromium instance rather than controlling the visible in-app pane, which defeats the goal of watching the agent test its own work live. This task builds a thin custom MCP server that exposes the standard browser-tool shape over MCP, but internally forwards every call into the already-running Conduit app, executing against the real visible pane via the JS-injection bridge already being built for Chat tab research (`task-browser-extraction-quality.md`). The harness (Claude Code/Kimi Code) sees a normal MCP browser server; what's actually happening is it's driving the exact pane on screen.

This task depends on the DOM-injection bridge existing (from the companion Chat-tab task) — if that hasn't landed yet, build/reuse its core JS-eval mechanism here first, since both features need the same underlying capability.

## What to build

### 1. MCP server process (`conduit-browser-mcp`, new small binary/service — Node or Rust, match whatever's lighter to maintain alongside the existing Rust backend)

Exposes standard MCP tools:
```
navigate(url: string, pane_id?: string)
click(selector_or_role_description: string, pane_id?: string)
type(selector_or_role_description: string, text: string, pane_id?: string)
read_page(mode: "interactive" | "content", pane_id?: string) -> PageState
scroll(direction: "up"|"down", pane_id?: string)
wait_for(condition: "navigation" | "selector" | "network_idle", target?: string, pane_id?: string)
```
- `pane_id` targets a specific Dev-tab browser pane by ID (a project may have more than one open — see §3). If omitted, target the currently-focused/most-recently-used browser pane for that session's project.
- Register this server in each Dev-tab session's harness config the same way any other MCP server is registered (`.mcp.json` for Claude Code, Kimi Code's equivalent) — scoped per-project, not global, so it only activates where a browser pane is relevant.

### 2. IPC bridge from the MCP server into the running Conduit app

- The MCP server is a separate process from the main Tauri app; it needs a local IPC channel to the app (a local Unix socket / named pipe, or a loopback WebSocket on a fixed local port — pick whichever pattern is already used elsewhere in this codebase for inter-process comms, don't introduce a third IPC mechanism if one's already established).
- Each MCP tool call is forwarded over this channel to the Rust backend, which executes it against the target pane's webview via the same `eval()`-based JS bridge as the Chat tab browser tools — reuse that bridge's core execution path, don't fork a second implementation.
- Tool results (page state, errors) flow back over the same channel to the MCP server, which returns them to the harness in standard MCP tool-result format.

### 3. Pane targeting and lifecycle

- If the target project has no browser pane open when a tool call arrives, auto-open one (per PRD §4.6/§7 existing browser pane behavior) rather than erroring.
- If multiple browser panes are open for the project, default to whichever was interacted with most recently by the user or the agent (track a simple "last active" pointer), with `pane_id` available for the harness to be explicit when needed.
- Read mode for this use case should default to `interactive` (full accessibility tree — element roles, form field states, button labels) rather than the Chat tab's readability-stripped content mode — this is testing/interaction, not research reading. Keep these as two distinct read modes on the same underlying bridge (per the earlier design note), not a single mode trying to serve both purposes.

### 4. Error/edge-case handling

- Navigation failures, elements not found, and timeouts should return structured, informative errors to the harness (not raw exceptions) so the agent can adapt (e.g. "element not found, try re-reading the page" rather than a bare stack trace).
- If the target pane's webview isn't in a state to accept commands (e.g. mid-navigation), queue or retry briefly rather than failing the call outright.

## Acceptance criteria

- [ ] `conduit-browser-mcp` registers successfully as an MCP server for both Claude Code and Kimi Code sessions in a Dev-tab project.
- [ ] Calling `navigate`/`click`/`type`/`read_page` from an agent session visibly affects the actual Dev-tab browser pane on screen — verified by watching it happen, not just checking a tool-result payload.
- [ ] Auto-opens a browser pane if none exists for the target project.
- [ ] Correctly targets a specific pane via `pane_id` when multiple browser panes are open for the same project.
- [ ] `read_page(mode: "interactive")` returns a usable accessibility-tree-style structure (roles, labels, form state) sufficient for an agent to locate and interact with elements without pixel coordinates.
- [ ] Structured error responses for not-found elements and navigation failures, verified against at least one real failure case each.
- [ ] Regression check: manual (human) use of the browser pane — typing in the URL bar, clicking links — still works normally alongside agent-driven control; confirm no conflict when both a human and an agent interact with the same pane in close succession.

## Out of scope for this task

- Cursor/typing animation for watchability — see companion task `task-browser-agent-visual-feedback.md`. This task makes agent control *functionally* work; the companion task makes it *legible* to watch.
- Chat tab research-mode extraction (readability/content mode) — already covered by the other browser-extraction task; this task's `interactive` mode is a separate, additive read mode on the same bridge.

## Process reminder

Per PRD §13: test against a real local dev server (not just static pages) since that's the actual use case — have an agent session navigate to a running dev server, click through a UI flow, and confirm the visible pane reflects it correctly at each step. Log the IPC mechanism choice and MCP registration approach in `BUILD_LOG.md`/`AI_CONTEXT.md` once decided, since this is genuinely new infrastructure other features may want to reuse later.
