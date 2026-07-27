# Conduit

A local-first, multi-pane desktop shell for AI coding agents (Claude Code, Kimi Code CLI).
All project docs live in the `AI CONTEXT/` folder: see `PRD.md` for the full product spec, `CONTRACT.md` for the frontend/backend IPC contract, `AI_CONTEXT.md` for the canonical AI-facing code map, `BUILD_LOG.md` for build history, and `RELEASE.md` for the release/auto-update workflow.

## Stack

- **Shell:** Tauri v2 (Rust backend + system webview)
- **Frontend:** React 18 + TypeScript + Zustand, xterm.js for terminal panes
- **Persistence:** SQLite (projects, sessions, cost events, skills, quick actions, settings)
- **Secrets:** OS keychain via the `keyring` crate (Windows Credential Manager / macOS Keychain)

## Prerequisites

- Node.js 20+ and npm
- Rust toolchain (`rustup`, stable) — https://rustup.rs
- Platform build tools:
  - **Windows:** Visual Studio Build Tools with the "Desktop development with C++" workload, plus the WebView2 runtime (preinstalled on Windows 10/11)
  - **macOS:** Xcode Command Line Tools
- One or both agent CLIs on PATH: `claude` (Claude Code) and/or `kimi` (Kimi Code CLI). The app works for project/session management without them, but agent panes need at least one.

## Run in dev mode

```bash
npm install
npm run tauri dev
```

The first run compiles the Rust backend and can take 10–20 minutes; subsequent runs are incremental.

## Build a release bundle

```bash
npm run tauri build
```

## Tests

```bash
npm test                      # frontend logic tests (vitest)
cd src-tauri && cargo test    # backend unit tests (adapters, db, git helpers)
```

## Notes

- Pane processes are killed on explicit pane close, LRU replacement (when all 6 pane slots are full — the least-recently-used pane is evicted and its pty terminated), or app quit — unfocused panes keep running (PRD §6.5).
- On app launch, previously open sessions are *not* auto-resumed; click a session in the sidebar to resume it by ID.
- The browser pane uses native Tauri child webviews on Windows/macOS (no more X-Frame-Options limitations); Linux falls back to iframes. Each pane supports multiple tabs — every tab is its own native webview (or iframe on Linux).
- The Chat tab offers a direct LLM conversation interface: streaming responses, HTML/CSS vector-SVG diagram generation (exportable to PNG/SVG), document generation (docx/pptx/xlsx/pdf via a bundled Python runtime — no system Python required), a visual artifact library with download/copy/export, message attachments (images and docs), and a model-effort selector. Mermaid is also rendered when present, but diagrams are generated through the `generate_diagram` tool, not Mermaid.
- The app ships a bundled `python-build-standalone` interpreter (with python-docx/python-pptx/openpyxl/reportlab) staged by `scripts/fetch-bundled-python.mjs`, so document generation works out of the box.
- Auto-updates: the app checks a GitHub Releases endpoint on launch and every 4 hours; a found update surfaces a banner and installs with signature verification. See `RELEASE.md`.
- See `BUILD_LOG.md` for build progress, test coverage, and design decisions/deviations from the PRD.
