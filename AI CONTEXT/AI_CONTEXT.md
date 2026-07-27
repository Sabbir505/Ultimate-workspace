# Conduit — AI Context Document

**Last verified:** 2026-07-26  
**Branch:** `master`  
**Working tree:** The auto-updater (Tauri plugin-updater + GitHub Releases + `UpdateBanner`), the bundled Python runtime (`chat/python_runtime.rs` staged by `scripts/fetch-bundled-python.mjs`), and message attachments (`components/chat/MessageAttachments.tsx`) are all in place. Doc set has been consolidated under `AI CONTEXT/`. On 2026-07-26 the chat backend was split into focused submodules (see BUILD_LOG): `chat/mod.rs` 2306→622 lines (extracted `prompts`/`proto`/`dispatch`/`streaming`) and `chat/tools.rs` 2394→`tools/mod.rs` 1108 (extracted `tools/{search,generate,fs}`); pure-mechanical, no behavior change.

This document is the single source of truth for AI assistants working on this codebase. It is grounded in the actual source, not in PRD/BUILD_LOG summaries. When in doubt, trust this doc over the PRD.

---

## 1. What Conduit Is

A local-first, multi-pane desktop shell for AI coding agents. It does **not** implement its own agent loop — it orchestrates existing CLI binaries inside pseudo-terminals, and adds a separate direct-HTTP LLM "Chat" tab.

**Two interaction surfaces:**

| Surface | Mechanism | Key events |
|---|---|---|
| **Dev tab** (Agent panes) | Spawn harness CLIs in PTYs, resume by session ID | `pty:output`, `pty:state`, `pty:exit`, `session:harness-id`, `cost:updated`, `browser:url_detected` |
| **Chat tab** (Direct LLM) | HTTP/SSE to Anthropic/OpenAI/OpenRouter/compatible providers; tool calling | `chat:token`, `chat:done`, `chat:error`, `chat:artifact`, `chat:open-browser` |

**Stack:** Tauri v2 (Rust) + React 18/TypeScript + Zustand + xterm.js + SQLite (rusqlite) + window-vibrancy (acrylic on Win, frosted on macOS)

---

## 2. Backend (`src-tauri/src`)

### 2.1 Entry Point (`lib.rs`)

- **Managed states:** `DbState` (SQLite behind `Mutex`), `PtyState` (`PtyManager`), `BrowserState` (`BrowserManager`), `ChatState` (`ChatManager`)
- **Plugins:** dialog, notification, fs, opener, updater
- **Boot sequence:** open `<app_data_dir>/conduit.db` → sweep expired artifacts (30-day retention) → register Python runtime resource dir → apply window vibrancy → register 78 commands
- **Exit cleanup** (`ExitRequested` / `Exit`): `kill_all()` PTYs, `close_all()` browsers, `cancel_all()` chat streams

### 2.2 Command Surface (80 registered in `lib.rs`)

```
Projects/sessions:   list_projects, add_project, remove_project, rename_project,
                     init_git_repo, list_sessions, create_session, update_session_title,
                     delete_session, touch_session
PTY/harnesses:       spawn_agent_session, spawn_shell, write_pty, resize_pty, kill_pty,
                     list_harnesses, run_harness_login
Browser:             browser_create, browser_navigate, browser_push_state, browser_action_result,
                     browser_go_back, browser_go_forward, browser_reload, browser_set_bounds,
                     browser_set_visible, browser_close, browser_close_pane
Git:                 get_git_status, create_worktree, get_git_diff
Settings/skills/etc: get_setting, set_setting, list_skills, create_skill, update_skill,
                     delete_skill, list_quick_actions, create_quick_action, update_quick_action,
                     delete_quick_action, set_secret, delete_secret, list_secret_keys,
                     get_cost_events, get_cost_rollups, export_session_markdown, read_file_text
Installed skills:    list_installed_skills, list_installed_loops, read_installed_skill,
                     save_installed_skill, create_installed_skill, delete_installed_skill
Chat:                list_chat_sessions, create_chat_session, delete_chat_session,
                     update_chat_session_title, generate_chat_title, set_chat_session_starred,
                     set_chat_session_unread, update_chat_session_model, get_chat_messages,
                     touch_chat_session, send_chat_message, cancel_chat_message,
                     set_chat_api_key, delete_chat_api_key, get_chat_config, list_chat_models,
                     read_artifact_preview, download_artifact, download_artifacts_zip,
                     list_artifacts, list_chat_artifacts, delete_artifact
Updater:             check_for_update, download_and_install_update
```

