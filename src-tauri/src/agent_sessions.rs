//! Headless CLI chat sessions (Phase 2 — mockups/04 "Option B").
//!
//! Chat sessions whose `agent` is a CLI harness (`harness:claude_code`, …)
//! are backed by real CLI processes instead of the built-in ChatManager's
//! direct HTTP calls. Two spawn styles, normalized onto the SAME Tauri events
//! the built-in chat emits (`chat:token` / `chat:done` / `chat:error`):
//!
//! - **claude_code** — one persistent process per chat:
//!   `claude -p --input-format stream-json --output-format stream-json
//!   --verbose --include-partial-messages`. Each turn is a JSON line on
//!   stdin; token deltas arrive via `stream_event` wrappers and the turn
//!   closes with a `result` event carrying usage + cost.
//! - **opencode** — one persistent server per chat:
//!   `opencode serve --hostname 127.0.0.1 --port <free>` driven over its
//!   HTTP API. A long-lived SSE subscription on `/event` streams text /
//!   reasoning / tool parts live (same `<tool>` marker encoding as the
//!   other CLIs); each turn POSTs `/session/<id>/message`, whose response
//!   resolves exactly when the turn completes and carries usage + cost.
//!   The server boots once per chat instead of once per turn, so warm
//!   turns stream immediately — no per-message cold start, matching the
//!   claude_code UX.
//! - **kimi_code** — one process per turn:
//!   `kimi -p <prompt> --output-format stream-json [-m model] [--session id]`
//!   The CLI's own session id (from the first turn's output) is passed back
//!   on later turns so the conversation continues; process exit closes the
//!   turn. The id is kept in memory AND persisted to app_settings
//!   (`agent.cli_session_id.<harness>.<sid>`), so multi-turn context survives
//!   cancels (which keep the entry, only killing the process tree) and app
//!   restarts. claude_code captures its `session_id` from result events and
//!   passes `--resume` on respawn; opencode persists its server-side session
//!   id and POSTs to it again after a respawn.
//!
//! Tool calls are encoded as `<tool>{json}</tool>` markers inline in the
//! token stream — the exact format MessageBubble / DiffCard and the history
//! sanitizer already parse (see chat/proto.rs). The frontend needed no new
//! rendering: only send/cancel routing.
//!
//! Engine handoff: when a turn goes to a CLI that is starting a brand-new
//! session (first harness turn of the chat, a mid-chat harness switch, or an
//! ACP respawn — ACP has no resume), the first prompt carries a **context
//! primer**: a compact transcript rebuilt from the persisted chat history, so
//! switching engines mid-chat preserves the conversation the same way the
//! built-in providers (which replay DB history every turn) always have.
//!
//! A third entry point, `run_one_shot`, runs one blocking self-contained
//! turn (no persistent process, no CLI session resume) and works with or
//! without a Tauri AppHandle — it backs scheduled automations, both from the
//! in-app scheduler and from the standalone `conduit-automation` binary.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::browser_mcp::bound_port;
use crate::browser_mcp_register;
use crate::harness_adapters::{resolve_for_spawn, CommandSpec};
use crate::DbState;

/// Tauri state wrapper (registered in lib.rs).
pub struct AgentSessionState(pub Arc<AgentSessionManager>);

pub struct AgentSessionManager {
    sessions: Mutex<HashMap<String, AgentChild>>,
}

struct AgentChild {
    harness: String,
    /// Model the session was last spawned with — a model change respawns
    /// (claude) or just applies to the next per-turn process.
    model: String,
    /// claude_code: the persistent process (always Some).
    /// kimi/opencode: Some only while a turn's process is running.
    child: Option<Child>,
    /// claude_code: the model the persistent process was spawned with —
    /// a change kills and respawns it.
    spawned_model: Option<String>,
    /// claude_code: the permission-mode label the persistent process was
    /// spawned with (`--permission-mode` is baked into the CLI invocation).
    /// A changed label live-applies via the set_permission_mode control
    /// request where possible and otherwise respawns on the next send —
    /// without this the mode menu's pick silently never reached the CLI.
    spawned_mode: Option<String>,
    /// The CLI's own session id, captured from turn output and passed back
    /// to continue the conversation (kimi `--session`, opencode `-s`,
    /// claude `--resume` on respawn). Shared with the reader thread, which
    /// fills it in; also persisted to app_settings so context survives
    /// cancels and app restarts.
    cli_session_id: Arc<Mutex<Option<String>>>,
    /// Set while a turn is streaming; cleared on result/exit.
    turn_in_flight: Arc<AtomicBool>,
    /// Whether a reader thread is still draining the current process's
    /// stdout. Cleared by a RAII guard on EVERY reader exit path; `send_*`
    /// respawns when this is `false` even though `child` is still Some —
    /// a handshake-failed or crashed CLI used to leave `child` occupied
    /// with no reader alive, wedging every later send (B-4/B-5).
    reader_alive: Arc<AtomicBool>,
    /// Incremented on every (re)spawn. A reader thread captures its value
    /// and may only clear `turn_in_flight` while it still matches — an old
    /// reader's late EOF must not clobber a turn already started on the
    /// respawned process (E-5).
    proc_generation: Arc<AtomicU64>,
    /// Set by `cancel` for the CURRENT turn/process only. Replaced with a
    /// fresh flag on every (re)spawn, so a late-finishing reader thread from
    /// a cancelled turn still sees `true` (skips persisting the partial
    /// reply) even after the user has already sent the next message.
    cancelled: Arc<AtomicBool>,
    /// Shared stdin for writing user input (e.g. a tool result) from the reader thread
    /// on stdin.
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    /// ACP: content queued for the reader thread to send as `session/request`
    /// once the initialize → session/new handshake completes (first turn only;
    /// later turns write the request directly from `send`).
    acp_pending: Arc<Mutex<Option<String>>>,
    /// ACP: id of the in-flight `session/request`, for a best-effort
    /// `request/cancel` notification before the process tree is killed.
    acp_request_id: Arc<Mutex<Option<u64>>>,
    // ---- OpenCode persistent server (`opencode serve`) state ----
    /// Base URL of this chat's server ("http://127.0.0.1:<port>"). Some only
    /// for opencode sessions; cleared whenever the child is killed so the
    /// next send respawns instead of POSTing into a dead server.
    oc_base_url: Option<String>,
    /// Accumulated reply text, shared between the SSE reader thread (which
    /// appends streamed suffixes) and the per-turn thread that calls
    /// finish_turn (which clears it — see finish_turn).
    oc_full: Arc<Mutex<String>>,
    /// Whether a `<think>` block is currently open in oc_full. The reader
    /// toggles it on reasoning/text transitions; the turn thread force-closes
    /// a dangling block at turn end so it can't render open forever.
    oc_in_think: Arc<Mutex<bool>>,
    /// Millis epoch of the last SSE event, updated by the reader. The turn
    /// thread waits for a quiet gap before finish_turn so the final snapshot
    /// events always land inside the persisted reply (the POST resolves when
    /// the turn completes, which can race its last SSE flush).
    oc_last_event_ms: Arc<AtomicU64>,
}

impl AgentSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Send one user turn. The harness id comes from the chat session's
    /// `agent` field ("harness:<id>"), passed by the command layer.
    /// `attach_prompt` is the CLI-facing appendix built by
    /// `prepare_agent_attachments` (attachment file paths + extracted text) —
    /// appended to what the CLI sees but NOT part of the persisted user
    /// message, which keeps only the compact display markers.
    /// `connectors` is the command layer's snapshot of connected connectors
    /// (tokens already refreshed), merged into the spawn's MCP config.
    pub fn send(
        &self,
        app: &AppHandle,
        db: &DbState,
        chat_session_id: &str,
        content: &str,
        attach_prompt: &str,
        harness: &str,
        model: &str,
        cwd: Option<&str>,
        project_id: Option<&str>,
        connectors: &[crate::connectors::HarnessMcpServer],
        // Optional structured summary of the turns the primer's char budget
        // drops (built async by the send command via `build_primer_summary`
        // before this sync path runs). Empty/None → truncate-only primer.
        primer_summary: Option<&str>,
    ) -> Result<(), String> {
        // Poison-recoverable: a panic in a prior send must not wedge every
        // future send behind a permanently-poisoned lock.
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let entry = sessions
            .entry(chat_session_id.to_string())
            .or_insert_with(|| {
                // Restore a previously captured CLI session id (persisted by
                // the reader thread at end of turn) so conversation context
                // survives app restarts, not just cancels.
                let stored = {
                    let conn = db.0.lock();
                    crate::db::get_setting(&conn, &cli_session_key(harness, chat_session_id))
                        .ok()
                        .flatten()
                };
                AgentChild {
                    harness: harness.to_string(),
                    model: model.to_string(),
                    child: None,
                    spawned_model: None,
                    spawned_mode: None,
                    cli_session_id: Arc::new(Mutex::new(stored)),
                    turn_in_flight: Arc::new(AtomicBool::new(false)),
                    reader_alive: Arc::new(AtomicBool::new(false)),
                    proc_generation: Arc::new(AtomicU64::new(0)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    stdin: Arc::new(Mutex::new(None)),
                    acp_pending: Arc::new(Mutex::new(None)),
                    acp_request_id: Arc::new(Mutex::new(None)),
                    oc_base_url: None,
                    oc_full: Arc::new(Mutex::new(String::new())),
                    oc_in_think: Arc::new(Mutex::new(false)),
                    oc_last_event_ms: Arc::new(AtomicU64::new(0)),
                }
            });
        // Check turn-in-flight BEFORE persisting the user message, so a
        // rejected send doesn't leave an orphan user message in the DB
        // with no assistant reply (which would survive restarts). (E-4:
        // also BEFORE the harness-switch teardown below — the teardown used
        // to run first, killing the in-flight turn's process tree and only
        // then rejecting the send.)
        if entry.turn_in_flight.load(Ordering::SeqCst) {
            return Err("a turn is already running for this chat".to_string());
        }
        // Harness switch on an existing chat: kill the old CLI's process and
        // drop its resume id — a kimi session id means nothing to opencode.
        if entry.harness != harness {
            if let Some(mut child) = entry.child.take() {
                kill_child_tree(&mut child);
            }
            entry.harness = harness.to_string();
            entry.spawned_model = None;
            entry.spawned_mode = None;
            if let Ok(mut g) = entry.cli_session_id.lock() {
                *g = None;
            }
        }
        entry.model = model.to_string();

        // Context primer for a fresh CLI session (see the module-level notes):
        // gated on cli_session_id AFTER the harness-switch teardown above — the
        // teardown is exactly what turns the id to None on an engine switch, so
        // the gate must be evaluated afterwards. Built BEFORE the user message
        // below is persisted, so the transcript covers only prior turns; this
        // turn's message rides in `content` verbatim.
        let context_primer = if entry.cli_session_id.lock().ok().and_then(|g| g.clone()).is_none() {
            // `primer_summary` (when the async command managed to pre-build
            // one) carries a structured summary of the turns that don't fit
            // the tail budget; without it the primer is truncate-only.
            let primer = build_context_primer(
                db,
                chat_session_id,
                primer_summary.filter(|s| !s.trim().is_empty()),
            );
            if !primer.is_empty() {
                eprintln!(
                    "[context] harness primer: session={} chars={} (fresh CLI session — replaying DB history)",
                    chat_session_id,
                    primer.len()
                );
            }
            primer
        } else {
            String::new()
        };

        // Mirror the built-in chat: the user message is persisted up front so
        // history survives a crash mid-turn. Done AFTER the turn-in-flight
        // check so a rejected turn can't orphan a user message.
        {
            let conn = db.0.lock();
            crate::db::add_chat_message(&conn, chat_session_id, "user", content, None, None, None, None, None, None, None, None, None, None, None, None, None, None, None)
                .map_err(|e| e.to_string())?;
        }

        // Prepend the Conduit persona + the user's custom system prompt
        // (Settings → Assistant) so the harness CLI presents the same identity
        // the built-in chat does — without it the CLI answers "I'm Claude
        // Code / OpenCode" and denies being Conduit. The persona goes FIRST,
        // the custom prompt after it, both separated from the message by a
        // blank line. The original content is persisted to the DB without the
        // prefix (the system prompt is separate config, not part of the
        // message). The attachment appendix goes LAST — after the persona and
        // the typed text — so file paths/text read as an addendum to the
        // user's words.
        let harness_label = match harness {
            "claude_code" => "Claude Code",
            "kimi_code" => "Kimi Code",
            "opencode" => "OpenCode",
            other => other,
        };
        let persona = harness_persona(harness_label);
        let effective = {
            let conn = db.0.lock();
            let custom: Option<String> =
                crate::db::get_setting(&conn, "assistant.systemPrompt").ok().flatten();
            let mut base = persona.clone();
            if let Some(sp) = custom.filter(|sp| !sp.trim().is_empty()) {
                base.push_str("\n\n");
                base.push_str(&sp);
            }
            base.push_str("\n\n---\n\n");
            if !context_primer.is_empty() {
                base.push_str(&context_primer);
                base.push_str("\n\n---\n\n");
            }
            base.push_str(content);
            if attach_prompt.is_empty() {
                base
            } else {
                format!("{base}{attach_prompt}")
            }
        };

        // Checkpoint baseline: snapshot the spawn dir's working tree once per
        // session before the CLI starts touching files (checkpoint 0 =
        // pre-chat state). Non-repo dirs (artifacts folder) skip silently.
        if let Some(dir) = spawn_dir(cwd, &db.0) {
            let conn = db.0.lock();
            crate::checkpoints::maybe_baseline(Some(app), &conn, chat_session_id, &dir);
        }

        match harness {
            "claude_code" => send_claude_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, connectors),
            "kimi_code" => spawn_per_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, PerTurn::Kimi, connectors),
            "opencode" => send_opencode_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, connectors),
            s if s.starts_with("acp:") => {
                send_acp_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, &s[4..])
            }
            other => Err(format!("harness '{other}' has no headless chat backend yet")),
        }
    }

    /// Cancel the in-flight turn by killing the process tree (claude has no
    /// graceful interrupt over stream-json input; per-turn CLIs are simply
    /// killed mid-run). Next send respawns. Matches the built-in chat's
    /// cancel semantics: the turn is discarded.
    ///
    /// The session entry is KEPT (only the process is killed and the turn
    /// flagged `cancelled`): the captured CLI session id must survive the
    /// cancel or the next turn would start a blank conversation. The
    /// `cancelled` flag tells the dying process's reader thread not to
    /// persist the partial reply or emit a second `chat:done`. State is
    /// dropped only when the chat itself is deleted (`remove_session`).
    pub fn cancel(&self, app: &AppHandle, chat_session_id: &str) -> Result<(), String> {
        // E-6: poison recovery like `send` — the panic that poisoned the lock
        // is exactly when children most need to be killed, so teardown must
        // not silently no-op behind `if let Ok(...)`.
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = sessions.get_mut(chat_session_id) {
            entry.cancelled.store(true, Ordering::SeqCst);
            // ACP: best-effort graceful cancel — notify the agent which
            // request is being cancelled, then kill the tree. The next send
            // respawns a fresh process + session (ACP has no --resume), so a
            // failed write here is irrelevant.
            if entry.harness.starts_with("acp:") {
                if let Ok(mut guard) = entry.stdin.lock() {
                    if let Some(stdin) = guard.as_mut() {
                        let rid = entry.acp_request_id.lock().ok().and_then(|g| *g);
                        if let Some(rid) = rid {
                            let line = crate::acp::encode_notification("request/cancel", &json!({ "requestId": rid }));
                            let _ = write_acp_line(stdin, &line);
                        }
                    }
                }
            }
            if let Some(mut child) = entry.child.take() {
                kill_child_tree(&mut child);
            }
            entry.turn_in_flight.store(false, Ordering::SeqCst);
            // B-6: a cancelled opencode turn's partial reply lives on in the
            // shared SSE buffer — it would otherwise be prefixed to the NEXT
            // turn's persisted message (and survive restarts). The turn
            // thread's cancelled branch clears the same cells; this is the
            // backstop for the case where that thread already died with the
            // server and never reached its branch.
            entry
                .oc_full
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            *entry.oc_in_think.lock().unwrap_or_else(|e| e.into_inner()) = false;
        }
        // A turn paused on a can_use_tool approval card must not outlive the
        // cancel: dropping the pendings resolves the oneshot to a deny, the
        // reader thread wakes and writes the deny control_response, and the
        // card clears via chat:approval-resolved.
        if let Some(state) = app.try_state::<crate::ChatState>() {
            state.0.drop_pending_for_session(chat_session_id);
        }
        emit_done(Some(app), chat_session_id, None, None, None);
        Ok(())
    }

    /// Best-effort LIVE application of a Claude Code permission-mode change to
    /// the session's running CLI process via the stdio control protocol
    /// (`set_permission_mode`). The deterministic path is the mode-label
    /// mismatch respawn in `send_claude_turn` — this only makes the change
    /// take effect immediately, including mid-turn. Returns false (no-op)
    /// when the session isn't a live gated claude_code process or the label
    /// isn't a harness-native mode; a process spawned with
    /// `--dangerously-skip-permissions` has no armed control protocol, so a
    /// "bypassPermissions" label can't be live-applied (the respawn covers it).
    pub fn apply_claude_permission_mode(&self, chat_session_id: &str, mode_label: &str) -> bool {
        const WIRE_MODES: [&str; 4] = ["default", "acceptEdits", "plan", "bypassPermissions"];
        if !WIRE_MODES.contains(&mode_label) {
            return false;
        }
        // Best-effort live-apply — NEVER wait on the global `sessions` mutex
        // here. This runs from sync commands on the MAIN thread; a send
        // holds `sessions` for its whole (potentially slow) setup, and a
        // blocking wait froze the entire window (audit B-8 class). Contended
        // → false: the deterministic mode-mismatch respawn in
        // `send_claude_turn` applies the change on the next send anyway.
        let Ok(sessions) = self.sessions.try_lock() else {
            return false;
        };
        let Some(entry) = sessions.get(chat_session_id) else {
            return false;
        };
        if entry.harness != "claude_code" || entry.child.is_none() {
            return false;
        }
        let Ok(mut guard) = entry.stdin.lock() else {
            return false;
        };
        let Some(stdin) = guard.as_mut() else {
            return false;
        };
        let request = json!({
            "request_id": format!("conduit-setmode-{}", now_ms_u64()),
            "type": "control_request",
            "request": { "subtype": "set_permission_mode", "mode": mode_label },
        })
        .to_string();
        stdin
            .write_all(request.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .is_ok()
    }

    /// Drop all state for a deleted chat: kill any running process tree and
    /// forget the in-memory CLI session id (the persisted app_settings keys
    /// are removed by the delete_chat_session command).
    pub fn remove_session(&self, chat_session_id: &str) {
        // E-6: poison recovery, same as send/cancel — the child tree must be
        // killed even (especially) after a panic poisoned the lock.
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut entry) = sessions.remove(chat_session_id) {
            entry.cancelled.store(true, Ordering::SeqCst);
            if let Some(mut child) = entry.child.take() {
                kill_child_tree(&mut child);
            }
        }
    }

    /// Same teardown as remove_session, plus dropping any pending approval
    /// cards for the session (deleting a chat mid-prompt must not leave a
    /// stuck card or a wedged reader thread).
    pub fn remove_session_with_app(&self, app: &AppHandle, chat_session_id: &str) {
        self.remove_session(chat_session_id);
        if let Some(state) = app.try_state::<crate::ChatState>() {
            state.0.drop_pending_for_session(chat_session_id);
        }
    }

    /// Kill all children (app shutdown).
    pub fn kill_all(&self) {
        // E-6: poison recovery, same as send/cancel — shutdown must kill
        // every child even when a panic poisoned the lock.
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut c) in sessions.drain() {
            if let Some(mut child) = c.child.take() {
                kill_child_tree(&mut child);
            }
        }
    }
}

