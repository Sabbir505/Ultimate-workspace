//! Claude Code spawn, permission/can-use-tool + ask-user question handling, and read_claude_stream — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;

pub(super) fn spawn_claude(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    model: &str,
    cwd: Option<&str>,
    project_id: Option<&str>,
    in_flight: &Arc<AtomicBool>,
    session_cell: &Arc<Mutex<Option<String>>>,
    cancelled: &Arc<AtomicBool>,
    reader_alive: &Arc<AtomicBool>,
    proc_generation: &Arc<AtomicU64>,
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Result<(Child, String, String), String> {
    let alias = claude_model_alias(model);
    // Per-session dual permission policies. full_access approval keeps the
    // historical bypass-everything spawn; every other posture routes the CLI's
    // permission prompts to the reader thread over the stdio control protocol
    // (`--permission-prompt-tool stdio` — Claude Code 2.x), where they become
    // the same chat:approval-request cards the built-in chat uses.
    let (sandbox_str, approval_str, harness_mode, effort_str) = {
        let conn = db.0.lock();
        crate::db::get_chat_session(&conn, sid)
            .ok()
            .flatten()
            .map(|cs| {
                (
                    cs.sandbox_policy,
                    cs.approval_policy,
                    cs.permission_mode,
                    cs.effort_level.unwrap_or_default(),
                )
            })
            .unwrap_or_else(|| {
                (
                    "workspace_write".to_string(),
                    "on_request".to_string(),
                    "manual".to_string(),
                    String::new(),
                )
            })
    };
    // Harness-NATIVE mode (mode menu shows Claude Code's own postures when
    // the session has one selected). Unknown/legacy labels ("manual", "plan"
    // from the BUILT-IN posture, …) fall through to the policy mapping above.
    let claude_mode = match harness_mode.as_str() {
        "default" | "acceptEdits" | "plan" | "bypassPermissions" => Some(harness_mode.clone()),
        _ => None,
    };
    // The stdio control protocol is armed for EVERY posture except the CLI's
    // own explicit bypassPermissions — not just gated ones. Reason: without
    // `--permission-prompt-tool stdio` the CLI has no channel for
    // AskUserQuestion (it removes the tool entirely in full-auto spawns), so
    // full_access sessions could never be asked anything — the model would
    // improvise or the turn would wedge. full_access still runs card-free:
    // handle_can_use_tool AUTO-ALLOWS regular tool prompts for those
    // sessions and only surfaces questions.
    let bypass = claude_mode.as_deref() == Some("bypassPermissions");
    let gated = !bypass;
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];
    if gated {
        args.push("--permission-prompt-tool".into());
        args.push("stdio".into());
        // Claude Code's own plan / accept-edits postures — the flag is the
        // contract; "default" needs no flag.
        if let Some(m) = claude_mode.as_deref().filter(|m| *m != "default") {
            args.push("--permission-mode".into());
            args.push(m.to_string());
        }
    } else {
        args.push("--dangerously-skip-permissions".into());
    }
    args.push("--model".into());
    args.push(alias);
    // Session effort tier ("low" | "medium" | "high" | "xhigh" | "max" — the
    // CLI validates; empty = "Default", no flag). Baked into the invocation
    // like --model: a later change respawns (send_claude_turn compares
    // `spawned_effort`).
    if !effort_str.is_empty() {
        args.push("--effort".into());
        args.push(effort_str.clone());
    }
    // Respawning (after a cancel, model change, or app restart) would
    // start a blank conversation — resume the captured CLI session instead.
    let resume = session_cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = &resume {
        args.push("--resume".into());
        args.push(id.clone());
    }
    // Relay-owned bundle: instructions, permissions, and both MCP servers
    // (browser + tools). Registration failure degrades to no extra flags —
    // the turn still runs, just without relay's prompt/tools.
    if let Some(bundle) = resolve_harness_bundle(
        app,
        project_id,
        cwd,
        artifacts_dir_for_bundle(app, cwd),
        connectors,
        Some(&sandbox_str),
        Some(&approval_str),
    ) {
        args.extend(crate::harness_bundle::claude_bundle_args(
            &bundle,
            &artifacts_dir_for_bundle(app, cwd),
        ));
    }
    let spec = resolve_for_spawn(&CommandSpec {
        program: "claude".into(),
        args,
    });
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Snapshot the watch dirs once per (re)spawn so finish_turn can diff them
    // after each turn and surface files the CLI created as artifacts. The
    // first dir is the spawn dir (the CLI's workspace); the second (when
    // different) is the artifacts dir relay-tools MCP writes into.
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude CLI: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture claude stdout")?;
    // Take stdin and share it so the reader thread can write user input —
    // turn prompts AND, for gated modes, control responses that answer the
    // CLI's can_use_tool permission prompts.
    {
        let mut guard = shared_stdin.lock().map_err(|e| e.to_string())?;
        *guard = child.stdin.take();
        // The control protocol must be armed BEFORE the first turn: without
        // an initialize control_request the CLI silently auto-denies every
        // permission prompt instead of asking. Best-effort — a write failure
        // here just means the process is already broken and the turn will
        // surface the real error.
        if gated {
            if let Some(stdin) = guard.as_mut() {
                let init = json!({
                    "request_id": "relay-init-1",
                    "type": "control_request",
                    "request": { "subtype": "initialize" },
                })
                .to_string();
                let _ = stdin
                    .write_all(init.as_bytes())
                    .and_then(|_| {
                        stdin.write_all(
                            b"
",
                        )
                    })
                    .and_then(|_| stdin.flush());
            }
        }
    }
    let app2 = app.clone();
    let db2 = DbState(Arc::clone(&db.0));
    let sid2 = sid.to_string();
    let in_flight2 = Arc::clone(in_flight);
    let session_cell2 = Arc::clone(session_cell);
    let cancelled2 = Arc::clone(cancelled);
    let stdin2 = Arc::clone(shared_stdin);
    // B-4/B-5/E-5: this spawn is a new process generation — arm the
    // reader-liveness flag (the thread's RAII guard clears it on every exit
    // path, letting the next send respawn a dead reader) and stamp the
    // generation the reader may clear `turn_in_flight` for.
    let generation = proc_generation.fetch_add(1, Ordering::SeqCst) + 1;
    reader_alive.store(true, Ordering::SeqCst);
    let reader_alive2 = Arc::clone(reader_alive);
    let generation_cell2 = Arc::clone(proc_generation);
    std::thread::spawn(move || {
        let _alive = ReaderAliveGuard(reader_alive2);
        read_claude_stream(
            Some(&app2),
            &db2,
            &sid2,
            stdout,
            &in_flight2,
            &session_cell2,
            &cancelled2,
            stdin2,
            watches,
            &generation_cell2,
            generation,
        );
    });
    // The mode label the flags above were built from — the caller records it
    // on the entry so a later label change can respawn (or live-apply). The
    // effort tier rides the same contract.
    Ok((child, harness_mode, effort_str))
}

