# Conduit — Project Understanding & Improvement Plan

> A codebase-wide tour of **Conduit v0.4.1** (a local-first, multi-pane desktop shell for AI coding agents), written from a direct read of the source tree on **2026-08-12**. It ends with a concrete list of bugs, improvements, and new-feature ideas ranked by value.

---

## 1. What Conduit is

Conduit is a **desktop orchestration shell** — *not* a code editor and *not* an agent framework. It wraps existing AI coding agent CLIs (**Claude Code**, **Kimi Code**, **OpenCode**) so a developer can:

- open any local project folder,
- run up to **6 agent sessions at once** in tiled, resizable **PTY panes**,
- resume any session later by its harness session id,
- talk to LLMs directly through a built-in **Chat tab** (streaming HTTP/SSE, tool calling, artifact generation),
- see live git state, diffs, commits, branches, and AI-proposed plans in a dedicated git sidebar,
- browse what the agent built in **native webview browser panes**,
- manage local **GGUF models** via a Hugging Face "market",
- schedule **automated cron runs** that fire even while the app is closed,
- control it all from a **React Native mobile companion** over a localhost WebSocket relay (the phone never holds API keys).

Everything is **local-first** — SQLite on disk, OS-keychain secrets, child processes on the same machine, no cloud backend. (The one online dependency is the optional Hugging Face catalog and the GitHub Releases auto-updater.)

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Shell | **Tauri v2** (Rust backend + system webview), window vibrancy (acrylic on Windows, frosted on macOS) |
| Frontend | **React 18 + TypeScript**, **Zustand** stores, Tailwind + a 260 KB hand-written `global.css` theme system |
| Terminal | **xterm.js** + `portable-pty` (ConPTY on Windows) |
| Persistence | **SQLite** (rusqlite, WAL mode) — projects, sessions, chat messages, cost events, skills, settings, artifacts |
| Secrets | **OS keychain** via `keyring` (Windows Credential Manager / macOS Keychain / Linux Secret Service) |
| LLM chat | reqwest → Anthropic / OpenAI / OpenRouter / OpenAI-compatible endpoints; local **llama-server** (GGUF) sidecar |
| Git | shells out to the `git` binary + a Rust **filesystem watcher** (`notify`) for event-driven status |
| Connectors | **OAuth 2.0 + remote MCP** (Notion, GitHub, Google family, Gmail, Kiwi) — vendor-hosted MCP servers, plus REST fallbacks |
| Docs/artifacts | Bundled **Python** (python-docx/pptx, openpyxl, reportlab) + bundled **LibreOffice** (pptx→pdf preview) |
| Mobile | **React Native / Expo** companion app |
| Distribution | NSIS installer + **signed auto-updates** from GitHub Releases (`latest.json`) |

---

## 3. High-level architecture

The app is three tiers connected by **Tauri IPC** (frontend ↔ backend) and by process/HTTP boundaries (backend ↔ external).

