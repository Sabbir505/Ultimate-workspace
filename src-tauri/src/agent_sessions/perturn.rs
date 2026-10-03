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

/// How long a per-turn CLI has to exit on its own after printing its
/// semantically-terminal frame before the watchdog kills the process tree,
/// and how often the watchdog polls. A healthy CLI exits in well under a
/// second after its final frame (the 5s grace only ever bites wedged
/// processes), and a turn that ends by process exit is untouched either way.
const TURN_WATCHDOG_GRACE: Duration = Duration::from_secs(5);
const TURN_WATCHDOG_POLL: Duration = Duration::from_millis(250);

/// Whether this JSONL frame is the harness's semantically-terminal frame —
/// the CLI's contract that the turn is complete and the process has nothing
/// left to do. The reader ends a turn ONLY at process EOF, so a CLI that
/// prints this frame but never exits (wedged child, a `.cmd` wrapper's
/// cmd.exe lingering because a spawned grandchild holds the pipe) hangs the
/// whole completed turn — the reply is fully on screen but `chat:done` never
/// fires. Detection feeds the completion watchdog (spawn_per_turn); a family
/// WITHOUT a verified terminal frame returns false for everything and keeps
/// pure process-exit semantics (nothing changes for it).
///
/// Per family (sources verified 2026-09-30):
/// - CommandCode `-p --output-format json`: one final
///   `{"type":"result","subtype":…}` line after the wrapped event frames.
/// - Kimi `--output-format stream-json`: Claude-Code-lineage frames — the
///   run closes with a `{"type":"result",…}` line ("prints result and
///   exits after one round"). Same-frame detection as commandcode.
/// - Pi / Omp `--mode json`: `{"type":"agent_settled"}` is the documented
///   final record of a fully settled run. `agent_end` is deliberately NOT
///   terminal — retries/compaction/queued work may follow it (upstream
///   docs/json.md), and killing there would truncate live turns.
/// - OpenCode `run --format json`: no documented terminal event (the
///   process just exits) — and this per-turn path is only the degraded
///   fallback for the persistent server. Stays process-exit-ended.
fn is_turn_terminal_frame(kind: PerTurn, v: &Value) -> bool {
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        PerTurn::CommandCode | PerTurn::Kimi => ty == "result",
        PerTurn::Pi | PerTurn::Omp => ty == "agent_settled",
        PerTurn::OpenCode => false,
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
        Some(sid),
    );
    // Legacy fallback: browser-only MCP when the bundle (or its mcp part)
    // didn't write — keeps pty-style browser tools working in degraded mode.
    let opencode_legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };
    let mut prompt_env: Option<(String, String)> = None;
    // Harness effort tier (session's `effort_level`): applied per harness —
    // env override for kimi (its config.toml is user-owned, never written),
    // a CLI flag for the pi-lineage CLIs. Empty = "Default", nothing applied.
    let effort = chat_effort_level(db, sid);
    let mut harness_env: Vec<(String, String)> = Vec::new();
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
            // Thinking effort rides the documented env override (the CLI
            // forwards it on the request) — writing the user's config.toml
            // would destroy their comments. Tiers: low | medium | high.
            if !effort.is_empty() {
                harness_env.push(("KIMI_MODEL_THINKING_EFFORT".into(), effort.clone()));
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
            // Thinking level: both CLIs document the same vocabulary
            // (off|minimal|low|medium|high|xhigh|max) — pi `--thinking <level>`,
            // omp `--thinking=<level>` (sade accepts the space form, same as
            // the --model flag above). Empty = "Default", no flag.
            if !effort.is_empty() {
                flags.push("--thinking".into());
                flags.push(effort.clone());
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
            // The fixed headless flags (-p --output-format json
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
            // Native permission posture: the composer's mode menu stores the
            // CLI's own label. Headless `--permission-mode` accepts
            // standard|plan|accept-edits|yolo (docs, re-checked 2026-09-30);
            // standard/plan/accept-edits ride explicitly and REPLACE the
            // baked --yolo alias (argv_args skips the alias when the flag is
            // present). "standard" is real enforcement — headless mode
            // auto-denies mutating tools without --yolo. "yolo" and the
            // legacy/other labels keep the baked alias; "dont-ask" is
            // CLI-settings-only (not accepted headless).
            let harness_mode = {
                let conn = db.0.lock();
                crate::db::get_chat_session(&conn, sid)
                    .ok()
                    .flatten()
                    .map(|cs| cs.permission_mode)
                    .unwrap_or_default()
            };
            if matches!(
                harness_mode.as_str(),
                "standard" | "plan" | "accept-edits"
            ) {
                flags.push("--permission-mode".into());
                flags.push(harness_mode.clone());
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
        // Diagnosis: per-turn CLIs report dead-turn causes (auth / quota) on
        // stderr — the reader surfaces its tail when a turn produced no
        // output (same pattern as the one-shot spawns).
        .stderr(Stdio::piped());
    // The prompt travels in the process env block (never cmd-parsed) when the
    // Windows wrapper transport is active — see turn_spec.
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
    // Harness effort overrides (kimi's env knob; the pi-lineage tiers ride
    // argv flags above).
    for (k, v) in &harness_env {
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
    if let Some((dir, _)) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    // PERF (audit MED-10): build the watches (a full per-dir tree snapshot)
    // on their own thread, overlapped with the CLI's cold start, instead of
    // synchronously under the per-session mutex — every per-turn send used to
    // re-walk the whole spawn dir while holding that lock. The reader joins
    // this job BEFORE consuming stdout, so the baseline is always complete
    // before the first parsed output.
    let watches_job = {
        let dirs = watch_dirs;
        std::thread::spawn(move || {
            dirs.into_iter()
                .map(|(dir, broad)| DirWatch::new(dir, broad))
                .collect::<Vec<_>>()
        })
    };
    no_console_window(&mut cmd);
    let mut child = spawn_harness_child(&mut cmd)
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
    // stderr drain: collected into a channel the reader consumes only when a
    // turn produced no output (the pipe closes at process exit, so the recv
    // below never waits long on that path).
    let stderr = child.stderr.take().ok_or("failed to capture CLI stderr")?;
    let erx = drain_stderr(stderr);
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    // Take-and-kill the previous child before overwriting the slot (audit
    // H21): every other adapter does exactly this (`acp.rs` /
    // `opencode.rs` call `kill_child_tree` on the old handle). A bare
    // assignment just DROPS the previous `Child`, which neither kills nor
    // reaps it — the exited CLI lingers as a zombie, and a still-live old
    // tree (EOF can arrive while the wrapper lingers) is orphaned beyond the
    // session's cancel/watchdog reach.
    if let Some(mut old) = entry.child.take() {
        kill_child_tree(&mut old);
    }
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
        crate::chat::stream_events::emit_status_reason(
            Some(app),
            sid,
            "harness_starting",
            format!("{} is starting up…", kind.display()),
        );
    }

    // Fresh per-turn cancel flag: a reader thread from a cancelled turn must
    // keep seeing `true` even after the next send replaces the entry's flag.
    let cancelled = Arc::new(AtomicBool::new(false));
    entry.cancelled = Arc::clone(&cancelled);
    // Terminal-frame flag: the reader flips it when the harness prints its
    // semantically-final frame (is_turn_terminal_frame); the watchdog below
    // then bounds how long the CLI may linger before the turn is force-
    // closed. Fresh per turn like `cancelled`.
    let terminal_seen = Arc::new(AtomicBool::new(false));
    let terminal_reader = Arc::clone(&terminal_seen);
    let cancelled_reader = Arc::clone(&cancelled);

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
        let watches = watches_job.join().unwrap_or_default();
        read_per_turn_stream(
            Some(&app2),
            &db2,
            &sid2,
            stdout,
            &in_flight2,
            &session_cell,
            kind,
            &cancelled_reader,
            &terminal_reader,
            watches,
            &proc_generation,
            my_generation,
            Some(erx),
            None,
        );
    });

    // Turn-completion watchdog. `read_per_turn_stream` ends a turn ONLY when
    // the CLI process exits (stdout EOF), so a harness that prints its final
    // frame and then never exits used to hang the whole completed turn —
    // reply fully streamed, `chat:done` never fired (observed live on the
    // CommandCode family). Once the reader flags the terminal frame, this
    // watcher grants the process a short grace to exit on its own and then
    // kills ONLY the child tree (kill_child_if_generation): stdout closes,
    // the reader wakes on EOF, and the NORMAL completion path persists the
    // full reply — no cancel semantics, nothing discarded. Generation and
    // in-flight checks make a watcher from a superseded/cancelled turn a
    // no-op (E-5), and a clean exit mid-grace is detected before any kill.
    if !matches!(kind, PerTurn::OpenCode) {
        let app3 = app.clone();
        let sid3 = sid.to_string();
        let in_flight3 = Arc::clone(&entry.turn_in_flight);
        let gen3 = Arc::clone(&entry.proc_generation);
        let cancelled3 = Arc::clone(&cancelled);
        let terminal3 = Arc::clone(&terminal_seen);
        std::thread::spawn(move || {
            // Phase 1: wait for the terminal frame (or the turn to end by
            // itself). Exits when the turn completes, is cancelled, or a
            // newer send superseded this process.
            loop {
                std::thread::sleep(TURN_WATCHDOG_POLL);
                if cancelled3.load(Ordering::SeqCst)
                    || gen3.load(Ordering::SeqCst) != my_generation
                    || !in_flight3.load(Ordering::SeqCst)
                {
                    return;
                }
                if terminal3.load(Ordering::SeqCst) {
                    break;
                }
            }
            // Phase 2: grace for the CLI to exit on its own.
            let deadline = std::time::Instant::now() + TURN_WATCHDOG_GRACE;
            while std::time::Instant::now() < deadline {
                std::thread::sleep(TURN_WATCHDOG_POLL);
                if cancelled3.load(Ordering::SeqCst)
                    || gen3.load(Ordering::SeqCst) != my_generation
                    || !in_flight3.load(Ordering::SeqCst)
                {
                    return;
                }
            }
            let killed =
                app3.state::<crate::agent_sessions::AgentSessionState>()
                    .0
                    .kill_child_if_generation(&sid3, my_generation);
            if killed {
                eprintln!(
                    "[agent_sessions] {sid3}: {} printed its terminal frame but never exited \
— watchdog killed the CLI tree to close the turn",
                    kind.display()
                );
            }
        });
    }
    Ok(())
}

