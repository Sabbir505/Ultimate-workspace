//! Claude/ACP turn dispatch and the ACP JSON stream reader — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
// ---------------------------------------------------------------- claude_code
/// Persistent-process path: spawn on first use (or on model change), then
/// write the turn as a stream-json stdin line.

pub(super) fn send_claude_turn(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    content: &str,
    entry: &mut AgentChild,
    cwd: Option<&str>,
    project_id: Option<&str>,
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Result<(), String> {
    // The persisted permission-mode label rides the spawn flags; a changed
    // label must respawn exactly like a changed model does — the CLI process
    // is long-lived and never re-reads the DB. (The mode menu ALSO live-applies
    // via set_permission_mode where the running CLI supports it; this is the
    // deterministic backstop for that best-effort path.)
    let current_mode = chat_permission_mode_label(db, sid);
    // The session's effort tier rides the same contract: `--effort` is baked
    // into the CLI invocation, so a changed tier must respawn exactly like a
    // changed model or mode does — the long-lived process never re-reads it.
    let current_effort = chat_effort_level(db, sid);
    // B-5: a CLI that died between turns leaves `child` Some holding a dead
    // pipe — its reader's RAII guard dropped `reader_alive`, so respawn on
    // that too instead of failing every later send with a broken-pipe error
    // (same intent as the opencode path's opencode_server_alive probe).
    if entry.child.is_none()
        || !entry.reader_alive.load(Ordering::SeqCst)
        || entry.spawned_model.as_deref() != Some(entry.model.as_str())
        || entry.spawned_mode.as_deref() != Some(current_mode.as_str())
        || entry.spawned_effort.as_deref() != Some(current_effort.as_str())
    {
        if let Some(mut old) = entry.child.take() {
            kill_child_tree(&mut old);
        }
        // The dead process's stdin is a broken pipe — drop it so a respawn
        // failure can't leave a stale handle behind (B-4/B-5 hygiene).
        // MUST be a scoped block: spawn_claude below re-locks this same
        // stdin cell to install the fresh child's pipe. A std Mutex is not
        // reentrant — a guard held across that call would deadlock the send
        // on itself WHILE holding the global `sessions` mutex, freezing
        // every later send/cancel and the main thread behind them (the
        // whole window goes "Not Responding").
        {
            let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
            *guard = None;
        }
        // Fresh per-process cancel flag: a respawn after cancel() must not
        // inherit the previous process's `true`.
        let cancelled = Arc::new(AtomicBool::new(false));
        entry.cancelled = Arc::clone(&cancelled);
        let (child, spawned_mode, spawned_effort) = spawn_claude(
            app,
            db,
            sid,
            &entry.model,
            cwd,
            project_id,
            &entry.turn_in_flight,
            &entry.cli_session_id,
            &cancelled,
            &entry.reader_alive,
            &entry.proc_generation,
            &entry.stdin,
            connectors,
        )?;
        entry.child = Some(child);
        entry.spawned_mode = Some(spawned_mode);
        entry.spawned_effort = Some(spawned_effort);
        entry.spawned_model = Some(entry.model.clone());
    }

    let line = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": content }],
        },
    })
    .to_string();
    // Set turn_in_flight BEFORE the stdin write (mirrors spawn_per_turn): the
    // reader thread can see this turn's `result`/EOF and clear the flag in
    // the gap between write and store — the trailing store would then re-set
    // a flag the reader already cleared, wedging every future send with
    // "turn already running". The flag can only legitimately transition
    // true→false from a result arriving, which requires the write first.
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    let write_result = {
        let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
        let stdin = guard.as_mut().ok_or("agent process stdin is closed")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
    };
    if let Err(e) = write_result {
        // The turn never reached the CLI — undo the flag we just set so the
        // next send isn't blocked by a phantom in-flight turn.
        entry.turn_in_flight.store(false, Ordering::SeqCst);
        return Err(format!("failed to write to CLI stdin: {e}"));
    }
    Ok(())
}