/// Registry of one-shot (automation) children so the app-exit handler can
/// kill them (M13): `run_one_shot` spawns a full `--dangerously-skip-permissions`
/// CLI tree that is NOT in the session registry — without this it keeps
/// running after the app quits. Keyed by pid; entries are removed when the
/// child is reaped, and the kill path skips children that already exited, so
/// a recycled pid can never be hit. BTreeMap only because `BTreeMap::new` is
/// const (HashMap's RandomState isn't).
static ONE_SHOT_CHILDREN: Mutex<BTreeMap<u32, Arc<Mutex<Child>>>> =
    Mutex::new(BTreeMap::new());

fn register_one_shot_child(child: &Arc<Mutex<Child>>) -> Option<u32> {
    let pid = child.lock().ok()?.id();
    ONE_SHOT_CHILDREN.lock().ok()?.insert(pid, Arc::clone(child));
    Some(pid)
}

fn unregister_one_shot_child(pid: u32) {
    if let Ok(mut map) = ONE_SHOT_CHILDREN.lock() {
        map.remove(&pid);
    }
}

/// Kill every registered one-shot child (app shutdown). Idempotent; children
/// that already exited are skipped — their pid may have been recycled, and
/// `try_wait` is the only safe way to know the handle is still ours.
pub fn kill_one_shot_children() {
    let drained: Vec<Arc<Mutex<Child>>> = match ONE_SHOT_CHILDREN.lock() {
        Ok(mut map) => std::mem::take(&mut *map).into_values().collect(),
        Err(_) => return,
    };
    for child in drained {
        if let Ok(mut guard) = child.lock() {
            let already_exited = matches!(guard.try_wait(), Ok(Some(_)) | Err(_));
            if !already_exited {
                kill_child_tree(&mut guard);
            }
        }
    }
}

/// Kill a spawned harness process AND its whole process tree. On Windows
/// every spawn is wrapped in `cmd.exe /C` (harness_adapters::resolve_for_spawn),
/// so the `Child` handle is the shell: `Child::kill()` terminates only
/// cmd.exe while the real CLI (the node.exe grandchild) survives, keeps the
/// stdout pipe open, and the turn visibly keeps running after cancel.
/// Kill the process tree. On Windows `taskkill /T /F` is the primary kill;
/// `child.kill()` + `child.wait()` is the fallback that always reaps the
/// direct handle. The stdio pipes are dropped here too (stdin/stdout/stderr
/// live on `Child`), which unblocks the reader thread so it can observe the
/// `cancelled` flag and exit without emitting a spurious `chat:done`.
fn kill_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // Kill the entire process tree first so no grandchildren survive.
        let pid = child.id();
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", pid.to_string().as_str(), "/T", "/F"]);
        no_console_window(&mut cmd);
        // Best-effort — taskkill can fail if the tree already exited, but
        // the direct kill+wait below still reaps the handle either way.
        let _ = cmd.status();
    }
    // Kill the direct child (belt) and wait for it to be reaped (suspenders).
    // On non-Windows this is the only kill; on Windows it cleans up if
    // taskkill failed or the child was already a zombie.
    let _ = child.kill();
    let _ = child.wait();
    // Explicitly take stdin so the reader thread's BufReader::lines() loop
    // ends when the stdout pipe closes — without this a stale stdin
    // reference can keep the pipe alive on some platforms.
    drop(child.stdin.take());
}

/// RAII guard for a reader thread's liveness (B-4/B-5): drops
/// `reader_alive` to `false` on EVERY exit path from the reader — EOF, an
/// early `return` (mid-handshake failures), or a panic unwinding through
/// the thread body. `send_claude_turn`/`send_acp_turn` respawn when the
/// flag is down; scattering `.store(false)` at each return site would miss
/// the panic path and permanently wedge the chat.
struct ReaderAliveGuard(Arc<AtomicBool>);

impl Drop for ReaderAliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// E-5: a reader may only clear `turn_in_flight` while its process is still
/// the session's CURRENT generation. A respawned process runs with a new
/// generation, so an old reader's late EOF must leave the flag (it belongs
/// to a turn already streaming on the new process) alone.
fn should_clear_in_flight(current_generation: u64, reader_generation: u64) -> bool {
    current_generation == reader_generation
}

/// DB key for the per-chat, per-harness CLI session id (kimi `--session`,
/// opencode `-s`, claude `--resume`). Harness-qualified so switching harness
/// on the same chat never resumes the wrong CLI's conversation.
fn cli_session_key(harness: &str, sid: &str) -> String {
    format!("agent.cli_session_id.{harness}.{sid}")
}

/// Persist the captured CLI session id (if any) so conversation context
/// survives cancels and app restarts. Called by reader threads at end of
/// turn / process exit.
fn persist_cli_session_id(
    db: &DbState,
    harness: &str,
    sid: &str,
    cell: &Arc<Mutex<Option<String>>>,
) {
    let id = cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = id {
        let conn = db.0.lock();
        let _ = crate::db::set_setting(&conn, &cli_session_key(harness, sid), &id);
    }
}

// ---- Context primer (mid-chat engine handoff) ----
//
// A CLI harness keeps its own conversation memory across turns (claude
// `--resume`, kimi `--session`, opencode's server-side session). But a CLI
// that is starting a BRAND-NEW session — the chat's first harness turn, a
// harness switch (the teardown drops the previous engine's resume id, which
// would be meaningless to the new CLI anyway), or an ACP respawn (ACP has no
// resume at all) — knows nothing about what was said before. Without a
// handoff, switching engines mid-chat silently loses the whole conversation;
// the built-in cloud/local providers never had this problem because they
// rebuild history from the DB on every turn.
//
// The primer rebuilds that same DB history as a compact labeled transcript
// and is prepended to the FIRST prompt of the fresh CLI session only (gated
// on `cli_session_id == None`; turns 2+ ride the CLI's own context).

/// Total character budget for the primer transcript (~6k tokens — a compact
/// handoff, not a full replay; very long chats keep their newest turns).
const CONTEXT_PRIMER_MAX_CHARS: usize = 32_000;
/// Per-message cap so one giant artifact-dump reply can't eat the budget.
const CONTEXT_PRIMER_MESSAGE_CAP: usize = 6_000;
/// When the turns that DON'T fit the tail budget carry at least this many
/// chars, the send command pre-summarizes them with the shared cloud
/// summarizer (see `build_primer_summary`) instead of silently dropping
/// them — long engine-switched chats keep a digest of their older span.
const CONTEXT_PRIMER_SUMMARY_TRIGGER_CHARS: usize = 8_000;

/// The identity + artifact-behavior preamble prepended to every harness turn
/// (see the send path's comment for ordering). Extracted from the send path
/// so a test can pin its tool references: the persona must only name tools
/// that actually exist in harness sessions — the conduit-tools MCP whitelist
/// (generate_document/diagram/file, get_skill, list_skills, search_docs) and
/// the conduit-browser MCP family. It must NOT reference built-in-chat-only
/// tools like `open_file`, which the CLI cannot call (that phantom reference
/// used to make harness models promise to "open" files and then fail or
/// improvise).
fn harness_persona(harness_label: &str) -> String {
    format!(
        "You are Relay — the agent of the Relay desktop workspace, running on \
         the {harness_label} engine. To the user you ARE Relay: if asked who you \
         are, answer \"I'm Relay\" (the {harness_label} engine underneath may be \
         named as a detail), and never deny being Relay.\n\n\
         Files you create or modify are listed in the app's Artifacts gallery \
         after the turn, but do NOT open on screen. When the user should see a \
         finished result (an HTML page, a report, a diagram), name it in your \
         reply with its path so they can open it from the gallery — there is no \
         open-file tool in this session."
    )
}

/// DB fetch half of the primer. MUST run before this turn's user message is
/// persisted so the transcript is exactly "the conversation so far" — the new
/// message itself is forwarded verbatim in `content`. `summary` (built async
/// by the send command when the dropped head was large enough) rides on top
/// of the verbatim tail.
fn build_context_primer(
    db: &DbState,
    chat_session_id: &str,
    summary: Option<&str>,
) -> String {
    let records = {
        let conn = db.0.lock();
        // Same rows the built-in providers would re-send (compaction folds and
        // forked-away tails excluded), so the handoff matches what a built-in
        // turn would have seen.
        crate::db::list_active_chat_messages(&conn, chat_session_id).unwrap_or_default()
    };
    context_primer_from_records(&records, summary)
}

/// One rendered primer line (`[Who]: body`) from a record. Display-only
/// `<think>`/`<tool>` markup is stripped (tool JSON the new CLI never ran),
/// per-message capped, and role-labeled.
fn primer_line(r: &crate::types::ChatMessageRecord) -> Option<String> {
    let text = crate::chat::commands::strip_think_blocks(&r.content);
    if text.is_empty() {
        return None;
    }
    let who = match r.role.as_str() {
        "user" => "User",
        "assistant" => "Relay",
        _ => "System", // compaction summaries and other meta rows
    };
    let mut body: String = text.chars().take(CONTEXT_PRIMER_MESSAGE_CAP).collect();
    if text.chars().count() > CONTEXT_PRIMER_MESSAGE_CAP {
        body.push_str("…[truncated]");
    }
    Some(format!("[{who}]: {body}"))
}

/// Which records the newest-first tail budget keeps, and what's left over.
/// Returns the tail IN CHRONOLOGICAL ORDER plus (count, chars) of the head —
/// the older turns the tail budget dropped. Drives both the primer rendering
/// and the pre-send head summarization (`build_primer_summary`), so the two
/// always split the history at exactly the same point.
fn primer_tail_and_head(
    records: &[crate::types::ChatMessageRecord],
) -> (Vec<&crate::types::ChatMessageRecord>, usize, usize) {
    let mut tail_rev: Vec<&crate::types::ChatMessageRecord> = Vec::new();
    let mut used = 0usize;
    for r in records.iter().rev() {
        let cost = primer_line(r).map(|l| l.len() + 2).unwrap_or(0); // join overhead
        if cost == 0 {
            continue;
        }
        if !tail_rev.is_empty() && used + cost > CONTEXT_PRIMER_MAX_CHARS {
            break;
        }
        used += cost;
        tail_rev.push(r);
    }
    tail_rev.reverse();
    let tail_len = tail_rev.len();
    // Head = everything before the first tail record (records with no
    // rendered line are display-only and belong to neither side).
    let first_tail_id = tail_rev.first().map(|r| r.id);
    let head: Vec<&crate::types::ChatMessageRecord> = records
        .iter()
        .take_while(|r| Some(r.id) != first_tail_id)
        .collect();
    let head_chars: usize = head
        .iter()
        .filter_map(|r| primer_line(r))
        .map(|l| l.len() + 2)
        .sum();
    (tail_rev, head.len(), head_chars)
}

/// Pure transcript builder behind `build_context_primer`.
///
/// Newest-first accumulation within the char budget keeps the most recent
/// turns — the ones the next reply most depends on — when a long chat must be
/// truncated. `summary` (when present) carries a structured summary of the
/// turns that did NOT fit the budget, so a long chat loses nothing: summary
/// for the old span, verbatim transcript for the recent tail. Returns ""
/// when there is nothing to hand over (fresh chat, or history made up
/// entirely of display-only markup).
fn context_primer_from_records(
    records: &[crate::types::ChatMessageRecord],
    summary: Option<&str>,
) -> String {
    let (tail, _, _) = primer_tail_and_head(records);
    let lines: Vec<String> = tail.iter().filter_map(|r| primer_line(r)).collect();
    if lines.is_empty() && summary.is_none() {
        return String::new();
    }
    let mut out = String::from(
        "[Context handoff] The earlier part of this conversation ran on a different \
         engine. Continue the conversation naturally — the user's new message follows \
         after the separator.\n\n",
    );
    if let Some(s) = summary {
        out.push_str("[Summary of the earlier turns]\n");
        out.push_str(s);
        out.push_str("\n\n");
    }
    if !lines.is_empty() {
        if summary.is_some() {
            out.push_str("[Recent transcript, verbatim]\n");
        } else {
            out.push_str("The transcript below is everything said so far, oldest first.\n\n");
        }
        out.push_str(&lines.join("\n\n"));
    }
    out
}

/// Summarize the older turns that the primer's char budget would drop, using
/// the shared cloud summarizer (the first configured cloud provider —
/// `resolve_cloud_summarizer`). Called by `send_agent_chat_message` (async)
/// BEFORE the sync spawn path, so the network round-trip never blocks or
/// freezes the spawn flow; `send` just receives the finished summary.
///
/// Returns `None` when: the CLI session already exists (no primer needed),
/// the cloud-summarizer switch is off, the dropped head is under the trigger
/// size, no provider is configured, or the call fails — every case falls
/// back to the truncate-only primer, which is exactly the pre-upgrade
/// behavior.
pub(crate) async fn build_primer_summary(
    db: &DbState,
    chat_session_id: &str,
    harness: &str,
) -> Option<String> {
    // Same gate the send path uses for the primer itself: a CLI session that
    // will be resumed doesn't need a handoff at all.
    let existing_session = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, &cli_session_key(harness, chat_session_id))
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    };
    if existing_session.is_some() {
        return None;
    }
    // The summarized handoff rides the cloud-compaction switch: one knob
    // governs "may Relay spend cloud tokens on summarization".
    let enabled = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, "chat.cloud.compaction_enabled")
            .ok()
            .flatten()
            .map(|v| !matches!(v.trim(), "false" | "0" | "off"))
            .unwrap_or(true)
    };
    if !enabled {
        return None;
    }

    let records = {
        let conn = db.0.lock();
        crate::db::list_active_chat_messages(&conn, chat_session_id).unwrap_or_default()
    };
    let (_, head_count, head_chars) = primer_tail_and_head(&records);
    if head_count == 0 || head_chars < CONTEXT_PRIMER_SUMMARY_TRIGGER_CHARS {
        return None;
    }

    // Resolve the summarizer: the first configured cloud provider.
    let (provider_id, base, api_key, model) = {
        let conn = db.0.lock();
        crate::chat::commands::resolve_cloud_summarizer(&conn)?
    };

    // Render the head with the same primer lines the tail uses, then let the
    // shared summarizer condense it (per-message trimming included).
    let head_records: Vec<crate::types::ChatMessageRecord> = {
        let (tail, _, _) = primer_tail_and_head(&records);
        let first_tail_id = tail.first().map(|r| r.id);
        records
            .iter()
            .take_while(|r| Some(r.id) != first_tail_id)
            .cloned()
            .collect()
    };
    if head_records.is_empty() {
        return None;
    }
    let mut head_text = String::new();
    for r in &head_records {
        if let Some(line) = primer_line(r) {
            head_text.push_str(&line);
            head_text.push_str("\n\n");
        }
    }
    let head_entry = crate::chat::compaction::CompactionEntry {
        id: 0,
        message: crate::chat::providers::ChatMessage {
            role: "user".to_string(),
            content: head_text,
            images: Vec::new(),
        },
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default();
    let (summary, _, _) = crate::chat::cloud_compact::summarize_via_provider(
        &client,
        provider_id,
        &base,
        &api_key,
        &model,
        &std::iter::once(&head_entry).collect::<Vec<&crate::chat::compaction::CompactionEntry>>(),
        None,
    )
    .await
    .ok()?;
    eprintln!(
        "[context] harness primer: summarized {head_count} older turn(s) ({head_chars} chars) via {}/{model}",
        provider_id.as_str(),
    );
    Some(summary)
}


