//! opencode turn dispatch, server lifecycle, SSE reader, and tool emission — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
/// Send one user turn to this chat's persistent `opencode serve` process.
/// Send one user turn to this chat's persistent `opencode serve` process.
///
/// Unlike the per-turn `opencode run` spawn — which paid a CLI cold start on
/// EVERY message (the "OpenCode is starting up…" notice each time) — the
/// server boots once per chat and stays up: turns POST to its HTTP API while
/// a long-lived SSE subscription streams text/reasoning/tool parts live.
/// Warm turns start streaming immediately, matching claude_code's UX. The
/// opencode session id lives server-side, so context survives respawns
/// (cancel, model change, app restart) exactly like the old `-s <id>` resume.

pub(super) fn send_opencode_turn(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    content: &str,
    entry: &mut AgentChild,
    cwd: Option<&str>,
    project_id: Option<&str>,
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Result<(), String> {
    // Reuse a healthy server; respawn a dead one. The persisted opencode
    // session id keeps the conversation continuous across respawns.
    let alive = entry
        .oc_base_url
        .as_deref()
        .map(opencode_server_alive)
        .unwrap_or(false);
    let mut fell_back = false;
    if entry.child.is_none() || !alive {
        if let Some(mut old) = entry.child.take() {
            kill_child_tree(&mut old);
        }
        entry.oc_base_url = None;
        // The old reader dies with the old server; the new reader revives the
        // flag (spawn_opencode_server sets it before the thread starts).
        entry.oc_reader_alive.store(false, Ordering::SeqCst);
        // No cold-start notice on purpose: the persistent server boots in
        // ~1s and the first token lands right after; a status flash on every
        // respawn read as noise.
        match spawn_opencode_server(
            app,
            db,
            sid,
            cwd,
            project_id,
            connectors,
            Arc::clone(&entry.cli_session_id),
            Arc::clone(&entry.oc_full),
            Arc::clone(&entry.oc_in_think),
            Arc::clone(&entry.oc_last_event_ms),
            Arc::clone(&entry.oc_reader_alive),
        ) {
            Ok((child, base_url)) => {
                entry.child = Some(child);
                entry.oc_base_url = Some(base_url);
            }
            Err(e) => {
                // Degraded mode: legacy one-shot `opencode run` per turn.
                eprintln!(
                    "[agent] opencode server unavailable ({e}); falling back to per-turn run"
                );
                fell_back = true;
            }
        }
    }
    if fell_back {
        return spawn_per_turn(
            app,
            db,
            sid,
            content,
            entry,
            cwd,
            project_id,
            PerTurn::OpenCode,
            connectors,
        );
    }
    let base_url = entry
        .oc_base_url
        .clone()
        .ok_or_else(|| "opencode server url missing".to_string())?;

    // Resolve or create the server-side session id INSIDE the turn thread —
    // it (and every other opencode HTTP call) must never run inline here:
    // this function executes on the tokio runtime (async command), where a
    // nested block_on panics and would poison the sessions lock.
    let model_body = split_opencode_model(&entry.model);
    // Harness-native plan mode rides the message body's `agent` field
    // (verified against the server OpenAPI spec). Read per turn so a mode
    // switch applies from the very next message — the server process itself
    // never needs a respawn.
    let agent_body = if chat_permission_mode_label(db, sid) == "plan" {
        Some("plan")
    } else {
        None
    };

    // Set turn_in_flight BEFORE spawning the turn thread (mirrors
    // send_claude_turn): the thread may observe completion before send returns.
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    // Fresh per-turn cancel flag (same contract as every other path: a
    // cancelled turn's thread must keep seeing `true` even after the next
    // send replaces the entry's flag).
    let cancelled = Arc::new(AtomicBool::new(false));
    entry.cancelled = Arc::clone(&cancelled);

    // E-5 for opencode: bump the generation per send so this turn's thread —
    // and only this turn's thread — clears `turn_in_flight` at its tail. The
    // old unconditional store let a cancelled-and-superseded turn's tail
    // clobber the new turn's flag (the new turn then ran unprotected, and a
    // second concurrent send could spawn a second child for the same chat).
    let my_generation = entry.proc_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let proc_generation = Arc::clone(&entry.proc_generation);

    let app2 = app.clone();
    let db2 = DbState(Arc::clone(&db.0));
    let sid2 = sid.to_string();
    let content2 = content.to_string();
    let base2 = base_url.clone();
    let session_cell = Arc::clone(&entry.cli_session_id);
    let in_flight2 = Arc::clone(&entry.turn_in_flight);
    let full_cell = Arc::clone(&entry.oc_full);
    let think_cell = Arc::clone(&entry.oc_in_think);
    let quiet_cell = Arc::clone(&entry.oc_last_event_ms);
    let cancelled2 = Arc::clone(&cancelled);
    let in_flight_gen = Arc::clone(&proc_generation);
    let reader_alive2 = Arc::clone(&entry.oc_reader_alive);
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    let started_at = crate::db::now_ts();
    std::thread::spawn(move || {
        // Live TTFT / tok/s for this turn, with the chat's AppHandle so
        // `chat:perf` flows (headless accumulators never emit). The SSE
        // reader's token emissions hit this accumulator; finish_turn
        // unregisters, and the unconditional unregister at thread end is the
        // backstop for the error/cancel paths.
        let _perf = crate::chat::turn_perf::register(
            &sid2,
            crate::chat::turn_perf::TurnPerf::new_opt(Some(app2.clone()), &sid2),
        );
        let mut watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();

        // Resolve or create the server-side session id (resume across
        // restarts). Plain thread → block_on inside the HTTP call is legal.
        let oc_sid2 = match session_cell.lock().ok().and_then(|g| g.clone()) {
            Some(id) => id,
            None => match opencode_create_session(&base2) {
                Ok(id) => {
                    if let Ok(mut g) = session_cell.lock() {
                        *g = Some(id.clone());
                    }
                    persist_cli_session_id(&db2, "opencode", &sid2, &session_cell);
                    id
                }
                Err(e) => {
                    if should_clear_in_flight(in_flight_gen.load(Ordering::SeqCst), my_generation) {
                        in_flight2.store(false, Ordering::SeqCst);
                    }
                    emit_error(
                        Some(&app2),
                        &sid2,
                        &format!("OpenCode session create failed: {e}"),
                    );
                    return;
                }
            },
        };

        match opencode_post_message(&base2, &oc_sid2, model_body, agent_body, &content2) {
            Ok((input, output, cache_read, cache_creation, cost, actual)) => {
                // The POST resolves when the turn completes but can race its
                // last SSE flush — wait for a reader-quiet gap so the final
                // text snapshot is inside `full` before persisting.
                wait_for_reader_quiet(&quiet_cell, Duration::from_millis(2500));
                close_opencode_think(Some(&app2), &sid2, &think_cell, &full_cell);
                if let Some(m) = actual.as_deref() {
                    persist_actual_model(&db2, "opencode", &sid2, m);
                }
                let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                // Audit #87: a POST can "succeed" while the SSE reader is
                // dead (connection dropped mid-turn) — all streamed text was
                // lost, and this used to persist an EMPTY reply with no
                // error. Surface it instead; the turn is retryable.
                if full.is_empty()
                    && !reader_alive2.load(Ordering::SeqCst)
                    && !cancelled2.load(Ordering::SeqCst)
                {
                    drop(full);
                    crate::chat::turn_perf::unregister(&sid2);
                    if should_clear_in_flight(in_flight_gen.load(Ordering::SeqCst), my_generation) {
                        in_flight2.store(false, Ordering::SeqCst);
                    }
                    emit_error(
                        Some(&app2),
                        &sid2,
                        "OpenCode's event stream dropped before any output arrived, so the \
                         reply was lost. Retry the turn — Relay will restart the server if needed.",
                    );
                    return;
                }
                // RELAY_ASK scan BEFORE persisting: strip the marker question
                // from the reply, surface it as a card after chat:done.
                let (clean, ask) = split_relay_ask(std::mem::take(&mut *full));
                *full = clean;
                finish_turn(
                    Some(&app2),
                    &db2,
                    &sid2,
                    &mut full,
                    input,
                    output,
                    cost,
                    cache_creation,
                    cache_read,
                    &mut watches,
                    started_at,
                    actual.as_deref(),
                );
                drop(full);
                if let Some(questions) = ask {
                    surface_relay_ask(Some(&app2), &sid2, questions);
                }
            }
            Err(e) => {
                // cancel() kills the server → the POST fails too; only the
                // cancel path may have reported (it already emitted done).
                if !cancelled2.load(Ordering::SeqCst) {
                    close_opencode_think(Some(&app2), &sid2, &think_cell, &full_cell);
                    {
                        // Discard the partial reply, like claude's error path.
                        let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                        full.clear();
                    }
                    emit_error(Some(&app2), &sid2, &format!("OpenCode turn failed: {e}"));
                } else {
                    // Cancelled: discard the partial reply — the shared cells
                    // outlive the killed server and would otherwise prefix
                    // the NEXT turn's persisted message with this turn's
                    // fragment (B-6; cancel() clears them too, defense in
                    // depth). Each turn snapshots its own watch baselines,
                    // so dropping these is correct.
                    full_cell.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    *think_cell.lock().unwrap_or_else(|e| e.into_inner()) = false;
                    drop(watches);
                }
            }
        }
        // Error/cancel paths skip finish_turn (the success path already
        // unregistered inside it) — this no-op-on-success backstop covers all
        // three so a stale accumulator can't linger in the registry.
        crate::chat::turn_perf::unregister(&sid2);
        // E-5 gate: only the current turn's thread may clear the shared flag
        // (see the generation bump in send_opencode_turn).
        if should_clear_in_flight(in_flight_gen.load(Ordering::SeqCst), my_generation) {
            in_flight2.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

/// Force-close a dangling `<think>` block left open by an interrupted
/// reasoning stream so it can't render open forever (mirrors read_claude_stream).
pub(super) fn close_opencode_think(
    app: Option<&AppHandle>,
    sid: &str,
    think_cell: &Arc<Mutex<bool>>,
    full_cell: &Arc<Mutex<String>>,
) {
    let was_open = {
        let mut t = think_cell.lock().unwrap_or_else(|e| e.into_inner());
        let was = *t;
        *t = false;
        was
    };
    if was_open {
        let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
        full.push_str("</think>");
        emit_token(app, sid, "</think>");
    }
}

/// Spawn one `opencode serve` child for this chat, wait for its HTTP surface
/// to answer, then start the long-lived SSE reader. Returns child + base URL.
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_opencode_server(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    cwd: Option<&str>,
    project_id: Option<&str>,
    connectors: &[crate::connectors::HarnessMcpServer],
    session_cell: Arc<Mutex<Option<String>>>,
    full_cell: Arc<Mutex<String>>,
    think_cell: Arc<Mutex<bool>>,
    last_event_ms: Arc<AtomicU64>,
    reader_alive: Arc<AtomicBool>,
) -> Result<(Child, String), String> {
    let port = opencode_free_port().ok_or("no free TCP port for opencode server")?;
    let base_url = format!("http://127.0.0.1:{port}");

    // Same MCP registration contract as every other opencode spawn: point
    // OPENCODE_CONFIG at the Relay-owned bundle config (browser + tools +
    // connectors). Failure degrades to the legacy browser-only config.
    let bundle = resolve_harness_bundle(
        app,
        project_id,
        cwd,
        artifacts_dir_for_bundle(app, cwd),
        connectors,
        None,
        None,
    );
    let legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };

    let mut cmd = Command::new("opencode");
    cmd.args([
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        &port.to_string(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    if let Some(cfg) = bundle
        .as_ref()
        .map(|b| b.opencode_config.clone())
        .filter(|p| p.exists())
        .or(legacy_cfg)
    {
        cmd.env("OPENCODE_CONFIG", cfg);
    }
    // Serve from the workspace dir so relative tool paths land in the project.
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    no_console_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn opencode serve: {e}"))?;

    if !opencode_wait_ready(&base_url, Duration::from_secs(20)) {
        let mut c = child;
        kill_child_tree(&mut c);
        return Err(format!("opencode server not ready at {base_url}"));
    }

    // Long-lived SSE subscription covering EVERY turn this server handles.
    let app2 = app.clone();
    let sid2 = sid.to_string();
    // Audit #87: mark the reader LIVE before it starts and DEAD on every
    // exit path — the turn thread uses this to detect a POST that "succeeded"
    // while the event stream was gone (which used to persist an empty reply
    // with no error).
    reader_alive.store(true, Ordering::SeqCst);
    std::thread::Builder::new()
        .name(format!("oc-sse-{port}"))
        .spawn(move || {
            read_opencode_server_events(
                Some(&app2),
                &sid2,
                format!("http://127.0.0.1:{port}"),
                session_cell,
                full_cell,
                think_cell,
                last_event_ms,
            );
            reader_alive.store(false, Ordering::SeqCst);
        })
        .map_err(|e| format!("failed to spawn opencode SSE reader: {e}"))?;

    Ok((child, base_url))
}

/// Cheap liveness probe: is anything accepting TCP on the server's port?
pub(super) fn opencode_server_alive(base_url: &str) -> bool {
    match base_url
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
    {
        Some(port) => std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(250),
        )
        .is_ok(),
        None => false,
    }
}

/// Grab an ephemeral free port (bind :0, read, release). Small TOCTOU window
/// before the server binds — acceptable on loopback.
pub(super) fn opencode_free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|a| a.port())
}

/// Poll the server's TCP listener until it accepts (or the budget runs out),
/// then give the HTTP router a short grace period. Pure socket probe — no
/// tokio, safe to call from the async-command thread.
pub(super) fn opencode_wait_ready(base_url: &str, budget: Duration) -> bool {
    let Some(port) = base_url
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
    else {
        return false;
    };
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = std::time::Instant::now() + budget;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            std::thread::sleep(Duration::from_millis(250));
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Create a fresh session on the server; returns its id (`ses_…`).
pub(super) fn opencode_create_session(base_url: &str) -> Result<String, String> {
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .post(format!("{base_url}/session"))
            .json(&json!({}))
            .send()
            .await
            .map_err(|e| format!("session create failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "session create HTTP {status}: {}",
                truncate_output(&body)
            ));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("session parse: {e}"))?;
        v.get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "session create returned no id".to_string())
    })
}

/// Split Relay's model id into OpenCode's message-body shape. Bare ids are
/// resolved to "provider/model" against the opencode.json config first —
/// OpenCode only accepts provider-qualified selectors, and a bare id used to
/// silently fall back to the CLI's configured default (the "model change does
/// nothing" bug). Unparseable models stay None → server default.
pub(super) fn split_opencode_model(model: &str) -> Option<Value> {
    let model = crate::harness_config::resolve_opencode_model(model);
    let (provider, name) = model.split_once('/')?;
    if provider.is_empty() || name.is_empty() {
        return None;
    }
    Some(json!({ "providerID": provider, "modelID": name }))
}

/// POST one turn. Resolves when the TURN completes (the endpoint blocks until
/// then) and carries final usage + cost; streaming arrives via SSE meanwhile.
/// `agent` selects OpenCode's built-in agent ("plan" for plan mode — the
/// message body's `agent` field is the server-path equivalent of `run
/// --agent`; verified against the server's OpenAPI spec).
pub(super) fn opencode_post_message(
    base_url: &str,
    oc_sid: &str,
    model: Option<Value>,
    agent: Option<&str>,
    content: &str,
) -> Result<
    (
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<f64>,
        Option<String>,
    ),
    String,
> {
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            // Turns can legitimately run long; only absurd hangs should fail.
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let mut body = json!({ "parts": [ { "type": "text", "text": content } ] });
        if let Some(m) = model {
            body["model"] = m;
        }
        if let Some(a) = agent {
            body["agent"] = json!(a);
        }
        let resp = client
            .post(format!("{base_url}/session/{oc_sid}/message"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("message post failed: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("HTTP {status}: {}", truncate_output(&text)));
        }
        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("message response parse: {e}"))?;
        let info = v.get("info").cloned().unwrap_or(json!({}));
        let input = info.pointer("/tokens/input").and_then(|t| t.as_i64());
        let output = info.pointer("/tokens/output").and_then(|t| t.as_i64());
        // OpenCode nests cache reads/writes under tokens.cache when the
        // provider reports them; absent → NULL like every other harness.
        let cache_read = info.pointer("/tokens/cache/read").and_then(|t| t.as_i64());
        let cache_creation = info.pointer("/tokens/cache/write").and_then(|t| t.as_i64());
        let cost = info.get("cost").and_then(|c| c.as_f64());
        // The model that ACTUALLY served the turn (opencode routes through
        // whatever its config says — the session's stored id can be a stale
        // catalog entry). modelID + providerID recombine into the canonical
        // "provider/model" shape the cost rollup and meter match on.
        let model = info.get("modelID").and_then(|m| m.as_str()).map(|m| {
            let provider = info.get("providerID").and_then(|p| p.as_str());
            match provider {
                Some(p) if !p.is_empty() => format!("{p}/{m}"),
                _ => m.to_string(),
            }
        });
        Ok((input, output, cache_read, cache_creation, cost, model))
    })
}

