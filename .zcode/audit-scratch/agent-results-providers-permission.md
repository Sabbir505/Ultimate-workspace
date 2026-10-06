# Agent findings: chat providers/permission (16 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:12. Its P0 (#1) is the SAME bug independently found by the dispatch-core agent (chat/dispatch.rs:1670 wrong arg keys) — two agents converged, cross-confirmed.

FILES COVERED: src-tauri/src/chat/{providers,subagents,permission,tasks,local_models,compaction,prompts,reconnect,auto_router,model_health,cache,llm_client,context_windows,error_class,turn_perf,cloud_compact}.rs — all 16 read in full; cross-file call sites read only to verify reachability.

## P0

**1. Subagent move/copy scope gate reads the wrong argument keys — filesystem scope bypass (confidence 95).**
- dispatch.rs:1670 (found verifying enforcement of permission.rs::path_within_scope; schema/executors at chat/tools/specs.rs:2458-2473 and chat/tools/fs.rs:362-363).
The subagent scope gate — "the only thing standing between a granted `write_file` and the whole filesystem" for subagents (they have no approval card) — extracts paths with keys that don't exist in the tool schema: `vec![arg("source"), arg("destination")]` vs the advertised `"required": ["src", "dest"]` (specs.rs:2471) and executors reading `arg_str(args, "src")/"dest"` (fs.rs:362-363, 389-390). Both extracted strings are always `""`, the `p.is_empty()` early-return skips the entire gate, and any `workspace_write` subagent whose allowlist includes `move_file`/`copy_file` (both in WORKSPACE_WRITE_TOOLS, subagents.rs:170-179) can move (delete from source, write to destination — fs.rs:374 raw `std::fs::rename`, even creating dest parent dirs) ANY absolute path on disk, inside or outside granted roots, with no approval and no scope check. The unit test pins the bug (dispatch.rs:4803 uses the same wrong keys, passes vacuously). Fix: `vec![arg("src"), arg("dest")]` + fix the test fixture. (Main-loop path is correct: fs_target_path uses "dest", dispatch.rs:3102 uses "src".)

## P1

**2. Background shell output retained without any byte cap — unbounded memory growth — tasks.rs:1073-1094 (confidence 90).**
The deque is capped at 40 *lines*, never bytes; `SHELL_OUTPUT_CAP` (200k chars) applies only to the copy in `snap.message`, not what is retained. `BufReader::lines()` has no line-length limit, so a single newline-free line (minified JSON, base64 blob, `type big.bin`) of hundreds of MB is retained for the task's lifetime — and background shells (documented `background: true` + no timeout class) live for the app's lifetime. The foreground path got exactly this fix (D1/SHELL_DRAIN_CAP/BoundedTail, line 510); the background path did not. Each throttled emit also re-clones/re-joins the whole deque. Fix: running byte total, per-line truncation (~64 KiB head+tail+marker), evict oldest on budget — or reuse `BoundedTail` per stream.

## P2

**3. `kill_process_tree` runs a blocking `taskkill` subprocess on the async runtime — tasks.rs:517-535, called from async at 1114, 1126 (85%).**
`.status()` blocks until taskkill completes (seconds on large trees); invoked inside `async fn shell_task` cancel/timeout arms. Foreground caller is safe (dispatch.rs:860 spawn_blocking); background is not. Fix: `spawn_blocking` at the call sites.

**4. Download resume: stale/oversized `.part` causes a permanent 416 failure loop; changed upstream files corrupt silently — tasks.rs:807-810, 833-835, 867-869 (80%).**
(a) a `.part` longer than the remote's current size yields HTTP 416 → non-retryable `Err`, `.part` never deleted → every future download to that URL fails forever. (b) no If-Range/ETag → a remote that changed but stayed ≥ same length resumes by concatenating mismatched bytes into a silently corrupt file (model weights that fail to load). Error string discards the body. Fix: on 416 (or 200 to a Range request) delete `.part` and restart from 0; send `If-Range: <etag>`; include a body snippet.

