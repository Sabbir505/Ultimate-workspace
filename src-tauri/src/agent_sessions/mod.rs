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
//! in-app scheduler and from the standalone `relay-automation` binary.

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
    /// B-8: the OUTER map lock is held only for map insert/remove/lookup;
    /// each entry's INNER lock covers that session's (potentially slow) turn
    /// setup — primer build, DB writes, bundle file I/O, checkpoint git
    /// snapshot, process spawn/wait-ready. Holding the global lock across
    /// all of that used to freeze cancel / permission-mode / remove for
    /// EVERY session behind one slow send.
    sessions: Mutex<HashMap<String, Arc<Mutex<AgentChild>>>>,
    /// Live RELAY_ASK questions (harnesses with no native ask protocol):
    /// chat session id → the question payload plus the pending_id the UI
    /// answers with. The claude control protocol uses ChatManager's
    /// oneshot registry instead — these have no reader blocked on stdin;
    /// the answer dispatches a follow-up turn (see dispatch_ask_follow_up).
    pending_asks: Mutex<HashMap<String, PendingAsk>>,
}

/// How an answered question reaches the model. Two producers share the
/// question card:
/// - `FollowUpTurn`: the RELAY_ASK marker channel (no native mechanism) —
///   the answer rides as a follow-up user turn on the resumed session.
/// - `OpenCode`: opencode's NATIVE `question` tool — the server parks the
///   turn on the request until we POST the answer to its reply endpoint.
pub enum PendingAskRoute {
    FollowUpTurn,
    OpenCode {
        base_url: String,
        oc_session_id: String,
        request_id: String,
    },
}

/// One surfaced question awaiting the user's answer.
pub struct PendingAsk {
    pub pending_id: String,
    /// Normalized `questions` array (same shape ChatQuestionRequestPayload
    /// carries to the UI).
    pub questions: serde_json::Value,
    pub route: PendingAskRoute,
}

/// Everything a follow-up turn needs to run in the SAME workspace as the
/// turn that asked the question. Snapshotted on every send.
#[derive(Clone)]
pub struct SendCtx {
    cwd: Option<String>,
    project_id: Option<String>,
    connectors: Arc<Vec<crate::connectors::HarnessMcpServer>>,
}

impl Default for SendCtx {
    fn default() -> Self {
        Self {
            cwd: None,
            project_id: None,
            connectors: Arc::new(Vec::new()),
        }
    }
}