### 2.3 Events (backend → frontend)

| Event | Payload | Emitted from |
|---|---|---|
| `pty:output` | `{ paneId, data }` | `pty/mod.rs` reader thread |
| `pty:exit` | `{ paneId, code }` | `pty/mod.rs` waiter thread |
| `pty:state` | `{ paneId, state }` | `pty/mod.rs` monitor thread |
| `session:harness-id` | `{ sessionId, harnessSessionId }` | `pty/mod.rs` (regex or filesystem probe) |
| `cost:updated` | `{ sessionId }` | `pty/mod.rs` (usage sync) |
| `browser:url_detected` | `{ paneId, url }` | `pty/mod.rs` (local URL scan in terminal output) |
| `browser:navigated` | `{ paneId, tabId, url }` | `browser.rs` + `commands/browser_cmds.rs` |
| `chat:token` | `{ chatSessionId, token }` | `chat/mod.rs` (SSE stream) |
| `chat:done` | `{ chatSessionId, inputTokens, outputTokens, costUsd }` | `chat/mod.rs` |
| `chat:error` | `{ chatSessionId, message, code }` | `chat/mod.rs` |
| `chat:artifact` | `{ chatSessionId, path, filename }` | `chat/mod.rs` |
| `chat:open-browser` | `{ chatSessionId, url }` | `chat/mod.rs` (from `open_url` tool) |
| `updater:progress` | `{ downloaded, total }` (`total` may be null) | `commands/updater_cmds.rs` (download stream) |
| `updater:installed` | `{}` | `commands/updater_cmds.rs` (post-install, app restarts) |

### 2.4 PTY Subsystem (`pty/mod.rs`)

- **Per pane:** writer thread (mpsc → PTY master), reader thread (raw bytes → `pty:output` + stripped transcript + local URL scan), waiter thread (`try_wait()` → `pty:exit`)
- **State heuristic** (200ms monitor): output → `working`; 1.5s silence → `waiting`; diff-prompt regex match → `diff_ready`; fresh spawn → `idle`
- **Session-id probe:** 120s post-spawn, polls harness on-disk session store every second
- **Usage sync:** every 5s, reads cumulative usage from harness logs, records deltas
- **Kill:** `taskkill /T /F` (Win) then `kill()`; idempotent via `AtomicBool`

### 2.5 Harness Adapters (`harness_adapters/`)

| Adapter | Binary | New | Resume | Session ID | Usage | Diff patterns |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | bare | `--resume <id>` | TUI regex + `~/.claude/projects/<slug>/*.jsonl` probe | `.jsonl` parse | "Do you want to make/apply/proceed this edit" |
| Kimi Code | `kimi` | bare | `--session <id>` | TUI regex + `~/.kimi-code/session_index.jsonl` | `wire.jsonl` parse | — |
| OpenCode | `opencode` | bare | `-s <id>` | TUI regex only (no filesystem probe) | None (PTY scrape fallback) | — |

**Registry:** static `Lazy<HashMap>` in `mod.rs` mapping `"claude_code"`, `"kimi_code"`, `"opencode"`.

### 2.6 Chat Subsystem (`chat/`)

