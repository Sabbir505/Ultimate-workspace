# Full Codebase Audit — Relay

**Date:** 2026-09-14 · **Scope:** entire working tree (`src/` frontend, `src-tauri/` Rust backend, `mobile/` app, configs) · **Method:** 8 parallel deep-audit passes, every finding verified against source with `file:line` evidence; the 4 highest-severity findings independently re-verified by hand.

**Totals: 152 findings — 1 Critical, 22 High, 67 Medium, 62 Low.**

Severity legend: **Critical** = crashes the app / data loss / security hole. **High** = bug users will realistically hit, significant perf problem, or exploitable issue. **Medium** = edge-case bug, leak, or moderate gap. **Low** = minor.

---

## Executive summary — fix these first

1. **[Critical] Conditional hook in `AutomationRunTable` crashes the entire app** — and there is **no React error boundary anywhere** (`src/main.tsx:26`), so any render error white-screens the desktop shell.
2. **[High/data-loss] Moving the chat DB twice silently reverts to the stale DB on restart** — `set_setting` writes the new location into the *old* database file (`src-tauri/src/commands/data.rs:155`), and a related command **overwrites an existing DB at the destination with no backup** (`data.rs:139-146`).
3. **[High/security] Model download writes to an arbitrary frontend-supplied directory** (`src-tauri/src/commands/local_model_market.rs:979-1014`) — arbitrary file write anywhere on disk from the webview.
4. **[High/security] Claude spawns skip the cmd.exe-safe model guard** — a model id containing `& | ^ % "` executes as a second command on Windows (`src-tauri/src/agent_sessions/claude.rs:87-88`, also `oneshot.rs`).
5. **[High/security] Headless automations are creatable through the ungated MCP relay path with forced full-auto** — prompt injection → persistent privileged shell execution that survives the conversation (`src-tauri/src/automations.rs:99-106`, `mcp_tools_bridge.rs:37-58`).
6. **[High/security] Mobile pairing error permanently downgrades the phone to plaintext raw-token mode** with a 3-second infinite retry loop (`mobile/src/hooks/useRelay.ts:352`).
7. **[High/data-loss] Assistant turn persist failure is silently swallowed and `chat:done` still fires** — the streamed reply vanishes on next reload (`src-tauri/src/chat/mod.rs:986-1061`).
8. **[High] Token usage is silently lost on every plain (non-tool) turn against local/compatible providers** — `finish_reason:"stop"` breaks the stream before the usage chunk arrives (`src-tauri/src/chat/providers.rs:766-787`).
9. **[High/mobile] Chat stuck "streaming" forever after a mid-stream disconnect; deep link can corrupt the stored relay URL and un-pair the phone** (`mobile/src/hooks/useSessionChat.ts:173-295`, `mobile/src/lib/deepLinks.ts:103`).
10. **[High/UX-data-loss] The "create artifact" intent detector intercepts ordinary messages** ("I want to create a loop in my code…"), wipes the draft, and never reaches the model (`src/components/chat/composerShared.tsx:88-119`).

---

# Area 1 — Rust chat engine (`src-tauri/src/chat/`, 57 files, ~46K lines)

## High

- **[HIGH][provider-integration] Usage silently lost on the plain (non-tool) path when a provider sends usage after `finish_reason:"stop"`** — `src-tauri/src/chat/providers.rs:766-787` (with `src-tauri/src/chat/mod.rs:1686-1702`)
  `parse_sse_chunk` returns `done=true` as soon as any choice carries `finish_reason:"stop"`, and `run_chat_stream` breaks its read loop on `Done`. llama-server and several aggregators send the usage chunk *after* the stop delta — the code's own comment in `streaming.rs:385-392` documents this exact order. The tool loops were fixed (`stop_seen` + 2s grace) but the provider-trait path used for tools-off turns was not: every plain local-GGUF turn persists `input_tokens/output_tokens = NULL`, shows no cost, and breaks tok/s. Fix: don't return `done` on `finish_reason:"stop"` unless usage is present.
- **[HIGH][data-loss] Assistant turn persist failure silently swallowed; `chat:done` still fires** — `src-tauri/src/chat/mod.rs:986-1061`
  On the success path, `db::add_chat_message(...)`'s `Result` is only consumed via `if let Ok(msg) = persisted` (line 1056). If the insert fails (disk full, DB lock), the entire streamed answer is never persisted, no error is emitted, and the UI is told the turn succeeded — the user sees the reply until the next reload, after which it is gone.
- **[HIGH][bug] HTML→PDF splices the injected `<head>` block at a byte offset computed on the untrimmed string but slices the trimmed one** — `src-tauri/src/chat/pdfprint.rs:86-106`
  `to_ascii_lowercase()` is computed on `model_html` but the splice is applied to `model_html.trim_start()`. When the model's HTML starts with whitespace, every position is off by the prefix length and `head_inject` lands mid-tag (e.g. `<st` + inject + `yle>`), corrupting the print document so Paged.js never runs. Use `trimmed.to_ascii_lowercase()` (ASCII lowering preserves offsets).

## Medium

- **[MEDIUM][correctness] Auto-failover persists the primary provider with the fallback's model on the message row** — `src-tauri/src/chat/mod.rs:1040` vs `:763` — cost rollups group spend under the wrong provider after failover, and cache-inclusion normalization uses the wrong provider convention.
- **[MEDIUM][perf] Office/PDF attachment text extraction runs inline on the async runtime with no size cap** — `src-tauri/src/chat/commands/send.rs:26-45` — a large docx/pptx stalls a tokio worker inside `send_chat_message`, delaying all other streams. Use `spawn_blocking` + size cap.
- **[MEDIUM][perf] `search_content` reads every candidate file fully (up to 5 MiB) just to sniff 1 KiB for binary detection** — `src-tauri/src/chat/tools/search_content.rs:406-419` — doubles I/O across corpus-wide sweeps.
- **[MEDIUM][edge-case] `edit_file` loads the whole file unbounded** — `src-tauri/src/chat/tools/fs.rs:216-219` — a multi-GB file pointed at by find/replace OOMs the blocking pool.
- **[MEDIUM][provider-integration] `parse_usage` only recognizes `data: ` with a trailing space** — `src-tauri/src/chat/providers.rs:796-797` — usage lines from non-conformant endpoints (the ones that motivated the earlier `data:[DONE]` tolerance fix) never parse.
- **[MEDIUM][concurrency] Chat import writes artifact files to disk while holding the global DB mutex** — `src-tauri/src/chat/export.rs:611-666` — a slow disk serializes every other DB consumer for the whole import.
- **[MEDIUM][bug] Fail-over candidates can inherit a previous candidate's provider-specific system prompt** — `src-tauri/src/chat/mod.rs:763-764` — `or(chat_req.system.take())` consumes the original eagerly; a later candidate can run with candidate 0's rebuilt prompt built for a different model class.
- **[MEDIUM][error-handling] Artifacts from a successful turn are not re-attributed when `attach_artifacts_to_message` fails** — `src-tauri/src/chat/mod.rs:1057, 1076-1086` — combined with the persist gap above, a failing DB yields a turn with no persisted reply *and* no artifacts.