/// Map our catalog/config model ids to what `claude --model` accepts:
/// aliases ("fable" | "opus" | "sonnet" | "haiku") resolve through the CLI's
/// own settings (including relay remaps); anything else passes through.
pub(super) fn claude_model_alias(model: &str) -> String {
    let m = model.to_lowercase();
    if m.contains("fable") {
        "fable".to_string()
    } else if m.contains("opus") {
        "opus".to_string()
    } else if m.contains("sonnet") {
        "sonnet".to_string()
    } else if m.contains("haiku") {
        "haiku".to_string()
    } else {
        model.to_string()
    }
}

// ---------------------------------------------------------------- ACP (roadmap #20)
//
// ACP (Agent Client Protocol) is a JSON-RPC 2.0 protocol over stdio spoken by
// Zed/Devin-ecosystem agents. The client launches the binary, does the
// initialize → initialized handshake, opens a `session/new`, then drives each
// turn with `session/request` and streams `session/update` notifications until
// `session/finish`. Wire framing + event translation live in `crate::acp`;
// this section owns the process lifecycle, reusing the persistent-process
// shape of the claude path (one long-lived child per chat, shared stdin, a
// reader thread normalizing output onto the chat's `chat:*` events).
//
// v1 scope: text/reasoning streaming, tool-call markers (replied to with an
// error result so the agent doesn't hang), request/cancel, fresh session per
// spawn. Out of scope: `session/prompt` (agent-initiated questions), MCP
// server registration, tool execution.

/// Write one ACP message (a JSON line) to the child's stdin.
pub(super) fn write_acp_line(stdin: &mut std::process::ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

/// Write one ACP message through the shared stdin cell (used by reader
/// threads, which don't own the stdin guard directly).
pub(super) fn write_line_shared(
    shared: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    line: &str,
) -> std::io::Result<()> {
    let mut guard = shared
        .lock()
        .map_err(|_| std::io::Error::other("stdin lock poisoned"))?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| std::io::Error::other("stdin closed"))?;
    write_acp_line(stdin, line)
}