/// Every reasoning-effort/thinking tier ANY harness accepts (claude `--effort`
/// low|medium|high|xhigh|max; omp/pi `--thinking` off|minimal|low|medium|high|
/// xhigh|max; kimi's `KIMI_MODEL_THINKING_EFFORT` low|medium|high — its
/// "max-to-high" migration retired "max"). The union is the session-tier
/// whitelist: one stored vocabulary, filtered per harness in the picker.
pub const EFFORT_TIERS: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Session-effort validation for the command layer. Empty = "Default" (clears
/// the tier). Anything outside [`EFFORT_TIERS`] is rejected — the value later
/// rides spawn argv/env, so junk never reaches a CLI.
pub fn is_valid_effort(effort: &str) -> bool {
    let e = effort.trim();
    e.is_empty() || EFFORT_TIERS.contains(&e)
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
    /// claude_code: the effort tier the persistent process was spawned with
    /// (`--effort` is baked into the CLI invocation; None = "Default", no
    /// flag). A changed tier respawns on the next send — same contract as
    /// `spawned_mode`.
    spawned_effort: Option<String>,
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
    /// Workspace snapshot of the LAST send (cwd/project/connectors), so a
    /// RELAY_ASK follow-up turn can run where the asking turn ran.
    send_ctx: std::sync::Mutex<Option<SendCtx>>,
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
    /// Audit #87: false once the SSE reader has exited (connection dropped /
    /// stream error / clean close). The turn thread checks it before
    /// finish_turn: a POST that "succeeded" while the reader was dead means
    /// the streamed text never arrived — previously persisted as an EMPTY
    /// reply with no error. The reader also revives it (sets true) on start.
    oc_reader_alive: Arc<AtomicBool>,
}

impl AgentSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_asks: Mutex::new(HashMap::new()),
        }
    }

    /// Register a surfaced question: the UI answers via
    /// `resolve_agent_question`, which routes by `route`. One pending
    /// question per chat.
    pub fn register_pending_ask(
        &self,
        chat_session_id: &str,
        questions: serde_json::Value,
        route: PendingAskRoute,
    ) -> String {
        let pending_id = crate::chat::proto::next_synthetic_tool_id();
        self.pending_asks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                chat_session_id.to_string(),
                PendingAsk {
                    pending_id: pending_id.clone(),
                    questions,
                    route,
                },
            );
        pending_id
    }

    /// Take a pending ask out of the registry (on resolve or cancel).
    pub fn take_pending_ask(&self, chat_session_id: &str) -> Option<PendingAsk> {
        self.pending_asks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(chat_session_id)
    }

    /// Take the pending ask ONLY if it is still the one the UI is answering.
    /// A stale resolve (answer raced a replacement question) must leave the
    /// newer pending in place — an unconditional take here used to consume
    /// the replacement, so the next answer found an empty registry and the
    /// harness waited on stdin forever.
    pub fn take_pending_ask_if(
        &self,
        chat_session_id: &str,
        expected_pending_id: &str,
    ) -> Option<PendingAsk> {
        let mut asks = self.pending_asks.lock().unwrap_or_else(|e| e.into_inner());
        match asks.get(chat_session_id) {
            Some(pending) if pending.pending_id == expected_pending_id => {
                asks.remove(chat_session_id)
            }
            _ => None,
        }
    }

    /// Block until the session's in-flight turn clears. A harness question is
    /// registered MID-TURN (the marker/tool call arrives while the asking
    /// turn is still streaming), so a fast answer lands while
    /// `turn_in_flight` is still set — dispatching then makes `send` reject
    /// with "a turn is already running" and the answer was silently lost.
    /// The follow-up must wait for the asking turn to end. Returns false on
    /// timeout (caller surfaces the failure instead of dropping the answer).
    pub fn wait_for_turn_idle(&self, chat_session_id: &str, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let in_flight = {
                let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
                match sessions.get(chat_session_id) {
                    Some(entry) => entry
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .turn_in_flight
                        .load(Ordering::SeqCst),
                    None => false,
                }
            };
            if !in_flight {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    /// Dispatch the follow-up turn for a resolved harness question: the
    /// answer rides as a normal user message, so the CLI's own session resume
    /// (kimi `--session`, opencode server session, pi `--session`, omp /
    /// commandcode `--resume`) carries the conversation forward, and the
    /// asking turn's workspace snapshot (cwd/project/connectors) keeps the
    /// follow-up in the same directory.
    pub fn dispatch_ask_follow_up(
        &self,
        app: &AppHandle,
        db: &DbState,
        chat_session_id: &str,
        content: &str,
    ) -> Result<(), String> {
        let (harness, model, ctx) = {
            let entry = {
                let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
                sessions
                    .get(chat_session_id)
                    .cloned()
                    .ok_or_else(|| "no agent session for this chat".to_string())?
            };
            let g = entry.lock().unwrap_or_else(|e| e.into_inner());
            let ctx = g
                .send_ctx
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_default();
            (g.harness.clone(), g.model.clone(), ctx)
        };
        if ctx.cwd.is_none() {
            return Err(
                "no recorded workspace for this session — send a message first".to_string(),
            );
        }
        self.send(
            app,
            db,
            chat_session_id,
            content,
            "",
            &harness,
            &model,
            ctx.cwd.as_deref(),
            ctx.project_id.as_deref(),
            &ctx.connectors,
            None,
        )
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
        // B-8: the global map lock is held ONLY for the lookup/insert below;
        // everything after runs under the PER-SESSION lock, so a slow setup
        // (git snapshot, harness spawn, wait-ready) for one chat no longer
        // blocks cancel/remove/permission-mode for every other chat.
        let entry = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            Arc::clone(
                sessions
                    .entry(chat_session_id.to_string())
                    .or_insert_with(|| {
                        // Restore a previously captured CLI session id (persisted by
                        // the reader thread at end of turn) so conversation context
                        // survives app restarts, not just cancels.
                        let stored = {
                            let conn = db.0.lock();
                            crate::db::get_setting(
                                &conn,
                                &cli_session_key(harness, chat_session_id),
                            )
                            .ok()
                            .flatten()
                        };
                        Arc::new(Mutex::new(AgentChild {
                            harness: harness.to_string(),
                            model: model.to_string(),
                            child: None,
                            spawned_model: None,
                            spawned_mode: None,
                            spawned_effort: None,
                            cli_session_id: Arc::new(Mutex::new(stored)),
                            turn_in_flight: Arc::new(AtomicBool::new(false)),
                            reader_alive: Arc::new(AtomicBool::new(false)),
                            proc_generation: Arc::new(AtomicU64::new(0)),
                            cancelled: Arc::new(AtomicBool::new(false)),
                            stdin: Arc::new(Mutex::new(None)),
                            acp_pending: Arc::new(Mutex::new(None)),
                            acp_request_id: Arc::new(Mutex::new(None)),
                            send_ctx: std::sync::Mutex::new(None),
                            oc_base_url: None,
                            oc_full: Arc::new(Mutex::new(String::new())),
                            oc_in_think: Arc::new(Mutex::new(false)),
                            oc_last_event_ms: Arc::new(AtomicU64::new(0)),
                            oc_reader_alive: Arc::new(AtomicBool::new(false)),
                        }))
                    }),
            )
        };
        let mut entry = entry.lock().unwrap_or_else(|e| e.into_inner());
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
            entry.spawned_effort = None;
            if let Ok(mut g) = entry.cli_session_id.lock() {
                *g = None;
            }
        }
        entry.model = model.to_string();

        // Workspace snapshot for RELAY_ASK follow-up turns: the answer turn
        // must run where the asking turn ran (same cwd/project/connectors).
        *entry.send_ctx.lock().unwrap_or_else(|e| e.into_inner()) = Some(SendCtx {
            cwd: cwd.map(|c| c.to_string()),
            project_id: project_id.map(|p| p.to_string()),
            connectors: Arc::new(connectors.to_vec()),
        });

        // Context primer for a fresh CLI session (see the module-level notes):
        // gated on cli_session_id AFTER the harness-switch teardown above — the
        // teardown is exactly what turns the id to None on an engine switch, so
        // the gate must be evaluated afterwards. Built BEFORE the user message
        // below is persisted, so the transcript covers only prior turns; this
        // turn's message rides in `content` verbatim.
        let fresh_cli = entry
            .cli_session_id
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .is_none();
        let context_primer = if fresh_cli {
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
            crate::db::add_chat_message(
                &conn,
                crate::db::NewChatMessage {
                    chat_session_id: chat_session_id,
                    role: "user",
                    content: content,
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
        }

        // Prepend the Relay persona + the user's custom system prompt
        // (Settings → Assistant) so the harness CLI presents the same identity
        // the built-in chat does — without it the CLI answers "I'm Claude
        // Code / OpenCode" and denies being Relay. The persona goes FIRST,
        // the custom prompt after it, both separated from the message by a
        // blank line. The original content is persisted to the DB without the
        // prefix (the system prompt is separate config, not part of the
        // message). The attachment appendix goes LAST — after the persona and
        // the typed text — so file paths/text read as an addendum to the
        // user's words.
        let harness_label = harness_label(harness);
        let persona = harness_persona(harness_label);
        // Adapters without a system-prompt flag (opencode/pi/omp/commandcode)
        // get the bundle instructions prepended to their FIRST turn — the
        // fresh-session gate mirrors the context primer's, so resumed turns
        // ride the CLI's own context without re-paying the tokens. claude and
        // kimi receive the same content via --append-system-prompt-file /
        // --agent-file and must NOT get it twice. Failure degrades to no
        // prefix (same contract as bundle failure everywhere else).
        let instructions_prefix = if fresh_cli && harness_needs_prompt_instructions(harness) {
            resolve_harness_bundle(
                app,
                project_id,
                cwd,
                artifacts_dir_for_bundle(app, cwd),
                connectors,
                None,
                None,
            )
            .and_then(|b| std::fs::read_to_string(&b.claude_instructions).ok())
            .filter(|s| !s.trim().is_empty())
        } else {
            None
        };
        let effective = {
            let conn = db.0.lock();
            let custom: Option<String> = crate::db::get_setting(&conn, "assistant.systemPrompt")
                .ok()
                .flatten();
            let mut base = match &instructions_prefix {
                Some(ins) => format!("{ins}\n\n"),
                None => String::new(),
            };
            base.push_str(&persona);
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
        // The question channel rides EVERY turn of the no-native-ask
        // harnesses (not just fresh sessions): bundle instructions only go
        // out on the first turn, but the model must know the marker exists
        // whenever it might need a decision.
        let effective = if harness_question_channel(harness) {
            format!("{effective}\n\n{RELAY_ASK_DIRECTIVE}")
        } else {
            effective
        };

        // Checkpoint baseline: snapshot the spawn dir's working tree once per
        // session before the CLI starts touching files (checkpoint 0 =
        // pre-chat state). Non-repo dirs (artifacts folder) skip silently.
        if let Some(dir) = spawn_dir(cwd, &db.0) {
            let conn = db.0.lock();
            crate::checkpoints::maybe_baseline(Some(app), &conn, chat_session_id, &dir);
        }

        // `entry` is now a MutexGuard (per-session lock — B-8); the turn
        // helpers take `&mut AgentChild`.
        let entry = &mut *entry;
        match harness {
            "claude_code" => send_claude_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                connectors,
            ),
            "kimi_code" => spawn_per_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                PerTurn::Kimi,
                connectors,
            ),
            "opencode" => send_opencode_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                connectors,
            ),
            "pi" => spawn_per_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                PerTurn::Pi,
                connectors,
            ),
            "omp" => spawn_per_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                PerTurn::Omp,
                connectors,
            ),
            "commandcode" => spawn_per_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                PerTurn::CommandCode,
                connectors,
            ),
            s if s.starts_with("acp:") => send_acp_turn(
                app,
                db,
                chat_session_id,
                &effective,
                entry,
                cwd,
                project_id,
                &s[4..],
            ),
            other => Err(format!(
                "harness '{other}' has no headless chat backend yet"
            )),
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
        // B-8: clone the entry Arc out, drop the global map lock, then take
        // the per-session lock — teardown for one session must not queue
        // behind the global map while another chat's send runs its setup.
        let entry = {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.get(chat_session_id).cloned()
        };
        if let Some(entry) = entry {
            let mut entry = entry.lock().unwrap_or_else(|e| e.into_inner());
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
                            let line = crate::acp::encode_notification(
                                "request/cancel",
                                &json!({ "requestId": rid }),
                            );
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
        // Same for a surfaced RELAY_ASK question: the answer would dispatch
        // a follow-up turn on a session the user just cancelled.
        self.pending_asks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(chat_session_id);
        emit_done(
            Some(app),
            chat_session_id,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
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
        // Best-effort live-apply — NEVER block the calling thread. This runs
        // from sync commands on the MAIN thread; contended locks → false: the
        // deterministic mode-mismatch respawn in `send_claude_turn` applies
        // the change on the next send anyway. B-8 moved a send's slow setup
        // under the PER-SESSION lock, so a miss here now only means "that
        // one session is mid-turn" (the global map lock is map-ops only).
        let entry = {
            let Ok(sessions) = self.sessions.try_lock() else {
                return false;
            };
            sessions.get(chat_session_id).cloned()
        };
        let Some(entry) = entry else {
            return false;
        };
        let Ok(entry) = entry.try_lock() else {
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
            "request_id": format!("relay-setmode-{}", now_ms_u64()),
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
        // B-8: map lock for the remove, per-session lock for the teardown.
        let entry = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.remove(chat_session_id)
        };
        if let Some(entry) = entry {
            let mut entry = entry.lock().unwrap_or_else(|e| e.into_inner());
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
        self.pending_asks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(chat_session_id);
    }

    /// Kill all children (app shutdown).
    pub fn kill_all(&self) {
        // E-6: poison recovery, same as send/cancel — shutdown must kill
        // every child even when a panic poisoned the lock.
        // B-8: drain under the map lock, then take each entry's per-session
        // lock for the kill. A session whose send is mid-setup delays only
        // its own kill (bounded by that setup), not every other session's.
        let drained: Vec<Arc<Mutex<AgentChild>>> = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.drain().map(|(_, entry)| entry).collect()
        };
        for entry in drained {
            let mut c = entry.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut child) = c.child.take() {
                kill_child_tree(&mut child);
            }
        }
    }
}

mod lifecycle;
mod primer;
mod attachments;