## Low

- **[LOW][edge-case] `anthropic_thinking_for` floors `max_tokens` to 3072 even when thinking is explicitly off** — `src-tauri/src/chat/providers.rs:311` — silently raises the output cap (and cost ceiling) above what was requested.
- **[LOW][concurrency] `ChatManager::cancel_all` drains pending approvals but not pending harness questions** — `src-tauri/src/chat/mod.rs:1383-1403` — their oneshot senders only die at process exit.
- **[LOW][perf] `provider_label` leaks memory per unknown provider id** — `src-tauri/src/chat/auto_router.rs:397` — `Box::leak` grows unboundedly with dynamic labels.
- **[LOW][bug] `run_task_subagent` targets `api.openai.com` when a local session has no `base_url`** — `src-tauri/src/chat/dispatch.rs:956-965` — confusing 401 from the wrong host instead of "no base URL configured".
- **[LOW][provider-integration] Subagent loop treats a tool-call id of `""` as valid when echoing Anthropic `tool_use` blocks** — `src-tauri/src/chat/dispatch.rs:1306-1317, 1448-1458` — strict backends can 400 on the next round.
- **[LOW][correctness] Elision stub reports byte length as "chars"** — `src-tauri/src/chat/streaming.rs:1037-1041` — CJK-heavy tool output reported ~3× its char count.

---

# Area 2 — Rust persistence & IPC commands (`src-tauri/src/db/` + `src-tauri/src/commands/`, 42 files, ~21K lines)

## High

- **[HIGH][data-loss] `storage.dbDir` is written to the OLD connection during a DB move, so a second move is undone at next restart** — `src-tauri/src/commands/data.rs:155-156`
  The comment claims the setting is written to the NEW connection, but `set_setting(&conn, ...)` runs before `*conn = new_conn`. First move (default → A) works only by accident; a second move (A → B) writes "B" into A's file, the default DB still says "A", and after restart the app silently reopens the stale A database — everything written to B appears lost. *(Verified by hand.)*
- **[HIGH][security] `start_model_download` accepts an arbitrary frontend-supplied `destDir` — arbitrary file write anywhere on disk** — `src-tauri/src/commands/local_model_market.rs:979-1014`
  `dest_dir` is used verbatim; only the *filename* is sanitized. A compromised webview can write attacker-chosen bytes (from any URL) to any directory (e.g. a Startup folder). Sibling `delete_downloaded_model` carefully canonicalize-gates to the models dir — this command should too. *(Verified by hand.)*

## Medium