/// Block until the SSE reader has been idle ~150ms (bounded), so the turn
/// thread never persists before the reader flushed its final snapshots.
pub(super) fn wait_for_reader_quiet(last_event_ms: &AtomicU64, max_wait: Duration) {
    let deadline = std::time::Instant::now() + max_wait;
    while std::time::Instant::now() < deadline {
        let last = last_event_ms.load(Ordering::Relaxed);
        let now = now_ms_u64();
        if last != 0 && now.saturating_sub(last) >= 150 {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub(super) fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Long-lived SSE consumer for one `opencode serve` child: maps
/// `message.part.updated` events onto the SAME handler the per-turn JSON
/// stream used, so tokens/tool markers/thinking blocks render identically.
/// Exits silently when the connection drops — turn errors are reported by
/// the turn thread via its failed POST.
pub(super) fn read_opencode_server_events(
    app: Option<&AppHandle>,
    sid: &str,
    base_url: String,
    session_cell: Arc<Mutex<Option<String>>>,
    full_cell: Arc<Mutex<String>>,
    think_cell: Arc<Mutex<bool>>,
    last_event_ms: Arc<AtomicU64>,
) {
    use futures_util::StreamExt;

    let _ = tauri::async_runtime::block_on(async move {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            // No overall timeout: SSE lives as long as the server does.
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let resp = match client
            .get(format!("{base_url}/event"))
            .header("accept", "text/event-stream")
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => return,
        };
        let mut stream = resp.bytes_stream();
        let mut buf = crate::util::SseLineBuffer::with_cap(4 * 1024 * 1024);
        let mut last_text = String::new();
        let mut last_reasoning = String::new();
        let mut tools = ToolTracker::new();
        // part id → 1 = live-call card sent, 2 = finished/self-contained.
        let mut tool_states: HashMap<String, u8> = HashMap::new();
        // message id → role ("user"/"assistant"): the server streams part
        // updates for BOTH messages, and only the assistant's are the reply.
        let mut roles: HashMap<String, String> = HashMap::new();
        // part id → kind ("text"/"reasoning"/"tool"): token-level
        // `message.part.delta` events only name the part id + field, so this
        // map routes each delta onto the right stream.
        let mut part_kinds: HashMap<String, String> = HashMap::new();
        // Audit #90: the SSE connection lives across hundreds of turns on a
        // long-running server and these maps key per-message/per-part ids —
        // they grew monotonically. `handle_opencode_sse_data` caps them.
        // (A cap-clear worst-case re-emits one tool card once, which beats
        // unbounded memory growth.)
        // The part id each snapshot baseline (last_text / last_reasoning)
        // currently tracks. Baselines are PER PART — a turn can hold several
        // text parts (text → tool → text), and carrying the flat baseline
        // across parts would duplicate the new part's final snapshot.
        let mut cur_text_part = String::new();
        let mut cur_reasoning_part = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(_) => break,
            };
            // Shared SSE line buffer carries partial lines across TCP chunks;
            // the 4 MiB cap is the pathological-flood guard (a server sending
            // megabytes without a newline gets its partial dropped whole
            // instead of growing the buffer without bound).
            for line in buf.push(&bytes) {
                let line = line.trim_end_matches(['\n', '\r']);
                if let Some(data) = line.strip_prefix("data:") {
                    handle_opencode_sse_data(
                        app,
                        sid,
                        &base_url,
                        data.trim(),
                        &session_cell,
                        &full_cell,
                        &think_cell,
                        &last_event_ms,
                        &mut last_text,
                        &mut last_reasoning,
                        &mut tools,
                        &mut tool_states,
                        &mut roles,
                        &mut part_kinds,
                        &mut cur_text_part,
                        &mut cur_reasoning_part,
                    );
                }
            }
        }
    });
}