// Used only by the inline attachment tests below in non-test builds.
#[cfg_attr(not(test), allow(unused_imports))]
use attachments::*;
mod acp;
mod dirwatch;
mod bundle;
mod claude;
mod perturn;
mod ask;
mod opencode;
mod handlers;
mod oneshot;
mod tracker;

use lifecycle::*;
use lifecycle::cli_session_key;
use primer::*;
use acp::*;
use dirwatch::*;
use bundle::*;
use claude::*;
use perturn::*;
use ask::*;
use opencode::*;
use handlers::*;
use oneshot::*;
use tracker::*;

pub(crate) use oneshot::{harness_oneshot_text, run_one_shot};
pub(crate) use tracker::tool_meta_generic;
pub(crate) use ask::{build_opencode_reply_answers, compose_ask_follow_up, opencode_answer_question};
pub(crate) use attachments::prepare_agent_attachments;
pub(crate) use bundle::{artifacts_dir_for_bundle, resolve_harness_bundle};
pub(crate) use dirwatch::previewable_ext;
pub(crate) use lifecycle::{kill_child_tree, kill_one_shot_children};
pub(crate) use primer::{actual_model_key, build_primer_summary, persist_actual_model};
/// kill them (M13): `run_one_shot` spawns a full `--dangerously-skip-permissions`
/// CLI tree that is NOT in the session registry — without this it keeps
/// running after the app quits. Keyed by pid; entries are removed when the
/// child is reaped, and the kill path skips children that already exited, so
/// a recycled pid can never be hit. BTreeMap only because `BTreeMap::new` is



#[allow(unused_imports)]

// ---------------------------------------------------------------- shared emit/persist

/// First present integer among `keys` on a usage object. Harnesses disagree on
/// cache-field names (claude: snake_case `cache_read_input_tokens`, pi:
/// `cacheRead`, commandcode: `cacheReadTokens`), so handlers match every known
/// spelling and take the first that's there.
fn usage_i64(u: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| u.get(*k).and_then(|t| t.as_i64()))
}

/// Turn finished successfully: persist the accumulated assistant message
/// (mirroring the built-in chat, so onDone's refetch sees it), surface any
/// files the CLI created or modified as artifacts (same insert_artifact +
/// `chat:artifact` emit as the built-in chat in chat/dispatch.rs), then emit
/// done.
///
/// The cache fields carry the harness's own split of its input tokens:
/// `input` is the UNCACHED portion only for claude-style reports, so a turn
/// whose prompt was mostly cache hits legitimately records a small `input`
/// alongside a large `cache_read`. Persisting the split (instead of folding
/// it into input or dropping it) is what lets session metrics and the cost
/// rollup bill cached tokens at the cached rate like the built-in chat does.
#[allow(clippy::too_many_arguments)]
fn finish_turn(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    full: &mut String,
    input: Option<i64>,
    output: Option<i64>,
    cost: Option<f64>,
    cache_creation: Option<i64>,
    cache_read: Option<i64>,
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
        "[context] harness turn: session={} model='{}' in={} out={} cache_write={} cache_read={}",
        sid,
        model_key.unwrap_or("—"),
        input.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
        output.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
        cache_creation
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".into()),
        cache_read
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".into()),
    );
    // Pull the harness turn's final perf from the active accumulator (before
    // it's unregistered below). TTFT and tok/s are measured for every
    // harness; LLM time is measurable for streams with recognizable
    // model-round boundaries (claude message_start/stop, opencode steps). The
    // tool-time split stays unavailable — the CLI executes tools as a black
    // box. Hoisted above the persist block so emit_done carries the same
    // numbers even for turns whose reply text ended up empty.
    let (ttft, tok_s, llm_ms) = crate::chat::turn_perf::active_harness_final(sid, output);

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
        crate::db::add_chat_message(
            &conn,
            crate::db::NewChatMessage {
                chat_session_id: sid,
                role: "assistant",
                content: full,
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost,
                cache_creation_input_tokens: cache_creation,
                cache_read_input_tokens: cache_read,
                reasoning_output_tokens: None,
                provider: Some(provider),
                model_key: model_key,
                pricing_estimated_usd: None,
                started_at: Some(started_at),
                completed_at: Some(crate::db::now_ts()),
                llm_time_ms: llm_ms,
                tool_time_ms: None,
                ttft_ms: ttft,
                tokens_per_second: tok_s,
            },
        )
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

    emit_done(
        app,
        sid,
        input,
        output,
        cost,
        cache_creation,
        cache_read,
        ttft,
        tok_s,
        llm_ms,
    );

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

#[allow(clippy::too_many_arguments)]
fn emit_done(
    app: Option<&AppHandle>,
    sid: &str,
    input: Option<i64>,
    output: Option<i64>,
    cost: Option<f64>,
    cache_creation: Option<i64>,
    cache_read: Option<i64>,
    // Final harness-turn perf, measured by the turn's accumulator and already
    // persisted on the assistant row. The built-in chat's ChatDonePayload
    // carries the same fields — omitting them here made the composer metrics
    // row drop TTFT/speed/elapsed for harness sessions even when measured.
    ttft: Option<i64>,
    tokens_per_second: Option<f64>,
    llm_time_ms: Option<i64>,
) {
    if let Some(app) = app {
        // Cache fields ride along when the harness reported them (absent →
        // null, so older frontend consumers keep working unchanged). `input`
        // is the uncached slice for claude-style reports; the frontend uses
        // the split to show the same IN/CACHE breakdown the built-in chat
        // gets — including the cacheHitRate chip (same math as
        // turn_perf::cache_hit_rate; harness reports are all exclusive).
        let cache_hit_rate = crate::chat::turn_perf::cache_hit_rate(
            cache_read.unwrap_or(0),
            cache_creation.unwrap_or(0),
            input.unwrap_or(0),
            false,
        );
        let _ = app.emit(
            "chat:done",
            json!({
                "chatSessionId": sid,
                "inputTokens": input,
                "outputTokens": output,
                "costUsd": cost,
                "cacheCreationInputTokens": cache_creation,
                "cacheReadInputTokens": cache_read,
                "cacheHitRate": cache_hit_rate,
                "llmTimeMs": llm_time_ms,
                "toolTimeMs": null,
                "ttftMs": ttft,
                "tokensPerSecond": tokens_per_second,
            }),
        );
    }
}