/// The chat session's persisted permission-mode label (the harness mode menu
/// writes it verbatim — claude "plan"/"acceptEdits"/…, opencode "plan"/…).
/// Empty when the row is missing.
pub(super) fn chat_permission_mode_label(db: &DbState, sid: &str) -> String {
    let conn = db.0.lock();
    crate::db::get_chat_session(&conn, sid)
        .ok()
        .flatten()
        .map(|cs| cs.permission_mode)
        .unwrap_or_default()
}

/// The chat session's persisted effort tier. Empty = "Default" (no flag —
/// the CLI's own configured effort stands).
pub(super) fn chat_effort_level(db: &DbState, sid: &str) -> String {
    let conn = db.0.lock();
    crate::db::get_chat_session(&conn, sid)
        .ok()
        .flatten()
        .and_then(|cs| cs.effort_level)
        .unwrap_or_default()
}

/// Build the control_response the CLI expects on stdin after a can_use_tool
/// prompt. Allow echoes the original input back as `updatedInput` (required
/// since Claude Code v2.1.207 — omitting it is a validation error); deny
/// carries the message the model sees as the tool result.
pub(super) fn can_use_tool_response(request_id: &str, approved: bool, input: &Value) -> Value {
    if approved {
        json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": { "behavior": "allow", "updatedInput": input },
            },
        })
    } else {
        json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": {
                    "behavior": "deny",
                    "message": "The user denied this action in Relay. Do not retry it unless the user explicitly asks.",
                },
            },
        })
    }
}