<details>
<summary><b>Architecture diagram</b> (also saved as <code>conduit-architecture.html</code> in this folder — open it in a browser or the artifact panel)</summary>

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 960" width="100%" style="max-width:920px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#64748b"/>
    </marker>
  </defs>
  <text x="550" y="32" text-anchor="middle" font-size="24" font-weight="700" fill="#0f172a">Conduit — Architecture Overview</text>
  <text x="550" y="54" text-anchor="middle" font-size="13" fill="#475569">Local-first, multi-pane desktop shell for AI coding agents · Tauri v2 + React 18 + SQLite</text>

  <rect x="20" y="70" width="1060" height="250" rx="14" fill="#eef2ff" stroke="#6366f1" stroke-width="1.5"/>
  <text x="40" y="98" font-size="14" font-weight="700" fill="#4338ca">REACT 18 + TYPESCRIPT FRONTEND (system webview)</text>

  <rect x="40" y="112" width="180" height="86" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="130" y="132" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">Sidebar</text><text x="130" y="152" text-anchor="middle" font-size="11" fill="#312e81">Projects · Sessions · Chats</text><text x="130" y="170" text-anchor="middle" font-size="11" fill="#312e81">Search / Cmd+K</text>
  <rect x="232" y="112" width="180" height="86" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="322" y="132" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">ChatView</text><text x="322" y="152" text-anchor="middle" font-size="11" fill="#312e81">MessageBubble · Composer</text><text x="322" y="170" text-anchor="middle" font-size="11" fill="#312e81">Artifacts · Attachments</text>
  <rect x="424" y="112" width="180" height="86" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="514" y="132" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">PaneGrid (≤ 6 panes)</text><text x="514" y="152" text-anchor="middle" font-size="11" fill="#312e81">TerminalPane (xterm.js)</text><text x="514" y="170" text-anchor="middle" font-size="11" fill="#312e81">BrowserPane (webview)</text>
  <rect x="616" y="112" width="180" height="86" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="706" y="132" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">Git Tools Sidebar</text><text x="706" y="152" text-anchor="middle" font-size="11" fill="#312e81">Commit · Branch · Plans</text><text x="706" y="170" text-anchor="middle" font-size="11" fill="#312e81">ToolPanel: Changes / Canvas</text>
  <rect x="808" y="112" width="180" height="86" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="898" y="132" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">Overlays</text><text x="898" y="152" text-anchor="middle" font-size="11" fill="#312e81">Settings · Skills · Cost</text><text x="898" y="170" text-anchor="middle" font-size="11" fill="#312e81">Automations · CommandPalette</text>

  <rect x="40" y="216" width="300" height="88" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="190" y="238" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">Zustand Stores</text><text x="190" y="258" text-anchor="middle" font-size="11" fill="#312e81">chat · ui · projects · settings</text><text x="190" y="276" text-anchor="middle" font-size="11" fill="#312e81">panes · artifacts · updater</text>
  <rect x="352" y="216" width="350" height="88" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="527" y="238" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">ipc.ts bridge</text><text x="527" y="258" text-anchor="middle" font-size="11" fill="#312e81">safeInvoke(cmd) → Tauri command</text><text x="527" y="276" text-anchor="middle" font-size="11" fill="#312e81">safeListen → chat:token · pty:output</text>
  <rect x="714" y="216" width="286" height="88" rx="8" fill="#e0e7ff" stroke="#a5b4fc"/><text x="857" y="238" text-anchor="middle" font-size="13" font-weight="700" fill="#1e1b4b">React Hooks</text><text x="857" y="258" text-anchor="middle" font-size="11" fill="#312e81">useChatEvents · usePtyEvents</text><text x="857" y="276" text-anchor="middle" font-size="11" fill="#312e81">usePlanTracker · useKeybindings</text>

  <line x1="527" y1="304" x2="527" y2="346" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/><text x="540" y="330" font-size="11.5" fill="#475569">Tauri IPC — invoke / events</text>

  <rect x="20" y="350" width="1060" height="310" rx="14" fill="#ecfeff" stroke="#0891b2" stroke-width="1.5"/>
  <text x="40" y="378" font-size="14" font-weight="700" fill="#155e75">TAURI V2 RUST BACKEND — lib.rs registers 134 IPC commands + managed shared state</text>

  <rect x="40" y="392" width="470" height="252" rx="10" fill="#ccfbf1" stroke="#5eead4"/>
  <text x="52" y="414" font-size="12.5" font-weight="700" fill="#134e4a">IPC Command Modules (commands/)</text>
  <g font-size="11" fill="#134e4a">
    <rect x="52" y="424" width="206" height="26" rx="6" fill="#f0fdfa" stroke="#99f6e4"/><text x="155" y="441" text-anchor="middle">projects · pty · browser · git</text>
    <rect x="274" y="424" width="206" height="26" rx="6" fill="#f0fdfa" stroke="#99f6e4"/><text x="377" y="441" text-anchor="middle">connectors</text>
    <rect x="52" y="452" width="206" height="26" rx="6" fill="#f0fdfa" stroke="#99f6e4"/><text x="155" y="469" text-anchor="middle">chat_cmds (+ agent)</text>
    <rect x="274" y="452" width="206" height="26" rx="6" fill="#f0fdfa" stroke="#99f6e4"/><text x="377" y="469" text-anchor="middle">local_model_market</text>
    <rect x="52" y="480" width="206" height="26" rx="6" fill="#f0fdfa" stroke="#99f6e4"/><text x="155" y="497" text-anchor="middle">data (settings/skills/cost)</text>
    <rect x="274" y="480" width="206" height="26" rx="6" fill="#f0fdfa" stroke="#99f6e4"/><text x="377" y="497" text-anchor="middle">automations · updater · mobile</text>
  </g>

  <rect x="530" y="392" width="330" height="252" rx="10" fill="#e0f2fe" stroke="#7dd3fc"/>
  <text x="542" y="414" font-size="12.5" font-weight="700" fill="#0c4a6e">Core Managers (shared state)</text>
  <g font-size="11" fill="#0c4a6e">
    <rect x="542" y="424" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="616" y="444" text-anchor="middle" font-weight="700">PtyManager</text><text x="616" y="460" text-anchor="middle" font-size="10">spawn/kill/resume PTYs</text>
    <rect x="700" y="424" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="774" y="444" text-anchor="middle" font-weight="700">BrowserManager</text><text x="774" y="460" text-anchor="middle" font-size="10">webviews + MCP relay</text>
    <rect x="542" y="482" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="616" y="502" text-anchor="middle" font-weight="700">ChatManager</text><text x="616" y="518" text-anchor="middle" font-size="10">SSE + 32 tools</text>
    <rect x="700" y="482" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="774" y="502" text-anchor="middle" font-weight="700">AgentSessions</text><text x="774" y="518" text-anchor="middle" font-size="10">headless CLI chat</text>
    <rect x="542" y="540" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="616" y="560" text-anchor="middle" font-weight="700">LocalModels</text><text x="616" y="576" text-anchor="middle" font-size="10">llama-server sidecar</text>
    <rect x="700" y="540" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="774" y="560" text-anchor="middle" font-weight="700">Connectors</text><text x="774" y="576" text-anchor="middle" font-size="10">OAuth + remote MCP</text>
    <rect x="542" y="598" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="616" y="618" text-anchor="middle" font-weight="700">Automations</text><text x="616" y="634" text-anchor="middle" font-size="10">cron · 30s tick</text>
    <rect x="700" y="598" width="148" height="46" rx="7" fill="#f0f9ff" stroke="#bae6fd"/><text x="774" y="618" text-anchor="middle" font-weight="700">MobileRelay</text><text x="774" y="634" text-anchor="middle" font-size="10">localhost WS</text>
  </g>

  <rect x="880" y="392" width="200" height="252" rx="10" fill="#f5f3ff" stroke="#c4b5fd"/>
  <text x="892" y="414" font-size="12.5" font-weight="700" fill="#4c1d95">Persistence &amp; Runtime</text>
  <g font-size="11.5" fill="#4c1d95">
    <text x="892" y="440">SQLite conduit.db (WAL)</text>
    <text x="892" y="466">OS Keychain (secrets)</text>
    <text x="892" y="492">Bundled Python + LibreOffice</text>
    <text x="892" y="518">Harness bundle (mcp.json)</text>
    <text x="892" y="544">Artifacts · 30-day sweep</text>
    <text x="892" y="570">git filesystem watcher</text>
  </g>

  <line x1="510" y1="505" x2="528" y2="505" stroke="#0891b2" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="860" y1="520" x2="878" y2="520" stroke="#0891b2" stroke-width="1.5" marker-end="url(#arr)"/>

  <path d="M616 470 V 674 H120 V 752" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/><text x="270" y="666" font-size="11.5" fill="#475569">PTY: spawn / resume-by-id</text>
  <path d="M628 528 V 686 H290 V 752" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/><text x="470" y="678" font-size="11.5" fill="#475569">HTTP / SSE streaming</text>
  <path d="M640 586 V 700 H460 V 752" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/><text x="500" y="692" font-size="11.5" fill="#475569">HF Hub download</text>
  <path d="M774 586 V 686 H630 V 752" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/><text x="640" y="678" font-size="11.5" fill="#475569">OAuth + remote MCP</text>
  <path d="M652 644 V 712 H800 V 752" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/><text x="660" y="704" font-size="11.5" fill="#475569">latest.json (HTTPS)</text>
  <path d="M786 644 V 724 H970 V 752" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/><text x="880" y="716" font-size="11.5" fill="#475569">WebSocket relay</text>

  <rect x="20" y="720" width="1060" height="210" rx="14" fill="#fffbeb" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="40" y="746" font-size="14" font-weight="700" fill="#b45309">EXTERNAL / THIRD-PARTY</text>

  <rect x="40" y="762" width="158" height="108" rx="8" fill="#fef3c7" stroke="#fcd34d"/><text x="119" y="788" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">Agent CLIs</text><text x="119" y="810" text-anchor="middle" font-size="11" fill="#92400e">Claude Code · Kimi</text><text x="119" y="830" text-anchor="middle" font-size="11" fill="#92400e">OpenCode (PTY child)</text><text x="119" y="850" text-anchor="middle" font-size="11" fill="#92400e">resume-by-id</text>
  <rect x="210" y="762" width="158" height="108" rx="8" fill="#fef3c7" stroke="#fcd34d"/><text x="289" y="788" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">LLM Providers</text><text x="289" y="810" text-anchor="middle" font-size="11" fill="#92400e">Anthropic · OpenAI</text><text x="289" y="830" text-anchor="middle" font-size="11" fill="#92400e">OpenRouter · compatible</text><text x="289" y="850" text-anchor="middle" font-size="11" fill="#92400e">SSE over HTTP</text>
  <rect x="380" y="762" width="158" height="108" rx="8" fill="#fef3c7" stroke="#fcd34d"/><text x="459" y="788" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">Hugging Face Hub</text><text x="459" y="810" text-anchor="middle" font-size="11" fill="#92400e">GGUF + mmproj models</text><text x="459" y="830" text-anchor="middle" font-size="11" fill="#92400e">streaming download</text><text x="459" y="850" text-anchor="middle" font-size="11" fill="#92400e">SHA-256 verified</text>
  <rect x="550" y="762" width="158" height="108" rx="8" fill="#fef3c7" stroke="#fcd34d"/><text x="629" y="788" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">OAuth + Remote MCP</text><text x="629" y="810" text-anchor="middle" font-size="11" fill="#92400e">Notion · GitHub · Google</text><text x="629" y="830" text-anchor="middle" font-size="11" fill="#92400e">Gmail · Kiwi</text><text x="629" y="850" text-anchor="middle" font-size="11" fill="#92400e">vendor MCP servers</text>
  <rect x="720" y="762" width="158" height="108" rx="8" fill="#fef3c7" stroke="#fcd34d"/><text x="799" y="788" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">GitHub Releases</text><text x="799" y="810" text-anchor="middle" font-size="11" fill="#92400e">latest.json + NSIS</text><text x="799" y="830" text-anchor="middle" font-size="11" fill="#92400e">signed auto-update</text>
  <rect x="890" y="762" width="158" height="108" rx="8" fill="#fef3c7" stroke="#fcd34d"/><text x="969" y="788" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">Mobile Companion</text><text x="969" y="810" text-anchor="middle" font-size="11" fill="#92400e">React Native / Expo</text><text x="969" y="830" text-anchor="middle" font-size="11" fill="#92400e">localhost WebSocket</text><text x="969" y="850" text-anchor="middle" font-size="11" fill="#92400e">phone holds no keys</text>

  <text x="550" y="920" text-anchor="middle" font-size="12.5" fill="#64748b">Local-first by design: SQLite + OS keychain + child PTYs on this machine — no cloud backend.</text>
