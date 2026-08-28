# IPC Contract (binding for both Rust backend and React frontend)

> **Naming note:** The product is "Relay" in user-visible surfaces (window title, `package.json`, `tauri.conf.json` `productName`, `<title>`) as of commit `e9abc7c3` (2026-08-27). The Rust crate is still `conduit`; the bundle identifier is still `dev.conduit.app`. The contract itself is unchanged. See `README.md` and `AI CONTEXT/RELEASE.md`.

All Tauri commands are invoked from the frontend with `invoke('<command_name>', { args })`.
All structs serialized over IPC use **camelCase** field names (Rust: `#[serde(rename_all = "camelCase")]`).
IDs are UUID strings. Timestamps are Unix epoch **seconds** (i64).

## Types

```ts
type HarnessId = 'claude_code' | 'kimi_code' | 'opencode';
type ChatProviderId = 'anthropic' | 'openai' | 'openrouter' | 'anthropic_compatible' | 'openai_compatible' | 'local_gguf';
type PaneState = 'idle' | 'working' | 'waiting' | 'diff_ready';
type ChatAgent = 'builtin' | 'local' | `harness:${HarnessId}`;

interface Project { id: string; path: string; name: string; isGitRepo: boolean; createdAt: number; lastOpenedAt: number | null }
interface SessionRecord { id: string; projectId: string; harness: HarnessId; harnessSessionId: string | null; title: string | null; worktreePath: string | null; createdAt: number; lastActiveAt: number; status: string }
interface HarnessStatus { id: HarnessId; displayName: string; installed: boolean }
interface GitStatusInfo { isRepo: boolean; branch: string | null; dirty: boolean; ahead: number; behind: number }
interface ChangedFile { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' }
interface Skill { id: string; name: string; slashCommand: string; content: string; scope: string; createdAt: number } // scope = 'global' or a project id
interface QuickAction { id: string; projectId: string; label: string; command: string; keybinding: string | null; runOnWorktree: boolean }
interface CostEvent { id: number; sessionId: string; timestamp: number; inputTokens: number | null; outputTokens: number | null; provider: string | null; modelKey: string | null; source: string; cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null; reasoningOutputTokens: number | null; reportedCostUsd: number | null; pricingEstimatedUsd: number | null }
interface CostRollups {
  totals: { rawTokenCostUsd: number; providerReportedUsd: number; estimatedUsd: number; unpricedUsd: number };
  perProvider: Array<{ provider: string; costUsd: number; tokens: number; sharePct: number }>;
  daily: Array<{ day: string; costUsd: number; tokensByProvider: Record<string, number> }>;
  byKind: { processedTokens: number; cachedInputTokens: number; uncachedInputTokens: number; outputTokens: number; reasoningTokens: number; sessions: number; responses: number };
  perModel: Array<{ modelKey: string; displayName: string; costUsd: number; sharePct: number; tokens: number; provider: string | null }>;
  costQuality: { providerReportedPct: number; modelPricedPct: number; unpricedPct: number; cacheSavingsUsd: number };
  perProject: Array<{ projectId: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }>;
  rangeStart: string; rangeEnd: string; rangeDays: 7 | 30 | 90;
} // day = 'YYYY-MM-DD'
interface Automation { id: string; name: string; prompt: string; harness: 'claude_code' | 'opencode'; model: string; cwd: string; schedule: string; enabled: boolean; lastRunAt: number | null; lastStatus: string | null; chatSessionId: string | null; createdAt: number }
interface AutomationInput { name: string; prompt: string; harness: 'claude_code' | 'opencode'; model?: string; cwd?: string; schedule: string; enabled?: boolean }
interface AutomationRun { id: string; automationId: string; startedAt: number; finishedAt: number | null; status: string; summary: string; chatSessionId: string | null; source: 'scheduled' | 'manual' }
interface HarnessModelInfo { id: string; label: string; source: 'config' | 'cli' | 'builtin' }
interface HarnessModelConfig { defaultModel: string | null; endpoint: string | null; models: HarnessModelInfo[] }
interface WorkspaceRecord { id: string; projectId: string; name: string; data: string; createdAt: number; updatedAt: number }
```

