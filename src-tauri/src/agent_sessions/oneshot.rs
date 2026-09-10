//! run_one_shot: the automation engine's self-contained blocking turn — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
// ---------------------------------------------------------------- one-shot turns
/// Run a single self-contained turn and BLOCK until it finishes. This is the
/// shared engine for automations: the in-app scheduler calls it with
/// `Some(app)` (live `chat:*` events) and the headless `relay-automation`
/// binary calls it with `None` (no Tauri runtime — events become no-ops,
/// messages still persist to the DB). Unlike the chat-session paths above,
/// claude runs one-shot here too (`claude -p <prompt>`), because scheduled
/// turns never need a persistent process or cross-turn CLI session resume.

pub fn run_one_shot(
    app: Option<&AppHandle>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    chat_session_id: &str,
    prompt: &str,
    harness: &str,
    model: &str,
    cwd: Option<&str>,
    // Hard time limit for the turn. `None` waits forever (interactive use);
    // scheduled automations always pass a bound so a hung CLI can't wedge
    // the automation's overlap guards and silently kill its schedule.
    max_duration: Option<Duration>,
) -> Result<(), String> {
    {
        let conn = db.lock();
        crate::db::add_chat_message(
            &conn,
            crate::db::NewChatMessage {
                chat_session_id: chat_session_id,
                role: "user",
                content: prompt,
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
    }

    // Persona + bundle instructions + custom system prompt, then the prompt
    // (prefix joined with blank lines, then the `---` separator before the
    // prompt text — mirroring the chat-session prefix stack). Automation runs
    // are unattended but still present as Relay with the relay-tools bridge.
    // Session connectors are NOT merged (their OAuth refresh is async and
    // one-shot runs are self-contained); enabled gallery MCP servers and
    // relay-tools/browser still ride the bundle.
    let (effective, bundle) = {
        let project_id = {
            let conn = db.lock();
            crate::db::get_chat_session(&conn, chat_session_id)
                .ok()
                .flatten()
                .and_then(|s| s.project_id)
        };
        let custom = {
            let conn = db.lock();
            crate::db::get_setting(&conn, "assistant.systemPrompt")
                .ok()
                .flatten()
        };
        let mut persona_text: Option<String> = None;
        let mut instructions: Option<String> = None;
        let mut bundle: Option<crate::harness_bundle::HarnessBundlePaths> = None;
        if let Some(app) = app {
            persona_text = Some(harness_persona(harness_label(harness)));
            // The bundle's MCP servers matter for every adapter; its
            // instructions text only matters where no CLI flag can carry it
            // (claude/kimi get --append-system-prompt-file / --agent-file).
            if let Some(b) = resolve_harness_bundle(
                app,
                project_id.as_deref(),
                cwd,
                artifacts_dir_for_bundle(app, cwd),
                &[],
                None,
                Some("full_access"),
            ) {
                if harness_needs_prompt_instructions(harness) {
                    if let Ok(ins) = std::fs::read_to_string(&b.claude_instructions) {
                        if !ins.trim().is_empty() {
                            instructions = Some(ins);
                        }
                    }
                }
                bundle = Some(b);
            }
        }
        let effective = assemble_one_shot_prompt(
            persona_text.as_deref(),
            instructions.as_deref(),
            custom.as_deref(),
            prompt,
        );
        (effective, bundle)
    };

    let (mut spec, prompt_env, prompt_via_stdin) = one_shot_spec(harness, &effective, model)?;
    // Bundle args for the adapters that take them on the command line; the
    // bundle was resolved above only when an app handle exists.
    let mut opencode_cfg_env: Option<(String, String)> = None;
    if let (Some(app), Some(b)) = (app, &bundle) {
        let artifacts = artifacts_dir_for_bundle(app, cwd);
        match harness {
            "claude_code" => spec
                .args
                .extend(crate::harness_bundle::claude_bundle_args(b, &artifacts)),
            "kimi_code" => spec.args.extend(crate::harness_bundle::kimi_bundle_args(
                b, &artifacts, false,
            )),
            "opencode" => {
                if b.opencode_config.exists() {
                    opencode_cfg_env = Some((
                        "OPENCODE_CONFIG".to_string(),
                        b.opencode_config.to_string_lossy().replace('\\', "/"),
                    ));
                }
            }
            _ => {}
        }
    }
    // claude and the pi-lineage CLIs take the prompt via stdin (M12); the
    // other harnesses either carry it in the env pair (Windows wrapper) or
    // inline in argv (POSIX).
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if prompt_via_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
    // OpenCode consumes the bundle through its config env var (no CLI flag).
    if let Some((k, v)) = &opencode_cfg_env {
        cmd.env(k, v);
    }
    // Same artifact detection as the chat-session paths: diff the watch dirs
    // (spawn dir + artifacts dir) after the turn and surface created/modified
    // files.
    let watch_dirs = turn_watch_dirs(cwd, db);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {} CLI: {e}", spec.program))?;
    if prompt_via_stdin {
        // Write the prompt and close the pipe — EOF tells the CLI the prompt
        // is complete. A write failure must kill the child, otherwise the
        // CLI waits on stdin forever and the automation turn hangs.
        let write_result = match child.stdin.take() {
            Some(mut stdin) => {
                use std::io::Write as _;
                stdin
                    .write_all(effective.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("failed to write prompt to CLI stdin: {e}"))
                // stdin drops here, closing the pipe.
            }
            None => Err("failed to open CLI stdin".to_string()),
        };
        if let Err(e) = write_result {
            // E-7: kill the WHOLE tree — on Windows `child.kill()` only
            // terminates the cmd.exe /C wrapper and the CLI grandchild
            // survives (see kill_child_tree).
            kill_child_tree(&mut child);
            return Err(e);
        }
    }
    // Register the child so the app-exit handler can kill this tree (M13):
    // an automation child is a full skip-permissions CLI tree that would
    // otherwise keep running after the app quits.
    let child = Arc::new(Mutex::new(child));
    // Dropped at scope end: kills the registered one-shot child on early return.
    #[allow(unused_variables)]
    let one_shot_guard = OneShotGuard(register_one_shot_child(&child));
    let stdout = {
        let mut guard = child.lock().map_err(|e| e.to_string())?;
        guard.stdout.take().ok_or("failed to capture CLI stdout")?
    };
    // stderr capture: on a failed turn the CLI's diagnosis (auth / quota /
    // unknown model) lands here and nowhere else — without it the run history
    // only ever says "exited with code 1" or "time limit exceeded".
    let stderr = {
        let mut guard = child.lock().map_err(|e| e.to_string())?;
        guard.stderr.take().ok_or("failed to capture CLI stderr")?
    };
    let (etx, erx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let mut stderr = stderr;
        use std::io::Read as _;
        let _ = stderr.read_to_string(&mut buf);
        let _ = etx.send(buf);
    });

    let db2 = DbState(Arc::clone(db));
    let sid2 = chat_session_id.to_string();
    let in_flight = Arc::new(AtomicBool::new(true));
    let in_flight2 = Arc::clone(&in_flight);
    let app2 = app.cloned();
    let is_claude = harness == "claude_code";
    // one_shot_spec already rejected unknown harnesses, so this is total over
    // the harnesses that can reach here.
    let per_turn_kind = match harness {
        "opencode" => PerTurn::OpenCode,
        "pi" => PerTurn::Pi,
        "omp" => PerTurn::Omp,
        "commandcode" => PerTurn::CommandCode,
        _ => PerTurn::Kimi,
    };
    let reader = std::thread::spawn(move || {
        // One-shot turns are never cancelled (they block the caller) and never
        // resumed, so both cells are throwaway; the readers still persist any
        // captured id, which is harmless (keyed by harness + chat id).
        let never_cancelled = AtomicBool::new(false);
        // One-shot readers have no respawn race: the generation cell is a
        // throwaway that always "matches" (E-5 helper needs the params).
        let generation = AtomicU64::new(1);
        if is_claude {
            let cell = Arc::new(Mutex::new(None));
            let dummy_stdin = Arc::new(Mutex::new(None));
            read_claude_stream(
                app2.as_ref(),
                &db2,
                &sid2,
                stdout,
                &in_flight2,
                &cell,
                &never_cancelled,
                dummy_stdin,
                watches,
                &generation,
                1,
            );
        } else {
            let cell = Arc::new(Mutex::new(None));
            read_per_turn_stream(
                app2.as_ref(),
                &db2,
                &sid2,
                stdout,
                &in_flight2,
                &cell,
                per_turn_kind,
                &never_cancelled,
                watches,
                &generation,
                1,
            );
        }
    });

    // Poll-wait WITHOUT holding the child lock across the wait: the app-exit
    // handler must be able to lock + kill this child while we block (M13) —
    // holding it would deadlock the exit path against the running turn.
    //
    // `max_duration` bounds the turn: a CLI that hangs (waiting on a stalled
    // network pipe, a hidden interactive prompt, …) used to block this thread
    // FOREVER, which kept the automation's overlap guards (RUNNING set + lock
    // file) held forever — every later scheduled tick read as "already
    // running" and the automation silently stopped firing until the app
    // restarted. On expiry we kill the process tree; the blocking wait then
    // unblocks, the reader hits EOF, and the caller finalizes with an error.
    let deadline = max_duration.map(|d| std::time::Instant::now() + d);
    let wait = loop {
        {
            let mut guard = match child.lock() {
                Ok(g) => g,
                Err(e) => {
                    break Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        e.to_string(),
                    ))
                }
            };
            match guard.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => break Err(e),
            }
            if deadline.is_some_and(|d| std::time::Instant::now() >= d) {
                kill_child_tree(&mut guard);
                let msg = format!(
                    "turn exceeded its {}s time limit and was killed",
                    max_duration.unwrap_or_default().as_secs()
                );
                break Err(std::io::Error::new(std::io::ErrorKind::TimedOut, msg));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = reader.join();
    // The exit/kill above closed the stderr pipe; give the reader a moment to
    // drain, then surface its tail on every failure path.
    let stderr_tail = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let suffix = stderr_suffix(&stderr_tail);
    // M2: `one_shot_guard` unregisters on drop — this return included.
    match wait {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{} exited with {status}{suffix}", spec.program)),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            Err(format!("{}{suffix}", e.to_string()))
        }
        Err(e) => Err(format!("failed to wait on {}: {e}{suffix}", spec.program)),
    }
}