/// Reader loop for one-shot processes: parse events, then close the turn at
/// EOF (process exit). Usage is taken from the stream when the CLI reports
/// it; otherwise done carries nulls. `stderr_tail` carries the spawn's
/// drained stderr, consumed only when the turn produced no output at all.
#[allow(clippy::too_many_arguments)]
pub(super) fn read_per_turn_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &AtomicBool,
    session_cell: &Arc<Mutex<Option<String>>>,
    kind: PerTurn,
    cancelled: &AtomicBool,
    // Flipped when the harness prints its semantically-terminal frame —
    // arms the spawn-side completion watchdog. One-shot automation runs
    // pass a throwaway (their turns are bounded by `max_duration` instead).
    terminal_seen: &AtomicBool,
    mut watches: Vec<DirWatch>,
    proc_generation: &AtomicU64,
    my_generation: u64,
    stderr_tail: Option<std::sync::mpsc::Receiver<String>>,
    // `Some("automation")` for one-shot scheduler runs — rides chat:done so
    // the frontend can skip its generic turn-complete toast. None otherwise.
    source: Option<&str>,
) {
    let mut full = String::new();
    // Crash-flush accumulator (see PartialFlush): keeps a seconds-stale
    // snapshot of the live reply in the DB so a mid-turn crash doesn't leave
    // the chat with a user bubble and nothing under it.
    let mut partial = PartialFlush::new();
    // The resume id in play when the turn started — a turn that RESUMED and
    // then produced nothing is the stale-id signature (recovery below).
    let resumed_with: Option<String> = session_cell.lock().ok().and_then(|g| g.clone());
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
    // CommandCode's plain-text accumulator (deltas only, no think wrappers /
    // tool markers) — the result line's finalText catch-up diffs against it.
    let mut cc_text = String::new();
    // mi18: read into ONE reused buffer (shared lossy+capped reader, audit
    // H20 — a single non-UTF-8 byte from the cmd.exe wrapper used to abort
    // the turn mid-stream).
    let mut reader = BufReader::new(stdout);
    let mut raw: Vec<u8> = Vec::new();
    while let Some(line) = crate::agent_sessions::next_harness_line(&mut reader, &mut raw) {
        let line: &str = &line;
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
                &mut last_text,
                &mut last_reasoning,
                &mut in_think,
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
                &mut cc_text,
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
        // Arm the completion watchdog when the harness declares the turn
        // semantically over — the process still has to exit (or be killed
        // after the grace) for EOF to close the turn.
        if is_turn_terminal_frame(kind, &v) {
            terminal_seen.store(true, Ordering::SeqCst);
        }
        partial.maybe_flush(db, sid, &full);
    }
    // Process exit with subagent dispatches still queued: their completion
    // frames never arrived — finalize the panel entries so they don't spin
    // forever (mirrors the claude reader's EOF drain).
    tools.fail_pending(app, sid, "The CLI exited before this agent reported completion.");
    // Same at EOF for the block itself: the process can die mid-thought (killed
    // by a provider error, an OOM, a crash), and the claude reader already
    // closes here. Left open, the rest of the turn is parsed as reasoning — a
    // "Thinking…" row that never resolves, with the tail of the reply sealed
    // inside it. Must close BEFORE the RELAY_ASK scan and the persist below,
    // or the closed-off tail is written to the transcript that way.
    if in_think {
        full.push_str("</think>");
        emit_token(app, sid, "</think>");
        in_think = false;
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
    // Hand persistence back to finish_turn's real insert (or the cancel's
    // discard): keeping the crash-flush row would double-render the turn.
    partial.discard(db);
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
        // A turn whose stream produced NOTHING means the CLI exited without
        // replying (auth / quota / crash) — surface the stderr tail instead
        // of a silent empty bubble (mirrors the one-shot paths' diagnosis).
        if full.is_empty() && ask.is_none() {
            let tail = stderr_tail
                .and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok())
                .unwrap_or_default();
            emit_error(
                app,
                sid,
                &format!(
                    "{} produced no output{}",
                    kind.display(),
                    stderr_suffix(&tail)
                ),
            );
            // Stale-resume recovery (mirrors the claude_code reader): a turn
            // that RESUMED from a stored CLI session id but produced zero
            // output is the signature of that id failing on the CLI side —
            // expired, GC'd, or wiped by a crash/update ("no session found to
            // resume"). Without this the chat resume-fails FOREVER; dropping
            // the id makes the next send take the context-primer path, which
            // replays the DB history. A false positive only costs one primer
            // replay.
            if resumed_with.is_some() {
                if let Ok(mut g) = session_cell.lock() {
                    *g = None;
                }
                {
                    let conn = db.0.lock();
                    // Audit MED-7 (claude reader): only drop the PERSISTED id
                    // while this chat still runs this harness — a harness
                    // switch keeps the stored id so switching back resumes.
                    let still_same = crate::db::get_chat_session(&conn, sid)
                        .ok()
                        .flatten()
                        .map(|cs| {
                            cs.agent.as_deref()
                                == Some(&format!("harness:{}", kind.harness_id()))
                        })
                        .unwrap_or(true);
                    if still_same {
                        let _ = crate::db::delete_setting(
                            &conn,
                            &cli_session_key(kind.harness_id(), sid),
                        );
                    }
                }
                eprintln!(
                    "[context] {} resume failed (no turn output); dropping stale CLI session id — the next send replays the context primer",
                    kind.harness_id()
                );
                crate::chat::stream_events::emit_status_reason(
                    app,
                    sid,
                    "context_primer_pending",
                    "CLI session expired — the next send replays the conversation context",
                );
            }
        }
        // Register the question BEFORE finish_turn emits chat:done: the
        // relay's done handler drops the chat→phone owner mapping unless an
        // ask is still pending, so registering afterwards left the card with
        // no owner and the phone never received it.
        let registered_ask = ask.clone().and_then(|questions| {
            app.and_then(|h| super::ask::register_relay_ask(h, sid, questions))
        });
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
            source,
        );
        // The card goes out only after chat:done — the turn is complete; the
        // answer arrives as a follow-up turn.
        if let (Some(pending_id), Some(h)) = (registered_ask, app) {
            super::ask::emit_relay_ask(h, sid, pending_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The watchdog's trigger table: only a family's VERIFIED terminal frame
    /// may arm the kill. `agent_end` must stay non-terminal (retries /
    /// compaction / queued work may follow it — killing there would truncate
    /// live pi/omp turns), and OpenCode keeps pure process-exit semantics.
    #[test]
    fn terminal_frame_detection_is_per_family() {
        let result = json!({ "type": "result", "subtype": "success", "finalText": "done" });
        let cc_event = json!({ "type": "event", "event": { "type": "run_end" } });
        let settled = json!({ "type": "agent_settled" });
        let agent_end = json!({ "type": "agent_end", "messages": [], "willRetry": true });
        let delta = json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "hi" }
        });
        let kimi_assistant = json!({ "role": "assistant", "content": "hi" });

        for kind in [PerTurn::CommandCode, PerTurn::Kimi] {
            assert!(is_turn_terminal_frame(kind, &result), "{kind:?} result frame");
            assert!(!is_turn_terminal_frame(kind, &cc_event));
            assert!(!is_turn_terminal_frame(kind, &kimi_assistant));
            assert!(!is_turn_terminal_frame(kind, &settled));
        }
        for kind in [PerTurn::Pi, PerTurn::Omp] {
            assert!(is_turn_terminal_frame(kind, &settled), "{kind:?} agent_settled");
            // agent_end may be followed by retries/compaction — never kill on it.
            assert!(!is_turn_terminal_frame(kind, &agent_end));
            assert!(!is_turn_terminal_frame(kind, &delta));
            assert!(!is_turn_terminal_frame(kind, &result));
        }
        // OpenCode: no verified terminal event — process-exit semantics only.
        for frame in [&result, &cc_event, &settled, &agent_end, &delta] {
            assert!(!is_turn_terminal_frame(PerTurn::OpenCode, frame));
        }
    }

    /// Minimal live entry with a real sleeper child, mirroring the send-path
    /// construction (mod.rs `or_insert_with`).
    fn entry_with_child(child: Option<Child>, generation: u64) -> Arc<Mutex<AgentChild>> {
        Arc::new(Mutex::new(AgentChild {
            harness: "commandcode".to_string(),
            model: String::new(),
            child,
            spawned_model: None,
            spawned_mode: None,
            spawned_effort: None,
            spawned_cwd: None,
            spawned_connectors: Vec::new(),
            cli_session_id: Arc::new(Mutex::new(None)),
            turn_in_flight: Arc::new(AtomicBool::new(false)),
            reader_alive: Arc::new(AtomicBool::new(false)),
            proc_generation: Arc::new(AtomicU64::new(generation)),
            cancelled: Arc::new(AtomicBool::new(false)),
            stdin: Arc::new(Mutex::new(None)),
            acp_pending: Arc::new(Mutex::new(None)),
            acp_request_id: Arc::new(Mutex::new(None)),
            acp_last_prompt: Arc::new(Mutex::new(None)),
            send_ctx: std::sync::Mutex::new(None),
            oc_base_url: None,
            oc_full: Arc::new(Mutex::new(String::new())),
            oc_in_think: Arc::new(Mutex::new(false)),
            oc_last_event_ms: Arc::new(AtomicU64::new(0)),
            oc_config_stamp: Arc::new(Mutex::new(None)),
            oc_reader_alive: Arc::new(AtomicBool::new(false)),
        }))
    }

    fn spawn_sleeper() -> Child {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "ping -n 8 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_console_window(&mut cmd);
        cmd.spawn().expect("sleeper spawn")
    }

    /// The watchdog's kill lever: only the CURRENT spawn generation's child
    /// may die, the kill empties the slot (a cancel/new spawn racing first is
    /// a no-op, never a double-kill of a recycled pid), and a surviving child
    /// proves the generation guard left it untouched.
    #[test]
    fn kill_child_if_generation_gates_on_generation_and_empties_the_slot() {
        let mgr = AgentSessionManager::new();
        let entry = entry_with_child(Some(spawn_sleeper()), 7);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("wd-gen-test".to_string(), Arc::clone(&entry));

        // Stale watcher (older generation) → nothing dies, child still live.
        assert!(!mgr.kill_child_if_generation("wd-gen-test", 6));
        let still_live = entry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .child
            .as_mut()
            .expect("child kept")
            .try_wait()
            .expect("try_wait");
        assert!(still_live.is_none(), "sleeper must still be running");

        // Current generation → killed, and the slot is emptied: a second
        // call (or a racing cancel) finds nothing to kill.
        assert!(mgr.kill_child_if_generation("wd-gen-test", 7));
        assert!(!mgr.kill_child_if_generation("wd-gen-test", 7));
        assert!(
            entry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .child
                .is_none()
        );
    }

    /// A session with no live child (never spawned, or already reaped) is a
    /// clean no-op — the watchdog must not error or resurrect anything.
    #[test]
    fn kill_child_if_generation_handles_missing_sessions_and_children() {
        let mgr = AgentSessionManager::new();
        assert!(!mgr.kill_child_if_generation("wd-missing", 1));
        let entry = entry_with_child(None, 3);
        mgr.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("wd-empty".to_string(), entry);
        assert!(!mgr.kill_child_if_generation("wd-empty", 3));
    }
}
