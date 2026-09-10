//! per-turn harness spawn (kimi/pi/opencode/commandcode) and read_per_turn_stream — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
// ------------------------------------------------------ per-turn CLIs (kimi/opencode/pi/omp)
/// Which per-turn CLI a spawn targets. OpenCode normally runs as the
/// persistent server (see send_opencode_turn); `PerTurn::OpenCode` survives
/// only as the degraded fallback when `opencode serve` cannot be started.
/// Pi and Omp share one event protocol (Omp is a pi fork): `CLI -p --mode
/// json` streams a session-header line followed by JSONL deltas.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PerTurn {
    Kimi,
    OpenCode,
    Pi,
    Omp,
    CommandCode,
}

impl PerTurn {
    /// The harness id stored on the chat session / used for CLI session-id
    /// persistence (`agent.cli_session_id.<harness>.<sid>`).
    pub(super) fn harness_id(self) -> &'static str {
        match self {
            PerTurn::Kimi => "kimi_code",
            PerTurn::OpenCode => "opencode",
            PerTurn::Pi => "pi",
            PerTurn::Omp => "omp",
            PerTurn::CommandCode => "commandcode",
        }
    }

    /// Friendly name for the "starting up" status notice.
    pub(super) fn display(self) -> &'static str {
        match self {
            PerTurn::Kimi => "Kimi",
            PerTurn::OpenCode => "OpenCode",
            PerTurn::Pi => "Pi",
            PerTurn::Omp => "Omp",
            PerTurn::CommandCode => "CommandCode",
        }
    }
}