/// Answer one Claude Code `can_use_tool` control request. Registers a
/// pending approval on the shared ChatManager (same registry the built-in
/// chat uses, so the existing `resolve_tool_action` command + approval-card
/// UI work unchanged), blocks until the user resolves it, then writes the
/// control_response to the CLI's stdin. Any failure to register (card UI
/// unreachable) resolves to a DENY — fail closed, never auto-approve.
pub(super) fn handle_can_use_tool(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    v: &Value,
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
) {
    let request = v.get("request").cloned().unwrap_or(json!({}));
    let request_id = v
        .get("request_id")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    if request_id.is_empty() {
        return;
    }
    let tool = request
        .get("tool_name")
        .and_then(|t| t.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = request.get("input").cloned().unwrap_or(json!({}));
    // Claude Code's AskUserQuestion rides the SAME can_use_tool control
    // request, but it wants the user's ANSWERS, not an approve/deny decision.
    // Routing it through the approval card would either stall the turn (deny)
    // or hand the model an empty answer set (approve with unchanged input).
    if tool == "AskUserQuestion" {
        handle_ask_user_question(app, sid, &request_id, &input, shared_stdin);
        return;
    }
    // full_access sessions arm the stdio protocol ONLY so AskUserQuestion has
    // a channel (see spawn_claude). Their no-cards contract still holds for
    // regular tool prompts: auto-allow without surfacing anything.
    let full_auto = {
        let conn = db.0.lock();
        crate::db::get_chat_session(&conn, sid)
            .ok()
            .flatten()
            .map(|cs| cs.approval_policy == "full_access")
            .unwrap_or(false)
    };
    if full_auto {
        let line = can_use_tool_response(&request_id, true, &input).to_string();
        if let Ok(mut guard) = shared_stdin.lock() {
            if let Some(stdin) = guard.as_mut() {
                let _ = stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .and_then(|_| stdin.flush());
            }
        }
        return;
    }
    let summary = crate::chat::dispatch::harness_tool_summary(&tool, &input);

    // Resolve the shared approval registry. `try_state` (not `state`): the
    // reader thread also runs in unit tests / relay contexts where the app
    // state may not be registered — a miss must deny, not panic.
    let mgr = app
        .and_then(|a| a.try_state::<crate::ChatState>())
        .map(|s| Arc::clone(&s.0));

    let (approved, pending_id) = if let (Some(app), Some(mgr)) = (app, mgr) {
        let (pending_id, rx) =
            mgr.register_pending_approval(sid, &tool, input.clone(), summary.clone());
        let _ = app.emit(
            "chat:approval-request",
            crate::types::ChatApprovalRequestPayload {
                chat_session_id: sid.to_string(),
                pending_id: pending_id.clone(),
                tool: tool.clone(),
                summary,
                args: input.clone(),
            },
        );
        // Block this reader thread until the UI resolves (or the pending is
        // dropped on cancel → deny). The CLI is simultaneously blocked
        // waiting on stdin, so neither side spins.
        let approved = rx.blocking_recv().unwrap_or(false);
        let _ = app.emit(
            "chat:approval-resolved",
            crate::types::ChatApprovalResolvedPayload {
                chat_session_id: sid.to_string(),
                pending_id: pending_id.clone(),
                approved,
            },
        );
        (approved, Some(pending_id))
    } else {
        // No app/registry → nobody can ever answer the card. Deny so the
        // CLI continues instead of waiting forever.
        (false, None)
    };
    let _ = pending_id; // kept in scope for clarity; the event owns it

    let response = can_use_tool_response(&request_id, approved, &input);
    let line = response.to_string();
    if let Ok(mut guard) = shared_stdin.lock() {
        if let Some(stdin) = guard.as_mut() {
            let _ = stdin
                .write_all(line.as_bytes())
                .and_then(|_| {
                    stdin.write_all(
                        b"
",
                    )
                })
                .and_then(|_| stdin.flush());
        }
    }
    // `db` is unused by the relay itself but keeps the signature symmetric
    // with the other reader helpers that persist state mid-turn.
    let _ = db;
}

/// Answer one Claude Code `AskUserQuestion` control request. Surfaces the
/// questions as a dedicated question card (`chat:question-request`) and
/// blocks the reader thread until the user answers, skips, or the turn is
/// cancelled. The answer rides back as an ALLOW response whose
/// `updatedInput` echoes the original questions plus an `answers` object
/// mapping question text → chosen label (multi-select answers are arrays; a
/// free-text reply goes in the top-level `response` field, which the CLI
/// substitutes for the structured answers). A cancelled/dropped pending
/// resolves to a DENY with a skip message so the CLI continues instead of
/// wedging on stdin.
pub(super) fn handle_ask_user_question(
    app: Option<&AppHandle>,
    sid: &str,
    request_id: &str,
    input: &Value,
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
) {
    let response = match app.and_then(|a| a.try_state::<crate::ChatState>()) {
        Some(state) => {
            let (pending_id, rx) = state.0.register_pending_question(sid);
            let _ = app.unwrap().emit(
                "chat:question-request",
                crate::types::ChatQuestionRequestPayload {
                    chat_session_id: sid.to_string(),
                    pending_id: pending_id,
                    questions: input.get("questions").cloned().unwrap_or(json!([])),
                },
            );
            match rx.blocking_recv() {
                Ok(reply) => {
                    let free = reply
                        .response
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    // Skip = no selections AND no free text. Resolve as a
                    // deny so the model learns the question went unanswered —
                    // an allow with an empty `answers` object would just make
                    // the CLI auto-resolve the tool with nothing.
                    let empty_answers = reply
                        .answers
                        .as_object()
                        .map(|o| o.is_empty())
                        .unwrap_or(true);
                    if empty_answers && free.is_none() {
                        ask_user_skip_response(request_id)
                    } else {
                        ask_user_allow_response(request_id, input, &reply.answers, free.as_deref())
                    }
                }
                Err(_) => ask_user_skip_response(request_id),
            }
        }
        // No app/registry → nobody can ever answer. Deny so the CLI continues.
        None => can_use_tool_response(request_id, false, input),
    };
    let line = response.to_string();
    if let Ok(mut guard) = shared_stdin.lock() {
        if let Some(stdin) = guard.as_mut() {
            let _ = stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush());
        }
    }
}

