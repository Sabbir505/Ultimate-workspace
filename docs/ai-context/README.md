# Relay

> A local-first, multi-pane desktop shell for AI coding agents (Claude Code, Kimi Code CLI, OpenCode, Pi, Omp, CommandCode).
>
> **Naming note.** "Relay" is the product name on every surface: user-visible strings, the Rust crate (`relay`, lib `relay_lib`), the bundle identifier (`dev.relay.app`), the sidecar binaries (`relay-browser-mcp`, `relay-automation`), the MCP server identifiers (`relay-browser`, `relay-tools`), the `RELAY_*` env vars, the mobile app (`Relay Mobile`, `com.relay.mobile`), and the Windows scheduled-task name (`RelayAutomations`). The only pre-rebrand value kept is the E2E pairing crypto constant (`conduit-e2e-relay-*`); existing installs migrate transparently (app data dir, keychain, DB file, user folders, scheduled task). See `RELEASE.md` for the rationale and compatibility matrix.

The core project docs live in the `docs/ai-context/` folder: see `PRD.md` for the full product spec, `CONTRACT.md` for the frontend/backend IPC contract, `AI_CONTEXT.md` for the canonical AI-facing code map, `BUILD_LOG.md` for build history, and `RELEASE.md` for the release/auto-update workflow. Historical audits and design records also live here (`AUDIT.md`, `BUG_LIST.md`, `BUG_LIST_ROUND2.md`, `COST_MODEL_REDESIGN.md`). The rest of the documentation tree sits under `docs/`: architecture docs in `docs/architecture/`, feature research in `docs/research/`, audit/issue/roadmap records in `docs/audits/`, and one-off reports/posts/task briefs in `docs/notes/` — see `docs/README.md` for the full map.

## Stack

- **Shell:** Tauri v2 (Rust backend + system webview) — `productName: "Relay"`, crate `relay`, identifier `dev.relay.app`
- **Frontend:** React 18 + TypeScript + Zustand, xterm.js for terminal panes
- **Persistence:** SQLite (projects, sessions, cost events, skills, quick actions, settings, memory, self-improvement) — 44 tables, WAL mode
- **Secrets:** OS keychain via the `keyring` crate (Windows Credential Manager / macOS Keychain / Linux Secret Service)

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
- One or more agent CLIs on PATH: `claude` (Claude Code), `kimi` (Kimi Code CLI), `opencode` (OpenCode), `pi` (Pi), `omp` (Omp), and/or `commandcode` (CommandCode). The app works for project/session management without them, but agent panes need at least one (one-click npm install is available in Settings → Harnesses).
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

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/` and named `Relay_<version>_x64-setup.exe` (`productName`-driven; the `make-latest-json` script's regex also accepts legacy `Conduit_` release assets when picking the updater artifact).

## Tests

```bash
npm test                      # frontend logic tests (vitest, 215 files / 1702 tests as of 2026-10-05;
                              #  run with NODE_ENV=test or unset)