pub(crate) fn emit_error(app: Option<&AppHandle>, sid: &str, message: &str) {
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
        conn,
        crate::db::NewChatMessage {
            chat_session_id: sid,
            role: "system",
            content: &marker,
            ..Default::default()
        },
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

    #[test]
    fn truncate_output_never_panics_on_multibyte_tail_boundary() {
        // The byte-slice regression: a body whose length crosses MAX_BYTES
        // with a multibyte char straddling the old `len - MAX_BYTES` cut used
        // to panic — on the opencode turn thread, wedging the chat with
        // turn_in_flight stuck true. ASCII prefix + CJK tail lands the cut
        // mid-char by construction.
        let mut s = "a".repeat(7_999);
        s.push_str("日本語テキスト");
        let out = truncate_output(&s);
        assert!(out.contains("日本語テキスト") || out.starts_with('…'));
        assert!(
            !out.contains('\u{FFFD}') || out.starts_with('…'),
            "tail kept must be char-aligned"
        );

        // Same straddle with emoji (4-byte UTF-8).
        let mut s2 = "b".repeat(8_001);
        s2.push_str("🎉🎉🎉");
        let out2 = truncate_output(&s2);
        assert!(!out2.is_empty());

        // Over-MAX_LINES path still truncates earlier lines.
        let many = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let out3 = truncate_output(&many);
        assert!(out3.contains("earlier lines truncated"));
        assert!(out3.contains("line99"), "keeps the newest lines");
    }

    #[test]
    fn stderr_suffix_flattens_and_caps_tail() {
        // Empty/whitespace stderr → empty suffix (no dangling " — stderr:").
        assert_eq!(stderr_suffix(""), "");
        assert_eq!(stderr_suffix("  \n\t "), "");
        // Newlines flatten so the message stays one line in toasts/history.
        let s = stderr_suffix("stream error\nAI_APICallError: quota exhausted\n");
        assert!(!s.contains('\n'), "{s}");
        assert!(
            s.starts_with(" — stderr: stream error AI_APICallError"),
            "{s}"
        );
        // The TAIL is kept (the last logged line is the one that mattered),
        // char-safe even when the cut lands mid-CJK.
        let long = "日".repeat(500);
        let s = stderr_suffix(&long);
        assert_eq!(s.chars().count(), " — stderr: ".chars().count() + 400);
        assert!(s.is_char_boundary(s.len()));
    }

    /// Reader-state snapshot the handler tests assert against.
    struct UsageState {
        full: String,
        cell: Arc<Mutex<Option<String>>>,
        input: Option<i64>,
        output: Option<i64>,
        cache_read: Option<i64>,
        cache_creation: Option<i64>,
        cost: Option<f64>,
    }

    /// Feed pi-lineage JSONL lines through handle_pi_event with app=None
    /// (events no-op), sharing reader state across lines exactly like
    /// read_per_turn_stream does.
    fn feed_pi(lines: &[&str]) -> UsageState {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let mut input = None;
        let mut output = None;
        let mut cache_read = None;
        let mut cache_creation = None;
        let mut cost = None;
        let mut in_think = false;
        let mut tools = ToolTracker::new();
        for line in lines {
            let v = serde_json::from_str(line).expect("test line must be valid JSON");
            handle_pi_event(
                None,
                "s",
                &v,
                &mut full,
                &cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut cost,
                &mut in_think,
                &mut tools,
            );
        }
        UsageState {
            full,
            cell,
            input,
            output,
            cache_read,
            cache_creation,
            cost,
        }
    }

    #[test]
    fn pi_session_header_binds_cli_session_id() {
        // First line of a real `pi -p --mode json` run.
        let st = feed_pi(&[
            r#"{"type":"session","version":3,"id":"01a067a9-7c1d-7332-9b4e-1d3f5a7b9c1e","timestamp":"2026-09-03","cwd":"D:/x"}"#,
        ]);
        assert!(st.full.is_empty()); // header is metadata, not transcript
        assert_eq!(
            st.cell.lock().unwrap().clone(),
            Some("01a067a9-7c1d-7332-9b4e-1d3f5a7b9c1e".to_string())
        );
    }

    #[test]
    fn pi_text_deltas_stream_into_transcript() {
        let st = feed_pi(&[
            r#"{"type":"message_update","usage":{"input":10,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":11,"cost":{"total":0.0}},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}"#,
            r#"{"type":"message_update","usage":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":12,"cost":{"total":0.0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hel"}}"#,
            r#"{"type":"message_update","usage":{"input":10,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":13,"cost":{"total":0.0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"lo"}}"#,
        ]);
        assert_eq!(st.full, "Hello");
        // pi reports input/output EXCLUDING the cache halves — a 200-token
        // cache read + 10 uncached must record input=10, not input=210.
        assert_eq!(st.input, Some(10));
        assert_eq!(st.output, Some(3));
    }

    /// The cache halves of pi's cumulative usage must reach the turn
    /// accumulators — dropping them is what made harness sessions look
    /// nearly token-free next to the built-in chat.
    #[test]
    fn pi_usage_captures_cache_read_and_write() {
        let st = feed_pi(&[
            r#"{"type":"message_update","usage":{"input":10,"output":2,"cacheRead":18432,"cacheWrite":2097,"totalTokens":22541,"cost":{"total":0.0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}}"#,
        ]);
        assert_eq!(st.input, Some(10));
        assert_eq!(st.output, Some(2));
        assert_eq!(st.cache_read, Some(18432));
        assert_eq!(st.cache_creation, Some(2097));
    }

    #[test]
    fn pi_thinking_deltas_wrap_in_think_block() {
        let st = feed_pi(&[
            r#"{"type":"message_update","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm "}}"#,
            r#"{"type":"message_update","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"answer"}}"#,
        ]);
        assert_eq!(st.full, "<think>hmm </think>answer");
    }

    #[test]
    fn pi_error_event_surfaces_message() {
        let st = feed_pi(&[
            r#"{"type":"message_update","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}},"assistantMessageEvent":{"type":"error","reason":"error","error":{"role":"assistant","content":[{"type":"text","text":"401: bad key"}],"stopReason":"error"}}}"#,
        ]);
        assert!(st.full.contains("401: bad key"), "{}", st.full);
    }

    #[test]
    fn pi_tool_execution_renders_markers() {
        let st = feed_pi(&[
            r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t1","result":{"content":"a.txt"},"isError":false}"#,
        ]);
        assert!(
            st.full.contains("bash"),
            "start marker missing: {}",
            st.full
        );
        assert!(st.full.contains("a.txt"), "result missing: {}", st.full);
    }

    #[test]
    fn pi_unknown_event_types_are_ignored() {
        // omp emits advisor events pi doesn't have; neither may corrupt the
        // transcript or panic.
        let st = feed_pi(&[
            r#"{"type":"advisor_cost_changed","total":0.5}"#,
            r#"{"type":"agent_start"}"#,
        ]);
        assert!(st.full.is_empty());
    }

    /// Feed CommandCode NDJSON frames through handle_commandcode_event with
    /// app=None, sharing reader state like read_per_turn_stream does.
    fn feed_cc(lines: &[&str]) -> UsageState {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let mut input = None;
        let mut output = None;
        let mut cache_read = None;
        let mut cache_creation = None;
        let mut in_think = false;
        let mut tools = ToolTracker::new();
        let mut seen = std::collections::HashSet::new();
        for line in lines {
            let v = serde_json::from_str(line).expect("test line must be valid JSON");
            handle_commandcode_event(
                None,
                "s",
                &v,
                &mut full,
                &cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut in_think,
                &mut tools,
                &mut seen,
            );
        }
        UsageState {
            full,
            cell,
            input,
            output,
            cache_read,
            cache_creation,
            cost: None,
        }
    }

    #[test]
    fn commandcode_result_line_binds_session_and_usage() {
        // Envelope shapes captured verbatim from a live `commandcode -p
        // --output-format json` run (the account was out of credits, so the
        // error path is the recorded one).
        let st = feed_cc(&[
            r#"{"type":"event","event":{"type":"run_start","sessionId":"88a3940f-2032-4a7a-b362-4fca46c4ea9b"}}"#,
            r#"{"type":"result","subtype":"error","sessionId":"88a3940f-2032-4a7a-b362-4fca46c4ea9b","usage":{"inputTokens":12,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":3970,"finalText":"","error":"Error: insufficient credits"}"#,
        ]);
        assert_eq!(
            st.cell.lock().unwrap().clone(),
            Some("88a3940f-2032-4a7a-b362-4fca46c4ea9b".to_string())
        );
        assert_eq!(st.input, Some(12));
        assert_eq!(st.output, Some(5));
        assert_eq!(
            st.cache_read,
            Some(0),
            "a reported zero is a true report, not absence"
        );
        assert_eq!(st.cache_creation, Some(0));
        assert!(st.full.contains("insufficient credits"), "{}", st.full);
    }

    /// The result line's camelCase cache counters must reach the
    /// accumulators (nonzero variant — the Claude-Code-style split).
    #[test]
    fn commandcode_result_captures_cache_split() {
        let st = feed_cc(&[
            r#"{"type":"result","subtype":"success","sessionId":"s1","usage":{"inputTokens":42,"outputTokens":8,"cacheReadTokens":15000,"cacheWriteTokens":1200},"finalText":"done"}"#,
        ]);
        assert_eq!(st.input, Some(42));
        assert_eq!(st.cache_read, Some(15000));
        assert_eq!(st.cache_creation, Some(1200));
    }

    #[test]
    fn commandcode_delta_frames_stream_and_result_catches_up() {
        let st = feed_cc(&[
            r#"{"type":"event","event":{"type":"text_delta","delta":"Hel"}}"#,
            r#"{"type":"event","event":{"type":"text_delta","delta":"lo"}}"#,
            // finalText carries the full reply — only the unstreamed suffix lands.
            r#"{"type":"result","subtype":"success","sessionId":"sid-1","usage":{"inputTokens":1,"outputTokens":2},"finalText":"Hello world"}"#,
        ]);
        assert_eq!(st.full, "Hello world");
    }

    #[test]
    fn commandcode_final_text_recovers_when_no_deltas_arrived() {
        // If the delta event type ever renames, the result line still
        // delivers the reply (forward-compat contract).
        let st = feed_cc(&[
            r#"{"type":"event","event":{"type":"message_start"}}"#,
            r#"{"type":"result","subtype":"success","finalText":"the whole answer"}"#,
        ]);
        assert_eq!(st.full, "the whole answer");
    }

    #[test]
    fn commandcode_tool_frames_mark_once() {
        let st = feed_cc(&[
            r#"{"type":"event","event":{"type":"tool_running","toolCallId":"t1","toolName":"bash","description":"ls"}}"#,
            r#"{"type":"event","event":{"type":"tool_running","toolCallId":"t1","toolName":"bash","description":"ls"}}"#,
            r#"{"type":"event","event":{"type":"tool_finished","toolCallId":"t1","toolName":"bash"}}"#,
        ]);
        assert_eq!(
            st.full.matches("bash").count(),
            1,
            "tool marked once: {}",
            st.full
        );
    }

    #[test]
    fn commandcode_non_json_update_banner_is_harmless() {
        // The reader skips unparseable lines; the handler sees only JSON. The
        // mid-stream self-update banner ("Updated 1.44.0 → 1.45.0") observed
        // live must never corrupt the transcript — covered by the reader's
        // from_str guard, asserted here at the handler boundary.
        let st = feed_cc(&[r#"{"type":"event","event":{"type":"turn_start","turnNumber":1}}"#]);
        assert!(st.full.is_empty());
    }

    /// OpenCode's step-finish tokens object (per-turn `run` mode). Cache
    /// counters arrive nested under `cache` — verified against the server's
    /// message-info shape.
    #[test]
    fn opencode_step_finish_captures_cache_split() {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let mut input = None;
        let mut output = None;
        let mut cache_read = None;
        let mut cache_creation = None;
        let mut cost = None;
        let mut last_text = String::new();
        let mut last_reasoning = String::new();
        let mut in_think = false;
        let mut tools = ToolTracker::new();
        let v = serde_json::from_str::<Value>(
            r#"{"type":"step_finish","sessionID":"oc-1","part":{"tokens":{"input":11,"output":3,"cache":{"read":20000,"write":2500}},"cost":0.01}}"#,
        )
        .unwrap();
        handle_opencode_event(
            None,
            "s",
            &v,
            &mut full,
            &cell,
            &mut input,
            &mut output,
            &mut cache_read,
            &mut cache_creation,
            &mut cost,
            &mut last_text,
            &mut last_reasoning,
            &mut in_think,
            &mut tools,
        );
        assert_eq!(input, Some(11));
        assert_eq!(output, Some(3));
        assert_eq!(cache_read, Some(20000));
        assert_eq!(cache_creation, Some(2500));
        assert_eq!(cost, Some(0.01));
    }

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
            .map(|i| {
                record(
                    i,
                    if i % 2 == 0 { "user" } else { "assistant" },
                    "turn text here",
                )
            })
            .collect();
        let (tail, head_count, head_chars) = primer_tail_and_head(&small);
        assert_eq!(tail.len(), 40);
        assert_eq!((head_count, head_chars), (0, 0));
        assert_eq!(tail.first().unwrap().id, 0);
        assert_eq!(tail.last().unwrap().id, 39);

        // 2_000 turns ≈ 80k chars — the tail must cap at ~32k and the rest is
        // head, keeping the NEWEST turns.
        let big: Vec<_> = (0..2_000)
            .map(|i| {
                record(
                    i,
                    if i % 2 == 0 { "user" } else { "assistant" },
                    "turn text here",
                )
            })
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
    /// the relay-tools MCP whitelist (see mcp_tools_bridge) — so a persona
    /// mention makes harness models promise an action they cannot take.
    /// See the doc on `harness_persona` for the whitelist rationale.
    #[test]
    fn harness_persona_only_names_bridgable_tools() {
        let p = harness_persona("Claude Code");
        assert!(p.contains("I'm Relay"));
        assert!(
            !p.contains("open_file"),
            "persona must not reference the built-in-chat open_file tool"
        );
        assert!(
            !p.contains("open_url"),
            "persona must not reference the built-in-chat open_url tool"
        );
        assert!(p.contains("Artifacts gallery"));
    }

    /// G2 parity: only adapters with no system-prompt flag need the bundle
    /// instructions riding the turn text. claude/kimi get them via
    /// --append-system-prompt-file / --agent-file and must not be doubled.
    #[test]
    fn instructions_ride_the_prompt_only_for_flagless_adapters() {
        for h in ["opencode", "pi", "omp", "commandcode"] {
            assert!(
                harness_needs_prompt_instructions(h),
                "{h} has no prompt flag"
            );
        }
        for h in ["claude_code", "kimi_code"] {
            assert!(
                !harness_needs_prompt_instructions(h),
                "{h} carries instructions via CLI flags"
            );
        }
    }

    #[test]
    fn harness_label_covers_known_adapters() {
        assert_eq!(harness_label("claude_code"), "Claude Code");
        assert_eq!(harness_label("kimi_code"), "Kimi Code");
        assert_eq!(harness_label("opencode"), "OpenCode");
        // Unknown harness ids pass through verbatim (persona stays readable).
        assert_eq!(harness_label("futurecli"), "futurecli");
    }

    /// G7 parity: automation one-shot prompts carry persona + instructions +
    /// custom prompt in the same order as the chat path, with the `---`
    /// separator only between prefix and prompt.
    #[test]
    fn one_shot_prompt_prefix_ordering() {
        let persona = harness_persona("Claude Code");
        let out = assemble_one_shot_prompt(
            Some(&persona),
            Some("## Current date & time\nToday is Monday."),
            Some("Always answer in French."),
            "Summarize the repo",
        );
        let persona_idx = out.find("You are Relay").unwrap();
        let date_idx = out.find("## Current date & time").unwrap();
        let custom_idx = out.find("Always answer in French").unwrap();
        let prompt_idx = out.find("Summarize the repo").unwrap();
        assert!(persona_idx < date_idx && date_idx < custom_idx && custom_idx < prompt_idx);
        // Exactly two separators: prefix-prompt boundary is the `---` line.
        assert_eq!(out.matches("\n\n---\n\n").count(), 1);

        // Blank / absent parts are skipped, not emitted as empty blocks.
        let out = assemble_one_shot_prompt(Some(&persona), Some("  "), None, "go");
        assert!(out.starts_with(&persona));
        assert!(out.ends_with("\n\n---\n\ngo"));
        // No prefix at all → bare prompt (app == None on automations).
        assert_eq!(assemble_one_shot_prompt(None, None, None, "go"), "go");
        // Blank custom prompt setting must not produce a lone `---`.
        let out = assemble_one_shot_prompt(None, None, Some("   "), "go");
        assert_eq!(out, "go");
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
        assert_eq!(
            unstreamed_suffix("", "reasoned answer"),
            Some("reasoned answer")
        );
    }

    /// Observed live (2026-09): a CLI turn can succeed WITHOUT any
    /// stream_event partials — under API retries the CLI falls back to
    /// non-streaming and the answer arrives only on the `result` event. The
    /// reader must recover it; before the `unstreamed_suffix` fallback the
    /// turn finished as an empty bubble (no assistant row persisted).
    #[test]
    fn claude_turn_without_partial_deltas_still_persists_the_result_text() {
        let conn = crate::db::mem();
        let cs =
            crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let db = DbState(Arc::new(parking_lot::Mutex::new(conn)));

        // Transcript with NO stream_event lines: text rides only the closing
        // `result` event, exactly like the failing probe run.
        let transcript = concat!(
            r#"{"type":"system","subtype":"init","session_id":"cli-abc"}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"the answer"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","result":"the answer","session_id":"cli-abc","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.001}"#,
            "\n",
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

    /// The cache halves of claude's result usage must reach the assistant
    /// row. claude's `input_tokens` excludes cached tokens, so without this
    /// split a heavily-cached turn (the common case mid-session) persisted
    /// ~5-20% of the tokens the model actually processed — the accounting
    /// hole that made harness sessions look nearly token-free next to the
    /// built-in chat.
    #[test]
    fn claude_result_usage_persists_cache_read_and_write() {
        let conn = crate::db::mem();
        let cs =
            crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let db = DbState(Arc::new(parking_lot::Mutex::new(conn)));

        let transcript = concat!(
            r#"{"type":"system","subtype":"init","session_id":"cli-abc"}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"ok"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","result":"ok","session_id":"cli-abc","usage":{"input_tokens":120,"output_tokens":40,"cache_creation_input_tokens":2097,"cache_read_input_tokens":48311},"total_cost_usd":0.02}"#,
            "\n",
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
        assert_eq!(assistant.len(), 1);
        assert_eq!(assistant[0].input_tokens, Some(120));
        assert_eq!(assistant[0].cache_creation_input_tokens, Some(2097));
        assert_eq!(assistant[0].cache_read_input_tokens, Some(48311));
    }

    /// A CLI that never reports cache fields (older versions) must persist
    /// NULLs — absence is not zero.
    #[test]
    fn claude_result_without_cache_fields_stays_null() {
        let conn = crate::db::mem();
        let cs =
            crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        let db = DbState(Arc::new(parking_lot::Mutex::new(conn)));

        let transcript = concat!(
            r#"{"type":"result","subtype":"success","result":"hi","session_id":"cli-abc","usage":{"input_tokens":7,"output_tokens":2},"total_cost_usd":0.001}"#,
            "\n",
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
        assert_eq!(assistant.len(), 1);
        assert_eq!(assistant[0].cache_creation_input_tokens, None);
        assert_eq!(assistant[0].cache_read_input_tokens, None);
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
            records.push(primer_record(
                "user",
                &format!("old message {i} {}", "x".repeat(200)),
            ));
            records.push(primer_record(
                "assistant",
                &format!("old reply {i} {}", "y".repeat(200)),
            ));
        }
        let primer = context_primer_from_records(&records, None);
        // Header + join overhead ride outside the per-line accounting.
        assert!(
            primer.len() <= CONTEXT_PRIMER_MAX_CHARS + 512,
            "{}",
            primer.len()
        );
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
            assert!(
                is_subagent_tool_name(name),
                "{name} must be a subagent tool"
            );
        }
        assert!(!is_subagent_tool_name("Bash"));
        for name in ["Task", "Agent"] {
            let meta = tool_meta_generic(
                name,
                &json!({
                    "subagent_type": "research",
                    "description": "Research inference",
                    "prompt": "Go deep"
                }),
            );
            assert_eq!(meta["kind"], "subagent", "{name} marker kind");
            assert_eq!(meta["role"], "research");
            assert_eq!(meta["detail"], "Research inference");
        }
    }

    #[test]
    fn parse_oneshot_text_extracts_each_cli_shape() {
        // Claude `--output-format json`: final text lives in `.result`.
        let claude = r#"{"type":"result","subtype":"success","result":"{\"type\":\"skill\"}","is_error":false}"#;
        assert_eq!(
            parse_oneshot_text("claude_code", claude).unwrap(),
            "{\"type\":\"skill\"}"
        );
        // is_error=true surfaces the message instead of the text.
        let err = r#"{"type":"result","subtype":"error_max_turns","result":"hit turn cap","is_error":true}"#;
        assert!(parse_oneshot_text("claude_code", err)
            .unwrap_err()
            .contains("hit turn cap"));

        // Kimi stream-json: assistant content strings concatenate; non-assistant
        // roles and tool_calls blocks are ignored.
        let kimi = concat!(
            r#"{"role":"user","content":"gen"}"#,
            "\n",
            r#"{"role":"assistant","content":"{\"type\":"}"#,
            "\n",
            r#"{"role":"assistant","content":"\"loop\"}"}"#,
            "\n",
        );
        assert_eq!(
            parse_oneshot_text("kimi_code", kimi).unwrap(),
            "{\"type\":\"loop\"}"
        );

        // OpenCode run-mode events: text parts carry FULL snapshots — only the
        // new suffix of each part may be appended or the JSON duplicates.
        let oc = concat!(
            r#"{"type":"step-start"}"#,
            "\n",
            r#"{"type":"text","part":{"text":"{\"type\":"}}"#,
            "\n",
            r#"{"type":"text","part":{"text":"{\"type\":\"skill\"}"}}"#,
            "\n",
        );
        assert_eq!(
            parse_oneshot_text("opencode", oc).unwrap(),
            "{\"type\":\"skill\"}"
        );
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
        assert_eq!(
            sanitize_attachment_name("my report (final).pdf"),
            "my_report_final.pdf"
        );
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
        assert_eq!(decode_attachment_b64("aGVsbG8="), Some(b"hello".to_vec()));
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
        let resp =
            ask_user_allow_response("req-8", &input, &json!("oops"), Some("  do it safely  "));
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
        assert!(
            status.is_some(),
            "registered one-shot child survived the kill"
        );
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
        let (mut cache_read, mut cache_creation) = (None, None);
        let mut tools = ToolTracker::new();
        let ev = |t: &str| json!({ "type": "text", "part": { "text": t } });
        let mut feed = |v: &Value, full: &mut String, last: &mut String| {
            handle_opencode_event(
                None,
                "s",
                v,
                full,
                &cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut cost,
                last,
                &mut last_reasoning,
                &mut in_think,
                &mut tools,
            );
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
        let (mut cache_read, mut cache_creation) = (None, None);
        let mut last_text = String::new();
        let mut last_reasoning = String::new();
        let mut in_think = false;
        let mut tools = ToolTracker::new();
        let mut feed = |v: &Value,
                        full: &mut String,
                        last_text: &mut String,
                        last_reasoning: &mut String,
                        in_think: &mut bool| {
            handle_opencode_event(
                None,
                "s",
                v,
                full,
                &cell,
                &mut input,
                &mut output,
                &mut cache_read,
                &mut cache_creation,
                &mut cost,
                last_text,
                last_reasoning,
                in_think,
                &mut tools,
            );
        };
        // Reasoning snapshots stream as suffixes inside one <think> block.
        feed(
            &json!({ "type": "reasoning", "part": { "text": "Think" } }),
            &mut full,
            &mut last_text,
            &mut last_reasoning,
            &mut in_think,
        );
        assert!(in_think);
        feed(
            &json!({ "type": "reasoning", "part": { "text": "Thinking…" } }),
            &mut full,
            &mut last_text,
            &mut last_reasoning,
            &mut in_think,
        );
        assert_eq!(full, "<think>Thinking…");
        // The first real text part closes the block before appending.
        feed(
            &json!({ "type": "text", "part": { "text": "Answer" } }),
            &mut full,
            &mut last_text,
            &mut last_reasoning,
            &mut in_think,
        );
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
        emit_opencode_tool(
            None,
            "s",
            &running,
            &full_cell,
            &think_cell,
            &mut tools,
            &mut states,
        );
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
        emit_opencode_tool(
            None,
            "s",
            &completed,
            &full_cell,
            &think_cell,
            &mut tools,
            &mut states,
        );
        {
            let f = full_cell.lock().unwrap();
            // Result marker attached exactly once for the shell step.
            assert_eq!(
                f.matches("\"kind\":\"result\"").count()
                    + f.matches("\"kind\": \"result\"").count(),
                1
            );
        }

        // A late duplicate completion must not attach another result.
        emit_opencode_tool(
            None,
            "s",
            &completed,
            &full_cell,
            &think_cell,
            &mut tools,
            &mut states,
        );
        {
            let f = full_cell.lock().unwrap();
            assert_eq!(
                f.matches("\"kind\":\"result\"").count()
                    + f.matches("\"kind\": \"result\"").count(),
                1
            );
        }

        // A tool that arrives already-finished is self-contained.
        let done = json!({
            "id": "prt_2", "type": "tool", "tool": "bash",
            "state": { "status": "completed", "input": { "command": "pwd" }, "output": "/tmp" }
        });
        emit_opencode_tool(
            None,
            "s",
            &done,
            &full_cell,
            &think_cell,
            &mut tools,
            &mut states,
        );
        {
            let f = full_cell.lock().unwrap();
            assert_eq!(
                f.matches("\"kind\":\"result\"").count()
                    + f.matches("\"kind\": \"result\"").count(),
                2
            );
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
                "http://127.0.0.1:1",
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
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","messageID":"msg_u","part":{"type":"text","text":"tell me a story","messageID":"msg_u"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert!(
            full_cell.lock().unwrap().is_empty(),
            "user-message parts must be filtered from the reply"
        );

        feed(
            r#"{"type":"message.updated","properties":{"info":{"id":"msg_a","role":"assistant"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );

        // Live streaming path: empty snapshot announces the reasoning part,
        // token deltas stream in, final snapshot reconciles to no-op.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_r1","type":"reasoning","text":"","messageID":"msg_a"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>");
        for d in ["Thi", "nking", "…"] {
            let payload = format!(
                r#"{{"type":"message.part.delta","properties":{{"sessionID":"ses_mine","messageID":"msg_a","partID":"prt_r1","field":"text","delta":"{d}"}}}}"#
            );
            feed(
                &payload,
                &mut last_text,
                &mut last_reasoning,
                &mut tools,
                &mut states,
                &mut roles,
                &mut part_kinds,
                &mut cur_text_part,
                &mut cur_reasoning_part,
            );
        }
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…");
        // Final full snapshot for the reasoning part reconciles to a no-op.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_r1","type":"reasoning","text":"Thinking…","messageID":"msg_a"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…");

        // Text part: empty snapshot closes the think block, then deltas.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_t1","type":"text","text":"","messageID":"msg_a"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>");
        for d in ["H", "i"] {
            let payload = format!(
                r#"{{"type":"message.part.delta","properties":{{"sessionID":"ses_mine","messageID":"msg_a","partID":"prt_t1","field":"text","delta":"{d}"}}}}"#
            );
            feed(
                &payload,
                &mut last_text,
                &mut last_reasoning,
                &mut tools,
                &mut states,
                &mut roles,
                &mut part_kinds,
                &mut cur_text_part,
                &mut cur_reasoning_part,
            );
        }
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_t1","type":"text","text":"Hi","messageID":"msg_a"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>Hi");

        // A SECOND text part (e.g. after tool calls) must not duplicate its
        // snapshot against the previous part's flat baseline.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_mine","part":{"id":"prt_t2","type":"text","text":"more","messageID":"msg_a"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>Himore");

        // Other sessions' traffic stays filtered.
        feed(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_other","part":{"id":"prt_x","type":"text","text":"IGNORED","messageID":"msg_x"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
        );
        assert_eq!(*full_cell.lock().unwrap(), "<think>Thinking…</think>Himore");

        // Non-part events are ignored but still bump the quiet timestamp.
        quiet.store(0, Ordering::Relaxed);
        feed(
            r#"{"type":"session.status","properties":{"status":{"type":"busy"}}}"#,
            &mut last_text,
            &mut last_reasoning,
            &mut tools,
            &mut states,
            &mut roles,
            &mut part_kinds,
            &mut cur_text_part,
            &mut cur_reasoning_part,
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
    /// artifacts dir: relay-tools MCP writes into `storage.artifactsDir`
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
        assert_eq!(
            dirs.len(),
            2,
            "spawn dir + configured artifacts dir: {dirs:?}"
        );
        assert_eq!(canon(&dirs[0]), canon(proj.path()));
        assert_eq!(canon(&dirs[1]), canon(arts.path()));
    }

    /// With no project and no configured dir, the spawn dir and the artifacts
    /// fallback are the same <Documents>/Relay — the watch must dedup to
    /// one dir, not snapshot the same tree twice.
    #[test]
    fn turn_watch_dirs_dedups_when_dirs_coincide() {
        let conn = crate::db::mem();
        let db = Arc::new(parking_lot::Mutex::new(conn));
        let dirs = turn_watch_dirs(None, &db);
        assert_eq!(dirs.len(), 1, "{dirs:?}");
    }

    /// F4 regression: the raw-stdout preview was sliced at BYTE 200
    /// (`&raw[..raw.len().min(200)]`), which panics when a multibyte char
    /// straddles the cut — routine for CJK/emoji CLI output. The truncation
    /// must be char-safe and still embed the truncated raw in the error.
    #[test]
    fn parse_oneshot_text_multibyte_straddling_byte_200_does_not_panic() {
        let mut raw = "x".repeat(199);
        raw.push('日'); // 3-byte char spanning bytes 199..202 — byte-cut at 200 panicked
        raw.push_str(" not json");
        let err = parse_oneshot_text("claude_code", &raw).unwrap_err();
        assert!(err.contains("unparseable claude output"), "{err}");
        // Truncation is char-safe: the straddling char survives in the preview.
        assert!(err.contains('日'), "{err}");
    }

    /// Same contract for the `result`-missing path (head(200) in the
    /// ok_or_else): valid JSON, multibyte char at the 200-byte boundary.
    #[test]
    fn parse_oneshot_text_missing_result_preview_is_char_safe() {
        // 8 bytes of prefix + 190 x + 3-byte 日 at bytes 198..201: a byte-cut
        // at 200 lands mid-char.
        let raw = format!("{{\"pad\":\"{}日\"}}", "x".repeat(190));
        let err = parse_oneshot_text("claude_code", &raw).unwrap_err();
        assert!(err.contains("missing `result`"), "{err}");
        assert!(err.contains('日'), "{err}");
    }

    // ---- subagent tracking (background agents, parent routing) ----

    fn spawn_sub(tools: &mut ToolTracker) -> String {
        tools.subagent_use(
            "Agent",
            json!({"kind": "subagent", "role": "general-purpose", "task": "t"}),
            None,
            "s1",
            "general-purpose",
            "t",
            "p",
            "call_abc",
            true,
        )
    }

    const RECEIPT: &str = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a1b3914b301b8a387 (internal ID - do not mention to user.)\nThe agent is working in the background. output_file: C:\\tmp\\tasks\\x.output";

    #[test]
    fn async_launch_receipt_is_swallowed_not_finalized() {
        let mut tools = ToolTracker::new();
        let marker = spawn_sub(&mut tools);
        assert!(marker.contains("<tool>"), "{marker}");
        assert_eq!(tools.by_tool_use.len(), 1);
        // The receipt arrives as the call's tool_result — it must NOT pop the
        // slot nor finalize the agent (the old "Done ✓ while still working" bug).
        let out = tools.tool_result(RECEIPT, false, None, "s1", Some("call_abc"));
        assert!(out.is_none());
        assert_eq!(
            tools.by_tool_use.len(),
            1,
            "receipt must keep the agent live"
        );
        assert_eq!(
            tools.pending.len(),
            1,
            "receipt must not consume the FIFO slot"
        );
        assert_eq!(
            tools
                .by_tool_use
                .values()
                .next()
                .unwrap()
                .agent_id
                .as_deref(),
            Some("a1b3914b301b8a387")
        );
    }

    #[test]
    fn background_completion_comes_from_task_notification() {
        let mut tools = ToolTracker::new();
        spawn_sub(&mut tools);
        let _ = tools.tool_result(RECEIPT, false, None, "s1", Some("call_abc"));
        tools.finish_background(
            None,
            "s1",
            &json!({
                "type": "system",
                "subtype": "task_notification",
                "task_id": "a35923ae14a875050",
                "tool_use_id": "call_abc",
                "status": "completed",
                "summary": "BACKGROUND_OK"
            }),
        );
        assert!(
            tools.by_tool_use.is_empty(),
            "notification finalizes the agent"
        );
        assert!(tools.pending.is_empty());
    }

    #[test]
    fn background_completion_correlates_by_agent_task_id() {
        let mut tools = ToolTracker::new();
        spawn_sub(&mut tools); // receipt teaches the agent_id
        let _ = tools.tool_result(RECEIPT, false, None, "s1", Some("call_abc"));
        // A notification without tool_use_id still correlates via the
        // receipt's agentId.
        tools.finish_background(
            None,
            "s1",
            &json!({"subtype": "task_notification", "task_id": "a1b3914b301b8a387", "status": "failed"}),
        );
        assert!(tools.by_tool_use.is_empty());
    }

    #[test]
    fn foreground_result_finalizes_by_exact_id() {
        let mut tools = ToolTracker::new();
        spawn_sub(&mut tools);
        // A real (non-receipt) result finalizes the exact agent, dropping its
        // FIFO slot so later tools stay aligned.
        let out = tools.tool_result("final report", false, None, "s1", Some("call_abc"));
        assert!(out.is_none(), "subagent results carry no main marker");
        assert!(tools.by_tool_use.is_empty());
        assert!(tools.pending.is_empty());
    }

    #[test]
    fn fifo_fallback_for_adapters_without_ids() {
        let mut tools = ToolTracker::new();
        tools.subagent_use(
            "Task",
            json!({"kind": "subagent"}),
            None,
            "s1",
            "role",
            "t",
            "p",
            "", // no CLI id exposed (kimi/pi/omp)
            false,
        );
        let out = tools.tool_result("report", false, None, "s1", None);
        assert!(out.is_none());
        assert!(tools.pending.is_empty());
    }

    #[test]
    fn subagent_internal_messages_route_to_their_panel_not_the_fifo() {
        let mut tools = ToolTracker::new();
        spawn_sub(&mut tools);
        // The agent's own assistant message (parent-tagged) routes true but
        // must NOT push a main FIFO slot…
        let routed = tools.route_subagent_assistant(
            None,
            "s1",
            "call_abc",
            &[json!({"type": "text", "text": "BACKGROUND_OK"})],
        );
        assert!(routed);
        // …and its internal tool result must not pop one either.
        let routed = tools.route_subagent_result(None, "s1", "call_abc", "ls output", false);
        assert!(routed);
        assert_eq!(
            tools.pending.len(),
            1,
            "main FIFO untouched by subagent activity"
        );
        // Unknown parents (background BASH tasks etc.) don't route.
        assert!(!tools.route_subagent_assistant(None, "s1", "call_other", &[]));
        // The foreground completion still lands on the right agent, and the
        // already-streamed text is not re-appended (finish_subagent skips the
        // token emission when `streamed`; asserted via state: entry removed).
        let out = tools.tool_result("BACKGROUND_OK", false, None, "s1", Some("call_abc"));
        assert!(out.is_none());
        assert!(tools.by_tool_use.is_empty());
    }

    #[test]
    fn receipt_detection_is_tight() {
        assert!(is_async_launch_receipt(RECEIPT));
        assert!(!is_async_launch_receipt("regular shell output"));
        assert!(!is_async_launch_receipt(""));
        assert_eq!(
            launch_receipt_agent_id(RECEIPT).as_deref(),
            Some("a1b3914b301b8a387")
        );
        assert_eq!(launch_receipt_agent_id("no id here"), None);
    }

    #[test]
    fn shell_result_matching_survives_a_background_agent_in_the_queue() {
        // Background agent launched, then a shell call: the receipt swallows
        // the agent's slot consumption, so the shell result must still pair
        // with the SHELL slot (the old FIFO desync ate it).
        let mut tools = ToolTracker::new();
        let _ = spawn_sub(&mut tools);
        let _ = tools.tool_result(RECEIPT, false, None, "s1", Some("call_abc"));
        let shell_marker = tools.tool_use("Bash", vec![json!({"kind": "command", "title": "ls"})]);
        assert!(!shell_marker.is_empty());
        let out = tools.tool_result("file1\nfile2", false, None, "s1", None);
        assert!(out.is_some(), "shell output must attach to its step");
    }

    // ---- RELAY_ASK: the marker question channel for no-protocol harnesses ----

    #[test]
    fn relay_ask_marker_is_stripped_and_normalized() {
        let reply = "I can do this two ways.\n\nWhich database should I use?\n\
            RELAY_ASK: {\"question\":\"Which database?\",\"header\":\"DB\",\"options\":[{\"label\":\"SQLite\",\"description\":\"local\"},{\"label\":\"Postgres\"}],\"multiSelect\":false}\n";
        let (clean, ask) = split_relay_ask(reply.to_string());
        assert_eq!(
            clean,
            "I can do this two ways.\n\nWhich database should I use?"
        );
        let qs = ask.expect("marker must parse");
        let q = &qs[0];
        assert_eq!(q["question"], "Which database?");
        assert_eq!(q["header"], "DB");
        assert_eq!(q["options"][0]["label"], "SQLite");
        assert_eq!(q["options"][0]["description"], "local");
        assert!(
            q["options"][1].get("description").is_none(),
            "missing description stays absent"
        );
        assert_eq!(q["options"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn relay_ask_survives_prose_and_repairs_broken_backslashes() {
        // The exact failure seen live: a Windows path with single backslashes
        // makes the JSON invalid ("D:\artifact" → \a is not a JSON escape).
        // The repair pass must rescue it and the marker line must strip.
        let broken = "RELAY_ASK: {\"question\":\"What would you like me to help you with today?\",\"header\":\"Today's Task\",\"options\":[{\"label\":\"Daily news automation\",\"description\":\"Tweak or debug the 9 a.m. AI/ML news workflow\"},{\"label\":\"New artifact or tool\",\"description\":\"Build something in D:\\artifact\"}],\"multiSelect\":false}";
        let (clean, ask) = split_relay_ask(broken.to_string());
        let qs = ask.expect("invalid escapes must be repaired");
        assert_eq!(clean, "", "a bare marker leaves no prose behind");
        assert_eq!(
            qs[0]["question"],
            "What would you like me to help you with today?"
        );
        assert_eq!(
            qs[0]["options"][1]["description"],
            "Build something in D:\\artifact"
        );
        // Already-valid double backslashes pass through untouched.
        let ok = "RELAY_ASK: {\"question\":\"Q?\",\"options\":[{\"label\":\"L\",\"description\":\"D:\\\\dir\"}]}";
        let (_, ask) = split_relay_ask(ok.to_string());
        assert_eq!(ask.unwrap()[0]["options"][0]["description"], "D:\\dir");
        // Prose after the marker is fine — the marker line strips, prose stays.
        let prose_after = "RELAY_ASK: {\"question\":\"Q?\"}\nPick one to continue.";
        let (clean, ask) = split_relay_ask(prose_after.to_string());
        assert!(ask.is_some());
        assert_eq!(clean, "Pick one to continue.");
    }

    #[test]
    fn relay_ask_ignores_buried_or_malformed_markers() {
        // A line that doesn't PARSE is ordinary text, even mid-reply.
        let buried = "RELAY_ASK: not json\nThen I picked option A myself.";
        let (clean, ask) = split_relay_ask(buried.to_string());
        assert!(ask.is_none());
        assert_eq!(clean, buried);
        // A parsed marker without a question text is ignored.
        let empty = "x\nRELAY_ASK: {\"question\":\"  \"}";
        assert!(split_relay_ask(empty.to_string()).1.is_none());
        // Backtick-wrapped JSON still parses.
        let wrapped = "ok\nRELAY_ASK: `{\"question\":\"Q?\"}`";
        let (_, ask) = split_relay_ask(wrapped.to_string());
        assert_eq!(ask.unwrap()[0]["question"], "Q?");
        // No marker: byte-identical passthrough.
        let plain = "Just a normal reply.".to_string();
        let (clean, ask) = split_relay_ask(plain.clone());
        assert!(ask.is_none());
        assert_eq!(clean, plain);
    }

    #[test]
    fn ask_follow_up_composes_answers_skips_and_free_text() {
        let qs = serde_json::json!([{"question": "Which database?"}]);
        let answers = serde_json::json!({"Which database?": "SQLite"});
        let msg = compose_ask_follow_up(&qs, &answers, None, false);
        assert!(
            msg.contains("You asked: \u{201c}Which database?\u{201d}"),
            "{msg}"
        );
        assert!(msg.contains("Which database?: SQLite"), "{msg}");
        assert!(msg.contains("Continue the task"), "{msg}");

        let multi = serde_json::json!({"Which database?": ["SQLite", "Postgres"]});
        let msg = compose_ask_follow_up(&qs, &multi, None, false);
        assert!(msg.contains("SQLite, Postgres"), "{msg}");

        let free_only = compose_ask_follow_up(
            &qs,
            &serde_json::json!({}),
            Some("use whatever").as_deref(),
            false,
        );
        assert!(free_only.contains("use whatever"), "{free_only}");

        let skipped = compose_ask_follow_up(&qs, &serde_json::json!({}), None, true);
        assert!(skipped.contains("dismissed"), "{skipped}");
        assert!(skipped.contains("best judgment"), "{skipped}");
    }

    #[test]
    fn question_channel_gates_by_harness() {
        assert!(harness_question_channel("kimi_code"));
        assert!(harness_question_channel("opencode"));
        assert!(harness_question_channel("pi"));
        assert!(harness_question_channel("omp"));
        assert!(harness_question_channel("commandcode"));
        // Real protocols must never get the text directive.
        assert!(!harness_question_channel("claude_code"));
        assert!(!harness_question_channel("acp:gemini"));
        assert!(!harness_question_channel("local_gguf"));
    }

    #[test]
    fn opencode_reply_answers_map_in_question_order() {
        let qs = serde_json::json!([
            {"question": "Which database?", "options": [{"label": "SQLite"}, {"label": "Postgres"}]},
            {"question": "Migrate now?", "multiSelect": true}
        ]);
        // Single labels, multi labels, and per-question free text fallback.
        let answers = serde_json::json!({"Which database?": "Postgres", "Migrate now?": ["yes", "also docs"]});
        let body = build_opencode_reply_answers(&qs, &answers, None);
        assert_eq!(
            body,
            serde_json::json!([["Postgres"], ["yes", "also docs"]])
        );
        // Unanswered question + free text: the free text fills THAT slot.
        let body = build_opencode_reply_answers(&qs, &serde_json::json!({}), Some("up to you"));
        assert_eq!(body, serde_json::json!([["up to you"], ["up to you"]]));
    }
}
