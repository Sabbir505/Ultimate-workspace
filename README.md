# Relay

> A local-first, multi-pane desktop shell for AI coding agents.

Relay wraps the AI agent CLIs you already use (Claude Code, Kimi Code CLI, OpenCode) and adds a unified built-in chat, native browser panes, a git sidebar, a cost dashboard, scheduled automations, and a mobile companion — all local-first on your machine.

- Up to **6** PTY agent panes, tiled and resizable
- **Built-in chat** that talks to Anthropic, OpenAI, OpenRouter, OpenAI-compatible endpoints, and local GGUF models (via `llama-server`)
- **Native browser panes** (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) with agent-driven control and visual feedback
- **Git sidebar** with status, diff, log, branches, worktrees, AI-proposed plans, and a Git Graph commit table
- **Local model "market"** — browse, download, and run Hugging Face GGUF models
- **Cron automations** that fire even while the app is closed (Windows Task Scheduler sidecar)
- **Mobile companion** (React Native / Expo, Expo SDK 57) — pair over QR, run chats from your phone, the phone never holds API keys
- **Connectors** (OAuth): Notion, GitHub, Google Drive/Calendar/Sheets/Docs/Slides/Chat/People, Gmail, YouTube, Kiwi

## Naming

"Relay" is the product name everywhere — the window title, the `productName` in `tauri.conf.json`, the `<title>` in `index.html`, all in-app strings, the Rust crate (`relay`, lib `relay_lib`), the bundle identifier (`dev.relay.app`), the sidecar binaries (`relay-browser-mcp`, `relay-automation`), the MCP server identifiers (`relay-browser`, `relay-tools`), the `RELAY_*` env vars, the OS keychain service, the mobile app (`Relay Mobile`, `com.relay.mobile`), and the Windows scheduled-task name (`RelayAutomations`).

The only pre-rebrand values kept on purpose are the E2E pairing crypto constants (`conduit-e2e-relay-*`), which are protocol-anchored on both desktop and phone. Existing installs migrate transparently: the app data dir (`%APPDATA%/dev.conduit.app` → `%APPDATA%/dev.relay.app`) renames itself on first launch, keychain entries are read across generations and re-homed on delete, persisted paths (`conduit.db`, `Documents/Conduit`, `~/Conduit/models`, `ConduitAutomations`) resolve their legacy counterparts, and the updater still accepts legacy `Conduit_` release assets — see `AI CONTEXT/RELEASE.md` for the full compatibility matrix.

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
npm test                          # vitest, 68 files / 460 tests
cd src-tauri && cargo test --lib  # 539 passed, 1 FAILED, 11 ignored (see BUG_AUDIT.md)
npx tsc --noEmit                  # 34 errors — see BUG_AUDIT.md N5
```

## Repository layout

```
src/                React + TypeScript frontend (Zustand stores, components, lib)
src-tauri/          Rust backend (Tauri v2)
  src/lib.rs        Tauri command surface (235 commands)
  src/db/           SQLite schema + 12+ inline migrations (21 tables, WAL mode)
  src/chat/         Chat dispatch, prompts, streaming, providers, tools, local models
  src/pty/          PTY lifecycle
  src/browser*.rs   Native browser panes + browser MCP
  src/mobile/       Localhost WebSocket relay (E2E encrypted)
  src/automations*  Cron scheduler
  src/connectors/   OAuth + remote MCP for Notion / GitHub / Google / etc.
mobile/             React Native / Expo companion (Expo SDK 57, RN 0.86)
scripts/            Build sidecars, stage Python/LibreOffice bundles, emit latest.json
docs/               Public docs (currently: remote-access.md)
AI CONTEXT/         Canonical code map, IPC contract, PRD, build log, release notes
```

## Documentation

| File | Purpose |
|---|---|
| `README.md` | This file |
| `PROJECT_OVERVIEW.md` | Codebase-wide tour with metrics, architecture, ranked improvements |
| `CHANGELOG.md` | Release notes and notable commits |
| `BUG_AUDIT.md` | Open and resolved bugs (Sev-tagged, source of truth: the code) |
| `PERFORMANCE_AUDIT.md` | Performance findings and current build metrics |
| `AI CONTEXT/AI_CONTEXT.md` | Canonical code map for AI assistants working on the codebase |
| `AI CONTEXT/CONTRACT.md` | IPC contract between Rust backend and React frontend |
| `AI CONTEXT/PRD.md` | Product requirements |
| `AI CONTEXT/BUILD_LOG.md` | Build history, test coverage, design decisions |
| `AI CONTEXT/RELEASE.md` | Auto-update release flow + naming rationale |
| `AI CONTEXT/AUDIT.md`, `AI CONTEXT/BUG_LIST.md`, `AI CONTEXT/BUG_LIST_ROUND2.md` | Historical bug audits |
| `docs/remote-access.md` | Pairing the mobile companion over USB or Tailscale |

## License

See repository license.