- **Core prompt:** lives in `chat/prompts.rs` — `core_prompt_base()`, `core_prompt_strict()` (appended for local models), `core_prompt_for(provider, model)`, `is_research_request()`, `build_system_prompt()`. `mod.rs` re-exports `build_system_prompt` + `is_research_request`. Tool names must match the `tools/mod.rs` registry.
- **Providers:** `Anthropic`, `OpenAI`, `AnthropicCompatible`, `OpenAICompatible`, `OpenRouter` (`chat/providers.rs`)
- **Tool loop (`chat/streaming.rs`):** OpenAI-style (`run_openai_tool_loop`) and Anthropic-style (`run_anthropic_tool_loop`), capped at `MAX_TOOL_ITERS = 45` (non-research) / `RESEARCH_MAX_TOOL_ITERS = 96` (research turns). Each call streams one round (`openai_stream_round`/`anthropic_stream_round`), then runs tool calls and feeds results back until a final answer or the cap. Hermes XML `<tool_calls>` fallback parser (in `chat/proto.rs`) recovers tool calls emitted as plain text by aggregators that don't translate the `tools` field. Wire-protocol helpers (`parse_tool_args`, `parse_hermes_tool_calls`, `strip_hermes_tool_calls`, `tool_block`, `openai_message_json`/`anthropic_message_json`, `next_synthetic_tool_id`) live in `chat/proto.rs`; tool dispatch (`run_tool`, `run_gated_fs_tool`, `run_browser_tool`, `run_ledger_tool`, `emit_token`, `artifacts_dir`) in `chat/dispatch.rs`.
- **Tools (19):** `web_search`, `generate_file`, `generate_document`, `generate_diagram`, `fetch_url`, `run_code`, `open_url`, `browser_read` (modes: `full`/`summary_only`/`section`, structured Markdown + metadata + failure reasons), `browser_click`, `browser_type`, `browser_scroll`, plus the filesystem set `list_directory`, `read_file`, `search_files` (read-only), `write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file` (mutating).
- **Tool caps:** `ToolCaps { code_exec, fs_roots }` — `code_exec` is gated per-chat; `fs_roots` is the per-session granted-root set for the auto-run permission modes. Everything else is on when tools enabled.
- **Permission gate (`permission.rs`):** the single `check_permission(mode, tool, path, fs_roots) -> AutoRun|NeedsApproval` function every filesystem tool routes through. `PermissionMode` ∈ `read_only`/`manual`/`auto_edit`/`full_auto` (per-session, on `chat_sessions.permission_mode`, default `manual`). Hard rules enforced here, not in UI copy: reads auto-run in every mode; `delete_file` is **always** gated (every mode); `read_only` strips mutating tools from the tool schema entirely (schema-level exclusion — the model literally cannot call `write_file`); `auto_edit`/`full_auto` auto-run writes/edits within granted roots; `auto_edit` also gates move/copy while `full_auto` auto-runs them. `run_tool` calls this before executing; `NeedsApproval` registers a pending approval + emits `chat:approval-request` and **pauses the turn** on a oneshot until the UI calls `resolve_tool_action(pendingId, approved)`.
- **Code exec:** `codeexec.rs` — python/js/bash in fresh temp dir, 20s timeout, NOT a hard sandbox
- **Python runtime:** `python_runtime.rs` — resolves a bundled python-build-standalone interpreter shipped in the installer's `resource_dir/python` (staged by `scripts/fetch-bundled-python.mjs`). Used by `pygen.rs` (doc gen) and `codeexec.rs` (code exec); degrades silently to system Python when not bundled (e.g. `cargo run` from source). Registered at boot in `lib.rs`.
- **Document gen:** `pygen.rs` (Python-backed docx/pptx/xlsx/pdf via python-docx/python-pptx/openpyxl/reportlab, 90s timeout) + `artifacts.rs` (hand-rolled minimal OpenXML/PDF)
- **Office preview:** `office.rs` — renders docx/pptx/xlsx to self-contained HTML; also extracts text for attachments

### 2.7 Browser Webviews (`browser.rs`)