/// Build the ALLOW control_response that answers a Claude Code
/// `AskUserQuestion`: `updatedInput` must echo the original `questions` array
/// (required for tool processing) plus an `answers` object keyed by question
/// TEXT → chosen option label. A free-text reply goes in the top-level
/// `response` field, which the CLI substitutes for the structured answers.
/// A non-object `answers` is coerced to `{}` — a malformed payload must never
/// wedge the protocol.
pub(super) fn ask_user_allow_response(
    request_id: &str,
    input: &Value,
    answers: &Value,
    free_response: Option<&str>,
) -> Value {
    let mut updated = input.clone();
    updated["answers"] = if answers.is_object() {
        answers.clone()
    } else {
        json!({})
    };
    if let Some(free) = free_response.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        updated["response"] = json!(free);
    }
    can_use_tool_response(request_id, true, &updated)
}

/// Build the DENY control_response used when the user skipped a harness
/// question (Skip button, or the pending was dropped by a cancel/session
/// delete): the model is told the question went unanswered so the turn
/// proceeds instead of wedging on stdin.
pub(super) fn ask_user_skip_response(request_id: &str) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "deny",
                "message": "The user dismissed the question without answering. \
    Continue with your best judgment and state any assumption you make.",
            },
        },
    })
}

/// Suffix of `final_text` that the streamed deltas never delivered, or None
/// when there is nothing to recover (deltas already delivered everything, or
/// the stream diverged from the final text — e.g. a mid-turn API retry
/// replaced the answer — where appending would double-print text).
pub(super) fn unstreamed_suffix<'a>(streamed: &str, final_text: &'a str) -> Option<&'a str> {
    if final_text.len() > streamed.len() && final_text.starts_with(streamed) {
        Some(&final_text[streamed.len()..])
    } else {
        None
    }
}

