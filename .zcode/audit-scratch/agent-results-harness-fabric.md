# Agent findings: harness/fabric layer (16 files)
# Status: COMPLETE — verified result captured 2026-10-02 20:00

FILES COVERED: src-tauri/src/session_fabric/{mod,eval}.rs, harness_adapters/{mod,kimi_code,claude_code,opencode,commandcode,omp,pi,pricing}.rs, harness_config.rs, harness_bundle.rs, harness_subagent_watch.rs, acp/{mod,events}.rs, acp_agents.rs

## P0

none

## P1

**1. Subagent release watcher frees the concurrency slot and settles the run row before the first turn ever starts — caps are defeated and failures are recorded as "ok".**
- session_fabric/mod.rs:1729-1748 (mesh path) and mod.rs:2240-2259 (manual path):
```rust
tauri::async_runtime::spawn(async move {
    let started = std::time::Instant::now();
    while session_busy(&app_for_slot, &slot_child) { ... sleep(POLL_MS).await; }
    crate::chat::subagents::bump_running(&slot_agent, -1);
    if let Some(run_id) = slot_run { ... finish_subagent_run(&&conn, &run_id, status, ...) }
    release_outcome_listeners(&app_for_slot, listener_ids);
});
```
Both watchers are spawned *before* `run_turn` is dispatched (mesh: watcher 1729, run_turn 1767; manual: watcher 2240, run_turn 2346 — with async worktree provisioning between at 2275 yielding repeatedly). The loop's FIRST `session_busy()` poll happens while `turn_in_flight` is still false (only set inside mgr.send at perturn.rs:462, after connector resolution + CLI spawn), so the loop body never executes: slot bumped −1, `finish_subagent_run(..., "ok", None)` (child session brand-new — subagent_run_settle_pair(&None) is ("ok", None)), listeners unlistened — all before the turn starts. Consequences (verified): (a) `max_concurrent`/MAX_ACTIVE_SUBAGENT gate spawn instants only — fan-out can exceed every cap; (b) the premature "ok" settle is final (`WHERE id = ?1 AND status = 'running'`, db/subagents.rs:464-468) — a first turn that later fails mid-stream is never recorded as an error, nullifying arm_subagent_run_outcome's synchronous registration contract (mod.rs:2041) and making spawn's fail-fast error settle (:2354) a no-op when the watcher polled first. The codebase knows the fix pattern — watch_answer (mod.rs:1019-1020) and spawn_spawn_result_reporter (:1247-1248) both open with a start-grace. Fix: in both release watchers, first wait for `session_busy` to flip true within a bounded start-grace; treat never-went-busy as "turn failed to start" and settle accordingly.

**2. Project-level native subagent stores never trigger a re-sync — the `project:fs-changed` payload is the watched root, not the changed file.**
- harness_subagent_watch.rs:83 `if !is_native_store_path(changed, &dirs) && !is_project_store_path(changed) { return; }`.
`is_project_store_path` (:95-114) matches paths whose parent chain is `<root>/.claude/agents` etc. — but the event payload `changed` is never a file path: git_watcher's notify callback discards `ev.paths` ("We only care that *something* changed", git_watcher.rs:108-111) and the debouncer emits the watched root (:163/:240 → `app.emit("project:fs-changed", canon...)`). For a project-level store the emitting watcher is the recursive per-project one, so the payload is e.g. `D:\proj` — parent `D:\`, file_name `proj`, not in {agents, agent}: the check can never match a project root; `is_native_store_path` also fails (not under a user-level store). `spawn_resync` never fires. The module header declares this a correctness requirement (:9-18). Trigger: import an agent from `<proj>/.claude/agents/x.md`, then edit it — the linked row stays stale until manual sync/restart. Fix: have git_watcher emit the changed file's path (notify callback has ev.paths; keep root-emitting behavior for the frontend via a payload carrying both).

## P2

**3. `is_native_store_path` never matches on Windows (`\\?\` verbatim prefix) — the OpenCode user store's re-sync is dead — harness_subagent_watch.rs:48-51.**
The payload is a `canonicalize()` result, which on Windows carries `\\?\` (documented in util.rs:81-83, the reason strip_unc_prefix exists); `existing_native_store_dirs()` builds plain home_dir()-joined paths, so `starts_with` fails unconditionally on Windows. Masked for claude/kimi/omp/commandcode (their user store dirs accidentally satisfy is_project_store_path's structural match); the OpenCode user store `~/.config/opencode/agent` fails BOTH checks — owner segment `opencode` (no leading dot; matcher has `.opencode` = project-level only). Edits to OpenCode native agents never re-sync at all. Fix: run both sides through `strip_unc_prefix`; add the user-level opencode layout to the structural matcher.

**4. `spawn_envelope` advertises `message_session`/`spawn_session` to CLIs that have no relay-tools — session_fabric/mod.rs:1881-1887 (built unconditionally at :1759).**
mesh_spawn_session happily produces children on harness:pi/omp/commandcode, but `harness_has_relay_tools` (mod.rs:93-95) excludes pi/omp. The exact anti-pattern the codebase documents twice (harness_bundle.rs:108-113 "advertising tools a CLI doesn't have made it answer 'I have no relay-tools session spawn' instead of delegating"; resumed_turn_hint mod.rs:316-328 gates the same guidance). Fix: thread the has_relay_tools resolution into spawn_envelope and drop/replace the mesh-tool sentences for tool-less engines.

**5. DRY: winget upgrade CommandSpec duplicated verbatim across two adapters — claude_code.rs:84-97 and opencode.rs:85-98.**
Both contain the identical winget upgrade block; the package-id helper already lives in mod.rs:860. Fix: `winget_upgrade_command(resolved) -> Option<CommandSpec>` next to it.

Not reported after verification: model-probe blocking in harness_config already spawn_blocking'd with 30s TTL cache; connector MCP names from the fixed CONNECTORS registry can't shadow built-in server names; watch_answer/spawn_spawn_result_reporter have no pre-turn idle race (they await mgr.send which sets turn_in_flight before returning); no lock-across-await, panic-reachable-from-harness-output, or ACP frame-desync issues in scope.
