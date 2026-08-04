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
  - **Linux (Ubuntu 22.04+ / Debian 12+ / Fedora 39+):**
    ```bash
    # Debian/Ubuntu
    sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
        libayatana-appindicator3-dev librsvg2-dev patchelf file wget
    # Fedora
    sudo dnf install webkit2gtk4.1-devel openssl-devel gtk3-devel \
        libappindicator-gtk3-devel librsvg2-devel patchelf file wget
    ```
- One or both agent CLIs on PATH: `claude` (Claude Code) and/or `kimi` (Kimi Code CLI). OpenCode (`opencode`) is also supported. The app works for project/session management without them, but agent panes need at least one.
- **Linux secrets:** the app uses the Secret Service API via the `keyring` crate (`linux-native` + `sync-secret-service` features), which works with `gnome-keyring`, `kwalletd5` (KDE), and `KeePassXC`. A running Secret Service implementation is recommended for full functionality. Without one, secrets fall back to the XOR-obfuscated SQLite store (documented in `AUDIT.md` row 3.2/2.2).

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
- The browser pane uses native Tauri webviews on every supported platform — child webviews (WebView2 / WKWebView) on Windows/macOS, standalone `WebviewWindow`s on Linux (since wry/gtk has no multi-webview support). No more X-Frame-Options limitations on any platform. Each pane supports multiple tabs — every tab is its own native webview. Agent-driven browser control (navigate, click, type, scroll, read) is available via the bundled `conduit-browser-mcp` sidecar or the in-app `browser_read`/`browser_click`/`browser_type`/`browser_scroll` chat tools, with on-screen visual feedback (cursor tween, click ripple, typing caret, element highlight).
- The Chat tab offers a direct LLM conversation interface: streaming responses, HTML/CSS vector-SVG diagram generation (exportable to PNG/SVG), document generation (docx/pptx/xlsx/pdf via a bundled Python runtime — no system Python required), a visual artifact library with download/copy/export, message attachments (images and docs), a model-effort selector, local model support (GGUF via llama.cpp with automatic context compaction), per-session permission modes (read-only / manual / auto-edit / full-auto) for filesystem tool access, research mode (`/research`) with a source ledger for cited answers, and a Connectors framework (OAuth sign-in for Notion, GitHub, Google, Gmail, Kiwi) that bridges remote MCP servers as per-session tools. Mermaid is also rendered when present, but diagrams are generated through the `generate_diagram` tool, not Mermaid.
- **Connectors** (OAuth SaaS integrations): Notion, GitHub, Gmail, Google Drive/Calendar/Sheets/Docs/Slides/Chat/People, and Kiwi are supported via OAuth 2.0. Connectors are per-conversation opt-in (attached to a chat session, never global). Credentials are stored in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service).
- The app ships a bundled `python-build-standalone` interpreter (with python-docx/python-pptx/openpyxl/reportlab) staged by `scripts/fetch-bundled-python.mjs`, so document generation works out of the box.
- Auto-updates: the app checks a GitHub Releases endpoint on launch and every 4 hours; a found update surfaces a banner and installs with signature verification. See `RELEASE.md`.
- A **mobile companion app** (React Native / Expo) connects to the desktop over a localhost WebSocket relay. The phone never holds API keys — every model call originates from the desktop. It mirrors terminal sessions as styled text snapshots, triggers chat turns, spawns local model sidecars, and resolves tool approvals. See `CONTRACT.md` → Mobile Relay.
- See `BUILD_LOG.md` for build progress, test coverage, and design decisions/deviations from the PRD.