## Commands

Projects / sessions:
- `list_projects() -> Project[]` (ordered by lastOpenedAt desc, nulls last)
- `add_project(path: string) -> Project` (inserts or returns existing; detects git repo; updates lastOpenedAt)
- `remove_project(projectId: string) -> ()` (also removes its sessions/cost events)
- `rename_project(projectId: string, name: string) -> ()`
- `init_git_repo(projectId: string) -> ()` (runs `git init` in project path, sets isGitRepo)
- `list_sessions(projectId?: string) -> SessionRecord[]` (most recent first; omit for all projects)
- `create_session(projectId: string, harness: HarnessId) -> SessionRecord`
- `update_session_title(sessionId: string, title: string) -> ()`
- `delete_session(sessionId: string) -> ()`
- `touch_session(sessionId: string) -> ()` (sets lastActiveAt = now)

PTY (paneId is a frontend-generated UUID per pane slot):
- `spawn_agent_session(paneId: string, sessionId: string) -> ()` — looks up session; spawns harness new-session command if `harnessSessionId` is null, else resume command. cwd = worktreePath ?? project.path. Also marks pane transcript buffer fresh and touches session.
- `spawn_shell(paneId: string, cwd: string, command: string, injectSecretsProjectId?: string) -> ()` — spawns a login shell running `command` (used for quick actions and login flows).
- `write_pty(paneId: string, data: string) -> ()`
- `resize_pty(paneId: string, cols: number, rows: number) -> ()`
- `kill_pty(paneId: string) -> ()` (SIGTERM then SIGKILL escalation)