- **Native child webviews** via `Window::add_child` (Windows/macOS only; Linux → iframe fallback)
- **Label scheme:** `browser-{paneId}-tab-{tabId}`
- **pushState monkey-patch:** injected JS wraps `history.pushState`/`replaceState` + `popstate`/`hashchange` → `browser_push_state`
- **Agentic browser:** `read_page` uses a vendored Mozilla `readability.js` (Apache 2.0, v0.6.0, embedded via `include_str!`) to extract clean Markdown via the `bridge_extract.js` wrapper. Supports **four** modes: `full` (complete cleaned article), `summary_only` (headings + first ~1500 chars), `section` (CSS selector or heading text), and `interactive` (accessibility tree — full a11y records per element: role, aria-label, name, id, value, placeholder, checked, disabled, type, rect; no Readability run, markdown empty). Consent/cookie banners are auto-dismissed; lazy-loaded content is surfaced via a bounded scroll loop. Returns structured JSON (`ExtractedContent`) with `markdown`, `title`, `url`, `canonicalUrl`, `publishedDate`, `byline`, `failureReason`, and `elementRefs`. Interactive elements are tagged with `data-conduit-ref` for `browser_click`/`browser_type`. 15s timeout per eval; `ReadOpts` controls settle wait (default 1s) and max scroll steps (default 4).
- **Agent-driven control (conduit-browser-mcp):** a standalone MCP server binary (`src/bin/conduit_browser_mcp.rs`, `[[bin]]` in Cargo.toml, does NOT link Tauri) speaks stdio JSON-RPC to a harness (Claude Code/Kimi Code) and forwards each `tools/call` over a **loopback WebSocket on fixed port 7681** (`BROWSER_MCP_PORT`) to `browser_mcp::serve` (spawned in `lib.rs` setup). Dispatch (`browser_mcp.rs`) runs against the real visible pane via `run_action_for_pane` / `read_page_for_pane` / `resolve_and_click` / `resolve_and_type` — the SAME eval bridge the chat tools use. Six tools: navigate / read_page / click / type_text / scroll / wait_for, all with optional `pane_id`. Pane resolution: explicit pane_id → `pane_active_tab` → label; else `project_id` → `browser:resolve-pane-request` frontend roundtrip (max-`lastUsedAt` browser pane, 5s) → global active. Auto-open: `browser:open-browser-request` roundtrip. Per-project registration via `--mcp-config` (Claude Code; `browser_mcp_register.rs` writes to `<app_data_dir>/mcp/<id>.mcp.json` in `spawn_agent_session`). Frontend hook `useBrowserMcpEvents.ts`. Structured error codes: not_found/nav_failure/timeout/browser_unavailable/invalid_args/pane_not_found.
- **Visual feedback layer:** `bridge_overlay.js` (injected after every nav + lazily per action) installs synthetic cursor/ripple/highlight/caret elements (all `data-conduit-overlay`, excluded from the a11y tagger). `click_js`/`type_js` return Promises: cursor tween (400ms) → highlight → ripple / per-keystroke typing (45ms±15ms with real keydown/keyup/input per char) → real action. `action_wrapper_js` is promise-aware (awaits a returned thenable) and applies watch-mode pacing (600ms) via a `__finish` helper — the tool result reports only after the visual+action chain resolves (race guard). Watch-mode: global `watchMode` setting + per-session nullable `watch_mode` column (mirrors `permission_mode`); backgrounded panes skip pacing (`pane_is_visible`).
- **Known open issue:** `run_action_for_pane`'s result reporting is intermittent against `browser-*` child webviews — `navigate` (tiny body) sometimes returns empty, and `read_page` (large bridge body) times out at 15s. `__TAURI_INTERNALS__.invoke('browser_action_result')` reachability in the child webview needs a devtools check; the `browser_action_result` custom command may need explicit capability allowance for `browser-*` windows.

### 2.8 DB Schema (`db/mod.rs`)

10 tables:

| Table | Key columns |
|---|---|
| `projects` | `id` PK, `path` UNIQUE, `name`, `is_git_repo`, `created_at`, `last_opened_at` |
| `sessions` | `id` PK, `project_id` FK, `harness`, `harness_session_id`, `title`, `worktree_path`, `created_at`, `last_active_at`, `status` |
| `cost_events` | `id` AUTOINCREMENT, `session_id` FK, `timestamp`, `input_tokens`, `output_tokens`, `estimated_cost_usd` |
| `skills` | `id` PK, `name`, `slash_command` UNIQUE, `content`, `scope`, `created_at` |
| `project_secrets` | `project_id` + `key` composite PK, `value_encrypted` BLOB |
| `app_settings` | `key` PK, `value` |
| `quick_actions` | `id` PK, `project_id` FK, `label`, `command`, `keybinding`, `run_on_worktree` |
| `chat_sessions` | `id` PK, `title`, `provider`, `model`, `created_at`, `last_active_at`, `starred`, `unread`, `permission_mode` (DEFAULT 'manual') |
| `chat_messages` | `id` AUTOINCREMENT, `chat_session_id` FK (CASCADE), `role`, `content`, `input_tokens`, `output_tokens`, `cost_usd`, `created_at` |
| `artifacts` | `id` PK, `chat_session_id`, `chat_message_id`, `filename`, `path`, `kind`, `created_at`, `expires_at` |