/// Wall-clock bound for [`harness_oneshot_text`]. Generation prompts are
/// self-contained (no tools to wait on), so a CLI that hasn't answered in
/// three minutes is wedged, not working.
pub(super) const ONESHOT_GEN_TIMEOUT: Duration = Duration::from_secs(180);

/// Blocking one-shot TEXT generation through a harness CLI — the artifact
/// generator's backend for `harness:<id>` chat sessions, whose provider/model
/// columns name a CLI, not an HTTP API. Self-contained prompt in, final text
/// out: no chat session, no events, no resume, no tool markers. Runs the
/// blocking process I/O on `spawn_blocking` so async command callers stay free.
pub(crate) async fn harness_oneshot_text(
    harness_id: &str,
    model: &str,
    prompt: &str,
    cwd: Option<&str>,
) -> Result<String, String> {
    let harness = harness_id.to_string();
    let model = model.to_string();
    let prompt = prompt.to_string();
    let cwd = cwd.map(|c| c.to_string());
    tokio::task::spawn_blocking(move || {
        harness_oneshot_blocking(&harness, &model, &prompt, cwd.as_deref())
    })
    .await
    .map_err(|e| format!("generation task failed: {e}"))?
}

pub(super) fn harness_oneshot_blocking(
    harness_id: &str,
    model: &str,
    prompt: &str,
    cwd: Option<&str>,
) -> Result<String, String> {
    // Claude uses plain `--output-format json`: one result object whose
    // `.result` field IS the final text (unlike stream-json, where the final
    // text is assembled from text deltas and the `result` event only closes
    // the turn). Kimi/OpenCode reuse the per-turn turn_spec transport — the
    // untrusted prompt never rides a cmd.exe command line (M12) — with their
    // stream events accumulated in `parse_oneshot_text` below.
    //
    // `--bare` (skip plugins/hooks/LSP/MCP) is REQUIRED here, not optional:
    // with a plugin-heavy settings.json, `claude -p` spent ~190s of wall time
    // on CLI startup before answering a 9s API call — past this function's
    // 180s kill timer, so every /create generation timed out. Bare mode
    // answers in ~4s. The prompt is self-contained and needs none of those
    // features; settings env (auth) still applies.
    let (spec, prompt_env, prompt_via_stdin) = match harness_id {
        "claude_code" => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                "--bare".into(),
                "--output-format".into(),
                "json".into(),
                "--dangerously-skip-permissions".into(),
            ];
            if !model.is_empty() {
                args.push("--model".into());
                args.push(claude_model_alias(model));
            }
            (
                resolve_for_spawn(&CommandSpec {
                    program: "claude".into(),
                    args,
                }),
                None,
                true,
            )
        }
        "kimi_code" => {
            let mut flags: Vec<String> = vec!["--output-format".into(), "stream-json".into()];
            if !model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("-m".into());
                flags.push(model.into());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::Kimi,
                prompt,
                flags,
            )?;
            (
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            )
        }
        "opencode" => {
            let mut flags: Vec<String> = Vec::new();
            if !model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("-m".into());
                flags.push(model.into());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::OpenCode,
                prompt,
                flags,
            )?;
            (
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            )
        }
        "pi" | "omp" | "commandcode" => {
            let mut flags: Vec<String> = Vec::new();
            if !model.is_empty() {
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push(if harness_id == "commandcode" {
                    "-m".into()
                } else {
                    "--model".into()
                });
                flags.push(model.into());
            }
            let harness = match harness_id {
                "omp" => crate::harness_adapters::TurnHarness::Omp,
                "commandcode" => crate::harness_adapters::TurnHarness::CommandCode,
                _ => crate::harness_adapters::TurnHarness::Pi,
            };
            let (spec, env, transport) =
                crate::harness_adapters::turn_spec(harness, prompt, flags)?;
            (
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            )
        }
        other => return Err(format!("unsupported harness for generation: {other}")),
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if prompt_via_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {harness_id} CLI: {e} (is it installed?)"))?;

    if prompt_via_stdin {
        let write_result = match child.stdin.take() {
            Some(mut stdin) => {
                use std::io::Write as _;
                stdin
                    .write_all(prompt.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("failed to write prompt to CLI stdin: {e}"))
            }
            None => Err("failed to open CLI stdin".to_string()),
        };
        if let Err(e) = write_result {
            // E-7 contract (same as spawn_per_turn / run_one_shot): dropping
            // Child does NOT terminate it — on Windows the handle is the
            // cmd.exe wrapper and the full-auto CLI grandchild would keep
            // running, blocked on its stdin. Kill the whole tree.
            kill_child_tree(&mut child);
            return Err(e);
        }
        // stdin drops here → EOF tells the CLI the prompt is complete.
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture CLI stdout".to_string())?;
    // Reader thread collects stdout to EOF; recv below joins it implicitly.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        use std::io::Read as _;
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    // stderr is where harness CLIs report the cause of a dead turn (auth /
    // quota / unknown-model errors — `opencode run` retries them indefinitely
    // and prints NOTHING to stdout), so a discarded stderr left the caller
    // with only "empty response" and the user with nothing actionable.
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture CLI stderr".to_string())?;
    let (etx, erx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        use std::io::Read as _;
        let _ = stderr.read_to_string(&mut buf);
        let _ = etx.send(buf);
    });

    // Poll-wait with a deadline; a hung CLI is killed at the bound instead of
    // wedging the async command forever (same posture as run_one_shot).
    let deadline = std::time::Instant::now() + ONESHOT_GEN_TIMEOUT;
    let mut timed_out = false;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if std::time::Instant::now() >= deadline => {
                // E-7: kill the WHOLE tree — on Windows `child.kill()` only
                // terminates the cmd.exe /C wrapper and the CLI grandchild
                // survives, keeps running (and spending) (see kill_child_tree).
                kill_child_tree(&mut child);
                timed_out = true;
                break;
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    if timed_out {
        // The kill above closed the stderr pipe → the reader hits EOF; give
        // it a moment and surface WHAT the CLI was doing when it was killed
        // (a retrying API error beats a bare "timed out").
        let err = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
        let suffix = stderr_suffix(&err);
        return Err(format!(
            "{harness_id} generation timed out after {}s{suffix}",
            ONESHOT_GEN_TIMEOUT.as_secs()
        ));
    }
    let raw = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| format!("{harness_id} closed without producing output"))?;
    let err = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();

    let text =
        parse_oneshot_text(harness_id, &raw).map_err(|e| format!("{e}{}", stderr_suffix(&err)))?;
    if text.trim().is_empty() {
        if err.trim().is_empty() {
            // Char-safe truncation: byte slicing panics when offset 200 lands
            // mid-multibyte-char (CJK/emoji CLI output).
            return Err(format!(
                "{harness_id} returned an empty response (raw: {})",
                crate::util::truncate_chars(&raw, 200)
            ));
        }
        return Err(format!(
            "{harness_id} returned an empty response{suffix}",
            suffix = stderr_suffix(&err)
        ));
    }
    Ok(text)
}

