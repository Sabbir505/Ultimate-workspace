# Relay — AI Context Document

> **Naming.** "Relay" is the product name on every surface: user-visible strings (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`, sidebar/banner/HTML strings), the Rust crate (`relay`, lib `relay_lib`), the bundle identifier (`dev.relay.app`), the sidecar binaries (`relay-browser-mcp`, `relay-automation`), the MCP server identifiers (`relay-browser`, `relay-tools`), the `RELAY_*` env vars, the NSIS installer filename, the mobile app (`Relay Mobile`, `com.relay.mobile`), and the Windows scheduled-task name (`RelayAutomations`). The only pre-rebrand value kept on purpose is the E2E pairing crypto constant (`conduit-e2e-relay-*`). Existing installs migrate transparently — app data dir, keychain service, DB file, user folders, and the scheduled task all resolve their legacy counterparts (`user_dirs.rs`, `db::db_file_in`, `secrets.rs`) — see `RELEASE.md` for the compatibility matrix.

**Last verified:** 2026-09-05
**Branch:** `master`
**Working tree:** Auto-updater (Tauri plugin-updater + GitHub Releases + `UpdateBanner`), bundled Python runtime (`chat/python_runtime.rs` staged by `scripts/fetch-bundled-python.mjs`) and bundled LibreOffice (`scripts/fetch-bundled-libreoffice.mjs`, office-accurate PDF conversion), local model support (GGUF via llama.cpp sidecar + Hugging Face market), OAuth connectors (Notion / GitHub / Google / Gmail / YouTube / Kiwi), workspace save/restore, mobile relay + Expo companion app (`mobile/`), headless CLI chat (six harnesses — Claude Code / Kimi Code / OpenCode / Pi / Omp / CommandCode — via `agent_sessions.rs` with the per-project harness bundle from `harness_bundle.rs`), the **automations** scheduler (cron-fired headless one-shot turns, `automations.rs` + `db/automations.rs`), persistent user memory (`memory/` + `commands/memory_cmds.rs` + `db/memory.rs`), the self-improving artifacts loop (`improve_engine.rs` + `commands/improve_cmds.rs` + `db/improve.rs`), voice dictation (`commands/stt.rs`), plan mode (`chat/plan.rs`), knowledge / doc-QA (`docs_index.rs` + `chat/docs.rs` + `db/docs.rs`), and budgets (`commands/budget.rs`) are all in place. Doc set is consolidated under `AI CONTEXT/`. Recent shape: chat backend split into focused submodules (`chat/{mod,prompts,proto,dispatch,streaming,plan,compaction,cloud_compact,cache,citation_lint,citation_verify,stream_events,turn_perf,error_class,export}.rs`) and chat tools into `chat/tools/{mod,specs,search,search_content,generate,fs,automations,capabilities}.rs`; per-session permission modes are wired end-to-end (`ff0b812f`) — `PermissionModeMenu` in the composer, `ApprovalCard`/`FullAutoConfirmModal` (`ApprovalFlow.tsx`), the approval-rules engine, and a Claude Code `can_use_tool` stdio relay — alongside the `AgentModelPicker` (composer agent selector) and the `DiffCard` inline review component. UI: floating glass composer over a scrolling transcript, collapsible git sidebar, Git Graph commit table, glass tool-panel slide-out.

This document is the single source of truth for AI assistants working on this codebase. It is grounded in the actual source, not in PRD/BUILD_LOG summaries. When in doubt, trust this doc over the PRD.

---

## 1. What Relay Is

A local-first desktop shell for AI coding agents with ONE unified chat surface (the old separate Dev/Chat tabs were removed in the single-mode layout rework, `d39d5a25`). It does **not** implement its own agent loop for harness CLIs — it orchestrates existing CLI binaries, and adds a direct-HTTP LLM chat backend for the built-in/local agents. "Relay" is the name everywhere — user-visible surfaces and internal identifiers alike (crate, bundle id, installer, mobile app, scheduled task; see the naming note at the top of this file).

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

- **Managed states:** `DbState` (SQLite behind `Mutex`), `PtyState` (`PtyManager`), `BrowserState` (`BrowserManager`), `ChatState` (`ChatManager`), `TaskState` (`chat::tasks::TaskManager`), `chat::plan::PlanState`, `MobileRelayState`, `OAuthFlowsState`, `chat::local_models::LocalModelState`, `commands::local_model_market::DownloadRegistry`, `agent_sessions::AgentSessionState`, `commands::stt::SttState`, `docs_index::IndexRegistry`, `git_watcher::WatcherState`, `mcp_gallery::McpGalleryState`, `BrowserMcpHandle`
- **Plugins:** dialog, notification, fs, opener, updater
- **Boot sequence:** open `<app_data_dir>/relay.db` → sweep expired artifacts (30-day retention) → register Python runtime resource dir → register all managed states → autostart the STT sidecar when enabled (`commands::stt::maybe_autostart`) → spawn mobile relay on a random localhost port → spawn loopback `browser_mcp::serve` WebSocket on an **OS-assigned ephemeral port** (published to `<app_data>/mcp/browser-mcp.json` for sidecar/external discovery; the `BROWSER_MCP_PORT` 7681 constant survives only as a defensive fallback) → start the `automations` scheduler (30s tick) → apply window vibrancy → register **296 commands** (`tauri::generate_handler!` macro, `src-tauri/src/lib.rs:258-577`; 298 `#[tauri::command]` attributes total across the backend)
- **Exit cleanup** (`ExitRequested` / `Exit`): `kill_all()` PTYs, `close_all()` browsers, `cancel_all()` chat streams, `agent_sessions::kill_all()`, `LocalModelState::stop_all()` (via `block_on`), `mobile::relay::stop_relay`

### 2.2 Command Surface (296 registered in `lib.rs`)

```
Projects/sessions (projects::):        list_projects, add_project, remove_project,
                                       rename_project, init_git_repo, list_sessions,
                                       create_session, update_session_title,
                                       delete_session, touch_session
PTY/harnesses (pty_cmds::):            spawn_agent_session, spawn_shell, write_pty,
                                       resize_pty, kill_pty, list_harnesses,
                                       run_harness_login, pane_memory, install_harness,
                                       pty_subscribe
Agents/headless chat (agent_cmds::):   send_agent_chat_message, cancel_agent_chat_message,
                                       list_harness_models, list_acp_agents,
                                       chat_token_subscribe
Browser (browser_cmds::):              browser_create, browser_navigate, browser_push_state,
                                       browser_action_result, browser_go_back,
                                       browser_go_forward, browser_reload, browser_set_bounds,
                                       browser_set_visible, browser_close, browser_close_pane,
                                       browser_open_devtools, browser_open_pane_result,
                                       browser_resolve_pane_result, browser_tab_result,
                                       browser_confirm_result, browser_timeline,
                                       browser_report_title, browser_set_agent_paused,
                                       browser_cancel_agent, browser_clear_site_data,
                                       register_browser_pane_project,
                                       unregister_browser_pane_project
Git (git_cmds::):                      get_git_status, get_git_diff, get_changed_files,
                                       get_git_file_diff, get_git_file_diff_scoped,
                                       get_branch_changed_files, create_worktree,
                                       list_git_branches, create_git_branch,
                                       checkout_git_branch, delete_git_branch, get_git_log,
                                       get_remote_url, git_commit, git_push,
                                       install_git_watcher, refresh_git_watchers,
                                       uninstall_git_watcher
GitHub PRs (github::):                 github_list_prs, github_get_pr, github_create_pr,
                                       github_draft_pr_text, github_pr_files, github_pr_checks,
                                       github_local_branches, github_submit_review
Automations (automation_cmds::):       list_automations, create_automation, update_automation,
                                       delete_automation, set_automation_enabled,
                                       run_automation_now, list_automation_runs,
                                       count_automation_runs, automation_next_fire
Automation task (automation_task::):   get_run_while_closed, set_run_while_closed,
                                       test_automation_webhook
Chat (chat_cmds::):                    list_chat_sessions, create_chat_session,
                                       delete_chat_session, delete_all_chat_sessions,
                                       delete_chat_message, delete_empty_chat_sessions,
                                       update_chat_session_title, generate_chat_title,
                                       set_chat_session_starred, set_chat_session_unread,
                                       update_chat_session_model, update_chat_session_provider,
                                       update_chat_session_watch_mode, update_chat_session_agent,
                                       update_chat_session_policies, set_chat_session_project,
                                       set_chat_session_permission_mode,
                                       set_chat_session_plan_mode, set_chat_default_model,
                                       set_selected_models, get_chat_messages, touch_chat_session,
                                       send_chat_message, cancel_chat_message, resolve_tool_action,
                                       resolve_plan_proposal, resolve_agent_question,
                                       get_agent_actual_model, set_chat_api_key,
                                       delete_chat_api_key, get_chat_config, list_chat_models,
                                       search_chat_messages, get_chat_session_metrics,
                                       persist_chat_command_message, persist_partial_chat_message,
                                       supersede_chat_tail, list_chat_checkpoints,
                                       restore_chat_checkpoint, generate_commit_message,
                                       generate_diff_review, count_context_tokens,
                                       count_context_breakdown, chat_compact_now,
                                       list_compacted_messages, research_citation_report,
                                       docdesign_complete, docdesign_qa_complete, docgen_complete,
                                       get_file_mtime, find_file_by_basename,
                                       is_libreoffice_available, office_accurate_pdf,
                                       warmup_local_prompt, fetch_provider_model_windows,
                                       read_artifact_preview, download_artifact,
                                       download_artifacts_zip, list_artifacts,
                                       list_chat_artifacts, delete_artifact,
                                       delete_all_artifacts, create_artifact_cmd,
                                       update_artifact_cmd, save_artifact_cmd,
                                       generate_artifact_cmd, search_artifacts_cmd,
                                       validate_artifact_cmd, regenerate_artifact_cmd,
                                       get_artifact_context_cmd, scan_local_models,
                                       start_local_model, stop_local_model, local_model_status,
                                       detect_llama_server_path, get_llama_server_path,
                                       set_llama_server_path
Chat export (export::):                export_chat_zip, export_project_zip, import_chat_zip
Data/settings/skills (data::):         get_setting, set_setting, list_skills, create_skill,
                                       update_skill, delete_skill, list_quick_actions,
                                       create_quick_action, update_quick_action,
                                       delete_quick_action, set_secret, delete_secret,
                                       list_secret_keys, get_cost_events, get_cost_rollups,
                                       export_session_markdown, read_file_text,
                                       get_chat_db_path, get_data_paths, set_chat_db_dir,
                                       pop_out_chat, list_workspaces, save_workspace,
                                       delete_workspace
Installed skills (skills_cmds::):      list_installed_skills, list_installed_loops,
                                       read_installed_skill, save_installed_skill,
                                       create_installed_skill, delete_installed_skill,
                                       list_chat_skills, make_installed_global
Connectors (connectors_cmds::):        list_connectors, connector_connect,
                                       connector_connect_family, connector_disconnect,
                                       list_session_connectors, set_session_connectors,
                                       add_session_connector, remove_session_connector
Mobile relay (commands::):             start_mobile_relay, stop_mobile_relay,
                                       get_mobile_relay_status, get_mobile_pairing_info,
                                       tailscale_login, tailscale_serve_enable,
                                       tailscale_serve_disable
Local model market (local_model_market::): fetch_model_catalog, start_model_download,
                                       cancel_model_download, download_mmproj,
                                       delete_downloaded_model, get_market_settings,
                                       set_models_directory, pick_models_directory,
                                       set_hugging_face_token, clear_hugging_face_token,
                                       fetch_model_file_sizes, get_gpu_vram, detect_gpu_power
Docs index (docs_index::):             docs_list_corpora, docs_add_corpus, docs_remove_corpus,
                                       docs_start_index, docs_cancel_index,
                                       docs_set_corpus_enabled, docs_attached_corpus_ids,
                                       docs_attach_corpus_to_chat, docs_detach_corpus_from_chat,
                                       docs_embedding_status
Memory (memory_cmds::):                memory_list, memory_create, memory_update, memory_delete,
                                       memory_purge, memory_export, memory_status,
                                       memory_set_document, memory_document_history,
                                       memory_evidence, memory_recent_ops, memory_set_enabled,
                                       memory_set_extract_model
Self-improvement (improve_cmds::):     list_improve_artifacts, list_improve_versions,
                                       list_improvement_proposals, apply_improvement_proposal,
                                       reject_improvement_proposal,
                                       evaluate_improvement_proposal,
                                       check_improvement_canaries, run_improvement_sweep,
                                       record_artifact_run, record_artifact_feedback,
                                       finish_artifact_runs, set_improve_channel,
                                       get_improve_autonomy, set_improve_autonomy,
                                       list_improve_eval_cases, get_loop_session,
                                       latest_loop_session, loop_session_start,
                                       loop_session_advance, loop_session_finish
Budgets (budget::):                    list_budgets, set_budget, remove_budget, check_budgets,
                                       list_hidden_cost_projects, hide_cost_project,
                                       unhide_cost_project
Speech/STT:                            transcribe_audio, transcribe_cancel (speech::);
                                       stt_status, stt_start, stt_stop, stt_install_server,
                                       stt_set_default, stt_set_auto_start,
                                       stt_set_server_path (stt::)
Worktree (worktree_cmds::):            ensure_chat_session_worktree, set_chat_session_worktree
MCP gallery (mcp_gallery::):           mcp_gallery_list, mcp_gallery_install,
                                       mcp_gallery_remove, mcp_gallery_set_enabled,
                                       mcp_gallery_connect, mcp_gallery_disconnect, kill_all
Updater (updater_cmds::):              check_for_update, download_and_install_update
Misc:                                  os_toast (os_toast::)
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
| `automation:run-started` | `{ automationId, chatSessionId }` | `automations.rs` |
| `browser:confirm-request` | `{ reqId, paneId, op, target, url, riskClass }` | `browser.rs` (risky agent op needs user confirm) |
| `browser:load-completed` | pane label (bare string payload) | `browser.rs` (page load finished) |
| `browser:takeover-request` | `{ paneId, reason, url, … }` | `browser_mcp.rs` (credential field detected → hand control to the user) |
| `browser:timeline-entry` | `{ paneId, entry }` | `browser.rs` (agent action timeline) |
| `browser:title` | `{ paneId, tabId, title }` | `browser.rs` + `commands/browser_cmds.rs` (tab labels/favicon) |
| `chat:citation-report` | citation lint verdicts for the finished turn | `chat/citation_lint.rs` / `chat/citation_verify.rs` |
| `chat:doc-qa` | `{ path, filename, passed[], warnings[], probes[], pageCount, … }` | `chat/docdesign/qa.rs` (render probes for generated documents) |
| `chat:open-preview` | `{ chatSessionId, path, filename }` | `chat/dispatch.rs` (open a generated file in the canvas) |
| `chat:plan-mode` | `{ chatSessionId, active, reason?, label }` | `chat/plan.rs` |
| `chat:plan-proposal` | `{ chatSessionId, pendingId, title, plan }` | `chat/plan.rs` (`present_plan` tool) |
| `chat:plan-accepted` | accepted plan acknowledgment | `chat/plan.rs` / `chat/commands.rs` (`resolve_plan_proposal`) |
| `chat:plan-updated` | live plan step list for the session | `chat/plan.rs` |
| `chat:plan-step-progress` | per-step progress while executing the accepted plan | `chat/dispatch.rs` / `agent_sessions.rs` |
| `chat:question-request` | `{ chatSessionId, pendingId, questions[] }` | `agent_sessions.rs` (`ask_user_questions` → `QuestionCard`) |
| `chat:subagent-spawn` | `{ chatSessionId, id, role, task, prompt }` | `agent_sessions.rs` / `chat/dispatch.rs` (`Task` tool) |
| `chat:subagent-tokens` | `{ chatSessionId, id, … }` streaming subagent tokens | `agent_sessions.rs` / `chat/dispatch.rs` |
| `chat:subagent-done` | subagent finished (session + subagent id) | `agent_sessions.rs` / `chat/dispatch.rs` |
| `docs:index:progress` | per-corpus embedding/index progress | `docs_index.rs` (`PROGRESS_EVENT`) |
| `mobile:session-open-requested` | `{ sessionId }` | `mobile/relay.rs` (phone asks desktop to open a chat session) |
| `project:fs-heartbeat` | keep-alive for project file watching | `git_watcher.rs` |

### 2.4 PTY Subsystem (`pty/mod.rs`)

- **Per pane:** writer thread (mpsc → PTY master), reader thread (raw bytes → `pty:output` + stripped transcript + local URL scan), waiter thread (`try_wait()` → `pty:exit`)
- **State heuristic** (200ms monitor): output → `working`; 1.5s silence → `waiting`; diff-prompt regex match → `diff_ready`; fresh spawn → `idle`
- **Session-id probe:** 120s post-spawn, polls harness on-disk session store every second
- **Usage sync:** every 5s, reads cumulative usage from harness logs, records deltas
- **Kill:** `taskkill /T /F` (Win) then `kill()`; idempotent via `AtomicBool`

### 2.5 Harness Adapters & Bundle

- **Adapters (`harness_adapters/`):** static registry in `mod.rs` mapping six ids — `"claude_code"`, `"kimi_code"`, `"opencode"`, `"pi"`, `"omp"`, `"commandcode"` — in a deterministic `ADAPTER_ORDER` so picker/settings rows don't reshuffle. Per-harness `CommandSpec` builders + parse_session_id from TUI output / on-disk JSONL session store. `resolve_for_spawn` wraps every spec in `cmd.exe /C` on Windows so `.cmd` shims (`claude.cmd`, `kimi.cmd`) actually run; on POSIX it's a no-op. `pricing.rs` carries per-harness pricing helpers.

| Adapter | Binary (npm package) | New | Resume | Session ID |
|---|---|---|---|---|
| Claude Code | `claude` | bare | `--resume <id>` | TUI regex + `~/.claude/projects/<slug>/*.jsonl` probe |
| Kimi Code | `kimi` | bare | `--session <id>` | TUI regex + `~/.kimi-code/session_index.jsonl` |
| OpenCode | `opencode` | bare | `-s <id>` | TUI regex only (no filesystem probe) |
| Pi | `pi` (`@earendil-works/pi-coding-agent`) | bare | `--session <path\|id>` | TUI regex only (no stable on-disk format to probe); auth is the in-TUI `/login` |
| Omp | `omp` (`@oh-my-pi/pi-coding-agent`) | bare | `--resume <id>` | TUI regex only; auth is `omp setup` (or in-TUI `/login`) |
| CommandCode | `commandcode` (npm `command-code`) | bare | `--resume <id>` (also accepts `-r`/`--session`) | TUI regex only; auth is `commandcode login` |

- **Per-project bundle (`harness_bundle.rs`):** every CLI session — headless chat (`agent_sessions.rs`) AND interactive PTY panes (`spawn_agent_session` in `commands/pty_cmds.rs`) — runs against a Relay-owned config bundle written under `<app_data>/harness/<safe-project-id>/`. (The on-disk directory is still `harness/`, the bundle files are still `instructions.md` / `agent.md` / `opencode.json` / etc., and the MCP server names are still `relay-browser` / `relay-tools` — those internal identifiers were intentionally left at the Relay-era names.) The bundle covers Claude (`instructions.md` = environment preamble + skill catalog + browser workflow — NOT the built-in chat's CORE prompt, the CLI keeps its own provider personality; `settings.json`; `mcp.json` registering `relay-browser` + `relay-tools` sidecars), Kimi (`agent.md` with frontmatter, same instructions body, `mcp.json`), and OpenCode (`opencode.json` with the `mcp` section and a `permission` section only for full-auto/headless runs; `OPENCODE_CONFIG` env var on spawn). Permission posture: headless chat maps the session's dual policies (`sandbox_policy` + `approval_policy` — `full_access` approval → `bypassPermissions`, `auto_edit` → `acceptEdits`, `on_request`/unknown → `default`, fail-closed; `read_only` sandbox forces `default`) plus an `mcp__relay-tools__*`/`Bash(git:*)` allow list; interactive PTY panes always spawn with `workspace_write`/`on_request` so the CLI's native TUI prompts stay in charge (no silent bypass), and OpenCode's allow-all permission block is omitted unless approval is `full_access`. Spawn-arg helpers `claude_bundle_args` / `kimi_bundle_args` / `opencode_bundle_args` add `--append-system-prompt-file`, `--settings`, `--mcp-config`, `--allowedTools` (Claude), `--mcp-config-file`, `--agent-file` (skipped on resume — kimi forbids it with `--session`), `--add-dir` (Kimi), or rely on the env var (OpenCode). Bundle write failure degrades to the legacy browser-only MCP config (`browser_mcp_register.rs`). Note: automations one-shots (`run_one_shot` / `run_one_shot_chat`) do NOT use the bundle or the CORE prompt — they carry only the user's custom `assistant.systemPrompt`.
- **Harness config discovery (`harness_config.rs`):** reads each CLI's own settings file (`~/.claude/settings.json` for `ANTHROPIC_BASE_URL` + `ANTHROPIC_DEFAULT_<ALIAS>_MODEL(_NAME)` remaps, `~/.kimi-code/config.toml` for `default_model` + `[providers.*]` + `[models.*]`, `~/.config/opencode/opencode.json` for `model` + `provider.<id>.options.baseURL` + `provider.<id>.models`) and merges with `opencode models` live registry output. Returns `HarnessModelConfig { defaultModel, endpoint, models[] }` with per-model `source` = `"config"` | `"cli"` | `"builtin"`. Empty/failed reads fall back to the static catalog in `src/lib/harnessModels.ts`.

- **Headless CLI chat (`agent_sessions.rs`):** chat sessions whose `agent` is `"harness:<id>"` are backed by real CLI processes (instead of the built-in chat's HTTP calls). Two spawn styles, normalized onto the SAME `chat:token`/`chat:done`/`chat:error`/`chat:artifact` events the built-in chat emits:
  - `claude_code` — one persistent process per chat: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <alias>`. Permission flags follow the session's `permission_mode`: `full_auto` adds `--dangerously-skip-permissions`; every other mode adds `--permission-prompt-tool stdio` so the CLI's `can_use_tool` asks surface as normal `chat:approval-request` cards (relay in `agent_sessions.rs`, deny is fail-closed). Turns are JSON lines on stdin; token deltas via `stream_event` wrappers; `result` event carries the CLI session id + usage + cost. The captured id persists to `app_settings` under `agent.cli_session_id.claude_code.<sid>` so respawns can `--resume`.
  - `kimi_code` / `opencode` — one process per turn: `kimi -p <prompt> --output-format stream-json [-m model] [--session id]` or `opencode run <prompt> --format json [-m provider/model] [-s id] --auto`. The CLI's own session id (from the first turn's output) is passed back on later turns.
  - `run_one_shot` — blocking one-shot self-contained turn at full-auto permission; backs the automations scheduler and the standalone `bin/relay_automation.rs` binary.
  - Tool calls are encoded as `<tool>{json}</tool>` markers inline in the token stream — the same format `MessageBubble` / `DiffCard` and the chat history sanitizer already parse (no frontend changes needed). `MultiEdit` is expanded into one marker per hunk; `Write`/`Edit`/`Bash` aliases are normalized to the same `kind: "edit"|"code"` payload.
  - The harness's per-turn working dir is snapshotted before spawn and diffed after; new/modified previewable files surface as artifacts (mirrors `chat/dispatch.rs`'s tool outcome path) with the `chat:artifact` event.

### 2.6 Chat Subsystem (`chat/`)

- **Core prompt:** lives in `chat/prompts.rs` — `core_prompt_base()`, `core_prompt_strict()` (appended for local models), `core_prompt_for(provider, model)`, `is_research_request()`, `build_system_prompt()`. `mod.rs` re-exports `build_system_prompt` + `is_research_request`. Tool names must match the `tools/mod.rs` registry.
- **Providers:** `Anthropic`, `OpenAI`, `AnthropicCompatible`, `OpenAICompatible`, `OpenRouter`, `LocalGguf` (`chat/providers.rs`)
- **Tool loop (`chat/streaming.rs`):** OpenAI-style (`run_openai_tool_loop`) and Anthropic-style (`run_anthropic_tool_loop`), capped at `MAX_TOOL_ITERS = 45` (non-research) / `RESEARCH_MAX_TOOL_ITERS = 96` (research turns). Each call streams one round (`openai_stream_round`/`anthropic_stream_round`), then runs tool calls and feeds results back until a final answer or the cap. Hermes XML `<tool_calls>` fallback parser (in `chat/proto.rs`) recovers tool calls emitted as plain text by aggregators that don't translate the `tools` field. Wire-protocol helpers (`parse_tool_args`, `parse_hermes_tool_calls`, `strip_hermes_tool_calls`, `tool_block`, `openai_message_json`/`anthropic_message_json`, `next_synthetic_tool_id`) live in `chat/proto.rs`; tool dispatch (`run_tool`, `run_gated_fs_tool`, `run_browser_tool`, `run_ledger_tool`, `emit_token`, `artifacts_dir`) in `chat/dispatch.rs`.
- **Tools (52):** `web_search`, `generate_file`, `generate_document`, `plan_document`, `revise_document`, `generate_diagram`, `fetch_url`, `run_code`, `open_url`, `open_file`, `get_skill`, `list_skills`, `list_artifacts`, `attach_connector`, `attach_mcp_server`, `get_capabilities`, `check_sufficiency`, `todo_write`, `enter_plan_mode`, `present_plan`, `list_automations`, `create_automation`, `update_automation`, `delete_automation`, `run_automation_now`, `search_docs`, `memory_save`, `memory_recall`, `memory_forget`, `browser_read` (modes: `full`/`summary_only`/`section`/`interactive` — interactive returns a full a11y tree with element `ref` ids for `browser_click`/`browser_type` and no Readability run), `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `download_file`, `download_progress`, `run_shell`, `Task` (focused subagent), `get_task_status`, `cancel_task`, `add_source_note`, `get_source_ledger`, `reset_source_ledger`, plus the filesystem set `list_directory`, `read_file`, `search_files`, `search_content` (read-only), `write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file` (mutating).
- **Tool caps:** `ToolCaps { code_exec, fs_roots, web_search, requires_local_sandbox, attached_connectors }` — `code_exec` is gated per-chat; `fs_roots` is the per-session granted-root set for the auto-run permission modes; `web_search` is false for local models (schema-level strip); `requires_local_sandbox` is plumbed end-to-end for `local_gguf`; `attached_connectors` carries live MCP sessions for the per-conversation connector opt-in. Everything else is on when tools enabled.
- **Permission gate (`permission.rs`):** the single `check_permission(mode, tool, path, fs_roots) -> AutoRun|NeedsApproval` function every filesystem tool routes through. `PermissionMode` ∈ `read_only`/`manual`/`auto_edit`/`full_auto` (per-session, on `chat_sessions.permission_mode`, default `manual`). Hard rules enforced here, not in UI copy: reads auto-run in every mode; `delete_file` is **always** gated (every mode); `read_only` strips mutating tools from the tool schema entirely (schema-level exclusion — the model literally cannot call `write_file`); `auto_edit`/`full_auto` auto-run writes/edits within granted roots; `auto_edit` also gates move/copy while `full_auto` auto-runs them. `run_tool` calls this before executing; `NeedsApproval` registers a pending approval + emits `chat:approval-request` and **pauses the turn** on a oneshot until the UI calls `resolve_tool_action(pendingId, approved)`. *Note: the `permission_mode` is honored by the built-in chat AND headless Claude Code (settings-bundle mapping + `can_use_tool` stdio relay); Kimi/OpenCode headless always run at full-auto permission (`--auto` / prompt-mode auto-approve — see §2.5 above) with post-hoc `DiffCard` review. The `PermissionModeMenu` (composer footer, shown for builtin/local/claude_code sessions) + `ApprovalCard`/`FullAutoConfirmModal` (`ApprovalFlow.tsx`) + the approval-rules engine (`permissions.rules` KV, settings panel, "always allow" capture on the card) are all wired.*
- **Automations (`automations.rs` + `db/automations.rs`):** scheduled headless one-shot agent turns fired by a 30s tick loop on `tauri::async_runtime`. Each due automation is launched on its own `std::thread` (the turn is blocking process I/O) via `launch_run`, which records `start_run` → executes via `agent_sessions::run_one_shot` (full-auto permission, since unattended turns can't answer prompts) → finalizes with `finish_run` + `record_run`. **Overlap-skip**: in-process `RUNNING: Mutex<HashSet<String>>` plus a cross-process lock file next to `relay.db` (`<db>.automation-<id>.lock`, `create_new` for atomicity) prevent double-fires. Stale lock files (older than 6h) are self-healed. Missed windows fire once on the next tick (due-ness is computed from `last_run_at` or `created_at`, not from now). The standalone `bin/relay_automation.rs` binary reuses the same `run_blocking` path for Windows Task Scheduler integration. Allowed harnesses: `claude_code` | `opencode` (kimi is rejected — `--yolo`/`--auto` are interactive-mode flags that kimi rejects with `-p`).
- **Compaction / context window:** three compaction paths share `chat/compaction.rs` summarization — the local path (`chat/commands.rs::count_context_tokens` queries the running llama-server's `/tokenize` endpoint for live `usedTokens` / `maxTokens`; auto-compaction fires as a local-model turn approaches the cap), the cloud path (`chat/cloud_compact.rs::compact_and_retry`, wired into the send path in `chat/mod.rs`: on a context-overflow error the oldest turns are summarized and the turn retried), and the harness path (supersede via `supersede_chat_tail`). Summarized rows get `superseded_by` set in `chat_messages` so the send path filters them out while the timeline still returns them — migration `migrate_chat_messages_superseded` adds the column. The frontend renders a circular SVG ring (`ContextMeter.tsx`, color-tiered green/amber/red); `lib/contextWindow.ts` holds the window math (flat 500k cloud/harness default, OpenRouter live window, local slider/auto).
- **Plan mode:** `chat/plan.rs` (`PlanState`) — `enter_plan_mode`/`present_plan` tools, `chat:plan-mode`/`chat:plan-proposal`/`chat:plan-accepted`/`chat:plan-updated`/`chat:plan-step-progress` events, `resolve_plan_proposal` / `set_chat_session_plan_mode` commands; frontend `PlanProposalCard.tsx`, `TurnChangesRow.tsx`, `todo_write`-backed step lists (`usePlanTracker.ts`).
- **Citations:** research turns record sources in `chat_source_notes` (ledger tools `add_source_note`/`get_source_ledger`/`reset_source_ledger`); end-of-turn lint (`chat/citation_lint.rs`) + async precision sampler (`chat/citation_verify.rs`) emit `chat:citation-report`; chips render amber/red in `ChatCitation.tsx` + `CitationReportStrip.tsx`.
- **Code exec:** `codeexec.rs` — python/js/bash in fresh temp dir, 20s timeout, NOT a hard sandbox
- **Python runtime:** `python_runtime.rs` — resolves a bundled python-build-standalone interpreter shipped in the installer's `resource_dir/python` (staged by `scripts/fetch-bundled-python.mjs`). Used by `pygen.rs` (doc gen fallback) and `codeexec.rs` (code exec); degrades silently to system Python when not bundled (e.g. `cargo run` from source). Registered at boot in `lib.rs`.
- **Document gen (JS/HTML-first since 0.4.1):** `jsdocgen.rs` is the Rust half of the JS document bridge — the model authors a program against `docx` (npm) or `PptxGenJS`, executed by the frontend `DocCodeRunner` in a sandboxed iframe (round-trips via the `docgen://run` event + `docgen_complete` command). PDF is authored as HTML and printed by `pdfprint.rs` through a hidden WebView2 + Paged.js + `PrintToPdf` (browser-grade CSS/CJK fidelity). `chat/docdesign/` adds plan/QA stages (`plan_document`/`revise_document` tools + `chat:doc-qa` render probes). `pygen.rs` (Python-backed docx/pptx/xlsx/pdf via python-docx/python-pptx/openpyxl/reportlab, 90s timeout) + `artifacts.rs` (hand-rolled minimal OpenXML/PDF) remain as fallbacks. `office_accurate_pdf` converts through bundled LibreOffice (`is_libreoffice_available` gates it).
- **Office preview:** `office.rs` — renders docx/pptx/xlsx to self-contained HTML; also extracts text for attachments. Frontend previews use `docx-preview` / `pdfjs-dist` (`DocxViewer.tsx` / `PdfViewer.tsx`) with backend fallback.

### 2.7 Browser Webviews (`browser.rs`)

- **Native child webviews** via `Window::add_child` (Windows/macOS only; Linux → iframe fallback)
- **Label scheme:** `browser-{paneId}-tab-{tabId}`
- **pushState monkey-patch:** injected JS wraps `history.pushState`/`replaceState` + `popstate`/`hashchange` → `browser_push_state`
- **Devtools:** `browser_open_devtools` command opens the native devtools pane for a browser tab
- **Agentic browser:** `read_page` uses a vendored Mozilla `readability.js` (Arc90 origin, Apache 2.0 license header — no version marker in the vendored copy; embedded via `include_str!`) to extract clean Markdown via the `bridge_extract.js` wrapper. Supports **four** modes: `full` (complete cleaned article), `summary_only` (headings + first ~1500 chars), `section` (CSS selector or heading text), and `interactive` (accessibility tree — full a11y records per element: role, aria-label, name, id, value, placeholder, checked, disabled, type, rect; no Readability run, markdown empty). Consent/cookie banners are auto-dismissed; lazy-loaded content is surfaced via a bounded scroll loop. Returns structured JSON (`ExtractedContent`) with `markdown`, `title`, `url`, `canonicalUrl`, `publishedDate`, `byline`, `failureReason`, and `elementRefs`. Interactive elements are tagged with `data-relay-ref` for `browser_click`/`browser_type`. 15s timeout per eval; `ReadOpts` controls settle wait (default 1s) and max scroll steps (default 4).
- **Agent-driven control (relay-browser-mcp):** a standalone MCP server binary (`src/bin/relay_browser_mcp.rs`, `[[bin]]` in Cargo.toml, does NOT link Tauri) speaks stdio JSON-RPC to a harness (any of the six) and forwards each `tools/call` over a **loopback WebSocket on an OS-assigned ephemeral port** (published to `<app_data>/mcp/browser-mcp.json` so the sidecar can discover it; `BROWSER_MCP_PORT` 7681 is only a legacy fallback) to `browser_mcp::serve` (spawned in `lib.rs` setup). Dispatch (`browser_mcp.rs`) runs against the real visible pane via `run_action_for_pane` / `read_page_for_pane` / `resolve_and_click` / `resolve_and_type` / `resolve_and_hover` / `evaluate_for_pane` / `history_for_pane` — the SAME eval bridge the chat tools use. The binary advertises **34 tools**: browser ops (`navigate`, `read_page`, `click`, `type_text`, `scroll`, `wait_for`, `screenshot`, `history`, `hover`, `evaluate`, `click_and_wait`, `press_key`, `fill_form`, `select_option`, `zoom`, `find`, `batch`, `new_tab`, `list_tabs`, `switch_tab`, `close_tab`, `print_to_pdf`, `read_console`, `read_network`, `search_docs`) plus relay/document tools (`generate_document`, `plan_document`, `revise_document`, `generate_diagram`, `generate_file`, `list_artifacts`, `get_skill`, `list_skills`, `get_capabilities`), all with optional `pane_id`. `click_and_wait` snaps the pre-click URL and polls for navigation/selector/network_idle in one round-trip; `evaluate` runs arbitrary page JS and returns a JSON-serialized value; `hover` dispatches real mouseover/mouseenter for `:hover` menus; `batch` chains several ops in one call. Pane resolution: explicit pane_id → `pane_active_tab` → label; else `project_id` → `browser:resolve-pane-request` frontend roundtrip (max-`lastUsedAt` browser pane, 5s) → global active. Auto-open: `browser:open-browser-request` roundtrip. Per-project registration via `--mcp-config` (Claude Code; `browser_mcp_register.rs` writes to `<app_data_dir>/mcp/<id>.mcp.json` in `spawn_agent_session`). Frontend hook `useBrowserMcpEvents.ts`. Structured error codes: not_found/nav_failure/timeout/browser_unavailable/invalid_args/pane_not_found.
- **Visual feedback layer:** `bridge_overlay.js` (injected after every nav + lazily per action) installs synthetic cursor/ripple/highlight/caret elements (all `data-relay-overlay`, excluded from the a11y tagger). `click_js`/`type_js` return Promises: cursor tween (400ms) → highlight → ripple / per-keystroke typing (45ms±15ms with real keydown/keyup/input per char) → real action. `action_wrapper_js` is promise-aware (awaits a returned thenable) and applies watch-mode pacing (600ms) via a `__finish` helper — the tool result reports only after the visual+action chain resolves (race guard). Watch-mode: global `watchMode` setting + per-session nullable `watch_mode` column (mirrors `permission_mode`); backgrounded panes skip pacing (`pane_is_visible`).
- **Known open issue:** `run_action_for_pane`'s result reporting is intermittent against `browser-*` child webviews — `navigate` (tiny body) sometimes returns empty, and `read_page` (large bridge body) times out at 15s. `__TAURI_INTERNALS__.invoke('browser_action_result')` reachability in the child webview needs a devtools check; the `browser_action_result` custom command may need explicit capability allowance for `browser-*` windows.

### 2.8 DB Schema (`db/mod.rs`)

42 tables (WAL mode, `journal_mode` set in `db/mod.rs`). Core tables:

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
| `citation_reports` | per-turn citation lint verdicts (research mode) |
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

Knowledge/cache tables: `research_queries`, `search_cache`, `page_cache` (research-mode ledgers + HTTP caches).

Memory tables (`db/memory.rs`): `memories`, `memory_evidence`, `memory_ops`, `memory_document_versions`, `memory_cursor`.

Self-improvement tables (`db/improve.rs`): `improve_artifacts`, `improve_versions`, `improve_channels`, `improve_runs`, `improve_feedback`, `improve_proposals`, `improve_eval_cases`, `improve_eval_runs`, `improve_eval_results`, `improve_canaries`, `improve_events`, plus `loop_sessions` (goal-loop runs).

**Migrations (19 `migrate_*` fns in `db/mod.rs`; `chat_checkpoints`/`chat_documents`/`doc_*` are base-schema tables):** `migrate_chat_session_flags` (adds `starred`/`unread`), `migrate_chat_session_watch_mode`, `migrate_chat_session_agent` (adds `agent`, backfills `local_gguf`→`"local"` / else→`"builtin"`), `migrate_chat_session_project_id`, `migrate_chat_session_permission_mode`, `migrate_chat_session_policies`, `migrate_chat_session_worktree`, `migrate_artifacts_message_id`, `migrate_chat_messages_superseded` (compaction pointer), `migrate_cost_v2`, `migrate_chat_messages_v2`, `migrate_chat_messages_started_completed` (adds `started_at`/`completed_at`), `migrate_chat_messages_perf` (adds `llm_time_ms`/`tool_time_ms`/`ttft_ms`/`tokens_per_second`), `migrate_unc_paths` (Win only, strips `\\?\` prefix), `migrate_chat_fts` (chat full-text search), `migrate_automation_runs_improve_link`, `migrate_improve_autonomy`, `migrate_memory_reflected`, `migrate_source_notes_metadata`.

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

### 2.14 Speech & Dictation (`commands/speech.rs`, `commands/stt.rs`)

- **Speech commands (2):** `transcribe_audio`, `transcribe_cancel` — file-based speech-to-text.
- **Dictation/STT commands (7):** `stt_status`, `stt_start`, `stt_stop`, `stt_install_server`, `stt_set_default`, `stt_set_auto_start`, `stt_set_server_path` — push-to-talk dictation backed by a whisper sidecar. `SttState` (managed in `lib.rs`) autostarts the sidecar at boot when enabled (`commands::stt::maybe_autostart`); partial results stream into the composer textarea.

### 2.15 Worktree Commands (`worktree_cmds.rs`)

- **Commands (2):** `ensure_chat_session_worktree`, `set_chat_session_worktree`
- Creates and assigns git worktrees per chat session.

### 2.16 MCP Gallery (`mcp_gallery.rs`)

- **Commands (7):** `mcp_gallery_list`, `mcp_gallery_install`, `mcp_gallery_remove`, `mcp_gallery_set_enabled`, `mcp_gallery_connect`, `mcp_gallery_disconnect`, `kill_all`
- Manages bundled MCP server tools that agents can use; enabled servers attach their tools to chat turns (`attach_enabled` / `attach_filtered`).

### 2.17 ACP Agents (`commands/agent_cmds.rs`)

- **Commands (5):** `list_acp_agents`, `chat_token_subscribe` (plus the headless-chat trio `send_agent_chat_message`, `cancel_agent_chat_message`, `list_harness_models` registered from the same module)
- Lists available ACP agents for the agent selector; `chat_token_subscribe` is the token-stream subscription for harness turns.

### 2.18 Auto-Updater (`commands/updater_cmds.rs`)

- **Plugin:** `tauri-plugin-updater` — configured in `tauri.conf.json` with a GitHub Releases endpoint and a baked-in public key for signature verification. Signing keypair lives at `.tauri/relay-update.key` / `.key.pub` (gitignored).
- **Commands (2):** `check_for_update` → `UpdateInfo { updateAvailable, version, notes, pubDate }` (GETs `latest.json`, semver compare; network failure treated as "no update"); `download_and_install_update` → downloads, verifies signature, installs; emits `updater:progress` during download and `updater:installed` when the verified package is on disk (app restarts automatically).
- **Frontend:** `state/updater.ts` — Zustand store (`update`, `downloaded`, `total`, `error`, `checking`, `installing`); `wireUpdaterEvents()` hooks the two events. `components/onboarding/UpdateBanner.tsx` — banner with changelog + download/restart button. Bootstrapped in `App.tsx` via `wireUpdaterEvents()` + `check()`, re-checks every 4 hours. Windows install is passive (progress bar, no dialog gauntlet).
- **Release tooling:** `scripts/make-latest-json.mjs` produces the `latest.json` manifest (semver + signature + notes) uploaded alongside each GitHub Release. See `RELEASE.md`.

### 2.19 Bundled Python Runtime (`chat/python_runtime.rs`)

- Resolves a bundled `python-build-standalone` interpreter shipped in the installer's `resource_dir/python`, pre-installed with `python-docx`, `python-pptx`, `openpyxl`, `reportlab` so docx/pptx/xlsx/pdf generation works without a system Python.
- Used by `pygen.rs` (document generation) and `codeexec.rs` (code execution). Output path passed via `RELAY_OUTPUT` env var.
- Staged at build time by `scripts/fetch-bundled-python.mjs` into `src-tauri/resources/python/` (gitignored, ~70 MB). Degrades silently to system Python when not bundled.
- Initialized at app startup (`lib.rs` registers the resource dir).

### 2.20 Safety Notes

- **`unsafe` usage is confined to FFI boundaries** — WebView2 COM interop in `browser.rs` (ICoreWebView2 controllers/visibility), NVML/DXGI GPU probing in `chat/local_models.rs`, Win32 job objects in `automations.rs` + `bin/relay_automation.rs`, and the PDF print path in `chat/pdfprint.rs`. No `unsafe` in business logic.
- **TODO debt:** sandbox-hardening TODOs in `chat/codeexec.rs` (`TODO(landlock)`, `TODO(sandbox-exec)`, `TODO(job+token)`) — the Linux/macOS sandbox layers are not implemented yet.
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
| `chat.ts` | `sessions[]` (incl. `agent`, `permissionMode`, `watchMode`), `activeChatSessionId`, `focusedChatSessionId`, `messages[]`, `hasMoreHistory`, split-view state (`splitChatSessionId`, `splitMessages[]`, `splitHasMoreHistory`), `streamingChatSessionId`, `config`, `error`, `effort`, `toolsEnabled`, `codeExecEnabled`, `artifacts`, `artifactsByMessage`, `pendingArtifacts`, `pendingApprovals` | `sendMessage` (routes to `sendAgentChatMessage` when `agent` is `"harness:<id>"`), `setSessionAgent` (writes via `update_chat_session_agent`), `onToken`/`onDone`/`onArtifact`/`onError`/`onApprovalRequest`/`onApprovalResolved`, `cancelStream` (routes to `cancelAgentChatMessage` for harness sessions), `regenerateLast`, `openChatSplit`/`closeChatSplit` (independent second chat view), `loadOlderMessages` (id-keyset pagination) |
| `automations.ts` | `automations[]`, `runningNow` (id → bool, button-spinner) | `load`, `create`, `update`, `remove`, `setEnabled`, `runNow` (sets `runningNow[id]=true`, fires `run_automation_now`, refreshes after 1.5s) |
| `artifacts.ts` | `items[]` (ArtifactRecord) | `load`, `remove` |
| `skills.ts` | `skills[]` (Relay prompt templates) | CRUD |
| `settings.ts` | `theme`, `dnd`, `keybindings`, `browserUrls` | `load`, `setTheme`, `setDnd`, `setKeybinding`, `lastBrowserUrl`, `rememberBrowserUrl` |
| `ui.ts` | `activeView`, `paletteOpen`, `peek`, `pendingReplace`, `toolPanelTab`, `toolPanelCollapsed`, `toolPanelWidth` | `setActiveView`, `togglePalette`, `openPeek`, `setPendingReplace`, `setToolPanelTab`, `setToolPanelCollapsed`, `setToolPanelWidth` |
| `updater.ts` | `update`, `downloaded`, `total`, `error`, `checking`, `installing` | `check` (every 4h), `startInstall`, `dismiss`, `reset`; `wireUpdaterEvents()` |
| `browserTrust.ts` | agent-browsing trust state (`BrowserConfirmRequest` queue for risky ops) | confirm/deny risky agent browser ops (`browser:confirm-request` roundtrip) |
| `docQa.ts` | design-QA verdicts per artifact path | receives `chat:doc-qa` payloads; preview pane renders the QA strip |
| `notifications.ts` | persisted notification center list (behind the title-bar bell) | add/mark-read/dismiss durable notifications |
| `pullRequests.ts` | per-project PR caches (Pulls tab) | pull-based refresh on mount/visibility, 30s poll while visible |

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
- **ChatComposer.tsx** — Claude-style card. Attachments: images ≤15MB, docs ≤10MB, text ≤512KB. Enter sends, Shift+Enter newline. Auto-grow textarea (max 200px). `AgentModelPicker` (leftmost chip) + `ModelEffortMenu`. The `+` button opens a popover with "Add files or photos" and "Research a topic" (the latter sets `forceResearch`). Voice dictation button (`commands/stt.rs`) types into the textarea.
- **AgentModelPicker.tsx** — agent selector chip: lists installed CLI harnesses (from `listHarnesses`, dimmed if uninstalled) plus the two non-CLI modes (`"builtin"` cloud chat, `"local"` GGUF). Spinner while `listHarnessModels` runs. Value persisted to `chat_sessions.agent` via `update_chat_session_agent`; routing to `sendAgentChatMessage` follows. `agentIcons.tsx` supplies per-harness glyphs.
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
- **SettingsView.tsx** — grouped nav, 6 sections / 16 categories: General (Appearance, Notifications, Assistant, Improvements), Models & Providers (API Keys, Web Search, Local Models with the embedded `ModelMarket`), Agents (Harnesses), Workspace & Safety (Version control, Approval rules), Integrations (Connectors, MCP Servers, Knowledge, Memory, Remote), Storage (Data). Pricing/Shortcuts panels remain reachable from their related sections.
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
| `lib/contextWindow.ts` | context-meter math — flat 500k cloud/harness default (no per-family catalog since 2026-09), OpenRouter live window (capped), local slider/auto; `[context]` debug trace |
| `lib/sound.ts` | notification chime (opt-in, settings toggle) |
| `lib/relativeTime.ts` | "3h ago" timestamps |

### 3.8 Tests (`src/test/`)

100 vitest test files / 733 tests, all passing (verified 2026-09-05 via `npm test`). Coverage spans panes/spotlight/fuzzy/browser helpers, chat flows (permission modes, approval rules, compaction settings, context window, split view, citations), artifacts and canvas preview, automations (incl. harness-install banner), cost dashboard + rollups, memory, doc-design runners, export/import, keybindings, and component suites (`MessageBubble`, `DiffCard`, `ModelEffortMenu`, `AgentModelPicker`, …).

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
| `bin/relay_automation.rs` standalone headless binary not in file map | `AI CONTEXT/AI_CONTEXT.md` §6 | **Fixed** — added under Backend entry |

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
| Backend entry | `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/src/bin/relay_automation.rs` + `src-tauri/src/bin/relay_browser_mcp.rs` (headless runner / browser-MCP sidecar binaries) |
| PTY lifecycle | `src-tauri/src/pty/mod.rs` |
| Harness adapters | `src-tauri/src/harness_adapters/{mod,claude_code,kimi_code,opencode,pi,omp,commandcode,pricing}.rs` |
| Per-project harness bundle | `src-tauri/src/harness_bundle.rs` (`HarnessBundlePaths`, `claude_bundle_args`, `kimi_bundle_args`, `opencode_bundle_args`) |
| Harness config discovery | `src-tauri/src/harness_config.rs` (`HarnessModelConfig`, Claude/Kimi/OpenCode config readers + `opencode_live_models`) |
| Headless CLI chat | `src-tauri/src/agent_sessions.rs` (`AgentSessionManager`, persistent-process / per-turn / one-shot paths) |
| Automations scheduler | `src-tauri/src/automations.rs` (tick loop, `launch_run`, `run_blocking`, `validate_schedule`) + `src-tauri/src/commands/automation_cmds.rs` + `src-tauri/src/automation_task.rs` + `src-tauri/src/db/automations.rs` |
| Memory subsystem | `src-tauri/src/memory/` (extract, consolidate, retrieve, render, scoring, worker, reflect, eval) + `src-tauri/src/commands/memory_cmds.rs` + `src-tauri/src/db/memory.rs` + `src/components/settings/MemoryPanel.tsx` + `src/hooks/useMemoryEvents.ts` |
| Self-improving artifacts | `src-tauri/src/improve_engine.rs` + `src-tauri/src/commands/improve_cmds.rs` + `src-tauri/src/db/improve.rs` + `src/components/settings/ImprovementsPanel.tsx` (design: `SELF_IMPROVING_ARTIFACTS.md`) |
| STT / dictation | `src-tauri/src/commands/stt.rs` (sidecar lifecycle, autostart) + `src-tauri/src/commands/speech.rs` + `src/components/settings/SttPanel.tsx` |
| Budgets | `src-tauri/src/commands/budget.rs` + `src/components/cost-dashboard/BudgetPanel.tsx` + `src/hooks/useBudgetEvents.ts` |
| Plan mode | `src-tauri/src/chat/plan.rs` + `src/components/chat/{PlanProposalCard,TurnChangesRow,QuestionCard}.tsx` + `src/hooks/usePlanTracker.ts` + `src/lib/planParser.ts`, `src/lib/planMatcher.ts` |
| Knowledge / doc-QA | `src-tauri/src/docs_index.rs` + `src-tauri/src/chat/docs.rs` + `src-tauri/src/db/docs.rs` + `src/state/docQa.ts` + `src/components/settings/KnowledgePanel.tsx` |
| MCP tools bridge | `src-tauri/src/mcp_tools_bridge.rs` (relay-tools dispatcher invoked by the harness bundle's MCP servers) |
| Chat core | `src-tauri/src/chat/{mod,commands,providers,python_runtime,local_models,permission,office,pygen,artifacts,codeexec,tasks,plan,compaction,cloud_compact,cache,context_windows,citation_lint,citation_verify,stream_events,turn_perf,error_class,export,jsdocgen,pdfprint}.rs` + `chat/docdesign/` |
| Chat prompt/stream/dispatch/proto | `src-tauri/src/chat/{prompts,streaming,dispatch,proto}.rs` |
| Chat tools (registry + impl) | `src-tauri/src/chat/tools/{mod,specs,search,search_content,generate,fs,automations,capabilities}.rs` |
| Auto-updater | `src-tauri/src/commands/updater_cmds.rs`, `src/state/updater.ts`, `src/components/onboarding/{UpdateBanner,UpdateBannerMarkdown}.tsx` |
| Bundled runtimes | `src-tauri/src/chat/python_runtime.rs`, `scripts/fetch-bundled-python.mjs`, `scripts/fetch-bundled-libreoffice.mjs` |
| Browser webviews | `src-tauri/src/browser.rs`, `src-tauri/src/commands/browser_cmds.rs`, `src-tauri/src/browser_mcp.rs`, `src-tauri/src/browser_mcp_register.rs`, `src/state/browserTrust.ts` |
| DB schema | `src-tauri/src/db/mod.rs` |
| DB queries | `src-tauri/src/db/{projects,chat,cost,cost_v2,artifacts,settings,skills,secrets,connector_credentials,workspaces,automations,source_ledger,checkpoints,docs,research_cache,improve,memory}.rs` |
| Git helpers | `src-tauri/src/git.rs`, `src-tauri/src/commands/git_cmds.rs`, `src-tauri/src/github.rs`, `src-tauri/src/git_watcher.rs`, `src-tauri/src/checkpoints.rs` |
| Secrets | `src-tauri/src/secrets.rs` |
| Mobile | backend relay `src-tauri/src/mobile/{relay,relay_ws,relay_crypto,protocol,tailscale,commands}.rs`; companion app `mobile/` (Expo SDK 57 / RN 0.86; `mobile/src/{components,hooks,lib,screens}`) |
| Frontend entry | `src/main.tsx`, `src/App.tsx` |
| State stores | `src/state/{projects,panes,chat,artifacts,skills,settings,ui,updater,spotlight,automations,browserTrust,docQa,notifications,pullRequests}.ts` |
| Pane components | `src/components/panes/{PaneFrame,TerminalPane,BrowserPane,DevDiffPanel,ToolPanel,BranchPanel,ProgressPanel,PullsPanel,SubagentPanel}.tsx` |
| Chat components | `src/components/chat/{ChatView,ChatComposer,AgentModelPicker,MessageAttachments,MessageBubble,MermaidDiagram,InlineDiagram,JsxPreview,ArtifactPreviewPane,ArtifactsMenu,ArtifactExportMenu,ModelEffortMenu,ChatSessionRow,DiffCard,ContextMeter,TaskProgressCard,PermissionModeMenu,ApprovalFlow,PlanProposalCard,QuestionCard,ChatCitation,CitationReportStrip,CommitModal,GitMenu,GitToolsSidebar,PdfViewer,DocxViewer,DocCodeRunner,TurnNavigator,TypingIndicator}.tsx` |
| Automations components | `src/components/automations/{AutomationsView,AutomationRunTable}.tsx` |
| Sidebar | `src/components/sidebar/{Sidebar,ProjectItem,SessionRow,ArtifactLibrary,ProjectSettingsPanel,ConnectorGrid}.tsx` |
| Documents | `src/components/documents-library/DocumentsLibrary.tsx` |
| Overlays | `src/components/{command-palette/CommandPalette,peek/PeekPanel,onboarding/OnboardingBanner,onboarding/UpdateBanner,cost-dashboard/CostDashboard,cost-dashboard/BudgetPanel,settings/SettingsView,settings/ModelMarket,settings/ConnectorIcon,settings/ModelDownloadIndicator,settings/MemoryPanel,settings/KnowledgePanel,settings/SttPanel,settings/ImprovementsPanel,skills-library/SkillsLibrary,common/Modal,common/GlassSelect,common/PanelIcon}.tsx` |
| IPC | `src/lib/ipc.ts` |
| Utilities | `src/lib/{id,sessionTitle,skillExpansion,diff,fuzzy,keybindings,browserHistory,browserOcclusion,sessionLauncher,exportSession,harnessModels,sanitize,syntaxTheme,syntaxHighlighter,modelLabel,contextWindow,sound,relativeTime,themes,themePresets,planParser,planMatcher,workspaceRestore,notifyCenter,chatCitations}.ts` |
| Hooks | `src/hooks/{usePtyEvents,useChatEvents,useGitStatusPolling,useTheme,useKeybindings,useBrowserMcpEvents,useModelDownloadEvents,usePaneMemory,useContextMeter,useSyntaxTheme,useAutomationEvents,useBudgetEvents,useMemoryEvents,useCostRollups,usePlanTracker,useStreamingText,useViewNav,useNewChatAction,useElementHeight}.ts` |
| Tests | `src/test/*.{ts,tsx}` |
| Built-in skills | `skills/{docx-skill,pptx-skill,pdf-skill,diagram-html-svg-skill,goal-loop-skill,relay-chat-system-prompt}.md` — embedded at compile time in `src-tauri/src/installed_skills.rs::builtins()` (slugs: docx, pptx, pdf, diagram, goal, loop; `/loop` is an alias of `/goal` sharing the `goal-loop-skill.md` body) |
| Config | `src-tauri/tauri.conf.json`, `vite.config.ts`, `tsconfig.json`, `index.html` |
| Docs | `AI CONTEXT/{README,PRD,CONTRACT,BUILD_LOG,RELEASE,AI_CONTEXT,AUDIT,BUG_LIST,BUG_LIST_ROUND2,COST_MODEL_REDESIGN}.md` |
