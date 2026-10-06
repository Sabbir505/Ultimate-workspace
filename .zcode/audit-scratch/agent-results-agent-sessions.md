# Agent findings: agent_sessions (14 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:31

FILES COVERED: src-tauri/src/agent_sessions/{mod,opencode,claude,handlers,oneshot,perturn,tracker,acp,dirwatch,lifecycle,ask,primer,bundle,attachments}.rs

## P0

none

## P1

**1. Dead opencode SSE reader is never repaired — chat enters a permanent turn-failure loop with lost (billed) replies (~90% confidence)**
- `agent_sessions/opencode.rs:55-64`: the server-reuse decision keys only on TCP liveness (`opencode_server_alive`), the config stamp, and cwd — it never consults `entry.oc_reader_alive`.
- `agent_sessions/opencode.rs:788-796`: the SSE reader performs exactly one `GET /event` with no retry; any single failed connect, stream error, or server-cycled connection makes `read_opencode_server_events` return, dropping `oc_reader_alive` to false while the server stays TCP-alive. Every subsequent send reuses the "healthy" server: the POST runs the full model turn (tokens billed), all streamed text is lost, and the audit-#87 branch (`opencode.rs:236-252`) errors with "Retry the turn — Relay will restart the server if needed" — but no restart ever occurs, because `alive` stays true. The chat is wedged until the config stamp/cwd changes, the server dies, or the app restarts.
Fix: add `|| !entry.oc_reader_alive.load(Ordering::SeqCst)` to the respawn condition at opencode.rs:64, and/or retry the `GET /event` with backoff before giving up.

## P2

**2. Reader loops: unbounded line growth, and any I/O error (including one invalid-UTF-8 byte) silently terminates the turn (~85%)**
- `agent_sessions/claude.rs:649-653` (identical shape at perturn.rs:660-664 and acp.rs:467-471): `match reader.read_line(&mut line) { Ok(0) => break, Ok(_) => {}, Err(_) => break }`. `read_line` returns `InvalidData` for a single non-UTF-8 byte; the loop treats that as EOF, so the reader exits mid-turn: for the persistent claude process this emits "Claude Code exited mid-turn", discards the streamed reply, and respawns a healthy CLI. Realistic Windows trigger: `cmd.exe /C` wrapper printing localized (OEM-codepage, non-UTF-8) messages to stdout. The loops also grow `line` without a cap — the SSE path guards this with the 4 MiB `SseLineBuffer`. Fix: `read_until(b'\n')` + `String::from_utf8_lossy`, `continue` on decode errors, cap the buffer.

**3. `spawn_per_turn` overwrites `entry.child` without killing/reaping the previous child (~85%)**
- `agent_sessions/perturn.rs:463`: `entry.child = Some(child);` — every other adapter tears the old child down first (`acp.rs:242-244`, `opencode.rs:65-67` via `kill_child_tree`). Dropping a `Child` neither kills nor reaps it: on Unix the exited CLI stays a zombie until the next send, and a still-alive old tree is orphaned beyond the session's kill reach (`cancel()` and the old watchdog can no longer see it). Fix: take-and-`kill_child_tree` the prior child before assigning.

**4. `run_one_shot` leaves an orphan user message on early failure (~85%)**
- `agent_sessions/oneshot.rs:32-44` persists the user row, then `oneshot.rs:130` and `oneshot.rs:185-186` return early without deleting it. `AgentSessionManager::send` upholds the opposite invariant (mod.rs:947-959 deletes the user row when dispatch fails, "orphan user bubble with no reply … survives restarts"). A failed automation spawn (unknown harness, CLI missing) leaves a permanent user bubble with no reply. Fix: capture the message id and delete it on every early-error return, mirroring `send`.

**5. ACP `session/error` leaks the registered turn-perf accumulator (~85%)**
- `agent_sessions/acp.rs:773-789`: unlike every sibling error path (acp.rs:502-503 and the `session/finish` cancelled branch at acp.rs:740 both call `crate::chat::turn_perf::unregister(sid)`), this arm neither unregisters nor resets `perf = None`. The stale accumulator — carrying the failed turn's timestamps — produces wrong TTFT/tok/s for the next turn, and the registry entry lingers with its heartbeat until process exit. Fix: add `unregister(sid); perf = None;` in this arm.

**6. `STREAM_STATE_CAP` clear wipes `roles`/`part_kinds`, letting the USER prompt echo render into the assistant transcript (~80%)**
- `agent_sessions/opencode.rs:888-897`: cap-clear of `roles` forgets which message ids are user-role, and the lenient filter (`opencode.rs:1062-1066`: unknown ids default to rendering) then admits the user-message prompt echo — persona, primer and all — into `full_cell`, i.e. the persisted assistant reply. Clearing `part_kinds` additionally misroutes reasoning deltas to the `text` fallback. On a long-lived server ("hundreds of turns"), crossing 8192 ids mid-message is when this fires. Fix: on cap breach keep the most recent N entries (or clear only `tool_states`).

**7. `wait_for_turn_idle` holds the global `sessions` map lock across the per-session lock (~80%)**
- `agent_sessions/mod.rs:374-385`: the map lock is held while blocking on `entry.lock()`, so a question answer racing that chat's own send-setup stalls `send`/`cancel`/`remove_session` for every other chat for the whole setup window (up to the 20 s opencode server boot). B-8's contract (mod.rs:70-76) says the outer lock is "only for map insert/remove/lookup". The `busy_flags` registry already exists to read this flag without the inner lock. Fix: clone the entry Arc (or busy flag) out under the map lock, drop the map lock, then poll.

**8. Per-send redundant filesystem/DB work (~85%)**
- `agent_sessions/mod.rs:705, 737-747, 765, 861` + `opencode.rs:32-41`: a single opencode send calls `spawn_dir(cwd, &db.0)` twice (each taking the DB lock, reading settings, `create_dir_all`), then `send_opencode_turn` re-runs `resolve_harness_bundle` — re-writing bundle files, re-listing artifacts, re-reading AGENTS.md/wiki/memory — even though `send` already resolved the same bundle for a fresh session. Fix: resolve bundle and watch dirs once in `send` and pass down.

**9. DRY: duplicated per-harness spec assembly and verbatim-duplicated plan-mode directive (~85%)**
- `agent_sessions/oneshot.rs:423-519` duplicates `one_shot_spec` (oneshot.rs:815-943) arm-for-arm (claude/kimi/opencode/pi-omp/commandcode flag lists, `ensure_cmd_safe_model` gates, `resolve_opencode_model` qualification) with only the claude `--bare`/`--output-format json` delta — two parallel tables that must be kept in sync when a harness changes.
- `agent_sessions/perturn.rs:177-186` and `perturn.rs:295-304` contain the identical multi-line `[PLAN MODE ACTIVE — read-only. …]` directive copy-pasted for kimi and pi/omp. Fix: extract one `plan_mode_directive(content) -> String` helper; fold the one-shot spec builders into a single parameterized builder.