/// Last-resort diagnostic tail from a harness CLI's stderr, for error
/// messages — the tail carries the actual failure (stream errors are logged
/// repeatedly; the last line is the one that mattered). Empty input produces
/// an empty string; otherwise ` — stderr: …` with a char-safe cut (byte
/// slicing panics mid-multibyte-char) and newlines flattened so the message
/// stays one line in toasts/run history.
pub(super) fn stderr_suffix(stderr: &str) -> String {
    let flat = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.trim().is_empty() {
        return String::new();
    }
    let tail: String = if flat.chars().count() > 400 {
        flat.chars().skip(flat.chars().count() - 400).collect()
    } else {
        flat
    };
    format!(" — stderr: {tail}")
}

/// Extract the final assistant text from a one-shot CLI's raw stdout.
/// Claude (plain json): `.result` off the single result object. Kimi
/// (stream-json): concatenation of assistant `content` strings — mirrors
/// handle_kimi_event's text path, minus tool markers (a generation prompt
/// must not call tools, and markers would corrupt the expected JSON).
/// OpenCode (run-mode json events): text parts carry FULL snapshots, so only
/// each part's new suffix is appended — mirrors handle_opencode_event.
pub(super) fn parse_oneshot_text(harness_id: &str, raw: &str) -> Result<String, String> {
    // Char-safe head truncation (byte slicing panics when the cut lands
    // mid-multibyte-char).
    let head = |n: usize| crate::util::truncate_chars(raw, n);
    match harness_id {
        "claude_code" => {
            let v: Value = serde_json::from_str(raw.trim())
                .map_err(|e| format!("unparseable claude output: {e} (raw: {})", head(200)))?;
            if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
                let msg = v
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("generation failed");
                return Err(format!("claude code: {msg}"));
            }
            v.get("result")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("claude output missing `result` (raw: {})", head(200)))
        }
        "kimi_code" => {
            let mut full = String::new();
            for line in raw.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if v.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                        full.push_str(text);
                    }
                }
            }
            Ok(full)
        }
        "pi" | "omp" => {
            // pi-lineage JSON events: text_delta deltas concatenate (mirrors
            // handle_pi_event's text path, minus tool markers).
            let mut full = String::new();
            for line in raw.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) == Some("message_update") {
                    if let Some(delta) = v
                        .pointer("/assistantMessageEvent/type")
                        .and_then(|t| t.as_str())
                        .filter(|t| *t == "text_delta")
                        .map(|_| ())
                        .and_then(|_| v.pointer("/assistantMessageEvent/delta"))
                        .and_then(|d| d.as_str())
                    {
                        full.push_str(delta);
                    }
                }
            }
            Ok(full)
        }
        "commandcode" => {
            // finalText on the result line IS the reply; deltas are ignored
            // (mirrors handle_commandcode_event's catch-up semantics).
            let mut full = String::new();
            for line in raw.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                    if let Some(text) = v.get("finalText").and_then(|t| t.as_str()) {
                        full.push_str(text);
                    }
                }
            }
            Ok(full)
        }
        _ => {
            let mut full = String::new();
            let mut last_text = String::new();
            for line in raw.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = v.pointer("/part/text").and_then(|t| t.as_str()) {
                        let suffix = text.strip_prefix(last_text.as_str()).unwrap_or(text);
                        full.push_str(suffix);
                        last_text.clear();
                        last_text.push_str(text);
                    }
                }
            }
            Ok(full)
        }
    }
}