</svg>

</details>

```mermaid
flowchart TB
    subgraph FE["React 18 + TypeScript Frontend (system webview)"]
        SB[Sidebar<br/>Projects · Sessions · Chats · Search]
        CV[ChatView<br/>MessageBubble · Composer · Artifacts]
        PG[PaneGrid ≤ 6 panes<br/>TerminalPane xterm · BrowserPane webview]
        GT[Git Tools Sidebar<br/>Commit · Branch · Plans · Progress]
        OV[Overlays<br/>Settings · Skills · Cost · Automations]
        ST[Zustand Stores<br/>chat · ui · projects · settings · panes]
        IPC[ipc.ts<br/>safeInvoke · safeListen]
    end

    subgraph BE["Tauri v2 Rust Backend — lib.rs registers 134 commands"]
        CM[Command modules<br/>projects · pty · browser · git · chat · data · connectors · local_model_market · automations · updater]
        MG[Core Managers<br/>PtyManager · BrowserManager · ChatManager · AgentSessions · LocalModels · Connectors · Automations · MobileRelay]
        DB[(SQLite conduit.db<br/>WAL) ]
        KC[OS Keychain<br/>secrets]
    end

    subgraph EXT["External / Third-party"]
        CL[Agent CLIs<br/>Claude Code · Kimi · OpenCode]
        LP[LLM Providers<br/>Anthropic · OpenAI · OpenRouter]
        HF[Hugging Face Hub<br/>GGUF models]
        OA[OAuth + Remote MCP<br/>Notion · GitHub · Google · Gmail · Kiwi]
        GR[GitHub Releases<br/>auto-updater]
        MO[Mobile Companion<br/>Expo · WS relay]
    end

    IPC <-->|invoke / events| CM
    ST <--> IPC
    SB --- CV --- PG --- GT --- OV
    CM <--> MG
    MG <--> DB
    MG <--> KC
    MG -->|PTY spawn / resume| CL
    MG -->|HTTP / SSE| LP
    MG -->|download + verify| HF
    MG -->|OAuth2 + remote MCP| OA
    MG -->|latest.json HTTPS| GR
    MG <-->|WebSocket relay| MO
```