Harnesses:
- `list_harnesses() -> HarnessStatus[]`
- `run_harness_login(paneId: string, harnessId: HarnessId, cwd: string) -> ()` (spawns login flow in that pane's pty)
- `list_harness_models(harnessId: HarnessId) -> HarnessModelConfig` — models/endpoint discovered in the CLI's own config files (`~/.claude/settings.json`, `~/.kimi-code/config.toml`, `~/.config/opencode/opencode.json`); per-model `source` = `"config"` | `"cli"` | `"builtin"`. Best-effort — empty/failed reads yield an empty list and the frontend falls back to the static catalog (`src/lib/harnessModels.ts`).

Headless CLI chat (chat sessions whose `agent` is `"harness:<id>"`; same `chat:token`/`chat:done`/`chat:error`/`chat:artifact` events as the built-in chat):
- `send_agent_chat_message(chatSessionId, content, harnessId, model?, cwd?, projectId?) -> ()` — spawns (or writes to) the headless CLI; claude uses a persistent process, kimi/opencode spawn per turn. The harness always runs at full-auto permission (`--dangerously-skip-permissions` for claude, `--auto` for opencode, kimi prompt mode auto-approves). The capture-and-resume CLI session id persists under `agent.cli_session_id.<harness>.<sid>` in `app_settings`.
- `cancel_agent_chat_message(chatSessionId) -> ()` — kills the in-flight CLI process; the next send respawns. Captured CLI session id is kept so context survives the cancel.

Git:
- `get_git_status(path: string) -> GitStatusInfo`
- `create_worktree(projectId: string, branchName: string) -> string` (returns worktree path; uses `git worktree add <path> -b <branch>`; path = sibling dir `<project>-<branch>` sanitized)
- `get_git_diff(path: string) -> string` (unified diff of working tree, capped ~200KB)
- `get_changed_files(path: string) -> ChangedFile[]` — per-pane file list for the Dev-tab Files panel (arg is the pane's actual cwd, worktree-aware)
- `get_git_file_diff(path: string, filePath: string) -> string` — per-file unified diff for the Files panel

Automations (scheduled headless agent runs; kimi excluded — `--yolo`/`--auto` are interactive-only):
- `list_automations() -> Automation[]`
- `create_automation(input: AutomationInput) -> Automation`
- `update_automation(automationId: string, input: AutomationInput) -> ()`
- `delete_automation(automationId: string) -> ()`
- `set_automation_enabled(automationId: string, enabled: boolean) -> ()`
- `run_automation_now(automationId: string) -> ()` — fire one run immediately on the same launch path the scheduler uses
- `list_automation_runs(automationId: string, limit?: number) -> AutomationRun[]` — newest-first, default cap 100
- `count_automation_runs(automationId: string) -> number` — sidebar list badge

Settings / skills / quick actions / secrets / cost:
- `get_setting(key: string) -> string | null`
- `set_setting(key: string, value: string) -> ()`
- `get_chat_db_path() -> string` — absolute path of `<app_data_dir>/conduit.db`
- `list_skills(projectId?: string) -> Skill[]` (global skills plus, if projectId given, that project's skills)
- `create_skill(name: string, slashCommand: string, content: string, scope: string) -> Skill`
- `update_skill(id: string, name: string, slashCommand: string, content: string) -> ()`
- `delete_skill(id: string) -> ()`
- `list_quick_actions(projectId: string) -> QuickAction[]`
- `create_quick_action(projectId: string, label: string, command: string, keybinding?: string, runOnWorktree?: boolean) -> QuickAction`
- `update_quick_action(id: string, label: string, command: string, keybinding?: string, runOnWorktree?: boolean) -> ()`
- `delete_quick_action(id: string) -> ()`
- `set_secret(projectId: string, key: string, value: string) -> ()`
- `delete_secret(projectId: string, key: string) -> ()`
- `list_secret_keys(projectId: string) -> string[]`
- `get_cost_events(sessionId?: string) -> CostEvent[]`
- `get_cost_rollups(rangeDays?: 7 | 30 | 90) -> CostRollups` (default 30; new shape from COST_MODEL_REDESIGN.md §8)
- `export_session_markdown(paneId: string) -> string` (formatted markdown from that pane's stripped transcript buffer)
- `read_file_text(path: string) -> string` (capped ~512KB; for the read-only peek viewer)

Installed skills / loops (harness skill directories — Claude Code `~/.claude/skills/<slug>/SKILL.md`, Kimi `~/.agents/skills/`):
- `list_installed_skills() -> InstalledSkill[]` — skills discovered in harness skill dirs
- `list_installed_loops() -> InstalledSkill[]` — loops discovered in harness loop dirs
- `read_installed_skill(slug: string, kind: string) -> string | null` — reads a skill/loop file's content (`kind` accepts "skill"/"loop" singular or plural)
- `save_installed_skill(slug: string, kind: string, content: string) -> ()` — overwrites an existing skill/loop file (mirrors to every copy that exists)
- `create_installed_skill(name: string, kind: string, content: string) -> InstalledSkill` — creates a new skill/loop in both harness roots
- `delete_installed_skill(slug: string, kind: string) -> ()`
- `list_chat_skills() -> ChatSkillInfo[]` — skills available for the Chat tab (appended to system prompt)

`InstalledSkill = { slug, name, description, source ("claude"|"kimi"|"both"), claudePath?, kimiPath?, kind ("skill"|"loop") }`.

## Browser (native child webviews, one per tab)

The browser pane uses Tauri child webviews on Windows/macOS; Linux uses standalone `WebviewWindow`s (one per tab) because wry/gtk has no multi-webview support. No iframe fallback remains on any platform.
Webview label scheme: `browser-{paneId}-tab-{tabId}` (extends the prior `browser-{paneId}` scheme).
Use tabId=`"default"` for the single-tab path so there is ONE code path.

Types:
- `BrowserRect { x: number, y: number, width: number, height: number }` (logical pixels from getBoundingClientRect)

Commands:
- `browser_create(paneId: string, tabId: string, url: string, rect: BrowserRect) -> ()` — create a native webview for a pane+tab; async (runs on worker thread to avoid blocking the main thread on WebView2 init)
- `browser_navigate(paneId: string, tabId: string, url: string) -> ()`
- `browser_push_state(paneId: string, tabId: string, url: string) -> ()` — called from injected JS on same-document navigations (pushState/replaceState/hashchange)
- `browser_action_result(reqId: number, result: string) -> ()` — called from injected JS to return an agentic browser action's result to the backend (resolves the pending `browser_read`/`browser_click`/`browser_type`/`browser_scroll`/`browser_screenshot` tool call keyed by `reqId`)
- `browser_go_back(paneId: string, tabId: string) -> ()`
- `browser_go_forward(paneId: string, tabId: string) -> ()`
- `browser_reload(paneId: string, tabId: string) -> ()`
- `browser_set_bounds(paneId: string, tabId: string, rect: BrowserRect) -> ()`
- `browser_set_visible(paneId: string, tabId: string, visible: boolean) -> ()`
- `browser_close(paneId: string, tabId: string) -> ()` — close a single tab's webview
- `browser_close_pane(paneId: string) -> ()` — close ALL tab webviews for a pane

Event:
- `browser:navigated` — payload `{ paneId: string, tabId: string, url: string }` (emitted on every navigation, including in-page link clicks and same-document navigations)

## Events (backend → frontend, via `app.emit`; frontend uses `listen(name, cb)`)

- `pty:output` — payload `{ paneId: string, data: string }` (UTF-8 lossy terminal output chunk)
- `pty:exit` — payload `{ paneId: string, code: number | null }`
- `pty:state` — payload `{ paneId: string, state: PaneState }` (backend heuristic: output activity → `working`; ~1.5s of silence after output → `waiting`; fresh spawn with no output → `idle`; harness diff-approval prompt pattern → `diff_ready`, best-effort)
- `session:harness-id` — payload `{ sessionId: string, harnessSessionId: string }` (when adapter detects the harness's own session id in output)
- `cost:updated` — payload `{ sessionId: string, version: 1 | 2 }` (after a parsed usage event is written; frontend refetches; version 2 = current shape)
- `browser:url_detected` — payload `{ paneId: string, url: string }` (when a local dev-server URL is detected in terminal output; frontend opens it in the built-in browser pane)

- `chat:token` — payload `{ chatSessionId: string, token: string }` (streaming token from LLM)
- `chat:done` — payload `{ chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null }` (assistant message completed and persisted)
- `chat:error` — payload `{ chatSessionId: string, message: string, code: string | null }` (stream or request error)
- `chat:artifact` — payload `{ chatSessionId: string, path: string, filename: string }` (a tool generated a file, surface it in the artifact panel)
- `chat:open-browser` — payload `{ chatSessionId: string, url: string }` (the `open_url` tool asks the UI to show a page in the built-in browser pane)
- `chat:approval-request` — payload `{ chatSessionId, pendingId, tool, summary, args }` (a filesystem tool call needs per-action approval; the turn pauses until the UI calls `resolve_tool_action`)
- `chat:approval-resolved` — payload `{ chatSessionId, pendingId, approved }` (the user resolved the card; the backend has resumed the paused tool loop)
- `chat:status` — payload `{ chatSessionId: string, status: string, reason?: string }` (stream status change, e.g. `context_compacted`)
- `chat:task-progress` — payload `{ chatSessionId: string, taskId: string, kind: string, status: string, detail?: string }` (background task progress)
- `updater:progress` — payload `{ downloaded: number, total: number | null }` (cumulative bytes downloaded during `download_and_install_update`; `total` is the Content-Length if known)
- `updater:installed` — payload `()` (the verified update package is on disk; the app restarts automatically)
- `browser:resolve-pane-request` — payload `{ reqId: string, projectId: string }` (MCP server asks frontend to resolve which browser pane to use)
- `browser:open-browser-request` — payload `{ reqId: string, projectId: string, url?: string }` (MCP server asks frontend to open a browser pane)
- `oauth:callback` — payload `{ connectorId: string, code: string, state: string }` (OAuth redirect captured by the backend)
- `mobile:session_chat_event` — payload `{ sessionId: string, event: object }` (mobile relay forwards a chat event)
- `mobile:session_chat_owner` — payload `{ sessionId: string, ownerPaneId: string }` (mobile relay assigns chat ownership)
- `local-model:download:progress` — payload `{ modelId: string, downloaded: number, total: number, status: string }` (model download progress)

## Auto-updater (Tauri plugin-updater + GitHub Releases)

Types:
- `UpdateInfo { updateAvailable: boolean, version: string | null, notes: string | null, pubDate: string | null }`

Commands:
- `check_for_update() -> UpdateInfo` — GETs the configured endpoint (`latest.json` on GitHub Releases) and semver-compares. A network failure mid-check is treated as "no update" (non-fatal) so the app keeps working. Safe to call on a timer (startup + every 4h).
- `download_and_install_update() -> ()` — re-checks for the pending update, downloads it while streaming `updater:progress`, verifies the signature against the baked-in pubkey, runs the installer (passive — progress bar, no dialog gauntlet — on Windows), then emits `updater:installed` and restarts. Guarded by a static `INSTALLING` flag so two calls cannot spawn concurrent downloads.

The endpoint URL, pubkey, and Windows install mode live in `tauri.conf.json` (`plugins.updater`). The signing keypair is at `.tauri/conduit-update.key` / `.key.pub` (gitignored); `scripts/make-latest-json.mjs` produces the `latest.json` manifest uploaded with each GitHub Release. See `RELEASE.md`.

## Chat (direct LLM HTTP API, separate from CLI agent panes)

Types:
- `ChatSession { id: string, title: string | null, provider: string, model: string, createdAt: number, lastActiveAt: number, starred: boolean, unread: boolean, permissionMode: string, watchMode?: boolean | null }` — `permissionMode` is the per-session filesystem-tool posture (`read_only` | `manual` | `auto_edit` | `full_auto`); new sessions default to `manual`. `watchMode` overrides the global `watchMode` setting for this session only.
- `ChatMessageRecord { id: number, chatSessionId: string, role: string, content: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null, createdAt: number, llmTimeMs?: number | null, toolTimeMs?: number | null, ttftMs?: number | null, tokensPerSecond?: number | null }` — the optional perf fields are populated by the streaming path when the provider returns per-turn timing (TTFT, LLM time, tool time) and rate (tokens/sec); surfaced in the composer metrics row. Persisted as `llm_time_ms`/`tool_time_ms`/`ttft_ms`/`tokens_per_second` (added by the `migrate_chat_messages_perf` migration).
- `ChatConfigPayload { provider: string | null, baseUrl: string | null, model: string | null, hasKey: boolean }`
- `ChatModel { id: string, object: string, created: number, ownedBy: string }`
- `ChatApprovalRequestPayload { chatSessionId: string, pendingId: string, tool: string, summary: string, args: any }` — a pending per-action filesystem-tool approval card.
- `ChatApprovalResolvedPayload { chatSessionId: string, pendingId: string, approved: boolean }`

Commands:
- `list_chat_sessions() -> ChatSession[]` (most recent first by lastActiveAt)
- `create_chat_session(provider: string, model: string) -> ChatSession`
- `delete_chat_session(chatSessionId: string) -> ()`
- `delete_all_chat_sessions() -> number` — bulk delete every chat session + its messages; returns the count deleted
- `update_chat_session_model(chatSessionId: string, model: string) -> ()`
- `update_chat_session_provider(chatSessionId: string, provider: string) -> ()` — switches the provider for an existing chat session.
- `update_chat_session_watch_mode(chatSessionId: string, watchMode: boolean | null) -> ()` — sets the per-session watch-mode override (null = inherit global setting).
- `update_chat_session_permission_mode(chatSessionId: string, mode: string) -> ()` — sets the per-session filesystem-tool posture (`read_only` | `manual` | `auto_edit` | `full_auto`); rejects unknown modes. The frontend gates the switch INTO `full_auto` behind a one-time confirmation modal before calling this.
- `update_chat_session_agent(chatSessionId: string, agent: string | null) -> ()` — sets the per-session agent selection from the composer's `AgentMenu` (`"builtin"` | `"local"` | `"harness:<id>"` | null = no agent picked yet). Selecting a harness routes subsequent `send_chat_message` calls to the headless CLI chat path (`send_agent_chat_message`).
- `delete_chat_message(chatSessionId: string, messageId: number) -> ()` — deletes a single message from a chat session.
- `update_chat_session_title(chatSessionId: string, title: string) -> ()`
- `generate_chat_title(chatSessionId: string) -> string | null` — auto-generates a 3–6 word title from the conversation history via the LLM; returns `null` if generation fails (no API key configured, empty transcript, or API error).
- `set_chat_session_starred(chatSessionId: string, starred: boolean) -> ()`
- `set_chat_session_unread(chatSessionId: string, unread: boolean) -> ()`
- `get_chat_messages(chatSessionId: string) -> ChatMessageRecord[]` (chronological by id)
- `touch_chat_session(chatSessionId: string) -> ()` (sets lastActiveAt = now)
- `send_chat_message(chatSessionId: string, content: string, effort?: string, toolsEnabled?: boolean, codeExecEnabled?: boolean, attachments?: ChatAttachmentInput[]) -> ()` — persists user message, looks up provider/model/api_key + the session's `permissionMode`, assembles message history, kicks off SSE streaming. `ChatAttachmentInput = { name, kind: "image"|"text"|"doc", text?, data? (base64), mediaType?, format? }`: images are sent to the model as vision content parts (data URL for OpenAI, base64 image block for Anthropic) on the live turn only; `doc` (docx/pptx/xlsx) bytes are text-extracted server-side and inlined into the message; `text` files are inlined as fenced blocks. Emits `chat:token`, then `chat:done` or `chat:error`. All diagrams go through the `generate_diagram` (vector SVG) tool. Chat tools (32): `web_search`, `generate_file`, `generate_document`, `generate_diagram`, `fetch_url`, `open_url`, `run_code`, `get_skill`, `list_skills`, the agentic browser control set (`browser_read`/`browser_click`/`browser_type`/`browser_scroll`/`browser_screenshot`), `download_file`, `download_progress`, `run_shell`, `Task` (focused subagent), `get_task_status`, `cancel_task`, `add_source_note`, `get_source_ledger`, `reset_source_ledger`, and the filesystem set (`list_directory`/`read_file`/`search_files`/`search_content`/`write_file`/`edit_file`/`delete_file`/`move_file`/`copy_file`). Filesystem mutating tools route through the central `check_permission` gate: under `read_only` the mutating tools are absent from the tool schema entirely; under `manual`/`auto_edit`/`full_auto` an action that needs approval emits `chat:approval-request` and pauses the turn until the UI resolves it via `resolve_tool_action`. `delete_file` is ALWAYS gated, in every mode.
- `cancel_chat_message(chatSessionId: string) -> ()` — aborts the active stream for that session (also drops its pending approvals).
- `resolve_tool_action(pendingId: string, approved: boolean) -> ()` — resolves a pending per-action filesystem-tool approval card. `true` lets the paused tool loop run the action and feed its result back to the model; `false` injects a "user denied" tool result. Unknown/already-resolved `pendingId` is a no-op.
- `list_artifacts() -> ArtifactRecord[]` — all persisted generated artifacts (files/diagrams), most recent first. `ArtifactRecord = { id, chatSessionId?, chatMessageId?, filename, path, kind, createdAt, expiresAt }`. `chatMessageId` links an artifact to the specific assistant message that produced it (used to restore inline diagrams/file chips on a reopened chat). Artifacts are retained 30 days; expired rows+files are swept on app startup.
- `list_chat_artifacts(chatSessionId: string) -> ArtifactRecord[]` — artifacts for a specific chat session
- `delete_artifact(id: string) -> ()` — removes an artifact's DB row and its on-disk file.
- `delete_all_artifacts() -> number` — bulk: removes every artifact row + on-disk file and sweeps the artifacts dir for leftovers. Returns the number of files removed.
- `set_chat_api_key(provider: string, key: string, baseUrl?: string, model?: string) -> ()` — stores key in OS keychain, stores baseUrl/model in app_settings. The key value is NEVER returned via any IPC command.
- `delete_chat_api_key(provider: string) -> ()`
- `get_chat_config(provider?: string) -> ChatConfigPayload` — NON-secret config only. The API key is never returned.
- `list_chat_models(provider: string, baseUrl?: string, apiKey?: string) -> ChatModel[]` — queries `/v1/models` on a compatible provider's base URL.
- `read_artifact_preview(path: string) -> ArtifactPreview` — returns in-app preview content for a generated artifact file. `kind` is one of: `text`, `markdown`, `csv`, `json`, `html`, `code`, `image`, `pdf`, `office`, `diagram`, `binary`. `diagram` is used for HTML files containing the `<!-- conduit:diagram -->` sentinel (generated by the `generate_diagram` tool); `office` is used for docx/pptx/xlsx extracted to HTML (docx additionally carries raw bytes in `dataUri`/`originalBytes` for client-side docx-preview rendering; pptx is converted to `pdf` upstream via headless LibreOffice when available).
- `office_accurate_pdf(path: string) -> string | null` — "accurate view" for Office previews: converts the ORIGINAL docx/pptx/xlsx/doc/ppt to PDF via headless LibreOffice (result cached by path+size+mtime) and returns a `data:application/pdf;base64,…` URI. `null` when LibreOffice is unavailable or conversion failed (caller keeps the fast preview).
- `docgen_complete(requestId: string, dataB64?: string, error?: string) -> ()` — completion callback for the JavaScript document engine. The Rust `generate_document` tool (language `javascript`) emits the `docgen://run` event `{ requestId, format, filename, code }` to the main window; the frontend `DocCodeRunner` executes the program in a sandboxed iframe with the `docx` / `PptxGenJS` bundles preloaded and resolves the run by invoking this command with the produced file as base64 (`dataB64`) or an `error` message.
- `download_artifact(src: string, dest: string) -> ()` — copy an artifact to a user-chosen path.
- `download_artifacts_zip(paths: string[], dest: string) -> ()` — zip multiple artifacts to a user-chosen `.zip` path.

## Local Model (bundled llama.cpp sidecar)

Commands:
- `scan_local_models() -> LocalModelInfo[]` — scans the models directory for GGUF files.
- `start_local_model(modelId: string, ctxSize?: number) -> LocalModelStatus` — spawns the llama.cpp sidecar.
- `stop_local_model() -> ()` — stops the running sidecar.
- `local_model_status() -> LocalModelStatus` — returns the current sidecar state.
- `count_context_tokens(chatSessionId: string) -> { usedTokens: number, maxTokens: number }` — queries the sidecar's /tokenize endpoint for the live context count.

## Connectors (OAuth + remote MCP)

Commands:
- `list_connectors() -> ConnectorInfo[]` — all configured connectors.
- `connector_connect(connectorId: string) -> ()` — initiates OAuth flow for a connector.
- `connector_connect_family(family: string) -> ()` — initiates OAuth for a connector family.
- `connector_disconnect(connectorId: string) -> ()` — revokes and removes stored credentials.
- `list_session_connectors(chatSessionId: string) -> SessionConnector[]` — connectors enabled for a chat session.
- `set_session_connectors(chatSessionId: string, connectorIds: string[]) -> ()` — sets which connectors are enabled for a chat session.

## Workspaces (pane layout save/restore)

Commands:
- `list_workspaces() -> Workspace[]` — all saved workspace layouts.
- `save_workspace(name: string, layoutJson: string) -> Workspace` — saves the current pane layout.
- `delete_workspace(workspaceId: string) -> ()` — deletes a saved workspace.

## Local Model Market (Hugging Face model downloads)

Commands:
- `fetch_model_catalog() -> ModelCatalogEntry[]` — fetches the curated model catalog.
- `start_model_download(modelId: string) -> ()` — starts downloading a model from Hugging Face.
- `cancel_model_download(modelId: string) -> ()` — cancels an in-progress download.
- `download_mmproj(modelId: string) -> ()` — downloads the mmproj (vision) companion file.
- `delete_downloaded_model(modelId: string) -> ()` — removes a downloaded model from disk.
- `get_market_settings() -> MarketSettings` — returns the current market settings.
- `set_models_directory(path: string) -> ()` — sets the directory where models are stored.
- `pick_models_directory() -> string | null` — opens a folder picker for the models directory.
- `set_hugging_face_token(token: string) -> ()` — stores the Hugging Face API token.
- `clear_hugging_face_token() -> ()` — removes the stored Hugging Face API token.

Providers: `anthropic`, `openai`, `openrouter`, `anthropic_compatible`, `openai_compatible`, `local_gguf`.

## Mobile Relay (desktop ↔ mobile companion app WebSocket bridge)

The desktop runs a localhost WebSocket relay server for the mobile companion app.
The phone never holds API keys — every model call originates from the desktop process.

Types:
- `MobileRelayStatus { running: boolean, port: number }`

Commands:
- `start_mobile_relay() -> number` — starts the relay on a random 127.0.0.1 port, returns the port
- `stop_mobile_relay() -> ()` — stops the relay server
- `get_mobile_relay_status() -> MobileRelayStatus` — current relay state

The relay auto-starts on app launch and auto-stops on exit. See `src-tauri/src/mobile/`
for the full protocol (JSON over WebSocket, tagged-union message types).

## Rules both sides must honor

- Pane processes are killed on explicit close, LRU replacement (when all 6 slots are full — the evicted pane's pty is terminated), or app quit — never on blur (PRD §6.5).
- On app quit the backend terminates all child pty processes cleanly (PtyState + agent_sessions::AgentSessionState + LocalModelState + mobile relay).
- CLI agent session title auto-generation (first ~40 chars of first user prompt) happens in the **frontend** (it observes what the user types); it calls `update_session_title` once when a session's title is null and the first prompt is submitted. Chat sessions instead use `generate_chat_title` (backend, LLM-based, 3–6 words).
- Skill slash-command expansion happens in the **frontend** before `write_pty`.
- Broadcast mode is pure frontend: it calls `write_pty` for each selected pane.
- **Headless CLI chat** routes through `send_agent_chat_message` when the chat session's `agent` starts with `"harness:"`; built-in chat uses `send_chat_message`. The `permission_mode` column is only honored by the built-in chat — CLI chat always runs at full-auto permission. UI for selecting a permission mode was removed in favor of the `AgentMenu` selector.
- SQLite lives at `<app_data_dir>/conduit.db`. Schema = PRD §6.3 plus `quick_actions`, `chat_sessions` (with `starred`/`unread`/`watch_mode`/`agent`/`permission_mode` columns), `chat_messages` (with `superseded_by`), `artifacts`, `chat_source_notes`, `connector_credentials`, `chat_session_connectors`, `workspaces`, `automations`, and `automation_runs`. Migrations add columns idempotently (`ALTER TABLE … ADD COLUMN` + duplicate-column tolerance).