/// Build the spawn spec for a one-shot turn on any harness. Always full-auto
/// (--dangerously-skip-permissions for claude, --auto for opencode — no
/// permission selector is surfaced or consulted in the UI, so all CLI turns
/// run unrestricted). Kimi prompt mode is already non-interactive and
/// auto-approves tool calls by default; --yolo/--auto are interactive-mode
/// flags that kimi rejects with -p.
///
/// The prompt is UNTRUSTED user text and never rides a cmd.exe command line
/// (M12): claude reads it from stdin (`claude -p` with no prompt arg — the
/// caller pipes it, see `prompt_via_stdin` in run_one_shot); kimi/opencode
/// get it via RELAY_TURN_PROMPT + delayed-expansion wrapper (the returned
/// env pair, Windows only — POSIX keeps the prompt in argv, which exec
/// carries verbatim).
pub(super) fn one_shot_spec(
    harness: &str,
    prompt: &str,
    model: &str,
) -> Result<(CommandSpec, Option<(String, String)>, bool), String> {
    // The bool is `stdin_prompt`: when true the caller pipes `prompt` to the
    // child's stdin after spawn (claude and the pi-lineage CLIs).
    let _ = prompt; // prompt text only rides argv for kimi/opencode POSIX
    match harness {
        "claude_code" => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(),
                "--dangerously-skip-permissions".into(),
            ];
            if !model.is_empty() {
                args.push("--model".into());
                args.push(claude_model_alias(model));
            }
            Ok((
                resolve_for_spawn(&CommandSpec {
                    program: "claude".into(),
                    args,
                }),
                None,
                true,
            ))
        }
        "kimi_code" => {
            let mut flags: Vec<String> = vec!["--output-format".into(), "stream-json".into()];
            if !model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("-m".into());
                flags.push(model.into());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::Kimi,
                prompt,
                flags,
            )?;
            Ok((
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            ))
        }
        "opencode" => {
            // Flags BEFORE `--` (yargs swallows post-terminator tokens into
            // the prompt — see spawn_per_turn's OpenCode arm); turn_spec's
            // assembly preserves that invariant.
            let mut flags: Vec<String> = vec![];
            if !model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("-m".into());
                flags.push(model.into());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::OpenCode,
                prompt,
                flags,
            )?;
            Ok((
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            ))
        }
        "pi" | "omp" => {
            // pi-lineage one-shot turns: `-p --mode json` streams the shared
            // JSONL event protocol (handled by handle_pi_event). No resume —
            // automation runs are self-contained.
            let mut flags: Vec<String> = vec![];
            if !model.is_empty() {
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("--model".into());
                flags.push(model.into());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                if harness == "omp" {
                    crate::harness_adapters::TurnHarness::Omp
                } else {
                    crate::harness_adapters::TurnHarness::Pi
                },
                prompt,
                flags,
            )?;
            Ok((
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            ))
        }
        "commandcode" => {
            // Fixed headless flags ride in turn_spec's argv (yolo/onboarding/
            // auto-update); only the model selection is per-run. No resume —
            // automation runs are self-contained.
            let mut flags: Vec<String> = vec![];
            if !model.is_empty() {
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("-m".into());
                flags.push(model.into());
            }
            let (spec, env, transport) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::CommandCode,
                prompt,
                flags,
            )?;
            Ok((
                spec,
                env,
                transport == crate::harness_adapters::TurnPromptTransport::Stdin,
            ))
        }
        other => Err(format!(
            "harness '{other}' has no headless chat backend yet"
        )),
    }
}

