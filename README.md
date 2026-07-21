# Conduit

A local-first, multi-pane desktop shell for AI coding agents (Claude Code, Kimi Code CLI).
See `PRD.md` for the full product spec and `CONTRACT.md` for the frontend/backend IPC contract.

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

- Pane processes are killed only on explicit pane close or app quit — unfocused panes keep running (PRD §6.5).
- On app launch, previously open sessions are *not* auto-resumed; click a session in the sidebar to resume it by ID.
- The browser pane is an embedded iframe pointed at your dev server; servers that send `X-Frame-Options: DENY` will refuse to render in it (known v1 limitation).
- See `BUILD_LOG.md` for build progress, test coverage, and design decisions/deviations from the PRD.