/// Parse one SSE `data:` payload and route it onto the shared buffers.
#[allow(clippy::too_many_arguments)]
pub(super) fn handle_opencode_sse_data(
    app: Option<&AppHandle>,
    sid: &str,
    base_url: &str,
    data: &str,
    session_cell: &Arc<Mutex<Option<String>>>,
    full_cell: &Arc<Mutex<String>>,
    think_cell: &Arc<Mutex<bool>>,
    last_event_ms: &AtomicU64,
    last_text: &mut String,
    last_reasoning: &mut String,
    tools: &mut ToolTracker,
    tool_states: &mut HashMap<String, u8>,
    roles: &mut HashMap<String, String>,
    part_kinds: &mut HashMap<String, String>,
    cur_text_part: &mut String,
    cur_reasoning_part: &mut String,
) {
    // Audit #90: bound the per-connection stream-state maps (see the cap at
    // the reader's declaration).
    const STREAM_STATE_CAP: usize = 8192;
    if tool_states.len() > STREAM_STATE_CAP {
        tool_states.clear();
    }
    if roles.len() > STREAM_STATE_CAP {
        roles.clear();
    }
    if part_kinds.len() > STREAM_STATE_CAP {
        part_kinds.clear();
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return;
    };
    last_event_ms.store(now_ms_u64(), Ordering::Relaxed);

    // OpenCode's NATIVE `question` tool: the server parks the in-flight turn
    // on this request until the client POSTs an answer (or a reject) to
    // `/session/{sid}/question/{requestID}/reply|reject`. Surface the
    // question card; `resolve_agent_question` routes the answer straight
    // back to the server and the turn completes on its own.
    if v.get("type").and_then(|t| t.as_str()) == Some("question.asked") {
        let request_id = v
            .pointer("/properties/id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        if !request_id.is_empty() {
            let questions = v
                .pointer("/properties/questions")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let oc_session_id = v
                .pointer("/properties/sessionID")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            surface_opencode_question(app, sid, base_url, &oc_session_id, &request_id, questions);
        }
        return;
    }

    // message.updated announces each message's id + role BEFORE its parts
    // stream — remember it so user-message parts can be filtered below.
    if v.get("type").and_then(|t| t.as_str()) == Some("message.updated") {
        if let (Some(id), Some(role)) = (
            v.pointer("/properties/info/id").and_then(|s| s.as_str()),
            v.pointer("/properties/info/role").and_then(|s| s.as_str()),
        ) {
            roles.insert(id.to_string(), role.to_string());
        }
        return;
    }

    // Token-level delta (verified shape):
    // {"type":"message.part.delta","properties":{"sessionID","messageID",
    //  "partID","field":"text","delta":" The"}} — a pure increment for one
    // part. This is what makes warm turns stream live; `message.part.updated`
    // only fires per completed segment as reconciliation.
    if v.get("type").and_then(|t| t.as_str()) == Some("message.part.delta") {
        // Session filter.
        if let Some(ev_sid) = v.pointer("/properties/sessionID").and_then(|s| s.as_str()) {
            let want = session_cell.lock().ok().and_then(|g| g.clone());
            if let Some(want) = want {
                if want != ev_sid {
                    return;
                }
            }
        }
        // Role filter (user messages never stream deltas, but be safe).
        if let Some(mid) = v.pointer("/properties/messageID").and_then(|m| m.as_str()) {
            if roles.get(mid).map(|r| r != "assistant").unwrap_or(false) {
                return;
            }
        }
        let Some(delta) = v.pointer("/properties/delta").and_then(|d| d.as_str()) else {
            return;
        };
        if delta.is_empty() {
            return;
        }
        // Route by the part's known kind; fall back to the event's field.
        let pid = v
            .pointer("/properties/partID")
            .and_then(|p| p.as_str())
            .unwrap_or("");
        let field = v
            .pointer("/properties/field")
            .and_then(|f| f.as_str())
            .unwrap_or("text");
        let kind = part_kinds
            .get(pid)
            .cloned()
            .unwrap_or_else(|| field.to_string());
        match kind.as_str() {
            "reasoning" | "thinking" => {
                // A new reasoning part restarts its snapshot baseline.
                if pid != cur_reasoning_part.as_str() {
                    *cur_reasoning_part = pid.to_string();
                    last_reasoning.clear();
                }
                // Open a fresh thinking block if none is open.
                let need_open = {
                    let mut t = think_cell.lock().unwrap_or_else(|e| e.into_inner());
                    if *t {
                        false
                    } else {
                        *t = true;
                        true
                    }
                };
                if need_open {
                    let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                    full.push_str("<think>");
                    emit_token(app, sid, "<think>");
                }
                last_reasoning.push_str(delta);
                let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                full.push_str(delta);
                emit_token(app, sid, delta);
            }
            "text" => {
                // A new text part restarts its snapshot baseline.
                if pid != cur_text_part.as_str() {
                    *cur_text_part = pid.to_string();
                    last_text.clear();
                }
                // Text after reasoning closes the thinking block first.
                let was_open = {
                    let mut t = think_cell.lock().unwrap_or_else(|e| e.into_inner());
                    let was = *t;
                    *t = false;
                    was
                };
                if was_open {
                    last_reasoning.clear();
                    let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                    full.push_str("</think>");
                    emit_token(app, sid, "</think>");
                }
                // Keep the baseline in lockstep so the reconciling full
                // snapshot at segment end computes an empty suffix.
                last_text.push_str(delta);
                let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                full.push_str(delta);
                emit_token(app, sid, delta);
            }
            // Tool parts stream no text deltas worth rendering — cards are
            // driven by the state machine on updated events.
            _ => {}
        }
        return;
    }

    if v.get("type").and_then(|t| t.as_str()) != Some("message.part.updated") {
        return;
    }
    // One serve process per chat session: ignore other sessions' traffic.
    let want = session_cell.lock().ok().and_then(|g| g.clone());
    if let (Some(want), Some(ev_sid)) = (
        want,
        v.pointer("/properties/sessionID").and_then(|s| s.as_str()),
    ) {
        if want != ev_sid {
            return;
        }
    }
    let Some(part) = v.pointer("/properties/part") else {
        return;
    };
    // Only ASSISTANT parts are the reply. The server also streams part
    // updates for the USER message (the prompt echo, incl. injected
    // instructions) — without this filter they'd render at the top of every
    // assistant bubble. Unknown ids default to rendering (lenient): observed
    // ordering always delivers message.updated first.
    if let Some(mid) = part.get("messageID").and_then(|m| m.as_str()) {
        if roles.get(mid).map(|r| r != "assistant").unwrap_or(false) {
            return;
        }
    }
    match part.get("type").and_then(|t| t.as_str()) {
        Some("text") | Some("reasoning") => {
            let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("text");
            // Remember this part's kind so its token deltas route here.
            let pid = part.get("id").and_then(|p| p.as_str()).unwrap_or("");
            part_kinds.insert(pid.to_string(), kind.to_string());
            // Baselines are per part: a new part id restarts its baseline so
            // the reconciling snapshot computes an empty suffix (deltas may
            // have already streamed this part's content).
            if kind == "text" {
                if pid != cur_text_part.as_str() {
                    *cur_text_part = pid.to_string();
                    last_text.clear();
                }
            } else if pid != cur_reasoning_part.as_str() {
                *cur_reasoning_part = pid.to_string();
                last_reasoning.clear();
            }
            // Normalize onto the shape handle_opencode_event already parses
            // (full snapshot of the part's text; suffix logic inside).
            let event = json!({ "type": kind, "part": { "text": part.get("text") } });
            let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
            let mut in_think = think_cell.lock().unwrap_or_else(|e| e.into_inner());
            // Throwaway usage accumulators — text/reasoning parts carry no
            // usage; the turn's numbers come from the POST response.
            let mut input: Option<i64> = None;
            let mut output: Option<i64> = None;
            let mut cache_read: Option<i64> = None;
            let mut cache_creation: Option<i64> = None;
            let mut cost: Option<f64> = None;
            handle_opencode_event(
                app,
                sid,
                &event,
                &mut full,
                session_cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut cost,
                last_text,
                last_reasoning,
                &mut in_think,
                tools,
            );
        }
        Some("tool") => {
            // Deltas for tool parts are ignored — cards are state-machine driven.
            // Tool execution begins — close the generation window so the tool
            // wait stays out of decode time/LLM time (mirrors the per-turn
            // handler's tool_use arm).
            crate::chat::turn_perf::end_active_gen(sid);
            if let Some(pid) = part.get("id").and_then(|p| p.as_str()) {
                part_kinds.insert(pid.to_string(), "tool".to_string());
            }
            emit_opencode_tool(app, sid, part, full_cell, think_cell, tools, tool_states);
        }
        // step-start/step-finish carry no renderable payload here — usage and
        // cost come from the POST response — so they're intentionally ignored.
        _ => {}
    }
}