/// DB key for the model id the harness LAST actually ran (assistant
/// message.model / message info.modelID). Feeds the composer's context meter
/// so it shows the real model — a custom/remapped harness setup used to keep
/// showing the session's stale catalog alias (opus/sonnet).
pub(crate) fn actual_model_key(harness: &str, sid: &str) -> String {
    format!("agent.actual_model.{harness}.{sid}")
}

/// Persist the harness's actual turn model (best-effort — display only).
pub(crate) fn persist_actual_model(db: &DbState, harness: &str, sid: &str, model: &str) {
    let conn = db.0.lock();
    let _ = crate::db::set_setting(&conn, &actual_model_key(harness, sid), model);
}

// ---------------------------------------------------------------- attachments

/// Turn composer attachments into a prompt appendix for harness turns.
///
/// Unlike the built-in chat (which sends images as vision content parts over
/// HTTP), CLI harnesses receive plain text on stdin — so binary attachments
/// are materialized to disk under `<artifacts>/chat-attachments/<session>/`
/// and referenced by absolute path: the harness's own file-reading tools open
/// them natively, images included (claude/kimi/opencode Read all handle png/
/// jpg/pdf). The caller folds the extracted document text into the persisted
/// message itself (via `chat::commands::process_attachments`), so this
/// appendix stays tiny — just the paths — and never duplicates it.
///
/// Returns the appendix to append to the turn's prompt — empty when there is
/// nothing usable. Plain-text attachments need no disk round-trip (their
/// contents ride along in the message body like any other provider).
pub(crate) fn prepare_agent_attachments(
    app: &AppHandle,
    chat_session_id: &str,
    attachments: &[crate::types::ChatAttachmentInput],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for (idx, a) in attachments.iter().enumerate() {
        // Only binary kinds hit the disk; "text" is already inline upstream.
        if !matches!(a.kind.as_str(), "image" | "doc") {
            continue;
        }
        let Some(bytes) = a.data.as_deref().and_then(decode_attachment_b64) else {
            continue;
        };
        match write_agent_attachment_file(app, chat_session_id, &a.name, idx, millis, &bytes) {
            Some(path) => {
                let desc = match a.kind.as_str() {
                    "image" => format!(
                        "image ({}); view it with your file/image reading tool",
                        a.media_type.clone().unwrap_or_else(|| "image".into())
                    ),
                    _ => format!(
                        "original {} file — the message above carries its extracted text; \
                         read this copy directly for figures/layout or anything the \
                         extraction missed",
                        a.format.clone().unwrap_or_else(|| "document".into())
                    ),
                };
                lines.push(format!("- `{}` — {desc}", path.display()));
            }
            // Disk write failed — say so instead of silently dropping.
            None => lines.push(format!(
                "- {} — could not be saved to disk for this turn.",
                a.name
            )),
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    let _count = lines.len();
    format!(
        "\n\n---\n\n## Attached files\nThe user attached file(s) with this message:\n{}\nRead every attached file above before answering.",
        lines.join("\n")
    )
}

/// Base64-decode an attachment payload (no `data:` prefix), tolerating junk.
fn decode_attachment_b64(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

/// Sanitize an attachment filename for safe use inside the attachments dir:
/// separators and control/odd characters become `_`, hidden-dot stems are
/// flattened, length is capped with the extension preserved. A name made of
/// nothing safe collapses to `file`.
fn sanitize_attachment_name(name: &str) -> String {
    const MAX_STEM: usize = 60;
    let stem_ext = name.rsplit_once('.');
    let sanitize_part =
        |s: &str| -> String {
            let mapped: String = s
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || matches!(c, '-' | '_') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            // Collapse runs of separators so "my report (final)" reads
            // my_report_final instead of my_report__final_.
            let mut collapsed = String::with_capacity(mapped.len());
            for c in mapped.chars() {
                if c == '_' && collapsed.ends_with('_') {
                    continue;
                }
                collapsed.push(c);
            }
            collapsed.trim_matches('_').to_string()
        };
    let (stem, ext) = match stem_ext {
        Some((stem, ext)) => (sanitize_part(stem), Some(sanitize_part(ext))),
        None => (sanitize_part(name), None),
    };
    let mut stem = stem.trim_matches('.').to_string();
    if stem.is_empty() {
        stem = "file".into();
    }
    if stem.chars().count() > MAX_STEM {
        stem = stem.chars().take(MAX_STEM).collect();
    }
    match ext.filter(|e| !e.is_empty()) {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

/// Write one attachment's bytes under
/// `<artifacts>/chat-attachments/<session>/<millis>_<idx>_<name>` — unique
/// per file within a turn (idx) and across turns (millis), so re-sending the
/// same filename never clobbers an earlier copy the CLI may still reference.
/// Returns the absolute path on success.
fn write_agent_attachment_file(
    app: &AppHandle,
    chat_session_id: &str,
    name: &str,
    idx: usize,
    millis: u128,
    bytes: &[u8],
) -> Option<std::path::PathBuf> {
    let dir = crate::chat::dispatch::artifacts_dir(app)
        .join("chat-attachments")
        .join(sanitize_attachment_name(chat_session_id));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{millis}_{idx:02}_{}", sanitize_attachment_name(name)));
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

// ---------------------------------------------------------------- claude_code

/// Persistent-process path: spawn on first use (or on model change), then
/// write the turn as a stream-json stdin line.
fn send_claude_turn(
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
    // B-5: a CLI that died between turns leaves `child` Some holding a dead
    // pipe — its reader's RAII guard dropped `reader_alive`, so respawn on
    // that too instead of failing every later send with a broken-pipe error
    // (same intent as the opencode path's opencode_server_alive probe).
    if entry.child.is_none()
        || !entry.reader_alive.load(Ordering::SeqCst)
        || entry.spawned_model.as_deref() != Some(entry.model.as_str())
        || entry.spawned_mode.as_deref() != Some(current_mode.as_str())
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
        let (child, spawned_mode) = spawn_claude(
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
fn claude_model_alias(model: &str) -> String {
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
fn write_acp_line(stdin: &mut std::process::ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

/// Write one ACP message through the shared stdin cell (used by reader
/// threads, which don't own the stdin guard directly).
fn write_line_shared(
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
fn send_acp_turn(
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
        // Conduit-owned bundle is not part of ACP v1 (no MCP servers, no
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
        let stdout = child
            .stdout
            .take()
            .ok_or("failed to capture ACP stdout")?;
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
fn read_acp_stream(
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
    let _perf = crate::chat::turn_perf::register(sid, crate::chat::turn_perf::TurnPerf::new_headless(sid));
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
                        emit_error(
                            app,
                            sid,
                            &format!("ACP request failed: {msg}"),
                        );
                        full.clear();
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
                        emit_error(
                            app,
                            sid,
                            "ACP agent returned no sessionId for session/new",
                        );
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
                                let marker = format!("<tool>{}</tool>", tool_meta_generic(&name, &input));
                                full.push_str(&marker);
                                emit_token(app, sid, &marker);
                                // v1 does not execute ACP tools — answer with
                                // an error result so the agent doesn't wait
                                // forever on a result that never comes.
                                reply_acp_tool_error(&shared_stdin, session_cell, &id);
                            }
                            AcpEvent::Finished
                            | AcpEvent::Failed(_)
                            | AcpEvent::PromptIgnored => {}
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
                    } else {
                        finish_turn(app, db, sid, &mut full, None, None, None, &mut watches, started, None);
                    }
                    if should_clear_in_flight(
                        proc_generation.load(Ordering::SeqCst),
                        my_generation,
                    ) {
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
                    if let AcpEvent::Failed(m) = crate::acp::events::translate_session_error(&params) {
                        emit_error(app, sid, &m);
                    }
                    full.clear();
                    if should_clear_in_flight(
                        proc_generation.load(Ordering::SeqCst),
                        my_generation,
                    ) {
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
                    "error": { "code": -32601, "message": "Method not supported by Conduit ACP v1" },
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
}

/// Answer an ACP tool call with an error tool_result (v1 doesn't execute
/// tools). The reader sends a fresh session/request carrying the result;
/// the agent continues the same turn.
fn reply_acp_tool_error(
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

/// Working directory for agent spawns. With no project selected the CLI
/// would otherwise inherit the app's own cwd — under `tauri dev` that's the
/// repo root, so generated files land in the app folder and the CLI's
/// sandbox then refuses paths outside it. Fall back to the configured
/// artifacts dir (`storage.artifactsDir`) when set, else Documents/Conduit
/// (the same default the built-in chat uses) instead.
fn spawn_dir(
    cwd: Option<&str>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Option<std::path::PathBuf> {
    let dir = cwd.map(std::path::PathBuf::from).or_else(|| {
        let configured = {
            let conn = db.lock();
            crate::chat::dispatch::configured_artifacts_dir(&conn)
        };
        configured.or_else(|| {
            dirs::document_dir()
                .or_else(dirs::home_dir)
                .map(|base| base.join("Conduit"))
        })
    });
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
    }
    dir
}

/// Directories a harness turn's artifact diff must watch: the spawn dir
/// (files the CLI writes into its workspace) PLUS the artifacts dir
/// (files the conduit-tools MCP writes — mcp_tools_bridge always resolves
/// `dispatch::artifacts_dir`, which differs from the spawn dir whenever a
/// project is selected or the user configured a custom `storage.artifactsDir`).
/// Watching only the spawn dir silently drops every MCP-generated docx/pptx/
/// pdf: no artifact row, no `chat:artifact` event, no canvas auto-open.
/// Deduped (canonicalized); spawn dir first.
fn turn_watch_dirs(
    cwd: Option<&str>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = spawn_dir(cwd, db) {
        dirs.push(d);
    }
    // Mirror dispatch::artifacts_dir's default without needing an AppHandle:
    // configured dir, else <Documents>/Conduit (falling back to home).
    let artifacts = {
        let conn = db.lock();
        crate::chat::dispatch::configured_artifacts_dir(&conn)
    }
    .or_else(|| {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .map(|base| base.join("Conduit"))
    });
    if let Some(a) = artifacts {
        let _ = std::fs::create_dir_all(&a);
        let canon = |p: &PathBuf| std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        let a_canon = canon(&a);
        if !dirs.iter().any(|d| canon(d) == a_canon) {
            dirs.push(a);
        }
    }
    dirs
}

/// A harness turn's spawn directory plus its pre-turn snapshot, moved into
/// the reader thread. `finish_turn` diffs the directory against the snapshot
/// to surface files the CLI created or modified as artifacts (the built-in
/// chat gets the same via tool outcomes in chat/dispatch.rs).
///
/// PERF (PERFORMANCE_AUDIT.md B6): a `notify` watcher records which paths
/// were touched DURING the turn, so `changed()` stats only those paths
/// instead of re-walking the whole tree (depth 4, up to 2000 stats) after
/// every turn. Falls back to the full walk when the watcher couldn't be
/// created (dir missing) or reported an error/overflow.
struct DirWatch {
    dir: PathBuf,
    before: HashMap<String, (SystemTime, u64)>,
    /// Touched relative paths ('/'-normalized) since the last `changed()`.
    /// `None` = poisoned (watcher failed/overflowed) → full-walk fallback.
    touched: Arc<Mutex<Option<std::collections::HashSet<String>>>>,
    /// Kept alive for the watch's lifetime; dropping stops notifications.
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Depth/filter rules shared by `snapshot_dir` and the watcher callback so
/// both modes see the same file set.
fn watch_path_allowed(rel: &str) -> bool {
    // Depth ≤ 4, no hidden dirs, no node_modules/target (same filter as
    // snapshot_dir's filter_entry).
    let mut depth = 0usize;
    for seg in rel.split('/') {
        depth += 1;
        if seg.starts_with('.') || seg == "node_modules" || seg == "target" {
            return false;
        }
    }
    // rel includes the file itself; snapshot_dir's max_depth(4) counts the
    // root as 0, so a file at walker depth 4 has 4 segments.
    depth <= 4
}

impl DirWatch {
    fn new(dir: PathBuf) -> Self {
        use notify::{RecursiveMode, Watcher};
        let before = snapshot_dir(&dir);
        let touched: Arc<Mutex<Option<std::collections::HashSet<String>>>> =
            Arc::new(Mutex::new(Some(std::collections::HashSet::new())));
        let dir_for_cb = dir.clone();
        let touched_for_cb = Arc::clone(&touched);
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let mut guard = touched_for_cb.lock().unwrap();
            match res {
                Ok(event) => {
                    let Some(set) = guard.as_mut() else { return };
                    for path in &event.paths {
                        let rel = path
                            .strip_prefix(&dir_for_cb)
                            .unwrap_or_else(|_| path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        if watch_path_allowed(&rel) {
                            set.insert(rel);
                        }
                    }
                    // Pathological churn (or a flood of events): give up on
                    // incremental mode for this turn rather than ballooning.
                    if set.len() > 4000 {
                        *guard = None;
                    }
                }
                // Overflow / backend error: poison → finish_turn full-walks.
                Err(_) => *guard = None,
            }
        })
        .ok()
        .and_then(|mut w| {
            w.watch(&dir, RecursiveMode::Recursive).ok()?;
            Some(w)
        });
        if watcher.is_none() {
            // No watcher (dir doesn't exist yet, backend init failed):
            // poisoned from the start → every turn full-walks, exactly the
            // pre-B6 behavior.
            *touched.lock().unwrap() = None;
        }
        Self { dir, before, touched, _watcher: watcher }
    }

    /// Files created/modified since the last call; refreshes the baseline.
    /// Watcher-healthy: stats only the touched paths. Otherwise: full walk.
    fn changed(&mut self) -> Vec<String> {
        let touched = {
            let mut guard = self.touched.lock().unwrap();
            let t = guard.take();
            // Rearm for the next turn when the watcher is still alive.
            *guard = if self._watcher.is_some() {
                Some(std::collections::HashSet::new())
            } else {
                None
            };
            t
        };
        match touched {
            Some(paths) if !paths.is_empty() => {
                let mut changed = Vec::new();
                for rel in paths {
                    let full = self.dir.join(&rel);
                    match std::fs::metadata(&full) {
                        Ok(md) if md.is_file() => {
                            let cur = (md.modified().unwrap_or(SystemTime::UNIX_EPOCH), md.len());
                            match self.before.get(&rel) {
                                Some(&prev) if prev == cur => {} // touched but unchanged
                                _ => {
                                    self.before.insert(rel.clone(), cur);
                                    changed.push(rel);
                                }
                            }
                        }
                        // Deleted or not a file: drop from the baseline.
                        _ => {
                            self.before.remove(&rel);
                        }
                    }
                }
                // Same previewable-extension filter the full-walk path
                // applies via changed_previewable_files.
                let mut filtered: Vec<String> =
                    changed.into_iter().filter(|rel| previewable_ext(rel)).collect();
                filtered.sort();
                filtered
            }
            Some(_) => Vec::new(), // watcher healthy, nothing touched
            None => {
                let after = snapshot_dir(&self.dir);
                let changed = changed_previewable_files(&self.before, &after);
                self.before = after;
                changed
            }
        }
    }
}

/// Relative path → (mtime, len) for every file under `dir`: depth ≤ 4, hidden
/// dirs / .git / node_modules / target skipped, ~2000 entries max. Taken
/// before a harness turn and diffed after it (see changed_previewable_files).
fn snapshot_dir(dir: &Path) -> HashMap<String, (SystemTime, u64)> {
    const MAX_ENTRIES: usize = 2000;
    let mut out = HashMap::new();
    let walker = walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 || !e.file_type().is_dir() {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        });
    for entry in walker.flatten() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(md) = entry.metadata() {
            let rel = entry
                .path()
                .strip_prefix(dir)
                .unwrap_or_else(|_| entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(rel, (md.modified().unwrap_or(SystemTime::UNIX_EPOCH), md.len()));
        }
    }
    out
}

/// Files that are NEW or MODIFIED (mtime or length changed) between the two
/// snapshots AND whose extension the artifact preview supports — the same
/// classification read_artifact_preview uses (text/code, image, pdf, office).
fn changed_previewable_files(
    before: &HashMap<String, (SystemTime, u64)>,
    after: &HashMap<String, (SystemTime, u64)>,
) -> Vec<String> {
    let mut out: Vec<String> = after
        .iter()
        .filter(|(rel, meta)| match before.get(rel.as_str()) {
            Some(prev) => prev != *meta,
            None => true,
        })
        .filter(|(rel, _)| previewable_ext(rel))
        .map(|(rel, _)| rel.clone())
        .collect();
    out.sort();
    out
}

/// Extension allow-list mirrored from read_artifact_preview's classification
/// (chat/commands.rs): text/code kinds, images, pdf, and Office documents.
fn previewable_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "markdown" | "csv" | "json" | "html" | "htm" | "txt" | "log" | "text"
            | "js" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h"
            | "hpp" | "sh" | "bash" | "yaml" | "yml" | "toml" | "xml" | "sql" | "rb" | "php"
            | "css"
            | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
            | "pdf"
            | "docx" | "pptx" | "xlsx"
    )
}

/// Same as pty_cmds' browser-only `.mcp.json`, but OpenCode-format: opencode
/// has no `--mcp-config` flag — it reads MCP servers from an opencode.json
/// "mcp" section, pointed at via the OPENCODE_CONFIG env var on the spawn.
/// Legacy fallback for per-turn spawns when the full bundle failed to write.
fn resolve_opencode_config(app: &AppHandle, project_id: Option<&str>) -> Option<std::path::PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    browser_mcp_register::write_opencode_config(&data_dir, project_id?, bound_port())
}

/// The artifacts dir the bundle should advertise: the spawn dir when set
/// (it IS the CLI's workspace), else the configured artifacts dir, else the
/// Documents/Conduit default — mirroring `spawn_dir`.
pub(crate) fn artifacts_dir_for_bundle(app: &AppHandle, cwd: Option<&str>) -> String {
    if let Some(c) = cwd { return c.to_string(); }
    crate::chat::dispatch::artifacts_dir(app).to_string_lossy().into_owned()
}

/// Bundle slug for sessions with no selected project. Connectors and
/// conduit-tools work project-less too, so a bundle is always written; the
/// tradeoff is that browser panes and artifacts of ALL project-less sessions
/// share this one scope.
const NO_PROJECT_BUNDLE_SLUG: &str = "_no_project";

/// Resolve (write if needed) the per-project harness bundle. Project-less
/// sessions fall back to the `_no_project` slug so connectors + conduit-tools
/// still reach the CLI. Returns None only when the app data dir or the write
/// fails — bundle failure must never fail the turn (same contract as the old
/// resolve_mcp_config). `connectors` are merged into the bundle's MCP configs
/// as remote servers (tokens already refreshed by the command layer).
/// Shared by the headless chat paths here and the interactive PTY spawn in
/// `commands::pty_cmds`.
pub(crate) fn resolve_harness_bundle(
    app: &AppHandle,
    project_id: Option<&str>,
    cwd: Option<&str>,
    artifacts_dir: String,
    connectors: &[crate::connectors::HarnessMcpServer],
    sandbox: Option<&str>,
    approval: Option<&str>,
) -> Option<crate::harness_bundle::HarnessBundlePaths> {
    let data_dir = app.path().app_data_dir().ok()?;
    crate::harness_bundle::write_bundle(
        &data_dir, project_id.unwrap_or(NO_PROJECT_BUNDLE_SLUG), cwd, Some(artifacts_dir.as_str()), sandbox, approval, crate::browser_mcp::bound_port(), connectors)
}

fn spawn_claude(
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
) -> Result<(Child, String), String> {
    let alias = claude_model_alias(model);
    // Per-session dual permission policies. full_access approval keeps the
    // historical bypass-everything spawn; every other posture routes the CLI's
    // permission prompts to the reader thread over the stdio control protocol
    // (`--permission-prompt-tool stdio` — Claude Code 2.x), where they become
    // the same chat:approval-request cards the built-in chat uses.
    let (sandbox_str, approval_str, harness_mode) = {
        let conn = db.0.lock();
        crate::db::get_chat_session(&conn, sid)
            .ok()
            .flatten()
            .map(|cs| (cs.sandbox_policy, cs.approval_policy, cs.permission_mode))
            .unwrap_or_else(|| {
                (
                    "workspace_write".to_string(),
                    "on_request".to_string(),
                    "manual".to_string(),
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
    let gated = approval_str != "full_access" && claude_mode.as_deref() != Some("bypassPermissions");
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
    // Respawning (after a cancel, model change, or app restart) would
    // start a blank conversation — resume the captured CLI session instead.
    let resume = session_cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = &resume {
        args.push("--resume".into());
        args.push(id.clone());
    }
    // Conduit-owned bundle: instructions, permissions, and both MCP servers
    // (browser + tools). Registration failure degrades to no extra flags —
    // the turn still runs, just without conduit's prompt/tools.
    if let Some(bundle) = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd), connectors, Some(&sandbox_str), Some(&approval_str)) {
        args.extend(crate::harness_bundle::claude_bundle_args(&bundle, &artifacts_dir_for_bundle(app, cwd)));
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
    // different) is the artifacts dir conduit-tools MCP writes into.
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
                    "request_id": "conduit-init-1",
                    "type": "control_request",
                    "request": { "subtype": "initialize" },
                })
                .to_string();
                let _ = stdin
                    .write_all(init.as_bytes())
                    .and_then(|_| stdin.write_all(b"
"))
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
    // on the entry so a later label change can respawn (or live-apply).
    Ok((child, harness_mode))
}

/// The chat session's persisted permission-mode label (the harness mode menu
/// writes it verbatim — claude "plan"/"acceptEdits"/…, opencode "plan"/…).
/// Empty when the row is missing.
fn chat_permission_mode_label(db: &DbState, sid: &str) -> String {
    let conn = db.0.lock();
    crate::db::get_chat_session(&conn, sid)
        .ok()
        .flatten()
        .map(|cs| cs.permission_mode)
        .unwrap_or_default()
}

/// Build the control_response the CLI expects on stdin after a can_use_tool
/// prompt. Allow echoes the original input back as `updatedInput` (required
/// since Claude Code v2.1.207 — omitting it is a validation error); deny
/// carries the message the model sees as the tool result.
fn can_use_tool_response(request_id: &str, approved: bool, input: &Value) -> Value {
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
fn handle_can_use_tool(
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
    let summary = crate::chat::dispatch::harness_tool_summary(&tool, &input);

    // Resolve the shared approval registry. `try_state` (not `state`): the
    // reader thread also runs in unit tests / relay contexts where the app
    // state may not be registered — a miss must deny, not panic.
    let mgr = app.and_then(|a| a.try_state::<crate::ChatState>()).map(|s| Arc::clone(&s.0));

    let (approved, pending_id) = if let (Some(app), Some(mgr)) = (app, mgr) {
        let (pending_id, rx) = mgr.register_pending_approval(sid, &tool, input.clone(), summary.clone());
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
                .and_then(|_| stdin.write_all(b"
"))
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
fn handle_ask_user_question(
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
fn ask_user_allow_response(
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
fn ask_user_skip_response(request_id: &str) -> Value {
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
fn unstreamed_suffix<'a>(streamed: &str, final_text: &'a str) -> Option<&'a str> {
    if final_text.len() > streamed.len() && final_text.starts_with(streamed) {
        Some(&final_text[streamed.len()..])
    } else {
        None
    }
}

/// Reader loop for the persistent claude process: one JSON event per line.
#[allow(clippy::too_many_arguments)]
fn read_claude_stream(
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
    // Register a per-turn perf accumulator so `emit_token` can drive live
    // TTFT / tok/s in the composer row. Cleared in `finish_turn`. The split
    // between LLM and tool time isn't available for the harness CLI (it's a
    // black-box mixed stream), so those stay — like legacy rows.
    let _perf = crate::chat::turn_perf::register(sid, crate::chat::turn_perf::TurnPerf::new_headless(sid));
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
                let delta = v.pointer("/event/delta");
                match delta
                    .and_then(|d| d.get("type"))
                    .and_then(|t| t.as_str())
                {
                    Some("text_delta") => {
                        if let Some(text) = delta
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
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
                                let marker = tools.subagent_use(
                                    &name,
                                    values.into_iter().next().unwrap_or(json!({})),
                                    app,
                                    sid,
                                    &role,
                                    &task,
                                    &prompt,
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
            Some("user") => {
                if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    for r in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                    {
                        let is_error = r
                            .get("is_error")
                            .and_then(|e| e.as_bool())
                            .unwrap_or(false);
                        let text = extract_result_text(r.get("content"));
                        if let Some(marker) = tools.tool_result(&text, is_error, app, sid) {
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
                    let input = usage.and_then(|u| u.get("input_tokens")).and_then(|t| t.as_i64());
                    let output = usage.and_then(|u| u.get("output_tokens")).and_then(|t| t.as_i64());
                    let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
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
                    finish_turn(app, db, sid, &mut full, input, output, cost, &mut watches, turn_started, actual_model.as_deref());
                } else {
                    let msg = v
                        .get("error")
                        .and_then(|e| e.as_str())
                        .or_else(|| v.get("result").and_then(|r| r.as_str()))
                        .unwrap_or("Claude Code turn failed")
                        .to_string();
                    full.clear();
                    emit_error(app, sid, &msg);
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

// ------------------------------------------------------ per-turn CLIs (kimi/opencode)

/// Which per-turn CLI a spawn targets. OpenCode normally runs as the
/// persistent server (see send_opencode_turn); `PerTurn::OpenCode` survives
/// only as the degraded fallback when `opencode serve` cannot be started.
enum PerTurn {
    Kimi,
    OpenCode,
}

/// Spawn a fresh one-shot process for a single turn, resuming the CLI's own
/// session when we have its id from a previous turn.
fn spawn_per_turn(
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
    // Conduit-owned bundle: instructions, permissions, and MCP registration.
    // Failure degrades to the legacy browser-only configs below (or none).
    // The bundle hardcodes bypassPermissions in settings.json so claude
    // runs with full-auto approval.
    // Kimi/OpenCode headless have no approval channel — the bundle keeps its
    // default (unrestricted) permissions regardless of the session's mode.
    let bundle = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd), connectors, None, None);
    // Legacy fallback: browser-only MCP when the bundle (or its mcp part)
    // didn't write — keeps pty-style browser tools working in degraded mode.
    let opencode_legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };
    let mut prompt_env: Option<(String, String)> = None;
    let spec = match kind {
        PerTurn::Kimi => {
            // The untrusted prompt never rides the command line — it goes via
            // CONDUIT_TURN_PROMPT + a delayed-expansion wrapper batch on
            // Windows (M12, see harness_adapters::turn_spec). Only OUR
            // bounded strings (model, session id, bundle paths) are argv.
            // Kimi prompt mode is non-interactive; --yolo/--auto are
            // interactive-mode flags that kimi rejects with -p.
            // Tool calls are auto-approved by default in prompt mode.
            let mut flags: Vec<String> = vec![
                "--output-format".into(),
                "stream-json".into(),
            ];
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
                    b, &artifacts_dir_for_bundle(app, cwd), resume.is_some()));
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
            let (spec, env) =
                crate::harness_adapters::turn_spec(crate::harness_adapters::TurnHarness::Kimi, &turn_content, flags);
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
                flags.push("-m".into());
                flags.push(entry.model.clone());
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
            let (spec, env) =
                crate::harness_adapters::turn_spec(crate::harness_adapters::TurnHarness::OpenCode, content, flags);
            prompt_env = env;
            spec
        }
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The prompt travels in the process env block (never cmd-parsed) when the
    // Windows wrapper transport is active — see turn_spec.
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
    // OpenCode only: point the CLI at the Conduit-owned opencode.json that
    // registers conduit-browser (it has no --mcp-config CLI flag).
    if matches!(kind, PerTurn::OpenCode) {
        // Bundle's opencode.json already has both MCP servers + permissions;
        // the legacy path only applies when the bundle failed to write.
        if let Some(cfg) = bundle.as_ref().map(|b| b.opencode_config.clone())
            .filter(|p| p.exists())
            .or(opencode_legacy_cfg.clone()) {
            cmd.env("OPENCODE_CONFIG", cfg);
        }
    }
    // Snapshot the watch dirs once for this turn so finish_turn can diff them
    // afterwards and surface files the CLI created as artifacts (spawn dir +
    // the artifacts dir conduit-tools MCP writes into, when different).
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {} CLI: {e}", spec.program))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture CLI stdout")?;
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    entry.child = Some(child);

    // Emit a "starting" status so the UI shows immediate activity. Kimi only:
    // OpenCode runs as the persistent server (no per-turn notice), and its
    // degraded fallback shares this spawn path — a flash there read as noise.
    // Cleared by the first real `chat:token` event (frontend onToken clears
    // chatStatus for the session) or by `chat:done`/`chat:error`.
    if matches!(kind, PerTurn::Kimi) {
        let _ = app.emit(
            "chat:status",
            json!({ "chatSessionId": sid, "reason": "harness_starting", "message": "Kimi is starting up…" }),
        );
    }

    // Fresh per-turn cancel flag: a reader thread from a cancelled turn must
    // keep seeing `true` even after the next send replaces the entry's flag.
    let cancelled = Arc::new(AtomicBool::new(false));
    entry.cancelled = Arc::clone(&cancelled);

    let app2 = app.clone();
    let db2 = DbState(Arc::clone(&db.0));
    let sid2 = sid.to_string();
    let in_flight2 = Arc::clone(&entry.turn_in_flight);
    let session_cell = Arc::clone(&entry.cli_session_id);
    let is_kimi = matches!(kind, PerTurn::Kimi);
    std::thread::spawn(move || {
        read_per_turn_stream(
            Some(&app2),
            &db2,
            &sid2,
            stdout,
            &in_flight2,
            &session_cell,
            is_kimi,
            &cancelled,
            watches,
        );
    });
    Ok(())
}

/// Reader loop for one-shot processes: parse events, then close the turn at
/// EOF (process exit). Usage is taken from the stream when the CLI reports
/// it; otherwise done carries nulls.
fn read_per_turn_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &AtomicBool,
    session_cell: &Arc<Mutex<Option<String>>>,
    is_kimi: bool,
    cancelled: &AtomicBool,
    mut watches: Vec<DirWatch>,
) {
    let mut full = String::new();
    // Capture the turn's start instant for the "Worked for Xs" label.
    let started_at = crate::db::now_ts();
    // OpenCode buffers deltas internally in `run` mode: each "text" event
    // carries the FULL snapshot of its part so far, not a delta. Track the
    // last snapshots so only the new suffix is emitted/persisted.
    let mut last_text = String::new();
    let mut last_reasoning = String::new();
    let mut in_think = false;
    let mut input: Option<i64> = None;
    let mut output: Option<i64> = None;
    let mut cost: Option<f64> = None;
    let mut tools = ToolTracker::new();
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
        if is_kimi {
            handle_kimi_event(app, sid, &v, &mut full, session_cell, &mut input, &mut output, &mut tools);
        } else {
            handle_opencode_event(app, sid, &v, &mut full, session_cell, &mut input, &mut output, &mut cost, &mut last_text, &mut last_reasoning, &mut in_think, &mut tools);
        }
    }
    // Process exit closes the turn. Persist any captured CLI session id so
    // the next turn (even after cancel or an app restart) resumes the same
    // conversation. If the turn was cancelled, discard the partial reply —
    // cancel() already emitted `chat:done`.
    persist_cli_session_id(db, if is_kimi { "kimi_code" } else { "opencode" }, sid, session_cell);
    in_flight.store(false, Ordering::SeqCst);
    if cancelled.load(Ordering::SeqCst) {
        full.clear();
    } else {
        // kimi/opencode fallback streams don't expose a model id on their
        // events — the cost rollup falls back to the session's model.
        finish_turn(app, db, sid, &mut full, input, output, cost, &mut watches, started_at, None);
    }
}

// ------------------------------------------------- persistent OpenCode server

/// Send one user turn to this chat's persistent `opencode serve` process.
///
/// Unlike the per-turn `opencode run` spawn — which paid a CLI cold start on
/// EVERY message (the "OpenCode is starting up…" notice each time) — the
/// server boots once per chat and stays up: turns POST to its HTTP API while
/// a long-lived SSE subscription streams text/reasoning/tool parts live.
/// Warm turns start streaming immediately, matching claude_code's UX. The
/// opencode session id lives server-side, so context survives respawns
/// (cancel, model change, app restart) exactly like the old `-s <id>` resume.
fn send_opencode_turn(
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
        ) {
            Ok((child, base_url)) => {
                entry.child = Some(child);
                entry.oc_base_url = Some(base_url);
            }
            Err(e) => {
                // Degraded mode: legacy one-shot `opencode run` per turn.
                eprintln!("[agent] opencode server unavailable ({e}); falling back to per-turn run");
                fell_back = true;
            }
        }
    }
    if fell_back {
        return spawn_per_turn(app, db, sid, content, entry, cwd, project_id, PerTurn::OpenCode, connectors);
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
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    let started_at = crate::db::now_ts();
    std::thread::spawn(move || {
        // Live TTFT / tok/s for this turn; finish_turn unregisters, the
        // guard's drop is the backstop.
        let _perf =
            crate::chat::turn_perf::register(&sid2, crate::chat::turn_perf::TurnPerf::new_headless(&sid2));
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
                    in_flight2.store(false, Ordering::SeqCst);
                    emit_error(Some(&app2), &sid2, &format!("OpenCode session create failed: {e}"));
                    return;
                }
            },
        };

        match opencode_post_message(&base2, &oc_sid2, model_body, agent_body, &content2) {
            Ok((input, output, cost, actual)) => {
                // The POST resolves when the turn completes but can race its
                // last SSE flush — wait for a reader-quiet gap so the final
                // text snapshot is inside `full` before persisting.
                wait_for_reader_quiet(&quiet_cell, Duration::from_millis(2500));
                close_opencode_think(Some(&app2), &sid2, &think_cell, &full_cell);
                if let Some(m) = actual.as_deref() {
                    persist_actual_model(&db2, "opencode", &sid2, m);
                }
                let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
                finish_turn(
                    Some(&app2),
                    &db2,
                    &sid2,
                    &mut full,
                    input,
                    output,
                    cost,
                    &mut watches,
                    started_at,
                    actual.as_deref(),
                );
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
        in_flight2.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Force-close a dangling `<think>` block left open by an interrupted
/// reasoning stream so it can't render open forever (mirrors read_claude_stream).
fn close_opencode_think(
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
fn spawn_opencode_server(
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
) -> Result<(Child, String), String> {
    let port = opencode_free_port().ok_or("no free TCP port for opencode server")?;
    let base_url = format!("http://127.0.0.1:{port}");

    // Same MCP registration contract as every other opencode spawn: point
    // OPENCODE_CONFIG at the Conduit-owned bundle config (browser + tools +
    // connectors). Failure degrades to the legacy browser-only config.
    let bundle = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd), connectors, None, None);
    let legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };

    let mut cmd = Command::new("opencode");
    cmd.args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()])
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
        })
        .map_err(|e| format!("failed to spawn opencode SSE reader: {e}"))?;

    Ok((child, base_url))
}

/// Cheap liveness probe: is anything accepting TCP on the server's port?
fn opencode_server_alive(base_url: &str) -> bool {
    match base_url.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
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
fn opencode_free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|a| a.port())
}

/// Poll the server's TCP listener until it accepts (or the budget runs out),
/// then give the HTTP router a short grace period. Pure socket probe — no
/// tokio, safe to call from the async-command thread.
fn opencode_wait_ready(base_url: &str, budget: Duration) -> bool {
    let Some(port) = base_url.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
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
fn opencode_create_session(base_url: &str) -> Result<String, String> {
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
            return Err(format!("session create HTTP {status}: {}", truncate_output(&body)));
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| format!("session parse: {e}"))?;
        v.get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "session create returned no id".to_string())
    })
}

/// Split Conduit's "provider/model" id into OpenCode's message-body shape.
/// Empty/unparseable models stay None → server uses its configured default.
fn split_opencode_model(model: &str) -> Option<Value> {
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
fn opencode_post_message(
    base_url: &str,
    oc_sid: &str,
    model: Option<Value>,
    agent: Option<&str>,
    content: &str,
) -> Result<(Option<i64>, Option<i64>, Option<f64>, Option<String>), String> {
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
        let cost = info.get("cost").and_then(|c| c.as_f64());
        // The model that ACTUALLY served the turn (opencode routes through
        // whatever its config says — the session's stored id can be a stale
        // catalog entry). modelID + providerID recombine into the canonical
        // "provider/model" shape the cost rollup and meter match on.
        let model = info
            .get("modelID")
            .and_then(|m| m.as_str())
            .map(|m| {
                let provider = info.get("providerID").and_then(|p| p.as_str());
                match provider {
                    Some(p) if !p.is_empty() => format!("{p}/{m}"),
                    _ => m.to_string(),
                }
            });
        Ok((input, output, cost, model))
    })
}

/// Block until the SSE reader has been idle ~150ms (bounded), so the turn
/// thread never persists before the reader flushed its final snapshots.
fn wait_for_reader_quiet(last_event_ms: &AtomicU64, max_wait: Duration) {
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

fn now_ms_u64() -> u64 {
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
fn read_opencode_server_events(
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
        let mut buf = String::new();
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
            buf.push_str(&String::from_utf8_lossy(&bytes));
            // Guard against a pathological flood without newlines.
            if buf.len() > 4 * 1024 * 1024 {
                buf.clear();
                continue;
            }
            while let Some(pos) = buf.find('\n') {
                let line: String = buf.drain(..=pos).collect();
                let line = line.trim_end_matches(['\n', '\r']);
                if let Some(data) = line.strip_prefix("data:") {
                    handle_opencode_sse_data(
                        app,
                        sid,
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
fn handle_opencode_sse_data(
    app: Option<&AppHandle>,
    sid: &str,
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
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return;
    };
    last_event_ms.store(now_ms_u64(), Ordering::Relaxed);

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
        let pid = v.pointer("/properties/partID").and_then(|p| p.as_str()).unwrap_or("");
        let field = v.pointer("/properties/field").and_then(|f| f.as_str()).unwrap_or("text");
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
            let mut input: Option<i64> = None;
            let mut output: Option<i64> = None;
            let mut cost: Option<f64> = None;
            handle_opencode_event(
                app,
                sid,
                &event,
                &mut full,
                session_cell,
                &mut input,
                &mut output,
                &mut cost,
                last_text,
                last_reasoning,
                &mut in_think,
                tools,
            );
        }
        Some("tool") => {
            // Deltas for tool parts are ignored — cards are state-machine driven.
            if let Some(pid) = part.get("id").and_then(|p| p.as_str()) {
                part_kinds.insert(pid.to_string(), "tool".to_string());
            }
            emit_opencode_tool(
                app, sid, part, full_cell, think_cell, tools, tool_states,
            );
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
fn emit_opencode_tool(
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
            let role = inp.get("subagent_type").and_then(|v| v.as_str()).unwrap_or("agent");
            let task = inp.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let prompt = inp.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            tools.subagent_use(name, value, app, sid, role, task, prompt)
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
        if let Some(marker) = tools.tool_result(text, status == "error", app, sid) {
            let mut full = full_cell.lock().unwrap_or_else(|e| e.into_inner());
            full.push_str(&marker);
            emit_token(app, sid, &marker);
        }
        tool_states.insert(pid, 2);
    }
}

/// Kimi stream-json: `{"role":"assistant","content":…}` messages, tool events
/// (see tool_marker_kimi), and a `session.resume_hint` meta line carrying the
/// resume id. (Verified against v0.31.1 output.)
fn handle_kimi_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    tools: &mut ToolTracker,
) {
    let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
    match role {
        "assistant" => {
            if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                full.push_str(text);
                emit_token(app, sid, text);
            }
            // Tool calls ride along as structured blocks when present.
            if let Some(calls) = v.get("tool_calls").and_then(|t| t.as_array()) {
                for c in calls.iter() {
                    if let Some((name, values)) = tool_meta_kimi(c) {
                        if is_subagent_tool_name(&name) {
                            let input = c.get("function").and_then(|f| f.get("arguments"));
                            let args = match input {
                                Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(json!({})),
                                Some(val) => val.clone(),
                                None => json!({}),
                            };
                            let role = args.get("subagent_type").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
                            let task = args.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let marker = tools.subagent_use(
                                &name,
                                values.into_iter().next().unwrap_or(json!({})),
                                app,
                                sid,
                                &role,
                                &task,
                                &prompt,
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
        // Tool results: kimi delivers one per call, in call order. Attach shell
        // output to its step; non-shell results are consumed for ordering only.
        "tool" => {
            let text = extract_result_text(v.get("content"));
            if let Some(marker) = tools.tool_result(&text, false, app, sid) {
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
        }
        "meta" => {
            if v.get("type").and_then(|t| t.as_str()) == Some("session.resume_hint") {
                if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) {
                    if let Ok(mut g) = session_cell.lock() {
                        *g = Some(id.to_string());
                    }
                }
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("usage") {
                if let Some(u) = v.get("usage") {
                    *input = u.get("input_tokens").and_then(|t| t.as_i64()).or(*input);
                    *output = u.get("output_tokens").and_then(|t| t.as_i64()).or(*output);
                }
            }
        }
        _ => {}
    }
}

/// Parse TodoWrite input and emit the FULL normalized todo list as a
/// `chat:plan-updated` event, so harness sessions (Claude Code etc. — which
/// do their own planning/task tracking) get the same Progress-list rendering
/// as the built-in agent. Claude Code rewrites the whole list each call, so
/// the event replaces the session's list authoritatively. Shared by the
/// per-turn and persistent-server OpenCode paths.
fn emit_todowrite_steps(app: Option<&AppHandle>, sid: &str, name: &str, inp: &Value) {
    if !name.eq_ignore_ascii_case("TodoWrite") {
        return;
    }
    let Some(todos) = inp.get("todos").and_then(|v| v.as_array()) else {
        return;
    };
    let items: Vec<crate::types::PlanTodo> = todos
        .iter()
        .filter_map(|todo| {
            let content = todo.get("content").and_then(|v| v.as_str())?.trim().to_string();
            if content.is_empty() {
                return None;
            }
            let status = match todo.get("status").and_then(|v| v.as_str()) {
                Some("completed") => "completed",
                Some("in_progress") => "in_progress",
                _ => "pending",
            };
            let active_form = todo
                .get("activeForm")
                .or_else(|| todo.get("active_form"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            Some(crate::types::PlanTodo {
                content,
                status: status.to_string(),
                active_form,
            })
        })
        .collect();
    if items.is_empty() {
        return;
    }
    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            "chat:plan-updated",
            crate::types::ChatPlanUpdatedPayload {
                chat_session_id: sid.to_string(),
                todos: items,
            },
        );
    }
}

/// OpenCode `--format json` events. (Shapes verified against `opencode run`
/// and the `opencode serve` SSE stream — both normalize onto these shapes.)
fn handle_opencode_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cost: &mut Option<f64>,
    last_text: &mut String,
    last_reasoning: &mut String,
    in_think: &mut bool,
    tools: &mut ToolTracker,
) {
    match v.get("type").and_then(|t| t.as_str()) {
        // {"type":"text","part":{"text":…}} — assistant text chunk. In `run`
        // mode opencode buffers deltas internally and fires one event per
        // completed text part with the FULL snapshot of that part's text, so
        // emit/append only the new suffix; a snapshot that doesn't extend the
        // previous one is a new part and is emitted whole. (Appending the
        // whole snapshot to `full` would duplicate it in the persisted
        // message.)
        Some("text") => {
            // Text after reasoning closes the thinking block — same contract
            // as claude's stream reader (an unclosed <think> would swallow
            // the answer into the collapsible block).
            if *in_think {
                full.push_str("</think>");
                emit_token(app, sid, "</think>");
                *in_think = false;
                last_reasoning.clear();
            }
            if let Some(text) = v.pointer("/part/text").and_then(|t| t.as_str()) {
                let suffix = text.strip_prefix(last_text.as_str()).unwrap_or(text);
                if !suffix.is_empty() {
                    full.push_str(suffix);
                    emit_token(app, sid, suffix);
                }
                last_text.clear();
                last_text.push_str(text);
            }
        }
        // {"type":"reasoning","part":{"text":…}} — thinking part (server
        // SSE). Same full-snapshot-suffix rule as text; wrapped in
        // <think>…</think> so the frontend shows a live collapsible block.
        Some("reasoning") => {
            if let Some(text) = v.pointer("/part/text").and_then(|t| t.as_str()) {
                if !*in_think {
                    full.push_str("<think>");
                    emit_token(app, sid, "<think>");
                    *in_think = true;
                    last_reasoning.clear();
                }
                let suffix = text.strip_prefix(last_reasoning.as_str()).unwrap_or(text);
                if !suffix.is_empty() {
                    full.push_str(suffix);
                    emit_token(app, sid, suffix);
                }
                last_reasoning.clear();
                last_reasoning.push_str(text);
            }
        }
        // {"type":"tool_use","part":{"tool":…,"state":{"input":…}}}
        Some("tool_use") => {
            let part = v.get("part").cloned().unwrap_or(json!({}));
            let name = part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
            let inp = part.pointer("/state/input").cloned().unwrap_or(json!({}));
            // TodoWrite JSON emits structured plan-step progress so the
            // frontend tracks individual task items instead of a generic
            // "Updating task list" marker.
            emit_todowrite_steps(app, sid, name, &inp);
            let value = tool_meta_generic(name, &inp);
            if is_subagent_tool_name(name) {
                // Subagent spawn (claude "Agent"/"Task"): extract
                // role/task/prompt and emit a spawn event.
                let role = inp.get("subagent_type").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
                let task = inp.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let prompt = inp.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let marker = tools.subagent_use(name, value, app, sid, &role, &task, &prompt);
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            } else {
                // OpenCode reports a tool's completed output inline on the same
                // part (`state.output` / `state.error`); attach it for shell tools.
                let out_text = part.pointer("/state/output").and_then(|o| o.as_str());
                let err_text = part.pointer("/state/error").and_then(|e| e.as_str());
                let marker = tools.tool_use_with_output(name, value, out_text, err_text);
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
        }
        // Session id / usage surfaces on step-finish.
        Some("step_finish") => {
            if let Ok(mut g) = session_cell.lock() {
                if g.is_none() {
                    if let Some(id) = v.get("sessionID").and_then(|s| s.as_str()) {
                        *g = Some(id.to_string());
                    }
                }
            }
            if let Some(u) = v.pointer("/part/tokens") {
                *input = u.get("input").and_then(|t| t.as_i64()).or(*input);
                *output = u.get("output").and_then(|t| t.as_i64()).or(*output);
            }
            // Free models report cost 0; Zen/relay models report real dollars.
            *cost = v.pointer("/part/cost").and_then(|c| c.as_f64()).or(*cost);
        }
        // Any event carrying the session id is a chance to capture it.
        _ => {
            if let Ok(mut g) = session_cell.lock() {
                if g.is_none() {
                    if let Some(id) = v.get("sessionID").and_then(|s| s.as_str()) {
                        *g = Some(id.to_string());
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- one-shot turns

/// Run a single self-contained turn and BLOCK until it finishes. This is the
/// shared engine for automations: the in-app scheduler calls it with
/// `Some(app)` (live `chat:*` events) and the headless `conduit-automation`
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
        crate::db::add_chat_message(&conn, chat_session_id, "user", prompt, None, None, None, None, None, None, None, None, None, None, None, None, None, None, None)
            .map_err(|e| e.to_string())?;
    }

    // Prepend the custom system prompt (same as the chat-session path).
    let effective = {
        let conn = db.lock();
        let custom: Option<String> =
            crate::db::get_setting(&conn, "assistant.systemPrompt").ok().flatten();
        match custom {
            Some(sp) if !sp.trim().is_empty() => {
                format!("{sp}\n\n---\n\n{prompt}")
            }
            _ => prompt.to_string(),
        }
    };

    let (spec, prompt_env) = one_shot_spec(harness, &effective, model)?;
    // claude one-shot takes the prompt via stdin (see one_shot_spec — M12);
    // the other harnesses either carry it in the env pair (Windows wrapper)
    // or inline in argv (POSIX).
    let prompt_via_stdin = harness == "claude_code";
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if prompt_via_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some((k, v)) = &prompt_env {
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
    let one_shot_pid = register_one_shot_child(&child);
    let stdout = {
        let mut guard = child.lock().map_err(|e| e.to_string())?;
        guard
            .stdout
            .take()
            .ok_or("failed to capture CLI stdout")?
    };

    let db2 = DbState(Arc::clone(db));
    let sid2 = chat_session_id.to_string();
    let in_flight = Arc::new(AtomicBool::new(true));
    let in_flight2 = Arc::clone(&in_flight);
    let app2 = app.cloned();
    let is_claude = harness == "claude_code";
    let is_kimi = harness == "kimi_code";
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
            read_claude_stream(app2.as_ref(), &db2, &sid2, stdout, &in_flight2, &cell, &never_cancelled, dummy_stdin, watches, &generation, 1);
        } else {
            let cell = Arc::new(Mutex::new(None));
            read_per_turn_stream(app2.as_ref(), &db2, &sid2, stdout, &in_flight2, &cell, is_kimi, &never_cancelled, watches);
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
    if let Some(pid) = one_shot_pid {
        unregister_one_shot_child(pid);
    }
    match wait {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{} exited with {status}", spec.program)),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Err(e.to_string()),
        Err(e) => Err(format!("failed to wait on {}: {e}", spec.program)),
    }
}

/// Wall-clock bound for [`harness_oneshot_text`]. Generation prompts are
/// self-contained (no tools to wait on), so a CLI that hasn't answered in
/// three minutes is wedged, not working.
const ONESHOT_GEN_TIMEOUT: Duration = Duration::from_secs(180);

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
    tokio::task::spawn_blocking(move || harness_oneshot_blocking(&harness, &model, &prompt, cwd.as_deref()))
        .await
        .map_err(|e| format!("generation task failed: {e}"))?
}

fn harness_oneshot_blocking(
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
    let (spec, prompt_env, prompt_via_stdin) = match harness_id {
        "claude_code" => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                "--output-format".into(),
                "json".into(),
                "--dangerously-skip-permissions".into(),
            ];
            if !model.is_empty() {
                args.push("--model".into());
                args.push(claude_model_alias(model));
            }
            (
                resolve_for_spawn(&CommandSpec { program: "claude".into(), args }),
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
            let (spec, env) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::Kimi,
                prompt,
                flags,
            );
            (spec, env, false)
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
            let (spec, env) = crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::OpenCode,
                prompt,
                flags,
            );
            (spec, env, false)
        }
        other => return Err(format!("unsupported harness for generation: {other}")),
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if prompt_via_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open CLI stdin".to_string())?;
        use std::io::Write as _;
        stdin
            .write_all(prompt.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("failed to write prompt to CLI stdin: {e}"))?;
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

    // Poll-wait with a deadline; a hung CLI is killed at the bound instead of
    // wedging the async command forever (same posture as run_one_shot).
    let deadline = std::time::Instant::now() + ONESHOT_GEN_TIMEOUT;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if std::time::Instant::now() >= deadline => {
                // E-7: kill the WHOLE tree — on Windows `child.kill()` only
                // terminates the cmd.exe /C wrapper and the CLI grandchild
                // survives, keeps running (and spending) (see kill_child_tree).
                kill_child_tree(&mut child);
                return Err(format!(
                    "{harness_id} generation timed out after {}s",
                    ONESHOT_GEN_TIMEOUT.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let raw = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| format!("{harness_id} closed without producing output"))?;

    let text = parse_oneshot_text(harness_id, &raw)?;
    if text.trim().is_empty() {
        return Err(format!("{harness_id} returned an empty response (raw: {})", &raw[..raw.len().min(200)]));
    }
    Ok(text)
}

/// Extract the final assistant text from a one-shot CLI's raw stdout.
/// Claude (plain json): `.result` off the single result object. Kimi
/// (stream-json): concatenation of assistant `content` strings — mirrors
/// handle_kimi_event's text path, minus tool markers (a generation prompt
/// must not call tools, and markers would corrupt the expected JSON).
/// OpenCode (run-mode json events): text parts carry FULL snapshots, so only
/// each part's new suffix is appended — mirrors handle_opencode_event.
fn parse_oneshot_text(harness_id: &str, raw: &str) -> Result<String, String> {
    let head = |n: usize| &raw[..raw.len().min(n)];
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
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                if v.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
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
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
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
/// get it via CONDUIT_TURN_PROMPT + delayed-expansion wrapper (the returned
/// env pair, Windows only — POSIX keeps the prompt in argv, which exec
/// carries verbatim).
fn one_shot_spec(harness: &str, prompt: &str, model: &str) -> Result<(CommandSpec, Option<(String, String)>), String> {
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
            ))
        }
        "kimi_code" => {
            let mut flags: Vec<String> = vec![
                "--output-format".into(),
                "stream-json".into(),
            ];
            if !model.is_empty() {
                // E-9c: the model id rides the cmd.exe wrapper line via an
                // unquoted `%*` — reject cmd metacharacters up front.
                crate::harness_adapters::ensure_cmd_safe_model(model)?;
                flags.push("-m".into());
                flags.push(model.into());
            }
            Ok(crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::Kimi,
                prompt,
                flags,
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
            Ok(crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::OpenCode,
                prompt,
                flags,
            ))
        }
        other => Err(format!("harness '{other}' has no headless chat backend yet")),
    }
}

// ---------------------------------------------------------------- tool markers

/// A tool's own content must never contain the closing tag or it would
/// truncate the marker on the client (same defense as chat/proto.rs).
fn sanitize(v: String) -> String {
    v.replace("</tool>", "<\\/tool>")
}

/// Claude Code tool_use block → `<tool>{json}</tool>` marker (same shapes as
/// chat/proto.rs `tool_block` so DiffCard/activity groups just work).
///
/// Returns the tool NAME plus the marker Value(s) (MultiEdit yields one per
/// hunk). The caller wraps them via `ToolTracker::tool_use`, which injects a
/// correlation id into shell markers and records the call so its later result
/// can be attached.
fn tool_meta_claude(block: &Value) -> Option<(String, Vec<Value>)> {
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
        let edits = input.get("edits").and_then(|e| e.as_array()).cloned().unwrap_or_default();
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

/// Kimi tool_call object → (name, marker values). Kimi names tools close to
/// Claude's (Edit/Write/Read/Bash/Grep/Glob…) with args under
/// `function.arguments` (JSON string) or directly as input — both handled.
fn tool_meta_kimi(call: &Value) -> Option<(String, Vec<Value>)> {
    let func = call.get("function").cloned().unwrap_or(call.clone());
    let name = func.get("name").and_then(|n| n.as_str())?.to_string();
    let args = match func.get("arguments") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(json!({})),
        Some(v) => v.clone(),
        None => json!({}),
    };
    let vals = vec![tool_meta_generic(&name, &args)];
    Some((name, vals))
}

/// True for the shell/command tool names used across the harness CLIs.
fn is_shell_name(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "bash" | "shell" | "run_shell" | "run_command"
    )
}

/// True for the subagent-dispatch tool name across the harness CLIs: Claude
/// Code 2.x renamed its `Task` tool to `Agent` (same input shape —
/// subagent_type/description/prompt, verified in the CLI bundle); opencode
/// calls it `task`; kimi still uses `Task`. Every harness path must treat
/// both names as a subagent spawn, or the chip/sidebar/panel UI never sees
/// the agent (the screenshot bug: "Running tool Agent" + empty AGENTS list).
fn is_subagent_tool_name(name: &str) -> bool {
    matches!(name.to_lowercase().as_str(), "task" | "agent")
}

/// Cap captured shell output so a huge dump can't bloat the stored message.
/// Shell output is usually most useful at the tail, so keep the last lines.
fn truncate_output(s: &str) -> String {
    const MAX_LINES: usize = 60;
    const MAX_BYTES: usize = 8_000;
    let lines: Vec<&str> = s.lines().collect();
    let mut out = if lines.len() > MAX_LINES {
        let dropped = lines.len() - MAX_LINES;
        format!(
            "… [{} earlier lines truncated]\n{}",
            dropped,
            lines[lines.len() - MAX_LINES..].join("\n")
        )
    } else {
        s.to_string()
    };
    if out.len() > MAX_BYTES {
        let start = out.len() - MAX_BYTES;
        out = format!("…\n{}", &out[start..]);
    }
    out
}

/// Pull the text out of a tool_result `content` field, which may be a plain
/// string or an array of content blocks (text/image). Only text is useful for
/// the shell preview; other blocks are ignored.
fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    }
}

/// Tracks tool calls within a turn so each tool RESULT can be matched back to
/// its call. CLI streams deliver calls and results IN ORDER but interleave
/// non-shell tools with shell tools, so we keep a FIFO per call and pop one slot
/// per result. Each slot records whether the call was a shell command (its
/// result renders as a terminal preview) or a subagent Task (its result feeds a
/// subagent panel). Other tools are tracked solely to keep the order aligned.
struct PendingTool {
    id: u64,
    shell: bool,
    subagent: Option<SubagentMeta>,
}
struct SubagentMeta {
    id: String,
    task: String,
}

struct ToolTracker {
    seq: u64,
    pending: VecDeque<PendingTool>,
}

impl ToolTracker {
    fn new() -> Self {
        Self { seq: 0, pending: VecDeque::new() }
    }
    /// Wrap one tool call's marker Value(s) as `<tool>…</tool>`, injecting an
    /// `id` when the call is a shell command, and record the call's slot.
    fn tool_use(&mut self, name: &str, values: Vec<Value>) -> String {
        let id = self.seq;
        self.seq += 1;
        let shell = is_shell_name(name);
        let mut out = String::new();
        for mut v in values {
            if shell {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("id".to_string(), json!(id));
                }
            }
            out.push_str(&format!("<tool>{v}</tool>"));
        }
        self.pending.push_back(PendingTool { id, shell, subagent: None });
        out
    }
    /// Wrap a subagent Task tool call: emits a `chat:subagent-spawn` event,
    /// injects an `id` into the marker, and records the slot as a subagent.
    fn subagent_use(&mut self, _name: &str, value: Value, app: Option<&AppHandle>, sid: &str, role: &str, task: &str, prompt: &str) -> String {
        let id = self.seq;
        self.seq += 1;
        // Unique across turns: `seq` resets every turn, so a plain `sub-0`
        // would clobber the previous turn's sub-0 in the frontend store
        // (same collision the built-in path fixed with a timestamp segment).
        static SUB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let sub_seq = SUB_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let sub_id = format!("sub-{}-{sub_seq}", crate::db::now_ts());
        let mut v = value;
        if let Some(obj) = v.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
        }
        // Emit the spawn event so the frontend creates the subagent immediately.
        if let Some(app) = app {
            let _ = app.emit(
                "chat:subagent-spawn",
                crate::types::SubagentSpawnPayload {
                    chat_session_id: sid.to_string(),
                    id: sub_id.clone(),
                    role: role.to_string(),
                    task: task.to_string(),
                    prompt: prompt.to_string(),
                },
            );
        }
        self.pending.push_back(PendingTool {
            id,
            shell: false,
            subagent: Some(SubagentMeta { id: sub_id, task: task.to_string() }),
        });
        format!("<tool>{v}</tool>")
    }
    /// Consume the next result slot (in call order). Returns a result marker
    /// carrying the output text only when that call was a shell command, and
    /// emits `chat:subagent-tokens` + `chat:subagent-done` when it was a
    /// subagent Task.
    fn tool_result(&mut self, text: &str, is_error: bool, app: Option<&AppHandle>, sid: &str) -> Option<String> {
        let slot = self.pending.pop_front()?;
        if let Some(meta) = &slot.subagent {
            if let Some(app) = app {
                let _ = app.emit(
                    "chat:subagent-tokens",
                    crate::types::SubagentTokenPayload {
                        chat_session_id: sid.to_string(),
                        subagent_id: meta.id.clone(),
                        chunk: text.to_string(),
                    },
                );
                let _ = app.emit(
                    "chat:subagent-done",
                    crate::types::SubagentDonePayload {
                        chat_session_id: sid.to_string(),
                        id: meta.id.clone(),
                        output: text.to_string(),
                        error: is_error.then(|| "subagent exited with an error".to_string()),
                    },
                );
            }
            return None;
        }
        if !slot.shell {
            return None;
        }
        Some(result_marker_text(slot.id, text, is_error))
    }
    /// Self-contained variant for CLIs that report a tool's call AND its
    /// completed output in one event (opencode). Assigns an id, emits the
    /// command marker, and — for shell tools whose output/error is present —
    /// appends a matching result marker. No pending slot (nothing to match
    /// later), so it can't desync a queue.
    fn tool_use_with_output(
        &mut self,
        name: &str,
        value: Value,
        output: Option<&str>,
        error: Option<&str>,
    ) -> String {
        let id = self.seq;
        self.seq += 1;
        let shell = is_shell_name(name);
        let mut out = String::new();
        let mut v = value;
        if shell {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("id".to_string(), json!(id));
            }
            out.push_str(&format!("<tool>{v}</tool>"));
            if let Some(text) = output.or(error) {
                out.push_str(&result_marker_text(id, text, error.is_some()));
            }
        } else {
            out.push_str(&format!("<tool>{v}</tool>"));
        }
        out
    }
}

/// Build a `<tool>{"kind":"result",…}</tool>` marker that the frontend merges
/// onto the shell step with the matching `id`.
fn result_marker_text(id: u64, text: &str, is_error: bool) -> String {
    let body = json!({
        "kind": "result",
        "id": id,
        "result": sanitize(truncate_output(text)),
        "resultError": is_error,
    });
    format!("<tool>{body}</tool>")
}

/// Shared tool-name → marker-meta mapping across CLIs. Claude, Kimi and
/// OpenCode all converge on similar tool names; the edit-shaped tools map to
/// DiffCard payloads, everything else to activity-group steps. Also used by
/// the built-in subagent loop (chat/dispatch.rs) for its `<tool>` markers.
pub(crate) fn tool_meta_generic(name: &str, input: &Value) -> Value {
    // Tools emit args in different conventions: Claude Code uses snake_case
    // (`file_path` / `old_string` / `new_string`), OpenCode uses camelCase
    // (`filePath` / `oldString` / `newString`). Look up both keys per field;
    // the helper's existing priority (snake first) is preserved.
    let s = |keys: &[&str]| {
        for k in keys {
            if let Some(v) = input.get(*k).and_then(|v| v.as_str()) {
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
        String::new()
    };
    let s_path = || s(&["file_path", "filePath", "path", "file_path_abs"]);
    let s_find = || s(&["old_string", "oldString", "find"]);
    let s_replace = || s(&["new_string", "newString", "replace", "newText"]);
    let s_content = || s(&["content", "fileContent", "text"]);
    // Normalize the common aliases the CLIs use for file edits.
    let lname = name.to_lowercase();
    let is_edit = matches!(lname.as_str(), "edit" | "edit_file" | "multiedit" | "str_replace_editor");
    let is_write = matches!(lname.as_str(), "write" | "write_file" | "create_file");
    let is_shell = matches!(lname.as_str(), "bash" | "shell" | "run_shell" | "run_command");

    if is_edit {
        let path = s_path();
        json!({
            "kind": "edit",
            "title": format!("Editing file \"{path}\""),
            "detail": path,
            "path": path,
            "edit": { "mode": "replace", "find": sanitize(s_find()), "replace": sanitize(s_replace()) },
        })
    } else if is_write {
        let path = s_path();
        json!({
            "kind": "edit",
            "title": format!("Writing file \"{path}\""),
            "detail": path,
            "path": path,
            "edit": { "mode": "write", "content": sanitize(s_content()) },
        })
    } else if is_shell {
        let cmd = s(&["command", "cmd"]);
        json!({ "kind": "code", "title": "Running shell command", "lang": "bash", "code": sanitize(cmd) })
    } else {
        match name {
            "Read" | "read" | "read_file" => json!({ "kind": "tool", "title": "Reading file", "detail": s_path() }),
            "Grep" | "grep" => json!({ "kind": "search", "title": "Searching code", "detail": s(&["pattern", "query"]) }),
            "Glob" | "glob" => json!({ "kind": "search", "title": "Finding files", "detail": s(&["pattern", "glob", "query"]) }),
            "WebSearch" | "web_search" => json!({ "kind": "search", "title": "Searching the web", "detail": s(&["query", "searchQuery"]) }),
            "WebFetch" | "web_fetch" | "fetch_url" => json!({ "kind": "web", "title": "Reading a web page", "detail": s(&["url", "uri"]) }),
            "TodoWrite" | "todowrite" => json!({ "kind": "tool", "title": "Updating task list" }),
            _ if is_subagent_tool_name(name) => json!({
                "kind": "subagent",
                "title": "Running subagent",
                "detail": s(&["description", "task", "summary"]),
                "role": s(&["subagent_type", "type", "agent_type"]),
                "prompt": sanitize(s(&["prompt", "message", "input"])),
            }),
            _ => json!({ "kind": "tool", "title": format!("Running tool {name}") }),
        }
    }
}

// ---------------------------------------------------------------- shared emit/persist

/// Turn finished successfully: persist the accumulated assistant message
/// (mirroring the built-in chat, so onDone's refetch sees it), surface any
/// files the CLI created or modified as artifacts (same insert_artifact +
/// `chat:artifact` emit as the built-in chat in chat/dispatch.rs), then emit
/// done.
fn finish_turn(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    full: &mut String,
    input: Option<i64>,
    output: Option<i64>,
    cost: Option<f64>,
    watches: &mut Vec<DirWatch>,
    // Unix-second instant the turn started (captured when the reader began),
    // persisted as `started_at` so the UI can show "Worked for Xs".
    started_at: i64,
    // The model id the HARNESS actually ran this turn (from its own stream —
    // claude's assistant message.model, opencode's message info.modelID).
    // Persisted on the assistant row as model_key so the cost breakdown
    // prices the REAL model — a custom/remapped harness model previously
    // fell back to the session's stale catalog id and priced opus/sonnet
    // rates for a completely different model.
    model_key: Option<&str>,
) {
    // Context-chain trace: the harness's own per-turn report — the model it
    // actually ran and the prompt size it counted, which the frontend meter
    // renders as "used" against its cap (lib/contextWindow.ts). No context
    // limit crosses this boundary; the CLI enforces its own window.
    eprintln!(
        "[context] harness turn: session={} model='{}' in={} out={}",
        sid,
        model_key.unwrap_or("—"),
        input.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
        output.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
    );
    // Persist the assistant message FIRST so we can attribute artifacts to it.
    let message_id: Option<i64> = if !full.is_empty() {
        let conn = db.0.lock();
        // Strip the "harness:" prefix from the agent so the rollup
        // groups harness-backed CLI chat under a clean provider label
        // (e.g. "claude_code" instead of "harness:claude_code").
        let agent: Option<String> = conn
            .query_row(
                "SELECT agent FROM chat_sessions WHERE id = ?1",
                rusqlite::params![sid],
                |r| r.get(0),
            )
            .ok();
        let provider = agent
            .as_deref()
            .and_then(|a| a.strip_prefix("harness:"))
            .unwrap_or("unknown");
        // Pull the harness turn's live perf from the active accumulator
        // (TTFT and tok/s only — the harness CLI's mixed stream doesn't
        // admit a clean LLM/tool split, so those stay —).
        let (ttft, tok_s) = crate::chat::turn_perf::active_snapshot(sid)
            .map(|p| (p.ttft_ms, p.tokens_per_second))
            .unwrap_or((None, None));
        crate::db::add_chat_message(&conn, sid, "assistant", full, input, output, cost, None, None, None, Some(provider), model_key, None, Some(started_at), Some(crate::db::now_ts()), None, None, ttft, tok_s)
            .ok()
            .map(|m| m.id)
    } else {
        None
    };
    full.clear();

    // Clear the active per-turn perf accumulator registered by the turn reader
    // (see the `register` call in the stream loops) so a later turn starts
    // fresh and `emit_token` stops recording to it.
    crate::chat::turn_perf::unregister(sid);

    // Diff every watch dir (spawn dir + artifacts dir). `emitted` dedups the
    // (rare) case of overlapping dirs reporting the same file twice.
    let mut emitted = std::collections::HashSet::new();
    for w in watches.iter_mut() {
        // B6: stats only watcher-touched paths when the notify watcher is
        // healthy; full-walks only as a fallback. The baseline refresh
        // happens inside changed() either way, so the next turn reports only
        // its own files.
        let changed = w.changed();
        for rel in changed {
            let path = w.dir.join(&rel).to_string_lossy().to_string();
            if !emitted.insert(path.clone()) {
                continue;
            }
            let filename = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let kind = Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            {
                let conn = db.0.lock();
                let _ = crate::db::insert_artifact(&conn, Some(sid), &filename, &path, &kind);
            }
            if let Some(app) = app {
                let _ = app.emit(
                    "chat:artifact",
                    crate::types::ChatArtifactPayload {
                        chat_session_id: sid.to_string(),
                        path,
                        filename,
                    },
                );
            }
        }
    }

    // Attribute this turn's artifacts to the assistant message so they
    // reappear on its bubble when the chat is reopened (mirrors chat/mod.rs).
    if let Some(mid) = message_id {
        let conn = db.0.lock();
        let _ = crate::db::attach_artifacts_to_message(&conn, sid, mid);
    }

    emit_done(app, sid, input, output, cost);

    // Per-turn git checkpoint against the spawn dir (watches are ordered
    // spawn-dir-first by turn_watch_dirs; non-repo dirs skip silently).
    // Runs on this reader thread — already off the UI path; turns that
    // changed nothing dedup-skip inside after_turn.
    if let Some(spawn) = watches.first() {
        let dir = spawn.dir.clone();
        let conn = db.0.lock();
        crate::checkpoints::after_turn(app, &conn, sid, message_id, &dir);
    }
}

fn emit_token(app: Option<&AppHandle>, sid: &str, token: &str) {
    if let Some(app) = app {
        let payload = crate::types::ChatTokenPayload {
            chat_session_id: sid.to_string(),
            token: token.to_string(),
        };
        if !crate::chat::stream_events::try_send(sid, &payload) {
            let _ = app.emit("chat:token", payload);
        }
    }
    // Record into the active per-turn perf accumulator (if one is registered
    // by the harness turn loop) so the live composer row shows TTFT + tok/s.
    crate::chat::turn_perf::record_active_token(sid);
}

fn emit_done(app: Option<&AppHandle>, sid: &str, input: Option<i64>, output: Option<i64>, cost: Option<f64>) {
    if let Some(app) = app {
        let _ = app.emit(
            "chat:done",
            json!({ "chatSessionId": sid, "inputTokens": input, "outputTokens": output, "costUsd": cost }),
        );
    }
}

fn emit_error(app: Option<&AppHandle>, sid: &str, message: &str) {
    if let Some(app) = app {
        // Classify harness errors too: a remapped harness backend rejecting a
        // turn for window overflow must reach the same recoverable-error UX
        // as the built-in providers, not the generic failure banner.
        let code = crate::chat::error_class::classify_error(message);
        let _ = app.emit(
            "chat:error",
            json!({ "chatSessionId": sid, "message": message, "code": code }),
        );
    }
}

/// Persist a "harness-side auto-compact" boundary row + emit the meter
/// refresh. Each harness surfaces its own native auto-compact differently:
/// Claude Code emits `{"type":"system","subtype":"compact_boundary"}` —
/// detected in its stream reader and forwarded here. OpenCode/Kimi don't
/// emit an observable event; their compactions stay invisible and the meter
/// reflects the drop via the next turn's input_tokens (the /compact slash
/// command remains the manual lever for those engines).
///
/// Takes a locked DB connection so the caller (already parsing the stream
/// with one) can pass it in without a second lock acquisition.
fn emit_harness_compact(
    conn: &rusqlite::Connection,
    app: Option<&AppHandle>,
    sid: &str,
    source: &str,
) {
    let marker = format!(
        "{}\n\nThe {source} engine condensed its own context here \
         (harness-side auto-compact). The summary remains inside the CLI \
         session; Relay records the boundary so nothing looks like it \
         silently vanished.",
        crate::chat::compaction::COMPACTED_PREFIX
    );
    let _ = crate::db::add_chat_message(
        conn, sid, "system", &marker,
        None, None, None, None, None, None, None, None, None,
        None, None, None, None, None, None,
    );
    if let Some(app) = app {
        let _ = app.emit(
            "chat:status",
            json!({
                "chatSessionId": sid,
                "reason": "context_compacted",
                "message": "Harness context compacted",
            }),
        );
    }
}

/// A GUI app spawning console tools on Windows would otherwise flash a
/// console window per spawn.
fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: i64, role: &str, content: &str) -> crate::types::ChatMessageRecord {
        crate::types::ChatMessageRecord {
            id,
            chat_session_id: "s".into(),
            role: role.into(),
            content: content.into(),
            input_tokens: None,
            output_tokens: None,
            cost_usd: None,
            created_at: 0,
            superseded_by: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None,
            provider: None,
            model_key: None,
            pricing_estimated_usd: None,
            started_at: None,
            completed_at: None,
            llm_time_ms: None,
            tool_time_ms: None,
            ttft_ms: None,
            tokens_per_second: None,
        }
    }

    /// The tail/head split must keep the NEWEST turns inside the char budget
    /// and classify everything older as head — the head is what the primer
    /// summarizer covers.
    #[test]
    fn primer_tail_and_head_splits_by_budget() {
        // 40 short turns ≈ well under the 32k budget → all tail, no head.
        let small: Vec<_> = (0..40)
            .map(|i| record(i, if i % 2 == 0 { "user" } else { "assistant" }, "turn text here"))
            .collect();
        let (tail, head_count, head_chars) = primer_tail_and_head(&small);
        assert_eq!(tail.len(), 40);
        assert_eq!((head_count, head_chars), (0, 0));
        assert_eq!(tail.first().unwrap().id, 0);
        assert_eq!(tail.last().unwrap().id, 39);

        // 2_000 turns ≈ 80k chars — the tail must cap at ~32k and the rest is
        // head, keeping the NEWEST turns.
        let big: Vec<_> = (0..2_000)
            .map(|i| record(i, if i % 2 == 0 { "user" } else { "assistant" }, "turn text here"))
            .collect();
        let (tail, head_count, head_chars) = primer_tail_and_head(&big);
        assert!(head_count > 0);
        assert_eq!(tail.len() + head_count, 2_000);
        assert_eq!(tail.last().unwrap().id, 1_999);
        assert!(tail.first().unwrap().id > 0);
        assert!(head_chars > CONTEXT_PRIMER_SUMMARY_TRIGGER_CHARS);
    }

    /// With a summary, the primer renders the summary section ABOVE the
    /// verbatim tail with distinct labels; without one it keeps the legacy
    /// everything-said-so-far wording.
    #[test]
    fn primer_renders_summary_and_tail_sections() {
        let records: Vec<_> = (0..4)
            .map(|i| record(i, if i % 2 == 0 { "user" } else { "assistant" }, "hello"))
            .collect();
        let with = context_primer_from_records(&records, Some("User asked for X; done."));
        assert!(with.contains("[Summary of the earlier turns]"));
        assert!(with.contains("User asked for X; done."));
        assert!(with.contains("[Recent transcript, verbatim]"));

        let without = context_primer_from_records(&records, None);
        assert!(!without.contains("[Summary of the earlier turns]"));
        assert!(without.contains("everything said so far"));
        assert!(without.contains("[User]: hello"));

        // Display-only history + no summary → empty handoff (unchanged rule).
        let thinky = vec![record(0, "assistant", "<think>internal</think>")];
        assert_eq!(context_primer_from_records(&thinky, None), "");
    }

    /// The harness persona must never reference a tool the CLI session
    /// doesn't have. `open_file` is a built-in-chat tool — not bridged through
    /// the conduit-tools MCP whitelist (see mcp_tools_bridge) — so a persona
    /// mention makes harness models promise an action they cannot take.
    /// See the doc on `harness_persona` for the whitelist rationale.
    #[test]
    fn harness_persona_only_names_bridgable_tools() {
        let p = harness_persona("Claude Code");
        assert!(p.contains("I'm Relay"));
        assert!(!p.contains("open_file"), "persona must not reference the built-in-chat open_file tool");
        assert!(!p.contains("open_url"), "persona must not reference the built-in-chat open_url tool");
        assert!(p.contains("Artifacts gallery"));
    }

    #[test]
    fn unstreamed_suffix_recovers_result_text_the_deltas_never_delivered() {
        // No partials streamed (CLI non-streaming fallback under API retries):
        // the whole result text is recovered.
        assert_eq!(unstreamed_suffix("", "hello"), Some("hello"));
        // Deltas streamed a strict prefix: only the remainder is recovered.
        assert_eq!(unstreamed_suffix("hel", "hello"), Some("lo"));
        // Deltas delivered everything: nothing to do.
        assert_eq!(unstreamed_suffix("hello", "hello"), None);
        // Diverged stream (mid-turn retry replaced the answer): refuse rather
        // than double-print.
        assert_eq!(unstreamed_suffix("first answer", "hello"), None);
        assert_eq!(unstreamed_suffix("hello!", "hello"), None);
        // Thinking-only turns stream no answer text but full carries think
        // markers — the suffix check runs against the delta accumulator, not
        // the marker-laden buffer, so the answer still lands whole.
        assert_eq!(unstreamed_suffix("", "reasoned answer"), Some("reasoned answer"));
    }

    /// Observed live (2026-09): a CLI turn can succeed WITHOUT any
    /// stream_event partials — under API retries the CLI falls back to
    /// non-streaming and the answer arrives only on the `result` event. The
    /// reader must recover it; before the `unstreamed_suffix` fallback the
    /// turn finished as an empty bubble (no assistant row persisted).
    #[test]
    fn claude_turn_without_partial_deltas_still_persists_the_result_text() {
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
            .unwrap();
        let db = DbState(Arc::new(parking_lot::Mutex::new(conn)));

        // Transcript with NO stream_event lines: text rides only the closing
        // `result` event, exactly like the failing probe run.
        let transcript = concat!(
            r#"{"type":"system","subtype":"init","session_id":"cli-abc"}"#, "\n",
            r#"{"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"the answer"}]}}"#, "\n",
            r#"{"type":"result","subtype":"success","result":"the answer","session_id":"cli-abc","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.001}"#, "\n",
        );
        let never = AtomicBool::new(false);
        let generation = AtomicU64::new(1);
        read_claude_stream(
            None,
            &db,
            &cs.id,
            std::io::Cursor::new(transcript),
            &never,
            &Arc::new(std::sync::Mutex::new(None)),
            &never,
            Arc::new(std::sync::Mutex::new(None)),
            Vec::new(),
            &generation,
            1,
        );

        let conn = db.0.lock();
        let rows = crate::db::list_chat_messages(&conn, &cs.id).unwrap();
        let assistant: Vec<_> = rows.iter().filter(|m| m.role == "assistant").collect();
        assert_eq!(assistant.len(), 1, "the recovered text must be persisted");
        assert_eq!(assistant[0].content, "the answer");
        assert_eq!(assistant[0].output_tokens, Some(5));
    }

    /// Minimal persisted-message row for primer tests (only role/content are
    /// read by the builder; the rest is display/telemetry metadata).
    fn primer_record(role: &str, content: &str) -> crate::types::ChatMessageRecord {
        crate::types::ChatMessageRecord {
            id: 1,
            chat_session_id: "s".into(),
            role: role.into(),
            content: content.into(),
            input_tokens: None,
            output_tokens: None,
            cost_usd: None,
            created_at: 0,
            superseded_by: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None,
            provider: None,
            model_key: None,
            pricing_estimated_usd: None,
            started_at: None,
            completed_at: None,
            llm_time_ms: None,
            tool_time_ms: None,
            ttft_ms: None,
            tokens_per_second: None,
        }
    }

    #[test]
    fn context_primer_hands_off_history_for_a_fresh_cli_session() {
        let records = vec![
            primer_record("user", "Create a quarterly report from my notes."),
            primer_record(
                "assistant",
                "Done — <tool>{\"name\":\"generate_file\"}</tool>quarterly_report.html is in Artifacts.",
            ),
            primer_record("user", "Now add a summary section."),
            primer_record(
                "assistant",
                "<think>reasoning is display-only, never re-sent</think>Added the summary section.",
            ),
        ];
        let primer = context_primer_from_records(&records, None);
        assert!(primer.starts_with("[Context handoff]"), "{primer}");
        assert!(primer.contains("[User]: Create a quarterly report"));
        assert!(primer.contains("[Relay]: Done — quarterly_report.html is in Artifacts."));
        assert!(primer.contains("[Relay]: Added the summary section."));
        // Display-only markup must not leak into the handoff: the new CLI
        // would otherwise see tool-call JSON for tools it never ran.
        assert!(!primer.contains("<tool>"));
        assert!(!primer.contains("<think>"));
        // Oldest first, so the transcript reads as a conversation.
        let first = primer.find("Create a quarterly report").unwrap();
        let last = primer.find("Added the summary section").unwrap();
        assert!(first < last);
    }

    #[test]
    fn context_primer_empty_for_fresh_chat_or_markup_only_history() {
        // Brand-new chat: nothing to hand over, no header either.
        assert_eq!(context_primer_from_records(&[], None), "");
        // Rows that are entirely think/tool markup carry no handoff content.
        let markup_only = vec![
            primer_record("assistant", "<think>hmm</think>"),
            primer_record("assistant", "<tool>{\"name\":\"bash\"}</tool>"),
        ];
        assert_eq!(context_primer_from_records(&markup_only, None), "");
    }

    #[test]
    fn context_primer_budget_keeps_the_newest_turns() {
        let mut records = Vec::new();
        for i in 0..200 {
            records.push(primer_record("user", &format!("old message {i} {}", "x".repeat(200))));
            records.push(primer_record("assistant", &format!("old reply {i} {}", "y".repeat(200))));
        }
        let primer = context_primer_from_records(&records, None);
        // Header + join overhead ride outside the per-line accounting.
        assert!(primer.len() <= CONTEXT_PRIMER_MAX_CHARS + 512, "{}", primer.len());
        // Newest turns survive truncation; the oldest fall out.
        assert!(primer.contains("old message 199"));
        assert!(primer.contains("old reply 199"));
        assert!(!primer.contains("old message 0 "));
    }

    #[test]
    fn agent_tool_is_recognized_as_subagent_spawn() {
        // Claude Code 2.x renamed Task → Agent; both names must map to the
        // subagent marker (kind "subagent"), NOT the generic "Running tool
        // Agent" row — the alias gap left harness subagents invisible.
        for name in ["Task", "task", "Agent", "agent"] {
            assert!(is_subagent_tool_name(name), "{name} must be a subagent tool");
        }
        assert!(!is_subagent_tool_name("Bash"));
        for name in ["Task", "Agent"] {
            let meta = tool_meta_generic(name, &json!({
                "subagent_type": "research",
                "description": "Research inference",
                "prompt": "Go deep"
            }));
            assert_eq!(meta["kind"], "subagent", "{name} marker kind");
            assert_eq!(meta["role"], "research");
            assert_eq!(meta["detail"], "Research inference");
        }
    }

    #[test]
    fn parse_oneshot_text_extracts_each_cli_shape() {
        // Claude `--output-format json`: final text lives in `.result`.
        let claude = r#"{"type":"result","subtype":"success","result":"{\"type\":\"skill\"}","is_error":false}"#;
        assert_eq!(parse_oneshot_text("claude_code", claude).unwrap(), "{\"type\":\"skill\"}");
        // is_error=true surfaces the message instead of the text.
        let err = r#"{"type":"result","subtype":"error_max_turns","result":"hit turn cap","is_error":true}"#;
        assert!(parse_oneshot_text("claude_code", err).unwrap_err().contains("hit turn cap"));

        // Kimi stream-json: assistant content strings concatenate; non-assistant
        // roles and tool_calls blocks are ignored.
        let kimi = concat!(
            r#"{"role":"user","content":"gen"}"#, "\n",
            r#"{"role":"assistant","content":"{\"type\":"}"#, "\n",
            r#"{"role":"assistant","content":"\"loop\"}"}"#, "\n",
        );
        assert_eq!(parse_oneshot_text("kimi_code", kimi).unwrap(), "{\"type\":\"loop\"}");

        // OpenCode run-mode events: text parts carry FULL snapshots — only the
        // new suffix of each part may be appended or the JSON duplicates.
        let oc = concat!(
            r#"{"type":"step-start"}"#, "\n",
            r#"{"type":"text","part":{"text":"{\"type\":"}}"#, "\n",
            r#"{"type":"text","part":{"text":"{\"type\":\"skill\"}"}}"#, "\n",
        );
        assert_eq!(parse_oneshot_text("opencode", oc).unwrap(), "{\"type\":\"skill\"}");
    }

    #[test]
    fn sanitize_attachment_name_blocks_traversal_and_weird_chars() {
        // Path separators / traversal attempts collapse to safe components.
        assert_eq!(sanitize_attachment_name("..\\..\\evil.png"), "evil.png");
        // Traversal segments become inert text (".." stems collapse to the
        // "file" fallback); whatever comes out must never contain separators.
        let got = sanitize_attachment_name("../../etc/passwd");
        assert_eq!(got, "file.etc_passwd");
        assert!(!got.contains('/') && !got.contains('\\') && !got.starts_with('.'));
        assert_eq!(sanitize_attachment_name("my report (final).pdf"), "my_report_final.pdf");
        // Inner dots count as separators too ("Report v2.docx"-style names
        // stay readable enough) — only the LAST dot's extension survives verbatim.
        assert_eq!(sanitize_attachment_name("a.b.c.docx"), "a_b_c.docx");
        // Hidden/dot-only names and empty stems fall back (ext still kept).
        assert_eq!(sanitize_attachment_name(".gitignore"), "file.gitignore");
        assert_eq!(sanitize_attachment_name("..."), "file");
        assert_eq!(sanitize_attachment_name(""), "file");
        // Long names keep the extension, cap the stem.
        let long = format!("{}.pdf", "x".repeat(100));
        let got = sanitize_attachment_name(&long);
        assert_eq!(got.chars().count(), 60 + 4);
        assert!(got.ends_with(".pdf"));
    }

    #[test]
    fn decode_attachment_b64_rejects_junk() {
        assert_eq!(
            decode_attachment_b64("aGVsbG8="),
            Some(b"hello".to_vec())
        );
        assert_eq!(decode_attachment_b64("not base64 !!!"), None);
        assert_eq!(decode_attachment_b64(""), Some(Vec::new()));
    }

    #[test]
    fn can_use_tool_response_shapes() {
        let input = json!({"file_path": "C:/x.txt", "content": "hi"});
        let allow = can_use_tool_response("req-9", true, &input);
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["subtype"], "success");
        assert_eq!(allow["response"]["request_id"], "req-9");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(allow["response"]["response"]["updatedInput"], input);

        let deny = can_use_tool_response("req-9", false, &input);
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
        assert!(deny["response"]["response"]["message"]
            .as_str()
            .unwrap()
            .contains("denied"));
        // Deny must NOT echo updatedInput (the tool never runs).
        assert!(deny["response"]["response"].get("updatedInput").is_none());
    }

    #[test]
    fn ask_user_allow_response_carries_answers() {
        let input = json!({
            "questions": [
                { "question": "Which db?", "header": "DB",
                  "options": [{"label": "SQLite", "description": "embedded"},
                              {"label": "Postgres", "description": "server"}],
                  "multiSelect": false },
                { "question": "Extras?", "header": "Extras", "options": [],
                  "multiSelect": true }
            ]
        });
        let answers = json!({"Which db?": "SQLite", "Extras?": ["a", "b"]});
        let resp = ask_user_allow_response("req-7", &input, &answers, None);
        let updated = &resp["response"]["response"]["updatedInput"];
        assert_eq!(resp["response"]["response"]["behavior"], "allow");
        // The original questions array MUST be echoed back unchanged.
        assert_eq!(updated["questions"], input["questions"]);
        assert_eq!(updated["answers"]["Which db?"], "SQLite");
        assert_eq!(updated["answers"]["Extras?"], json!(["a", "b"]));
        // No free-text reply → no `response` field.
        assert!(updated.get("response").is_none());
    }

    #[test]
    fn ask_user_allow_response_free_text_and_garbage_answers() {
        let input = json!({"questions": [{"question": "Proceed?"}]});
        // A non-object answers payload must coerce to {} (never wedge the
        // protocol with a malformed updatedInput).
        let resp = ask_user_allow_response("req-8", &input, &json!("oops"), Some("  do it safely  "));
        let updated = &resp["response"]["response"]["updatedInput"];
        assert_eq!(updated["answers"], json!({}));
        // Free-text reply is trimmed and replaces the structured answers.
        assert_eq!(updated["response"], "do it safely");
    }

    use super::*;

    /// M13: a registered one-shot child (a cmd-wrapped tree, like automation
    /// spawns) must die with the app, and the kill must be idempotent —
    /// already-exited children are skipped so a recycled pid is never hit.
    #[test]
    #[cfg(windows)]
    fn kill_one_shot_children_kills_registered_trees() {
        // Sleeper tree mirroring the harness spawn shape: cmd.exe → ping.
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "ping 127.0.0.1 -n 60 >nul"]);
        no_console_window(&mut cmd);
        let child = cmd.spawn().unwrap();
        let child = Arc::new(Mutex::new(child));
        let pid = register_one_shot_child(&child).expect("must register");
        std::thread::sleep(Duration::from_millis(300)); // let the tree start

        kill_one_shot_children();

        let status = child.lock().unwrap().try_wait().unwrap();
        assert!(status.is_some(), "registered one-shot child survived the kill");
        assert!(
            ONE_SHOT_CHILDREN.lock().unwrap().get(&pid).is_none(),
            "registry must be drained after the kill"
        );
        // Idempotent re-run: no registered children, no pid-recycle hazard.
        kill_one_shot_children();
    }

    /// OpenCode "text" events carry the full snapshot of a part's text, not a
    /// delta: only the new suffix must reach `full`/the token stream, and a
    /// non-extending snapshot starts a new part (emitted whole).
    #[test]
    fn opencode_text_events_emit_only_new_suffix() {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let mut last = String::new();
        let mut last_reasoning = String::new();
        let mut in_think = false;
        let (mut input, mut output, mut cost) = (None, None, None);
        let mut tools = ToolTracker::new();
        let ev = |t: &str| json!({ "type": "text", "part": { "text": t } });
        let mut feed = |v: &Value, full: &mut String, last: &mut String| {
            handle_opencode_event(None, "s", v, full, &cell, &mut input, &mut output, &mut cost, last, &mut last_reasoning, &mut in_think, &mut tools);
        };
        feed(&ev("Hello"), &mut full, &mut last);
        feed(&ev("Hello, world"), &mut full, &mut last);
        assert_eq!(full, "Hello, world");
        feed(&ev("Hello, world!"), &mut full, &mut last);
        assert_eq!(full, "Hello, world!");
        // A snapshot that doesn't extend the previous one is a new part.
        feed(&ev("Next part"), &mut full, &mut last);
        assert_eq!(full, "Hello, world!Next part");
    }

    #[test]
    fn opencode_reasoning_wraps_in_think_and_text_closes_it() {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let (mut input, mut output, mut cost) = (None, None, None);
        let mut last_text = String::new();
        let mut last_reasoning = String::new();
        let mut in_think = false;
        let mut tools = ToolTracker::new();
        let mut feed = |v: &Value,
                        full: &mut String,
                        last_text: &mut String,
                        last_reasoning: &mut String,
                        in_think: &mut bool| {
            handle_opencode_event(None, "s", v, full, &cell, &mut input, &mut output, &mut cost, last_text, last_reasoning, in_think, &mut tools);
        };
        // Reasoning snapshots stream as suffixes inside one <think> block.
        feed(&json!({ "type": "reasoning", "part": { "text": "Think" } }), &mut full, &mut last_text, &mut last_reasoning, &mut in_think);
        assert!(in_think);
        feed(&json!({ "type": "reasoning", "part": { "text": "Thinking…" } }), &mut full, &mut last_text, &mut last_reasoning, &mut in_think);
        assert_eq!(full, "<think>Thinking…");
        // The first real text part closes the block before appending.
        feed(&json!({ "type": "text", "part": { "text": "Answer" } }), &mut full, &mut last_text, &mut last_reasoning, &mut in_think);
        assert!(!in_think);
        assert_eq!(full, "<think>Thinking…</think>Answer");
    }

    #[test]
    fn opencode_server_tool_transitions_dedup_markers() {
        let full_cell = Arc::new(Mutex::new(String::new()));
        let think_cell = Arc::new(Mutex::new(false));
        let mut tools = ToolTracker::new();
        let mut states: HashMap<String, u8> = HashMap::new();

        let running = json!({
            "id": "prt_1", "type": "tool", "tool": "bash",
            "state": { "status": "running", "input": { "command": "ls" } }
        });
        emit_opencode_tool(None, "s", &running, &full_cell, &think_cell, &mut tools, &mut states);
        {
            let f = full_cell.lock().unwrap();
            // Exactly ONE call card while running — repeated updates dedup.
            assert_eq!(f.matches("<tool>").count(), 1);
            assert!(f.contains("ls"));
            assert!(!f.contains("\"kind\":\"result\""));
        }

        let completed = json!({
            "id": "prt_1", "type": "tool", "tool": "bash",
            "state": { "status": "completed", "input": { "command": "ls" }, "output": "file.txt" }
        });
        emit_opencode_tool(None, "s", &completed, &full_cell, &think_cell, &mut tools, &mut states);
        {
            let f = full_cell.lock().unwrap();
            // Result marker attached exactly once for the shell step.
            assert_eq!(f.matches("\"kind\":\"result\"").count() + f.matches("\"kind\": \"result\"").count(), 1);
        }

        // A late duplicate completion must not attach another result.
        emit_opencode_tool(None, "s", &completed, &full_cell, &think_cell, &mut tools, &mut states);
        {
            let f = full_cell.lock().unwrap();
            assert_eq!(f.matches("\"kind\":\"result\"").count() + f.matches("\"kind\": \"result\"").count(), 1);
        }

        // A tool that arrives already-finished is self-contained.
        let done = json!({
            "id": "prt_2", "type": "tool", "tool": "bash",
            "state": { "status": "completed", "input": { "command": "pwd" }, "output": "/tmp" }
        });
        emit_opencode_tool(None, "s", &done, &full_cell, &think_cell, &mut tools, &mut states);
        {
            let f = full_cell.lock().unwrap();
            assert_eq!(f.matches("\"kind\":\"result\"").count() + f.matches("\"kind\": \"result\"").count(), 2);
        }
    }

    #[test]
    fn opencode_sse_data_routes_parts_and_filters_sessions() {
        let session_cell = Arc::new(Mutex::new(Some("ses_mine".to_string())));
        let full_cell = Arc::new(Mutex::new(String::new()));
        let think_cell = Arc::new(Mutex::new(false));
        let quiet = Arc::new(AtomicU64::new(0));
        let mut last_text = String::new();
        let mut last_reasoning = String::new();
        let mut tools = ToolTracker::new();
        let mut states: HashMap<String, u8> = HashMap::new();
        let mut roles: HashMap<String, String> = HashMap::new();
        let mut part_kinds: HashMap<String, String> = HashMap::new();
        let mut cur_text_part = String::new();
        let mut cur_reasoning_part = String::new();
        let mut feed = |data: &str,
                        last_text: &mut String,
                        last_reasoning: &mut String,
                        tools: &mut ToolTracker,
                        states: &mut HashMap<String, u8>,
                        roles: &mut HashMap<String, String>,
                        part_kinds: &mut HashMap<String, String>,
                        cur_text_part: &mut String,
                        cur_reasoning_part: &mut String| {
            handle_opencode_sse_data(
                None,
                "s",
                data,
                &session_cell,
                &full_cell,
                &think_cell,
                &quiet,
                last_text,
                last_reasoning,
                tools,
                states,
                roles,
                part_kinds,
                cur_text_part,
                cur_reasoning_part,
            );
        };

        // NOTE: the reader strips the `data:` prefix before calling us, so
        // these payloads are bare JSON.

        // message.updated first (observed server ordering), then the USER
        // prompt echo — which must NOT land in the reply buffer.
        feed(
            r#"{"type":"message.updated","properties":{"info":{"id":"msg_u","role":"user"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","messageID":"msg_u","part":{"type":"text","text":"tell me a story","messageID":"msg_u"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert!(
            full_cell.lock().unwrap().is_empty(),
            "user-message parts must be filtered from the reply"
        );

        feed(
            r#"{"type":"message.updated","properties":{"info":{"id":"msg_a","role":"assistant"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );

        // Live streaming path: empty snapshot announces the reasoning part,
        // token deltas stream in, final snapshot reconciles to no-op.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_r1","type":"reasoning","text":"","messageID":"msg_a"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>");
        for d in ["Thi", "nking", "…"] {
            let payload = format!(
                r#"{{"type":"message.part.delta","properties":{{"sessionID":"ses_mine","messageID":"msg_a","partID":"prt_r1","field":"text","delta":"{d}"}}}}"#
            );
            feed(&payload, &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
                &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part);
        }
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…");
        // Final full snapshot for the reasoning part reconciles to a no-op.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_r1","type":"reasoning","text":"Thinking…","messageID":"msg_a"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…");

        // Text part: empty snapshot closes the think block, then deltas.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_t1","type":"text","text":"","messageID":"msg_a"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>");
        for d in ["H", "i"] {
            let payload = format!(
                r#"{{"type":"message.part.delta","properties":{{"sessionID":"ses_mine","messageID":"msg_a","partID":"prt_t1","field":"text","delta":"{d}"}}}}"#
            );
            feed(&payload, &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
                &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part);
        }
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_t1","type":"text","text":"Hi","messageID":"msg_a"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>Hi");

        // A SECOND text part (e.g. after tool calls) must not duplicate its
        // snapshot against the previous part's flat baseline.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_t2","type":"text","text":"more","messageID":"msg_a"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>Himore");

        // Other sessions' traffic stays filtered.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_other","part":{"id":"prt_x","type":"text","text":"IGNORED","messageID":"msg_x"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>Himore");

        // Non-part events are ignored but still bump the quiet timestamp.
        quiet.store(0, Ordering::Relaxed);
        feed(
            r#"{"type":"session.status","properties":{"status":{"type":"busy"}}}"#,
            &mut last_text, &mut last_reasoning, &mut tools, &mut states, &mut roles,
            &mut part_kinds, &mut cur_text_part, &mut cur_reasoning_part,
        );
        assert!(quiet.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn opencode_model_split_variants() {
        let m = split_opencode_model("sharkai/glm-5.2").unwrap();
        assert_eq!(m["providerID"], "sharkai");
        assert_eq!(m["modelID"], "glm-5.2");
        // Provider ids may contain slashes? OpenCode's format is provider/id
        // with the FIRST slash separating; model ids never contain slashes.
        let m = split_opencode_model("a/b/c");
        assert!(m.is_some());
        assert!(split_opencode_model("").is_none());
        assert!(split_opencode_model("nomodel").is_none());
        assert!(split_opencode_model("/x").is_none());
        assert!(split_opencode_model("x/").is_none());
    }

    /// The dir diff reports NEW and MODIFIED files with previewable
    /// extensions only: unchanged files, unsupported extensions and skipped
    /// dirs (node_modules, hidden) never surface.
    #[test]
    fn dir_diff_detects_new_and_modified_previewable_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("keep.txt"), "v1").unwrap();
        std::fs::write(dir.join("notes.bin"), "x").unwrap();
        let before = snapshot_dir(dir);

        std::fs::write(dir.join("keep.txt"), "v1-longer").unwrap(); // modified
        std::fs::write(dir.join("notes.bin"), "xxx").unwrap(); // modified, unsupported ext
        std::fs::write(dir.join("report.md"), "# hi").unwrap(); // new
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/data.csv"), "a,b").unwrap(); // new, nested
        std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
        std::fs::write(dir.join("node_modules/dep/index.js"), "1").unwrap(); // skipped dir
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/secret.md"), "s").unwrap(); // hidden dir

        let after = snapshot_dir(dir);
        assert_eq!(
            changed_previewable_files(&before, &after),
            vec![
                "keep.txt".to_string(),
                "report.md".to_string(),
                "sub/data.csv".to_string(),
            ]
        );
        // Diffing an unchanged tree reports nothing.
        let again = snapshot_dir(dir);
        assert!(changed_previewable_files(&after, &again).is_empty());
    }

    /// The artifact watch covers BOTH the spawn dir and the configured
    /// artifacts dir: conduit-tools MCP writes into `storage.artifactsDir`
    /// regardless of the CLI's workspace, so a project-selected turn (or a
    /// custom folder) must still surface MCP-generated files.
    #[test]
    fn turn_watch_dirs_includes_configured_artifacts_dir() {
        let proj = tempfile::tempdir().unwrap();
        let arts = tempfile::tempdir().unwrap();
        let conn = crate::db::mem();
        crate::db::set_setting(
            &conn,
            crate::chat::dispatch::ARTIFACTS_DIR_SETTING_KEY,
            arts.path().to_str().unwrap(),
        )
        .unwrap();
        let db = Arc::new(parking_lot::Mutex::new(conn));
        let dirs = turn_watch_dirs(Some(proj.path().to_str().unwrap()), &db);
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap();
        assert_eq!(dirs.len(), 2, "spawn dir + configured artifacts dir: {dirs:?}");
        assert_eq!(canon(&dirs[0]), canon(proj.path()));
        assert_eq!(canon(&dirs[1]), canon(arts.path()));
    }

    /// With no project and no configured dir, the spawn dir and the artifacts
    /// fallback are the same <Documents>/Conduit — the watch must dedup to
    /// one dir, not snapshot the same tree twice.
    #[test]
    fn turn_watch_dirs_dedups_when_dirs_coincide() {
        let conn = crate::db::mem();
        let db = Arc::new(parking_lot::Mutex::new(conn));
        let dirs = turn_watch_dirs(None, &db);
        assert_eq!(dirs.len(), 1, "{dirs:?}");
    }
}