/// Spawn a fresh one-shot process for a single turn, resuming the CLI's own
/// session when we have its id from a previous turn.
pub(super) fn spawn_per_turn(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    content: &str,
    entry: &mut AgentChild,
    cwd: Option<&str>,
    project_id: Option<&str>,
    kind: PerTurn,
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Result<(), String> {
    let resume = entry.cli_session_id.lock().ok().and_then(|g| g.clone());
    // Relay-owned bundle: instructions, permissions, and MCP registration.
    // Failure degrades to the legacy browser-only configs below (or none).
    // The bundle hardcodes bypassPermissions in settings.json so claude
    // runs with full-auto approval.
    // Kimi/OpenCode headless have no approval channel — the bundle keeps its
    // default (unrestricted) permissions regardless of the session's mode.
    let bundle = resolve_harness_bundle(
        app,
        project_id,
        cwd,
        artifacts_dir_for_bundle(app, cwd),
        connectors,
        None,
        None,
    );
    // Legacy fallback: browser-only MCP when the bundle (or its mcp part)
    // didn't write — keeps pty-style browser tools working in degraded mode.
    let opencode_legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };
    let mut prompt_env: Option<(String, String)> = None;
    // Set when turn_spec chose the stdin transport: the prompt is piped to
    // the child after spawn (pi-lineage print mode reads stdin).
    let mut stdin_payload: Option<String> = None;
    let spec = match kind {
        PerTurn::Kimi => {
            // The untrusted prompt never rides the command line — it goes via
            // RELAY_TURN_PROMPT + a delayed-expansion wrapper batch on
            // Windows (M12, see harness_adapters::turn_spec). Only OUR
            // bounded strings (model, session id, bundle paths) are argv.
            // Kimi prompt mode is non-interactive; --yolo/--auto are
            // interactive-mode flags that kimi rejects with -p.
            // Tool calls are auto-approved by default in prompt mode.
            let mut flags: Vec<String> = vec!["--output-format".into(), "stream-json".into()];
            if !entry.model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(&entry.model)?;
                flags.push("-m".into());
                flags.push(entry.model.clone());
            }
            if let Some(id) = &resume {
                // Verified against `kimi --help` (v0.31): `-S, --session <id>`.
                flags.push("--session".into());
                flags.push(id.clone());
            }
            // Bundle args cover --mcp-config-file, --agent-file (fresh only),
            // and --add-dir. kimi_bundle_args skips --agent-file when resuming
            // (kimi forbids it with --session). When bundle is None, nothing is
            // added — matching today's degraded behavior (no browser tools).
            if let Some(b) = &bundle {
                flags.extend(crate::harness_bundle::kimi_bundle_args(
                    b,
                    &artifacts_dir_for_bundle(app, cwd),
                    resume.is_some(),
                ));
            }
            // Kimi plan mode: the CLI rejects `--plan` in prompt mode
            // ("Cannot combine --prompt with --plan", verified against the
            // installed CLI) and `--agent-file` is forbidden with --session
            // resume — so the plan posture rides as a prompt directive.
            // Advisory only (prompt mode auto-approves tool calls), but it is
            // the strongest lever kimi's headless mode offers.
            let turn_content = if chat_permission_mode_label(db, sid) == "plan" {
                format!(
                    "{content}\n\n[PLAN MODE ACTIVE — read-only. The user enabled plan mode: \
research and analyze, then reply with a detailed implementation plan as markdown. \
Do NOT modify, create, or delete any files and do NOT run mutating commands. \
End your reply with the plan and wait for the user's approval.]"
                )
            } else {
                content.to_string()
            };
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::Kimi,
                &turn_content,
                flags,
            )?;
            // Oversized prompts take the stdin transport (the env var would
            // silently expand empty past cmd.exe's line limit).
            if transport == crate::harness_adapters::TurnPromptTransport::Stdin {
                stdin_payload = Some(turn_content);
            }
            prompt_env = env;
            spec
        }
        PerTurn::OpenCode => {
            // Every flag must come BEFORE the `--` terminator: yargs (which
            // `opencode run` uses) treats post-`--` tokens as positional
            // message parts — turn_spec's argv/wrapper assembly keeps that
            // invariant. Only the prompt is positional, and on Windows it
            // arrives via the wrapper's delayed-expansion env read (M12).
            let mut flags: Vec<String> = vec![];
            if !entry.model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(&entry.model)?;
                // `opencode run -m` takes "provider/model" only — resolve bare
                // ids the same way the persistent server path does, or the
                // CLI silently uses its configured default.
                flags.push("-m".into());
                flags.push(crate::harness_config::resolve_opencode_model(&entry.model));
            }
            // Harness-native mode: the session label "plan" selects OpenCode's
            // read-only planning AGENT ("build" is the default — no flag).
            // NOTE: `opencode run` has no `--mode` flag — yargs silently
            // dropped it, so plan mode never reached the CLI. The supported
            // lever is `--agent <name>` (built-in agents: build, plan).
            let harness_mode = {
                let conn = db.0.lock();
                crate::db::get_chat_session(&conn, sid)
                    .ok()
                    .flatten()
                    .map(|cs| cs.permission_mode)
                    .unwrap_or_default()
            };
            if harness_mode == "plan" {
                flags.push("--agent".into());
                flags.push("plan".into());
            }
            // OpenCode: --auto is baked into the wrapper/argv prefix.
            if let Some(id) = &resume {
                flags.push("-s".into());
                flags.push(id.clone());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::OpenCode,
                content,
                flags,
            )?;
            // Oversized prompts take the stdin transport (the env var would
            // silently expand empty past cmd.exe's line limit).
            if transport == crate::harness_adapters::TurnPromptTransport::Stdin {
                stdin_payload = Some(content.to_string());
            }
            prompt_env = env;
            spec
        }
        PerTurn::Pi | PerTurn::Omp => {
            // pi-lineage JSON protocol: `-p --mode json` (space-separated flag
            // for pi, sade `--mode=json` for omp — turn_spec owns the exact
            // spelling). Prompt rides stdin (never a cmd.exe line).
            //
            // Permission model (verified live): both CLIs' print modes
            // AUTO-APPROVE tool calls — a file-creating turn executed
            // end-to-end with no approval flag. pi's `--approve` governs
            // project-trust (loading project-local extensions/settings —
            // arbitrary code), which we deliberately leave at the safe
            // non-interactive default of "ignore"; omp's `--auto-approve`
            // would be redundant. So: full-auto tools, no extra flags.
            let mut flags: Vec<String> = vec![];
            if !entry.model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(&entry.model)?;
                flags.push("--model".into());
                flags.push(entry.model.clone());
            }
            if let Some(id) = &resume {
                // pi: `--session <path|id>`; omp: `--resume <id>` (both accept
                // the captured session id — verified against upstream docs).
                match kind {
                    PerTurn::Omp => {
                        flags.push("--resume".into());
                    }
                    _ => {
                        flags.push("--session".into());
                    }
                }
                flags.push(id.clone());
            }
            // Like Kimi, the pi-lineage CLIs reject a dedicated plan flag in
            // prompt mode — the read-only posture rides as a prompt directive.
            let turn_content = if chat_permission_mode_label(db, sid) == "plan" {
                format!(
                    "{content}\n\n[PLAN MODE ACTIVE — read-only. The user enabled plan mode: \
research and analyze, then reply with a detailed implementation plan as markdown. \
Do NOT modify, create, or delete any files and do NOT run mutating commands. \
End your reply with the plan and wait for the user's approval.]"
                )
            } else {
                content.to_string()
            };
            let harness = match kind {
                PerTurn::Omp => crate::harness_adapters::TurnHarness::Omp,
                _ => crate::harness_adapters::TurnHarness::Pi,
            };
            let (spec, env, transport) =
                crate::harness_adapters::turn_spec(harness, &turn_content, flags)?;
            prompt_env = env;
            if transport == crate::harness_adapters::TurnPromptTransport::Stdin {
                stdin_payload = Some(turn_content);
            }
            spec
        }
        PerTurn::CommandCode => {
            // The fixed headless flags (-p --output-format json --yolo
            // --skip-onboarding --no-auto-update) live in turn_spec's argv —
            // here only the per-session bits ride along. Resume uses
            // `--resume <id>` ("by id or name", CLI reference); `-m` selects
            // the model for this session.
            let mut flags: Vec<String> = vec![];
            if !entry.model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(&entry.model)?;
                flags.push("-m".into());
                flags.push(entry.model.clone());
            }
            if let Some(id) = &resume {
                flags.push("--resume".into());
                flags.push(id.clone());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::CommandCode,
                content,
                flags,
            )?;
            prompt_env = env;
            if transport == crate::harness_adapters::TurnPromptTransport::Stdin {
                stdin_payload = Some(content.to_string());
            }
            spec
        }
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The prompt travels in the process env block (never cmd-parsed) when the
    // Windows wrapper transport is active — see turn_spec.
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
    // OpenCode only: point the CLI at the Relay-owned opencode.json that
    // registers relay-browser (it has no --mcp-config CLI flag).
    if matches!(kind, PerTurn::OpenCode) {
        // Bundle's opencode.json already has both MCP servers + permissions;
        // the legacy path only applies when the bundle failed to write.
        if let Some(cfg) = bundle
            .as_ref()
            .map(|b| b.opencode_config.clone())
            .filter(|p| p.exists())
            .or(opencode_legacy_cfg.clone())
        {
            cmd.env("OPENCODE_CONFIG", cfg);
        }
    }
    // Snapshot the watch dirs once for this turn so finish_turn can diff them
    // afterwards and surface files the CLI created as artifacts (spawn dir +
    // the artifacts dir relay-tools MCP writes into, when different).
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {} CLI: {e}", spec.program))?;

    // Stdin transport (pi/omp/commandcode): write the prompt and close the
    // pipe — EOF tells the CLI the prompt is complete. Same failure contract
    // as claude's one-shot stdin: a failed write kills the WHOLE tree (E-7 —
    // `child.kill()` would only terminate the cmd.exe wrapper and the CLI
    // grandchild would wait on stdin forever).
    if let Some(prompt) = stdin_payload {
        let write_result = match child.stdin.take() {
            Some(mut stdin) => {
                use std::io::Write as _;
                stdin
                    .write_all(prompt.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("failed to write prompt to CLI stdin: {e}"))
                // stdin drops here, closing the pipe.
            }
            None => Err("failed to open CLI stdin".to_string()),
        };
        if let Err(e) = write_result {
            kill_child_tree(&mut child);
            return Err(e);
        }
    }

    let stdout = child.stdout.take().ok_or("failed to capture CLI stdout")?;
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    entry.child = Some(child);

    // Emit a "starting" status so the UI shows immediate activity. Kimi-only:
    // its cold start is slow enough to read as a hang. Pi/omp/commandcode are
    // NOT announced — the CLI effectively spins up while the user is still
    // composing (agent/model selection already exercised it), and a per-send
    // "starting up…" flash on the first message read as noise. OpenCode runs
    // as the persistent server (no per-turn notice), and its degraded
    // fallback shares this spawn path — a flash there would be noise too.
    // Cleared by the first real `chat:token` event or `chat:done`/`chat:error`.
    if matches!(kind, PerTurn::Kimi) {
        let _ = app.emit(
            "chat:status",
            json!({ "chatSessionId": sid, "reason": "harness_starting", "message": format!("{} is starting up…", kind.display()) }),
        );
    }

    // Fresh per-turn cancel flag: a reader thread from a cancelled turn must
    // keep seeing `true` even after the next send replaces the entry's flag.
    let cancelled = Arc::new(AtomicBool::new(false));
    entry.cancelled = Arc::clone(&cancelled);

    // E-5 for the per-turn CLIs: every turn spawns a fresh process, so each
    // send bumps the generation and the reader clears `turn_in_flight` only
    // while it is still the current turn. An old reader's late EOF after a
    // cancel + immediate re-send used to clobber the NEW turn's flag
    // unconditionally — the new turn then ran unprotected and a second
    // concurrent send could spawn a second child for the same chat.
    let my_generation = entry.proc_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let proc_generation = Arc::clone(&entry.proc_generation);

    let app2 = app.clone();
    let db2 = DbState(Arc::clone(&db.0));
    let sid2 = sid.to_string();
    let in_flight2 = Arc::clone(&entry.turn_in_flight);
    let session_cell = Arc::clone(&entry.cli_session_id);
    std::thread::spawn(move || {
        read_per_turn_stream(
            Some(&app2),
            &db2,
            &sid2,
            stdout,
            &in_flight2,
            &session_cell,
            kind,
            &cancelled,
            watches,
            &proc_generation,
            my_generation,
        );
    });
    Ok(())
}