/// Handle one server tool part across its status transitions: pending/running
/// → live `<tool>` card immediately; completed/error → attach the result.
/// Parts that arrive already-finished use the self-contained call+output
/// marker (identical to what the per-turn JSON stream emitted).
pub(super) fn emit_opencode_tool(
    app: Option<&AppHandle>,
    sid: &str,
    part: &Value,
    full_cell: &Arc<Mutex<String>>,
    think_cell: &Arc<Mutex<bool>>,
    tools: &mut ToolTracker,
    tool_states: &mut HashMap<String, u8>,
) {
    let pid = match part.get("id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => format!("seq-{}", tools.seq),
    };
    let name = part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
    let state = part.get("state").cloned().unwrap_or(json!({}));
    let status = state.get("status").and_then(|s| s.as_str()).unwrap_or("");
    let inp = state.get("input").cloned().unwrap_or(json!({}));
    let done = matches!(status, "completed" | "error");

    // Plan-step progress flows through every update (dedup'd UI-side).
    emit_todowrite_steps(app, sid, name, &inp);

    let seen = tool_states.get(&pid).copied().unwrap_or(0);
    if seen == 0 {
        // A tool call ends any open thinking block (keeps markers outside it).
        close_opencode_think(app, sid, think_cell, full_cell);
        let value = tool_meta_generic(name, &inp);
        let marker = if done {
            let out = state.get("output").and_then(|o| o.as_str());
            let err = state.get("error").and_then(|e| e.as_str());
            tools.tool_use_with_output(name, value, out, err)
        } else if is_subagent_tool_name(name) {
            let role = inp
                .get("subagent_type")
                .and_then(|v| v.as_str())
                .unwrap_or("agent");
            let task = inp
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let prompt = inp.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            tools.subagent_use(name, value, app, sid, role, task, prompt, "", false)
        } else {
            tools.tool_use(name, vec![value])
        };
        {
            let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
            full.push_str(&marker);
        }
        emit_token(app, sid, &marker);
        tool_states.insert(pid, if done { 2 } else { 1 });
    } else if seen == 1 && done {
        // Attach the completed output to the live card queued earlier.
        let text = state
            .get("output")
            .and_then(|o| o.as_str())
            .or_else(|| state.get("error").and_then(|e| e.as_str()))
            .unwrap_or(if status == "error" { "tool failed" } else { "" });
        if let Some(marker) = tools.tool_result(text, status == "error", app, sid, None) {
            let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
            full.push_str(&marker);
            emit_token(app, sid, &marker);
        }
        tool_states.insert(pid, 2);
    }
}
