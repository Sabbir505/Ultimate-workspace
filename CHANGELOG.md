# Changelog

## 0.3.1

**Fix auto-updater signing key** — corrected the updater public key baked into the app so it matches the signing keypair. v0.3.0 installs could not verify update signatures because of a one-character mismatch in the embedded public key; this release restores the auto-update chain. (Existing v0.2.0 and v0.3.0 installs should manually install 0.3.1 once; updates work automatically after that.)

## What's new in 0.3.0

**Connectors framework** — a new connectors framework (OAuth sign-in, encrypted credential storage, remote-MCP tool bridging, per-tool permission gating), with Notion as the first connector. Heads-up: Notion sign-in isn't active in this build — it switches on in the next patch release; everything else is ready.

**Permission modes + filesystem tools** — pick how much freedom the agent gets per chat session: read-only, ask-every-time, auto-edit, or full-auto. Sensitive actions pause the turn for your approval; deletions always ask.

**Research mode** — deep-dive orchestration: the agent plans, gathers sources into a persistent ledger, then synthesizes a cited answer. Trigger it with `/research` or the composer's Research button.

**Local models** — Settings → Local Models scans your machine for `.gguf` files and serves them through a managed llama-server. Local models show up as a first-class provider: free, offline, private.

**Browser agent control** — the bundled `conduit-browser-mcp` sidecar lets an agent drive the in-app browser pane itself: navigate, click, and type with on-screen visual feedback (cursor, typing, and highlight overlays), plus much better page-content extraction.

**Bundled Python runtime** — the installer now ships its own Python + document libraries, so generating Word/PowerPoint/PDF artifacts works out of the box with no system Python required.

**Mobile companion + cost details** — the phone app mirrors and controls desktop sessions, and its Settings tab now shows the full cost dashboard: 14-day spend, per-project totals, and per-local-model token usage.

**Look & feel** — new warm cream/charcoal theme with a terracotta accent.

**Under the hood** — the chat backend is split into focused modules (prompts, streaming, dispatch, tools) and test coverage is much broader.

## 0.2.0

**Auto-updates** — Conduit now checks for new versions automatically. When a release is available, a banner appears with the changelog and a one-click Download & restart.

**Chat improvements** — model picker fuzzy search, remembers last-used provider, OpenRouter support, inline vector diagrams, JSX live preview, PDF/doc attachments, streaming token display, zoomable artifact preview pane, per-chat artifacts persisted.

**Docs** — AI_CONTEXT.md; CONTRACT.md synced to the implementation.