/// Persistent-process path for ACP agents: spawn on first use, handshake,
/// then `session/request` per turn. The reader thread performs the handshake
/// for the FIRST turn (the content is queued in `entry.acp_pending` and sent
/// once `session/new` returns); later turns write the request directly — the
/// session id is known by then, serialized under the session_id lock so the
/// reader can never double-send the first request.
pub(super) fn send_acp_turn(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    content: &str,
    entry: &mut AgentChild,
    cwd: Option<&str>,
    _project_id: Option<&str>,
    acp_id: &str,
) -> Result<(), String> {
    let agent = {
        let conn = db.0.lock();
        crate::acp_agents::find_agent(&conn, acp_id)
    }
    .ok_or_else(|| format!("ACP agent '{acp_id}' is not registered"))?;
    // B-4/B-5: respawn when the previous reader is dead even though `child`
    // is still Some — a handshake failure returns from read_acp_stream early
    // and used to leave the child cell occupied with no reader alive, so the
    // queued turn was never drained and every later send was rejected.
    if entry.child.is_none() || !entry.reader_alive.load(Ordering::SeqCst) {
        if let Some(mut old) = entry.child.take() {
            kill_child_tree(&mut old);
        }
        // The dead process's stdin is a broken pipe — drop it with the rest
        // of the old state before respawning fresh.
        {
            let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
            *guard = None;
        }
        // Fresh per-process cancel flag: a respawn after cancel() must not
        // inherit the previous process's `true`.
        let cancelled = Arc::new(AtomicBool::new(false));
        entry.cancelled = Arc::clone(&cancelled);
        // ACP has no `--resume`: every spawn opens a brand-new session via
        // session/new. Drop any stale captured id so the handshake restarts.
        if let Ok(mut g) = entry.cli_session_id.lock() {
            *g = None;
        }
        // Relay-owned bundle is not part of ACP v1 (no MCP servers, no
        // permission flags) — the agent's own config governs its tools.
        let spec = resolve_for_spawn(&CommandSpec {
            program: agent.command.clone(),
            args: agent.args.clone(),
        });
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in &agent.env {
            cmd.env(k, v);
        }
        let watch_dirs = turn_watch_dirs(cwd, &db.0);
        if let Some(dir) = watch_dirs.first() {
            cmd.current_dir(dir);
        }
        let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
        no_console_window(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn ACP agent '{}': {e}", agent.display_name))?;
        let stdout = child.stdout.take().ok_or("failed to capture ACP stdout")?;
        {
            let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
            *guard = child.stdin.take();
            // Kick off the handshake: initialize. The reader thread answers
            // it (initialized + session/new) and sends the queued turn.
            if let Some(stdin) = guard.as_mut() {
                let init = crate::acp::encode_request(
                    1,
                    "initialize",
                    &json!({
                        "protocolVersion": crate::acp::ACP_PROTOCOL_VERSION,
                        "clientCapabilities": {},
                    }),
                );
                let _ = write_acp_line(stdin, &init);
            }
        }
        let app2 = app.clone();
        let db2 = DbState(Arc::clone(&db.0));
        let sid2 = sid.to_string();
        let in_flight2 = Arc::clone(&entry.turn_in_flight);
        let session_cell2 = Arc::clone(&entry.cli_session_id);
        let cancelled2 = Arc::clone(&cancelled);
        let stdin2 = Arc::clone(&entry.stdin);
        let pending2 = Arc::clone(&entry.acp_pending);
        let request_id2 = Arc::clone(&entry.acp_request_id);
        // B-4/B-5/E-5: new process generation — arm `reader_alive` (the
        // thread's RAII guard clears it on every exit path, including the
        // mid-handshake early returns) and stamp the generation the reader
        // may clear `turn_in_flight` for.
        let generation = entry.proc_generation.fetch_add(1, Ordering::SeqCst) + 1;
        entry.reader_alive.store(true, Ordering::SeqCst);
        let reader_alive2 = Arc::clone(&entry.reader_alive);
        let generation_cell2 = Arc::clone(&entry.proc_generation);
        std::thread::spawn(move || {
            let _alive = ReaderAliveGuard(reader_alive2);
            read_acp_stream(
                Some(&app2),
                &db2,
                &sid2,
                stdout,
                &in_flight2,
                &session_cell2,
                &cancelled2,
                stdin2,
                &pending2,
                &request_id2,
                &generation_cell2,
                generation,
                watches,
            );
        });
        entry.child = Some(child);
    }

    // Queue the turn. The reader drains `acp_pending` right after the
    // handshake's session/new response (first turn); later turns write
    // `session/request` directly below.
    {
        let mut g = entry.acp_pending.lock().map_err(|e| e.to_string())?;
        *g = Some(content.to_string());
    }
    entry.turn_in_flight.store(true, Ordering::SeqCst);

    // Later turns: the handshake already completed (session id known). Write
    // the request now — while holding the session_id lock so the reader's
    // handshake branch (which consumes `acp_pending` under the same lock)
    // can't race us into sending the first turn twice.
    let sess_guard = entry.cli_session_id.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = sess_guard.as_ref() {
        let rid = crate::acp::next_request_id();
        *entry.acp_request_id.lock().map_err(|e| e.to_string())? = Some(rid);
        let params = crate::acp::user_session_request(sess, content);
        let line = crate::acp::encode_request(rid, "session/request", &params);
        let write_result = {
            let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
            let stdin = guard.as_mut().ok_or("ACP agent process stdin is closed")?;
            write_acp_line(stdin, &line)
        };
        match write_result {
            Ok(()) => {
                let mut p = entry.acp_pending.lock().map_err(|e| e.to_string())?;
                *p = None;
            }
            Err(e) => {
                entry.turn_in_flight.store(false, Ordering::SeqCst);
                return Err(format!("failed to write to ACP stdin: {e}"));
            }
        }
    }
    Ok(())
}

/// Reader thread for an ACP child. Drives the initialize → session/new
/// handshake, sends the first turn once the session is open, then streams
/// session/update content onto the chat events until session/finish (or
/// session/error / process exit).
#[allow(clippy::too_many_arguments)]
pub(super) fn read_acp_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &Arc<AtomicBool>,
    session_cell: &Arc<Mutex<Option<String>>>,
    cancelled: &Arc<AtomicBool>,
    shared_stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    pending: &Arc<Mutex<Option<String>>>,
    request_id_cell: &Arc<Mutex<Option<u64>>>,
    proc_generation: &AtomicU64,
    my_generation: u64,
    mut watches: Vec<DirWatch>,
) {
    let mut full = String::new();
    // "Worked for Xs" label: the turn window runs from when we start watching
    // for the turn's output until session/finish. Reset at each finish so the
    // next turn (sent directly by send_acp_turn) gets its own window.
    let mut turn_started = crate::db::now_ts();
    // Perf accumulator for the CURRENT turn, holding the chat's AppHandle so
    // `chat:perf` flows. Like the claude reader, this loop outlives turns: a
    // fresh accumulator is registered at the first session/update of each
    // turn (finish_turn unregisters the previous one at session/finish).
    let mut perf: Option<crate::chat::turn_perf::TurnPerf> = None;
    let mut handshake_done = false;
    // Id of the session/new request we're awaiting a response for.
    let mut awaiting_session_new: Option<u64> = None;
    // Id of the first turn's session/request (so its JSON-RPC error response
    // can fail the turn); later turns' ids live in request_id_cell.
    let mut pending_request_id: Option<u64> = None;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break,
        }
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        let Some(msg) = crate::acp::decode_line(line.trim()) else {
            continue;
        };
        use crate::acp::events::AcpEvent;
        use crate::acp::AcpLine;
        match msg {
            AcpLine::Response { id, result, error } => {
                if let Some(err) = error {
                    let msg = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown JSON-RPC error");
                    // B-13: the first turn's id lives in pending_request_id;
                    // later turns' ids are stored by send_acp_turn in
                    // request_id_cell. A matching error response fails the
                    // CURRENT turn — ignoring it left turn_in_flight set
                    // forever from turn 2 on (same wedge as B-4).
                    let current_turn_id = request_id_cell.lock().ok().and_then(|g| *g);
                    if !handshake_done
                        || Some(id) == pending_request_id
                        || current_turn_id == Some(id)
                    {
                        // Handshake or in-flight turn request failed → the
                        // turn is over before it streamed anything.
                        emit_error(app, sid, &format!("ACP request failed: {msg}"));
                        full.clear();
                        crate::chat::turn_perf::unregister(sid);
                        perf = None;
                        if should_clear_in_flight(
                            proc_generation.load(Ordering::SeqCst),
                            my_generation,
                        ) {
                            in_flight.store(false, Ordering::SeqCst);
                        }
                        // Consume the failed id so a duplicate error
                        // response can't re-fail the next turn.
                        if Some(id) == pending_request_id {
                            pending_request_id = None;
                        }
                        if let Ok(mut g) = request_id_cell.lock() {
                            if *g == Some(id) {
                                *g = None;
                            }
                        }
                        if !handshake_done {
                            return;
                        }
                    }
                    // Tool-result replies can error harmlessly — keep going.
                    continue;
                }
                if id == 1 && !handshake_done {
                    // initialize acknowledged → initialized notification +
                    // session/new with the spawn dir (or artifacts fallback).
                    handshake_done = true;
                    let _ = write_line_shared(
                        &shared_stdin,
                        &crate::acp::encode_notification("initialized", &json!({})),
                    );
                    let cwd_str = watches
                        .first()
                        .map(|w| w.dir.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let new_id = crate::acp::next_request_id();
                    awaiting_session_new = Some(new_id);
                    let params = json!({ "cwd": cwd_str, "mcpServers": {} });
                    let _ = write_line_shared(
                        &shared_stdin,
                        &crate::acp::encode_request(new_id, "session/new", &params),
                    );
                } else if Some(id) == awaiting_session_new {
                    awaiting_session_new = None;
                    let sess = result
                        .as_ref()
                        .and_then(|r| r.get("sessionId"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    let Some(sess) = sess else {
                        emit_error(app, sid, "ACP agent returned no sessionId for session/new");
                        full.clear();
                        // B-4: returning here used to leave `entry.child`
                        // occupied with a live agent and no reader — the next
                        // send queued into the void. The RAII guard below
                        // drops `reader_alive`, and the generation gate keeps
                        // this late clear from clobbering a respawned turn.
                        if should_clear_in_flight(
                            proc_generation.load(Ordering::SeqCst),
                            my_generation,
                        ) {
                            in_flight.store(false, Ordering::SeqCst);
                        }
                        return;
                    };
                    // Store the session id and, if a turn is already queued
                    // (the first send raced ahead of the handshake), send its
                    // session/request now — all under the session_id lock so
                    // send_acp_turn can't double-send the first turn.
                    let queued = {
                        let mut cell = session_cell.lock().unwrap_or_else(|e| e.into_inner());
                        *cell = Some(sess.clone());
                        pending.lock().ok().and_then(|mut p| p.take())
                    };
                    if let Some(text) = queued {
                        let rid = crate::acp::next_request_id();
                        if let Ok(mut g) = request_id_cell.lock() {
                            *g = Some(rid);
                        }
                        pending_request_id = Some(rid);
                        let params = crate::acp::user_session_request(&sess, &text);
                        let _ = write_line_shared(
                            &shared_stdin,
                            &crate::acp::encode_request(rid, "session/request", &params),
                        );
                    }
                }
                // Other responses (tool-result acks) need no action.
            }
            AcpLine::Notification { method, params } => match method.as_str() {
                "session/update" => {
                    // First update of a turn: register a fresh accumulator
                    // (the previous turn's was unregistered at finish).
                    if perf.is_none() {
                        perf = Some(crate::chat::turn_perf::register(
                            sid,
                            crate::chat::turn_perf::TurnPerf::new_opt(app.cloned(), sid),
                        ));
                    }
                    for ev in crate::acp::events::translate_session_update(&params) {
                        match ev {
                            AcpEvent::Text(t) => {
                                full.push_str(&t);
                                emit_token(app, sid, &t);
                            }
                            AcpEvent::Reasoning(t) => {
                                let wrapped = format!("<think>{t}</think>");
                                full.push_str(&wrapped);
                                emit_token(app, sid, &wrapped);
                            }
                            AcpEvent::ToolCall { id, name, input } => {
                                let marker =
                                    format!("<tool>{}</tool>", tool_meta_generic(&name, &input));
                                full.push_str(&marker);
                                emit_token(app, sid, &marker);
                                // v1 does not execute ACP tools — answer with
                                // an error result so the agent doesn't wait
                                // forever on a result that never comes.
                                reply_acp_tool_error(&shared_stdin, session_cell, &id);
                            }
                            AcpEvent::Finished | AcpEvent::Failed(_) | AcpEvent::PromptIgnored => {}
                        }
                    }
                }
                "session/finish" => {
                    for ev in crate::acp::events::translate_session_finish(&params) {
                        match ev {
                            AcpEvent::Text(t) => {
                                full.push_str(&t);
                                emit_token(app, sid, &t);
                            }
                            AcpEvent::Reasoning(t) => {
                                let wrapped = format!("<think>{t}</think>");
                                full.push_str(&wrapped);
                                emit_token(app, sid, &wrapped);
                            }
                            _ => {}
                        }
                    }
                    let started = turn_started;
                    turn_started = crate::db::now_ts();
                    if cancelled.load(Ordering::SeqCst) {
                        // Cancel already emitted chat:done — discard the
                        // partial reply.
                        full.clear();
                        crate::chat::turn_perf::unregister(sid);
                    } else {
                        finish_turn(
                            app,
                            db,
                            sid,
                            &mut full,
                            None,
                            None,
                            None,
                            None,
                            None,
                            &mut watches,
                            started,
                            None,
                        );
                    }
                    // Both paths above closed the turn's accumulator
                    // (finish_turn unregisters internally) — drop the handle
                    // so the next turn registers a fresh one.
                    perf = None;
                    if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation)
                    {
                        in_flight.store(false, Ordering::SeqCst);
                    }
                    pending_request_id = None;
                    // Consume the turn id too: a stale error response after
                    // the finish must not fail the NEXT turn (B-13).
                    if let Ok(mut g) = request_id_cell.lock() {
                        *g = None;
                    }
                }
                "session/error" => {
                    if let AcpEvent::Failed(m) =
                        crate::acp::events::translate_session_error(&params)
                    {
                        emit_error(app, sid, &m);
                    }
                    full.clear();
                    if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation)
                    {
                        in_flight.store(false, Ordering::SeqCst);
                    }
                    pending_request_id = None;
                    if let Ok(mut g) = request_id_cell.lock() {
                        *g = None;
                    }
                }
                "session/prompt" => {
                    // Out of scope v1 — surface a note instead of silently
                    // ignoring the agent's question.
                    let note = "<think>[Agent asked a question — ACP prompts are not supported yet]</think>";
                    full.push_str(note);
                    emit_token(app, sid, note);
                }
                _ => {}
            },
            AcpLine::Request { id, .. } => {
                // Server-initiated requests (e.g. session/prompt as a request)
                // — out of scope v1. Respond with a method-not-found error so
                // the agent doesn't wait on us.
                // (The notification form above is the common one; this is a
                // safety net for agents that send the request form.)
                // B-12: echo the request's own id — a hardcoded 0 let the
                // agent's JSON-RPC client wait forever on its real id.
                let err = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "Method not supported by Relay ACP v1" },
                });
                let _ = write_line_shared(&shared_stdin, &err.to_string());
            }
        }
    }
    // EOF: the process died. If a turn was in flight it never finished —
    // surface that instead of leaving the spinner up forever (unless we
    // killed it ourselves via cancel, which already emitted chat:done).
    if !handshake_done {
        emit_error(
            app,
            sid,
            "ACP agent exited before completing the handshake — is it running with ACP over stdio?",
        );
        if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation) {
            in_flight.store(false, Ordering::SeqCst);
        }
        return;
    }
    // E-5: gate on the generation — a respawned process may already be
    // streaming a new turn that this stale reader must not clobber.
    if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation)
        && in_flight.swap(false, Ordering::SeqCst)
        && !cancelled.load(Ordering::SeqCst)
    {
        emit_error(app, sid, "ACP agent exited mid-turn");
    }
    // A reader that dies mid-turn leaves the turn's accumulator registered —
    // finish_turn never ran. Drop it so the registry entry can't outlive the
    // session (same backstop as the claude reader's EOF).
    if perf.take().is_some() {
        crate::chat::turn_perf::unregister(sid);
    }
}

/// Answer an ACP tool call with an error tool_result (v1 doesn't execute
/// tools). The reader sends a fresh session/request carrying the result;
/// the agent continues the same turn.
pub(super) fn reply_acp_tool_error(
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    session_cell: &Arc<Mutex<Option<String>>>,
    tool_call_id: &str,
) {
    let sess = session_cell.lock().ok().and_then(|g| g.clone());
    let Some(sess) = sess else { return };
    let rid = crate::acp::next_request_id();
    let params = crate::acp::tool_error_session_request(&sess, tool_call_id);
    let _ = write_line_shared(
        shared_stdin,
        &crate::acp::encode_request(rid, "session/request", &params),
    );
}