*(The inline Mermaid above is for GitHub-flavored markdown readers. In the Conduit app the canonical diagram is the generated `conduit-architecture` HTML artifact, which renders in the artifact panel and exports to PNG/SVG.)*

### How the pieces fit together

1. **Frontend → backend** — every interaction goes through `src/lib/ipc.ts` (`safeInvoke`/`safeListen`), which wraps ~134 Tauri commands registered in `src-tauri/src/lib.rs`. Streaming data (chat tokens, pty output, git status changes, plan-step progress) comes back as **Tauri events** (`chat:token`, `pty:output`, `project:fs-changed`, `plan-step-progress`…). There are **no other channels**; the IPC contract is the seam (`AI CONTEXT/CONTRACT.md`).

2. **Agent panes (Dev tab)** — `PtyManager` spawns harness CLIs in a ConPTY, resumes by id (`claude --resume`, `kimi -r`, `opencode -s`), and streams output to xterm.js. Harness behavior is abstracted behind the `HarnessAdapter` trait (`src-tauri/src/harness_adapters/`): session-id capture, usage scraping, diff-prompt detection. A **per-project harness bundle** (`src-tauri/src/harness_bundle.rs`) writes `mcp.json`/instructions into Conduit-owned config so connectors and skills reach the CLIs without clobbering the user's own config.