/// Reader loop for the persistent claude process: one JSON event per line.
#[allow(clippy::too_many_arguments)]
pub(super) fn read_claude_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &AtomicBool,
    session_cell: &Arc<Mutex<Option<String>>>,
    cancelled: &AtomicBool,
    shared_stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    mut watches: Vec<DirWatch>,
    proc_generation: &AtomicU64,
    my_generation: u64,
) {
    let mut full = String::new();
    // Answer text accumulated from `stream_event` deltas ONLY (no think
    // markers, no tool markers). The `result` fallback below diffs it against
    // `result.result` to recover text the CLI never streamed.
    let mut answer_text = String::new();
    // Whether the CLI showed any sign of turn activity (streamed text, an
    // assistant message, or a result). Drives the stale-resume-id recovery
    // at EOF below: a process that dies with ZERO activity while a resume id
    // was in play is the signature of `--resume` failing on a stale id.
    let mut saw_turn_activity = false;
    // Capture the turn's start instant for the "Worked for Xs" label. The
    // reader is invoked right after the prompt is sent to the persistent CLI,
    // so this is a close lower bound on the turn's wall-clock window.
    // E-9a: reset after each `result` so turn 2+ gets its own window instead
    // of an ever-inflating "Worked for" reading (mirrors the ACP reader).
    let mut started_at = crate::db::now_ts();
    // Whether a thinking block is currently streaming: thinking deltas are
    // wrapped in `<think>…</think>` markers (the frontend renders them as a
    // collapsible block), mirroring anthropic_stream_round in
    // chat/streaming.rs.
    let mut in_think = false;
    // Matches each tool RESULT back to its call so shell output can be attached
    // to the originating step. Lives across the loop; the pending queue drains
    // within each turn (every call gets its result before the turn's `result`).
    let mut tools = ToolTracker::new();
    // The model id the CLI reports on its assistant messages (message.model) —
    // the REAL model backing the turn, which can differ from the session's
    // stored catalog id when the harness remaps aliases or runs a custom
    // model. Persisted with the assistant row (model_key → correct pricing)
    // and to app_settings so the composer's context meter shows the truth.
    let mut actual_model: Option<String> = None;
    // Perf accumulator for the CURRENT turn, holding the chat's AppHandle so
    // `chat:perf` flows (a headless accumulator never emits — the live
    // composer row never ticked for harness turns). This reader outlives
    // turns, so it re-registers at each turn's first `message_start` after
    // `finish_turn` unregistered the previous turn's accumulator; None means
    // no turn has streamed yet.
    let mut perf: Option<crate::chat::turn_perf::TurnPerf> = None;
    // mi18: read_line into ONE reused String — BufReader::lines() allocated a
    // fresh String per line on streams that run thousands of lines per turn.
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break,
        }
        let line = line.trim_end_matches(&[char::from(10), char::from(13)][..]);
        let line: &str = line;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // Token streaming (requires --include-partial-messages): raw
            // deltas wrapped in stream_event.
            Some("stream_event") => {
                saw_turn_activity = true;
                // Model-round boundaries: each assistant message opens a
                // generation window on message_start and closes it on
                // message_stop, so decode time (→ tok/s) and LLM time become
                // measurable, and message_start's per-round usage feeds the
                // live IN/CACHE chips. A fresh accumulator is registered on
                // the turn's first message_start (finish_turn unregistered
                // the previous turn's).
                match v.pointer("/event/type").and_then(|t| t.as_str()) {
                    Some("message_start") => {
                        if perf.is_none() {
                            perf = Some(crate::chat::turn_perf::register(
                                sid,
                                crate::chat::turn_perf::TurnPerf::new_opt(app.cloned(), sid),
                            ));
                        }
                        if let Some(p) = &perf {
                            p.begin_gen();
                            if let Some(u) = v.pointer("/event/message/usage") {
                                p.note_round_usage(
                                    u.get("input_tokens").and_then(|t| t.as_i64()).unwrap_or(0),
                                    usage_i64(
                                        u,
                                        &["cache_read_input_tokens", "cacheReadInputTokens"],
                                    )
                                    .unwrap_or(0),
                                    usage_i64(
                                        u,
                                        &[
                                            "cache_creation_input_tokens",
                                            "cacheCreationInputTokens",
                                        ],
                                    )
                                    .unwrap_or(0),
                                    false,
                                );
                            }
                        }
                    }
                    Some("message_stop") => {
                        if let Some(p) = &perf {
                            p.end_gen();
                        }
                    }
                    _ => {}
                }
                let delta = v.pointer("/event/delta");
                match delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        if let Some(text) =
                            delta.and_then(|d| d.get("text")).and_then(|t| t.as_str())
                        {
                            if in_think {
                                full.push_str("</think>");
                                emit_token(app, sid, "</think>");
                                in_think = false;
                            }
                            full.push_str(text);
                            answer_text.push_str(text);
                            emit_token(app, sid, text);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta
                            .and_then(|d| d.get("thinking"))
                            .and_then(|t| t.as_str())
                        {
                            if !in_think {
                                full.push_str("<think>");
                                emit_token(app, sid, "<think>");
                                in_think = true;
                            }
                            full.push_str(text);
                            emit_token(app, sid, text);
                        }
                    }
                    // Tool-use content_block_start: extract tool markers for
                    // the frontend's tool-call cards. No permission relay —
                    // the CLI is spawned with --dangerously-skip-permissions,
                    // so no stdin approval is needed.
                    Some("content_block_start") => {
                        let block = delta
                            .and_then(|d| d.get("content_block"))
                            .or_else(|| v.pointer("/event/content_block"));
                        if let Some(block) = block {
                            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                // No relay needed — full-auto mode.
                            }
                        }
                    }
                    _ => {}
                }
            }
            // Complete assistant message: text already streamed via deltas —
            // only tool_use blocks are extracted here. The stream_event
            // content_block_start handler already fires the relay for
            // dangerous tools before the CLI waits for stdin; this path is
            // a safety net for cases where the stream event wasn't caught.
            Some("assistant") => {
                saw_turn_activity = true;
                if in_think {
                    full.push_str("</think>");
                    emit_token(app, sid, "</think>");
                    in_think = false;
                }
                // The CLI's authoritative model id for this turn (remaps and
                // custom setups can differ from the session's stored id).
                if actual_model.is_none() {
                    if let Some(m) = v.pointer("/message/model").and_then(|x| x.as_str()) {
                        if !m.is_empty() {
                            actual_model = Some(m.to_string());
                        }
                    }
                }
                // Subagent-internal message: claude tags every message
                // produced inside an Agent/Task with `parent_tool_use_id`.
                // Stream it into THAT agent's panel (text/thinking/tool
                // markers) and keep it out of the main transcript and the
                // main tool FIFO — subagent activity entering the queue
                // desynced it and mis-attributed later results. These
                // messages are the ONLY live view of a subagent's work: the
                // CLI streams partial deltas for the main loop only.
                let parent_id = v
                    .get("parent_tool_use_id")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                if !parent_id.is_empty() {
                    if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                        tools.route_subagent_assistant(app, sid, parent_id, blocks);
                    }
                    continue;
                }
                if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    // No safety-net relay — CLI is in full-auto mode (no stdin
                    // approval). Just extract tool markers for the UI.
                    for b in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                    {
                        if let Some((name, values)) = tool_meta_claude(b) {
                            if is_subagent_tool_name(&name) {
                                // Subagent spawn (claude "Agent"/"Task"):
                                // extract role/task/prompt and emit a spawn
                                // event so the frontend opens the subagent
                                // panel + inline strip immediately.
                                let input = b.get("input").cloned().unwrap_or(json!({}));
                                let role = input
                                    .get("subagent_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("agent")
                                    .to_string();
                                let task = input
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let prompt = input
                                    .get("prompt")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let cli_tool_use_id =
                                    b.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                let background = input
                                    .get("run_in_background")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                let marker = tools.subagent_use(
                                    &name,
                                    values.into_iter().next().unwrap_or(json!({})),
                                    app,
                                    sid,
                                    &role,
                                    &task,
                                    &prompt,
                                    cli_tool_use_id,
                                    background,
                                );
                                full.push_str(&marker);
                                emit_token(app, sid, &marker);
                            } else {
                                let marker = tools.tool_use(&name, values);
                                full.push_str(&marker);
                                emit_token(app, sid, &marker);
                            }
                        }
                    }
                }
            }
            // Tool results come back as user-role messages whose content is an
            // array of tool_result blocks (in tool_use order). Attach shell
            // output to its step; other tools are tracked only for ordering.
            // Messages tagged with `parent_tool_use_id` belong to a SUBAGENT's
            // internal tool loop — their results fold into that agent's panel
            // and must not pop main-loop FIFO slots (that desync was the
            // source of garbled/stuck agent panes).
            Some("user") => {
                let parent_id = v
                    .get("parent_tool_use_id")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    for r in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                    {
                        let is_error = r.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                        let text = extract_result_text(r.get("content"));
                        if !parent_id.is_empty() {
                            tools.route_subagent_result(app, sid, parent_id, &text, is_error);
                            continue;
                        }
                        let cli_tool_use_id = r.get("tool_use_id").and_then(|x| x.as_str());
                        if let Some(marker) =
                            tools.tool_result(&text, is_error, app, sid, cli_tool_use_id)
                        {
                            full.push_str(&marker);
                            emit_token(app, sid, &marker);
                        }
                    }
                }
            }
            Some("result") => {
                saw_turn_activity = true;
                // Answer text streamed so far this turn; taken here so the
                // next turn starts from a clean accumulator.
                let streamed_answer = std::mem::take(&mut answer_text);
                // Capture the CLI's session id so a later respawn can
                // `--resume` this conversation instead of starting blank.
                if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) {
                    if let Ok(mut g) = session_cell.lock() {
                        *g = Some(id.to_string());
                    }
                    persist_cli_session_id(db, "claude_code", sid, session_cell);
                }
                let ok = v.get("subtype").and_then(|s| s.as_str()) == Some("success");
                // E-5: only the current process generation may clear the flag.
                if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation) {
                    in_flight.store(false, Ordering::SeqCst);
                }
                // E-9a: this turn's window is closed — capture it and start
                // the next one now, so a later turn isn't timed from here.
                let turn_started = started_at;
                started_at = crate::db::now_ts();
                if cancelled.load(Ordering::SeqCst) {
                    // Turn was cancelled while in flight: discard the partial
                    // reply — cancel() already emitted `chat:done`.
                    full.clear();
                    crate::chat::turn_perf::unregister(sid);
                    perf = None;
                } else if ok {
                    // A turn that ends mid-thinking (rare) still needs the
                    // closing marker or the block renders open forever.
                    if in_think {
                        full.push_str("</think>");
                        emit_token(app, sid, "</think>");
                        in_think = false;
                    }
                    // Some successful turns complete WITHOUT any stream_event
                    // deltas — the CLI falls back to non-streaming under API
                    // retries, and the answer arrives only on this `result`
                    // event. Without this recovery the turn finishes as an
                    // empty bubble (`full` empty → finish_turn persists
                    // nothing) while usage is still billed.
                    if let Some(final_text) = v.get("result").and_then(|r| r.as_str()) {
                        if let Some(suffix) = unstreamed_suffix(&streamed_answer, final_text) {
                            full.push_str(suffix);
                            emit_token(app, sid, suffix);
                        }
                    }
                    let usage = v.get("usage");
                    let input = usage
                        .and_then(|u| u.get("input_tokens"))
                        .and_then(|t| t.as_i64());
                    let output = usage
                        .and_then(|u| u.get("output_tokens"))
                        .and_then(|t| t.as_i64());
                    let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
                    // claude's input_tokens EXCLUDES cached tokens — the cache
                    // halves of the report carry 80-95% of the prompt in
                    // agentic turns. Dropping them (as this parser once did)
                    // made harness turns look nearly free next to the
                    // built-in chat's full-prompt accounting. Absent fields
                    // (older CLIs) stay NULL; present-but-zero is a true
                    // report and is stored as 0.
                    let cache_creation = usage.and_then(|u| {
                        usage_i64(
                            u,
                            &["cache_creation_input_tokens", "cacheCreationInputTokens"],
                        )
                    });
                    let cache_read = usage.and_then(|u| {
                        usage_i64(u, &["cache_read_input_tokens", "cacheReadInputTokens"])
                    });
                    // Some CLI versions also report the model on the result
                    // event itself — prefer it if we never saw an assistant
                    // message with one.
                    if actual_model.is_none() {
                        if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
                            if !m.is_empty() {
                                actual_model = Some(m.to_string());
                            }
                        }
                    }
                    if let Some(m) = actual_model.as_deref() {
                        persist_actual_model(db, "claude_code", sid, m);
                    }
                    finish_turn(
                        app,
                        db,
                        sid,
                        &mut full,
                        input,
                        output,
                        cost,
                        cache_creation,
                        cache_read,
                        &mut watches,
                        turn_started,
                        actual_model.as_deref(),
                    );
                    // finish_turn unregistered the turn's accumulator — drop
                    // the local handle so the next turn's message_start
                    // registers a fresh one.
                    perf = None;
                } else {
                    let msg = v
                        .get("error")
                        .and_then(|e| e.as_str())
                        .or_else(|| v.get("result").and_then(|r| r.as_str()))
                        .unwrap_or("Claude Code turn failed")
                        .to_string();
                    full.clear();
                    emit_error(app, sid, &msg);
                    // The failed turn's accumulator must not leak into the
                    // registry (nothing else unregisters this path).
                    crate::chat::turn_perf::unregister(sid);
                    perf = None;
                }
            }
            // Control protocol: the CLI answers our `initialize`
            // control_request here — nothing to do with the payload.
            Some("control_response") => {}

            // can_use_tool permission prompt (`--permission-prompt-tool
            // stdio`): surface it as the same approval card the built-in
            // chat uses, then write the user's decision back to the CLI's
            // stdin as a control_response. The reader blocks on the oneshot
            // while the CLI blocks on stdin — cancel/delete drops the
            // pending approval, which resolves to a deny so neither side
            // can wedge.
            Some("control_request") => {
                let request = v.get("request").cloned().unwrap_or(json!({}));
                if request.get("subtype").and_then(|t| t.as_str()) == Some("can_use_tool") {
                    handle_can_use_tool(app, db, sid, &v, &shared_stdin);
                }
            }

            // System events: {"type":"system","subtype":"init|compact_boundary|…"}. A
            // compact_boundary marks Claude Code's OWN native auto-compact —
            // the CLI condensed its context mid-session. Relay persists a
            // boundary marker so the timeline shows where detail was
            // condensed and the meter refreshes; the summary text itself
            // stays inside the CLI session (the event carries no content).
            Some("system") => {
                let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                if subtype.contains("compact") {
                    let conn = db.0.lock();
                    emit_harness_compact(&conn, app, sid, "Claude Code");
                }
                // A background Agent finished (claude): the notification is
                // correlated to the Agent call via tool_use_id (fallback: the
                // receipt's agentId), carries a status and the report summary.
                // This — not the launch receipt — is when the pane flips to
                // Done.
                if subtype == "task_notification" {
                    tools.finish_background(app, sid, &v);
                }
            }
            // system(init/hooks/status), user (tool results), rate_limit, …
            // — not needed for rendering.
            _ => {}
        }
    }
    // EOF: the process died. Close any open thinking block, persist any
    // captured session id, and if a turn was in flight it never delivered a
    // result — surface that instead of leaving the spinner up forever
    // (unless we killed it ourselves via cancel, which already emitted
    // `chat:done`).
    if in_think {
        full.push_str("</think>");
        emit_token(app, sid, "</think>");
    }
    // A process that died mid-turn leaves the turn's accumulator registered —
    // finish_turn never ran. Drop it so the registry entry and its heartbeat
    // don't outlive the session.
    if perf.take().is_some() {
        crate::chat::turn_perf::unregister(sid);
    }
    // The CLI is gone — any agent still awaiting its completion notification
    // can never deliver it. Finalize as errors so no pane spins forever.
    tools.fail_pending(
        app,
        sid,
        "The harness exited before this agent reported completion",
    );
    persist_cli_session_id(db, "claude_code", sid, session_cell);
    // Stale-resume-id recovery: a process that died with ZERO turn activity
    // while a resume id was in play is the signature of `--resume` failing
    // on a stale id (expired / GC'd / CLI version change). Without this the
    // next send would resume-fail forever AND the fresh session would start
    // blank despite the full DB history existing. Drop the id so the next
    // send takes the context-primer path instead. Cancels are excluded (they
    // set `cancelled`); a false positive only costs one primer replay.
    if !saw_turn_activity
        && !cancelled.load(Ordering::SeqCst)
        && session_cell.lock().ok().and_then(|g| g.clone()).is_some()
    {
        if let Ok(mut g) = session_cell.lock() {
            *g = None;
        }
        {
            let conn = db.0.lock();
            let _ = crate::db::delete_setting(&conn, &cli_session_key("claude_code", sid));
        }
        eprintln!(
            "[context] claude_code resume failed (no turn activity); dropping stale CLI              session id — the next send replays the context primer"
        );
        if let Some(app) = app {
            let _ = app.emit(
                "chat:status",
                json!({
                    "chatSessionId": sid,
                    "reason": "context_primer_pending",
                    "message": "CLI session expired — the next send replays the conversation context",
                }),
            );
        }
    }
    // E-5: a respawned process may already be streaming a new turn — an old
    // reader's EOF must not clear its flag (nor emit a spurious exit error).
    if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation)
        && in_flight.swap(false, Ordering::SeqCst)
        && !cancelled.load(Ordering::SeqCst)
    {
        emit_error(app, sid, "Claude Code exited mid-turn");
    }
}