**Migrations:** `migrate_chat_session_flags` (adds `starred`/`unread`), `migrate_chat_session_permission_mode` (adds `permission_mode`, backfills NULL→`manual`), `migrate_artifacts_message_id`, `migrate_unc_paths` (Win only, strips `\\?\` prefix).

### 2.9 Secrets (`secrets.rs`)

- Windows/macOS: OS keychain via `keyring` crate
- Linux: XOR-obfuscated SQLite fallback (documented deviation from PRD)

### 2.10 Auto-Updater (`commands/updater_cmds.rs`)

- **Plugin:** `tauri-plugin-updater` — configured in `tauri.conf.json` with a GitHub Releases endpoint and a baked-in public key for signature verification. Signing keypair lives at `.tauri/conduit-update.key` / `.key.pub` (gitignored).
- **Commands (2):** `check_for_update` → `UpdateInfo { updateAvailable, version, notes, pubDate }` (GETs `latest.json`, semver compare; network failure treated as "no update"); `download_and_install_update` → downloads, verifies signature, installs; emits `updater:progress` during download and `updater:installed` when the verified package is on disk (app restarts automatically).
- **Frontend:** `state/updater.ts` — Zustand store (`update`, `downloaded`, `total`, `error`, `checking`, `installing`); `wireUpdaterEvents()` hooks the two events. `components/onboarding/UpdateBanner.tsx` — banner with changelog + download/restart button. Bootstrapped in `App.tsx` via `wireUpdaterEvents()` + `check()`, re-checks every 4 hours. Windows install is passive (progress bar, no dialog gauntlet).
- **Release tooling:** `scripts/make-latest-json.mjs` produces the `latest.json` manifest (semver + signature + notes) uploaded alongside each GitHub Release. See `RELEASE.md`.

### 2.11 Bundled Python Runtime (`chat/python_runtime.rs`)

- Resolves a bundled `python-build-standalone` interpreter shipped in the installer's `resource_dir/python`, pre-installed with `python-docx`, `python-pptx`, `openpyxl`, `reportlab` so docx/pptx/xlsx/pdf generation works without a system Python.
- Used by `pygen.rs` (document generation) and `codeexec.rs` (code execution). Output path passed via `CONDUIT_OUTPUT` env var.
- Staged at build time by `scripts/fetch-bundled-python.mjs` into `src-tauri/resources/python/` (gitignored, ~70 MB). Degrades silently to system Python when not bundled.
- Initialized at app startup (`lib.rs` registers the resource dir).

### 2.12 Safety Notes

- **No `unsafe` blocks** anywhere in the Rust codebase
- **No TODO/FIXME/HACK/XXX** anywhere
- **Pane processes killed** on explicit pane close, LRU replacement (when all 6 slots are full — the evicted pane's pty is terminated), or app quit — never on blur (PRD §6.5)
- **Nothing auto-resumes on relaunch** — click a session to resume-by-ID
- **Code exec is NOT a hard sandbox** — runs with app privileges

---

## 3. Frontend (`src`)

### 3.1 Entry (`main.tsx` → `App.tsx`)

- Bootstrap loads: `settingsStore.load()` → `projectsStore.loadAll()` → `skillsStore.load()` → `ensureDefaultSkills()` → `wireUpdaterEvents()` + `updaterStore.check()` (also re-checks every 4h via `setInterval`)
- **Active views:** `"grid"` (Dev panes), `"chat"` (Chat), `"settings"`, `"skills"`, `"cost"`
- **Sidebar modes:** `"projects"` (Dev) / `"chats"` (Chat)
- Hooks registered: `useTheme`, `useKeybindings`, `usePtyEvents`, `useChatEvents`, `useGitStatusPolling`

### 3.2 State (Zustand)

| Store | Key state | Key actions |
|---|---|---|
| `projects.ts` | `projects[]`, `sessions[]`, `gitStatuses`, `harnesses[]`, `selectedProjectId` | `loadAll`, `addProjectAtPath`, `createSessionFor`, `refreshGitStatus` (polls all projects) |
| `panes.ts` | `panes[]` (max 6 visible), `focusedPaneId`, `broadcast`, `useCounter`, `focusEpoch` | `addPane`, `closePane` (→ `disposePaneResources` → `killPty`/`browserClosePane`), `focusPane`, `setSpotlight`, multi-tab browser |
| `chat.ts` | `sessions[]` (incl. `permissionMode`), `activeChatSessionId`, `messages[]`, `loaded`, `streamingChatSessionId`, `config`, `error`, `effort`, `toolsEnabled`, `codeExecEnabled`, `artifacts`, `artifactsByMessage`, `pendingArtifacts`, `previewArtifact`, `pendingApprovals`, `fullAutoConfirmingFor` | `sendMessage` (double-send guard), `onToken`, `onDone` (auto-title after 1st & 3rd turn), `onArtifact`, `onError`, `onApprovalRequest`/`onApprovalResolved`, `setSessionPermissionMode` (full_auto → one-time modal), `confirmFullAuto`/`cancelFullAutoConfirm`, `resolveApproval`, `cancelStream`, `regenerateLast`, `setPreviewArtifact` |
| `artifacts.ts` | `items[]` (ArtifactRecord) | `load`, `remove` |
| `skills.ts` | `skills[]` (Conduit prompt templates) | CRUD |
| `settings.ts` | `theme`, `dnd`, `keybindings`, `browserUrls` | `load`, `setTheme`, `setDnd`, `setKeybinding`, `lastBrowserUrl`, `rememberBrowserUrl` |
| `ui.ts` | `activeView`, `paletteOpen`, `peek`, `pendingReplace` | `setActiveView`, `togglePalette`, `openPeek`, `setPendingReplace` |
| `updater.ts` | `update`, `downloaded`, `total`, `error`, `checking`, `installing` | `check` (every 4h), `startInstall`, `dismiss`, `reset`; `wireUpdaterEvents()` |

**Spotlight logic** (pure functions in `state/spotlight.ts`): `activeTerminalId` (override wins, else recency), `cycleTerminalId`, `activeTerminalPair` (top+bottom), `cycleTerminalPair`.

### 3.3 Panes (`components/panes/`)

- **PaneGrid.tsx** — 3 layout modes: grid (2-col CSS), split (spotlight terminals stacked left + browser right, hidden terminals stay mounted `display:none`), chat-split (chat left + browser right). Memoized `PaneFrame`.
- **TerminalPane.tsx** — xterm with transparent bg (glass shows through), theme-aware, copy/paste (Ctrl+Shift+C/V), font zoom (Ctrl+scroll), `focusEpoch` re-focus, resume-on-exit overlay. ResizeObserver + debounced refit (50ms).
- **BrowserPane.tsx** — native webview path (bounds tracking + occlusion via `browserOcclusion.ts`) + iframe fallback. Per-tab history, 8s load timeout. Tab bar + URL bar.
- **BroadcastBar.tsx** — literal text fan-out to selected terminals (no skill expansion).

### 3.4 Chat UI (`components/chat/`)

- **ChatView.tsx** — flex column: scrollable messages + composer. Smart auto-scroll (80px threshold). `ArtifactsMenu` in toolbar. `has-preview` split when `previewArtifact` set.
- **ChatComposer.tsx** — Claude-style card. Attachments: images ≤5MB, docs ≤10MB, text ≤512KB. Enter sends, Shift+Enter newline. Auto-grow textarea (max 200px). `ModelEffortMenu` + `PermissionModeMenu`. Card gets a colored border/glow (`.composer-mode-*`) whenever a non-`manual` posture is active.
- **PermissionModeMenu.tsx** — glass dropdown (matches `ModelEffortMenu`) listing the four postures; the trigger dot/border tint per mode so the active posture is visible at a glance. Switching INTO `full_auto` does NOT apply here — `chat.ts` opens the one-time `FullAutoConfirmModal`.
- **ApprovalFlow.tsx** — `ApprovalCard` (per-action Approve once/Deny card rendered above the composer when `check_permission` gates a call) + `FullAutoConfirmModal` (one-time full_auto confirmation, with copy stating deletes remain gated).
- **MessageAttachments.tsx** — renders attached images/docs under a message bubble; image thumbnails + file chips with size/type.
- **MessageBubble.tsx** — parses `<think>` and `<tool>` segments. `ThinkingBlock` (collapsible), `ToolBlock` (emoji glyph per kind), Markdown via `react-markdown` + `remarkGfm`, Mermaid via `MermaidDiagram`, JSX via `JsxArtifactChip` (opens `JsxPreview` in pane). Hover actions: Copy/Edit/Regenerate.
- **MermaidDiagram.tsx** — lazy-loads `mermaid`, debounced render (250ms), theme-aware, `normalizeSvg()` strips solid backgrounds.
- **InlineDiagram.tsx** — sandboxed iframe sized to diagram intrinsic height, scaled to chat width. `ArtifactExportMenu`.
- **JsxPreview.tsx** — Babel transpile in sandboxed iframe (`allow-scripts` only). Tries `export default`, then global names (App, Example, Demo, Main, Component).
- **ArtifactPreviewPane.tsx** — right-side preview, draggable resizer (min 320px), zoom 25%-300%, transform-scale. Handles image/pdf/markdown/office/html/diagram/csv/code/json/text/binary.
- **ArtifactExportMenu.tsx** — Copy PNG, Download PNG, Download SVG. Smart background detection. Variants: `"toolbar"` and `"kebab"`.

### 3.5 Sidebar & Overlays

- **Sidebar.tsx** — Dev mode (projects + sessions) / Chat mode (new chat + artifact library + session rows). Footer toggles Skills/Cost/Settings.
- **ProjectItem.tsx** — Git status badge, inline rename, session list, harness chooser, context menu (new session, new worktree, peek diff, settings, rename, remove).
- **SessionRow.tsx** — Live state dot, auto title, harness badge, relative time, delete.
- **ArtifactLibrary.tsx** — Visual cards + file list, search, 30-day retention indicator.
- **CommandPalette.tsx** — Fuzzy search across sessions, projects, actions. Cmd+K.
- **PeekPanel.tsx** — File mode (`readFileText`) / Diff mode (`getGitDiff` + `parseUnifiedDiff`).
- **CostDashboard.tsx** — Hand-rolled SVG bar chart (14 days) + per-project table.
- **SettingsView.tsx** — 6 categories: Appearance, Assistant (custom prompt + skills), Pricing, Harnesses, Shortcuts, API Keys.

### 3.6 IPC (`lib/ipc.ts`)

- `safeInvoke` / `safeListen` — no-op outside Tauri (jsdom tests, plain `vite dev`)
- All commands grouped by subsystem (projects, PTY, browser, git, settings, chat, artifacts, installed skills)
- Updater IPC: `UpdateInfo` / `UpdateProgressPayload` interfaces, `checkForUpdate()`, `downloadAndInstallUpdate()`, `listenUpdaterProgress()`, `listenUpdaterInstalled()`
- `ChatProvider` union: `"anthropic" | "openai" | "openrouter" | "anthropic_compatible" | "openai_compatible"`
- `ChatSession` interface includes `starred?: boolean`, `unread?: boolean`

### 3.7 Key Libraries

| File | Purpose |
|---|---|
| `lib/id.ts` | `uuid()` — `crypto.randomUUID()` with jsdom fallback |
| `lib/sessionTitle.ts` | `generateSessionTitle()` — 40-char truncation at word boundary |
| `lib/skillExpansion.ts` | `expandSkillCommand()` — `/command` → skill content |
| `lib/diff.ts` | `parseUnifiedDiff()` — git diff → typed hunks |
| `lib/fuzzy.ts` | `fuzzyScore()` / `fuzzyFilter()` — subsequence matching with bonuses |
| `lib/keybindings.ts` | 14 actions, `parseAccelerator()`, `matchesAccelerator()`, `acceleratorFromEvent()` |
| `lib/browserHistory.ts` | `BrowserHistory` stack, `normalizeUrl()` (Bing search fallback) |
| `lib/browserOcclusion.ts` | `browserOccluded()` — when to hide native webviews |
| `lib/defaultSkills.ts` | 4 built-in skills embedded via Vite `?raw` (docx, pptx, pdf, diagram) |
| `lib/sessionLauncher.ts` | `openSession()`, `newSessionFlow()`, `runQuickAction()`, `respawnPane()` |
| `lib/exportSession.ts` | `exportFocusedSession()` — markdown export via save dialog |

### 3.8 Tests (`src/test/`)

14 vitest files: panes, spotlight, fuzzy, browserOcclusion, sessionTitle, browserHistory, skillExpansion, keybindings, keybindingPhase.repro, focusPaneShortcuts.repro, paneDomFocus.repro, artifactCardThumb, inlineDiagramGating, messageAttachments.

---

## 4. Documentation Gaps (Verified Against Source)

These are confirmed discrepancies between the docs and the current implementation. Fix them when editing docs.

| Gap | Where | Current truth |
|---|---|---|
| `openrouter` missing from `ChatProviderId` | `CONTRACT.md` line 11 | `ChatProviderId` in Rust has 5 variants including `OpenRouter`; frontend `ipc.ts` has `"openrouter"` |
| `starred`/`unread` missing from `ChatSession` | `CONTRACT.md` line 115 | Both fields exist in DB schema, Rust `types.rs`, and frontend `ipc.ts` |
| `browser:url_detected` event missing | `CONTRACT.md` Events section | Emitted by `pty/mod.rs` (local URL scan); frontend `usePtyEvents.ts` listens and opens browser pane |
| `list_chat_artifacts` command missing | `CONTRACT.md` Chat section | Registered in `lib.rs` line 167; used by frontend chat store |
| `generate_chat_title` command missing | `CONTRACT.md` Chat section | Registered in `lib.rs` line 151 |
| `set_chat_session_starred`/`unread` missing | `CONTRACT.md` Chat section | Registered in `lib.rs` lines 152-153 |
| PRD §14 says "only two harnesses required for v1" | `PRD.md` line 541 | Three harnesses are implemented: claude_code, kimi_code, opencode |

---

## 5. Known Open Items

From BUILD_LOG.md and source inspection:

1. **Manual verification pending:** native webview rendering (HiDPI, splitter drags, occlusion, Linux iframe fallback) — BUILD_LOG 2026-07-18
2. **Placeholder app icon:** `src-tauri/icons/icon.ico` is a minimal 32x32 PNG-in-ICO — needs replacement before release
3. **Quick-action custom keybindings:** stored in DB but not globally registered as OS-level shortcuts
4. **Kimi cross-attribution risk:** two panes in same cwd within probe window can attribute the same session_index entry
5. **Linux secrets:** XOR-obfuscated fallback, not true encryption

---

## 6. File Map (Key Files by Concern)

| Concern | Files |
|---|---|
| Backend entry | `src-tauri/src/lib.rs`, `src-tauri/src/main.rs` |
| PTY lifecycle | `src-tauri/src/pty/mod.rs` |
| Harness adapters | `src-tauri/src/harness_adapters/{mod,claude_code,kimi_code,opencode}.rs` |
| Chat core | `src-tauri/src/chat/{mod,commands,providers,python_runtime}.rs` |
| Chat prompt/stream/dispatch/proto | `src-tauri/src/chat/{prompts,streaming,dispatch,proto}.rs` |
| Chat tools (registry + impl) | `src-tauri/src/chat/tools/{mod,specs,search,generate,fs}.rs` |
| Chat tools impl (other) | `src-tauri/src/chat/{codeexec,office,pygen,artifacts}.rs` |
| Auto-updater | `src-tauri/src/commands/updater_cmds.rs`, `src/state/updater.ts`, `src/components/onboarding/UpdateBanner.tsx` |
| Bundled Python | `src-tauri/src/chat/python_runtime.rs`, `scripts/fetch-bundled-python.mjs` |
| Browser webviews | `src-tauri/src/browser.rs`, `src-tauri/src/commands/browser_cmds.rs` |
| DB schema | `src-tauri/src/db/mod.rs` |
| DB queries | `src-tauri/src/db/{projects,chat,cost,artifacts,settings,skills,secrets}.rs` |
| Git helpers | `src-tauri/src/git.rs`, `src-tauri/src/commands/git_cmds.rs` |
| Secrets | `src-tauri/src/secrets.rs` |
| Frontend entry | `src/main.tsx`, `src/App.tsx` |
| State stores | `src/state/{projects,panes,chat,artifacts,skills,settings,ui,updater,spotlight}.ts` |
| Pane components | `src/components/panes/{PaneGrid,TerminalPane,BrowserPane,BroadcastBar}.tsx` |
| Chat components | `src/components/chat/{ChatView,ChatComposer,MessageAttachments,MessageBubble,MermaidDiagram,InlineDiagram,JsxPreview,ArtifactPreviewPane,ArtifactsMenu,ArtifactExportMenu,ModelEffortMenu,ChatSessionRow}.tsx` |
| Sidebar | `src/components/sidebar/{Sidebar,ProjectItem,SessionRow,ArtifactLibrary}.tsx` |
| Overlays | `src/components/{command-palette/CommandPalette,peek/PeekPanel,onboarding/OnboardingBanner,onboarding/UpdateBanner,cost-dashboard/CostDashboard,settings/SettingsView,skills-library/SkillsLibrary,common/Modal,common/GlassSelect}.tsx` |
| IPC | `src/lib/ipc.ts` |
| Utilities | `src/lib/{id,sessionTitle,skillExpansion,diff,fuzzy,keybindings,browserHistory,browserOcclusion,defaultSkills,sessionLauncher,exportSession}.ts` |
| Hooks | `src/hooks/{usePtyEvents,useChatEvents,useGitStatusPolling,useTheme,useKeybindings}.ts` |
| Tests | `src/test/*.{ts,tsx}` |
| Built-in skills | `skills/{docx-skill,pptx-skill,pdf-skill,diagram-html-svg-skill,conduit-chat-system-prompt}.md` |
| Config | `src-tauri/tauri.conf.json`, `vite.config.ts`, `tsconfig.json`, `index.html` |
| Docs | `AI CONTEXT/{README,PRD,CONTRACT,BUILD_LOG,RELEASE,AI_CONTEXT}.md` |