/// Reader loop for one-shot processes: parse events, then close the turn at
/// EOF (process exit). Usage is taken from the stream when the CLI reports
/// it; otherwise done carries nulls.
pub(super) fn read_per_turn_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &AtomicBool,
    session_cell: &Arc<Mutex<Option<String>>>,
    kind: PerTurn,
    cancelled: &AtomicBool,
    mut watches: Vec<DirWatch>,
    proc_generation: &AtomicU64,
    my_generation: u64,
) {
    let mut full = String::new();
    // Capture the turn's start instant for the "Worked for Xs" label.
    let started_at = crate::db::now_ts();
    // One accumulator per turn (this whole reader IS one turn): the chat's
    // AppHandle makes `chat:perf` flow so the composer row ticks live.
    // finish_turn unregisters; the cancelled branch below unregisters too.
    let _perf = crate::chat::turn_perf::register(
        sid,
        crate::chat::turn_perf::TurnPerf::new_opt(app.cloned(), sid),
    );
    // OpenCode buffers deltas internally in `run` mode: each "text" event
    // carries the FULL snapshot of its part so far, not a delta. Track the
    // last snapshots so only the new suffix is emitted/persisted.
    let mut last_text = String::new();
    let mut last_reasoning = String::new();
    let mut in_think = false;
    let mut input: Option<i64> = None;
    let mut output: Option<i64> = None;
    let mut cost: Option<f64> = None;
    // Cache halves of the harness's usage report, threaded through the
    // handlers like input/output. Handlers only overwrite when their event
    // actually carries the field, so a CLI that never reports cache stays
    // NULL end-to-end.
    let mut cache_read: Option<i64> = None;
    let mut cache_creation: Option<i64> = None;
    let mut tools = ToolTracker::new();
    // CommandCode emits several frames per running tool (`tool_running` and
    // friends all carry the same toolCallId) — dedupe markers per call id.
    let mut seen_tools: std::collections::HashSet<String> = std::collections::HashSet::new();
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
        match kind {
            PerTurn::Kimi => handle_kimi_event(
                app,
                sid,
                &v,
                &mut full,
                session_cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut tools,
            ),
            PerTurn::OpenCode => handle_opencode_event(
                app,
                sid,
                &v,
                &mut full,
                session_cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut cost,
                &mut last_text,
                &mut last_reasoning,
                &mut in_think,
                &mut tools,
            ),
            // Pi and Omp share the pi-lineage JSON event protocol.
            PerTurn::Pi | PerTurn::Omp => handle_pi_event(
                app,
                sid,
                &v,
                &mut full,
                session_cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut cost,
                &mut in_think,
                &mut tools,
            ),
            PerTurn::CommandCode => handle_commandcode_event(
                app,
                sid,
                &v,
                &mut full,
                session_cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut in_think,
                &mut tools,
                &mut seen_tools,
            ),
        }
    }
    // Process exit closes the turn. Persist any captured CLI session id so
    // the next turn (even after cancel or an app restart) resumes the same
    // conversation. If the turn was cancelled, discard the partial reply —
    // cancel() already emitted `chat:done`.
    persist_cli_session_id(db, kind.harness_id(), sid, session_cell);
    // RELAY_ASK scan BEFORE the cancelled discard and before finish_turn
    // persists: a marker question is stripped from the persisted reply and
    // surfaced as a card once the turn is done.
    let (mut full, ask) = if cancelled.load(Ordering::SeqCst) {
        (full, None)
    } else {
        split_relay_ask(full)
    };
    // E-5 gate: only the CURRENT turn's reader may clear the shared flag —
    // an old reader's late EOF after a superseding send must leave it (the
    // new turn set it true and owns it).
    if should_clear_in_flight(proc_generation.load(Ordering::SeqCst), my_generation) {
        in_flight.store(false, Ordering::SeqCst);
    }
    if cancelled.load(Ordering::SeqCst) {
        full.clear();
        // Cancel skips finish_turn (which normally unregisters) — drop the
        // turn's accumulator here so it can't linger in the registry.
        crate::chat::turn_perf::unregister(sid);
    } else {
        // per-turn CLI streams don't reliably expose a model id on their
        // events — the cost rollup falls back to the session's model.
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
            started_at,
            None,
        );
    }
    // The card goes out only after chat:done — the turn is complete; the
    // answer arrives as a follow-up turn.
    if let Some(questions) = ask {
        surface_relay_ask(app, sid, questions);
    }
}