- **[MEDIUM][logic] `/create `-prefix backfill re-runs on every startup and hides legitimately typed user messages from the model** — `src-tauri/src/db/mod.rs:255-259` — any harness/mobile user message starting with `/create ` is permanently stamped `artifact_command` and excluded from model context after restart.
- **[MEDIUM][data-consistency] Project removal orphans `memory_evidence` rows and never flags unbacked memories** — `src-tauri/src/db/chat.rs:220-231` — unlike `delete_chat_session`, memories keep `active` status with evidence pointing at ghost messages.
- **[MEDIUM][data-consistency] `delete_chat_session` runs destructive cleanup before the non-transactional final DELETE** — `src-tauri/src/db/chat.rs:242-261` — if the final DELETE fails, evidence is gone and memories flagged while the chat survives (unrecoverable half-applied delete).
- **[MEDIUM][security] `browser_action_result` makes the anti-forgery nonce optional, keeping the unverified resolve path reachable** — `src-tauri/src/commands/browser_cmds.rs:122-125` → `src-tauri/src/browser/actions.rs:19-23` — a hostile page can omit the nonce and forge/complete arbitrary pending agentic actions (e.g. inject a fake tool result into the agent's transcript). *(Also flagged by the browser auditor; fix once here.)*
- **[MEDIUM][security/trust] `stt_set_server_path` persists an arbitrary renderer-supplied executable path that is later spawned with no exec gate** — `src-tauri/src/commands/stt.rs:195-206, 369-393` — same trust inconsistency applies to `set_models_directory`.
- **[MEDIUM][data-integrity] Resumed downloads silently skip SHA-256 verification when the prefix can't be re-hashed** — `src-tauri/src/commands/local_model_market.rs:1262-1272, 1325-1334` — a possibly-corrupt resumed file is renamed to its final name; should hard-fail when an expected hash was provided.
- **[MEDIUM][perf] `update_artifact_cmd` holds the shared DB mutex across filesystem writes** — `src-tauri/src/commands/artifact_cmds.rs:371-417` — stalls every other DB consumer for the duration of the skill file write. Drop the guard before the FS step.
- **[MEDIUM][storage] Research caches grow without bound** — `src-tauri/src/db/research_cache.rs:109-137, 167-196, 215-244` — expired rows are only deleted when the exact same key is fetched again; page bodies can be hundreds of KB. Add a TTL sweep.
- **[MEDIUM][data-loss] `set_chat_db_dir` overwrites an existing `relay.db` at the destination with no backup or confirmation** — `src-tauri/src/commands/data.rs:139-146` — mis-picking a folder containing an old Relay DB destroys it irrecoverably.

## Low

- **[LOW][perf] `configure()` runs O(table) work on every startup** — `src-tauri/src/db/mod.rs:168-222` — `COUNT(*)` over `chat_messages` per open; gate on a persisted marker.
- **[LOW][logic] `resolve_session_id` interpolates user input into a LIKE pattern without escaping `%`/`_`** — `src-tauri/src/db/session_fabric.rs:271-274` — a `%` in the prefix can resolve to an unintended session.
- **[LOW][data-consistency] `remove_corpus` runs three DELETEs outside a transaction** — `src-tauri/src/db/docs.rs:95-106` — crash between deletes leaves orphaned chunks/files.
- **[LOW][perf] Vector search materializes every embedding blob of all enabled corpora per query** — `src-tauri/src/db/docs.rs:281-387` — ~300 MB transient allocations at 100k chunks × 768 f32.
- **[LOW][logic] `insert_artifact` dedupe re-SELECT is ambiguous within the same second and returns a synthetic record** — `src-tauri/src/db/artifacts.rs:41-63` — later attachment may leave the artifact attributed to a stale message.
- **[LOW][logic] TTS `status_inner` reports `loaded` without the model-match check its own comment promises** — `src-tauri/src/commands/tts.rs:1101-1105`.
- **[LOW][edge-case] `synthesize_gpu` leaks the temp WAV when the final read fails** — `src-tauri/src/commands/tts_gpu.rs:668-670`.
- **[LOW][api-contract] `list_automation_runs`' `beforeId` is documented as an id cursor but implemented as a `started_at` cursor** — `src-tauri/src/commands/automation_cmds.rs:126-137` vs `src-tauri/src/db/automations.rs:348-370`.
- **[LOW][perf] Path-allowlist checks load the full `projects` + `sessions` tables on every call, including per fs-change burst** — `src-tauri/src/commands/git_cmds.rs:17-67`, `src-tauri/src/commands/data.rs:425-502`.
- **[LOW][edge-case] `transcribe_audio`'s external STT client is hard-pinned to `.no_proxy()`** — `src-tauri/src/commands/speech.rs:167-171` — breaks proxied networks and cloud STT endpoints.
- **[LOW][error-handling] `set_autonomy` builds audit JSON by string formatting** — `src-tauri/src/db/improve.rs:686-693` — a quote in `tier` would write invalid JSON.
- **[LOW][perf] Per-row UPDATE/SELECT loops in memory + improve paths** — `src-tauri/src/db/memory.rs:417-427, 551-559`; `src-tauri/src/db/improve.rs:644-652` — batch with `IN (...)`.
- **[LOW][edge-case] `normalize_query` uses `to_ascii_lowercase`, so non-ASCII queries defeat repeat detection** — `src-tauri/src/db/research_cache.rs:358-363`.

---

# Area 3 — Agent session orchestration (`agent_sessions/`, `session_fabric/`, `acp/`, `harness_adapters/`, harness root files, ~16K lines)

## High

- **[HIGH][security] Claude spawn paths skip the `ensure_cmd_safe_model` guard on `--model`** — `src-tauri/src/agent_sessions/claude.rs:87-88`; also `oneshot.rs:400-403, 754-757`
  On Windows every spawn is wrapped `cmd.exe /C claude … --model <id>` where flags ride unquoted through the npm shim's `%*` — the exact exposure the E-9c guard was written for and which every other harness applies. `claude_model_alias` passes any id that doesn't contain fable/opus/sonnet/haiku through verbatim, so a model id containing `& | ^ % "` executes as a second command with the app's privileges. *(Verified by hand.)*
- **[HIGH][concurrency] Whole blocking `send()` runs on a tokio worker, including a 20 s wait-ready poll** — `src-tauri/src/commands/agent_cmds.rs:70` + `agent_sessions/opencode.rs:391` — pins a runtime worker per (re)spawn, stalling unrelated async tasks. Wrap in `spawn_blocking` like `cancel` already does.
- **[HIGH][perf] Harness send/turn-end hold the global DB mutex across full `git add -A` snapshots** — `src-tauri/src/agent_sessions/mod.rs:654-657, 1171-1175` — freezes every DB consumer (all chat streams) for the whole snapshot; `maybe_baseline_detached` exists precisely to fix this but only the builtin path uses it.
- **[HIGH][lifecycle] User message is persisted before spawn validation — orphaned user bubble on every spawn failure** — `src-tauri/src/agent_sessions/mod.rs:540-544` vs dispatch at `662-740` — contradicts the invariant at `mod.rs:471-477`; the orphaned row survives restarts.

## Medium

- **[MEDIUM][zombie] One-shot generation children (`/create` backend) are not registered for app-exit kill** — `src-tauri/src/agent_sessions/oneshot.rs:496-567` — quitting mid-generation leaks a running `--dangerously-skip-permissions` tree.
- **[MEDIUM][lifecycle] Mesh pump delivery failure permanently leaks the parked answer waiter** — `src-tauri/src/session_fabric/mod.rs:704, 983-988` — REJECTED mail never resolves the waiter's oneshot until process exit.
- **[MEDIUM][lifecycle] Harness-switch lets the old claude reader delete the stored resume id, breaking switch-back** — `src-tauri/src/agent_sessions/mod.rs:482-493` + `claude.rs:982-1002` — switching back to claude starts a blank conversation instead of resuming the intact CLI session.
- **[MEDIUM][restore] Checkpoint restore can race a running turn and runs blocking on the runtime** — `src-tauri/src/checkpoints.rs:226-274` (command at `chat/commands/sessions.rs:96-104`) — restore's git checkout races a harness CLI writing the same repo; also fully blocking on a tokio worker.
- **[MEDIUM][concurrency] ACP first turn can be double-sent** — `src-tauri/src/agent_sessions/acp.rs:293-324 vs 473-489` — pending store and direct-send decision are not under one lock acquisition; duplicates the first prompt and bills it twice.
- **[MEDIUM][perf] Per-turn CLI turns re-snapshot watched dirs synchronously under the session lock** — `src-tauri/src/agent_sessions/perturn.rs:344-348` + `dirwatch.rs:109-253` — full depth-4 walk per message on kimi/pi/omp/commandcode.
- **[MEDIUM][edge] Mesh mail can be permanently REJECTED by a busy-check race** — `src-tauri/src/session_fabric/mod.rs:760-779, 973-989` — "turn already running" between poll and send drops the message instead of re-queuing.
- **[MEDIUM][edge] `emit_opencode_tool` fallback id mints a new id per event, duplicating call cards** — `src-tauri/src/agent_sessions/opencode.rs:1073-1076` — results never attach for servers that omit part ids.

## Low

- **[LOW][error-handling] `expect("row just inserted")` on the turn-finalize path** — `src-tauri/src/checkpoints.rs:93` — read failure panics the reader thread mid-finalize.
- **[LOW][error-handling] `app.unwrap()` in the AskUserQuestion emit** — `src-tauri/src/agent_sessions/claude.rs:390` — safe today; fragile under refactor.
- **[LOW][zombie] `binary_on_path` timeout kills only the direct child** — `src-tauri/src/harness_adapters/mod.rs:636-637` — the CLI grandchild survives (sibling code correctly uses `kill_child_tree`).
- **[LOW][edge] opencode port TOCTOU can POST turns to a foreign local server** — `src-tauri/src/agent_sessions/opencode.rs:337-338, 391`.
- **[LOW][diagnosability] opencode serve stdout/stderr are `Stdio::null()`** — `src-tauri/src/agent_sessions/opencode.rs:367-369` — startup failures are undiagnosable; similarly chat-path claude/per-turn spawns discard stderr, so mid-turn auth/quota failures surface as bare "exited mid-turn".
- **[LOW][lifecycle] Mesh answer watcher expires at 15 min even while the target's turn is still running** — `src-tauri/src/session_fabric/mod.rs:828-845` — the eventual answer is never captured or forwarded.
- **[LOW][edge] One-shot stdout recv can discard a late-producing reply** — `src-tauri/src/agent_sessions/oneshot.rs:579-581` — 5 s `recv_timeout` gives up when a surviving grandchild holds the stdout pipe.

---

# Area 4 — System integration & security surfaces (browser, PTY, git, secrets, automations, lib/main, ~20K lines)

Overall: well-hardened (git subprocess timeouts, path-traversal validation in `git.rs`, keychain-backed secrets, exec gates). No verified Critical.

## High

- **[HIGH][security] Headless automations run full-auto and are creatable/runnable through the ungated MCP relay-tools path — prompt-injection → persistent privileged execution** — `src-tauri/src/automations.rs:99-106`, `browser_mcp.rs:366`, `mcp_tools_bridge.rs:37-58`
  Runs force `full_auto` with "do not ask questions" rules, and `create_automation`/`run_automation_now` are exempt from the browser trust layer. A prompt-injected agent driving the browser pane over malicious web content can persist a cron automation whose headless CLI turn executes arbitrary shell commands with no dialog and no user present — surviving even after the conversation ends. Require one-time user confirmation for bridge-created automations or a stricter headless permission mode.
- **[HIGH][bug] GitHub REST client has no HTTP timeout — every Pulls command can hang forever** — `src-tauri/src/github.rs:100-127` — a server that accepts but never responds leaves the command pending indefinitely. Add `.timeout(30s)` like other call sites.

## Medium

- **[MEDIUM][security] CSP allows a third-party script CDN and disables SmartScreen / auto-grants media permission prompts on the main window** — `src-tauri/tauri.conf.json:26,30` — `script-src 'self' https://cdnjs.cloudflare.com` lets a compromised cdnjs asset (or app-origin XSS injecting one) execute with full app IPC rights.
- **[MEDIUM][security] Capability set grants fs-read/dialog/opener/notification/updater to `browser-*` and `oauth-*` windows** — `src-tauri/capabilities/default.json:5-28` — combined with `validate_nav_url` allowing `file://` navigation in panes (`browser.rs:384-396`), an agent-navigated local page could read files via `fs`. Scope capabilities to `"main"` only.
- **[MEDIUM][security] `spawn_shell` exec gate remembers approval per working folder — one "Allow" permanently approves every future command in that folder** — `src-tauri/src/commands/pty_cmds.rs:211-225` + `exec_gate.rs:32-47` — key the grant on the exact command line or expire folder grants per session.
- **[MEDIUM][security/perf] `logs/browser.log` is append-only and unbounded** — `src-tauri/src/browser.rs:620-635` — no rotation or size cap.
- **[MEDIUM][bug] PTY frame-boundary splitting corrupts multibyte UTF-8 and ANSI sequences in the fallback emit and stripped transcript** — `src-tauri/src/pty/mod.rs:849, 872-935` — per-frame `from_utf8_lossy` and `strip_ansi` on ConPTY frames split anywhere → permanent U+FFFD and half-escapes feeding session-id/usage regex matching. Buffer bytes and convert only at sequence-complete flush points.
- **[MEDIUM][bug] `relay-browser-mcp` `round_trip` has no timeout — a wedged app side hangs the MCP stdio server forever** — `src-tauri/src/bin/relay_browser_mcp.rs:219-249`.
- **[MEDIUM][security] Windows MCP-server spawn re-parses user args through `cmd.exe /C`, and the approval identity is an ambiguous joined string** — `src-tauri/src/mcp_gallery.rs:346-354, 307` — args with `& | %VAR%` are shell-interpreted; two different arg vectors can hash to the same approval.
- **[MEDIUM][bug] `git worktree add` accepts branch names beginning with `-`** — `src-tauri/src/git.rs:213-221` — renderer-supplied `-x` becomes a git flag; sibling branch functions already guard this.
- **[MEDIUM][bug] `close_tab_for_pane` drops the map entry without closing the native webview** — `src-tauri/src/browser/tabs.rs:305-313` — on a race, an invisible input-swallowing WebView2 leaks (the documented ghost-webview bug).

## Low

- **[LOW][perf] Each navigation spawns a detached OS thread for post-nav injection** — `src-tauri/src/browser/navigation.rs:114-132` — the equivalent in `browser.rs:962` was migrated to tokio; this site was missed.
- **[LOW][security] Pre-auth WebSocket connections never time out** — `src-tauri/src/browser_mcp.rs:203-216` — any local process can hold unbounded connection tasks forever without sending the token.
- **[LOW][bug] Dead/footgun APIs: `attach_navigation_listeners` never called; `resolve_pane_request_emit` drops the receiver** — `src-tauri/src/browser.rs:1675`, `browser/tabs.rs:39-46` — answers routed through `browser_resolve_pane_result` can never be received.
- **[LOW][perf] PTY monitor thread polls at 200 ms forever, even with zero panes** — `src-tauri/src/pty/mod.rs:1277-1279`.
- **[LOW][bug] `get_git_log` graph-prefix heuristic can misclassify decorated lines with box-drawing glyphs** — `src-tauri/src/git.rs:976-983`.
- **[LOW][bug] PTY reader busy-waits in 3 ms slices up to the 16 ms frame budget** — `src-tauri/src/pty/mod.rs:983-991` — steady output pays a 16 ms latency floor.
- **[LOW][bug] `get_run_while_closed` maps every `schtasks /Query` failure to "not registered"** — `src-tauri/src/automation_task.rs:188-204` — a broken registration is silently overwritten with `/F` instead of surfaced.

---

# Area 5 — Frontend core logic (`src/lib/`, `src/state/`, `src/hooks/`, ~23K lines)

Context: the code is densely annotated with prior audit IDs and most classic bugs (unlisten races, buffer caps, surrogate-safe slicing) are already fixed. XSS surface is well defended (`src/lib/sanitize.ts` DOMPurifies every raw-HTML path). Findings that survived:

## High

- **[HIGH][state] Background session's queued message renders its optimistic bubble in the wrong transcript** — `src/state/chat/slices/streamingSlice.ts:155` — `sendMessage` keys the optimistic write off `forSplit` only; a queued message draining into a background non-split session appends the bubble to the *active* session's list, where it sits until the user switches sessions.
- **[HIGH][error-handling] Steer can silently discard the steered message and the whole queue** — `src/state/chat/slices/composerSlice.ts:34-46` — `steerQueuedMessage` empties the queue, then awaits `cancelStream` whose IPC calls are unguarded (`streamingSlice.ts:407-409`); a rejection loses everything the user stacked, with no restore.

## Medium

- **[MEDIUM][race] `selectSession` replaces the message buffer without `mergeOptimistic`** — `src/state/chat/slices/sessionsSlice.ts:158-163` — a send landing between the session-id flip and the fetch resolution makes the just-sent message disappear until the next turn.
- **[MEDIUM][state] Opening a session wipes the *other* pane's checkpoint chips** — `src/state/chat/slices/sessionsSlice.ts:195` — whole-map replacement clobbers the split pane's chips.
- **[MEDIUM][state] Errored/auto-finished partials never surface in the split pane** — `src/state/chat/slices/streamingSlice.ts:845` (also `:509`) — `onError`/`endRemoteTurn` refetches gate only on `activeChatSessionId`; the cancel path was fixed, these weren't.
- **[MEDIUM][perf] Chat token streaming bypasses the Channel transport built for it and clones two maps per token** — `src/hooks/useChatEvents.ts:71`, `streamingSlice.ts:528-543`, `lib/channels.ts:35` — `chatTokenChannel` is exported but never consumed; every token re-renders every subscriber of `streaming`/`chatStatus` at 50–200/s.
- **[MEDIUM][growth] Session-Mesh state is unbounded and survives `deleteChat`** — `src/state/chat/slices/meshSlice.ts:92,119` + `moduleState.ts:375-468` — `meshMail`, `meshMailBySession`, `meshChildren` are missing from the "strip EVERY per-session key" helper.
- **[MEDIUM][robustness] `onPlanUpdated` throws on a malformed `todos` payload** — `src/state/chat/slices/plansSlice.ts:88-96` — no `Array.isArray` guard, unlike the sibling question handler.

## Low

- **[LOW][growth] `docQa` verdict map grows forever per artifact path** — `src/state/docQa.ts:18-19`.
- **[LOW][state] Optimistic message ids use `-Date.now()` and can collide** — `src/state/chat/slices/streamingSlice.ts:128` — queue ids already moved to a monotonic counter for exactly this reason; delete/steer act BY ID.
- **[LOW][parsing] Re-sending identical text drops the still-optimistic bubble** — `src/state/chat/moduleState.ts:113-118` — `mergeOptimistic` matches by role+text, so the second copy is "explained away".
- **[LOW][error-handling] `loadSessionMetrics` rejections are unhandled** — `src/state/chat/slices/perfSlice.ts:11` — both call sites fire-and-forget.
- **[LOW][perf] Boot reads curated model lists with serial IPC round-trips** — `src/state/settings.ts:308-317` — sequential `getSetting` per provider inside the boot `Promise.all`.
- **[LOW][parsing] `encodeURI` leaves `%` unescaped in `file:///` artifact URLs** — `src/lib/sessionLauncher.ts:277-279` — a literal `%` in a Windows path breaks the artifact load.
- **[LOW][state] `invalidate` doesn't clear in-flight loading locks** — `src/state/pullRequests.ts:145-160` — fresh requests after switching back are silently skipped by `lockIsFresh`.
- **[LOW][hooks] `refresh` in `useCostRollups` can setState after unmount** — `src/hooks/useCostRollups.ts:29-34`.

---

# Area 6 — Frontend components, a–m (automations, chat, command-palette, common, cost-dashboard, documents-library; 66 files, ~25K lines)

## Critical

- **[CRITICAL][react-correctness] Conditional hook call crashes the whole app on first run row** — `src/components/automations/AutomationRunTable.tsx:102-126`
  `useNowSeconds(inFlight)` is called after two early returns. When the Past-Runs table transitions from zero runs to one row (e.g. "Run now" + the 5 s poll delivers the first row), React throws "Rendered more hooks than during the previous render". With **no error boundary anywhere in `src/`**, the exception unmounts the entire app to a blank window. Fix: move the hook above the early returns. *(Verified by hand.)*

## High

- **[HIGH][race-condition] Popout chat window auto-starts a junk session and races the empty-session sweep** — `src/components/chat/ChatView.tsx:740-757` — the auto-start effect guards split view but not popouts; a popout fires `deleteEmptyChatSessions()` (destroying untitled chats app-wide, including the one it was asked to show) and `newChat(...)`, racing the `popoutSessionId` select effect. Nondeterministic outcome.
- **[HIGH][edge-case] "Create artifact" intent detector silently swallows ordinary messages** — `src/components/chat/composerShared.tsx:88-119` (used at `ChatComposer.tsx:1037-1050`) — broad legacy phrases (`/create a loop/`, "schedule this", type-keyword + creation-verb triples) intercept messages like "I want to create a loop in my code that retries", wipe the draft, and show an artifact-proposal card instead of an answer. No undo.

## Medium

- **[MEDIUM][error-handling] `listConnectors()` rejection unhandled in @-attach source loader** — `src/components/chat/ChatComposer.tsx:509-541` — runs on mount and every session switch; failure yields an unhandled rejection and an empty `@` menu.
- **[MEDIUM][performance] ChatComposer is not memoized — its memoization defenses are dead code; inline prop defeats AgentModelPicker memo per streaming flush** — `ChatComposer.tsx:162` (no `memo()`), `ChatView.tsx:1653` (fresh arrow each render) — the whole composer body re-renders dozens of times/sec during streaming.
- **[MEDIUM][performance] O(messages) work per streaming flush scales badly on long transcripts** — `ChatView.tsx:1107-1194, 1233-1239, 1287-1289` — per token flush: full-list slice, O(n) `structureSig` string join, and `[...items].reverse().find()`. A 5–10k-message session pays several full-list passes dozens of times/sec.
- **[MEDIUM][race-condition] History-prepend failure is an unhandled rejection** — `src/components/chat/useTranscriptScroll.ts:166-176` — `void prepend.finally(...)` still rejects; scroll-anchor restore silently fails on DB/IPC error.
- **[MEDIUM][memory] Voice dictation retains the entire raw audio clip in memory for the whole session** — `src/components/chat/useVoiceDictation.ts:392-393, 312-318` — the repair pass only runs when a segment commit failed; 30 min of dictation holds ~115 MB of Float32Array refs for nothing.
- **[MEDIUM][performance] Automation detail re-renders entirely every 5 seconds even when nothing changed** — `src/components/automations/AutomationsView.tsx:597-614` — fresh array identity + loading toggles per background poll.

## Low

- **[LOW][error-handling] `listHarnessModels` effect has no `.catch`** — `src/components/chat/ChatView.tsx:183-189`.
- **[LOW][error-handling] `useLazyComponent` never handles loader failure** — `src/components/chat/ActivitySteps.tsx:66-76` — a failed Prism chunk leaves all code blocks un-highlighted forever.
- **[LOW][error-handling] Notification row click / automation delete: unhandled rejections** — `src/components/common/NotificationBell.tsx:116`; `AutomationsView.tsx:717` — the identical CommandPalette call got a `.catch(toastError)`; these didn't.
- **[LOW][error-handling] Budget remove/hide: try/finally without catch swallows errors** — `src/components/cost-dashboard/BudgetPanel.tsx:74-92`.
- **[LOW][performance] Markdown element cache keyed by the full message content** — `src/components/chat/ActivitySteps.tsx:1534-1539` — 240 entries can each pin a full message copy as the key plus its element tree; key on content hash instead.
- **[LOW][react-correctness] `jumpToLiveEdge` glide rAF loop is not cancelled on unmount** — `src/components/chat/useTranscriptScroll.ts:217-281`.
- **[LOW][edge-case] `beginVoiceRecording` catch path can leak a half-built audio graph** — `src/components/chat/useVoiceDictation.ts:487-490` — call `stopCapture()` instead of only stopping tracks.

Verification note: all `dangerouslySetInnerHTML` sites in this half (MermaidDiagram, DiagramLightbox, ArtifactPreviewPane) inject only DOMPurify-sanitized SVG — no XSS found; listener/interval cleanups correct except as noted.

---

# Area 7 — Frontend components, n–z + app root (panes, settings, sidebar, pet, onboarding, skills; ~20K lines)

## High

- **[HIGH][race/dead-feature] Terminal activity feed + pane-header activity detection can never fire in production** — `src/components/panes/TerminalPane.tsx:200-238`
  The feed/chip are driven by a `pty:output` event subscriber, but the backend only emits that event when **no** channel consumer is registered (`src-tauri/src/pty/mod.rs:833-848`), and TerminalPane itself always registers the channel on mount (`:348`). From the first mounted frame the event is suppressed — mermaid/html/jsx FeedCards and the header activity chip silently never appear.
- **[HIGH][error-handling] No error boundary anywhere — any render error white-screens the whole app** — `src/main.tsx:26`, `src/App.tsx:87` — verified by grep across `src/`; in a desktop shell with attached terminals/webviews the user must kill and restart.

## Medium

- **[MEDIUM][correctness] Background tab's iframe `onLoad` clobbers the active tab's load state** — `src/components/panes/BrowserPane.tsx:830-841` — one handler for every tab always writes `activeTabId` state; a background tab finishing load clears the active tab's spinner or marks it `loadFailed` wrongly.
- **[MEDIUM][race] ModelMarket search/sort responses resolve out of order and overwrite newer results** — `src/components/settings/ModelMarket.tsx:203-231` — no sequence guard (the ticket pattern already exists in `ApiKeysPanel.tsx:201-236`).
- **[MEDIUM][perf] Sidebar re-renders on every streamed token due to unstable selector** — `src/components/sidebar/Sidebar.tsx:165-167` — `Object.keys(s.streaming)` returns a fresh array identity per store notification, defeating `Object.is`.
- **[MEDIUM][correctness] External-peek diff never live-refreshes: FS listener checks the wrong cwd** — `src/components/panes/DevDiffPanel.tsx:631-635` vs `:569, :603` — filters on `cwd`, fetches against `diffCwd`.
- **[MEDIUM][data-loss] Debounced setting writes are dropped, not flushed, on unmount/close** — `src/components/settings/SettingsView.tsx:804-809` (web-search API keys), `LocalModelsPanel.tsx:141-149` — a key typed within 400 ms of closing Settings is silently never saved.
- **[MEDIUM][error-handling] Boot fetches without `.catch` leave panels stuck blank forever** — `SettingsView.tsx:667-677, 811-827`; `ConnectorsPanel.tsx:60-63`; `AcpAgentsPanel.tsx:44-46`; `PermissionRulesPanel.tsx:50-52`.
- **[MEDIUM][perf] SubagentPanel forces layout on every render during streaming** — `src/components/panes/SubagentPanel.tsx:152-159` — dep-less `useLayoutEffect` reading `scrollHeight` per token flush.
- **[MEDIUM][error-handling] Provider rail delete button has no failure handling** — `src/components/settings/ApiKeysPanel.tsx:419-436` — on rejection the row stays with no toast and the refresh never runs.

## Low

- **[LOW][edge-case] LocalElectricitySettings: a rejected settings read permanently hides the whole section** — `src/components/settings/LocalModelsPanel.tsx:759-768, 796`.
- **[LOW][error-handling] MemoryPanel action handlers swallow rejections into unhandled promise rejections** — `src/components/settings/MemoryPanel.tsx:298-304, 362-382, 257-266` — `toggleHistory` leaves a permanent spinner.
- **[LOW][correctness] `preventDefault` inside React's passive `onWheel` is a no-op** — `src/components/panes/ToolPanel.tsx:285-296` — needs a native non-passive listener.
- **[LOW][perf] `sessionsFor(project.id)` selector allocates per store change** — `src/components/sidebar/ProjectItem.tsx:24`.
- **[LOW][error-handling] SkillsLibrary save/create/remove have no rejection handling** — `src/components/skills-library/SkillsLibrary.tsx:157-184`.
- **[LOW][correctness] ModelMarket mmproj auto-fetch condition is convoluted and mis-scopes `vision::` ids** — `src/components/settings/ModelMarket.tsx:168-188` — works only because a downstream lookup filters it.
- **[LOW][dead-code] Unreferenced components: `ProgressPanel.tsx`, `ConnectorGrid.tsx`; dangling JSDoc in `SettingsView.tsx:892-894`.**

Verification note: the only raw-HTML render path (terminal HTML feed cards) correctly uses `sanitizeHtml` + `sandbox=""` iframe (`TerminalPane.tsx:727-732`); `innerHTML`/`srcdoc` grep over the scope returned zero other hits.

---

# Area 8 — Mobile app, mobile relay (desktop side), memory, artifacts, connectors, configs

Context: the desktop relay core is well-hardened (pairing fails closed on empty token, raw-token legacy path removed server-side, plaintext frames rejected on E2E connections, artifact reads containment-checked). No unauthenticated remote-execution hole found.

## High

- **[HIGH][mobile] Pairing error permanently downgrades phone to legacy raw-token mode → infinite reconnect loop that leaks the raw token** — `mobile/src/hooks/useRelay.ts:352, 317-322, 409`
  Any `ChatError` with `chat_session_id === "pair"` flips `_desktopLegacy = true`; the phone then re-pairs by sending the raw pairing token **in plaintext every 3 s forever**. The desktop removed raw-token pairing and rotates the token each launch, so the normal "desktop restarted" flow bricks the phone into this loop until the user re-scans the QR.
- **[HIGH][mobile] Chat stuck "streaming" forever after a mid-stream disconnect** — `mobile/src/hooks/useSessionChat.ts:173-295` — the hook never subscribes to connection state; after a WS drop the desktop's owner-map registration is cleaned up, so resumed tokens are dropped and no Done/Error ever arrives; the 50 ms flush interval runs indefinitely.
- **[HIGH][mobile] Token-only deep link corrupts the stored relay URL** — `mobile/src/lib/deepLinks.ts:103` + `mobile/App.tsx:117-119` + `useRelay.ts:414-425` — for `relay://connect#<token>` the bare token is handed to `connect()`, which **overwrites `relay.relayUrl` in AsyncStorage with the token string**; any link with a token fragment silently un-pairs the phone.
- **[HIGH][connector] `gdrive_read_file_content` treats any non-ASCII text as binary** — `src-tauri/src/connectors/google_rest.rs:517` — every UTF-8 file containing an em dash, é, or CJK returns "[binary file content]" instead of its content. Detect UTF-8 decode failure / NUL bytes, not ASCII-ness.
- **[HIGH][perf] Phone polls `GetCostSummary` every 5 s, which runs two full `cost_events` scans with per-row pricing under the global DB mutex** — `src-tauri/src/mobile/relay_requests.rs:262-311` + `mobile/src/hooks/useRelay.ts:253-256` — visibly stalls the desktop on a fixed cadence as the ledger grows.

## Medium

- **[MED][security] OAuth authorization codes logged to stderr** — `src-tauri/src/connectors/oauth.rs:740` — the full redirect URI including the single-use `code` goes to the console/log.
- **[MED][security] Live OAuth bearer tokens written to plaintext project config files** — `src-tauri/src/connectors/harness.rs:71-76` — fresh access tokens embedded in per-project `mcp.json`/`opencode.json`, outside the OS keychain.
- **[MED][security] Approval summaries (user content) pushed through Expo's cloud in plaintext** — `src-tauri/src/mobile/push.rs:80-88, 123-140` — a third party receives chat-derived content; push a generic body instead.
- **[MED][security] Pairing token + full URL stored in plaintext AsyncStorage, duplicated under two keys** — `mobile/src/hooks/useRelay.ts:423-424` — the desktop moved its token to the OS keychain; the phone should use `expo-secure-store`.
- **[MED][security] Phone "Always allow" writes a `pattern: ""` rule matching every path in every workspace root** — `src-tauri/src/mobile/session_chat.rs:548-567` — one tap auto-approves file writes/deletes everywhere, forever. Scope to the pending approval's directory.
- **[MED][mobile] No reconnect backoff; fixed 3 s retry forever** — `mobile/src/hooks/useRelay.ts:409`.
- **[MED][perf] Memory extraction re-reads the entire transcript once per chunk** — `src-tauri/src/memory/worker.rs:211-224, 300-308` — O(chunks × messages) DB work per run.
- **[MED][perf] Per-turn memory injection loads every active memory record including embedding blobs** — `src-tauri/src/memory/mod.rs:87` — on **every** send, just to find ≤2 identity facts.
- **[MED][connector] Gmail fallback reads return the raw API body uncapped** — `src-tauri/src/connectors/gmail_api.rs:192-210`; same unbounded `resp.text()` in `google_rest.rs:391, 516` — a huge thread blows the turn's token budget.
- **[MED][mobile] Markdown links opened with no scheme allowlist** — `mobile/src/components/chat/MarkdownText.tsx:235` — `intent://`, `file://`, custom schemes from assistant text launch arbitrary Android intents. Allowlist `https?:`.
- **[MED][artifacts] `/create` LLM calls have no timeout** — `src-tauri/src/artifacts/generator.rs:335, 456-461, 523-532` — a stalled provider hangs the `/create` command indefinitely.
- **[MED][artifacts] `slugify` produces an empty slug for non-Latin artifact names** — `src-tauri/src/artifacts/adapter.rs:61-68` — "中文助手" → `slash_command: "/"` and an empty installed-skill slug.
- **[MED][mobile] "Done with zero tokens" promotes an empty assistant bubble; flush interval never stopped on stuck stream** — `mobile/src/hooks/useSessionChat.ts:196-222, 193`.

## Low

- **[LOW][mobile] `connect()` on Home mount can tear down an in-flight (CONNECTING) socket** — `mobile/src/screens/HomeScreen.tsx:28` + `useRelay.ts:290-291`.
- **[LOW][rust] `ALTER TABLE … ADD COLUMN owner_session_id` attempted on every `GetSessionMessages`/`SendChatMessage`** — `src-tauri/src/mobile/session_chat.rs:24-32, 78` — hoist to a once-flag.
- **[LOW][rust] Up to 8 MB `fs::read` + base64 encode inside the async WS task** — `src-tauri/src/mobile/session_chat.rs:837, 861` — wrap in `spawn_blocking`.
- **[LOW][mobile] Attachment size caps bypassed when the document picker omits `size`** — `mobile/src/components/chat/ChatComposer.tsx:183` — `asset.size ?? 0` passes the check on iOS.
- **[LOW][rust] `StartLocalModel`/`ChatTurn` accept an arbitrary `gguf_path` from the phone** — `src-tauri/src/mobile/relay.rs:1308-1334`, `relay_requests.rs:326-356` — pair-gated, but an allowlist against the scanned GGUF registry would close it.
- **[LOW][rust] Any peer completing pairing gets the full provider/session/cost surface, with no per-device binding** — `src-tauri/src/mobile/relay.rs:560, 700-715` — fine for single-user; add an explicit device list later.
- **[LOW][config] `index.html` pulls 8 font families from fonts.googleapis.com at startup** — `index.html:10-16` — a local-first app phones home on every cold start and FOUTs offline; self-host.

Config/scripts verdict: `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `mobile/app.json`, `mobile/eas.json`, `Cargo.toml`, and `scripts/` (grepped for destructive ops) — no exposed debug settings, permissive CORS, or unsafe script operations found; bundled downloads are pinned + hash-verified.

---

# Coverage & limitations

| Area | Files | Coverage |
|---|---|---|
| `src-tauri/src/chat/` | 57 | All read fully except `docgen_helper.py` + vendored `paged.polyfill.min.js`; `prompts.rs`/`office.rs`/`tools/specs.rs` logic-complete (long constants skimmed) |
| `src-tauri/src/db/` + `commands/` | 42 | All 42 read fully (incl. tests) |
| `agent_sessions/`, `session_fabric/`, `acp/`, `harness_adapters/`, harness root files | 27 | Core files fully; remaining harness adapters partially (mirror `kimi_code.rs` patterns) |
| Browser, PTY, git, secrets, automations, mcp, lib/main, bins, bridges | ~30 | All read fully except vendored `bridge_readability.js` and `bridge_extract.js` (partially) |
| `src/lib/`, `src/state/`, `src/hooks/` | ~135 non-test | All production files read fully except `docdesign/` data-heavy files + static theme/icon tables (structural skim) |
| `src/components/` (a–m) | 66 | All read; a few bulk-skimmed |
| `src/components/` (n–z) + `App.tsx`/`main.tsx`/`types.ts`/`dev/` | ~55 | All read fully except `types.ts` (types only) |
| `mobile/` + `src-tauri/src/mobile/`, `memory/`, `artifacts/`, `connectors/` | ~50 | All read fully/partially as noted; relay test files skimmed |
| `scripts/`, root configs | ~15 | Skimmed via targeted greps + headers; clean |

**Not audited in depth (deliberate):** `src/test/` (151 test files, ~20K lines — tests don't ship), vendored third-party JS (`Readability`, `paged.polyfill`), and the 200 prior-audit markdown reports at the repo root (this audit was performed fresh against source, not derived from them).

**Cross-cutting checks that came back clean:** every scoped `#[tauri::command]` is registered in the invoke handler; non-test `unwrap/expect` in scoped Rust is limited to a handful of safe-by-construction sites; no lock-across-await in `db/`/`commands/`; all sanitized-HTML sinks verified to DOMPurify before injection; no XSS sink found in any frontend half.

---

# Fix status (2026-09-14, branch `fix/codebase-audit-2026-09-14`)

All findings were remediated and verified: **`cargo test` green (1129 lib tests + bins/integration), `tsc --noEmit` clean, vitest 1083/1083 tests in 156 files green** (baseline before fixes: 1 pre-existing vitest failure — the `automationStop` duration test, which this branch also repairs by fixing the underlying hook bug and pinning its clock).

**Fixed:** 145 of 152 findings. Highlights: the Critical conditional hook (plus a new app-level error boundary), the DB-move location-write and clobber-refusal, the model-download `destDir` containment gate, the cmd.exe model-alias spawn gate, one-shot confirmation for relay-created automations, the mobile plaintext legacy-pairing downgrade (removed) with exponential backoff, and the deep-link URL corruption.

**Skipped with reasons (7):**
1. CSP `cdnjs` entry (`tauri.conf.json`) — deliberate contract: srcdoc artifact previews inherit the main CSP and `src/test/csp.test.ts` asserts these directives; removal breaks preview rendering.
2. Harness bearer tokens in project `mcp.json`/`opencode.json` — tokens are functionally required by the harness CLIs; env-var indirection needs a coordinated spawn-path refactor outside this branch's scope.
3. Mobile `expo-secure-store` migration — not an existing dependency and no dependency installs were in scope; the duplicate AsyncStorage key was removed instead (single copy remains).
4. Vector-search full-embedding materialization (`db/docs.rs`) — documented as acceptable at current scale in the original audit; no cheap bound available without sqlite-vec.
5. Per-device binding for paired phones — product decision (multi-device model).
6. Google Fonts self-hosting (`index.html`) — no local font assets exist in the repo; a font pipeline change, not a bug fix.
7. `WebView2` feature flags (SmartScreen/media prompts) — deliberate configuration; left unchanged.

**Audit corrections found during fixing (2):**
- Finding "encodeURI leaves `%` unescaped" (frontend LOW, sessionLauncher) was a **false positive** — `encodeURI` already escapes bare `%` to `%25`; the first fix attempt actually introduced a double-encoding regression, which was reverted. The named-helper refactor and its tests were kept.
- Finding "opencode tool card duplication" — the production dedupe fix was correct; its new unit test initially miscounted result cards as call cards and was corrected.

**Test-suite additions on this branch:** 5 new frontend test files (`errorBoundary`, `selectSessionBuffers`, `sessionLauncherFileUrl`, `terminalActivityChannel`, `queueBubble`) plus 8 extended suites; new Rust unit tests for the cmd-safety gate, PTY split-sequence carrying, git-log parsing, worktree dash guard, schtasks failure mapping, MCP identity/quoting, LIKE escaping, same-second artifact dedupe, unicode query folding, gdrive binary detection, response capping, and slug fallbacks.