3. **Chat tab** — `ChatManager` streams SSE from the chosen provider, emits tokens to the frontend, runs a **32-tool loop** (filesystem, browser automation, document/diagram generation, research ledger, tasks), gates filesystem writes through `permission.rs`, attaches **connectors** as per-turn remote MCP tools, and persists messages + cost to SQLite. Headless CLI chat (`harness:claude_code` etc.) runs through `AgentSessionManager` and normalizes onto the *same* `chat:*` events.

4. **Git & plans** — the backend `git.rs` shells out to git (90 s cap, no terminal prompt), and `git_watcher.rs` (Rust `notify`) pushes `project:fs-changed` events so the frontend refreshes only on real change (60 s heartbeat as a safety net). A new **plan tracker** (`src/lib/planParser.ts` + `usePlanTracker.ts`) scans assistant markdown for step lists and the backend emits `plan-step-progress` events as tools run, rendering an execution timeline in the git sidebar.

5. **Local models** — the Hugging Face **market** (`commands/local_model_market.rs`) browses/downloads GGUF files (SHA-256 verified, resumable, cancellable); `chat/local_models.rs` scans folders, parses GGUF metadata, and spawns **llama-server** as an OpenAI-compatible localhost endpoint with a stepwise GPU-offload fallback ladder and free-VRAM probing (NVML on Windows).

6. **Automations** — `automations.rs` ticks every 30 s, fires due cron schedules as headless one-shot turns (full-auto permission), and logs each run into a chat session. A second binary, `conduit-automation`, reuses the same `launch_run` path so Windows Task Scheduler can run them while Conduit is closed.

7. **Mobile relay** — `mobile/relay.rs` binds a loopback/LAN WS server with a fresh per-launch **pairing token**; the Expo app mirrors terminal sessions as styled text snapshots and triggers chat turns. All model calls still originate on the desktop.

---

## 4. Backend map (`src-tauri/src/`)

| Module | Role | Notes |
|---|---|---|
| `lib.rs` | Entry point; manages shared state, registers 134 commands, boot sequence, exit cleanup | Kills every child PTY/browser/stream/sidecar on quit |
| `commands/` | Thin Tauri command wrappers (projects, pty, browser, git, chat, data, connectors, local_model_market, automations, updater, skills) | Verifies project-path allowlists before git/file ops |
| `pty/` | Pane lifecycle (spawn/kill/resume), writer+reader+waiter threads, URL detection | Panes only die on explicit close or quit |
| `browser.rs` | Native child-webview panes + tabs; bounds synced from the frontend | Windows/macOS: `add_child`; Linux: standalone `WebviewWindow`s |
| `browser_mcp.rs` + `bin/conduit_browser_mcp.rs` | In-app loopback MCP server + standalone sidecar binary; agent-driven browser control | Auth via random token; **10 browser ops** (`navigate`/`read_page`/`click`/`type_text`/`scroll`/`wait_for`/`screenshot`/`history`/`hover`/`evaluate`/`click_and_wait`) + **5 conduit tools** |
| `chat/` | `commands.rs` (2485 lines, largest), `mod.rs` (manager/streams), `dispatch.rs` (tool loop), `permission.rs`, `providers.rs`, `streaming.rs`, `compaction.rs`, `prompts.rs`, `local_models.rs`, `office.rs`, `artifacts.rs`, `tools/` | 4 providers; context compaction for local models; 32 tools |
| `agent_sessions.rs` (78 KB) | Headless CLI chat (claude stream-json; kimi/opencode per-turn), one-shot runs for automations | Normalizes to `chat:*` events |
| `git.rs` + `git_watcher.rs` | Git subprocess wrapper + filesystem watcher | 90 s timeout, no interactive prompts |
| `connectors/` | OAuth flows (PKCE), credential storage, remote MCP client, REST fallbacks (Gmail, Google Workspace) | Per-conversation opt-in; writes approval-gated |
| `automations.rs` | Cron scheduler (30 s tick) + run ledger | Overlap→skip; missed windows→one catch-up |
| `db/` | SQLite schema + migrations (13 modules) | WAL; additive column migrations; 30-day artifact sweep |
| `mobile/` | WS relay, session-chat mirroring, pairing auth | Phone never holds keys |
| `secrets.rs` | Keychain wrapper with XOR-fallback | |
| `harness_adapters/`, `harness_bundle.rs`, `harness_config.rs`, `installed_skills.rs` | Harness trait, per-project MCP bundle, CLI config parsing, skill/loop discovery | Built-in skills: `docx`/`pptx`/`pdf`/`diagram` + `goal`/`loop` (autonomous goal loop) |

