# Changelog

## 0.3.2

**Local model context compaction** — automatically summarizes older conversation history when a local GGUF model's context window approaches capacity. The most recent exchanges stay verbatim; aged-out turns are condensed via a non-streaming summarization call. Configurable threshold and pin count in Settings → Local Models → Compaction.

**Context window meter** — a small circular SVG ring below the send button shows how much context was used by the last turn (green < 70%, amber 70–90%, red > 90%).

**Skills system overhaul** — skills moved from the old JSON table to on-disk files in harness skill directories (`~/.claude/skills/`, `~/.agents/skills/`) plus four built-in skills (`docx`, `pptx`, `pdf`, `diagram`). A new `/` slash-menu in the composer lists all available skills, and a new `get_skill(slug)` tool lets the model load skill instructions on demand.

**UI refresh — Codex-style aesthetic** — thinking blocks collapsed by default with muted monospace styling, tool-call activity in compact monospace log lines, inline unified diffs, blinking cursor typing indicator, compaction markers in the timeline, and session context menus that flip upward near the viewport bottom.

**Notification sound** — new setting (on by default) plays a short chime alongside PTY notifications. Per-pane 30s cooldown prevents spam.

**Model selector improvements** — local model names shortened (quantization tags and `.gguf` stripped), duplicate entries resolved, context-size number input alongside the slider, and `n_ctx` propagated end-to-end for accurate context metering.

**Mobile companion enhancements** — new `StartLocalModel`/`LocalModelReady`/`LocalModelError` protocol messages let the phone trigger a sidecar spawn on the desktop.

**Windows console window suppression** — `llama-server`, Python, git, and code-execution subprocesses use `CREATE_NO_WINDOW` to prevent console window flashes.

**Delete session also closes pane** — removing a session from the Dev tab sidebar now kills the underlying PTY process and closes the terminal pane.

**Browser pane polish** — address bar selects all text on focus/click; full pane close on React unmount prevents floating frozen native webviews.

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
