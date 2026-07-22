# IPC Contract (binding for both Rust backend and React frontend)

All Tauri commands are invoked from the frontend with `invoke('<command_name>', { args })`.
All structs serialized over IPC use **camelCase** field names (Rust: `#[serde(rename_all = "camelCase")]`).
IDs are UUID strings. Timestamps are Unix epoch **seconds** (i64).

## Types

```ts
type HarnessId = 'claude_code' | 'kimi_code' | 'opencode';
type ChatProviderId = 'anthropic' | 'openai' | 'anthropic_compatible' | 'openai_compatible';
type PaneState = 'idle' | 'working' | 'waiting' | 'diff_ready';

interface Project { id: string; path: string; name: string; isGitRepo: boolean; createdAt: number; lastOpenedAt: number | null }
interface SessionRecord { id: string; projectId: string; harness: HarnessId; harnessSessionId: string | null; title: string | null; worktreePath: string | null; createdAt: number; lastActiveAt: number; status: string }
interface HarnessStatus { id: HarnessId; displayName: string; installed: boolean }
interface GitStatusInfo { isRepo: boolean; branch: string | null; dirty: boolean; ahead: number; behind: number }
interface Skill { id: string; name: string; slashCommand: string; content: string; scope: string; createdAt: number } // scope = 'global' or a project id
interface QuickAction { id: string; projectId: string; label: string; command: string; keybinding: string | null; runOnWorktree: boolean }
interface CostEvent { id: number; sessionId: string; timestamp: number; inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null }
interface CostRollups { perProject: Array<{ projectId: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }>; daily: Array<{ day: string; costUsd: number }> } // day = 'YYYY-MM-DD'
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

Git:
- `get_git_status(path: string) -> GitStatusInfo`
- `create_worktree(projectId: string, branchName: string) -> string` (returns worktree path; uses `git worktree add <path> -b <branch>`; path = sibling dir `<project>-<branch>` sanitized)
- `get_git_diff(path: string) -> string` (unified diff of working tree, capped ~200KB)

Settings / skills / quick actions / secrets / cost:
- `get_setting(key: string) -> string | null`
- `set_setting(key: string, value: string) -> ()`
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
- `get_cost_rollups() -> CostRollups`
- `export_session_markdown(paneId: string) -> string` (formatted markdown from that pane's stripped transcript buffer)
- `read_file_text(path: string) -> string` (capped ~512KB; for the read-only peek viewer)

## Browser (native child webviews, one per tab)

The browser pane uses Tauri child webviews on Windows/macOS; Linux falls back to iframes.
Webview label scheme: `browser-{paneId}-tab-{tabId}` (extends the prior `browser-{paneId}` scheme).
Use tabId=`"default"` for the single-tab path so there is ONE code path.

Types:
- `BrowserRect { x: number, y: number, width: number, height: number }` (logical pixels from getBoundingClientRect)

Commands:
- `browser_create(paneId: string, tabId: string, url: string, rect: BrowserRect) -> ()` — create a native webview for a pane+tab; async (runs on worker thread to avoid blocking the main thread on WebView2 init)
- `browser_navigate(paneId: string, tabId: string, url: string) -> ()`
- `browser_push_state(paneId: string, tabId: string, url: string) -> ()` — called from injected JS on same-document navigations (pushState/replaceState/hashchange)
- `browser_action_result(reqId: number, result: string) -> ()` — called from injected JS to return an agentic browser action's result to the backend (resolves the pending `browser_read`/`browser_click`/`browser_type`/`browser_scroll` tool call keyed by `reqId`)
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
- `cost:updated` — payload `{ sessionId: string }` (after a parsed usage event is written; frontend refetches)

- `chat:token` — payload `{ chatSessionId: string, token: string }` (streaming token from LLM)
- `chat:done` — payload `{ chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null }` (assistant message completed and persisted)
- `chat:error` — payload `{ chatSessionId: string, message: string, code: string | null }` (stream or request error)
- `chat:artifact` — payload `{ chatSessionId: string, path: string, filename: string }` (a tool generated a file, surface it in the artifact panel)
- `chat:open-browser` — payload `{ chatSessionId: string, url: string }` (the `open_url` tool asks the UI to show a page in the built-in browser pane)

## Chat (direct LLM HTTP API, separate from CLI agent panes)

Types:
- `ChatSession { id: string, title: string | null, provider: string, model: string, createdAt: number, lastActiveAt: number }`
- `ChatMessageRecord { id: number, chatSessionId: string, role: string, content: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null, createdAt: number }`
- `ChatConfigPayload { provider: string | null, baseUrl: string | null, model: string | null, hasKey: boolean }`
- `ChatModel { id: string, object: string, created: number, ownedBy: string }`

Commands:
- `list_chat_sessions() -> ChatSession[]` (most recent first by lastActiveAt)
- `create_chat_session(provider: string, model: string) -> ChatSession`
- `delete_chat_session(chatSessionId: string) -> ()`
- `update_chat_session_model(chatSessionId: string, model: string) -> ()`
- `update_chat_session_title(chatSessionId: string, title: string) -> ()`
- `get_chat_messages(chatSessionId: string) -> ChatMessageRecord[]` (chronological by id)
- `touch_chat_session(chatSessionId: string) -> ()` (sets lastActiveAt = now)
- `send_chat_message(chatSessionId: string, content: string, effort?: string, toolsEnabled?: boolean, codeExecEnabled?: boolean, attachments?: ChatAttachmentInput[]) -> ()` — persists user message, looks up provider/model/api_key, assembles message history, kicks off SSE streaming. `ChatAttachmentInput = { name, kind: "image"|"text"|"doc", text?, data? (base64), mediaType?, format? }`: images are sent to the model as vision content parts (data URL for OpenAI, base64 image block for Anthropic) on the live turn only; `doc` (docx/pptx/xlsx) bytes are text-extracted server-side and inlined into the message; `text` files are inlined as fenced blocks. Emits `chat:token`, then `chat:done` or `chat:error`. All diagrams go through the `generate_diagram` (vector SVG) tool. Chat tools: `web_search`, `generate_file`, `generate_document`, `generate_diagram`, `fetch_url`, `open_url`, `run_code`, plus agentic browser control (`browser_read`/`browser_click`/`browser_type`/`browser_scroll`) that drives the active browser pane via injected JS (native webview only; no-op on the Linux iframe fallback).
- `cancel_chat_message(chatSessionId: string) -> ()` — aborts the active stream for that session.
- `list_artifacts() -> ArtifactRecord[]` — all persisted generated artifacts (files/diagrams), most recent first. `ArtifactRecord = { id, chatSessionId?, filename, path, kind, createdAt, expiresAt }`. Artifacts are retained 30 days; expired rows+files are swept on app startup.
- `delete_artifact(id: string) -> ()` — removes an artifact's DB row and its on-disk file.
- `set_chat_api_key(provider: string, key: string, baseUrl?: string, model?: string) -> ()` — stores key in OS keychain, stores baseUrl/model in app_settings. The key value is NEVER returned via any IPC command.
- `delete_chat_api_key(provider: string) -> ()`
- `get_chat_config(provider?: string) -> ChatConfigPayload` — NON-secret config only. The API key is never returned.
- `list_chat_models(provider: string, baseUrl?: string, apiKey?: string) -> ChatModel[]` — queries `/v1/models` on a compatible provider's base URL.
- `read_artifact_preview(path: string) -> ArtifactPreview` — returns in-app preview content for a generated artifact file. `kind` is one of: `text`, `markdown`, `csv`, `json`, `html`, `code`, `image`, `pdf`, `office`, `diagram`, `binary`. `diagram` is used for HTML files containing the `<!-- conduit:diagram -->` sentinel (generated by the `generate_diagram` tool); `office` is used for docx/pptx/xlsx extracted to HTML.
- `download_artifact(src: string, dest: string) -> ()` — copy an artifact to a user-chosen path.
- `download_artifacts_zip(paths: string[], dest: string) -> ()` — zip multiple artifacts to a user-chosen `.zip` path.

Providers: `anthropic`, `openai`, `anthropic_compatible`, `openai_compatible`.

## Rules both sides must honor

- Pane processes are killed ONLY on explicit close or app quit — never on blur (PRD §6.5).
- On app quit the backend terminates all child pty processes cleanly.
- Session title auto-generation (first ~40 chars of first user prompt) happens in the **frontend** (it observes what the user types); it calls `update_session_title` once when a session's title is null and the first prompt is submitted.
- Skill slash-command expansion happens in the **frontend** before `write_pty`.
- Broadcast mode is pure frontend: it calls `write_pty` for each selected pane.
- SQLite lives at `<app_data_dir>/conduit.db`. Schema = PRD §6.3 plus a `quick_actions` table (id TEXT PK, project_id TEXT NOT NULL REFERENCES projects(id), label TEXT NOT NULL, command TEXT NOT NULL, keybinding TEXT, run_on_worktree BOOLEAN NOT NULL DEFAULT 0).