## 5. Frontend map (`src/`)

| Area | Purpose |
|---|---|
| `App.tsx` | Shell layout: sidebar + toolbar + chat grid; lazy overlay views (Settings, Skills, Cost, Automations); modals; bootstrap hooks |
| `state/` | Zustand stores — `chat.ts` (1366 lines: sessions, messages, streaming, plan steps), `panes.ts`, `projects.ts`, `ui.ts`, `settings.ts`, `artifacts.ts`, `updater.ts`, `automations.ts`, `skills.ts` |
| `hooks/` | Event wiring (`useChatEvents`, `usePtyEvents`, `useBrowserMcpEvents`, `useGitStatusPolling`, `usePlanTracker`, …) + UI hooks |
| `components/chat/` | ChatView, MessageBubble (lazy, memoized), ChatComposer, GitToolsSidebar, CommitModal, BranchDropdown, InlineDiagram, MermaidDiagram, ArtifactExportMenu, … |
| `components/panes/` | PaneGrid, TerminalPane (xterm), BrowserPane, DevDiffPanel, ToolPanel, BranchPanel, ProgressPanel |
| `components/sidebar/`, `settings/`, `cost-dashboard/`, `skills-library/`, `automations/`, `command-palette/`, `peek/`, `onboarding/`, `documents-library/` | The rest of the surface |
| `lib/` | `ipc.ts` (1155 lines — the full IPC contract), session launcher, diff parser, plan parser/matcher, sanitize, syntax highlighting, model labels, keybindings, fuzzy search |
| `styles/global.css` | 260 KB theme system (Cursor-style palette, light/dark via `data-theme`), Tailwind utilities layered on top |

### Data model (SQLite, key tables)

- `projects` (path, is_git_repo) · `sessions` (harness, harness_session_id, worktree_path) · `chat_sessions` (provider, model, starred, unread, watch_mode, agent, project_id) · `chat_messages` (content, tokens, cost, superseded_by for compaction, started/completed timestamps) · `cost_events` · `artifacts` (30-day expiry) · `skills`, `quick_actions`, `settings`, `workspaces`, `connector_credentials`, `automations`, `chat_source_notes` (research ledger)
- Migrations are additive `ALTER TABLE … ADD COLUMN` with duplicate-column no-ops (`db/mod.rs`) — safe to run on every startup.

---

## 6. Testing & quality status

- **Frontend:** ~30 vitest test files in `src/test/` + hook tests (sanitization, diff parsing, plan parsing, model-effort, project-binding regressions…).
- **Backend:** Rust unit tests in ~58 files (db, permission, git helpers, adapters, streaming, local_models, office, browser MCP, mobile relay). `AI CONTEXT/AUDIT.md` reported **295+ Rust + vitest tests** passing (2026-08-04).
- **CI:** `.github/workflows/build.yml` builds + releases Windows NSIS. **It does not run the test suites** — a gap worth closing.
- **Audit trail:** `AI CONTEXT/BUG_LIST.md` tracked 69 findings; **68/69 fixed**, the one on hold being the permission-mode posture (see below). `AI CONTEXT/AUDIT.md` lists acknowledged debt. `PERFORMANCE_AUDIT.md` (29 KB) documents bundle-size/perf work (lazy-loading heavy deps, memoization).

---

## 7. Known issues & acknowledged debt

