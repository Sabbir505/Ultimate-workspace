# Relay — AI Context Document

> **Naming.** "Relay" is the user-visible product name (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`, sidebar/banner/HTML strings). The Rust crate name (`conduit`), the bundle identifier (`dev.conduit.app`), the NSIS installer filename pattern (`Conduit_<version>_x64-setup.exe`), the mobile app name (`Conduit Mobile`), the mobile bundle identifier (`com.conduit.mobile`), and the Windows scheduled-task name (`ConduitAutomations`) are still "Conduit" / `conduit` — the rebrand (`e9abc7c3`) was deliberately limited to user-visible surfaces. See `RELEASE.md` for the rationale. Where this doc refers to **the product**, it means Relay. Where it refers to the crate, the bundle id, the installer, the mobile app, or the scheduled task, it means Conduit.

**Last verified:** 2026-08-27
**Branch:** `master`
**Working tree:** Auto-updater (Tauri plugin-updater + GitHub Releases + `UpdateBanner`), bundled Python runtime (`chat/python_runtime.rs` staged by `scripts/fetch-bundled-python.mjs`), local model support (GGUF via llama.cpp sidecar + Hugging Face market), OAuth connectors (Notion / GitHub / Google / Gmail / Kiwi), workspace save/restore, mobile relay, headless CLI chat (Claude Code / Kimi Code / OpenCode via `agent_sessions.rs` with the per-project harness bundle from `harness_bundle.rs`), and the **automations** scheduler (cron-fired headless one-shot turns, `automations.rs` + `db/automations.rs`) are all in place. Doc set is consolidated under `AI CONTEXT/`. Recent shape: chat backend split into focused submodules (`chat/{mod,prompts,proto,dispatch,streaming}.rs`) and chat tools into `chat/tools/{mod,specs,search,generate,fs,search_content}.rs`; per-session permission modes are wired end-to-end (`ff0b812f`) — `PermissionModeMenu` in the composer, `ApprovalCard`/`FullAutoConfirmModal` (`ApprovalFlow.tsx`), the approval-rules engine, and a Claude Code `can_use_tool` stdio relay — alongside the `AgentMenu` (composer agent selector) and the `DiffCard` inline review component. UI rework in progress: floating glass composer over a scrolling transcript, collapsible git sidebar, Git Graph commit table, glass tool-panel slide-out.

This document is the single source of truth for AI assistants working on this codebase. It is grounded in the actual source, not in PRD/BUILD_LOG summaries. When in doubt, trust this doc over the PRD.

---

## 1. What Relay Is

A local-first desktop shell for AI coding agents with ONE unified chat surface (the old separate Dev/Chat tabs were removed in the single-mode layout rework, `d39d5a25`). It does **not** implement its own agent loop for harness CLIs — it orchestrates existing CLI binaries, and adds a direct-HTTP LLM chat backend for the built-in/local agents. The product is "Relay" everywhere the user sees it; the Rust crate, the bundle id, the installer, the mobile app, and the scheduled task are still "Conduit" (see the naming note at the top of this file).

**One main surface (`ChatView`), fed by three chat backends plus interactive PTY panes in the right-side ToolPanel:**

| Surface | Chat session `agent` value | Mechanism | Key events |
|---|---|---|---|
| Built-in cloud chat | `"builtin"` | HTTP/SSE to Anthropic/OpenAI/OpenRouter/compatible providers; tool loop | `chat:token`, `chat:done`, `chat:error`, `chat:artifact`, `chat:open-browser` |
| Local GGUF | `"local"` | llama.cpp sidecar (OpenAI wire format) | same |
| Headless harness CLI | `"harness:<id>"` | persistent `claude -p` stream-json process / per-turn `kimi` / `opencode run` (`agent_sessions.rs`) | same, plus `chat:approval-request` |
| Interactive harness pane | n/a (`sessions` table) | Sidebar session row → PTY spawn, resume by session ID; terminal renders in the ToolPanel's Terminal tab | `pty:output`, `pty:state`, `pty:exit`, `session:harness-id`, `cost:updated`, `browser:url_detected` |

**Stack:** Tauri v2 (Rust) + React 18/TypeScript + Zustand + xterm.js + SQLite (rusqlite) + window-vibrancy (acrylic on Win, frosted on macOS)

---

## 2. Backend (`src-tauri/src`)

### 2.1 Entry Point (`lib.rs`)

- **Managed states:** `DbState` (SQLite behind `Mutex`), `PtyState` (`PtyManager`), `BrowserState` (`BrowserManager`), `ChatState` (`ChatManager`), `TaskState` (`chat::tasks::TaskManager`), `MobileRelayState`, `OAuthFlowsState`, `chat::local_models::LocalModelState`, `commands::local_model_market::DownloadRegistry`, `agent_sessions::AgentSessionState`
- **Plugins:** dialog, notification, fs, opener, updater
- **Boot sequence:** open `<app_data_dir>/conduit.db` → sweep expired artifacts (30-day retention) → register Python runtime resource dir → register all managed states → spawn mobile relay on a random localhost port → spawn loopback `browser_mcp::serve` WebSocket on `BROWSER_MCP_PORT` → start the `automations` scheduler (30s tick) → apply window vibrancy → register **235 commands** (`tauri::generate_handler!` macro, `src-tauri/src/lib.rs:239-494`; 236 `#[tauri::command]` attributes total across the backend — the 9-command delta from the previously-documented 226 is in `commands/git_cmds.rs`, `commands/browser_cmds.rs`, `chat/commands.rs`, and `connectors/`)
- **Exit cleanup** (`ExitRequested` / `Exit`): `kill_all()` PTYs, `close_all()` browsers, `cancel_all()` chat streams, `agent_sessions::kill_all()`, `LocalModelState::stop_all()` (via `block_on`), `mobile::relay::stop_relay`

### 2.2 Command Surface (235 registered in `lib.rs`)

```
Projects/sessions:   list_projects, add_project, remove_project, rename_project,
                     init_git_repo, list_sessions, create_session, update_session_title,
                     delete_session, touch_session, get_chat_db_path
PTY/harnesses:       spawn_agent_session, spawn_shell, write_pty, resize_pty, kill_pty,
                     list_harnesses, run_harness_login, pane_memory, install_harness,
                     pty_subscribe
Browser:             browser_create, browser_navigate, browser_push_state, browser_action_result,
                     browser_go_back, browser_go_forward, browser_reload, browser_set_bounds,
                     browser_set_visible, browser_close, browser_close_pane,
                     browser_open_pane_result, browser_resolve_pane_result,
                     browser_open_devtools,
                     register_browser_pane_project, unregister_browser_pane_project
Git:                 get_git_status, create_worktree, get_git_diff,
                     get_changed_files, get_git_file_diff, checkout_git_branch,
                     create_git_branch, delete_git_branch, get_git_log, get_remote_url,
                     git_commit, git_push, install_git_watcher, list_git_branches,
                     refresh_git_watchers, uninstall_git_watcher
Automations:         list_automations, create_automation, update_automation,
                     delete_automation, set_automation_enabled, run_automation_now,
                     list_automation_runs, count_automation_runs, automation_next_fire,
                     test_automation_webhook, get_run_while_closed, set_run_while_closed
Settings/skills/etc: get_setting, set_setting, list_skills, create_skill, update_skill,
                     delete_skill, list_quick_actions, create_quick_action, update_quick_action,
                     delete_quick_action, set_secret, delete_secret, list_secret_keys,
                     get_cost_events, get_cost_rollups, export_session_markdown, read_file_text,
                     get_data_paths, set_chat_db_dir, pop_out_chat
Workspaces:          list_workspaces, save_workspace, delete_workspace
Installed skills:    list_installed_skills, list_installed_loops, read_installed_skill,
                     save_installed_skill, create_installed_skill, delete_installed_skill,
                     list_chat_skills, make_installed_global
Chat:                list_chat_sessions, create_chat_session, delete_chat_session,
                     delete_all_chat_sessions, delete_chat_message,
                     update_chat_session_title, generate_chat_title,
                     set_chat_session_starred, set_chat_session_unread,
                     update_chat_session_model, update_chat_session_provider,
                     update_chat_session_watch_mode, update_chat_session_agent,
                     update_chat_session_policies, set_chat_session_project,
                     get_chat_messages, touch_chat_session,
                     send_chat_message, cancel_chat_message,
                     send_agent_chat_message, cancel_agent_chat_message,
                     list_harness_models,
                     resolve_tool_action,
                     set_chat_api_key, delete_chat_api_key, get_chat_config,
                     list_chat_models, read_artifact_preview, download_artifact,
                     download_artifacts_zip, list_artifacts, list_chat_artifacts,
                     delete_artifact, delete_all_artifacts, count_context_tokens,
                     count_context_breakdown, generate_commit_message, generate_diff_review,
                     supersede_chat_tail, persist_chat_command_message,
                     persist_partial_chat_message, scan_local_models,
                     start_local_model, stop_local_model, local_model_status,
                     detect_llama_server_path, get_llama_server_path, set_llama_server_path,
                     is_libreoffice_available, get_chat_session_metrics,
                     restore_chat_checkpoint, list_chat_checkpoints, delete_empty_chat_sessions,
                     search_chat_messages, create_artifact_cmd, update_artifact_cmd,
                     save_artifact_cmd, generate_artifact_cmd, search_artifacts_cmd,
                     validate_artifact_cmd, get_artifact_context_cmd, regenerate_artifact_cmd
Local model:         scan_local_models, start_local_model, stop_local_model,
                     local_model_status, count_context_tokens
Connectors:          list_connectors, connector_connect, connector_connect_family,
                     connector_disconnect, list_session_connectors, set_session_connectors
Mobile relay:        start_mobile_relay, stop_mobile_relay, get_mobile_relay_status,
                     get_mobile_pairing_info, tailscale_login,
                     tailscale_serve_enable, tailscale_serve_disable
Local model market:  fetch_model_catalog, start_model_download, cancel_model_download,
                     download_mmproj, delete_downloaded_model, get_market_settings,
                     set_models_directory, pick_models_directory,
                     set_hugging_face_token, clear_hugging_face_token, fetch_model_file_sizes,
                     get_gpu_vram
Docs index:          docs_list_corpora, docs_add_corpus, docs_remove_corpus,
                     docs_start_index, docs_cancel_index, docs_set_corpus_enabled,
                     docs_attached_corpus_ids, docs_attach_corpus_to_chat,
                     docs_detach_corpus_from_chat, docs_embedding_status
GitHub:              github_list_prs, github_get_pr, github_create_pr,
                     github_draft_pr_text, github_pr_files, github_pr_checks,
                     github_local_branches, github_submit_review
ACP/agents:          list_acp_agents
Updater:             check_for_update, download_and_install_update
Speech:              transcribe_audio
Worktree:            ensure_chat_session_worktree, set_chat_session_worktree
Skills gallery:      mcp_gallery_list, mcp_gallery_install, mcp_gallery_remove,
                     mcp_gallery_set_enabled, mcp_gallery_connect, mcp_gallery_disconnect
```

### 2.3 Events (backend → frontend)

| Event | Payload | Emitted from |
|---|---|---|
| `pty:output` | `{ paneId, data }` | `pty/mod.rs` reader thread |
| `pty:exit` | `{ paneId, code }` | `pty/mod.rs` waiter thread |
| `pty:state` | `{ paneId, state }` | `pty/mod.rs` monitor thread |
| `session:harness-id` | `{ sessionId, harnessSessionId }` | `pty/mod.rs` (regex or filesystem probe) |
| `cost:updated` | `{ sessionId, version }` | `pty/mod.rs` (usage sync; version 2 = current rollup shape) |
| `browser:url_detected` | `{ paneId, url }` | `pty/mod.rs` (local URL scan in terminal output) |
| `browser:navigated` | `{ paneId, tabId, url }` | `browser.rs` + `commands/browser_cmds.rs` |
| `chat:token` | `{ chatSessionId, token }` | `chat/mod.rs` (SSE stream) |
| `chat:done` | `{ chatSessionId, inputTokens, outputTokens, costUsd }` | `chat/mod.rs` |
| `chat:error` | `{ chatSessionId, message, code }` | `chat/mod.rs` |
| `chat:artifact` | `{ chatSessionId, path, filename }` | `chat/mod.rs` |
| `chat:open-browser` | `{ chatSessionId, url }` | `chat/mod.rs` (from `open_url` tool) |
| `chat:status` | `{ chatSessionId, status, reason? }` | `chat/streaming.rs` |
| `chat:task-progress` | `{ chatSessionId, taskId, kind, status, detail? }` | `chat/streaming.rs` |
| `chat:perf` | `{ chatSessionId, metrics }` | `chat/streaming.rs` |
| `chat:approval-request` | `{ chatSessionId, pendingId, tool, summary, args }` | `chat/permission.rs` |
| `chat:approval-resolved` | `{ chatSessionId, pendingId, approved }` | `chat/permission.rs` |
| `browser:resolve-pane-request` | `{ reqId, projectId }` | `browser_mcp.rs` (MCP roundtrip) |
| `browser:open-browser-request` | `{ reqId, projectId, url? }` | `browser_mcp.rs` (MCP roundtrip) |
| `browser:activity` | `{ paneId, tabId }` | `browser.rs` (page load activity) |
| `oauth:callback` | `{ connectorId, code, state }` | `connectors/mod.rs` |
| `mobile:session_chat_event` | `{ sessionId, event }` | `mobile/mod.rs` |
| `mobile:session_chat_owner` | `{ sessionId, ownerPaneId }` | `mobile/mod.rs` |
| `mobile:pairing-token` | `{ token }` | `mobile/relay.rs` |
| `local-model:download:progress` | `{ modelId, downloaded, total, status }` | `local_model_market.rs` |
| `updater:progress` | `{ downloaded, total }` (`total` may be null) | `commands/updater_cmds.rs` (download stream) |
| `updater:installed` | `{}` | `commands/updater_cmds.rs` (post-install, app restarts) |
| `automation:run-finished` | `{ automationId, runId, status }` | `automations.rs` |
| `project:fs-changed` | `{ path }` | `git_watcher.rs` |
| `budget:alert` | `{ budgetId, remaining }` | `commands/budget.rs` |
| `checkpoint:created` | `{ chatSessionId, checkpointId }` | `chat/commands.rs` |
| `docs:corpus:updated` | `{ corpusId }` | `docs_index.rs` |

### 2.4 PTY Subsystem (`pty/mod.rs`)

- **Per pane:** writer thread (mpsc → PTY master), reader thread (raw bytes → `pty:output` + stripped transcript + local URL scan), waiter thread (`try_wait()` → `pty:exit`)
- **State heuristic** (200ms monitor): output → `working`; 1.5s silence → `waiting`; diff-prompt regex match → `diff_ready`; fresh spawn → `idle`
- **Session-id probe:** 120s post-spawn, polls harness on-disk session store every second
- **Usage sync:** every 5s, reads cumulative usage from harness logs, records deltas
- **Kill:** `taskkill /T /F` (Win) then `kill()`; idempotent via `AtomicBool`

### 2.5 Harness Adapters & Bundle

- **Adapters (`harness_adapters/`):** static registry in `mod.rs` mapping `"claude_code"`, `"kimi_code"`, `"opencode"`. Per-harness `CommandSpec` builders + parse_session_id from TUI output / on-disk JSONL session store. `resolve_for_spawn` wraps every spec in `cmd.exe /C` on Windows so `.cmd` shims (`claude.cmd`, `kimi.cmd`) actually run; on POSIX it's a no-op.

| Adapter | Binary | New | Resume | Session ID |
|---|---|---|---|---|
| Claude Code | `claude` | bare | `--resume <id>` | TUI regex + `~/.claude/projects/<slug>/*.jsonl` probe |
| Kimi Code | `kimi` | bare | `--session <id>` | TUI regex + `~/.kimi-code/session_index.jsonl` |
| OpenCode | `opencode` | bare | `-s <id>` | TUI regex only (no filesystem probe) |

- **Per-project bundle (`harness_bundle.rs`):** every CLI session — headless chat (`agent_sessions.rs`) AND interactive PTY panes (`spawn_agent_session` in `commands/pty_cmds.rs`) — runs against a Relay-owned config bundle written under `<app_data>/harness/<safe-project-id>/`. (The on-disk directory is still `harness/`, the bundle files are still `instructions.md` / `agent.md` / `opencode.json` / etc., and the MCP server names are still `conduit-browser` / `conduit-tools` — those internal identifiers were intentionally left at the Conduit-era names.) The bundle covers Claude (`instructions.md` = environment preamble + skill catalog + browser workflow — NOT the built-in chat's CORE prompt, the CLI keeps its own provider personality; `settings.json`; `mcp.json` registering `conduit-browser` + `conduit-tools` sidecars), Kimi (`agent.md` with frontmatter, same instructions body, `mcp.json`), and OpenCode (`opencode.json` with the `mcp` section and a `permission` section only for full-auto/headless runs; `OPENCODE_CONFIG` env var on spawn). Permission posture: headless chat maps the session's dual policies (`sandbox_policy` + `approval_policy` — `full_access` approval → `bypassPermissions`, `auto_edit` → `acceptEdits`, `on_request`/unknown → `default`, fail-closed; `read_only` sandbox forces `default`) plus an `mcp__conduit-tools__*`/`Bash(git:*)` allow list; interactive PTY panes always spawn with `workspace_write`/`on_request` so the CLI's native TUI prompts stay in charge (no silent bypass), and OpenCode's allow-all permission block is omitted unless approval is `full_access`. Spawn-arg helpers `claude_bundle_args` / `kimi_bundle_args` / `opencode_bundle_args` add `--append-system-prompt-file`, `--settings`, `--mcp-config`, `--allowedTools` (Claude), `--mcp-config-file`, `--agent-file` (skipped on resume — kimi forbids it with `--session`), `--add-dir` (Kimi), or rely on the env var (OpenCode). Bundle write failure degrades to the legacy browser-only MCP config (`browser_mcp_register.rs`). Note: automations one-shots (`run_one_shot` / `run_one_shot_chat`) do NOT use the bundle or the CORE prompt — they carry only the user's custom `assistant.systemPrompt`.
- **Harness config discovery (`harness_config.rs`):** reads each CLI's own settings file (`~/.claude/settings.json` for `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_<ALIAS>_MODEL(_NAME)` remaps, `~/.kimi-code/config.toml` for `default_model` + `[providers.*]` + `[models.*]`, `~/.config/opencode/opencode.json` for `model` + `provider.<id>.options.baseURL` + `provider.<id>.models`) and merges with `opencode models` live registry output. Returns `HarnessModelConfig { defaultModel, endpoint, models[] }` with per-model `source` = `"config"` | `"cli"` | `"builtin"`. Empty/failed reads fall back to the static catalog in `src/lib/harnessModels.ts`.

- **Headless CLI chat (`agent_sessions.rs`):** chat sessions whose `agent` is `"harness:<id>"` are backed by real CLI processes (instead of the built-in chat's HTTP calls). Two spawn styles, normalized onto the SAME `chat:token`/`chat:done`/`chat:error`/`chat:artifact` events the built-in chat emits:
  - `claude_code` — one persistent process per chat: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <alias>`. Permission flags follow the session's `permission_mode`: `full_auto` adds `--dangerously-skip-permissions`; every other mode adds `--permission-prompt-tool stdio` so the CLI's `can_use_tool` asks surface as normal `chat:approval-request` cards (relay in `agent_sessions.rs`, deny is fail-closed). Turns are JSON lines on stdin; token deltas via `stream_event` wrappers; `result` event carries the CLI session id + usage + cost. The captured id persists to `app_settings` under `agent.cli_session_id.claude_code.<sid>` so respawns can `--resume`.
  - `kimi_code` / `opencode` — one process per turn: `kimi -p <prompt> --output-format stream-json [-m model] [--session id]` or `opencode run <prompt> --format json [-m provider/model] [-s id] --auto`. The CLI's own session id (from the first turn's output) is passed back on later turns.
  - `run_one_shot` — blocking one-shot self-contained turn at full-auto permission; backs the automations scheduler and the standalone `bin/conduit_automation.rs` binary.
  - Tool calls are encoded as `<tool>{json}</tool>` markers inline in the token stream — the same format `MessageBubble` / `DiffCard` and the chat history sanitizer already parse (no frontend changes needed). `MultiEdit` is expanded into one marker per hunk; `Write`/`Edit`/`Bash` aliases are normalized to the same `kind: "edit"|"code"` payload.
  - The harness's per-turn working dir is snapshotted before spawn and diffed after; new/modified previewable files surface as artifacts (mirrors `chat/dispatch.rs`'s tool outcome path) with the `chat:artifact` event.

### 2.6 Chat Subsystem (`chat/`)

- **Core prompt:** lives in `chat/prompts.rs` — `core_prompt_base()`, `core_prompt_strict()` (appended for local models), `core_prompt_for(provider, model)`, `is_research_request()`, `build_system_prompt()`. `mod.rs` re-exports `build_system_prompt` + `is_research_request`. Tool names must match the `tools/mod.rs` registry.
- **Providers:** `Anthropic`, `OpenAI`, `AnthropicCompatible`, `OpenAICompatible`, `OpenRouter`, `LocalGguf` (`chat/providers.rs`)
- **Tool loop (`chat/streaming.rs`):** OpenAI-style (`run_openai_tool_loop`) and Anthropic-style (`run_anthropic_tool_loop`), capped at `MAX_TOOL_ITERS = 45` (non-research) / `RESEARCH_MAX_TOOL_ITERS = 96` (research turns). Each call streams one round (`openai_stream_round`/`anthropic_stream_round`), then runs tool calls and feeds results back until a final answer or the cap. Hermes XML `<tool_calls>` fallback parser (in `chat/proto.rs`) recovers tool calls emitted as plain text by aggregators that don't translate the `tools` field. Wire-protocol helpers (`parse_tool_args`, `parse_hermes_tool_calls`, `strip_hermes_tool_calls`, `tool_block`, `openai_message_json`/`anthropic_message_json`, `next_synthetic_tool_id`) live in `chat/proto.rs`; tool dispatch (`run_tool`, `run_gated_fs_tool`, `run_browser_tool`, `run_ledger_tool`, `emit_token`, `artifacts_dir`) in `chat/dispatch.rs`.
- **Tools (32):** `web_search`, `generate_file`, `generate_document`, `generate_diagram`, `fetch_url`, `run_code`, `open_url`, `get_skill`, `list_skills`, `browser_read` (modes: `full`/`summary_only`/`section`/`interactive` — interactive returns a full a11y tree with element `ref` ids for `browser_click`/`browser_type` and no Readability run), `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `download_file`, `download_progress`, `run_shell`, `Task` (focused subagent), `get_task_status`, `cancel_task`, `add_source_note`, `get_source_ledger`, `reset_source_ledger`, plus the filesystem set `list_directory`, `read_file`, `search_files`, `search_content` (read-only), `write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file` (mutating).
- **Tool caps:** `ToolCaps { code_exec, fs_roots, web_search, requires_local_sandbox, attached_connectors }` — `code_exec` is gated per-chat; `fs_roots` is the per-session granted-root set for the auto-run permission modes; `web_search` is false for local models (schema-level strip); `requires_local_sandbox` is plumbed end-to-end for `local_gguf`; `attached_connectors` carries live MCP sessions for the per-conversation connector opt-in. Everything else is on when tools enabled.
- **Permission gate (`permission.rs`):** the single `check_permission(mode, tool, path, fs_roots) -> AutoRun|NeedsApproval` function every filesystem tool routes through. `PermissionMode` ∈ `read_only`/`manual`/`auto_edit`/`full_auto` (per-session, on `chat_sessions.permission_mode`, default `manual`). Hard rules enforced here, not in UI copy: reads auto-run in every mode; `delete_file` is **always** gated (every mode); `read_only` strips mutating tools from the tool schema entirely (schema-level exclusion — the model literally cannot call `write_file`); `auto_edit`/`full_auto` auto-run writes/edits within granted roots; `auto_edit` also gates move/copy while `full_auto` auto-runs them. `run_tool` calls this before executing; `NeedsApproval` registers a pending approval + emits `chat:approval-request` and **pauses the turn** on a oneshot until the UI calls `resolve_tool_action(pendingId, approved)`. *Note: the `permission_mode` is honored by the built-in chat AND headless Claude Code (settings-bundle mapping + `can_use_tool` stdio relay); Kimi/OpenCode headless always run at full-auto permission (`--auto` / prompt-mode auto-approve — see §2.5 above) with post-hoc `DiffCard` review. The `PermissionModeMenu` (composer footer, shown for builtin/local/claude_code sessions) + `ApprovalCard`/`FullAutoConfirmModal` (`ApprovalFlow.tsx`) + the approval-rules engine (`permissions.rules` KV, settings panel, "always allow" capture on the card) are all wired.*
- **Automations (`automations.rs` + `db/automations.rs`):** scheduled headless one-shot agent turns fired by a 30s tick loop on `tauri::async_runtime`. Each due automation is launched on its own `std::thread` (the turn is blocking process I/O) via `launch_run`, which records `start_run` → executes via `agent_sessions::run_one_shot` (full-auto permission, since unattended turns can't answer prompts) → finalizes with `finish_run` + `record_run`. **Overlap-skip**: in-process `RUNNING: Mutex<HashSet<String>>` plus a cross-process lock file next to `conduit.db` (`<db>.automation-<id>.lock`, `create_new` for atomicity) prevent double-fires. Stale lock files (older than 6h) are self-healed. Missed windows fire once on the next tick (due-ness is computed from `last_run_at` or `created_at`, not from now). The standalone `bin/conduit_automation.rs` binary reuses the same `run_blocking` path for Windows Task Scheduler integration. Allowed harnesses: `claude_code` | `opencode` (kimi is rejected — `--yolo`/`--auto` are interactive-mode flags that kimi rejects with `-p`).
- **Compaction / context window:** `chat/commands.rs::count_context_tokens` queries the running llama-server's `/tokenize` endpoint for live `usedTokens` / `maxTokens`. The frontend renders a circular SVG ring (`ContextMeter.tsx`, color-tiered green/amber/red). Auto-compaction fires when the local-model turn approaches the cap; summarized rows get `superseded_by` set in `chat_messages` so the send path filters them out while the timeline still returns them — migration `migrate_chat_messages_superseded` adds the column.
- **Code exec:** `codeexec.rs` — python/js/bash in fresh temp dir, 20s timeout, NOT a hard sandbox
- **Python runtime:** `python_runtime.rs` — resolves a bundled python-build-standalone interpreter shipped in the installer's `resource_dir/python` (staged by `scripts/fetch-bundled-python.mjs`). Used by `pygen.rs` (doc gen) and `codeexec.rs` (code exec); degrades silently to system Python when not bundled (e.g. `cargo run` from source). Registered at boot in `lib.rs`.
- **Document gen:** `pygen.rs` (Python-backed docx/pptx/xlsx/pdf via python-docx/python-pptx/openpyxl/reportlab, 90s timeout) + `artifacts.rs` (hand-rolled minimal OpenXML/PDF)
- **Office preview:** `office.rs` — renders docx/pptx/xlsx to self-contained HTML; also extracts text for attachments

### 2.7 Browser Webviews (`browser.rs`)

- **Native child webviews** via `Window::add_child` (Windows/macOS only; Linux → iframe fallback)
- **Label scheme:** `browser-{paneId}-tab-{tabId}`
- **pushState monkey-patch:** injected JS wraps `history.pushState`/`replaceState` + `popstate`/`hashchange` → `browser_push_state`
- **Devtools:** `browser_open_devtools` command opens the native devtools pane for a browser tab
- **Agentic browser:** `read_page` uses a vendored Mozilla `readability.js` (Apache 2.0, v0.6.0, embedded via `include_str!`) to extract clean Markdown via the `bridge_extract.js` wrapper. Supports **four** modes: `full` (complete cleaned article), `summary_only` (headings + first ~1500 chars), `section` (CSS selector or heading text), and `interactive` (accessibility tree — full a11y records per element: role, aria-label, name, id, value, placeholder, checked, disabled, type, rect; no Readability run, markdown empty). Consent/cookie banners are auto-dismissed; lazy-loaded content is surfaced via a bounded scroll loop. Returns structured JSON (`ExtractedContent`) with `markdown`, `title`, `url`, `canonicalUrl`, `publishedDate`, `byline`, `failureReason`, and `elementRefs`. Interactive elements are tagged with `data-conduit-ref` for `browser_click`/`browser_type`. 15s timeout per eval; `ReadOpts` controls settle wait (default 1s) and max scroll steps (default 4).
- **Agent-driven control (conduit-browser-mcp):** a standalone MCP server binary (`src/bin/conduit_browser_mcp.rs`, `[[bin]]` in Cargo.toml, does NOT link Tauri) speaks stdio JSON-RPC to a harness (Claude Code/Kimi Code) and forwards each `tools/call` over a **loopback WebSocket on fixed port 7681** (`BROWSER_MCP_PORT`) to `browser_mcp::serve` (spawned in `lib.rs` setup). Dispatch (`browser_mcp.rs`) runs against the real visible pane via `run_action_for_pane` / `read_page_for_pane` / `resolve_and_click` / `resolve_and_type` / `resolve_and_hover` / `evaluate_for_pane` / `history_for_pane` — the SAME eval bridge the chat tools use. **Browser ops (10):** navigate / read_page / click / type_text / scroll / wait_for / screenshot / history (back|forward) / hover / evaluate / click_and_wait, all with optional `pane_id`; plus **conduit tools (5):** generate_document / generate_diagram / generate_file / get_skill / list_skills. `click_and_wait` snaps the pre-click URL and polls for navigation/selector/network_idle in one round-trip; `evaluate` runs arbitrary page JS and returns a JSON-serialized value; `hover` dispatches real mouseover/mouseenter for `:hover` menus. Pane resolution: explicit pane_id → `pane_active_tab` → label; else `project_id` → `browser:resolve-pane-request` frontend roundtrip (max-`lastUsedAt` browser pane, 5s) → global active. Auto-open: `browser:open-browser-request` roundtrip. Per-project registration via `--mcp-config` (Claude Code; `browser_mcp_register.rs` writes to `<app_data_dir>/mcp/<id>.mcp.json` in `spawn_agent_session`). Frontend hook `useBrowserMcpEvents.ts`. Structured error codes: not_found/nav_failure/timeout/browser_unavailable/invalid_args/pane_not_found.
- **Visual feedback layer:** `bridge_overlay.js` (injected after every nav + lazily per action) installs synthetic cursor/ripple/highlight/caret elements (all `data-conduit-overlay`, excluded from the a11y tagger). `click_js`/`type_js` return Promises: cursor tween (400ms) → highlight → ripple / per-keystroke typing (45ms±15ms with real keydown/keyup/input per char) → real action. `action_wrapper_js` is promise-aware (awaits a returned thenable) and applies watch-mode pacing (600ms) via a `__finish` helper — the tool result reports only after the visual+action chain resolves (race guard). Watch-mode: global `watchMode` setting + per-session nullable `watch_mode` column (mirrors `permission_mode`); backgrounded panes skip pacing (`pane_is_visible`).
- **Known open issue:** `run_action_for_pane`'s result reporting is intermittent against `browser-*` child webviews — `navigate` (tiny body) sometimes returns empty, and `read_page` (large bridge body) times out at 15s. `__TAURI_INTERNALS__.invoke('browser_action_result')` reachability in the child webview needs a devtools check; the `browser_action_result` custom command may need explicit capability allowance for `browser-*` windows.

### 2.8 DB Schema (`db/mod.rs`)

21 tables (6 new since the previous audit: `chat_checkpoints`, `automations`, `automation_runs`, `chat_source_notes`, `connector_credentials`, `chat_session_connectors`, `workspaces`, `doc_corpora`, `doc_files`, `doc_chunks`, `chat_documents`; plus new columns/migrations):

| Table | Key columns |
|---|---|
| `projects` | `id` PK, `path` UNIQUE, `name`, `is_git_repo`, `created_at`, `last_opened_at` |
| `sessions` | `id` PK, `project_id` FK, `harness`, `harness_session_id`, `title`, `worktree_path`, `created_at`, `last_active_at`, `status` |
| `cost_events` | `id` AUTOINCREMENT, `session_id` FK, `timestamp`, `input_tokens`, `output_tokens`, `provider`, `model_key`, `source` (`'pty'`/`'on_disk'`), `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_output_tokens`, `reported_cost_usd`, `pricing_estimated_usd` (write-only audit) |
| `skills` | `id` PK, `name`, `slash_command` UNIQUE, `content`, `scope`, `created_at` |
| `project_secrets` | `project_id` + `key` composite PK, `value_encrypted` BLOB |
| `app_settings` | `key` PK, `value` |
| `quick_actions` | `id` PK, `project_id` FK, `label`, `command`, `keybinding`, `run_on_worktree` |
| `chat_sessions` | `id` PK, `title`, `provider`, `model`, `created_at`, `last_active_at`, `starred`, `unread`, `watch_mode` (NULLABLE), `permission_mode` (DEFAULT 'manual'), `agent` (NULLABLE: `"builtin"` / `"local"` / `"harness:<id>"`) |
| `chat_messages` | `id` AUTOINCREMENT, `chat_session_id` FK (CASCADE), `role`, `content`, `input_tokens`, `output_tokens`, `cost_usd`, `created_at`, `superseded_by` (compacted turn pointer), `started_at`, `completed_at`, `llm_time_ms`, `tool_time_ms`, `ttft_ms`, `tokens_per_second` (per-turn perf metrics populated when the provider returns timing/rate; surfaced in the composer metrics row, see `ComposerMetrics.tsx`) |
| `artifacts` | `id` PK, `chat_session_id`, `chat_message_id`, `filename`, `path`, `kind`, `created_at`, `expires_at` |
| `chat_source_notes` | `id` PK, `chat_session_id` FK, `url`, `title`, `fact`, `excerpt`, `unavailable`, `created_at` |
| `connector_credentials` | `connector_id` PK, `expires_at`, `granted_scopes`, `account_display`, `connected_at` |
| `chat_session_connectors` | `chat_session_id` + `connector_id` composite PK |
| `workspaces` | `id` PK, `project_id` FK, `name`, `data`, `created_at`, `updated_at` |
| `automations` | `id` PK, `name`, `prompt`, `harness`, `model`, `cwd`, `schedule`, `enabled`, `last_run_at`, `last_status`, `chat_session_id`, `created_at` |
| `automation_runs` | `id` PK, `automation_id` FK (CASCADE), `started_at`, `finished_at`, `status`, `summary`, `chat_session_id`, `source` (DEFAULT 'scheduled') |
| `chat_checkpoints` | `id` PK, `chat_session_id` FK, `name`, `message_id`, `created_at` |
| `doc_corpora` | `id` PK, `name`, `path`, `enabled`, `created_at` |
| `doc_files` | `id` PK, `corpus_id` FK, `path`, `size`, `mtime`, `indexed_at` |
| `doc_chunks` | `id` PK, `corpus_id` FK, `file_id` FK, `chunk_index`, `content`, `embedding` BLOB |
| `chat_documents` | `id` PK, `chat_session_id` FK, `corpus_id` FK, `attached_at` |

**Migrations:** `migrate_chat_session_flags` (adds `starred`/`unread`), `migrate_chat_session_watch_mode`, `migrate_chat_session_agent` (adds `agent`, backfills `local_gguf`→`"local"` / else→`"builtin"`), `migrate_chat_session_project_id`, `migrate_artifacts_message_id`, `migrate_chat_messages_superseded` (compaction pointer), `migrate_cost_v2`, `migrate_chat_messages_v2`, `migrate_chat_messages_started_completed` (adds `started_at`/`completed_at`), `migrate_chat_messages_perf` (adds `llm_time_ms`/`tool_time_ms`/`ttft_ms`/`tokens_per_second`), `migrate_unc_paths` (Win only, strips `\\?\` prefix), `migrate_chat_checkpoints`, `migrate_chat_documents`, `migrate_doc_corpora`.

### 2.9 Secrets (`secrets.rs`)

- Windows/macOS: OS keychain via `keyring` crate
- Linux: XOR-obfuscated SQLite fallback (documented deviation from PRD)

### 2.10 Automation Task Commands (`automation_task.rs`)

- **Commands (3):** `get_run_while_closed`, `set_run_while_closed`, `test_automation_webhook`
- Exposes automation task settings and webhook testing outside the main automation CRUD surface.

### 2.11 Docs Index (`docs_index.rs`)

- **Commands (10):** `docs_list_corpora`, `docs_add_corpus`, `docs_remove_corpus`, `docs_start_index`, `docs_cancel_index`, `docs_set_corpus_enabled`, `docs_attached_corpus_ids`, `docs_attach_corpus_to_chat`, `docs_detach_corpus_from_chat`, `docs_embedding_status`
- Powers the document RAG feature: project docs are embedded and attached per-chat for retrieval-augmented generation.

### 2.12 GitHub PR Commands (`github.rs`)

- **Commands (8):** `github_list_prs`, `github_get_pr`, `github_create_pr`, `github_draft_pr_text`, `github_pr_files`, `github_pr_checks`, `github_local_branches`, `github_submit_review`
- Wraps GitHub REST API for PR management inside the Dev panel.

### 2.13 Mobile Relay Commands (`mobile/commands.rs`)

- **Commands (7):** `start_mobile_relay`, `stop_mobile_relay`, `get_mobile_relay_status`, `get_mobile_pairing_info`, `tailscale_serve_enable`, `tailscale_serve_disable`, `tailscale_login`
- Controls the local relay server, Tailscale integration, and mobile pairing flow.

### 2.14 Speech Commands (`speech.rs`)

- **Commands (1):** `transcribe_audio`
- Speech-to-text for voice input.

### 2.15 Worktree Commands (`worktree_cmds.rs`)

- **Commands (2):** `ensure_chat_session_worktree`, `set_chat_session_worktree`
- Creates and assigns git worktrees per chat session.

### 2.16 MCP Gallery (`mcp_gallery.rs`)

- **Commands (6):** `mcp_gallery_list`, `mcp_gallery_install`, `mcp_gallery_remove`, `mcp_gallery_set_enabled`, `mcp_gallery_connect`, `mcp_gallery_disconnect`
- Manages bundled MCP server tools that agents can use.

### 2.17 ACP Agents (`commands/agent_cmds.rs`)

- **Commands (1):** `list_acp_agents`
- Lists available ACP agents for the agent selector.

### 2.18 Auto-Updater (`commands/updater_cmds.rs`)

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
- **Headless CLI chat:** Kimi/OpenCode run at full-auto permission (`--auto` for OpenCode, kimi prompt mode auto-approves by default) with no per-action approval card — edits surface post-hoc as `DiffCard` entries (read-only review). Claude Code honors the session's `permission_mode`: non-full-auto spawns add `--permission-prompt-tool stdio` and the CLI's `can_use_tool` asks relay as normal `ApprovalCard`s; `full_auto` adds `--dangerously-skip-permissions`.

---

## 3. Frontend (`src`)

### 3.1 Entry (`main.tsx` → `App.tsx`)

- Bootstrap loads: `settingsStore.load()` → `projectsStore.loadAll()` → `skillsStore.load()` → `ensureDefaultSkills()` → `wireUpdaterEvents()` + `updaterStore.check()` (also re-checks every 4h via `setInterval`)
- **Active views:** `"chat"` (the single main surface), `"settings"`, `"skills"`, `"cost"`, `"automations"`
- **Sidebar:** one unified column — New Chat, Artifacts, Connectors, Projects (each with nested session rows that open interactive harness panes in the ToolPanel's Terminal tab), Chat history, footer links
- Hooks registered: `useTheme`, `useKeybindings`, `usePtyEvents`, `useChatEvents`, `useGitStatusPolling`

### 3.2 State (Zustand)

| Store | Key state | Key actions |
|---|---|---|
| `projects.ts` | `projects[]`, `sessions[]`, `gitStatuses`, `harnesses[]`, `selectedProjectId` | `loadAll`, `addProjectAtPath`, `createSessionFor`, `refreshGitStatus` (polls all projects) |
| `panes.ts` | `panes[]` (max 6 visible), `focusedPaneId`, `broadcast`, `useCounter`, `focusEpoch`, `spotlightOverride` | `addPane`, `closePane` (→ `disposePaneResources` → `killPty`/`browserClosePane`), `focusPane`, `setSpotlight`, multi-tab browser |
| `chat.ts` | `sessions[]` (incl. `agent`, `permissionMode`, `watchMode`), `activeChatSessionId`, `messages[]`, `loaded`, `streamingChatSessionId`, `config`, `error`, `effort`, `toolsEnabled`, `codeExecEnabled`, `artifacts`, `artifactsByMessage`, `pendingArtifacts`, `previewArtifacts[]` + `activePreviewPath` (multi-tab canvas), `pendingApprovals` | `sendMessage` (routes to `sendAgentChatMessage` when `agent` is `"harness:<id>"`), `setSessionAgent` (writes via `update_chat_session_agent`), `onToken`/`onDone`/`onArtifact`/`onError`/`onApprovalRequest`/`onApprovalResolved`, `cancelStream` (routes to `cancelAgentChatMessage` for harness sessions), `regenerateLast`, `setPreviewArtifact` (open-or-focus tab), `closePreviewArtifact` |
| `automations.ts` | `automations[]`, `runningNow` (id → bool, button-spinner) | `load`, `create`, `update`, `remove`, `setEnabled`, `runNow` (sets `runningNow[id]=true`, fires `run_automation_now`, refreshes after 1.5s) |
| `artifacts.ts` | `items[]` (ArtifactRecord) | `load`, `remove` |
| `skills.ts` | `skills[]` (Relay prompt templates) | CRUD |
| `settings.ts` | `theme`, `dnd`, `keybindings`, `browserUrls` | `load`, `setTheme`, `setDnd`, `setKeybinding`, `lastBrowserUrl`, `rememberBrowserUrl` |
| `ui.ts` | `activeView`, `paletteOpen`, `peek`, `pendingReplace`, `toolPanelTab`, `toolPanelCollapsed`, `toolPanelWidth` | `setActiveView`, `togglePalette`, `openPeek`, `setPendingReplace`, `setToolPanelTab`, `setToolPanelCollapsed`, `setToolPanelWidth` |
| `updater.ts` | `update`, `downloaded`, `total`, `error`, `checking`, `installing` | `check` (every 4h), `startInstall`, `dismiss`, `reset`; `wireUpdaterEvents()` |
| `connector.ts` | `connectors[]`, `sessionConnectors` | `loadConnectors`, `connect`, `disconnect`, `setSessionConnectors` |
| `localModel.ts` | `models[]`, `activeModelId`, `status`, `catalog` | `scanModels`, `startModel`, `stopModel`, `fetchCatalog` |

**Spotlight logic** (pure functions in `state/spotlight.ts`): `activeTerminalId` (override wins, else recency), `cycleTerminalId`, `activeTerminalPair` (top+bottom), `cycleTerminalPair`.

**Tool panel** (`ToolPanel.tsx`, mounted in `App.tsx`): a collapsible right-side column with `terminal | browser | files | pulls | canvas | agents` tabs. Every tab's content stays mounted (display:none when not active) so xterm + pty + native browser webviews keep running. Width is persisted in the `ui` store; left-edge drag handle doubles as the chat|panel splitter. The Canvas tab is the new home for artifact previews (multi-tab browser-style, each preview kept mounted for instant switching).

### 3.3 Panes (`components/panes/`)

> The old 2-column `PaneGrid` / Dev-tab grid was removed with the single-mode layout. Terminal + browser panes now render in single slots inside the ToolPanel, one visible pane per tab with a switcher dropdown.

- **PaneFrame.tsx** — shared frame that mounts a terminal (`TerminalPane`) or browser (`BrowserPane`) pane; hidden panes stay mounted `display:none` (per §6.5, never kill on blur). Also exports `DormantBrowsers` (minimized/collapsed browser panes kept alive via the `visible=false` webview flag).
- **TerminalPane.tsx** — xterm with transparent bg (glass shows through), theme-aware, copy/paste (Ctrl+Shift+C/V), font zoom (Ctrl+scroll), `focusEpoch` re-focus, resume-on-exit overlay. ResizeObserver + debounced refit (50ms).
- **BrowserPane.tsx** — native webview path (bounds tracking + occlusion via `browserOcclusion.ts`) + iframe fallback. Per-tab history, 8s load timeout. Tab bar + URL bar.
- **DevDiffPanel.tsx** — the Files panel (changed-files list + per-file diff + "Send PR" button). Embedded in the ToolPanel's Files tab.
- **ToolPanel.tsx** — right-side collapsible terminal | browser | files | pulls | canvas | agents column (see §3.2).
- **BranchPanel.tsx / ProgressPanel.tsx / PullsPanel.tsx / SubagentPanel.tsx** — Git branch view, download/run progress, PR list, and the live subagent token stream panel (Agents tab).

### 3.4 Chat UI (`components/chat/`)

- **ChatView.tsx** — flex column: scrollable messages + composer. Smart auto-scroll (80px threshold). `ArtifactsMenu` in toolbar. `has-preview` split when the ToolPanel is open with the canvas tab active.
- **ChatComposer.tsx** — Claude-style card. Attachments: images ≤5MB, docs ≤10MB, text ≤512KB. Enter sends, Shift+Enter newline. Auto-grow textarea (max 200px). `AgentMenu` (leftmost chip) + `ModelEffortMenu`. The `+` button opens a popover with "Add files or photos" and "Research a topic" (the latter sets `forceResearch`).
- **AgentMenu.tsx** — agent selector chip: lists installed CLI harnesses (from `listHarnesses`, dimmed if uninstalled) plus the two non-CLI modes (`"builtin"` cloud chat, `"local"` GGUF). Spinner while `listHarnessModels` runs. Value persisted to `chat_sessions.agent` via `update_chat_session_agent`; routing to `sendAgentChatMessage` follows.
- **ModelEffortMenu.tsx** — glass dropdown; the active agent's models (from `harnessModelCatalog` or the live `listHarnessModels` query) populate the rows. Renders a "Local" badge when the session provider is `local_gguf`.
- **DiffCard.tsx** — inline diff review for the agent's file edits (replaces the per-action `ApprovalCard` flow for CLI chat). Shows filename, +/− stats, a 5-line hunk preview, and per-edit "Applied ✓" / "Open in Peek". The card body expands inline (Cursor-style) and collapses on body-click; no per-edit Accept/Reject since harness CLIs run at full-auto.
- **MessageAttachments.tsx** — renders attached images/docs under a message bubble; image thumbnails + file chips with size/type.
- **MessageBubble.tsx** — parses `<think>` and `<tool>` segments. `ThinkingBlock` (collapsible), the `ActivityGroup` / `ActivitySummary` / `ActivityStepRow` collapsed two-level activity summary (one synthesized line per multi-tool run, expandable to ordered step list with per-step args/results), Markdown via `react-markdown` + `remarkGfm`, Mermaid via `MermaidDiagram`, diagrams via `InlineDiagram`, JSX via `JsxPreview`. Edit-tool markers now render as `DiffCard` (no `ToolBlock`). Hover actions: Copy/Edit/Regenerate.
- **MermaidDiagram.tsx** — lazy-loads `mermaid`, debounced render (250ms), theme-aware, `normalizeSvg()` strips solid backgrounds.
- **InlineDiagram.tsx** — sandboxed iframe sized to diagram intrinsic height, scaled to chat width. `ArtifactExportMenu`.
- **JsxPreview.tsx** — Babel transpile in sandboxed iframe (`allow-scripts` only). Tries `export default`, then global names (App, Example, Demo, Main, Component).
- **ArtifactPreviewPane.tsx** — right-side preview (mounted in the ToolPanel Canvas tab), draggable resizer (min 320px), zoom 25%-300%, transform-scale. Handles image/pdf/markdown/office/html/diagram/csv/code/json/text/binary.
- **ArtifactExportMenu.tsx** — Copy PNG, Download PNG, Download SVG. Smart background detection. Variants: `"toolbar"` and `"kebab"`.
- **ContextMeter.tsx** — circular SVG ring under the send button; green < 70%, amber 70–90%, red > 90% of the local-model context window.
- **TaskProgressCard.tsx** — live progress card for `download_file` / `run_shell` background tasks.
- **ChatSessionRow.tsx** — sidebar chat-session row.

> **Restored + wired end-to-end (2026-08-15, `ff0b812f`):** `PermissionModeMenu.tsx` and `ApprovalFlow.tsx` (`ApprovalCard` + `FullAutoConfirmModal`) are live — the menu sits in the composer footer for builtin/local/Claude Code sessions, the approval card docks above the composer, and the `permissionModeMenu.test.tsx` / `permissionModeStore.test.ts` / `approvalRules.test.tsx` suites cover the flow. (An earlier 2026-08 working-tree removal of these files was reverted before ever being committed.)

### 3.5 Sidebar & Overlays

- **Sidebar.tsx** — unified single-mode column: New Chat, Artifacts, Connectors, Projects (nested session rows open interactive harness panes in the ToolPanel's Terminal tab), Chat history. Footer toggles Skills/Cost/Settings/Automations.
- **ProjectItem.tsx** — Git status badge, inline rename, session list, harness chooser, context menu (new session, new worktree, peek diff, settings, rename, remove).
- **SessionRow.tsx** — Live state dot, auto title, harness badge, relative time, delete.
- **ProjectSettingsPanel.tsx** — per-project quick actions + secrets editor.
- **ConnectorGrid.tsx** — connector connect/disconnect grid (used in the Settings Connectors category and the chat's connector picker).
- **ArtifactLibrary.tsx** — Visual cards + file list, search, 30-day retention indicator.
- **CommandPalette.tsx** — Fuzzy search across sessions, projects, actions. Cmd+K.
- **PeekPanel.tsx** — File mode (`readFileText`) / Diff mode (`getGitDiff` + `parseUnifiedDiff`).
- **CostDashboard.tsx** — T3 Code-style usage dashboard: raw token cost hero, per-provider breakdown, daily Cost/Tokens chart (7d/30d/90d toggle), 6-card stats row (incl. cache savings), per-model breakdown table, cost-quality panel. Backed by `useCostRollups.ts` + the new `RangeToggle`/`CostHero`/`DailyChart`/`StatsRow`/`ModelBreakdownTable`/`CostQualityPanel` sub-components.
- **SettingsView.tsx** — 7 categories: Appearance, Assistant (custom prompt + skills), Pricing, Harnesses, Shortcuts, API Keys, Local Models (with the embedded `ModelMarket`).
- **ModelMarket.tsx** — Hugging Face catalog browser + download manager (Settings → Local Models). Paired with `ModelDownloadIndicator.tsx` for live progress.
- **AutomationsView.tsx** + **AutomationRunTable.tsx** — automations list, create/edit form, run-now button, past-runs table.
- **DocumentsLibrary.tsx** — visual file browser for all artifacts (under the chat sidebar).
- **SkillsLibrary.tsx** — Skills CRUD (local + harness `~/.claude/skills` / `~/.agents/skills`).
- **OnboardingBanner.tsx**, **UpdateBanner.tsx**, **UpdateBannerMarkdown.tsx** — install hints + update banner (changelog rendered from the GitHub release body via the dedicated markdown renderer).
- **common/{Modal, GlassSelect, PanelIcon}.tsx** — shared chrome.

### 3.6 IPC (`lib/ipc.ts`)

- `safeInvoke` / `safeListen` — no-op outside Tauri (jsdom tests, plain `vite dev`)
- All commands grouped by subsystem (projects, PTY, browser, git, settings, chat, artifacts, installed skills, local model, connectors, workspaces, mobile relay, local model market, automations, agent, harness-models)
- Updater IPC: `UpdateInfo` / `UpdateProgressPayload` interfaces, `checkForUpdate()`, `downloadAndInstallUpdate()`, `listenUpdaterProgress()`, `listenUpdaterInstalled()`
- `ChatProvider` union: `"anthropic" | "openai" | "openrouter" | "anthropic_compatible" | "openai_compatible" | "local_gguf"`
- `ChatSession` interface includes `starred?: boolean`, `unread?: boolean`, `permissionMode?: string`, `watchMode?: string | null`, `agent?: string | null`
- Headless CLI chat IPC: `sendAgentChatMessage(chatSessionId, content, harnessId, model?, cwd?, projectId?)`, `cancelAgentChatMessage(chatSessionId)`, `listHarnessModels(harnessId)` (returns `HarnessModelConfig { defaultModel, endpoint, models[] }`)
- Automations IPC: `listAutomations`, `createAutomation`, `updateAutomation`, `deleteAutomation`, `setAutomationEnabled`, `runAutomationNow`, `listAutomationRuns(automationId, limit?)`, `countAutomationRuns(automationId)`; types `Automation` + `AutomationInput` + `AutomationRun` are camelCase mirrors of the Rust structs
- Local model IPC: `scanLocalModels()`, `startLocalModel()`, `stopLocalModel()`, `localModelStatus()`, `countContextTokens()`
- Connector IPC: `listConnectors()`, `connectorConnect()`, `connectorConnectFamily()`, `connectorDisconnect()`, `listSessionConnectors()`, `setSessionConnectors()`
- Workspace IPC: `listWorkspaces()`, `saveWorkspace()`, `deleteWorkspace()`
- Mobile relay IPC: `startMobileRelay()`, `stopMobileRelay()`, `getMobileRelayStatus()`
- Local model market IPC: `fetchModelCatalog()`, `startModelDownload()`, `cancelModelDownload()`, `downloadMmproj()`, `deleteDownloadedModel()`, `getMarketSettings()`, `setModelsDirectory()`, `pickModelsDirectory()`, `setHuggingFaceToken()`, `clearHuggingFaceToken()`

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
| `lib/sessionLauncher.ts` | `openSession()`, `newSessionFlow()`, `runQuickAction()`, `respawnPane()` |
| `lib/exportSession.ts` | `exportFocusedSession()` — markdown export via save dialog |
| `lib/harnessModels.ts` | static per-harness `HarnessModel[]` catalog (`CLAUDE_MODELS` / `KIMI_MODELS` / `OPENCODE_EXTRA_MODELS`); `harnessModelCatalog(harnessId)` for the composer dropdown |
| `lib/sanitize.ts` | string-level sanitization for tool-marker contents (defense against embedded `</tool>` close tags, etc.) |
| `lib/syntaxTheme.ts` | Shiki / Prism theme binding to the app's light/dark tokens |
| `lib/syntaxHighlighter.ts` | wraps Shiki/Prism with the project theme + a small set of languages |
| `lib/modelLabel.ts` | id → human label lookup for the model dropdown |
| `lib/contextWindow.ts` | context-meter math (color tier, percentage) |
| `lib/sound.ts` | notification chime (opt-in, settings toggle) |
| `lib/relativeTime.ts` | "3h ago" timestamps |

### 3.8 Tests (`src/test/`)

22 vitest files: `panes`, `spotlight`, `fuzzy`, `browserOcclusion`, `sessionTitle`, `browserHistory`, `skillExpansion`, `keybindings`, `keybindingPhase.repro`, `focusPaneShortcuts.repro`, `paneDomFocus.repro`, `artifactCardThumb`, `inlineDiagramGating`, `messageAttachments`, `activityGrouping`, `modelEffortMenu`, `diffCard`, `modelLabel`, `compactionSettings`, `contextWindow`, `chatPreviewTabs`, `deletedChatTombstone`.

---

## 4. Documentation Gaps (Verified Against Source)

All previously identified gaps have been resolved as of 2026-08-07. The 2026-08 audit (this pass) fixed the following new drift introduced since 2026-08-03:

| Gap | Where | Status |
|---|---|---|
| Headless CLI chat (`agent_sessions.rs`, `harness_bundle.rs`, `harness_config.rs`, `mcp_tools_bridge.rs`) undocumented | `AI_CONTEXT.md` §2.5 / §2.6 / §2.12 | **Fixed** — §2.5 rewritten; new `agent_sessions` module + `HarnessBundlePaths` + `listHarnessModels` documented |
| `automations.rs` + `db/automations.rs` + `commands/automation_cmds.rs` undocumented | `AI_CONTEXT.md` §2 / `CONTRACT.md` | **Fixed** — new §2.6 entry, 8 new commands in §2.2, 2 new DB tables in §2.8, automation IPC + types in §3.6, `automations.ts` store + `AutomationsView` in §3.2 / §3.5 |
| New `AgentMenu` + `DiffCard` + `ToolPanel` + `ConnectorGrid` + `ModelMarket` + `UpdateBannerMarkdown` + `ContextMeter` + `TaskProgressCard` + `ChatSessionRow` + `AutomationRunTable` components not in file map | `AI_CONTEXT.md` §3 / §6 | **Fixed** — listed in §3.4 / §3.5 / §6 |
| Removed `PermissionModeMenu.tsx` / `ApprovalFlow.tsx` still in doc | `AI_CONTEXT.md` §3.4 / §6 | **Fixed** — noted as Removed (2026-08) in §3.4; removed from §6 file map |
| Command count 118 (now 134) | `AI_CONTEXT.md` §2.2 | **Fixed** — 8 automation cmds + `get_chat_db_path` + `update_chat_session_agent` + `send_agent_chat_message` + `cancel_agent_chat_message` + `list_harness_models` + `delete_all_chat_sessions` + `delete_all_artifacts` added |
| Tool count 29 (now 32) | `AI_CONTEXT.md` §2.6 | **Fixed** — `list_skills` + the fourth `browser_read` mode (`interactive`) acknowledged; `search_content` is its own tool (was nested under FS); ledger + browser tool count refreshed |
| DB table count 14 (now 15 + 1 new index) | `AI_CONTEXT.md` §2.8 | **Fixed** — `automations` + `automation_runs` added; `chat_sessions.agent` + `chat_messages.superseded_by` columns + 2 new migrations added |
| `chat_messages.superseded_by` column + `migrate_chat_messages_superseded` not documented | `AI_CONTEXT.md` §2.6 / §2.8 | **Fixed** — compaction section rewritten with `superseded_by` + migration listed |
| `lib/{harnessModels,sanitize,syntaxTheme,syntaxHighlighter,modelLabel,contextWindow,sound}.ts` not in library list | `AI_CONTEXT.md` §3.7 | **Fixed** — all seven added |
| `state/automations.ts` store not in state table | `AI_CONTEXT.md` §3.2 | **Fixed** — row added |
| Test count 14 (now 22) | `AI_CONTEXT.md` §3.8 | **Fixed** — eight new test files listed (`activityGrouping`, `modelEffortMenu`, `diffCard`, `modelLabel`, `compactionSettings`, `contextWindow`, `chatPreviewTabs`, `deletedChatTombstone`); `permissionModeMenu` / `permissionModeStore` removed at the time, since restored by the permission rewire (`ff0b812f`, plus `approvalRules`) |
| `bin/conduit_automation.rs` standalone headless binary not in file map | `AI CONTEXT/AI_CONTEXT.md` §6 | **Fixed** — added under Backend entry |

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
| Backend entry | `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/src/bin/conduit_automation.rs` (headless runner binary) |
| PTY lifecycle | `src-tauri/src/pty/mod.rs` |
| Harness adapters | `src-tauri/src/harness_adapters/{mod,claude_code,kimi_code,opencode}.rs` |
| Per-project harness bundle | `src-tauri/src/harness_bundle.rs` (`HarnessBundlePaths`, `claude_bundle_args`, `kimi_bundle_args`, `opencode_bundle_args`) |
| Harness config discovery | `src-tauri/src/harness_config.rs` (`HarnessModelConfig`, Claude/Kimi/OpenCode config readers + `opencode_live_models`) |
| Headless CLI chat | `src-tauri/src/agent_sessions.rs` (`AgentSessionManager`, persistent-process / per-turn / one-shot paths) |
| Automations scheduler | `src-tauri/src/automations.rs` (tick loop, `launch_run`, `run_blocking`, `validate_schedule`) + `src-tauri/src/commands/automation_cmds.rs` + `src-tauri/src/db/automations.rs` |
| MCP tools bridge | `src-tauri/src/mcp_tools_bridge.rs` (conduit-tools dispatcher invoked by the harness bundle's MCP servers) |
| Chat core | `src-tauri/src/chat/{mod,commands,providers,python_runtime,local_models,permission,office,pygen,artifacts,codeexec,tasks}.rs` |
| Chat prompt/stream/dispatch/proto | `src-tauri/src/chat/{prompts,streaming,dispatch,proto}.rs` |
| Chat tools (registry + impl) | `src-tauri/src/chat/tools/{mod,specs,search,generate,fs,search_content}.rs` |
| Auto-updater | `src-tauri/src/commands/updater_cmds.rs`, `src/state/updater.ts`, `src/components/onboarding/{UpdateBanner,UpdateBannerMarkdown}.tsx` |
| Bundled Python | `src-tauri/src/chat/python_runtime.rs`, `scripts/fetch-bundled-python.mjs` |
| Browser webviews | `src-tauri/src/browser.rs`, `src-tauri/src/commands/browser_cmds.rs`, `src-tauri/src/browser_mcp.rs`, `src-tauri/src/browser_mcp_register.rs` |
| DB schema | `src-tauri/src/db/mod.rs` |
| DB queries | `src-tauri/src/db/{projects,chat,cost,artifacts,settings,skills,secrets,connector_credentials,workspaces,automations,source_ledger}.rs` |
| Git helpers | `src-tauri/src/git.rs`, `src-tauri/src/commands/git_cmds.rs` |
| Secrets | `src-tauri/src/secrets.rs` |
| Mobile relay | `src-tauri/src/mobile/relay.rs`, `src-tauri/src/mobile/commands.rs` |
| Frontend entry | `src/main.tsx`, `src/App.tsx` |
| State stores | `src/state/{projects,panes,chat,artifacts,skills,settings,ui,updater,spotlight,connector,localModel,automations}.ts` |
| Pane components | `src/components/panes/{PaneFrame,TerminalPane,BrowserPane,DevDiffPanel,ToolPanel,BranchPanel,ProgressPanel,PullsPanel,SubagentPanel}.tsx` |
| Chat components | `src/components/chat/{ChatView,ChatComposer,AgentMenu,MessageAttachments,MessageBubble,MermaidDiagram,InlineDiagram,JsxPreview,ArtifactPreviewPane,ArtifactsMenu,ArtifactExportMenu,ModelEffortMenu,ChatSessionRow,DiffCard,ContextMeter,TaskProgressCard}.tsx` |
| Automations components | `src/components/automations/{AutomationsView,AutomationRunTable}.tsx` |
| Sidebar | `src/components/sidebar/{Sidebar,ProjectItem,SessionRow,ArtifactLibrary,ProjectSettingsPanel,ConnectorGrid}.tsx` |
| Documents | `src/components/documents-library/DocumentsLibrary.tsx` |
| Overlays | `src/components/{command-palette/CommandPalette,peek/PeekPanel,onboarding/OnboardingBanner,onboarding/UpdateBanner,cost-dashboard/CostDashboard,settings/SettingsView,settings/ModelMarket,settings/ConnectorIcon,settings/ModelDownloadIndicator,skills-library/SkillsLibrary,common/Modal,common/GlassSelect,common/PanelIcon}.tsx` |
| IPC | `src/lib/ipc.ts` |
| Utilities | `src/lib/{id,sessionTitle,skillExpansion,diff,fuzzy,keybindings,browserHistory,browserOcclusion,sessionLauncher,exportSession,harnessModels,sanitize,syntaxTheme,syntaxHighlighter,modelLabel,contextWindow,sound,relativeTime}.ts` |
| Hooks | `src/hooks/{usePtyEvents,useChatEvents,useGitStatusPolling,useTheme,useKeybindings,useBrowserMcpEvents,useModelDownloadEvents,usePaneMemory,useContextMeter,useSyntaxTheme}.ts` |
| Tests | `src/test/*.{ts,tsx}` |
| Built-in skills | `skills/{docx-skill,pptx-skill,pdf-skill,diagram-html-svg-skill,goal-loop-skill,conduit-chat-system-prompt}.md` — embedded at compile time in `src-tauri/src/installed_skills.rs::builtins()` (slugs: docx, pptx, pdf, diagram, goal, loop; `/loop` is an alias of `/goal` sharing the `goal-loop-skill.md` body) |
| Config | `src-tauri/tauri.conf.json`, `vite.config.ts`, `tsconfig.json`, `index.html` |
| Docs | `AI CONTEXT/{README,PRD,CONTRACT,BUILD_LOG,RELEASE,AI_CONTEXT}.md` |