// ---------------------------------------------------------------- tool markers

/// A tool's own content must never contain the closing tag or it would
/// truncate the marker on the client (same defense as chat/proto.rs).
pub(super) fn sanitize(v: String) -> String {
    v.replace("</tool>", "<\\/tool>")
}

/// Claude Code tool_use block → `<tool>{json}</tool>` marker (same shapes as
/// chat/proto.rs `tool_block` so DiffCard/activity groups just work).
///
/// Returns the tool NAME plus the marker Value(s) (MultiEdit yields one per
/// hunk). The caller wraps them via `ToolTracker::tool_use`, which injects a
/// correlation id into shell markers and records the call so its later result
/// can be attached.
pub(super) fn tool_meta_claude(block: &Value) -> Option<(String, Vec<Value>)> {
    let name = block.get("name").and_then(|n| n.as_str())?.to_string();
    let input = block.get("input").cloned().unwrap_or(json!({}));
    // One marker per MultiEdit hunk so each gets its own DiffCard. The harness
    // uses snake_case (old_string / new_string); accept the camelCase variants
    // too so OpenCode/anything wrapping Claude's API can land DiffCards.
    if name == "MultiEdit" {
        let path = input
            .get("file_path")
            .or_else(|| input.get("filePath"))
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        let edits = input
            .get("edits")
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let vals = edits
            .iter()
            .map(|e| {
                let find = e
                    .get("old_string")
                    .or_else(|| e.get("oldString"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let replace = e
                    .get("new_string")
                    .or_else(|| e.get("newString"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                json!({
                    "kind": "edit",
                    "title": format!("Editing file \"{path}\""),
                    "detail": path,
                    "path": path,
                    "edit": {
                        "mode": "replace",
                        "find": sanitize(find.to_string()),
                        "replace": sanitize(replace.to_string()),
                    },
                })
            })
            .collect();
        return Some((name, vals));
    }
    let vals = vec![tool_meta_generic(&name, &input)];
    Some((name, vals))
}