| # | Issue | Where | Status / note |
|---|---|---|---|
| 1 | **Per-session permission modes are unwired** — the backend *hardcodes* `PermissionMode::FullAuto` on every send (`chat/commands.rs:1211`, `:1436`); the enum + `as_str`/`from_str` plumbing exists in `permission.rs` but nothing reads a persisted `permission_mode` column. Frontend `PermissionModeMenu.tsx` + `ApprovalFlow.tsx` exist but are **never imported** (dead files), and the `resolve_tool_action` IPC is gone from `ipc.ts`. | `src-tauri/src/chat/commands.rs` · `permission.rs` · `src/components/chat/` | ⚠️ `BUG_LIST` H2 says *"FullAuto is intentional while the approval UX is reworked"* — so the right move is to **finish or remove**, not silently ship a UI that claims 4 modes while always running full-auto. |
| 2 | **Stale backend doc comment** — `git.rs` claims the frontend *polls* on an interval "rather than a filesystem watcher", but `git_watcher.rs` + the `project:fs-changed` event now exist and are the primary path. | `src-tauri/src/git.rs:5-7` | Comment rot. |
| 3 | **CSS mojibake** — `global.css` comments show UTF-8 mis-decoded as `â€”` / `Â§` (em-dashes and § symbols) on many lines. Comments only (cosmetic), but they're in the *main* stylesheet that every AI pass reads. | `src/styles/global.css` (lines ~7, 16-17, 24, 38-39, 46, 62, 65-66, 74…) | Re-encode file as clean UTF-8. |
| 4 | **Docs lag the code** — `AI CONTEXT/AUDIT.md` still lists "No CI/CD" (🟡) although `build.yml` exists, and "Browser panes disabled on Linux" although `browser.rs` now ships Linux `WebviewWindow`s. `AI_CONTEXT.md` ("single source of truth") is stamped 2026-08-07, predating the model-size gate, update button, and plan-steps features. | `AI CONTEXT/*` | Stale-proof the docs (see Improvements). |
| 5 | **Static model catalogs** — `src/lib/harnessModels.ts` has an open TODO ("replace this static catalog with a live query"); `SettingsView.tsx:117` hardcodes a pricing `MODELS` table. | `src/lib/harnessModels.ts:7` · `src/components/settings/SettingsView.tsx:117` | Drift risk whenever a model is added/renamed. |
| 6 | **Bundled Python/LibreOffice are Windows-only** in the fetch scripts; release pipeline only builds Windows NSIS. macOS/Linux builds would lack doc generation. | `scripts/fetch-bundled-*.mjs` · `.github/workflows/build.yml` | AUDIT 2.1/6.2 acknowledged. |
| 7 | **Notion/Google/GitHub client secrets baked into the binary** via `option_env!`; `.tauri/conduit-update.key` signing key sits in the repo tree (gitignored). | `src-tauri/src/connectors/config.rs` | AUDIT 3.6/6.4 acknowledged; a dynamic config endpoint would remove the risk. |
| 8 | **`run_code` is not OS-sandboxed** — `chat/codeexec.rs` has open TODOs (landlock / sandbox-exec / Windows Job Object). | `src-tauri/src/chat/codeexec.rs:52,62,83` | Mitigated by permission gating; a Windows Job Object would be a big win. |
| 9 | **Connector token freshness for persistent Claude sessions** — a long-lived `claude` process can hold an OAuth bearer token past its ~1 h expiry until the next respawn. | `src-tauri/src/connectors/harness.rs:14-15` | |
| 10 | **No per-turn wall-clock timeout** for chat streams; **MCP sessions are re-opened every tool-enabled turn** instead of reused. | `chat/*` · `connectors/session.rs` | AUDIT 5.4 / 5.3. |
| 11 | **Mobile relay binds `0.0.0.0`** (LAN-reachable) on a persistent port. A per-launch pairing token gates the first WS message, but consider defaulting to `127.0.0.1` with an explicit opt-in for LAN. | `src-tauri/src/mobile/relay.rs:3-4` | |
| 12 | **Hardcoded 250 ms "submit" delay** in `writePtySubmit` — a timing hack that could mis-fire on slow TUIs. | `src/lib/ipc.ts:90-93` | |
| 13 | **No root README** — first-time contributors land on a bare repo (the README lives under `AI CONTEXT/`). | repo root | |
| 14 | **Modal has no focus trap / ESC** — `Modal.tsx` renders a `role="dialog"` with no focus management or `Escape` handling; a11y gap. | `src/components/common/Modal.tsx` | |
| 15 | **`useGitStatusPolling` name is stale** — the hook is now event-driven (60 s heartbeat), but the name still suggests polling. Cosmetic, but misleading for future readers. | `src/hooks/useGitStatusPolling.ts` | |

---

## 8. Bugs worth fixing (ranked)

1. **Wire per-session permission modes end-to-end (or remove the half-built UI).** Add the `permission_mode` column (permission.rs already documents it), persist per session, read it at turn start instead of the `FullAuto` hardcode, and either re-wire `ApprovalFlow` + `resolve_tool_action` IPC or delete the dead components. Today the UI *shows* four modes that are all ignored — that's the single most misleading gap in the product. *(Confirm the 2026-08-08 "keep FullAuto" decision first.)*
2. **Add a test job to CI.** `build.yml` builds and releases but never runs `cargo test` or `vitest` — a regression can slip straight into a signed release.
3. **Fix the CSS encoding** (`global.css` mojibake) — cheap, improves every future AI/code pass over the stylesheet.
4. **Refresh stale docs** — correct `git.rs` header, `AUDIT.md` rows 6.1/2.3, bump `AI_CONTEXT.md`, and add a "last verified" marker so they can't rot silently.
5. **Sandbox `run_code` on Windows** with a Job Object (restrict to job + optionally break away disabled + drop privileges where possible); Landlock/sandbox-exec on Linux/macOS are the cross-platform asks.
6. **Reuse MCP sessions across turns** (cache `McpSession` per chat session + token lifetime) — cuts per-turn latency and re-auth churn.
7. **Add a per-turn chat timeout** (configurable) so a wedged stream can't spin forever.
8. **Default the mobile relay to `127.0.0.1`** with an explicit "Allow LAN" toggle, and re-emit the pairing token on rotation.
9. **Live/static model catalog cleanup** — either finish the "refresh from CLI" path or move pricing to a config file the release can regenerate.
10. **`Modal` accessibility** — focus trap, `Escape` to close, `aria-modal`, and return focus on close.

