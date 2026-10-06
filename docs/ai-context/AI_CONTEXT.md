# Relay — AI Context Document

> **Naming.** "Relay" is the product name on every surface: user-visible strings (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`, sidebar/banner/HTML strings), the Rust crate (`relay`, lib `relay_lib`), the bundle identifier (`dev.relay.app`), the sidecar binaries (`relay-browser-mcp`, `relay-automation`), the MCP server identifiers (`relay-browser`, `relay-tools`), the `RELAY_*` env vars, the NSIS installer filename, the mobile app (`Relay Mobile`, `com.relay.mobile`), and the Windows scheduled-task name (`RelayAutomations`). The only pre-rebrand value kept on purpose is the E2E pairing crypto constant (`conduit-e2e-relay-*`). Existing installs migrate transparently — app data dir, keychain service, DB file, user folders, and the scheduled task all resolve their legacy counterparts (`user_dirs.rs`, `db::db_file_in`, `secrets.rs`) — see `RELEASE.md` for the compatibility matrix.

**Last verified:** 2026-10-05
**Branch:** `master`
**Working tree:** Auto-updater (Tauri plugin-updater + GitHub Releases + `UpdateBanner`), bundled Python runtime (`chat/python_runtime.rs` staged by `scripts/fetch-bundled-python.mjs`) and bundled LibreOffice (`scripts/fetch-bundled-libreoffice.mjs`, office-accurate PDF conversion), local model support (GGUF via llama.cpp sidecar + Hugging Face market), OAuth connectors (Notion / GitHub / Google / Gmail / YouTube / Kiwi), workspace save/restore, mobile relay + Expo companion app (`mobile/`), headless CLI chat (six harnesses — Claude Code / Kimi Code / OpenCode / Pi / Omp / CommandCode — via the `agent_sessions/` directory with the per-project harness bundle from `harness_bundle.rs`), the **automations** scheduler (cron-fired headless one-shot turns, `automations.rs` + `db/automations.rs`), persistent user memory (`memory/` + `commands/memory_cmds.rs` + `db/memory.rs`), the self-improving artifacts loop (`improve_engine.rs` + `commands/improve_cmds.rs` + `db/improve.rs`), voice dictation (`commands/stt.rs`), plan mode (`chat/plan.rs`), knowledge / doc-QA (`docs_index.rs` + `chat/docs.rs` + `db/docs.rs`), and budgets (`commands/budget.rs`) are all in place. Doc set is consolidated under `docs/ai-context/`. Recent shape: chat backend split into focused submodules (`chat/{mod,prompts,proto,dispatch,streaming,plan,compaction,cloud_compact,cache,citation_lint,citation_verify,stream_events,turn_perf,error_class,export}.rs`) and chat tools into `chat/tools/{mod,specs,search,search_content,generate,imagegen,fs,vault,automations,capabilities,serp_browser}.rs`; per-session permission modes are wired end-to-end (`ff0b812f`) — `PermissionModeMenu` in the composer, `ApprovalCard`/`FullAutoConfirmModal` (`ApprovalFlow.tsx`), the approval-rules engine, and a Claude Code `can_use_tool` stdio relay — alongside the `AgentModelPicker` (composer agent selector) and the `DiffCard` inline review component. UI: floating glass composer over a scrolling transcript, collapsible git sidebar, Git Graph commit table, glass tool-panel slide-out.

This document is the single source of truth for AI assistants working on this codebase. It is grounded in the actual source, not in PRD/BUILD_LOG summaries. When in doubt, trust this doc over the PRD.

**Recent shape (2026-09-05 → 2026-09-14):** text-to-speech (`commands/tts.rs` + `commands/tts_gpu.rs` — in-process Kokoro-82M via sherpa-onnx, CUDA via a vendor CLI child process), sidebar header art (`commands/appearance_cmds.rs` + `state/appearance.ts` + `SidebarArtPanel.tsx`), the Session Mesh (`session_fabric/` + `db/session_fabric.rs` + `chat/slices mesh` — cross-session awareness/messaging/spawning via five `*_session` chat tools), ACP agents (`acp/` + `acp_agents.rs` — Agent Client Protocol client over stdio), the conversational artifacts pipeline (`artifacts/` dir + `commands/artifact_cmds.rs`, `/create` flow), the stream reconnect ladder (`chat/reconnect.rs` — pinged reconnect instead of a bare stall watchdog), mobile Expo push fallback (`mobile/push.rs`), the exec gate (`exec_gate.rs` — native OS dialog gating renderer-initiated process spawns), `chat/llm_client.rs` (shared one-shot LLM call), `chat/partial_buf.rs` (persist partial streams on quit), and `chat/tools/serp_browser.rs` (WebView SERP fallback). Structural splits: `chat/commands.rs` is now a module root over `chat/commands/{api_keys,approval,artifacts,generators,llama_sidecar,preview,selection,send,sessions}.rs`; `agent_sessions.rs` is now the `agent_sessions/` directory; `src/state/chat.ts` is now `src/state/chat/` (11 slices); `src/lib/ipc.ts` is a barrel over `src/lib/ipc/` (19 domain modules) + `ipcCore.ts`.

**Recent shape (2026-09-14 → 2026-09-21, v0.6.0):** the **Vault** — a bound markdown knowledge base with end-to-end AI CRUD (`vault_*` commands + six chat tools + `relay-tools` bridge, atomic writes with vault-wide link rewrites, FTS with `tag:`/`path:`/`file:` operators), an Obsidian-parity editor (note tabs, callouts, properties, templates, local graph, PDF viewer), and its own sidebar view; **local image generation** (`generate_image` tool + sd-server sidecar + Settings → Local Models → Images); **user hooks** (pre/post tool-call scripts, Claude-Code I/O contract, Settings → Hooks, `hooks_import_claude`); **automation triggers** beyond cron (webhook listener, watched file, git HEAD, new Gmail); **hybrid local search** (`doc_chunks_fts` + vector RRF k=60, optional llama-server reranker); a **live harness model catalog** (the static `src/lib/harnessModels.ts` catalog is gone — the picker runs on live `list_harness_models` discovery with Refresh-from-CLI and provenance badges); **live pricing refresh** (daily LiteLLM registry → `price.lite.db`, `prices_refresh_now`); **app wallpaper** (presets/custom + dim scrim); and a token-efficiency pass II (family-locked attach-on-demand tools + the send-time keyword fast-path `detect_family_unlocks`). New events: `chat:hook-run`, `chat:turn-started`, `automation:approval-request`, `image-gen:update`, `vault:changed`/`vault:scanned`/`vault:scan-error`. Structural: new modules `vault/`, `hooks.rs`, `automation_triggers.rs`, `automation_webhook.rs`, `pricing_live.rs`, `commands/image_gen.rs`, `chat/tools/{vault,imagegen}.rs`, `chat/subagent_model.rs`; frontend `src/state/{vault,imageGenStore,buildUpdates}.ts`, `src/components/vault/`, and `src/lib/ipc/` now at 23 domain modules.

---

## 1. What Relay Is

A local-first desktop shell for AI coding agents with ONE unified chat surface (the old separate Dev/Chat tabs were removed in the single-mode layout rework, `d39d5a25`). It does **not** implement its own agent loop for harness CLIs — it orchestrates existing CLI binaries, and adds a direct-HTTP LLM chat backend for the built-in/local agents. "Relay" is the name everywhere — user-visible surfaces and internal identifiers alike (crate, bundle id, installer, mobile app, scheduled task; see the naming note at the top of this file).

**One main surface (`ChatView`), fed by three chat backends plus interactive PTY panes in the right-side ToolPanel:**

| Surface | Chat session `agent` value | Mechanism | Key events |
|---|---|---|---|
| Built-in cloud chat | `"builtin"` | HTTP/SSE to Anthropic/OpenAI/OpenRouter/compatible providers; tool loop | `chat:token`, `chat:done`, `chat:error`, `chat:artifact`, `chat:open-browser` |
| Local GGUF | `"local"` | llama.cpp sidecar (OpenAI wire format) | same |
| Headless harness CLI | `"harness:<id>"` | persistent `claude -p` stream-json process / per-turn `kimi` / `opencode run` (`agent_sessions/`) | same, plus `chat:approval-request` |
| Interactive harness pane | n/a (`sessions` table) | Sidebar session row → PTY spawn, resume by session ID; terminal renders in the ToolPanel's Terminal tab | `pty:output`, `pty:state`, `pty:exit`, `session:harness-id`, `cost:updated`, `browser:url_detected` |

**Stack:** Tauri v2 (Rust) + React 18/TypeScript + Zustand + xterm.js + SQLite (rusqlite) + window-vibrancy (acrylic on Win, frosted on macOS)

---

## 2. Backend (`src-tauri/src`)

### 2.1 Entry Point (`lib.rs`)

- **Managed states:** `DbState` (SQLite behind `Mutex`), `PtyState` (`PtyManager`), `BrowserState` (`BrowserManager`), `ChatState` (`ChatManager`), `TaskState` (`chat::tasks::TaskManager`), `chat::plan::PlanState`, `MobileRelayState`, `OAuthFlowsState`, `chat::local_models::LocalModelState`, `commands::local_model_market::DownloadRegistry`, `agent_sessions::AgentSessionState`, `commands::stt::SttState`, `commands::image_gen::ImageGenState`, `session_fabric::FabricState`, `commands::tts::TtsState`, `docs_index::IndexRegistry`, `git_watcher::WatcherState`, `vault::VaultState`, `mcp_gallery::McpGalleryState`, `automation_webhook::WebhookServerHandle`, `BrowserMcpHandle`
- **Plugins:** dialog, notification, fs, opener, updater
- **Boot sequence:** register the hooks lifecycle listeners when enabled (`chat:done`/`chat:error` → `hooks::lifecycle_detached(TurnComplete)`, see `hooks.rs`) → open `<app_data_dir>/relay.db` (or the `storage.dbDir` override) → sweep expired artifacts (30-day retention) → sweep orphaned sidecars from a force-killed previous run (`sidecar_sweep.rs`: llama-server / whisper-server / sd-server) → register the bundled Python + LibreOffice resource dirs → pre-create the hidden HTML→PDF print window (Windows) → register all managed states (incl. the `sd-server` orphan sweep from a force-killed previous run, via `<app_data>/sd-server.pid`) → autostart the STT sidecar when enabled (`commands::stt::maybe_autostart`) → preload the TTS engine when enabled (`commands::tts::maybe_preload`) → spawn mobile relay on a random localhost port → spawn loopback `browser_mcp::serve` WebSocket on an **OS-assigned ephemeral port** (published to `<app_data>/mcp/browser-mcp.json` for sidecar/external discovery; the `BROWSER_MCP_PORT` 7681 constant survives only as a defensive fallback) → start the `automations` scheduler (30s tick; also evaluates git triggers) → start the inbound webhook listener (`automation_webhook.rs`, loopback ephemeral port, `/trigger/<id>/<secret>`) → start the LLM log gateway on a loopback ephemeral port when enabled (`llm_log/gateway.rs`) → budget alert timer (first check at 3 min, then every 5 min) → live pricing refresh (~60s after boot, then daily — `pricing_live.rs`) → apply window vibrancy → register **425 commands** (`tauri::generate_handler!` macro, `src-tauri/src/lib.rs:691-1155`; 424 real `#[tauri::command]` attributes across the backend — 200 `#[tauri::command(async)]` + 224 plain `#[tauri::command]`. A naive grep for `#[tauri::command` also matches 6 doc/comment mentions, which inflates the count to 430)
- **Exit cleanup** (`ExitRequested` / `Exit`): drain + persist in-flight partial turns (`chat::partial_buf`), `kill_all()` PTYs, `close_all()` browsers, `cancel_all()` chat streams, `agent_sessions::kill_all()`, `kill_one_shot_children()` (automation CLI trees), `LocalModelState::stop_all()` (via `block_on`, 3s bound), `stt::stop_sidecar` (2s bound), `image_gen::stop_sidecar` (2s bound), `tts::unload()` (drops the Kokoro ONNX session), `mobile::relay::stop_relay`, `mcp_gallery::kill_all`, and `abort()` on the `BrowserMcpHandle` + `automation_webhook::WebhookServerHandle` tasks

### 2.2 Command Surface (425 registered in `lib.rs`)

```
Projects/sessions (projects::):        list_projects, add_project, remove_project,
                                       rename_project, init_git_repo, list_sessions,
                                       create_session, update_session_title,
                                       delete_session, touch_session
PTY/harnesses (pty_cmds::):            spawn_agent_session, spawn_shell, write_pty,
                                       resize_pty, kill_pty, list_harnesses,
                                       check_harness_updates, run_harness_login,
                                       pane_memory, install_harness, pty_subscribe
Agents/headless chat (agent_cmds::):   send_agent_chat_message, cancel_agent_chat_message,
                                       reconcile_agent_sessions, list_harness_models,
                                       list_acp_agents, chat_token_subscribe,
                                       list_harness_subagents
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
GitHub Issues (github::):              github_list_issues, github_get_issue,
                                       github_create_issue, github_list_issue_comments,
                                       github_add_issue_comment, github_set_issue_state;
                                       PAT auth: github_set_pat, github_clear_pat,
                                       github_has_pat
Automations (automation_cmds::):       list_automations, create_automation, update_automation,
                                       delete_automation, set_automation_enabled,
                                       run_automation_now, stop_automation_run,
                                       list_automation_runs, count_automation_runs,
                                       automation_next_fire, automation_webhook_info
Automation task (automation_task::):   get_run_while_closed, set_run_while_closed,
                                       test_automation_webhook
Chat (chat_cmds::):                    list_chat_sessions, create_chat_session,
                                       fork_chat_session,
                                       delete_chat_session, delete_all_chat_sessions,
                                       delete_chat_message, delete_empty_chat_sessions,
                                       update_chat_session_title, generate_chat_title,
                                       set_chat_session_starred, set_chat_session_unread,
                                       update_chat_session_model, update_chat_session_provider,
                                       update_chat_session_watch_mode, update_chat_session_agent,
                                       update_chat_session_effort, update_chat_session_policies,
                                       set_chat_session_auto, set_chat_session_project,
                                       set_chat_session_permission_mode, set_chat_session_cwd,
                                       set_chat_session_plan_mode, set_chat_default_model,
                                       set_selected_models, get_chat_messages, touch_chat_session,
                                       send_chat_message, cancel_chat_message, resolve_tool_action,
                                       resolve_plan_proposal, resolve_agent_question,
                                       get_agent_actual_model, set_chat_api_key,
                                       delete_chat_api_key, get_chat_config, list_chat_models,
                                       list_chat_instances, search_chat_messages,
                                       get_chat_session_metrics,
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
                                       delete_all_artifacts, open_artifact_external,
                                       set_search_api_key, has_search_api_key,
                                       delete_search_api_key,
                                       scan_local_models,
                                       start_local_model, stop_local_model, local_model_status,
                                       detect_llama_server_path, get_llama_server_path,
                                       set_llama_server_path
Conversational artifacts (artifact_cmds::):
                                       generate_artifact_cmd, validate_artifact_cmd,
                                       create_artifact_cmd, regenerate_artifact_cmd,
                                       save_artifact_cmd, search_artifacts_cmd,
                                       update_artifact_cmd, get_artifact_context_cmd
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
                                       regen_mobile_pairing_token, tailscale_login,
                                       tailscale_serve_enable, tailscale_serve_disable
Local model market (local_model_market::): fetch_model_catalog, start_model_download,
                                       cancel_model_download, download_mmproj,
                                       delete_downloaded_model, get_market_settings,
                                       set_models_directory, pick_models_directory,
                                       set_hugging_face_token, clear_hugging_face_token,
                                       fetch_model_file_sizes, get_gpu_vram, detect_gpu_power
Docs index (docs_index::):             docs_list_corpora, docs_add_corpus, docs_remove_corpus,
                                       docs_start_index, docs_cancel_index, docs_start_reranker,
                                       docs_set_corpus_enabled, docs_attached_corpus_ids,
                                       docs_attach_corpus_to_chat, docs_detach_corpus_from_chat,
                                       docs_embedding_status, docs_list_embedding_models,
                                       docs_set_embedding_model
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
                                       loop_session_advance, loop_session_finish,
                                       get_artifact_costs, list_improve_pack_health,
                                       set_improve_case_quarantine
Budgets (budget::):                    list_budgets, set_budget, remove_budget, check_budgets,
                                       list_hidden_cost_projects, hide_cost_project,
                                       unhide_cost_project
Speech/STT:                            transcribe_audio, transcribe_cancel (speech::);
                                       stt_status, stt_start, stt_stop, stt_install_server,
                                       stt_set_default, stt_set_auto_start,
                                       stt_set_server_path, stt_set_device,
                                       stt_install_cuda (stt::)
TTS/read-aloud (commands::tts):        tts_status, tts_speak, tts_preload, tts_unload,
                                       tts_install_model, tts_set_model, tts_set_voice,
                                       tts_set_speed, tts_set_auto_read, tts_set_device,
                                       tts_set_keep_loaded; GPU synthesis (tts_gpu::):
                                       tts_gpu_status, tts_install_gpu
Appearance (appearance_cmds::):        sidebar art — import_sidebar_art, set_sidebar_art_preset,
                                       read_sidebar_art_data, clear_sidebar_art,
                                       get_sidebar_art_path; app wallpaper —
                                       import_app_wallpaper, set_app_wallpaper_preset,
                                       read_app_wallpaper_data, clear_app_wallpaper
Worktree (worktree_cmds::):            ensure_chat_session_worktree, set_chat_session_worktree
MCP gallery (mcp_gallery::):           mcp_gallery_list, mcp_gallery_install,
                                       mcp_gallery_remove, mcp_gallery_set_enabled,
                                       mcp_gallery_connect, mcp_gallery_disconnect;
                                       public registry (mcp_gallery::):
                                       mcp_registry_search, mcp_registry_install
Project wiki (wiki::commands):        wiki_list_all, wiki_get, wiki_read_page,
                                       wiki_build_start, wiki_cancel, wiki_update,
                                       wiki_remove
Declarative subagents (commands/subagent_cmds.rs):
                                       list_subagents, get_subagent, create_subagent,
                                       update_subagent, delete_subagent, run_subagent,
                                       export_subagents, import_subagent,
                                       import_harness_subagent, sync_harness_subagents,
                                       unlink_native_subagent, list_subagent_runs
LLM request log + gateway (llm_log::commands, 12):
                                       llm_log_list, llm_log_get, llm_log_stats,
                                       llm_log_clear, llm_log_prune, llm_log_config_get,
                                       llm_log_config_set, gateway_status, gateway_probe,
                                       gateway_set_targets, gateway_set_default_target,
                                       gateway_set_require_auth
Skills gallery (skills_gallery.rs):   list_skill_gallery, verify_skill_gallery_entry;
                                       data:: install_skill_from_url
App self-control (app_ui.rs):         app_ui_result
Automation templates:                 list_automation_templates
Vault (vault::):                       vault_get_state, vault_bind, vault_unbind, vault_rescan,
                                       vault_tree, vault_read_note, vault_read_binary,
                                       vault_create_note, vault_write_note, vault_delete_note,
                                       vault_move_file, vault_import_file, vault_write_binary,
                                       vault_rename_note, vault_create_folder,
                                       vault_delete_folder, vault_search, vault_note_meta,
                                       vault_graph, vault_all_tags, vault_stats
Local image gen (image_gen::):         image_gen_status, image_gen_start, image_gen_stop,
                                       image_gen_install, image_gen_set_default,
                                       image_gen_set_file_role, image_gen_set_file_layout,
                                       image_gen_select, image_gen_use_family,
                                       image_gen_family_plans, image_gen_set_device,
                                       image_gen_set_server_path, image_generate
Hooks (hooks_cmds::):                  hooks_test, hooks_import_claude
Build/runtime updates:                 check_build_updates (build_updates::);
                                       llama_install_cuda (llama_build::)
Pricing:                               prices_refresh_now (pricing_cmds::)
Updater (updater_cmds::):              check_for_update, download_and_install_update
Misc:                                  os_toast (os_toast::)
```

### 2.3 Events (backend → frontend)

| Event | Payload | Emitted from |
|---|---|---|
| `pty:output` | `{ paneId, data }` | `pty/mod.rs` reader thread |
| `pty:exit` | `{ paneId, code }` | `pty/mod.rs` waiter thread |
| `pty:crashed` | `{ paneId, thread, reason }` | `pty/mod.rs` — a pane's reader/writer/waiter thread panicked; frontend shows the crash overlay (Resume respawns) |
| `pty:state` | `{ paneId, state }` | `pty/mod.rs` monitor thread |
| `session:harness-id` | `{ sessionId, harnessSessionId }` | `pty/mod.rs` (regex or filesystem probe) |
| `cost:updated` | `{ sessionId, version }` | `pty/mod.rs` (usage sync; version 2 = current rollup shape) |
| `browser:url_detected` | `{ paneId, url }` | `pty/mod.rs` (local URL scan in terminal output) |
| `browser:navigated` | `{ paneId, tabId, url }` | `browser.rs` + `commands/browser_cmds.rs` |
| `chat:token` | `{ chatSessionId, token }` | `chat/stream_events.rs` (SSE stream) |
| `chat:done` | `{ chatSessionId, inputTokens, outputTokens, costUsd }` | `chat/mod.rs` |
| `chat:error` | `{ chatSessionId, message, code }` | `chat/mod.rs` |
| `chat:artifact` | `{ chatSessionId, path, filename }` | `chat/mod.rs` |
| `chat:open-browser` | `{ chatSessionId, url }` | `chat/mod.rs` (from `open_url` tool) |
| `chat:status` | `{ chatSessionId, status, reason? }` | `chat/stream_events.rs` (reasons include `context_compacted`, plus the reconnect ladder's `reconnecting`/`reconnect_restart`/`reconnected` from `chat/reconnect.rs`) |
| `chat:task-progress` | `{ chatSessionId, taskId, kind, status, detail? }` | `chat/streaming.rs` |
| `chat:perf` | `{ chatSessionId, metrics }` | `chat/streaming.rs` |
| `chat:approval-request` | `{ chatSessionId, pendingId, tool, summary, args }` | `chat/permission.rs` |
| `chat:approval-resolved` | `{ chatSessionId, pendingId, approved }` | `chat/permission.rs` |
| `browser:resolve-pane-request` | `{ reqId, projectId }` | `browser_mcp.rs` (MCP roundtrip) |
| `browser:open-browser-request` | `{ reqId, projectId, url? }` | `browser_mcp.rs` (MCP roundtrip) |
| `browser:activity` | `{ paneId, tabId }` | `browser.rs` (page load activity) |
| `oauth:callback` | `{ connectorId, code, state }` | `connectors/mod.rs` |
| `mobile:pairing-token` | `{ token }` | `mobile/relay.rs` |
| `local-model:download:progress` | `{ modelId, downloaded, total, status }` | `local_model_market.rs` |
| `updater:progress` | `{ downloaded, total }` (`total` may be null) | `commands/updater_cmds.rs` (download stream) |
| `updater:installed` | `{}` | `commands/updater_cmds.rs` (post-install, app restarts) |
| `automation:run-finished` | `{ automationId, runId, status }` | `automations.rs` |
| `project:fs-changed` | `{ path }` | `git_watcher.rs` |
| `budget:alert` | `{ budgetId, remaining }` | `commands/budget.rs` |
| `checkpoint:created` | `{ chatSessionId, checkpointId }` | `checkpoints.rs` |
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
| `chat:plan-step-progress` | per-step progress while executing the accepted plan | `chat/dispatch.rs` / `agent_sessions/` |
| `chat:question-request` | `{ chatSessionId, pendingId, questions[] }` | `agent_sessions/` (`ask_user_questions` → `QuestionCard`) |
| `chat:subagent-spawn` | `{ chatSessionId, id, role, task, prompt }` | `agent_sessions/` / `chat/dispatch.rs` (`Task` tool) |
| `chat:subagent-tokens` | `{ chatSessionId, id, … }` streaming subagent tokens | `agent_sessions/` / `chat/dispatch.rs` |
| `chat:subagent-done` | subagent finished (session + subagent id) | `agent_sessions/` / `chat/dispatch.rs` |
| `docs:index:progress` | per-corpus embedding/index progress | `docs_index.rs` (`PROGRESS_EVENT`) |
| `mobile:session-open-requested` | `{ sessionId }` | `mobile/relay.rs` (phone asks desktop to open a chat session) |
| `project:fs-heartbeat` | keep-alive for project file watching | `git_watcher.rs` |
| `memory:updated` | memory store changed (extraction/consolidation landed) | `memory/worker.rs` |
| `chat:session-spawn` | `{ parentSessionId, childSessionId, title, agent }` | `session_fabric/mod.rs` (an agent spawned a child chat session — Session Mesh) |
| `chat:session-mail` | `{ mailId, fromSession, fromTitle, toSession, toTitle, mode, status, bodyExcerpt, answerExcerpt?, depth }` | `session_fabric/mod.rs` (Session Mesh inter-session mail transition; one event covers both parties) |
| `chat:turn-started` | `{ chatSessionId }` | `chat/commands/approval.rs` (an uninitiated follow-up turn begins — pre-creates the streaming entry) |
| `chat:hook-run` | `{ chat_session_id, event, hookName, tool, verdict, exitCode, timedOut, … }` | `hooks.rs` (hook execution report; `verdict: "ask-dropped"` = a pre-hook `ask` degraded under full_auto) |
| `automation:approval-request` | `{ source, name, schedule, harness }` | `mcp_tools_bridge.rs` (a harness-created automation lands disabled, waiting on a human) |
| `image-gen:update` | `{ phase: "starting"\|"rendering"\|"done"\|"error", owner?, step?, total?, width?, height?, path?, dataUri?, error? }` | `commands/image_gen.rs` (local image-generation progress; `owner` = owning chat session) |
| `vault:changed` | `{ paths }` | `vault/mod.rs` (watcher saw note changes on disk) |
| `vault:scanned` / `vault:scan-error` | `{ notes, ms }` / `{ error }` | `vault/mod.rs` (full-scan completion / failure) |
| `wiki:build:progress` | per-project wiki build progress | `wiki/mod.rs` (`PROGRESS_EVENT`) |
| `llm-log:appended` | a local-model exchange was captured | `chat/mod.rs` + `llm_log/{mod,gateway}.rs` |
| `browser:url-changed` | `{ paneId, tabId, url }` | `browser.rs` + `commands/browser_cmds.rs` (distinct from `browser:navigated` so the frontend can show a spinner without re-entering the nav handler) |
| `browser:crashed` | `{ paneId, tabId, reason }` | `browser.rs` |
| `app-ui:census-reset` | the app self-control element census was invalidated | `app_ui.rs` |
| `harness:subagents-changed` | the harness-native subagent registry changed | `commands/subagent_cmds.rs` |
| `subagent:approval-request` | a subagent tool call needs approval | `mcp_tools_bridge.rs` |
| `fs:file-changed` | a watched file changed on disk | `git_watcher.rs` (consumed by `harness_subagent_watch.rs`) |
| `chat:session-updated` | `{ sessionId }` a chat session changed | `mobile/session_chat.rs` |
| `browser:{switch,new,close}-tab-request` | `{ reqId, … }` tab-management MCP roundtrip | `browser/tabs.rs` (name built with `format!("browser:{kind}-tab-request")`) |

### 2.4 PTY Subsystem (`pty/mod.rs`)

- **Per pane:** writer thread (mpsc → PTY master), reader thread (raw bytes → `pty:output` + stripped transcript + local URL scan), waiter thread (`try_wait()` → `pty:exit`). All three are wrapped in `catch_unwind` — a panic emits `pty:crashed` instead of silently freezing the pane (Round-3 M1, 2026-09-06)
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

- **Per-project bundle (`harness_bundle.rs`):** every CLI session — headless chat (`agent_sessions/`) AND interactive PTY panes (`spawn_agent_session` in `commands/pty_cmds.rs`) — runs against a Relay-owned config bundle written under `<app_data>/harness/<safe-project-id>/`. (The on-disk directory is still `harness/`, the bundle files are still `instructions.md` / `agent.md` / `opencode.json` / etc., and the MCP server names are still `relay-browser` / `relay-tools` — those internal identifiers were intentionally left at the Relay-era names.) The bundle covers Claude (`instructions.md` = environment preamble + skill catalog + browser workflow — NOT the built-in chat's CORE prompt, the CLI keeps its own provider personality; `settings.json`; `mcp.json` registering `relay-browser` + `relay-tools` sidecars), Kimi (`agent.md` with frontmatter, same instructions body, `mcp.json`), and OpenCode (`opencode.json` with the `mcp` section and a `permission` section only for full-auto/headless runs; `OPENCODE_CONFIG` env var on spawn). Permission posture: headless chat maps the session's dual policies (`sandbox_policy` + `approval_policy` — `full_access` approval → `bypassPermissions`, `auto_edit` → `acceptEdits`, `on_request`/unknown → `default`, fail-closed; `read_only` sandbox forces `default`) plus an `mcp__relay-tools__*`/`Bash(git:*)` allow list; interactive PTY panes always spawn with `workspace_write`/`on_request` so the CLI's native TUI prompts stay in charge (no silent bypass), and OpenCode's allow-all permission block is omitted unless approval is `full_access`. Spawn-arg helpers `claude_bundle_args` / `kimi_bundle_args` / `opencode_bundle_args` add `--append-system-prompt-file`, `--settings`, `--mcp-config`, `--allowedTools` (Claude), `--mcp-config-file`, `--agent-file` (skipped on resume — kimi forbids it with `--session`), `--add-dir` (Kimi), or rely on the env var (OpenCode). Bundle write failure degrades to the legacy browser-only MCP config (`browser_mcp_register.rs`). Note: automations one-shots (`run_one_shot` / `run_one_shot_chat`) do NOT use the bundle or the CORE prompt — they carry only the user's custom `assistant.systemPrompt`.
- **Harness config discovery (`harness_config.rs`):** reads each CLI's own settings file / live listing for all six harnesses — Claude (`~/.claude/settings.json`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_<ALIAS>_MODEL(_NAME)` remaps, plus its `CLAUDE_CODE_EFFORT_LEVEL` read read-only), Kimi (`~/.kimi-code/config.toml`: `default_model`, `[providers.*]`, `[models.*]`), OpenCode (`~/.config/opencode/opencode.json`: `model`, `provider.<id>.options.baseURL`, `provider.<id>.models`, merged with `opencode models` live output), Pi (`pi --list-models`), Omp (`omp models --json`) and CommandCode (`commandcode --list-models`). Returns `HarnessModelConfig { defaultModel, endpoint, models[] }` with per-model `source` = `"config"` | `"cli"` | `"builtin"`, plus `effort_options_for(harness)` for the picker's effort tiers. Empty/failed reads yield an empty catalog — the picker shows only what the CLI's config + live listing reported, no static fallback rows.

- **Headless CLI chat (`agent_sessions/` directory — `mod`, `claude`, `opencode`, `kimi`-style per-turn `perturn`, `oneshot`, `acp`, `ask`, `handlers`, `lifecycle`, …):** chat sessions whose `agent` is `"harness:<id>"` are backed by real CLI processes (instead of the built-in chat's HTTP calls). Two spawn styles, normalized onto the SAME `chat:token`/`chat:done`/`chat:error`/`chat:artifact` events the built-in chat emits:
  - `claude_code` — one persistent process per chat: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <alias>`. Permission flags follow the session's `permission_mode`: `full_auto` adds `--dangerously-skip-permissions`; every other mode adds `--permission-prompt-tool stdio` so the CLI's `can_use_tool` asks surface as normal `chat:approval-request` cards (relay in `agent_sessions/`, deny is fail-closed). Turns are JSON lines on stdin; token deltas via `stream_event` wrappers; `result` event carries the CLI session id + usage + cost. The captured id persists to `app_settings` under `agent.cli_session_id.claude_code.<sid>` so respawns can `--resume`.
  - `kimi_code` / `opencode` — one process per turn: `kimi -p <prompt> --output-format stream-json [-m model] [--session id]` or `opencode run <prompt> --format json [-m provider/model] [-s id] --auto`. The CLI's own session id (from the first turn's output) is passed back on later turns.
  - `run_one_shot` — blocking one-shot self-contained turn at full-auto permission; backs the automations scheduler and the standalone `bin/relay_automation.rs` binary.
  - Tool calls are encoded as `<tool>{json}</tool>` markers inline in the token stream — the same format `MessageBubble` / `DiffCard` and the chat history sanitizer already parse (no frontend changes needed). `MultiEdit` is expanded into one marker per hunk; `Write`/`Edit`/`Bash` aliases are normalized to the same `kind: "edit"|"code"` payload.
  - The harness's per-turn working dir is snapshotted before spawn and diffed after; new/modified previewable files surface as artifacts (mirrors `chat/dispatch.rs`'s tool outcome path) with the `chat:artifact` event.

### 2.6 Chat Subsystem (`chat/`)

- **Core prompt:** lives in `chat/prompts.rs` — `core_prompt_base()`, `core_prompt_strict()` (appended for local models), `core_prompt_for(provider, model)`, `is_research_request()`, `build_system_prompt()`. `mod.rs` re-exports `build_system_prompt` + `is_research_request`. Tool names must match the `tools/mod.rs` registry.
- **Providers:** `Anthropic`, `OpenAI`, `AnthropicCompatible`, `OpenAICompatible`, `OpenRouter`, `LocalGguf` (`chat/providers.rs`)
- **Tool loop (`chat/streaming.rs`):** OpenAI-style (`run_openai_tool_loop`) and Anthropic-style (`run_anthropic_tool_loop`), capped at `MAX_TOOL_ITERS = 500` (non-research) / `RESEARCH_MAX_TOOL_ITERS = 1000` (research turns). Each call streams one round (`openai_stream_round`/`anthropic_stream_round`), then runs tool calls and feeds results back until a final answer or the cap. Hermes XML `<tool_calls>` fallback parser (in `chat/proto.rs`) recovers tool calls emitted as plain text by aggregators that don't translate the `tools` field. Wire-protocol helpers (`parse_tool_args`, `parse_hermes_tool_calls`, `strip_hermes_tool_calls`, `tool_block`, `openai_message_json`/`anthropic_message_json`, `next_synthetic_tool_id`) live in `chat/proto.rs`; tool dispatch (`run_tool`, `run_gated_fs_tool`, `run_browser_tool`, `run_ledger_tool`, `emit_token`, `artifacts_dir`) in `chat/dispatch.rs`.
- **Tools (the registry defines 88 tool-name constants — `chat/tools/mod.rs` holds 91 `pub const … : &str` items, of which 3 are `FAMILY_*` family ids rather than tools; `UNLOCKABLE_FAMILIES` is a `[(&str, &str); 3]` table, not a `&str`):** `web_search`, `generate_file`, `generate_document`, `plan_document`, `revise_document`, `generate_diagram`, `generate_image` (local diffusion via the sd.cpp sidecar — `chat/tools/imagegen.rs`), `fetch_url`, `run_code`, `open_url`, `open_file`, `get_skill`, `list_skills`, `list_artifacts`, `attach_connector`, `attach_mcp_server`, `get_capabilities`, `check_sufficiency`, `todo_write`, `enter_plan_mode`, `present_plan`, `list_automations`, `get_automation`, `create_automation`, `update_automation`, `delete_automation`, `run_automation_now`, `search_docs`, the vault set `vault_list` / `vault_read` / `vault_search` (read-only) and `vault_write` / `vault_move` / `vault_delete` (mutating — `chat/tools/vault.rs`), the project-wiki pair `search_wiki` / `read_wiki_page` (`chat/tools/` wiki impl, gated on `ToolCaps.wiki` — true once a project has a generated wiki), the `AGENTS.md` pair `read_agents_md` / `write_agents_md` (`agents_md.rs`), the declarative-subagent quartet `list_subagents` / `create_subagent` / `update_subagent` / `delete_subagent` (`chat/tools/subagents.rs`), the five-tool app self-control family `app_snapshot` / `app_click` / `app_type` / `app_press_key` / `app_select_option` (the agent drives Relay's own UI through the injected self-UI bridge in `app_ui.rs`; results return via the `app_ui_result` command — a far cheaper alternative to OS-level computer use), `memory_save`, `memory_recall`, `memory_forget`, `browser_read` (modes: `full`/`summary_only`/`section`/`interactive` — interactive returns a full a11y tree with element `ref` ids for `browser_click`/`browser_type` and no Readability run), the browser-interaction set `browser_click` / `browser_type` / `browser_scroll` / `browser_screenshot` / `browser_observe` (compact actionable-element census) / `browser_extract` (prompt-scored section extraction — `BrowserManager::extract_for_pane`) plus the extension `browser_upload_file` / `browser_zoom` / `browser_press_key` / `browser_fill_form` / `browser_select_option` / `browser_find` / `browser_batch` (14 `BROWSER_*` constants in total), `download_file`, `download_progress`, `run_shell`, `Task` (focused subagent), `get_task_status`, `cancel_task`, `add_source_note`, `get_source_ledger`, `reset_source_ledger`, plus the filesystem set `list_directory`, `read_file`, `search_files`, `search_content` (read-only), `write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file` (mutating), plus `totp_code` (RFC 6238 2FA codes — `chat/totp.rs`; seed stays in the keychain / Bitwarden / 1Password CLI, only the code is returned), and the five Session Mesh inter-session tools `list_sessions` / `read_session` / `search_sessions` / `message_session` / `spawn_session` (runtime in `session_fabric/mod.rs`; also served to harness CLIs via the `relay-tools` bridge in `mcp_tools_bridge.rs`). Family-locked attach-on-demand (absent from the default schema; `attach_connector("<family>")` or the send-time keyword fast-path `prompts::detect_family_unlocks` restores them for the turn): the Session Mesh five, the automation write half (`create_automation` / `update_automation` / `delete_automation` / `run_automation_now` — `list_automations`/`get_automation` stay always-on), and `totp_code`. The research source-ledger tools (`add_source_note` / `get_source_ledger` / `reset_source_ledger` / `check_sufficiency`) ride research-mode turns only. `Task` also takes `background: true` (non-blocking subagent: registers a `subagent`-kind task in TaskManager, returns a task id immediately, result lands in `get_task_status`; Claude-Code June-2026 pattern).
- **Tool caps (24 fields):** `ToolCaps { code_exec, fs_roots, web_search, native_search, native_search_openai, requires_local_sandbox, attached_connectors, local_docs, wiki, mcp_tools, fs_rules, attachable_connectors, attachable_mcp, local_model, memory, browser, allows_mutating, research, session_mesh, automations_write, subagent_write, totp, unlockable_families, allow }` — `code_exec` is gated per-chat; `fs_roots` is the per-session granted-root set for the auto-run permission postures; `web_search` is false for local models (schema-level strip), while `native_search` / `native_search_openai` gate the provider-side hosted search tools; `requires_local_sandbox` is plumbed end-to-end but not yet branched on — there is **no** OS-level sandbox anywhere on the code-exec path (audit E-1); `attached_connectors` / `mcp_tools` carry the live MCP sessions (per-conversation connectors vs. globally enabled gallery servers); `fs_rules` is the user's approval-rule list; `local_docs` / `wiki` / `memory` / `browser` gate `search_docs` (true when any enabled corpus has indexed chunks — hybrid search degrades to keyword-only), `search_wiki` / `read_wiki_page` (true once a project wiki exists), the memory tools, and the browser-interaction tools (true while a page is open, or sticky-true once the session used the browser; `streaming.rs` refreshes caps mid-round); `allows_mutating` mirrors the sandbox posture so `get_capabilities` can never claim writes in a read-only turn; `research` / `session_mesh` / `automations_write` / `subagent_write` / `totp` are the per-turn family unlocks (see the Tools bullet); `unlockable_families` is the catalog behind `attach_connector`; `allow` is the name-level allow list that survives all of the above.
- **Permission gate (`permission.rs`):** the single `check_permission(sandbox: SandboxPolicy, approval: ApprovalPolicy, tool, path, granted_roots) -> PermissionDecision` function every filesystem tool routes through. The model is **dual-policy**, not a single mode: `SandboxPolicy` ∈ `read_only`/`workspace_write` (persisted on `chat_sessions.sandbox_policy`) decides *which tools are visible*; `ApprovalPolicy` ∈ `on_request`/`confirm_edits`/`auto_edit`/`full_access` (on `chat_sessions.approval_policy`) decides *when a visible mutating tool pauses*. The legacy `PermissionMode` enum (`read_only`/`manual`/`auto_edit`/`full_auto`, still readable from `chat_sessions.permission_mode`) survives only as a compatibility shim — `PermissionMode::to_policies()` maps each variant onto a policy pair, and `migrate_chat_session_policies` backfills the two new columns from it. `confirm_edits` is the newer middle posture: writes/edits pause like `on_request` but the approval card carries a structured preview of the actual occurrences in the target file, so the user can accept all, accept a subset, or reject. Hard rules enforced here, not in UI copy: reads (`list_directory`/`read_file`/`search_files`) auto-run in every posture; `delete_file` is **always** gated below `full_access`; `read_only` strips mutating tools from the tool schema entirely (schema-level exclusion — the model literally cannot call `write_file`); a hard `path_within_scope` gate blocks writes outside granted roots at every approval level. `run_tool` calls this before executing; `NeedsApproval` registers a pending approval + emits `chat:approval-request` and **pauses the turn** on a oneshot until the UI calls `resolve_tool_action(pendingId, approved)`. *Note: the session's policies are honored by the built-in chat AND headless Claude Code (settings-bundle mapping + `can_use_tool` stdio relay); Kimi/OpenCode headless always run at full-auto permission (`--auto` / prompt-mode auto-approve — see §2.5 above) with post-hoc `DiffCard` review. The `PermissionModeMenu` (composer footer, shown for builtin/local/claude_code sessions) + `ApprovalCard`/`FullAutoConfirmModal` (`ApprovalFlow.tsx`) + the approval-rules engine (`permissions.rules` KV, settings panel, "always allow" capture on the card) are all wired.*
- **Automations (`automations.rs` + `automation_triggers.rs` + `automation_webhook.rs` + `db/automations.rs`):** headless agent runs fired by a 30s tick loop on `tauri::async_runtime`. **Triggers** (`trigger_type`/`trigger_config`; logic in `automation_triggers.rs`): `cron` (the original schedule), `webhook` (inbound `/trigger/<id>/<secret>` on a loopback listener — constant-time secret compare, app-open only), `file` (watched path, 1s debounce with a burst ceiling plus a per-automation minimum re-fire interval), `git` (HEAD change; evaluated on the tick AND by the run-while-closed sidecar), and `gmail` (historyId polling via the Gmail connector; v1 fires on any mailbox activity). Event runs advance `last_event_run_at` — a separate clock from `last_run_at` — so they never delay the cron schedule; `automation_next_fire` returns human labels for event types. **Agents:** CLI harnesses `claude_code`/`opencode`/`pi`/`omp`/`commandcode` (kimi excluded — it cannot combine prompt mode with auto-approve), the cloud APIs, or `local_gguf`; CLI runs go through `agent_sessions::run_one_shot`, API/local runs through the chat send path. The chat tools `list_automations` truncates each prompt to a one-liner while `get_automation` returns the complete prompt (the `update_automation` schema carries the same full-prompt contract). Each due automation is launched on its own `std::thread` (the turn is blocking process I/O) via `launch_run`, which records `start_run` → executes via `agent_sessions::run_one_shot` (full-auto permission, since unattended turns can't answer prompts) → finalizes with `finish_run` + `record_run`. **Overlap-skip**: in-process `RUNNING: Mutex<HashSet<String>>` plus a cross-process lock file next to `relay.db` (`<db>.automation-<id>.lock`, `create_new` for atomicity) prevent double-fires. Stale lock files (older than 6h) are self-healed. Missed windows fire once on the next tick (due-ness is computed from `last_run_at` or `created_at`, not from now). The standalone `bin/relay_automation.rs` binary reuses the same `run_blocking` path for Windows Task Scheduler integration.
- **Compaction / context window:** three compaction paths share `chat/compaction.rs` summarization — the local path (`chat/commands.rs::count_context_tokens` queries the running llama-server's `/tokenize` endpoint for live `usedTokens` / `maxTokens`; auto-compaction fires as a local-model turn approaches the cap), the cloud path (`chat/cloud_compact.rs::compact_and_retry`, wired into the send path in `chat/mod.rs`: on a context-overflow error the oldest turns are summarized and the turn retried), and the harness path (supersede via `supersede_chat_tail`). Summarized rows get `superseded_by` set in `chat_messages` so the send path filters them out while the timeline still returns them — migration `migrate_chat_messages_superseded` adds the column. The frontend renders a circular SVG ring (`ContextMeter.tsx`, color-tiered green/amber/red); `lib/contextWindow.ts` holds the window math (flat 500k cloud/harness default, OpenRouter live window, local slider/auto).
- **Plan mode:** `chat/plan.rs` (`PlanState`) — `enter_plan_mode`/`present_plan` tools, `chat:plan-mode`/`chat:plan-proposal`/`chat:plan-accepted`/`chat:plan-updated`/`chat:plan-step-progress` events, `resolve_plan_proposal` / `set_chat_session_plan_mode` commands; frontend `PlanProposalCard.tsx`, `TurnChangesRow.tsx`, `todo_write`-backed step lists (`usePlanTracker.ts`).
- **Citations:** research turns record sources in `chat_source_notes` (ledger tools `add_source_note`/`get_source_ledger`/`reset_source_ledger`); end-of-turn lint (`chat/citation_lint.rs`) + async precision sampler (`chat/citation_verify.rs`) emit `chat:citation-report`; chips render amber/red in `ChatCitation.tsx` + `CitationReportStrip.tsx`.
- **Auto model routing:** `chat/auto_router.rs` — rule-based cloud-only router (availability → context fit → vision → stickiness → provider preference) resolving a primary + ordered fail-over chain for `Auto` sessions; failures feed `chat/model_health.rs` (per provider+model health store driving availability). Wired into the send path in `chat/mod.rs` (candidate loop + `chat:status` fail-over disclosure); research/design notes in `AUTO_MODEL_ROUTING_RESEARCH.md` (Phase 4 deferred).
- **Stream reconnect:** `chat/reconnect.rs` — after an idle-probe silence the reader pings the provider (GET `/v1/models`) instead of failing the turn; a bounded ladder (max 10 attempts / 180s budget) emits `chat:status` reasons `reconnecting` / `reconnect_restart` / `reconnected`, so Wi-Fi hand-offs / VPN flaps / half-closed proxies recover the stream. Replaces the old bare 60s stall watchdog.
- **Session Mesh (cross-session agent fabric):** `session_fabric/mod.rs` (`FabricState`, managed in `lib.rs`) + `db/session_fabric.rs` (tables `session_mail`, `session_summaries`) + `state/chat/slices/meshSlice.ts`. Five chat tools (`list_sessions`/`read_session`/`search_sessions`/`message_session`/`spawn_session`) let any chat (built-in or harness CLI via the `relay-tools` bridge) see, read, search, message, and spawn other chat sessions; a per-target pump polls busy-state instead of turn-end hooks. Emits `chat:session-spawn` / `chat:session-mail`; settings toggle `sessionMesh.enabled`. Design doc: `SESSION_MESH_DESIGN_ARCHITECTURE.md`.
- **Conversational artifacts (`/create`):** the `artifacts/` module directory (intent classification, spec schemas, proposal, validator, adapter, context builder, generator) + `commands/artifact_cmds.rs` (8 commands). Command-only chat rows persist with `chat_messages.kind = 'artifact_command'` (excluded from model context) and anchor proposal cards — frontend `ArtifactProposalCard.tsx` / `ArtifactTypeSelector.tsx`.
- **Exec gate:** `exec_gate.rs` — native OS-dialog confirmation for renderer-initiated process execution (`spawn_shell`, MCP-gallery custom installs, `set_llama_server_path`); decisions are remembered per identifying detail in settings, and the dialog lives outside the webview so a compromised renderer cannot answer it.
- **Context windows / misc:** `chat/context_windows.rs` (per-provider window catalog used by the context meter), `chat/docs_images.rs` (image handling for the docs/RAG pipeline).
- **Code exec:** `codeexec.rs` — python/js/bash in fresh temp dir, 20s timeout, NOT a hard sandbox
- **Python runtime:** `python_runtime.rs` — resolves a bundled python-build-standalone interpreter shipped in the installer's `resource_dir/python` (staged by `scripts/fetch-bundled-python.mjs`). Used by `pygen.rs` (doc gen fallback) and `codeexec.rs` (code exec); degrades silently to system Python when not bundled (e.g. `cargo run` from source). Registered at boot in `lib.rs`.
- **Document gen (JS/HTML-first since 0.4.1):** `jsdocgen.rs` is the Rust half of the JS document bridge — the model authors a program against `docx` (npm) or `PptxGenJS`, executed by the frontend `DocCodeRunner` in a sandboxed iframe (round-trips via the `docgen://run` event + `docgen_complete` command). PDF is authored as HTML and printed by `pdfprint.rs` through a hidden WebView2 + Paged.js + `PrintToPdf` (browser-grade CSS/CJK fidelity). `chat/docdesign/` adds plan/QA stages (`plan_document`/`revise_document` tools + `chat:doc-qa` render probes). `pygen.rs` (Python-backed docx/pptx/xlsx/pdf via python-docx/python-pptx/openpyxl/reportlab, 90s timeout) + `artifacts.rs` (hand-rolled minimal OpenXML/PDF) remain as fallbacks. `office_accurate_pdf` converts through bundled LibreOffice (`is_libreoffice_available` gates it).
- **Office preview:** `office.rs` — renders docx/pptx/xlsx to self-contained HTML; also extracts text for attachments. Frontend previews use `docx-preview` / `pdfjs-dist` (`DocxViewer.tsx` / `PdfViewer.tsx`) with backend fallback.

### 2.7 Browser Webviews (`browser.rs`)

- **Native webviews, no iframe fallback:** Windows/macOS use a child webview (`WebviewBuilder` + `window.add_child`); Linux spawns a standalone Tauri `WebviewWindow` per pane+tab (wry/gtk has no multi-webview support) positioned over the pane body — see the module doc in `browser.rs`
- **Label scheme:** `browser-{paneId}-tab-{tabId}`
- **pushState monkey-patch:** injected JS wraps `history.pushState`/`replaceState` + `popstate`/`hashchange` → `browser_push_state`
- **Devtools:** `browser_open_devtools` command opens the native devtools pane for a browser tab
- **Agentic browser:** `read_page` uses a vendored Mozilla `readability.js` (Arc90 origin, Apache 2.0 license header — no version marker in the vendored copy; embedded via `include_str!`) to extract clean Markdown via the `bridge_extract.js` wrapper. Supports **four** modes: `full` (complete cleaned article), `summary_only` (headings + first ~1500 chars), `section` (CSS selector or heading text), and `interactive` (accessibility tree — full a11y records per element: role, aria-label, name, id, value, placeholder, checked, disabled, type, rect; no Readability run, markdown empty). Consent/cookie banners are auto-dismissed; lazy-loaded content is surfaced via a bounded scroll loop. Returns structured JSON (`ExtractedContent`) with `markdown`, `title`, `url`, `canonicalUrl`, `publishedDate`, `byline`, `failureReason`, and `elementRefs`. Interactive elements are tagged with `data-relay-ref` for `browser_click`/`browser_type`. 15s timeout per eval; `ReadOpts` controls settle wait (default 1s) and max scroll steps (default 4).
- **Agent-driven control (relay-browser-mcp):** a standalone MCP server binary (`src/bin/relay_browser_mcp.rs`, `[[bin]]` in Cargo.toml, does NOT link Tauri) speaks stdio JSON-RPC to a harness (any of the six) and forwards each `tools/call` over a **loopback WebSocket on an OS-assigned ephemeral port** (published to `<app_data>/mcp/browser-mcp.json` so the sidecar can discover it; `BROWSER_MCP_PORT` 7681 is only a legacy fallback) to `browser_mcp::serve` (spawned in `lib.rs` setup). Dispatch (`browser_mcp.rs`) runs against the real visible pane via `run_action_for_pane` / `read_page_for_pane` / `resolve_and_click` / `resolve_and_type` / `resolve_and_hover` / `evaluate_for_pane` / `history_for_pane` — the SAME eval bridge the chat tools use. The binary advertises **63 statically-declared tools** — `tool_schemas()` in `src/bin/relay_browser_mcp.rs` is `[browser_schemas(), static_relay_schemas()].concat()`: **27** hand-written in-app browser ops (`navigate`, `read_page`, `observe`, `extract`, `click`, `type_text`, `scroll`, `wait_for`, `history`, `hover`, `evaluate`, `click_and_wait`, `screenshot`, `find`, `fill_form`, `select_option`, `press_key`, `batch`, `read_console`, `read_network`, `list_tabs`, `switch_tab`, `new_tab`, `close_tab`, `zoom`, `print_to_pdf`, `upload_file`) plus **36** relay/document tools. At runtime the bridge merges in the live **34-entry** `ALLOWED_RELAY_TOOLS` allowlist from `mcp_tools_bridge.rs` (which covers the document generators, `get_skill`/`list_skills`/`list_artifacts`/`get_capabilities`, the six automation tools, the five Session Mesh tools, the four subagent tools, the two wiki tools, and the six vault tools) together with REST fallbacks for connected connectors — so the effective advertised count is higher than the static 63 and varies with what is connected. All browser ops take an optional `pane_id`. `click_and_wait` snaps the pre-click URL and polls for navigation/selector/network_idle in one round-trip; `evaluate` runs arbitrary page JS and returns a JSON-serialized value; `hover` dispatches real mouseover/mouseenter for `:hover` menus; `batch` chains several ops in one call. Pane resolution: explicit pane_id → `pane_active_tab` → label; else `project_id` → `browser:resolve-pane-request` frontend roundtrip (max-`lastUsedAt` browser pane, 5s) → global active. Auto-open: `browser:open-browser-request` roundtrip. Per-project registration via `--mcp-config` (Claude Code; `browser_mcp_register.rs` writes to `<app_data_dir>/mcp/<id>.mcp.json` in `spawn_agent_session`). Frontend hook `useBrowserMcpEvents.ts`. Structured error codes: not_found/nav_failure/timeout/browser_unavailable/invalid_args/pane_not_found. **CLI verbs (2026-09-06, Browser Phase 3):** the sidecar binary also runs one-shot — `relay-browser navigate <url> | read [mode] | observe | extract <prompt> | click <desc> | type <desc> <text> | find <query> | screenshot` — speaking the same loopback-WS protocol but printing ONLY the text result, so PTY harnesses drive the visible browser with short shell commands instead of full MCP snapshot payloads (the 114K-vs-27K-token lesson). Connects via RELAY_WS_PORT / RELAY_MCP_AUTH_TOKEN, which the `.mcp.json` registration already sets inside agent sessions.
- **Visual feedback layer:** `bridge_overlay.js` (injected after every nav + lazily per action) installs synthetic cursor/ripple/highlight/caret elements (all `data-relay-overlay`, excluded from the a11y tagger). `click_js`/`type_js` return Promises: cursor tween (400ms) → highlight → ripple / per-keystroke typing (45ms±15ms with real keydown/keyup/input per char) → real action. `action_wrapper_js` is promise-aware (awaits a returned thenable) and applies watch-mode pacing (600ms) via a `__finish` helper — the tool result reports only after the visual+action chain resolves (race guard). Watch-mode: global `watchMode` setting + per-session nullable `watch_mode` column (mirrors `permission_mode`); backgrounded panes skip pacing (`pane_is_visible`).
- **Result-loss flakiness — FIXED (2026-09-06):** the old "navigate returns empty / read_page times out" symptom was NOT an IPC capability problem — it was an eval-vs-navigation race. An eval fired while a navigation was in flight (e.g. `op_navigate`'s immediate `document.title` read, or an agent's click/read right after a navigate) executed in the document that was about to be REPLACED; when the old JS context died, the wrapper's result report never fired and the op burned its whole 45s timeout. Fix: per-label navigation-in-flight tracking (`BrowserManager.nav`, a `NavTracker`) fed from `navigate()` (synchronously, before the COM dispatch) + both NavigationStarting/NavigationCompleted handler sites, and `run_action_for_pane_opts` now waits — bounded at 10s from nav START + 2s slack, with a 150ms post-completion settle — before evaluating. The action wrapper also gained a one-shot report guard with a `pagehide` fallback so a navigation committing during watch-mode pacing delivers the result instead of dropping it. Regression tests: `nav_tracker_marks_in_flight_until_completion`, `nav_tracker_tracks_labels_independently`.

### 2.8 DB Schema (`db/mod.rs`)

60 tables (49 created by the base schema in `db/mod.rs::init_schema` + the 5 vault tables in `vault::index::ensure_schema` (called from `init_schema`) + the 3 secrets-fallback tables in `secrets.rs` + the `llm_log` table in `db/llm_log.rs::ensure_schema`; plus 5 FTS5 virtual tables — `chat_messages_fts`, `doc_chunks_fts`, `memories_fts`, `vault_fts`, `wiki_pages_fts` — which are not counted in the 60. WAL mode, `journal_mode` set in `db/mod.rs`). Core tables:

| Table | Key columns |
|---|---|
| `projects` | `id` PK, `path` UNIQUE, `name`, `is_git_repo`, `created_at`, `last_opened_at` |
| `sessions` | `id` PK, `project_id` FK, `harness`, `harness_session_id`, `title`, `worktree_path`, `created_at`, `last_active_at`, `status` |
| `cost_events` | `id` AUTOINCREMENT, `session_id` FK, `timestamp`, `input_tokens`, `output_tokens`, `provider`, `model_key`, `source` (`'pty'`/`'on_disk'`), `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_output_tokens`, `reported_cost_usd`, `pricing_estimated_usd` (write-only audit) |
| `skills` | `id` PK, `name`, `slash_command` UNIQUE, `content`, `scope`, `created_at` |
| `project_secrets` | `project_id` + `key` composite PK, `value_encrypted` BLOB |
| `app_settings` | `key` PK, `value` |
| `quick_actions` | `id` PK, `project_id` FK, `label`, `command`, `keybinding`, `run_on_worktree` |
| `chat_sessions` | `id` PK, `title`, `provider`, `model`, `created_at`, `last_active_at`, `starred`, `unread`, `watch_mode` (NULLABLE), `permission_mode` (DEFAULT 'manual'), `agent` (NULLABLE: `"builtin"` / `"local"` / `"harness:<id>"` / `"acp:<id>"`), `auto_model` (DEFAULT 0 — Auto routing flag), `effort_level` (NULLABLE — per-session reasoning-effort tier), `cwd_override` (NULLABLE — per-session working folder), `origin` (NULLABLE), `sandbox_policy`/`approval_policy` |
| `chat_messages` | `id` AUTOINCREMENT, `chat_session_id` FK (CASCADE), `role`, `content`, `input_tokens`, `output_tokens`, `cost_usd`, `created_at`, `superseded_by` (compacted turn pointer), `started_at`, `completed_at`, `llm_time_ms`, `tool_time_ms`, `ttft_ms`, `tokens_per_second` (per-turn perf metrics populated when the provider returns timing/rate; surfaced in the composer metrics row, see `ComposerMetrics.tsx`) |
| `artifacts` | `id` PK, `chat_session_id`, `chat_message_id`, `filename`, `path`, `kind`, `created_at`, `expires_at` |
| `chat_source_notes` | `id` PK, `chat_session_id` FK, `url`, `title`, `fact`, `excerpt`, `unavailable`, `created_at` |
| `citation_reports` | per-turn citation lint verdicts (research mode) |
| `connector_credentials` | `connector_id` PK, `expires_at`, `granted_scopes`, `account_display`, `connected_at` |
| `chat_session_connectors` | `chat_session_id` + `connector_id` composite PK |
| `workspaces` | `id` PK, `project_id` FK, `name`, `data`, `created_at`, `updated_at` |
| `automations` | `id` PK, `name`, `prompt`, `harness`, `model`, `cwd`, `schedule`, `enabled`, `last_run_at`, `last_status`, `chat_session_id`, `trigger_type` (DEFAULT 'cron'), `trigger_config` (JSON), `last_trigger_state`, `last_event_run_at`, `created_at` |
| `automation_runs` | `id` PK, `automation_id` FK (CASCADE), `started_at`, `finished_at`, `status`, `summary`, `chat_session_id`, `source` (DEFAULT 'scheduled') |
| `chat_checkpoints` | `id` PK, `chat_session_id` FK, `name`, `message_id`, `created_at` |
| `doc_corpora` | `id` PK, `name`, `path`, `enabled`, `created_at` |
| `doc_files` | `id` PK, `corpus_id` FK, `path`, `size`, `mtime`, `indexed_at` |
| `doc_chunks` | `id` PK, `corpus_id` FK, `file_id` FK, `chunk_index`, `content`, `embedding` BLOB |
| `chat_documents` | `id` PK, `chat_session_id` FK, `corpus_id` FK, `attached_at` |

Knowledge/cache tables: `research_queries`, `search_cache`, `page_cache` (research-mode ledgers + HTTP caches). Session Mesh tables (`db/session_fabric.rs`): `session_mail`, `session_summaries`.

Subagent tables (`db/subagents.rs`, base schema): `subagents`, `subagent_runs` — these shipped under the names `crew_agents`/`crew_runs` and are renamed in place by `migrate_crew_tables_rename`, which deliberately runs *before* `init_schema` so a legacy database never ends up with an empty `subagents` table beside an old `crew_agents`.

Project-wiki tables (`db/wiki.rs` + base schema): `wiki_projects`, `wiki_pages`, `wiki_claims` — every generated page ends in a claims ledger (`claim` → `evidence_path` + line range + blob SHA), and freshness is computed by diffing `old..new` HEADs against `wiki_claims.evidence_path`.

LLM request-log table (`db/llm_log.rs::ensure_schema`): `llm_log` — one row per local-model HTTP exchange, captured verbatim by `llm_log/normalize.rs` and replayable through the loopback gateway.

Memory tables (`db/memory.rs`): `memories`, `memory_evidence`, `memory_ops`, `memory_document_versions`, `memory_cursor`.

Self-improvement tables (`db/improve.rs`): `improve_artifacts`, `improve_versions`, `improve_channels`, `improve_runs`, `improve_feedback`, `improve_proposals`, `improve_eval_cases`, `improve_eval_runs`, `improve_eval_results`, `improve_canaries`, `improve_events`, plus `loop_sessions` (goal-loop runs).

Vault tables (`vault/index.rs::ensure_schema`, called from `init_schema`): `vault_files`, `vault_links`, `vault_tags`, `vault_headings`, `vault_blocks`, plus the `vault_fts` FTS5 virtual table.

Secret-fallback tables (`secrets.rs`, created on demand when an OS-keychain write is unavailable): `chat_secrets`, `connector_secrets`, `generic_secrets`.

**Migrations (40 chained statements in `db/mod.rs::configure` — 37 distinct `migrate_*` calls plus `init_schema`, `llm_log::ensure_schema`, and `research_cache::purge_expired`; all idempotent. `chat_checkpoints`/`chat_documents`/`doc_*`/`subagents`/`wiki_*` are base-schema tables):** `migrate_crew_tables_rename` (runs first — `crew_agents`→`subagents`, `crew_runs`→`subagent_runs`), `migrate_chat_session_flags` (adds `starred`/`unread`), `migrate_chat_session_watch_mode`, `migrate_chat_session_auto` (adds `auto_model`), `migrate_chat_session_agent` (adds `agent`, backfills `local_gguf`→`"local"` / else→`"builtin"`), `migrate_chat_session_agent_def` (adds `agent_def_id`), `migrate_chat_session_project_id`, `migrate_chat_session_permission_mode`, `migrate_chat_session_policies` (adds `sandbox_policy`/`approval_policy` and backfills them from `permission_mode`), `migrate_chat_session_worktree`, `migrate_chat_session_effort` (adds `effort_level`), `migrate_chat_session_cwd_override` (adds `cwd_override`), `migrate_chat_session_origin`, `migrate_artifacts_message_id`, `migrate_chat_messages_superseded` (compaction pointer), `migrate_cost_v2`, `migrate_source_notes_metadata`, `migrate_chat_messages_v2`, `migrate_chat_messages_started_completed` (adds `started_at`/`completed_at`), `migrate_chat_messages_perf` (adds `llm_time_ms`/`tool_time_ms`/`ttft_ms`/`tokens_per_second`), `migrate_improve_autonomy`, `migrate_improve_case_quarantine`, `migrate_improve_eval_runs_session`, `migrate_automation_runs_improve_link`, `migrate_automations_origin` (adds `automation_runs.source`), `migrate_automations_triggers` (adds `trigger_type`/`trigger_config`/`last_trigger_state`/`last_event_run_at`), `migrate_chat_fts` (chat full-text search), `migrate_doc_chunks_fts`, `migrate_doc_chunks_heading` (heading trail for excerpt trails), `migrate_doc_corpora_chunk_version` (forces a one-time re-index), `migrate_memory_reflected`, `migrate_chat_message_kind` (adds `chat_messages.kind`, backfills artifact-command rows), `migrate_sessions_harness_id_source` (adds the `HarnessIdSource` provenance column), `migrate_subagents_origin`, `migrate_subagents_seed`, `migrate_subagents_source_path`, `migrate_unc_paths` (Win only, strips `\\?\` prefix).

> **Counting note:** 40 counts the statements `configure()` actually invokes. Two other migration-shaped steps sit outside that chain: `init_schema` itself calls `migrate_wiki_pages_fts`, and `db/mod.rs` also defines `migrate_unc_paths_rewrites_verbatim_corpus_paths` — which exists only as a test, never as a live step.

### 2.9 Secrets (`secrets.rs`)

- Windows/macOS: OS keychain via `keyring` crate
- Linux: XOR-obfuscated SQLite fallback (documented deviation from PRD)

### 2.10 Automation Task Commands (`automation_task.rs`)

- **Commands (3):** `get_run_while_closed`, `set_run_while_closed`, `test_automation_webhook`
- Exposes automation task settings and webhook testing outside the main automation CRUD surface.

### 2.11 Docs Index (`docs_index.rs`)

- **Commands (13):** `docs_list_corpora`, `docs_add_corpus`, `docs_remove_corpus`, `docs_start_index`, `docs_cancel_index`, `docs_start_reranker`, `docs_set_corpus_enabled`, `docs_attached_corpus_ids`, `docs_attach_corpus_to_chat`, `docs_detach_corpus_from_chat`, `docs_embedding_status`, `docs_list_embedding_models`, `docs_set_embedding_model`
- Powers the document RAG feature: project docs are embedded and attached per-chat for retrieval-augmented generation. `search_docs` now runs **hybrid search** — `doc_chunks_fts` (keyword) + vector legs fused with Reciprocal Rank Fusion (k=60), degrading to keyword-only when the embedding sidecar is down; chunks carry a markdown heading trail in excerpts (corpus `chunk_version` forces a one-time re-index). The optional reranker stage (default off) re-scores the fused top-50 via `/v1/rerank` on a llama-server reranker sidecar (any `*reranker*.gguf` in the models folder), fail-open.
- The embedding model is user-selectable (Settings → Knowledge picker): `docs_set_embedding_model` persists the chosen GGUF path into the `docs.embedding_model` setting (empty = auto-discovery, nomic-embed preferred), `docs_list_embedding_models` scans the model dirs for every embedding GGUF (bert/roberta-family or `*-embedding*` arch, plus `*embed*`-named files with chat-arch headers) grouped by family × quantization; a chosen path wins over auto-discovery until deleted, then falls back silently.

### 2.12 GitHub PR Commands (`github.rs`)

- **Commands (8):** `github_list_prs`, `github_get_pr`, `github_create_pr`, `github_draft_pr_text`, `github_pr_files`, `github_pr_checks`, `github_local_branches`, `github_submit_review`
- Wraps GitHub REST API for PR management inside the Dev panel.

### 2.13 Mobile Relay Commands (`mobile/commands.rs`)

- **Commands (7):** `start_mobile_relay`, `stop_mobile_relay`, `get_mobile_relay_status`, `get_mobile_pairing_info`, `tailscale_serve_enable`, `tailscale_serve_disable`, `tailscale_login`
- Controls the local relay server, Tailscale integration, and mobile pairing flow.

### 2.14 Speech, Dictation & Read-aloud (`commands/speech.rs`, `commands/stt.rs`, `commands/tts.rs`, `commands/tts_gpu.rs`)

- **Speech commands (2):** `transcribe_audio`, `transcribe_cancel` — file-based speech-to-text.
- **Dictation/STT commands (9):** `stt_status`, `stt_start`, `stt_stop`, `stt_install_server`, `stt_install_cuda`, `stt_set_default`, `stt_set_auto_start`, `stt_set_server_path`, `stt_set_device` (cpu/gpu whisper build switch, applied on next start) — push-to-talk dictation backed by a whisper sidecar. `SttState` (managed in `lib.rs`) autostarts the sidecar at boot when enabled (`commands::stt::maybe_autostart`); partial results stream into the composer textarea.
- **TTS / read-aloud commands (13):** `tts_status`, `tts_speak`, `tts_preload`, `tts_unload`, `tts_install_model`, `tts_set_model`, `tts_set_voice`, `tts_set_speed`, `tts_set_auto_read`, `tts_set_device`, `tts_set_keep_loaded` (`commands/tts.rs`) + `tts_gpu_status`, `tts_install_gpu` (`commands/tts_gpu.rs`). Hexgrad Kokoro-82M (Apache-2.0) runs **in-process** via sherpa-onnx — no sidecar, no cloud; models install as a single tar.bz2 into `<models dir>/tts/` (progress reuses `local-model:download:progress`). Because the crates.io sherpa-onnx build is CPU-only, GPU synthesis runs the vendor's CUDA `sherpa-onnx-offline-tts` binary as a short-lived child process (Windows; `tts_install_gpu` caches the ~456 MB download). `TtsState` is managed in `lib.rs` and preloaded at boot when enabled (`commands::tts::maybe_preload`); `state/tts.ts` + `TtsPlayerBar.tsx` + `useTtsAutoRead.ts` on the frontend.

### 2.15 Worktree Commands (`worktree_cmds.rs`)

- **Commands (2):** `ensure_chat_session_worktree`, `set_chat_session_worktree`
- Creates and assigns git worktrees per chat session.

### 2.16 MCP Gallery (`mcp_gallery.rs`)

- **Commands (6):** `mcp_gallery_list`, `mcp_gallery_install`, `mcp_gallery_remove`, `mcp_gallery_set_enabled`, `mcp_gallery_connect`, `mcp_gallery_disconnect` (`kill_all` is an internal exit-cleanup fn, not a registered command)
- Manages bundled MCP server tools that agents can use; enabled servers attach their tools to chat turns (`attach_enabled` / `attach_filtered`).

### 2.17 ACP Agents (`acp/`, `acp_agents.rs`, `commands/agent_cmds.rs`)

- **Commands (6):** `list_acp_agents`, `chat_token_subscribe` (plus the headless-chat commands registered from the same module: `send_agent_chat_message`, `cancel_agent_chat_message`, `reconcile_agent_sessions`, `list_harness_models`)
- **ACP client (`acp/mod.rs` + `acp/events.rs`, lifecycle in `agent_sessions/acp.rs`):** Agent Client Protocol over the agent binary's stdio (initialize → session/new → session/update streaming); sessions whose agent id is `acp:<id>` resolve through `acp_agents.rs::find_agent`. `acp_agents.rs` is the registry — static Zed/Devin-ecosystem entries merged with user agents from the `acp.agents` settings blob. Settings UI: `AcpAgentsPanel.tsx`.

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

### 2.20 Vault — Markdown Knowledge Base (`vault/` + `chat/tools/vault.rs`)

- **What:** the user binds ONE folder of markdown notes (`vault_bind`); Relay indexes it (frontmatter, `[[wikilinks]]`, `^block-ids`, tags, headings) into `vault_files`/`vault_links`/`vault_tags`/`vault_headings`/`vault_blocks`/`vault_fts`, watches it with `notify` (debounced; emits `vault:changed`, `vault:scanned`, `vault:scan-error`), and offers an Obsidian-parity editor: note tabs with wheel-scroll and drag-reorder, callouts, properties, templates, a local graph, tags, navigation history, asset management with an in-app PDF viewer, and notes that open in the app preview by default.
- **Modules:** `vault/mod.rs` (`VaultState`, file ops, watcher), `vault/index.rs` (SQLite index + `ensure_schema` + `full_scan`), `vault/parse.rs` (frontmatter/links/tags parser).
- **Atomicity + link integrity:** agent writes go through the same atomic-write + link-rewrite cores the UI uses (an agent-written note is indistinguishable from a hand-written one); `vault_move`/rename rewrites every inbound `[[WikiLink]]` vault-wide (a failed rename restores the rewritten links); deletes land in a recoverable `.trash/`.
- **Chat tools:** `vault_list` / `vault_read` / `vault_search` (FTS with `tag:` / `path:` / `file:` / quoted-phrase / `-exclude` operators, ranked hits with snippets) ride the default schema; `vault_write` / `vault_move` / `vault_delete` are mutating and stripped by `read_only` (same posture as the filesystem tools). The read/write halves ride the same permission gate as fs tools. Harness CLIs reach them via the `relay-tools` bridge (`chat/tools/vault.rs` + `mcp_tools_bridge.rs`).
- **Commands (21):** listed in §2.2. Frontend: `state/vault.ts` + `lib/ipc/vault.ts` + the Vault view/components.

### 2.21 Local Image Generation (`commands/image_gen.rs` + `chat/tools/imagegen.rs`)

- **Engine:** stable-diffusion.cpp's `sd-server` sidecar, installed from Settings → Local Models → Images (`image_gen_install`) and managed by `ImageGenState` (managed in `lib.rs`; an orphaned child from a force-killed previous run is swept at boot via the `<app_data>/sd-server.pid` file, and the sidecar is stopped at exit).
- **Tool:** `generate_image` paints from a descriptive text prompt and returns a PNG artifact surfaced in chat; progress rides `image-gen:update` (`phase: starting|rendering|done|error`, `owner` = the owning chat session). A missing engine/model returns actionable setup guidance instead of a failure.
- **Commands (13):** listed in §2.2. Frontend: `state/imageGenStore.ts` + `lib/ipc/imageGen.ts`.

### 2.22 User Hooks (`hooks.rs` + `commands/hooks_cmds.rs`)

- **What:** user commands that run around every agent tool call in the built-in chat (main loop, spawned subagent Tasks, Session Mesh children), the subagent loop, and the `relay-tools` MCP bridge. Config lives under the `hooks` setting, edited in Settings → Hooks with a per-hook Test button.
- **Contract (Claude-Code-style I/O):** JSON on stdin, exit 0/2/other, JSON decisions — `pre_tool_use` can deny (exit 2 or `decision:"deny"`; the refusal text feeds back to the model), request approval (`decision:"ask"` routes into the same approval card the permission system uses; degrades to deny on subagent/bridge paths), or rewrite arguments (`updatedInput`); `post_tool_use` annotates results (`additionalContext`) or observes detached (`async: true`). Commands spawn exec-form (never a shell) with `${tool_input.*}` substitution; the first run of each distinct command raises the native exec-gate dialog, remembered per hash; per-hook `onError: closed` lets guardrail hooks fail closed. Matchers support exact lists and regexes.
- **Lifecycle hooks:** `turn_complete` (from the global `chat:done`/`chat:error` listeners registered in `lib.rs` setup) and `session_start` (first message) fire detached as observers. Claude Code sessions gate `can_use_tool` requests through pre-hooks (deny answers the CLI, rewritten input rides the allow response, ask degrades to proceed under full_auto's no-cards contract); all six harness panes fire detached post-tool observations. Run reports ride `chat:hook-run` (`verdict: "ask-dropped"` marks a degraded ask).
- **Commands (2):** `hooks_test`, `hooks_import_claude` (imports command-type hooks from `~/.claude/settings.json`). Research notes: `docs/research/HOOKS_SYSTEM_RESEARCH.md`.

### 2.23 Project Wiki — Generated, Claims-Grounded Knowledge Base (`wiki/`)

- **What:** per project, Relay generates a markdown wiki that documents the codebase as it actually is. Build is three-phase: (1) deterministic repository analysis (file walk + git log) with no model in the loop, (2) one model call that produces the page outline, (3) one read-only model call per page. Progress rides `wiki:build:progress`.
- **Grounding:** every generated page ends in a **Grounded-Claims ledger** — each claim carries an `evidence_path` plus a line range and the blob SHA it was derived from. `validate_claims` drops claims whose escapes are invalid or whose referenced file is missing, and refuses Windows-absolute or symlink escapes. Freshness is computed by diffing `old..new` HEADs against `wiki_claims.evidence_path`, so pages whose sources did not move are left alone. Claims and pages are cleared and rewritten atomically, and a build that fails (e.g. no model configured) leaves the existing wiki intact.
- **Chat tools:** `search_wiki`, `read_wiki_page`, gated on `ToolCaps.wiki` (true once the project has a wiki). Harness CLIs reach them through the `relay-tools` bridge.
- **Commands (7):** `wiki_list_all`, `wiki_get`, `wiki_read_page`, `wiki_build_start`, `wiki_cancel`, `wiki_update`, `wiki_remove`. Concurrency is guarded by `WikiJobRegistry` (a managed state) — a second concurrent build for a project is refused and cancelling does not free the slot early. Frontend: `state/wiki.ts` + `lib/ipc/wiki.ts`. Research notes: `docs/research/PROJECT_WIKI_RESEARCH.md`.

### 2.24 Declarative Subagents (`chat/subagents.rs` + `commands/subagent_cmds.rs`)

- **What:** a registry of reusable, user-authored agent definitions (prompt + tool set + engine/model/effort + sandbox/approval policies + worktree policy + round/concurrency limits). A definition can be run on demand (`run_subagent`) and its runs recorded in `subagent_runs`. This is the subsystem that used to be called "crew agents": the tables shipped as `crew_agents`/`crew_runs` and are renamed in place by `migrate_crew_tables_rename`.
- **Harness interop:** `sync_harness_subagents` / `import_harness_subagent` / `unlink_native_subagent` reconcile Relay's registry with harness-native subagent stores (`~/.claude/agents/*.md`), and `harness_subagent_watch.rs` watches those paths (via `fs:file-changed`) so prompt edits made directly in a terminal are picked up. Changes broadcast on `harness:subagents-changed`.
- **Portability:** `export_subagents` / `import_subagent` move definitions between machines.
- **Commands (12):** listed in §2.2. Chat tools (`chat/tools/subagents.rs`): `list_subagents`, `create_subagent`, `update_subagent`, `delete_subagent`. Subagent tool calls needing approval surface as `subagent:approval-request`. Frontend: `state/subagents.ts` + `lib/ipc/subagents.ts`. Research notes: `docs/research/DECLARATIVE_SUBAGENTS_CREW_RESEARCH.md`.

### 2.25 LLM Request Log & Loopback Gateway (`llm_log/`)

- **What:** every local-model HTTP exchange is captured verbatim into the `llm_log` table (`llm_log/normalize.rs`), giving a replayable record of what was actually sent to a local model. `llm-log:appended` fires as rows land; retention is managed with `llm_log_prune`/`llm_log_clear`, and `llm_log_stats` summarizes usage.
- **Gateway:** `llm_log/gateway.rs` runs a loopback HTTP server that other apps can point a local model's `base_url` at; it forwards bytes **without re-framing** them, so the captured traffic matches what a real client would send. `GatewayHandle` is a managed state; auth is optional and configured via `gateway_set_require_auth`. Targets and the default target are set with `gateway_set_targets` / `gateway_set_default_target`, and `gateway_probe` checks reachability. All **12** commands are declared in `llm_log/commands.rs` (7 log-management + 5 gateway-control); frontend `lib/ipc/llmLogs.ts`. Plan: `docs/research/LOCAL_MODEL_LOG_GATEWAY_PLAN.md`.

### 2.26 App Self-Control (`app_ui.rs`)

- **What:** lets the agent drive Relay's *own* UI through an injected self-UI bridge — five chat tools (`app_snapshot`, `app_click`, `app_type`, `app_press_key`, `app_select_option`) enumerate the app's interactive elements and act on them. This is a far cheaper alternative to OS-level computer use, because it works against Relay's accessibility tree instead of pixels.
- **Roundtrip:** because the injected bridge runs in the webview, results come back through the `app_ui_result` command, which resolves the pending request for the tool call that asked for it. It is declared `async` so it never runs on the UI thread. `SelfUiPending` is the managed state; `app-ui:census-reset` invalidates the element census.

### 2.27 Safety Notes

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
- **Active views:** `"chat"` (the single main surface), `"settings"`, `"skills"`, `"cost"`, `"automations"`, `"vault"` (`ActiveView` in `state/ui.ts`)
- **Sidebar:** one unified column — New Chat, Artifacts, Connectors, Projects (each with nested session rows that open interactive harness panes in the ToolPanel's Terminal tab), Chat history, footer links
- Hooks registered: `useTheme`, `useKeybindings`, `usePtyEvents`, `useChatEvents`, `useGitStatusPolling`

### 3.2 State (Zustand)

| Store | Key state | Key actions |
|---|---|---|
| `projects.ts` | `projects[]`, `sessions[]`, `gitStatuses`, `harnesses[]`, `selectedProjectId` | `loadAll`, `addProjectAtPath`, `createSessionFor`, `refreshGitStatus` (polls all projects) |
| `panes.ts` | `panes[]` (max 6 visible), `focusedPaneId`, `broadcast`, `useCounter`, `focusEpoch`, `spotlightOverride` | `addPane`, `closePane` (→ `disposePaneResources` → `killPty`/`browserClosePane`), `focusPane`, `setSpotlight`, multi-tab browser |
| `chat/` (dir — `index.ts` + `moduleState.ts` + `types.ts` + `paneTree.ts` + 12 slices: approvals, artifacts, buffers, composer, config, loops, mesh, panes, perf, plans, sessions, streaming; split out of a former 3,700-line `chat.ts`) | `sessions[]` (incl. `agent`, `permissionMode`, `watchMode`), `activeChatSessionId`, `focusedChatSessionId`, `messages[]`, `hasMoreHistory`, split-view state (`splitChatSessionId`, `splitMessages[]`, `splitHasMoreHistory`), `streamingChatSessionId`, `config`, `error`, `effort`, `toolsEnabled`, `codeExecEnabled`, `artifacts`, `artifactsByMessage`, `pendingArtifacts`, `pendingApprovals` | `sendMessage` (routes to `sendAgentChatMessage` when `agent` is `"harness:<id>"`), `setSessionAgent` (writes via `update_chat_session_agent`), `onToken`/`onDone`/`onArtifact`/`onError`/`onApprovalRequest`/`onApprovalResolved`, `cancelStream` (routes to `cancelAgentChatMessage` for harness sessions), `regenerateLast`, `openChatSplit`/`closeChatSplit` (independent second chat view), `loadOlderMessages` (id-keyset pagination) |
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
| `appearance.ts` | sidebar header art (custom upload / built-in preset) + app wallpaper (presets/custom + dim scrim) | import/preset/clear via the `appearance_cmds` commands (art + wallpaper families) |
| `vault.ts` | vault binding state, file tree, note buffers, tabs, search, graph | bind/unbind/rescan + note CRUD via the `vault_*` commands; listens `vault:changed`/`vault:scanned` |
| `imageGenStore.ts` | local image-gen status/selection/family plans + live render progress | `image_gen_*` commands; listens `image-gen:update` |
| `buildUpdates.ts` | llama.cpp / CUDA build-update check state | `check_build_updates` + install flows |
| `onboarding.ts` | welcome-wizard + first-run banners | step progression, dismiss |
| `pet.ts` | desktop-pet state (actor/sprite) | pet actions via `usePetEvents` |
| `tts.ts` | TTS engine status, model/voice/speed, auto-read toggle | speak/preload + settings via the `tts_*` commands |
| `wiki.ts` | per-project wiki list, current page content, build progress | `wiki_*` commands; listens `wiki:build:progress` |
| `subagents.ts` | the declarative subagent registry + its run history | `list_subagents`/`run_subagent`/… ; listens `harness:subagents-changed` |
| `projectsSidebar.ts` | sidebar-only project/session presentation state | sidebar expand/collapse + selection |
| `voiceLoop.ts` | hands-free voice-loop (dictation → send → read-aloud) state | the voice round trip across `stt_*` + `tts_*` |

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
- **Model/effort selection** — folded into `AgentModelPicker.tsx` (the standalone `ModelEffortMenu.tsx` was removed); the picker's model rows come from the live `listHarnessModels` query (with a Refresh-from-CLI force reload), render a "Local" badge when the session provider is `local_gguf`, and carry a reasoning-effort tier persisted per session via `update_chat_session_effort`.
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
- **SettingsView.tsx** — grouped nav, 6 sections / 18 categories: General (Appearance, Notifications, Assistant, Improvements), Models & Providers (API Keys, Web Search, Local Models with the embedded `ModelMarket`, Subagent model), Agents (Harnesses), Workspace & Safety (Version control, Approval rules, Hooks), Integrations (Connectors, MCP Servers, Knowledge, Memory, Remote), Storage (Data). Pricing/Shortcuts panels remain reachable from their related sections.
- **ModelMarket.tsx** — Hugging Face catalog browser + download manager (Settings → Local Models). Paired with `ModelDownloadIndicator.tsx` for live progress.
- **AutomationsView.tsx** + **AutomationRunTable.tsx** — automations list, create/edit form, run-now button, past-runs table.
- **DocumentsLibrary.tsx** — visual file browser for all artifacts (under the chat sidebar).
- **SkillsLibrary.tsx** — Skills CRUD (local + harness `~/.claude/skills` / `~/.agents/skills`).
- **OnboardingBanner.tsx**, **UpdateBanner.tsx**, **UpdateBannerMarkdown.tsx** — install hints + update banner (changelog rendered from the GitHub release body via the dedicated markdown renderer).
- **common/{Modal, GlassSelect, PanelIcon}.tsx** — shared chrome.

### 3.6 IPC (`lib/ipc.ts`)

- `safeInvoke` / `safeListen` — no-op outside Tauri (jsdom tests, plain `vite dev`)
- `lib/ipc.ts` is a barrel over `src/lib/ipc/` — **26 domain modules** (appearance, approvals, artifacts, automations, budget, chatSessions, exportImport, github, harnessChat, hooks, imageGen, llmLogs, localModels, marketFiles, mcp, modelMarket, pricing, prompts, rag, sessionMesh, subagents, updater, vault, voice, wiki, workspaces) + `ipcCore.ts` (transport)
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
- Vault IPC (`lib/ipc/vault.ts`): `vaultGetState`/`vaultBind`/`vaultUnbind`/`vaultRescan`/`vaultTree`/`vaultReadNote`/`vaultWriteNote`/`vaultSearch`/… plus `listenVaultChanged`/`listenVaultScanned`
- Hooks IPC (`lib/ipc/hooks.ts`): `hooksTest`, `hooksImportClaude`, `listenHookRun` (`chat:hook-run`)
- Image-gen IPC (`lib/ipc/imageGen.ts`): `imageGenStatus`/`imageGenStart`/`imageGenStop`/`imageGenInstall`/`imageGenSelect`/`imageGenerate`/… plus `listenImageGenUpdate`
- Pricing IPC (`lib/ipc/pricing.ts`): `pricesRefreshNow` + the live-rate layer; `lib/ipc/rag.ts` covers the docs-index corpus commands; `lib/ipc/budget.ts` the budgets; `lib/ipc/prompts.ts` the prompt-template/installed-skill surfaces; `lib/ipc/approvals.ts` the approval-rule store

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
| `lib/harnessUpdates.ts` | once-per-open harness CLI update check → one bell row when an installed CLI is behind npm's latest |
| `lib/buildUpdates.ts` | same flow for the pinned native builds (whisper CPU/CUDA, TTS GPU runtime) |
| `lib/vaultFrontmatter.ts` | Obsidian-style frontmatter (properties) subset — parse/serialize |
| `lib/vaultLinks.ts` | frontend half of the Obsidian-flavored link spec (the Rust half is `vault/parse.rs`; both sides share a documented subset enforced by tests) |
| `lib/format.ts` | shared display formatting helpers (bytes, durations, counts) so units/rounding stay consistent |
| `lib/chatPaneDnd.ts` | module-level drag state for chat-session → split-pane drag-and-drop |
| `lib/sanitize.ts` | string-level sanitization for tool-marker contents (defense against embedded `</tool>` close tags, etc.) |
| `lib/syntaxTheme.ts` | Shiki / Prism theme binding to the app's light/dark tokens |
| `lib/syntaxHighlighter.ts` | wraps Shiki/Prism with the project theme + a small set of languages |
| `lib/modelLabel.ts` | id → human label lookup for the model dropdown |
| `lib/contextWindow.ts` | context-meter math — flat 500k cloud/harness default (no per-family catalog since 2026-09), OpenRouter live window (capped), local slider/auto; `[context]` debug trace |
| `lib/sound.ts` | notification chime (opt-in, settings toggle) |
| `lib/relativeTime.ts` | "3h ago" timestamps |

### 3.8 Tests (`src/test/`)

215 vitest test files / 1702 tests (verified 2026-10-05 via `npm test` — run with `NODE_ENV=test`, or with `NODE_ENV` unset; a shell exporting `NODE_ENV=production` makes React resolve its production build and every component test fails on `act()`). The 215 files are **214 under `src/test/` plus `site/landing.test.mjs`**, which vitest's default glob also sweeps up. Backend: `cargo test --lib` → **1659 passed, 0 failed, 23 ignored** (verified 2026-10-05). Coverage spans panes/spotlight/fuzzy/browser helpers, chat flows (permission modes, approval rules, compaction settings, context window, split view, citations, session mesh, TTS), artifacts and canvas preview, automations (incl. harness-install banner), cost dashboard + rollups, memory, doc-design runners, the project wiki (`wiki` — claims-ledger validation, freshness, atomic rebuilds), subagents, LLM log, vault (store, graph, links, frontmatter, split clamp), wallpapers, export/import, keybindings, onboarding, pet, and component suites (`MessageBubble`, `DiffCard`, `AgentModelPicker`, …).

> **One known-flaky frontend test:** `src/test/jsxPreviewRuntime.test.ts` ("lowers curated-library imports to require() calls") can exceed the 5s default timeout when the full suite runs in parallel, because the Babel transpile competes for CPU with the Mermaid corpus render. It passes in isolation (`npx vitest run src/test/jsxPreviewRuntime.test.ts` → 5/5). Treat a lone failure there as load, not a regression.

---

## 4. Documentation Gaps (Verified Against Source)

**2026-10-05 full doc pass (this revision):** every living doc was re-verified against the code by running the suites and grepping the sources rather than trusting the previous pass. Fixed in this pass — command count 369 → **425** (and the `generate_handler!` line range 554-954 → **691-1155**; also corrected the attribute count, which a naive grep inflates to 430 by matching 6 doc-comment mentions — the real figure is **424**: 200 `async` + 224 plain), tool counts (**88** registry constants; the browser-MCP sidecar's advertised set is **63 statically declared** = 27 browser + 36 relay, merged at runtime with a live 34-entry allowlist — not the old "54"), DB counts (56 → **60** tables + 5 FTS5 virtual tables; 29 → **40** chained statements in `configure()`), test counts (**215** vitest files / **1702** tests; **1659** Rust tests / 0 failed / 23 ignored, plus a note on the one load-flaky frontend test), the tool-loop caps (`MAX_TOOL_ITERS` 45 → **500**, research 96 → **1000**), the **permission model**, which is no longer a single `PermissionMode` — `check_permission` now takes a `SandboxPolicy` × `ApprovalPolicy` pair (with the newer `confirm_edits` middle posture) and `PermissionMode` survives only as a backfill shim — `src/lib/ipc/` module count 23 → **26**, the chat-slice count, the removal of the dead `mobile:session_chat_event` / `mobile:session_chat_owner` events, and the addition of the subsystems that had no coverage at all (see the table below).

**Subsystems documented in this pass that were previously absent from every doc:** the **project wiki** (`src-tauri/src/wiki/` — a generated, claims-grounded markdown knowledge base with its own commands, chat tools, DB tables, and build-progress event), the **declarative subagent registry** (`chat/subagents.rs` + `commands/subagent_cmds.rs` + the `subagents`/`subagent_runs` tables — formerly the "crew" naming, renamed by migration), the **LLM request log + loopback gateway** (`src-tauri/src/llm_log/`), **app self-control** (`app_ui.rs`), **`AGENTS.md` support** (`agents_md.rs`), the **skills gallery**, **automation templates**, the **docs watcher**, **sidecar orphan sweeping**, the **prompt firewall**, and **harness-native subagent watching**.

**Prior pass (2026-09-21):** command count 321 → 369, tool counts (68 registry constants / 54 browser-MCP tools), DB counts (44 → 56 tables, 24 → 29 migrations), test counts, version 0.4.2 → 0.6.0 in BUILD_LOG, the removed `src/lib/harnessModels.ts` fallback, the new 0.6.0 subsystems (Vault, image generation, user hooks, automation triggers, wallpaper, hybrid search/reranker, live pricing), six new events, `src/lib/ipc/` module count 19 → 23, state-store and chat-slice counts, and the browser Linux fallback wording.

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
| `bin/relay_automation.rs` standalone headless binary not in file map | `docs/ai-context/AI_CONTEXT.md` §6 | **Fixed** — added under Backend entry |

---

## 5. Known Open Items

From BUILD_LOG.md and source inspection:

1. **Manual verification pending:** native webview rendering (HiDPI, splitter drags, occlusion, Linux iframe fallback) — BUILD_LOG 2026-07-18
2. ~~**Placeholder app icon:** `src-tauri/icons/icon.ico` is a minimal 32x32 PNG-in-ICO~~ — **resolved** (2026-09: `icon.ico` is now a full multi-size icon, ~86 KB)
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
| Headless CLI chat | `src-tauri/src/agent_sessions/` (directory: `mod`, `claude`, `opencode`, `perturn`, `oneshot`, `acp`, `ask`, `handlers`, `lifecycle`, … — persistent-process / per-turn / one-shot / ACP paths) |
| ACP agents | `src-tauri/src/acp/{mod,events}.rs` + `src-tauri/src/acp_agents.rs` + `src/components/settings/AcpAgentsPanel.tsx` |
| Session Mesh | `src-tauri/src/session_fabric/mod.rs` + `src-tauri/src/db/session_fabric.rs` + `src/state/chat/slices/meshSlice.ts` (design: `SESSION_MESH_DESIGN_ARCHITECTURE.md`) |
| Conversational artifacts | `src-tauri/src/artifacts/` (8 modules) + `src-tauri/src/commands/artifact_cmds.rs` + `src/components/chat/{ArtifactProposalCard,ArtifactTypeSelector}.tsx` |
| Automations scheduler | `src-tauri/src/automations.rs` (tick loop, `launch_run`, `run_blocking`, `validate_schedule`) + `src-tauri/src/automation_triggers.rs` (trigger specs, git/file evaluators, webhook secrets) + `src-tauri/src/automation_webhook.rs` (loopback listener) + `src-tauri/src/commands/automation_cmds.rs` + `src-tauri/src/automation_task.rs` + `src-tauri/src/db/automations.rs` |
| Vault (markdown KB) | `src-tauri/src/vault/{mod,index,parse}.rs` + `src-tauri/src/chat/tools/vault.rs` + `src/state/vault.ts` + `src/lib/ipc/vault.ts` + `src/lib/vaultFrontmatter.ts` + `src/lib/vaultLinks.ts` + `src/components/vault/` (`VaultView`, `VaultEditor`, `VaultFileTree`, `VaultGraph`, `VaultLocalGraph`, `VaultPreview`, `VaultQuickSwitcher`, `VaultPdfViewer`, `VaultAssetView`, `VaultLinkHover`) |
| Local image generation | `src-tauri/src/commands/image_gen.rs` (sd-server lifecycle + `image-gen:update`) + `src-tauri/src/chat/tools/imagegen.rs` + `src/state/imageGenStore.ts` + `src/lib/ipc/imageGen.ts` + `src/components/settings/ImageGenPanel.tsx` + `src/components/chat/ImageGenCard.tsx` |
| User hooks | `src-tauri/src/hooks.rs` (matchers, exec gate, decisions, detached observers) + `src-tauri/src/commands/hooks_cmds.rs` + `src/lib/ipc/hooks.ts` + `src/components/settings/HooksPanel.tsx` (research: `HOOKS_SYSTEM_RESEARCH.md`) |
| Live model pricing | `src-tauri/src/pricing_live.rs` (daily LiteLLM registry fetch → `price.lite.db`) + `src-tauri/src/commands/pricing_cmds.rs` + `src/lib/ipc/pricing.ts` |
| Memory subsystem | `src-tauri/src/memory/` (extract, consolidate, retrieve, render, scoring, worker, reflect, eval) + `src-tauri/src/commands/memory_cmds.rs` + `src-tauri/src/db/memory.rs` + `src/components/settings/MemoryPanel.tsx` + `src/hooks/useMemoryEvents.ts` |
| Self-improving artifacts | `src-tauri/src/improve_engine.rs` + `src-tauri/src/commands/improve_cmds.rs` + `src-tauri/src/db/improve.rs` + `src/components/settings/ImprovementsPanel.tsx` (design: `SELF_IMPROVING_ARTIFACTS.md`) |
| STT / dictation | `src-tauri/src/commands/stt.rs` (sidecar lifecycle, autostart) + `src-tauri/src/commands/speech.rs` + `src/components/settings/SttPanel.tsx` |
| TTS / read-aloud | `src-tauri/src/commands/tts.rs` (in-process Kokoro via sherpa-onnx) + `src-tauri/src/commands/tts_gpu.rs` (CUDA child process) + `src/state/tts.ts` + `src/components/settings/TtsPanel.tsx` + `src/hooks/useTtsAutoRead.ts` |
| Exec gate / shared download | `src-tauri/src/exec_gate.rs` (OS-dialog gate for renderer-initiated spawns) + `src-tauri/src/download.rs` (resumable `.part` pump shared by `download_file` + HF market) |
| Budgets | `src-tauri/src/commands/budget.rs` + `src/components/cost-dashboard/BudgetPanel.tsx` + `src/hooks/useBudgetEvents.ts` |
| Plan mode | `src-tauri/src/chat/plan.rs` + `src/components/chat/{PlanProposalCard,TurnChangesRow,QuestionCard}.tsx` + `src/hooks/usePlanTracker.ts` + `src/lib/planParser.ts`, `src/lib/planMatcher.ts` |
| Knowledge / doc-QA | `src-tauri/src/docs_index.rs` + `src-tauri/src/chat/docs.rs` + `src-tauri/src/db/docs.rs` + `src/state/docQa.ts` + `src/components/settings/KnowledgePanel.tsx` |
| MCP tools bridge | `src-tauri/src/mcp_tools_bridge.rs` (relay-tools dispatcher invoked by the harness bundle's MCP servers) |
| Chat core | `src-tauri/src/chat/{mod,commands.rs,providers,python_runtime,local_models,permission,office,pygen,artifacts,codeexec,tasks,plan,compaction,cloud_compact,cache,context_windows,citation_lint,citation_verify,stream_events,turn_perf,error_class,export,jsdocgen,pdfprint,reconnect,llm_client,partial_buf,totp,auto_router,model_health,docs_images,subagent_model,docs,subagents}.rs` (34 top-level modules, declared in `chat/mod.rs`) + `chat/docdesign/` + `chat/commands/` (9 submodules: api_keys, approval, artifacts, generators, llama_sidecar, preview, selection, send, sessions) |
| Chat prompt/stream/dispatch/proto | `src-tauri/src/chat/{prompts,streaming,dispatch,proto}.rs` |
| Chat tools (registry + impl) | `src-tauri/src/chat/tools/{mod,specs,search,search_content,generate,imagegen,fs,vault,automations,capabilities,serp_browser,subagents}.rs` (12 files) |
| Auto-updater | `src-tauri/src/commands/updater_cmds.rs`, `src/state/updater.ts`, `src/components/onboarding/{UpdateBanner,UpdateBannerMarkdown}.tsx` |
| Bundled runtimes | `src-tauri/src/chat/python_runtime.rs`, `scripts/fetch-bundled-python.mjs`, `scripts/fetch-bundled-libreoffice.mjs` |
| Browser webviews | `src-tauri/src/browser.rs` + `src-tauri/src/browser/{actions,interactions,navigation,tabs}.rs` (the single file has been split into a module directory), `src-tauri/src/commands/browser_cmds.rs`, `src-tauri/src/browser_mcp.rs`, `src-tauri/src/browser_mcp_register.rs`, `src/state/browserTrust.ts` |
| Project wiki | `src-tauri/src/wiki/{mod,commands,tools_impl,tests}.rs` + `src-tauri/src/db/wiki.rs` + `src/state/wiki.ts` + `src/lib/ipc/wiki.ts` (research: `PROJECT_WIKI_RESEARCH.md`) |
| Declarative subagents | `src-tauri/src/chat/subagents.rs` + `src-tauri/src/chat/tools/subagents.rs` + `src-tauri/src/commands/subagent_cmds.rs` + `src-tauri/src/harness_subagent_watch.rs` + `src-tauri/src/db/subagents.rs` + `src/state/subagents.ts` + `src/lib/ipc/subagents.ts` |
| LLM request log + gateway | `src-tauri/src/llm_log/{mod,gateway,commands,normalize,live_tests}.rs` + `src-tauri/src/db/llm_log.rs` + `src/lib/ipc/llmLogs.ts` (research: `LOCAL_MODEL_LOG_GATEWAY_PLAN.md`) |
| App self-control | `src-tauri/src/app_ui.rs` (`SelfUiPending`, `app_ui_result`, the five `app_*` chat tools) |
| AGENTS.md support | `src-tauri/src/agents_md.rs` (prompt layering + `read_agents_md`/`write_agents_md`) |
| Skills gallery | `src-tauri/src/skills_gallery.rs` + `src-tauri/src/installed_skills.rs` + `install_skill_from_url` |
| Prompt firewall | `src-tauri/src/prompt_firewall.rs` (scans retrieved content — memories, RAG excerpts — crossing into the prompt) |
| Sidecar orphan sweep | `src-tauri/src/sidecar_sweep.rs` (boot-time sweep of llama-server / whisper-server / sd-server children left by a crash) |
| Docs watcher | `src-tauri/src/docs_watcher.rs` (`DocsWatcherState`, re-indexes corpora on file edits) |
| Automation templates | `src-tauri/src/automation_templates.rs` (curated `AutomationInput` prefills for `list_automation_templates`) |
| DB schema | `src-tauri/src/db/mod.rs` |
| DB queries | `src-tauri/src/db/{projects,chat,cost,cost_v2,artifacts,settings,skills,secrets,connector_credentials,workspaces,automations,source_ledger,checkpoints,docs,docs_eval,research_cache,improve,memory,session_fabric,subagents,wiki,llm_log}.rs` |
| Git helpers | `src-tauri/src/git.rs`, `src-tauri/src/commands/git_cmds.rs`, `src-tauri/src/github.rs`, `src-tauri/src/git_watcher.rs`, `src-tauri/src/checkpoints.rs` |
| Secrets | `src-tauri/src/secrets.rs` |
| Mobile | backend relay `src-tauri/src/mobile/{mod,commands,relay,relay_ws,relay_crypto,relay_owner,relay_requests,session_chat,protocol,push,dispatch,tailscale}.rs` (push = Expo push-notification fallback when the phone is backgrounded); companion app `mobile/` (Expo SDK 57 / RN 0.86; `mobile/src/{components,hooks,lib,screens}`) |
| Frontend entry | `src/main.tsx`, `src/App.tsx` |
| State stores | `src/state/{projects,projectsSidebar,panes,artifacts,skills,settings,ui,updater,spotlight,automations,browserTrust,docQa,notifications,pullRequests,appearance,onboarding,pet,tts,voiceLoop,vault,wiki,subagents,imageGenStore,buildUpdates}.ts` + `src/state/chat/` (dir — `index.ts` + `moduleState.ts` + `types.ts` + `paneTree.ts` + 12 slices — see §3.2) |
| Pane components | `src/components/panes/{PaneFrame,TerminalPane,BrowserPane,DevDiffPanel,ToolPanel,BranchPanel,ProgressPanel,PullsPanel,SubagentPanel}.tsx` |
| Chat components | `src/components/chat/` — main surface files (`ChatView`, `ChatComposer`, `ChatWelcome`, `ChatPaneGrid`, `AgentModelPicker` + `agentPickerParts`/`agentPickerShared`/`agentIcons`, `MessageAttachments`, `MessageBubble`, `MermaidDiagram`, `InlineDiagram`, `ImageGenCard`, `JsxPreview`, `ArtifactPreviewPane`, `ArtifactProposalCard`, `ArtifactTypeSelector`, `ArtifactsMenu`, `ArtifactExportMenu`, `ChatSessionRow`, `DiffCard`, `ContextMeter`, `ComposerMetrics`, `TaskProgressCard`, `PermissionModeMenu`, `ApprovalFlow`, `PlanProposalCard`, `TurnChangesRow`, `QuestionCard`, `ChatCitation`, `CitationReportStrip`, `CommitModal`, `GitMenu`, `GitToolsSidebar`, `BranchDropdown`, `PdfViewer`, `DocxViewer`, `DocCodeRunner`, `DocDesignRunner`, `docRunnerFrame`, `TurnNavigator`, `TypingIndicator`, `TtsPlayerBar`, `ChatSelectionToolbar`, `DiagramLightbox`, `ActivitySteps`, `MarkdownTable`, `MdLink`, `MissingFieldsPrompt`, `SegmentedSlider`, `LlamaAdvancedFields`, plus shared helpers `composerChrome`/`composerModals`/`composerShared`/`chatWelcomeShared` and chat-local hooks `useLocalModelSidecar`/`useTranscriptScroll`/`useVoiceDictation`) |
| Automations components | `src/components/automations/{AutomationsView,AutomationRunTable}.tsx` |
| Sidebar | `src/components/sidebar/{Sidebar,ProjectItem,SessionRow,ArtifactLibrary,ProjectSettingsPanel,ConnectorGrid}.tsx` |
| Documents | `src/components/documents-library/DocumentsLibrary.tsx` |
| Overlays & settings panels | `src/components/command-palette/CommandPalette`, `peek/PeekPanel`, `cost-dashboard/{CostDashboard,BudgetPanel}`, `skills-library/SkillsLibrary`, `common/{Modal,GlassSelect,PanelIcon}`; `src/components/onboarding/` (`OnboardingBanner`, `UpdateBanner`, `UpdateBannerMarkdown`, `WelcomeWizard` + `steps/`, `WorktreeNudgeBanner`, `LocalModelModal`); `src/components/pet/` (`PetActor`, `PetPanel`, `PetStrip`, `PetTicker`); `src/components/settings/` (`SettingsView`, `ApiKeysPanel`, `AcpAgentsPanel`, `ConnectorsPanel`, `ConnectorIcon`, `DataPanel`, `FontSettingsPanel`, `GitPanel`, `HooksPanel`, `ImageGenPanel`, `ImprovementsPanel`, `KnowledgePanel`, `LocalModelsPanel`, `ModelMarket`, `ModelDownloadIndicator`, `McpGalleryPanel`, `MemoryPanel`, `PermissionRulesPanel`, `RemotePanel`, `ServerBuildsCard`, `SidebarArtPanel`, `SttPanel`, `SubagentModelPanel`, `ThemeGalleryPanel`, `ToggleSwitch`, `TtsPanel`, `WallpaperPanel`) |
| IPC | `src/lib/ipc.ts` (barrel) over `src/lib/ipc/` (26 domain modules) + `src/lib/ipcCore.ts` (transport) |
| Utilities | `src/lib/{id,sessionTitle,skillExpansion,diff,fuzzy,keybindings,browserHistory,browserOcclusion,sessionLauncher,exportSession,harnessUpdates,buildUpdates,vaultFrontmatter,vaultLinks,format,chatPaneDnd,lastSelection,viewKinds,sanitize,syntaxTheme,syntaxHighlighter,modelLabel,contextWindow,sound,relativeTime,themes,themePresets,planParser,planMatcher,workspaceRestore,notifyCenter,chatCitations,modelCapabilities,providerKind,voiceRecording,tts,ttsPreview,diagramExport,interactiveHtml,channels,segments,appFocus,chatScroll,chatSelection,openBrowserPane,paths,pointerDrag,releaseNotes,notify,agents,safeSlice,fonts,icons}.ts` + `src/lib/pets/` |
| Hooks | `src/hooks/{usePtyEvents,useChatEvents,useGitStatusPolling,useTheme,useKeybindings,useBrowserMcpEvents,useModelDownloadEvents,usePaneMemory,useContextMeter,useSyntaxTheme,useAutomationEvents,useBudgetEvents,useMemoryEvents,useCostRollups,usePlanTracker,useStreamingText,useViewNav,useNewChatAction,useElementHeight,useOcclusion,useCopyToClipboard,useTtsAutoRead,usePetEvents,useTauriEvent,useWallpaper}.ts` |
| Tests | `src/test/*.{ts,tsx}` |
| Built-in skills | `skills/{docx-skill,pptx-skill,pdf-skill,diagram-html-svg-skill,goal-loop-skill,relay-chat-system-prompt}.md` — embedded at compile time in `src-tauri/src/installed_skills.rs::builtins()` (slugs: docx, pptx, pdf, diagram, goal, loop; `/loop` is an alias of `/goal` sharing the `goal-loop-skill.md` body) |
| Config | `src-tauri/tauri.conf.json`, `vite.config.ts`, `tsconfig.json`, `index.html` |
| Docs | `docs/ai-context/{README,PRD,CONTRACT,BUILD_LOG,RELEASE,AI_CONTEXT,AUDIT,BUG_LIST,BUG_LIST_ROUND2,COST_MODEL_REDESIGN}.md` |