**5. Chat/embedding sidecar health-check clients have no request timeout — model start can hang forever — local_models.rs:1083-1086 (chat ladder) and 1385-1388 (embedding) (85%).**
Every poll is `client.get(&health_url).send().await` with no `.timeout(...)`; a llama-server that is alive, listening, but not answering (wedged GPU driver) parks the health loop forever, defeating the documented per-rung budget and the whole GPU fallback ladder (no outer timeout on `start()`). Other probes do it right: 2s at :668, 5s at :1505. Fix: `.timeout(Duration::from_secs(2))` on both builders.

**6. Non-Windows PATH probe blocks the async runtime with an unbounded subprocess — local_models.rs:1989-1994 from async `start()` at :918 (85%).**
`llama-server --version` via `.output()` with no bound; a hanging binary wedges `start()` indefinitely (`probe_llama_version` at :2099 already implements the bounded 4s pattern). Windows skips this branch. Fix: same detached-thread + recv_timeout(4s) pattern, or spawn_blocking.

**7. Cloud compaction sends the summarizer request with no total-size bound — the overflow-recovery path can itself overflow — cloud_compact.rs:260-287 (80%).**
No equivalent of the local path's `summarizer_input_budget_chars` truncation + map-reduce (compaction.rs:837-928). The threshold trigger keeps the head under window, but the *forced* compaction after a real context-overflow 400 does not: with history already over the window (including under-counted CJK prompts, estimate divides by 4), the summarize request itself 400s → `run_cloud_compaction` Err → caller "sends as-is" → the turn dies with the raw overflow error the module exists to prevent. Fix: port the local budget (truncate `to_compact` from the oldest end against `window * ~3` chars minus max_tokens; map-reduce the dropped span — machinery already pub(crate)).

**8. `download_file` containment is skipped entirely when `fs_roots` is empty — including under AutoEdit where no card fires — dispatch.rs:3046-3055 (80%).**
`check_system_permission` returns AutoRun for download_file under AutoEdit/FullAccess (permission.rs:299-306), relying on this dispatcher-side gate for containment. The `!caps.fs_roots.is_empty()` bypass exists so Manual-mode users see the approval card — but under AutoEdit/FullAccess with no roots granted there is no card AND no containment: a (potentially injected) model writes to any absolute path (startup folders, PATH binaries) with zero gates, while `write_file` in the same session is hard-blocked by empty-roots. Fix: skip the hard gate only when an approval card will actually be shown (`matches!(approval, OnRequest | ConfirmEdits) || ...`).

**9. Anthropic effort-tier → extended-thinking mapping silently dropped on the tool loop (the default path) — providers.rs:337-366 vs streaming.rs:1690-1714 (85%).**
`anthropic_thinking_for`'s doc contract: "Used by BOTH the non-tool builder … and the streaming tool-loop body — the two must stay in lockstep." The tool-loop builder only honors the brain toggle (`if req.thinking == Some(true)`); `req.effort` is never consulted — with tools on (the default), selecting an effort tier on Anthropic models is a silent no-op; cap-floor logic also diverges. (Inverse panic risk checked: both call sites floor max_tokens ≥3072, so the `clamp(1024, max_tokens-1)` panic is unreachable today.) Fix: call the shared `anthropic_thinking_for(req)` in `build_anthropic_body`.

**10. DRY: tokenization assembly duplicated between `ChatMessage` and `CompactionEntry` variants — compaction.rs:242-261 and 298-317 (90%).**
Byte-for-byte the same framing loop (`<|role|>\n content \n`, optional system header); the format must stay identical or /tokenize counts diverge from wire cost — the entries variant already omits the `sys.trim().is_empty()` guard the messages variant has. Fix: one generic `assemble<T>(system, items, f)` with both wrappers calling it.

Verified clean: `anthropic_thinking_budget` clamp panic unreachable; run_shell_to_completion on spawn_blocking; llm_client one-shots surface HTTP errors; save_last_good_ngl wired; LocalModelRegistry stop/stop_kind avoid holding handles lock across await; TaskManager lock ordering (tasks → cancel → snapshot) consistent; reconnect ladder passes refusals through, cancel/budget-safe; model_health blob pruning bounded; subagents registry cache re-entrancy guards + poison-tolerant; permission.rs canonicalize handles ../case/separators without panics; turn_perf lock ordering acyclic.