---

## 9. Improvements (engineering & UX polish)

1. **Root `README.md`** — port the `AI CONTEXT/README.md` essentials (what it is, stack, dev run, test, build) to the repo root.
2. **Global error surfacing** — most commands return `Err(String)` and the frontend often swallows it with `console.warn`. Add a small toast/notification surface so failures (git push, downloads, connector calls) are visible.
3. **Consolidate the theme system** — `global.css` is 260 KB and mixes a hand-rolled token system with Tailwind utilities. Extract design tokens to a single `theme.css` and prune dead rules.
4. **Message-list windowing** — `ChatView` renders the full message list; for very long sessions, virtualize (or at least cap the DOM with a "load earlier" button).
5. **Search across everything** — SQLite FTS5 index over `chat_messages` + a global command-palette result for chats/files/projects. High value, well-scoped.
6. **Update the stale hook name** and add a code comment pass on `git_watcher` vs polling so the design is unambiguous.
7. **Error states for the local-model market** — surface catalog/download failures with retry affordances; today a gated-repo 401/403 is only a hint string.
8. **Updater UX edge cases** — the update check runs on startup + every 4 h; consider manual "Check for updates" in Settings and a per-channel (stable/beta) opt-in.
9. **Keyboard-first pass** — more global shortcuts (jump to chat, switch pane, toggle panels), a command-palette action registry, and consistent focus management.
10. **`started_at`/`completed_at` already feed "Worked for Xs"** — extend the same timing to harness (PTY) turns so cost/elapsed metrics are uniform across both surfaces.

---

## 10. New feature ideas (ranked by leverage)

| Idea | Why it fits | Rough cost |
|---|---|---|
| **Full-text search over all chats** (FTS5) | The app already stores everything locally; a unified search is the natural next step | Small (backend FTS5 + palette results) |
| **Project/chat export & import** (zip bundle: messages, artifacts, cost) | Backups, sharing, and the "local-first" story | Small–Medium |
| **Budget / spend alerts** | Cost dashboard exists; add a threshold that pushes a notification when a project or the month crosses a $ cap | Small |
| **Create PR / review from the git sidebar** (drive `gh` CLI or the GitHub connector) | Git surface is already rich; "commit & push" → "open PR" is one step | Medium |
| **More connectors** (Slack, Linear, Jira, Notion databases, Canva, Airtable…) | The `CONNECTORS` registry + OAuth/MCP framework is generic — each new connector is mostly config + scopes | Small per connector |
| **Multi-chat "team" broadcast** (extend pane broadcast mode to chat sessions) | Mirrors existing broadcast UX for the newer surface | Medium |
| **Prompt/template library in chat** | QuickActions already store commands; generalize to reusable multi-turn prompt templates with variables | Small–Medium |
| **VRAM-aware model suggestions** | Free-VRAM probing exists; suggest quantization/repo based on detected VRAM for the market cards | Medium |
| **Custom themes / theme import** | The token system is already data-driven; let users import a theme JSON | Small |
| **Pop-out chats & panes into their own windows** | Tauri multi-window is proven in this codebase; power-user win | Medium |
| **Research-mode citation export** (BibTeX / markdown bibliography) | Source ledger already captures facts + excerpts | Small |
| **Automation run notifications + richer results view** | Runs are headless; notify on completion/failure and show a diff/summary | Small–Medium |
| **Onboarding tour for first run** | OnboardingBanner exists; a short guided tour (add project → open chat → schedule automation) reduces churn | Small |
| **Terminal UX upgrades** (find-in-terminal, per-pane tabs, split panes) | The PTY layer supports it; frontend work only | Medium |

---

## 11. Getting started

```bash
npm install                 # frontend deps
npm run tauri dev           # dev (first Rust compile takes 10–20 min)
npm test                    # frontend logic tests (vitest)
cd src-tauri && cargo test  # backend unit tests
npm run tauri build         # release bundle (Windows NSIS)
```

Docs live in **`AI CONTEXT/`** (`PRD.md` = product spec, `CONTRACT.md` = binding IPC contract, `AI_CONTEXT.md` = canonical code map, `BUG_LIST.md` = audit trail, `RELEASE.md` = release/update flow). Superpowers specs/plans live in **`docs/superpowers/`**.

---

*Written from a source-tree read on 2026-08-12. Line references were verified against the working tree at that time; re-check before acting on any single line number.*
