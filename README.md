# Relay

> A local-first, multi-pane desktop shell for AI coding agents.

Relay wraps the AI agent CLIs you already use (Claude Code, Kimi Code CLI, OpenCode, Pi, Omp, CommandCode) and adds a unified built-in chat, native browser panes, a git sidebar, a cost dashboard, scheduled automations, and a mobile companion — all local-first on your machine.

- Up to **6** PTY agent panes, tiled and resizable
- **Built-in chat** that talks to Anthropic, OpenAI, OpenRouter, OpenAI-compatible endpoints, and local GGUF models (via `llama-server`)
- **Native browser panes** (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) with agent-driven control and visual feedback
- **Vault** — a bound folder of markdown notes with full AI read/write (search with `tag:`/`path:`/`file:` operators, atomic writes, vault-wide `[[wikilink]]` rewrites, recoverable deletes), an Obsidian-parity editor with note tabs, local graph, tags, templates and an in-app PDF viewer
- **Local image generation** — a local diffusion sidecar (`sd.cpp`) paints from a text prompt, no cloud and no API key
- **User hooks** — Claude-Code-style pre/post tool-call scripts around every agent tool call (deny, ask, rewrite input, annotate results), with a Test button and a `hooks_import_claude` importer
- **Git sidebar** with status, diff, log, branches, worktrees, AI-proposed plans, and a Git Graph commit table
- **Local model "market"** — browse, download, and run Hugging Face GGUF models
- **Automations** — cron schedules that fire even while the app is closed (Windows Task Scheduler sidecar), plus event triggers: inbound webhook, watched file, git HEAD change, and new Gmail activity
- **Voice** — push-to-talk dictation (whisper STT) and read-aloud answers (Kokoro TTS, in-process via sherpa-onnx, optional CUDA)
- **Mobile companion** (React Native / Expo, Expo SDK 57) — pair over QR, run chats from your phone, the phone never holds API keys
- **Connectors** (OAuth): Notion, GitHub, Google Drive/Calendar/Sheets/Docs/Slides/Chat/People, Gmail, YouTube, Kiwi, Canva
- **Appearance** — stock or custom wallpaper with a dim scrim, sidebar header art, and a theme gallery

## Naming

"Relay" is the product name everywhere — the window title, the `productName` in `tauri.conf.json`, the `<title>` in `index.html`, all in-app strings, the Rust crate (`relay`, lib `relay_lib`), the bundle identifier (`dev.relay.app`), the sidecar binaries (`relay-browser-mcp`, `relay-automation`), the MCP server identifiers (`relay-browser`, `relay-tools`), the `RELAY_*` env vars, the OS keychain service, the mobile app (`Relay Mobile`, `com.relay.mobile`), and the Windows scheduled-task name (`RelayAutomations`).

The only pre-rebrand values kept on purpose are the E2E pairing crypto constants (`conduit-e2e-relay-*`), which are protocol-anchored on both desktop and phone. Existing installs migrate transparently: the app data dir (`%APPDATA%/dev.conduit.app` → `%APPDATA%/dev.relay.app`) renames itself on first launch, keychain entries are read across generations and re-homed on delete, persisted paths (`conduit.db`, `Documents/Conduit`, `~/Conduit/models`, `ConduitAutomations`) resolve their legacy counterparts, and the updater still accepts legacy `Conduit_` release assets — see `docs/ai-context/RELEASE.md` for the full compatibility matrix.

## Quick start

```bash
npm install
npm run tauri dev      # first run: 10-20 min for Rust compile, then incremental
```

Production build:

```bash
npm run tauri build    # NSIS installer in src-tauri/target/release/bundle/nsis/
```

## Tests

```bash
npm test                          # vitest, 174 files / 1286 tests
cd src-tauri && cargo test --lib  # 1315 passed, 0 failed, 16 ignored
npx tsc --noEmit                  # clean (also for mobile/: npx tsc --noEmit)
```

## Repository layout

```
src/                React + TypeScript frontend (Zustand stores, components, lib)
src-tauri/          Rust backend (Tauri v2)
  src/lib.rs        Tauri command surface (369 registered commands)
  src/db/           SQLite schema + 29 inline migrations (56 tables, WAL mode)
  src/commands/     Tauri command handlers, one module per domain (chat, git, tts, stt, vault, image gen, …)
  src/chat/         Chat dispatch, prompts, streaming, providers, tools, local models
  src/memory/       Persistent user memory (extraction, consolidation, retrieval)
  src/session_fabric/  Session Mesh — cross-session awareness/messaging/spawning
  src/vault/        Markdown knowledge base — index, frontmatter/link parser, atomic file ops
  src/hooks.rs      User pre/post tool-call hooks (exec gate, decisions, observations)
  src/pty/          PTY lifecycle
  src/browser*.rs   Native browser panes + browser MCP
  src/mobile/       Localhost WebSocket relay (E2E encrypted)
  src/automations*  Automation scheduler (cron + webhook/file/git/Gmail triggers)
  src/improve_engine.rs  Self-improving artifacts engine
  src/connectors/   OAuth + remote MCP for Notion / GitHub / Google / etc.
  src/harness_adapters/  Per-CLI harness adapters (six harnesses)
  src/bin/          Sidecar binaries (relay-browser-mcp, relay-automation)
mobile/             React Native / Expo companion (Expo SDK 57, RN 0.86)
scripts/            Build sidecars, stage Python/LibreOffice bundles, emit latest.json
docs/               All project documentation (see docs/README.md for the map)
  docs/ai-context/    Canonical code map, IPC contract, PRD, build log, release notes
  docs/architecture/  Shipped-subsystem design docs (memory, documents, compaction, …)
  docs/research/      Feature research notes
  docs/audits/        Audit / issue / roadmap records (point-in-time)
  docs/notes/         One-off reports, release posts, task briefs
```

## Documentation

| File | Purpose |
|---|---|
| `README.md` | This file |
| `docs/ai-context/README.md` | Index of the `docs/ai-context/` doc set |
| `CHANGELOG.md` | Release notes and notable commits |
| `docs/audits/BUG_AUDIT.md` | Open and resolved bugs (Sev-tagged, source of truth: the code) |
| `docs/audits/PERFORMANCE_AUDIT.md` | Performance findings and current build metrics |
| `docs/ai-context/AI_CONTEXT.md` | Canonical code map for AI assistants working on the codebase |
| `docs/ai-context/CONTRACT.md` | IPC contract between Rust backend and React frontend |
| `docs/ai-context/PRD.md` | Product requirements |
| `docs/ai-context/BUILD_LOG.md` | Build history, test coverage, design decisions |
| `docs/ai-context/RELEASE.md` | Auto-update release flow + naming rationale |
| `docs/ai-context/AUDIT.md`, `docs/ai-context/BUG_LIST.md`, `docs/ai-context/BUG_LIST_ROUND2.md` | Historical bug audits |
| `docs/architecture/DOCUMENT_DESIGN_ARCHITECTURE.md` | Document design layer (DOCX/PPTX/PDF generation) |
| `docs/architecture/MEMORY_DESIGN_ARCHITECTURE.md` | Persistent user-memory architecture |
| `docs/architecture/COMPACTION_REDESIGN.md` | Context compaction across the three chat paths |
| `docs/architecture/SELF_IMPROVING_ARTIFACTS.md` | Self-improving artifacts loop (design + shipped phases) |
| `docs/architecture/SESSION_MESH_DESIGN_ARCHITECTURE.md` | Session Mesh — cross-session awareness, messaging, and spawning |
| `docs/remote-access.md` | Pairing the mobile companion over USB or Tailscale |

## License

See repository license.