cd src-tauri && cargo test --lib  # backend unit tests (1659 passed, 0 failed, 23 ignored as of 2026-10-05)
```

> `src/test/jsxPreviewRuntime.test.ts` has one case that can exceed the 5s timeout when the whole suite runs in parallel (it competes with the Mermaid corpus render for CPU). It passes in isolation — a lone failure there is load, not a regression.

## Notes

- Pane processes are killed on explicit pane close, LRU replacement (when all 6 pane slots are full — the least-recently-used pane is evicted and its pty terminated), or app quit — unfocused panes keep running (PRD §6.5). `MAX_PANES = 6` in `src/state/panes.ts:22`.
- On app launch, previously open sessions are *not* auto-resumed; click a session in the sidebar to resume it by ID.
- The browser pane uses native Tauri webviews on every supported platform — child webviews (WebView2 / WKWebView) on Windows/macOS, standalone `WebviewWindow`s on Linux (since wry/gtk has no multi-webview support). No more X-Frame-Options limitations on any platform. Each pane supports multiple tabs — every tab is its own native webview. Agent-driven browser control (navigate, click, type, scroll, read) is available via the bundled `relay-browser-mcp` sidecar (binary name retained) or the in-app `browser_read`/`browser_click`/`browser_type`/`browser_scroll` chat tools, with on-screen visual feedback (cursor tween, click ripple, typing caret, element highlight).
- The Chat tab offers a direct LLM conversation interface: streaming responses, HTML/CSS vector-SVG diagram generation (exportable to PNG/SVG), document generation (docx via the `docx` npm library, pptx via PptxGenJS, pdf via HTML → WebView2 print with Paged.js; Python engines as fallback), a visual artifact library with download/copy/export, message attachments (images and docs), a model-effort selector, local model support (GGUF via llama.cpp with automatic context compaction), per-session permission policies (a sandbox policy — read-only / workspace-write — plus an approval policy — on-request / confirm-edits / auto-edit / full-access — for filesystem tool access; the older single "permission mode" is kept only as a backfill shim), research mode (`/research`) with a source ledger for cited answers, and a Connectors framework (OAuth sign-in for Notion, GitHub, Google, Gmail, YouTube, Kiwi, Canva) that bridges remote MCP servers as per-session tools. Mermaid is also rendered when present, but diagrams are generated through the `generate_diagram` tool, not Mermaid.
- **Connectors** (OAuth SaaS integrations): Notion, GitHub, Gmail, Google Drive/Calendar/Sheets/Docs/Slides/Chat/People, YouTube, Kiwi, and Canva are supported via OAuth 2.0. Connectors are per-conversation opt-in (attached to a chat session, never global). Credentials are stored in the OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service).
- The app ships a bundled `python-build-standalone` interpreter (with python-docx/python-pptx/openpyxl/reportlab) staged by `scripts/fetch-bundled-python.mjs`, so the Python document-generation fallback and code execution work out of the box; `scripts/fetch-bundled-libreoffice.mjs` stages LibreOffice for office-accurate PDF conversion.
- Auto-updates: the app checks a GitHub Releases endpoint on launch and every 4 hours; a found update surfaces a banner and installs with signature verification. See `RELEASE.md`.
- A **mobile companion app** (React Native / Expo, SDK 57, RN 0.86) connects to the desktop over a localhost WebSocket relay. The phone never holds API keys — every model call originates from the desktop. It mirrors terminal sessions as styled text snapshots, triggers chat turns, spawns local model sidecars, and resolves tool approvals. See `CONTRACT.md` → Mobile Relay and `docs/remote-access.md`.
- **0.6.0 additions:** a **Vault** (bound markdown folder with end-to-end AI CRUD — `vault_*` commands plus `vault_list`/`vault_read`/`vault_search`/`vault_write`/`vault_move`/`vault_delete` chat tools, atomic writes, vault-wide link rewrites, recoverable deletes, Obsidian-parity editor), **local image generation** (`generate_image` + the sd.cpp `sd-server` sidecar), **user hooks** (pre/post tool-call scripts with a Claude-Code I/O contract; `hooks_test`/`hooks_import_claude`), **automation triggers beyond cron** (inbound webhook / watched file / git HEAD / new Gmail), **hybrid local search** (FTS + vector RRF with an optional llama-server reranker), a **live harness model catalog** (the static fallback catalog is gone), **live LiteLLM pricing refresh**, and app **wallpaper** presets/custom uploads.
- **Since 0.6.0:** a generated **project wiki** (per-project markdown knowledge base whose pages end in a Grounded-Claims ledger — claim → file + line range + blob SHA — with freshness computed from git), a **declarative subagent registry** (reusable agent definitions with their own prompt, tool set, engine/model and policies; shipped as `crew_*` and renamed by migration), an **LLM request log** for local models plus a loopback passthrough gateway, **GitHub Issues** support alongside PRs, and **app self-control** (the agent can drive Relay's own UI through an injected bridge).
- See `BUILD_LOG.md` for build progress, test coverage, and design decisions/deviations from the PRD.
