//! Chat mode — direct LLM HTTP API streaming (separate from CLI agent panes).
//!
//! Four providers: Anthropic, OpenAI, AnthropicCompatible, OpenAICompatible.
//! All SSE streaming, API keys stored in the OS keychain, HTTP in Rust backend.

pub mod artifacts;
pub mod auto_router;
pub mod cache;
pub mod citation_lint;
pub(crate) mod llm_client;
pub mod citation_verify;
pub mod cloud_compact;
pub mod codeexec;
pub mod commands;
pub mod compaction;
pub mod context_windows;
pub mod dispatch;
pub mod docdesign;
pub mod docs;
pub mod docs_images;
pub mod error_class;
pub mod export;
pub mod jsdocgen;
pub mod local_models;
pub mod model_health;
pub mod office;
pub mod pdfprint;
pub mod permission;
pub mod plan;
pub mod prompts;
pub mod proto;
pub mod providers;
pub mod pygen;
pub mod python_runtime;
pub mod reconnect;
pub mod stream_events;
pub mod streaming;
pub mod tasks;
pub mod tools;
pub mod totp;
pub mod turn_perf;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
#[cfg(test)]
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

// System-prompt assembly (CORE prompt, STRICT addendum, tool guide, research
// scaffolding, and the final assembler) lives in `prompts.rs`. Re-export the
// two entry points that `commands.rs` calls via `crate::chat::*`.
pub use prompts::{build_system_prompt, is_research_request};

use crate::db;
use crate::types::*;
use proto::*;
use providers::*;
use streaming::*;

/// One fail-over candidate for Auto-routed turns (chat/auto_router.rs): the
/// resolver's ordered chain — primary first, then fallbacks — with each
/// candidate's credentials pre-resolved. Empty for pinned (non-auto)
/// sessions, which therefore behave exactly as before.
#[derive(Debug, Clone)]
pub struct AutoFallback {
    pub provider_id: ChatProviderId,
    pub model: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

/// Raw inputs for rebuilding a provider-appropriate system prompt per
/// fail-over candidate (the prebuilt `system` was assembled for the primary's
/// provider/model class). Captured only for Auto sessions; `system_suffix`
/// carries the working-directory section that the send path appends AFTER
/// `build_system_prompt`, so rebuilt prompts keep it.
#[derive(Debug, Clone, Default)]
pub struct SystemPromptInputs {
    pub custom: Option<String>,
    pub skills: Vec<(String, String)>,
    pub manifest: Option<String>,
    pub memory_profile: Option<String>,
    pub plan_mode: bool,
    pub system_suffix: String,
}

/// A pending per-action approval for a filesystem tool call. Created when the
/// central `check_permission` returns `NeedsApproval`; the tool loop pauses on
/// the matching oneshot receiver until the UI calls `resolve_tool_action`.
#[allow(dead_code)] // `tool`/`args`/`summary` retained for auditing/future use
pub(crate) struct PendingApproval {
    /// The chat session this approval belongs to (so a cancelled/aborted stream
    /// can drop all its pending approvals).
    pub chat_session_id: String,
    /// Tool name (e.g. `write_file`) — shown on the card.
    pub tool: String,
    /// The verbatim JSON arguments the model produced.
    pub args: serde_json::Value,
    /// A short human-facing description of the action (e.g. "write_file → C:/…").
    pub summary: String,
    /// Sender resumed when the UI resolves the card. `true` = approve & run,
    /// `false` = deny. None/dropped = stream cancelled → deny.
    pub response_tx: tokio::sync::oneshot::Sender<bool>,
}

/// A pending harness question — a Claude Code `AskUserQuestion` that arrived
/// over the can_use_tool control protocol and needs the USER's answers (not a
/// permission decision). The reader thread pauses on the oneshot until the UI
/// calls `resolve_agent_question`; a dropped sender (cancel/session delete)
/// resolves to a skip, so neither side can wedge.
pub(crate) struct PendingQuestion {
    pub chat_session_id: String,
    /// Sender resumed with the user's answers. Dropped = cancelled → skip.
    pub response_tx: tokio::sync::oneshot::Sender<QuestionReply>,
}

/// The user's answer to a pending harness question. `answers` maps question
/// text → chosen option label (string, or an array of labels for
/// multiSelect); `response` carries an optional free-text reply that replaces
/// the structured answers entirely (the protocol's top-level `response`).
pub(crate) struct QuestionReply {
    pub answers: serde_json::Value,
    pub response: Option<String>,
}

/// Manages active chat streams. Each chat_session_id maps to a cancellation
/// token (tokio AbortHandle). Only one stream per session is allowed — sending
/// a new message cancels the previous one automatically.
pub struct ChatManager {
    pub client: reqwest::Client,
    streams: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// Pending per-action approvals keyed by a synthetic id. A filesystem
    /// tool call that `check_permission` flags as `NeedsApproval` registers
    /// here and pauses its loop on the oneshot receiver until the UI resolves.
    pending: Mutex<HashMap<String, PendingApproval>>,
    /// Pending harness questions (`AskUserQuestion` over the control
    /// protocol). Separate from `pending` because the resolution carries the
    /// user's ANSWERS, not a bool — the approval-card UI must not render it.
    pending_questions: Mutex<HashMap<String, PendingQuestion>>,
    /// PERF (PERFORMANCE_AUDIT.md B11): memoized context-meter token counts.
    /// The frontend polls `count_context_tokens` every 2 s while a local
    /// session is idle, and each call used to re-send the ENTIRE active
    /// history to llama-server's /tokenize even when nothing had changed.
    /// Keyed by chat_session_id → (fingerprint, used_tokens); the
    /// fingerprint covers (last active message id, active message count,
    /// system prompt, model) so any transcript / prompt / model change
    /// invalidates. Entries are removed on session delete.
    context_token_cache: Mutex<HashMap<String, (String, u32)>>,
    /// Attach-on-demand hand-off, keyed by chat session id. The dispatcher's
    /// `attach_connector` / `attach_mcp_server` handlers push freshly
    /// connected sources into the live turn's slot; the tool loops drain it
    /// after each round and merge the new tools into the request so the very
    /// next round can call them. One slot per session (one live turn per
    /// session — `send` cancels any prior stream first).
    late_attach: Mutex<HashMap<String, Arc<Mutex<LateAttach>>>>,
    /// Subagent (`Task`/`Agent`) child loops spawned by the live turn, keyed
    /// by session id. Cancelling a turn used to abort only the turn task —
    /// which DETACHED the subagent (its JoinHandle was dropped mid-await) and
    /// let it keep spending provider tokens for up to SUBAGENT_MAX_ROUNDS
    /// more with no way to stop it. `cancel` aborts these too.
    child_tasks: Mutex<HashMap<String, Vec<tokio::task::AbortHandle>>>,
}

/// Sources attached mid-turn by the `attach_connector` / `attach_mcp_server`
/// meta-tools, awaiting pickup by the turn's tool loop.
#[derive(Default)]
pub(crate) struct LateAttach {
    pub connectors: Vec<crate::connectors::AttachedConnector>,
    pub mcp: Vec<crate::mcp_gallery::McpToolEntry>,
}

impl ChatManager {
    pub fn new() -> Self {
        Self {
            // B-10: this client serves every stream round, compaction
            // tokenize/summarize, and context counting — a blackholed connect
            // (misconfigured base_url at a firewalled IP) used to hang all of
            // them for the OS TCP timeout (minutes). 20s connect bound; body
            // reads stay unbounded (streams are guarded by the B-9 stall
            // watchdog instead).
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(20))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            streams: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            pending_questions: Mutex::new(HashMap::new()),
            context_token_cache: Mutex::new(HashMap::new()),
            late_attach: Mutex::new(HashMap::new()),
            child_tasks: Mutex::new(HashMap::new()),
        }
    }

    /// Track a subagent loop spawned for this session so `cancel` (and a
    /// superseding `send`, which cancels first) can abort it.
    pub(crate) fn register_child_task(&self, sid: &str, handle: tokio::task::AbortHandle) {
        self.child_tasks
            .lock()
            .entry(sid.to_string())
            .or_default()
            .push(handle);
    }

    /// Remove one finished child from the registry — by its own task id, so
    /// an old child's cleanup never clobbers a newer turn's registrations.
    pub(crate) fn unregister_child_task(&self, sid: &str, task_id: tokio::task::Id) {
        let mut map = self.child_tasks.lock();
        if let Some(list) = map.get_mut(sid) {
            list.retain(|h| h.id() != task_id);
        }
        if map.get(sid).is_some_and(|l| l.is_empty()) {
            map.remove(sid);
        }
    }

    /// Abort every live subagent loop for a session.
    fn abort_child_tasks(&self, sid: &str) {
        if let Some(list) = self.child_tasks.lock().remove(sid) {
            for handle in list {
                handle.abort();
            }
        }
    }

    /// Register (or reset) the late-attach slot for a session's turn. Called
    /// by `send` before the turn spawns; `clear_late_attach` on completion.
    pub(crate) fn reset_late_attach(&self, sid: &str) -> Arc<Mutex<LateAttach>> {
        let slot = Arc::new(Mutex::new(LateAttach::default()));
        self.late_attach
            .lock()
            .insert(sid.to_string(), Arc::clone(&slot));
        slot
    }

    /// The live turn's late-attach slot, if a turn is running for `sid`.
    pub(crate) fn late_attach_slot(&self, sid: &str) -> Option<Arc<Mutex<LateAttach>>> {
        self.late_attach.lock().get(sid).map(Arc::clone)
    }

    /// Drop the slot when the turn ends (`send`'s spawn tail).
    pub(crate) fn clear_late_attach(&self, sid: &str) {
        self.late_attach.lock().remove(sid);
    }

    /// Look up a memoized token count for the given fingerprint.
    pub(crate) fn cached_context_tokens(
        &self,
        chat_session_id: &str,
        fingerprint: &str,
    ) -> Option<u32> {
        self.context_token_cache
            .lock()
            .get(chat_session_id)
            .and_then(|(fp, tokens)| {
                if fp == fingerprint {
                    Some(*tokens)
                } else {
                    None
                }
            })
    }

    /// Store a token count under the given fingerprint (replaces any stale
    /// entry for the session).
    pub(crate) fn store_context_tokens(
        &self,
        chat_session_id: &str,
        fingerprint: String,
        tokens: u32,
    ) {
        self.context_token_cache
            .lock()
            .insert(chat_session_id.to_string(), (fingerprint, tokens));
    }

    /// Drop the memoized count for a session (called on session delete).
    pub(crate) fn invalidate_context_tokens(&self, chat_session_id: &str) {
        self.context_token_cache.lock().remove(chat_session_id);
    }

    /// Register a pending approval and return its synthetic id + the receiver
    /// the tool loop should await. The loop pauses on the receiver until
    /// `resolve_pending_approval` is called.
    pub(crate) fn register_pending_approval(
        &self,
        chat_session_id: &str,
        tool: &str,
        args: serde_json::Value,
        summary: String,
    ) -> (String, tokio::sync::oneshot::Receiver<bool>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = next_synthetic_tool_id();
        self.pending.lock().insert(
            id.clone(),
            PendingApproval {
                chat_session_id: chat_session_id.to_string(),
                tool: tool.to_string(),
                args,
                summary,
                response_tx: tx,
            },
        );
        (id, rx)
    }

    /// Resolve a pending approval by id. Returns the chat session id + the
    /// PendingApproval (so the caller can run the tool / build the deny
    /// message). `None` when the id is unknown (already resolved, cancelled,
    /// or never existed) — the UI treats that as a no-op.
    pub(crate) fn take_pending_approval(&self, id: &str) -> Option<PendingApproval> {
        self.pending.lock().remove(id)
    }

    /// Drop every pending approval for a session (used when its stream is
    /// cancelled/aborted — the senders drop, the receivers error, and the
    /// paused loops resume as "denied").
    pub(crate) fn drop_pending_for_session(&self, chat_session_id: &str) {
        let to_remove: Vec<String> = self
            .pending
            .lock()
            .iter()
            .filter(|(_, p)| p.chat_session_id == chat_session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for k in to_remove {
            self.pending.lock().remove(&k); // sender drops → receiver errors
        }
        // Same contract for pending harness questions: sender drop → the
        // blocked reader thread resumes as "user skipped the question".
        let q_remove: Vec<String> = self
            .pending_questions
            .lock()
            .iter()
            .filter(|(_, q)| q.chat_session_id == chat_session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for k in q_remove {
            self.pending_questions.lock().remove(&k);
        }
    }

    /// Register a pending harness question and return its synthetic id plus
    /// the receiver the reader thread awaits. The reader pauses until the UI
    /// calls `resolve_agent_question` (or the pending is dropped on cancel →
    /// skip).
    pub(crate) fn register_pending_question(
        &self,
        chat_session_id: &str,
    ) -> (String, tokio::sync::oneshot::Receiver<QuestionReply>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = next_synthetic_tool_id();
        self.pending_questions.lock().insert(
            id.clone(),
            PendingQuestion {
                chat_session_id: chat_session_id.to_string(),
                response_tx: tx,
            },
        );
        (id, rx)
    }

    /// Resolve a pending harness question by id, handing the user's answers
    /// to the paused reader thread. `None` when the id is unknown (already
    /// resolved, cancelled, or never existed) — the UI treats that as a no-op.
    pub(crate) fn take_pending_question(&self, id: &str) -> Option<PendingQuestion> {
        self.pending_questions.lock().remove(id)
    }

    /// Send a chat message. Spawns a tokio task that:
    /// 1. Builds the provider HTTP request
    /// 2. Reads SSE chunks, emitting `chat:token` events
    /// 3. On completion, emits `chat:done` and persists the assistant message
    /// 4. On error, emits `chat:error`
    ///
    /// The user message is assumed already persisted by the caller (commands layer).
    /// Cancelling any existing stream for this session first.
    ///
    /// `thinking` toggles extended thinking on the request:
    /// - Anthropic: emits `thinking: {"type":"enabled","budget_tokens":…}`.
    /// - OpenAI / OpenRouter: ignored (reasoning is gated by `effort`).
    /// - Local GGUF: emits `chat_template_kwargs.enable_thinking`.
    pub fn send(
        self: &Arc<Self>,
        chat_session_id: String,
        provider_id: ChatProviderId,
        model: String,
        api_key: String,
        base_url: Option<String>,
        effort: Option<String>,
        tools_enabled: bool,
        code_exec_enabled: bool,
        sandbox: permission::SandboxPolicy,
        approval: permission::ApprovalPolicy,
        fs_roots: Vec<String>,
        // Connector ids attached to this conversation (per-session opt-in).
        // When tools are enabled, each is connected (OAuth token refreshed,
        // MCP session opened, tools listed + classified) at the start of the
        // spawned turn; their remote tools are merged into the schema and
        // routed through the connector permission gate in dispatch.
        connector_ids: Vec<String>,
        // MCP-gallery server ids (`mcp:<id>` session rows) attached to this
        // conversation — same attach-on-demand contract as `connector_ids`.
        mcp_server_ids: Vec<String>,
        system: Option<String>,
        messages: Vec<ChatMessage>,
        db: Arc<Mutex<Connection>>,
        app: AppHandle,
        research_mode: bool,
        thinking: Option<bool>,
        // Auto fail-over chain (primary already applied by the caller).
        fallbacks: Vec<AutoFallback>,
        // Raw system-prompt inputs for rebuilding the prompt per fail-over
        // candidate; None (pinned sessions) keeps the prebuilt `system`.
        system_inputs: Option<SystemPromptInputs>,
    ) {
        // Cancel any existing stream for this session.
        self.cancel(&chat_session_id);

        let chat_req = ChatRequest {
            model,
            messages,
            max_tokens: Some(4096),
            system: system.filter(|s| !s.trim().is_empty()),
            effort,
            thinking,
            local_docs_retrieval: Vec::new(),
            memory_context: None,
        };

        // OpenRouter and LocalGguf speak the OpenAI wire format, so they ride
        // the OpenAI request/tool path. (Computed per fail-over candidate
        // inside the turn loop — the primary's values drive nothing else.)

        let client = self.client.clone();
        let sid = chat_session_id.clone();
        let pcaps = prompts::provider_capabilities(provider_id.clone(), &chat_req.model);
        let local_model = matches!(provider_id, ChatProviderId::LocalGguf);
        // Local-docs search tool is exposed only when (a) the embedding
        // sidecar is already running for this turn, AND (b) at least one
        // enabled corpus has chunks indexed. Both are cheap DB/registry queries
        // that flip the `search_docs` schema in. Computed before the spawn so
        // the registry's status snapshot is taken under the same turn setup.
        let local_docs = {
            let sidecar_up = app
                .try_state::<local_models::LocalModelState>()
                .is_some_and(|s| s.0.embedding_status().is_some());
            let conn = db.lock();
            sidecar_up && db::any_searchable_corpus(&conn)
        };
        // Keep the embedding sidecar URL for the turn — the auto-retrieval
        // below and the `search_docs` tool both need it. Snapshot under the
        // same registry lock as the capability flag so both see one state.
        let embedding_base = if local_docs {
            app.try_state::<local_models::LocalModelState>()
                .and_then(|s| s.0.embedding_status())
                .map(|a| a.base_url)
        } else {
            None
        };
        // Load the user's approval rules ("always allow tool + glob") from
        // `app_settings` so the dispatcher can short-circuit approval cards.
        // Invalid JSON settles to empty (never fails the turn).
        let fs_rules: Vec<permission::ApprovalRule> = {
            let conn = db.lock();
            match db::get_setting(&conn, "permissions.rules") {
                Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
                _ => Vec::new(),
            }
        };
        let caps = {
            // Attach-on-demand catalog: available-but-not-attached connectors
            // and gallery servers. Drives the `attach_connector` /
            // `attach_mcp_server` enum params — their full tool schemas join
            // the request only after an attach (see dispatch + the loops'
            // late-attach drain).
            let attachable_c: Vec<(String, String)> = {
                let db_state = app.state::<crate::DbState>();
                let conn = db_state.0.lock();
                let credentialed: Vec<String> = db::list_connector_credential_rows(&conn)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|r| r.connector_id)
                    .collect();
                crate::connectors::CONNECTORS
                    .iter()
                    .filter(|c| {
                        (c.is_public() || credentialed.iter().any(|id| id == c.id))
                            && !connector_ids.iter().any(|id| id == c.id)
                    })
                    .map(|c| (c.id.to_string(), c.display_name.to_string()))
                    .collect()
            };
            let attachable_m: Vec<(String, String)> = crate::mcp_gallery::load_defs(&app)
                .into_iter()
                .filter(|d| d.enabled && !mcp_server_ids.iter().any(|id| *id == d.id))
                .map(|d| (d.id, d.name))
                .collect();
            tools::ToolCaps {
                code_exec: code_exec_enabled,
                fs_roots,
                web_search: pcaps.native_web_search,
                requires_local_sandbox: pcaps.requires_local_sandbox,
                attached_connectors: Arc::new(Vec::new()),
                local_docs,
                mcp_tools: Arc::new(Vec::new()),
                fs_rules,
                attachable_connectors: Arc::new(attachable_c),
                attachable_mcp: Arc::new(attachable_m),
                local_model,
            }
        };
        // Fresh late-attach slot for this turn (replaces any stale one).
        self.reset_late_attach(&sid);
        let mgr = Arc::clone(self);

        let handle = tokio::spawn(async move {
            // Capture the turn's start instant for the "Worked for Xs" label.
            let started_at = db::now_ts();
            // Perf accumulator — threads through all streaming/tool-loop paths
            // so the composer metrics row gets real LLM/tool time / TTFT.
            // Registered globally per-session so the token hot path
            // (`emit_token`) can auto-record without threading references
            // through every stream helper.
            let perf = turn_perf::register(&sid, turn_perf::TurnPerf::new(app.clone(), &sid));
            // Checkpoint baseline: snapshot the pre-turn working tree once per
            // session (checkpoint 0 = pre-chat state, so even the first turn
            // is undoable). Only fires for project-bound git-repo sessions;
            // failures are logged inside and never fail the turn.
            // D3: this used to run the `git add -A` snapshot INLINE while
            // HOLDING the global DB mutex, stalling every other DB consumer
            // for the whole snapshot. It now runs on a detached thread (the
            // same shape as the turn-end checkpoint below) which takes the
            // mutex only twice, briefly — repo+gates, then the row insert —
            // and snapshots lock-free in between. The snapshot still starts
            // here, before any model I/O, so it remains pre-turn in practice.
            {
                let ckpt_db = Arc::clone(&db);
                let ckpt_sid = sid.clone();
                let ckpt_app = app.clone();
                std::thread::spawn(move || {
                    crate::checkpoints::maybe_baseline_detached(
                        Some(&ckpt_app),
                        &ckpt_db,
                        &ckpt_sid,
                    );
                });
            }
            // When tools are enabled and the session has connectors attached,
            // connect to each vendor's remote MCP server now (refreshing the
            // OAuth token, listing + classifying its tools). This is per-turn
            // network I/O; failures are non-fatal — a connector that won't
            // connect is skipped and the turn proceeds with the rest. See
            // connectors::session::connect_all.
            let mut caps = caps;
            if tools_enabled && !connector_ids.is_empty() {
                let attached = crate::connectors::connect_all(&app, &connector_ids).await;
                if !attached.is_empty() {
                    caps.attached_connectors = Arc::new(attached);
                }
            }
            // MCP-gallery servers (§3.2.14): every ENABLED installed server
            // attaches to every tool-enabled turn (global, not per-chat).
            // Sessions are cached across turns; a server that fails to
            // start is skipped without failing the turn.
            if tools_enabled {
                let mcp_tools =
                    crate::mcp_gallery::attach_filtered(&app, Some(&mcp_server_ids)).await;
                if !mcp_tools.is_empty() {
                    caps.mcp_tools = Arc::new(mcp_tools);
                }
            }

            // [prompt-audit]: per-source tool attachment feeding this turn's
            // `tools` array — every attached tool ships its full vendor
            // description, and the send path logs the serialized total.
            if tools_enabled {
                let conns: Vec<String> = caps
                    .attached_connectors
                    .iter()
                    .map(|c| {
                        let desc: usize = c
                            .tools
                            .values()
                            .map(|(_, d)| d.as_ref().map(|s| s.len()).unwrap_or(0))
                            .sum();
                        format!(
                            "{}={} tools/{} desc chars",
                            c.display_name,
                            c.tools.len(),
                            desc
                        )
                    })
                    .collect();
                let mut mcp: std::collections::BTreeMap<&str, (usize, usize)> = Default::default();
                for e in caps.mcp_tools.iter() {
                    let agg = mcp.entry(e.server_name.as_str()).or_default();
                    agg.0 += 1;
                    agg.1 += e.description.as_ref().map(|s| s.len()).unwrap_or(0);
                }
                let mcps: Vec<String> = mcp
                    .iter()
                    .map(|(name, (n, desc))| format!("{name}={n} tools/{desc} desc chars"))
                    .collect();
                eprintln!(
                    "[prompt-audit] attached: connectors=[{}] mcp_servers=[{}]",
                    conns.join(", "),
                    mcps.join(", ")
                );
            }

            // ── Per-turn local-docs auto-retrieval (§3.1.7) ─────────────────
            // When the embedding sidecar is running AND the tool is gated on,
            // pre-compute relevant document hits and inject them as a synthetic
            // "Retrieved context" user message so the model answers from the
            // user's own documents WITHOUT an explicit search_docs call.
            let mut chat_req = chat_req;
            if let (Some(base_url), true) = (&embedding_base, tools_enabled && local_docs) {
                // Pinned corpus ids are read synchronously (parking_lot guards
                // aren't Send — they can't cross the await below).
                let pinned_ids = {
                    let conn = db.lock();
                    db::attached_corpus_ids(&conn, &sid).unwrap_or_default()
                };
                let query = chat_req
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.role == "user")
                    .map(|m| m.content.trim())
                    .filter(|c| !c.is_empty())
                    .map(|c| c.to_string());
                let retrieval = compute_docs_retrieval(&db, base_url, query, &pinned_ids).await;
                if !retrieval.is_empty() {
                    chat_req.local_docs_retrieval = retrieval;
                }
            }

            // ── Memory (MEMORY_DESIGN_ARCHITECTURE.md §11, amended): the
            // per-turn on-demand load — identity core + query-matched
            // records, access bumps included — happens in `send_chat_message`
            // (chat/commands.rs 5b), where the system prompt is assembled.
            // The old turn-loop pass here only re-searched to bump access
            // counters (plus an embedding roundtrip); that job moved into
            // `memory::on_demand_injection`. Deeper recall stays available to
            // the model via the `memory_recall` tool.

            // ── Turn execution — candidate chain with fail-over. The primary
            // runs first; Auto-routed sessions carry fail-over candidates
            // (the auto resolver's ordered chain): when one fails BEFORE any
            // token streamed with a retryable class (429 / 5xx / unreachable
            // / bad key / out of credit / dead model), the failure is
            // recorded in the health store (chat/model_health.rs) and the
            // next candidate takes the turn, disclosed via chat:status.
            // Mid-stream failures NEVER re-route (tokens may already be on
            // screen and partially persisted). Pinned sessions have no
            // fallbacks and behave exactly as before. Context-overflow keeps
            // its ONE compact-and-retry per turn.
            let mut retried_after_compaction = false;

            // Candidate set: primary first, then the resolver's fallbacks.
            let mut candidates: Vec<AutoFallback> = Vec::with_capacity(fallbacks.len() + 1);
            candidates.push(AutoFallback {
                provider_id: provider_id.clone(),
                model: chat_req.model.clone(),
                api_key: api_key.clone(),
                base_url: base_url.clone(),
            });
            candidates.extend(fallbacks);

            let mut result: Option<Result<(String, Option<ChatUsage>), String>> = None;
            // Post-turn helpers (citation verification, cache-hit-rate) need
            // the WINNING candidate's endpoint details — tracked here.
            let mut winner: Option<(String, String, bool)> = None;
            for (ci, cand) in candidates.iter().enumerate() {
                // OpenRouter and LocalGguf speak the OpenAI wire format; the
                // rest ride the Anthropic path.
                let cand_is_openai = matches!(
                    cand.provider_id,
                    ChatProviderId::OpenAI
                        | ChatProviderId::OpenAICompatible
                        | ChatProviderId::OpenRouter
                        | ChatProviderId::LocalGguf
                );
                let cand_is_anthropic = matches!(
                    cand.provider_id,
                    ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible
                );
                let cand_provider = resolve_provider(&cand.provider_id);
                let cand_tool_base = cand.base_url.clone().unwrap_or_else(|| {
                    if cand.provider_id == ChatProviderId::OpenRouter {
                        providers::OpenRouterProvider::DEFAULT_BASE.to_string()
                    } else if cand_is_openai {
                        OpenAIProvider::DEFAULT_BASE.to_string()
                    } else {
                        AnthropicProvider::DEFAULT_BASE.to_string()
                    }
                });
                // Anthropic-style cache marks ride the OpenAI wire format ONLY
                // for OpenRouter serving an `anthropic/*` model — OpenRouter
                // translates them into native Claude prompt caching, while
                // stricter OpenAI-compatible backends can reject unknown fields.
                let cand_cache_marks = cand.provider_id == ChatProviderId::OpenRouter
                    && cache::openrouter_anthropic(&cand.model);
                // Rebuild the system prompt for the candidate's provider/model
                // class when the raw inputs are available (Auto sessions) —
                // the prebuilt `system` was assembled for the primary.
                let cand_system: Option<String> = system_inputs.as_ref().and_then(|inp| {
                    let mut s = prompts::build_system_prompt(
                        cand.provider_id.clone(),
                        &cand.model,
                        inp.custom.as_deref(),
                        &inp.skills,
                        tools_enabled,
                        research_mode,
                        inp.plan_mode,
                        inp.manifest.as_deref(),
                        inp.memory_profile.as_deref(),
                    )
                    .unwrap_or_default();
                    s.push_str(&inp.system_suffix);
                    if s.trim().is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                });
                // THIS candidate's request: same messages/params, its own
                // model + system prompt. On success/failure the request's
                // model names what actually ran (cost attribution below).
                chat_req.model = cand.model.clone();
                chat_req.system = cand_system.clone().or(chat_req.system.take());
                let notify_reconnect = |reason: &str, message: String| {
                    let _ = app.emit(
                        "chat:status",
                        ChatStatusPayload {
                            chat_session_id: sid.clone(),
                            reason: reason.to_string(),
                            message,
                        },
                    );
                };
                let attempt = loop {
                    // Scoped so the attempt closure's borrow of `chat_req`
                    // ends with this block: a compaction retry below replaces
                    // the request (`chat_req = rebuilt`), and the closure must
                    // be rebuilt against the new one anyway.
                    let mut attempt = {
                        // Reachability probe for this candidate's endpoint —
                        // the stall watchdog pings it instead of killing a
                        // merely slow stream.
                        let cand_ping = reconnect::PingTarget::new(
                            &client,
                            &cand_tool_base,
                            &cand.api_key,
                            cand_is_anthropic,
                        );
                        // One attempt at this candidate, re-callable: the
                        // reconnect ladder re-issues exactly this (same
                        // model, same request) rather than rebuilding
                        // anything. Its `chat:status` notices are the
                        // "Reconnecting… (n/10)" line the UI shows under the
                        // assistant bubble.
                        let mut run_attempt = || {
                            async {
                                run_turn_attempt(
                                    &client,
                                    cand,
                                    cand_is_openai,
                                    cand_is_anthropic,
                                    cand_cache_marks,
                                    &cand_tool_base,
                                    cand_provider.as_ref(),
                                    &chat_req,
                                    tools_enabled,
                                    caps.clone(),
                                    sandbox,
                                    approval,
                                    &mgr,
                                    &sid,
                                    &app,
                                    research_mode,
                                    &perf,
                                    Some(&cand_ping),
                                )
                                .await
                            }
                        };
                        let mut attempt = run_attempt().await;
                        // A dropped connection is re-dialed in place before
                        // the turn is allowed to fail: the same model, the
                        // same request, up to ten pinged attempts, with the
                        // counter on screen. Only while the turn has caused
                        // nothing yet (`tools_ran == 0`) — replaying a round
                        // that already wrote a file or ran a command would do
                        // it twice, so a stall after a tool keeps the plain
                        // fail-the-turn path.
                        let lost = match &attempt {
                            Err(e)
                                if perf.tools_ran() == 0 && reconnect::is_connection_loss(e) =>
                            {
                                Some(e.clone())
                            }
                            _ => None,
                        };
                        if let Some(first_error) = lost {
                            attempt = reconnect::reconnect(
                                &cand_ping,
                                &reconnect::Config::default(),
                                &notify_reconnect,
                                first_error,
                                // A cancel (or a superseding send) drops this
                                // session's stream entry before it aborts the
                                // task, so this gate sees it even if the abort
                                // lands mid-ladder.
                                &|| mgr.is_current_stream(&sid, tokio::task::id()),
                                &mut run_attempt,
                            )
                            .await;
                        }
                        attempt
                    };
                    let overflow = matches!(&attempt, Err(e) if crate::chat::error_class::classify_error(e) == Some(crate::chat::error_class::CODE_CONTEXT_OVERFLOW));
                    if overflow
                        && !retried_after_compaction
                        && !matches!(cand.provider_id, ChatProviderId::LocalGguf)
                    {
                        retried_after_compaction = true;
                        match compact_and_retry(
                            &db,
                            &client,
                            cand.provider_id.clone(),
                            &cand_tool_base,
                            &cand.api_key,
                            &sid,
                            &chat_req,
                            &app,
                        )
                        .await
                        {
                            Some(rebuilt) => {
                                // Compaction shrank the history — keep this
                                // candidate's model + rebuilt prompt on it.
                                chat_req = rebuilt;
                                chat_req.model = cand.model.clone();
                                chat_req.system = cand_system.clone().or(chat_req.system.take());
                                continue;
                            }
                            None => break attempt,
                        }
                    }
                    break attempt;
                };
                match attempt {
                    Ok(turn) => {
                        // The endpoint works — clear its failure state.
                        {
                            let conn = db.lock();
                            crate::chat::model_health::record_success(
                                &conn,
                                cand.provider_id.as_str(),
                                db::now_ts(),
                            );
                        }
                        winner =
                            Some((cand_tool_base.clone(), cand.api_key.clone(), cand_is_openai));
                        result = Some(Ok(turn));
                        break;
                    }
                    Err(e) => {
                        let failure = crate::chat::error_class::classify_failure(&e);
                        if let Some(f) = &failure {
                            let conn = db.lock();
                            crate::chat::model_health::record_failure(
                                &conn,
                                cand.provider_id.as_str(),
                                &cand.model,
                                f,
                                db::now_ts(),
                            );
                        }
                        let retryable = failure
                            .as_ref()
                            .map(|f| f.kind.retryable())
                            .unwrap_or(false);
                        if retryable && ci + 1 < candidates.len() {
                            let next = &candidates[ci + 1];
                            eprintln!(
                                "[chat:auto] {} · {} failed pre-stream ({}); failing over to {} · {}",
                                cand.provider_id.as_str(),
                                cand.model,
                                crate::util::truncate_chars(&e, 160),
                                next.provider_id.as_str(),
                                next.model,
                            );
                            let _ = app.emit(
                                "chat:status",
                                crate::types::ChatStatusPayload {
                                    chat_session_id: sid.clone(),
                                    // Distinct from the routine "auto_route"
                                    // resolution notice (which the frontend
                                    // suppresses — a pill on every turn read
                                    // as noise): fail-overs are rare and
                                    // worth surfacing.
                                    reason: "auto_failover".to_string(),
                                    message: format!(
                                        "Auto: {} · {} unavailable — trying {} · {}",
                                        crate::chat::auto_router::provider_label(
                                            cand.provider_id.as_str()
                                        ),
                                        cand.model,
                                        crate::chat::auto_router::provider_label(
                                            next.provider_id.as_str()
                                        ),
                                        next.model,
                                    ),
                                },
                            );
                            continue;
                        }
                        result = Some(Err(e));
                        break;
                    }
                }
            }
            let result =
                result.unwrap_or_else(|| Err("no routing candidate was executed".to_string()));
            // Winner details for the post-turn helpers below (only read on
            // the success path, where `winner` is always set). The
            // unwrap_or fallbacks cover the no-candidate corner.
            let tool_base = winner.as_ref().map(|w| w.0.clone()).unwrap_or_default();
            let api_key = winner.as_ref().map(|w| w.1.clone()).unwrap_or(api_key);
            let is_openai = winner.as_ref().map(|w| w.2).unwrap_or(true);

            match result {
                Ok((full_response, usage)) => {
                    // Fold any window a code path forgot to close (defensive —
                    // successful turns close them via end_gen/end_tool) so the
                    // final metrics below see complete spans.
                    perf.close_open_windows();
                    // Context-chain trace ([context] in devtools on the
                    // frontend side): what the provider actually counted for
                    // this turn — the figure the meter renders as "used".
                    // There is deliberately NO context limit on this boundary;
                    // the cap lives in the meter (lib/contextWindow.ts).
                    eprintln!(
                        "[context] provider turn: provider={} model='{}' in={} out={} cache_create={} cache_read={}",
                        provider_id.as_str(),
                        chat_req.model,
                        usage.as_ref().map(|u| u.input_tokens).unwrap_or(0),
                        usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                        usage.as_ref().map(|u| u.cache_creation_input_tokens).unwrap_or(0),
                        usage.as_ref().map(|u| u.cache_read_input_tokens).unwrap_or(0),
                    );
                    // Persist the assistant message with usage.
                    // The turn's message id escapes this block for the
                    // post-done checkpoint (chip attaches to this message).
                    let mut turn_message_id: Option<i64> = None;
                    {
                        let conn = db.lock();
                        // provider + model_key on the row let the rollup group
                        // in-app chat under chat:<provider> and price by the
                        // session's model (spec §8 / §10.3).
                        let model_key =
                            crate::harness_adapters::canonical_model_key(&chat_req.model);
                        let persisted = db::add_chat_message(
                            &conn,
                            db::NewChatMessage {
                                chat_session_id: &sid,
                                role: "assistant",
                                content: &full_response,
                                input_tokens: usage.as_ref().and_then(|u| {
                                    if u.input_tokens > 0 || u.output_tokens > 0 {
                                        Some(u.input_tokens)
                                    } else {
                                        None
                                    }
                                }),
                                output_tokens: usage.as_ref().and_then(|u| {
                                    if u.input_tokens > 0 || u.output_tokens > 0 {
                                        Some(u.output_tokens)
                                    } else {
                                        None
                                    }
                                }),
                                cost_usd: usage.as_ref().and_then(|u| {
                                    if u.input_tokens > 0 || u.output_tokens > 0 {
                                        Some(u.cost_usd)
                                    } else {
                                        None
                                    }
                                }),
                                cache_creation_input_tokens: usage.as_ref().and_then(|u| {
                                    if u.cache_creation_input_tokens > 0 {
                                        Some(u.cache_creation_input_tokens)
                                    } else {
                                        None
                                    }
                                }),
                                cache_read_input_tokens: usage.as_ref().and_then(|u| {
                                    if u.cache_read_input_tokens > 0 {
                                        Some(u.cache_read_input_tokens)
                                    } else {
                                        None
                                    }
                                }),
                                reasoning_output_tokens: usage.as_ref().and_then(|u| {
                                    if u.reasoning_tokens > 0 {
                                        Some(u.reasoning_tokens)
                                    } else {
                                        None
                                    }
                                }),
                                provider: Some(provider_id.as_str()),
                                model_key: model_key,
                                pricing_estimated_usd: None,
                                started_at: Some(started_at),
                                completed_at: Some(db::now_ts()),
                                llm_time_ms: perf.llm_time_ms(),
                                tool_time_ms: perf.tool_time_ms(),
                                ttft_ms: perf.ttft_ms(),
                                tokens_per_second: perf.tokens_per_second(
                                    usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                                ),
                            },
                        );
                        // Attribute this turn's artifacts to the assistant
                        // message so they reappear on its bubble when the chat
                        // is reopened.
                        if let Ok(msg) = persisted {
                            let _ = db::attach_artifacts_to_message(&conn, &sid, msg.id);
                            turn_message_id = Some(msg.id);
                        }
                        let _ = db::touch_chat_session(&conn, &sid);
                    }
                    // Memory extraction (MEMORY_DESIGN_ARCHITECTURE.md §7.1):
                    // background, fire-and-forget — the assistant row is
                    // persisted, so the cursor-based extractor sees the full
                    // turn. Never blocks or fails the reply path.
                    crate::memory::worker::spawn_turn_extraction(&app, &sid);
                    // Citation-integrity lint (research turns only): the
                    // model's report is checked mechanically against the
                    // source ledger — orphan citations, unused sources, weak
                    // attribution. Zero model calls; the verdict rides to the
                    // frontend as `chat:citation-report` and persists in
                    // `citation_reports` for trend tracking.
                    if research_mode && tools_enabled {
                        let artifact_paths: Vec<String> = turn_message_id
                            .and_then(|mid| {
                                let conn = db.lock();
                                db::list_artifacts_for_message(&conn, &sid, mid)
                                    .ok()
                                    .map(|arts| {
                                        arts.into_iter()
                                            .filter(|a| a.kind == "md")
                                            .map(|a| a.path)
                                            .collect::<Vec<_>>()
                                    })
                            })
                            .unwrap_or_default();
                        let report = {
                            let conn = db.lock();
                            citation_lint::lint_and_store(
                                &conn,
                                &sid,
                                turn_message_id,
                                &full_response,
                                &artifact_paths,
                            )
                        };
                        if let Some(report) = report {
                            let weak_numbers: Vec<u32> =
                                report.weak.iter().map(|w| w.number).collect();
                            let orphan_numbers: Vec<u32> =
                                report.orphans.iter().map(|o| o.number).collect();
                            // R10 — async precision sampler: re-judge the
                            // heuristic's weak flags with one background
                            // model call against the session's own provider.
                            // The strip already rendered; when verdicts land,
                            // a refined `chat:citation-report` updates it and
                            // a refined row is persisted for the Fix action.
                            if !report.weak.is_empty()
                                && !matches!(provider_id, ChatProviderId::LocalGguf)
                            {
                                let verify_claims: Vec<citation_verify::VerifyClaim> = report
                                    .weak
                                    .iter()
                                    .take(12)
                                    .map(|w| citation_verify::VerifyClaim {
                                        number: w.number,
                                        sentence: w.sentence.clone(),
                                        excerpt: w.excerpt.clone(),
                                    })
                                    .collect();
                                let client2 = client.clone();
                                let base2 = tool_base.clone();
                                let key2 = api_key.clone();
                                let model2 = chat_req.model.clone();
                                let sid2 = sid.clone();
                                let mid2 = turn_message_id;
                                let app2 = app.clone();
                                let db2 = std::sync::Arc::clone(&db);
                                let report2 = report.clone();
                                let orphan_numbers2 = orphan_numbers.clone();
                                tauri::async_runtime::spawn(async move {
                                    let verdicts = citation_verify::verify_via_provider(
                                        &client2,
                                        provider_id,
                                        &base2,
                                        &key2,
                                        &model2,
                                        &verify_claims,
                                    )
                                    .await;
                                    let Ok(verdicts) = verdicts else {
                                        return; // silent: verification is best-effort
                                    };
                                    let supported: Vec<u32> = verdicts
                                        .iter()
                                        .filter(|v| v.verdict == "supported")
                                        .map(|v| v.number)
                                        .collect();
                                    if supported.is_empty() {
                                        return; // nothing cleared — no update needed
                                    }
                                    let refined = {
                                        let conn = db2.lock();
                                        citation_lint::refine_with_verdicts(
                                            &conn, &sid2, mid2, &report2, &verdicts,
                                        )
                                    };
                                    if let Some(refined) = refined {
                                        let weak_numbers: Vec<u32> =
                                            refined.weak.iter().map(|w| w.number).collect();
                                        let _ = app2.emit(
                                            "chat:citation-report",
                                            CitationReportPayload {
                                                chat_session_id: sid2,
                                                message_id: mid2,
                                                total_citations: refined.total_citations,
                                                orphan_count: refined.orphan_count,
                                                unused_count: refined.unused_ledger_count,
                                                uncited_sentences: refined.uncited_sentences,
                                                weak_count: refined.weak_count,
                                                weak_numbers,
                                                orphan_numbers: orphan_numbers2,
                                            },
                                        );
                                    }
                                });
                            }
                            let _ = app.emit(
                                "chat:citation-report",
                                CitationReportPayload {
                                    chat_session_id: sid.clone(),
                                    message_id: turn_message_id,
                                    total_citations: report.total_citations,
                                    orphan_count: report.orphan_count,
                                    unused_count: report.unused_ledger_count,
                                    uncited_sentences: report.uncited_sentences,
                                    weak_count: report.weak_count,
                                    weak_numbers,
                                    orphan_numbers,
                                },
                            );
                        }
                    }
                    let _ = app.emit(
                        "chat:done",
                        ChatDonePayload {
                            chat_session_id: sid.clone(),
                            input_tokens: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    // The HUD's IN figure is the UNCACHED
                                    // prompt slice: OpenAI-style prompt_tokens
                                    // already embeds the cache read — strip it
                                    // (Anthropic-style input is exclusive
                                    // already). The raw figure stays on the DB
                                    // row for the cost rollups.
                                    Some(if is_openai {
                                        (u.input_tokens - u.cache_read_input_tokens).max(0)
                                    } else {
                                        u.input_tokens
                                    })
                                } else {
                                    None
                                }
                            }),
                            output_tokens: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.output_tokens)
                                } else {
                                    None
                                }
                            }),
                            cost_usd: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.cost_usd)
                                } else {
                                    None
                                }
                            }),
                            // Populated by the TurnPerf accumulator captured in
                            // the tool loops / stream below.
                            llm_time_ms: perf.llm_time_ms(),
                            tool_time_ms: perf.tool_time_ms(),
                            ttft_ms: perf.ttft_ms(),
                            tokens_per_second: perf.tokens_per_second(
                                usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                            ),
                            cache_hit_rate: usage.as_ref().and_then(|u| {
                                crate::chat::turn_perf::cache_hit_rate(
                                    u.cache_read_input_tokens,
                                    u.cache_creation_input_tokens,
                                    u.input_tokens,
                                    // OpenAI-style prompt_tokens already
                                    // includes the cached tokens; Anthropic
                                    // bills them separately.
                                    is_openai,
                                )
                            }),
                        },
                    );

                    // Per-turn git checkpoint — runs detached AFTER the done
                    // event so the UI's turn handling never waits on git.
                    // Project-bound git-repo sessions only; unchanged turns
                    // dedup-skip inside.
                    if let Some(mid) = turn_message_id {
                        let db = Arc::clone(&db);
                        let ckpt_sid = sid.clone();
                        let ckpt_app = app.clone();
                        std::thread::spawn(move || {
                            let conn = db.lock();
                            if let Some(repo) = db::chat_session_repo_path(&conn, &ckpt_sid) {
                                crate::checkpoints::after_turn(
                                    Some(&ckpt_app),
                                    &conn,
                                    &ckpt_sid,
                                    Some(mid),
                                    std::path::Path::new(&repo),
                                );
                            }
                        });
                    }
                }
                Err(e) => {
                    // The stream failed (HTTP status, SSE stall, tool loop
                    // abort, …). Log it — the UI banner only shows a truncated
                    // version, and some errors (e.g. llama-server 400 bodies)
                    // name the exact rejected field.
                    eprintln!("[chat:stream] turn failed for {sid}: {e}");
                    // Classify before moving the message into the payload: a
                    // context-overflow rejection is recoverable and the
                    // frontend keys its "compact / new chat" copy off the code.
                    let code = crate::chat::error_class::classify_error(&e);
                    let _ = app.emit(
                        "chat:error",
                        ChatErrorPayload {
                            chat_session_id: sid.clone(),
                            message: e,
                            code: code.map(|c| c.to_string()),
                        },
                    );
                }
            }

            // The stream finished (either done or aborted). Drop the abort
            // handle from the registry so a future `send` for this session
            // starts clean — but only if the entry still belongs to THIS
            // stream. A superseding send() may already have replaced it;
            // removing unconditionally would clobber the newer stream's
            // handle and leave it uncancellable.
            mgr.remove_stream_if_current(&sid, tokio::task::id());
            // Drop this turn's late-attach slot — anything the model attached
            // mid-turn is already persisted to the session rows, so the next
            // turn re-attaches through the normal send path.
            mgr.clear_late_attach(&sid);
            // Clear the active per-turn perf accumulator so a later turn
            // starts fresh (and so `emit_token` stops recording to it).
            crate::chat::turn_perf::unregister(&sid);
        });

        self.streams
            .lock()
            .insert(chat_session_id.clone(), handle.abort_handle());
    }

    /// Whether `task_id` is still the registered stream for this session.
    ///
    /// The turn task's own id, so a cancelled turn (whose entry
    /// `ChatManager::cancel` removes before aborting the task) and a
    /// superseded one (whose entry a newer `send` replaces) both read as
    /// "not current". The reconnect ladder polls this between attempts: it is
    /// the one gate that still sees a cancel landing while the ladder is
    /// parked between awaits, before the abort tears the task down.
    pub(crate) fn is_current_stream(
        &self,
        chat_session_id: &str,
        task_id: tokio::task::Id,
    ) -> bool {
        self.streams
            .lock()
            .get(chat_session_id)
            .is_some_and(|h| h.id() == task_id)
    }

    /// Remove the abort-handle registry entry for a finished stream — but only
    /// if the entry still maps to that stream's own handle (identified by its
    /// task id). A superseding `send` for the same session replaces the entry;
    /// without this check the old stream's cleanup would clobber the newer
    /// stream's handle and leave it uncancellable.
    fn remove_stream_if_current(&self, chat_session_id: &str, task_id: tokio::task::Id) {
        let mut streams = self.streams.lock();
        if streams
            .get(chat_session_id)
            .is_some_and(|h| h.id() == task_id)
        {
            streams.remove(chat_session_id);
        }
    }

    /// Cancel an active stream for the given session (no-op if none active).
    /// Also aborts any live subagent (`Task`) loops the turn spawned, drops
    /// pending per-action approvals for the session so their paused loops
    /// resume as "denied" rather than hanging forever, and clears the
    /// per-turn perf accumulator + late-attach slot — those are normally
    /// released by the spawned task's tail, which NEVER runs when the turn is
    /// aborted here (an aborted 500 ms perf heartbeat used to emit
    /// `chat:perf` forever, and live connector MCP sessions stayed parked in
    /// the late-attach map for the process lifetime).
    pub fn cancel(&self, chat_session_id: &str) {
        if let Some(handle) = self.streams.lock().remove(chat_session_id) {
            handle.abort();
        }
        self.abort_child_tasks(chat_session_id);
        self.drop_pending_for_session(chat_session_id);
        // A superseding `send` cancels first, THEN re-registers perf and the
        // late-attach slot — so clearing them here cannot hurt the new turn.
        crate::chat::turn_perf::unregister(chat_session_id);
        self.clear_late_attach(chat_session_id);
    }

    /// App-exit cleanup: cancel all active streams.
    pub fn cancel_all(&self) {
        let handles: Vec<_> = self.streams.lock().drain().map(|(_, h)| h).collect();
        for handle in handles {
            handle.abort();
        }
        // Abort every live subagent loop too.
        let children: Vec<_> = self
            .child_tasks
            .lock()
            .drain()
            .flat_map(|(_, list)| list)
            .collect();
        for handle in children {
            handle.abort();
        }
        // Drop all pending approvals too.
        let ids: Vec<String> = self.pending.lock().keys().cloned().collect();
        for id in ids {
            self.pending.lock().remove(&id);
        }
    }
}

/// Pre-compute the per-turn local-docs auto-retrieval (§3.1.7).
///
/// Two retrieval paths are merged (both results passed in from the synchronous
/// caller so no parking_lot guards cross the async boundary):
/// 1. **Pinned** — top 2 hits from any corpus the user explicitly attached
///    to this chat. Always included so pinned docs are always in context.
/// 2. **Auto-matched** — top 2 hits from ALL enabled corpora using the
///    latest user message as the query. Included when a meaningful query exists.
///
/// Results are deduplicated by path and capped at 4 total. Best-effort:
/// any step failing returns an empty Vec so the turn proceeds without injection
/// (the user still has the `search_docs` tool as a manual fallback).
pub(crate) async fn compute_docs_retrieval(
    db: &Arc<Mutex<rusqlite::Connection>>,
    base_url: &str,
    query: Option<String>,
    pinned_ids: &[String],
) -> Vec<String> {
    let query_vec = match &query {
        Some(q) => {
            let vecs = match local_models::embed_texts(base_url, &[q.clone()]).await {
                Ok(v) => v,
                Err(_) => return Vec::new(),
            };
            match vecs.into_iter().next() {
                Some(v) => Some(v),
                None => None,
            }
        }
        None => None,
    };

    // DB reads happen in spawn_blocking: parking_lot guards aren't Send, so a
    // guard held across an await would make the spawn future non-Send. The Arc
    // is Send+Sync (Connection is Send), so it clones cleanly into the closure.
    let db = Arc::clone(db);
    let _base_url_owned = base_url.to_string();
    let query_vec_owned = query_vec;
    let pinned_ids_owned: Vec<String> = pinned_ids.iter().cloned().collect();
    let hits = tokio::task::spawn_blocking(move || {
        let conn = db.lock();
        let mut results: Vec<(String, String, f32)> = Vec::new();

        // Pinned: always include top 2 hits per pinned corpus.
        for corpus_id in &pinned_ids_owned {
            if let Ok(list) = crate::db::search_chunks_in_corpus(
                &conn,
                query_vec_owned.as_deref().unwrap_or(&[]),
                corpus_id,
                2,
            ) {
                for h in list {
                    results.push((h.path, h.content, h.score));
                }
            }
        }

        // Auto-matched: top 2 from all corpora (deduplicated against pinned).
        if let Some(ref qv) = query_vec_owned {
            if let Ok(auto) = crate::db::search_chunks(&conn, qv, 2) {
                for h in auto {
                    if !results.iter().any(|(p, _, _)| p == &h.path) {
                        results.push((h.path, h.content, h.score));
                    }
                }
            }
        }

        results
    })
    .await
    .unwrap_or_default();

    if hits.is_empty() {
        return Vec::new();
    }

    const MAX_CHUNK: usize = 600;
    const MAX_HITS: usize = 4;
    let body: Vec<String> = hits
        .into_iter()
        .take(MAX_HITS)
        .map(|(path, content, score)| {
            // Char-safe cap: a raw byte slice panics when MAX_CHUNK lands
            // mid-codepoint (any CJK/emoji corpus) — and this runs inside the
            // spawned turn task, where a panic kills the turn silently (B-1).
            let text = crate::util::truncate_chars(&content, MAX_CHUNK);
            let text = if content.chars().count() > MAX_CHUNK {
                format!("{text}…")
            } else {
                text
            };
            format!("[{} · score={:.2}]\n{}", path, score, text)
        })
        .collect();

    // Prefix with a contextual hint so the model knows what this is.
    let prefix = if pinned_ids.is_empty() {
        "Retrieved from your local documents:".to_string()
    } else {
        "From your pinned documents and your local documents:".to_string()
    };
    std::iter::once(prefix).chain(body).collect()
}

/// One attempt at a turn for a single candidate: the tool loop matching the
/// candidate's wire format, or the plain streaming path when tools are off.
///
/// Factored out of `send` so the reconnect ladder can re-issue it verbatim
/// (`chat/reconnect.rs`): a retry must be the SAME request the lost attempt
/// was, or the ladder would quietly change provider, model or prompt.
#[allow(clippy::too_many_arguments)]
async fn run_turn_attempt(
    client: &reqwest::Client,
    cand: &AutoFallback,
    cand_is_openai: bool,
    cand_is_anthropic: bool,
    cand_cache_marks: bool,
    cand_tool_base: &str,
    cand_provider: &dyn ChatProvider,
    chat_req: &ChatRequest,
    tools_enabled: bool,
    caps: tools::ToolCaps,
    sandbox: permission::SandboxPolicy,
    approval: permission::ApprovalPolicy,
    mgr: &Arc<ChatManager>,
    sid: &str,
    app: &AppHandle,
    research_mode: bool,
    perf: &turn_perf::TurnPerf,
    ping: Option<&reconnect::PingTarget>,
) -> Result<(String, Option<ChatUsage>), String> {
    if tools_enabled && cand_is_openai {
        run_openai_tool_loop(
            client,
            cand_tool_base,
            &cand.api_key,
            chat_req,
            caps,
            sandbox,
            approval,
            mgr,
            sid,
            app,
            research_mode,
            cand_cache_marks,
            perf.clone(),
        )
        .await
    } else if tools_enabled && cand_is_anthropic {
        run_anthropic_tool_loop(
            client,
            cand_tool_base,
            &cand.api_key,
            chat_req,
            caps,
            sandbox,
            approval,
            mgr,
            sid,
            app,
            research_mode,
            perf.clone(),
        )
        .await
    } else {
        run_chat_stream(
            client,
            cand_provider,
            sid,
            chat_req,
            &cand.api_key,
            cand.base_url.as_deref(),
            Some(app),
            perf,
            ping,
        )
        .await
    }
}

/// Runs the full SSE stream lifecycle for one chat request.
/// Returns the accumulated assistant text and optional usage info.
/// `app` may be `None` in headless tests (token events then flow only
/// through `stream_events::try_send`, which is a no-op without a
/// subscriber).
pub(crate) async fn run_chat_stream(
    client: &reqwest::Client,
    provider: &dyn ChatProvider,
    chat_session_id: &str,
    req: &ChatRequest,
    api_key: &str,
    base_url: Option<&str>,
    app: Option<&AppHandle>,
    perf: &turn_perf::TurnPerf,
    // Endpoint probe for the stall watchdog: while the endpoint answers, a
    // silent round is treated as a slow model rather than a lost connection
    // (chat/reconnect.rs). `None` keeps the old flat deadline.
    ping: Option<&reconnect::PingTarget>,
) -> Result<(String, Option<ChatUsage>), String> {
    let request = provider
        .build_request(client, req, api_key, base_url)
        .map_err(|e| format!("failed to build request: {e}"))?;

    // Open the generation window BEFORE the request is issued, matching the
    // tool loops: TTFT (anchored at this instant) then covers connect +
    // prompt eval, and llm time means the same thing with tools on or off.
    perf.begin_gen();

    // B-10: bound time-to-headers — a blackholed connect otherwise hangs the
    // turn forever (OS TCP timeouts can be minutes). The B-9 watchdog below
    // covers the body.
    let response = tokio::time::timeout(std::time::Duration::from_secs(60), request.send())
        .await
        .map_err(|_| "request timed out waiting for response headers (60s)".to_string())?
        .map_err(|e| format!("request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    // (stream reads go through stream_next_with_watchdog, which brings its
    // own StreamExt — no local import.)

    let mut stream = response.bytes_stream();
    let mut buf = String::new(); // SSE buffer passed to provider parser
                                 // Carry-over for partial lines: TCP chunks split SSE `data:` lines
                                 // arbitrarily, and feeding half a line into parse_sse_chunk is fatal
                                 // (its serde_json::from_str fails and kills the whole turn). Only
                                 // complete, newline-terminated lines may be parsed — same pattern the
                                 // tool-loop rounds use in streaming.rs. B-14: byte-buffered, so a
                                 // multi-byte char split across reads is never corrupted.
    let mut pending = crate::util::SseLineBuffer::new();
    let mut full_text = String::new();
    // Shared provider-SSE pump (streaming.rs): reasoning-sentinel <think>
    // wrapping, full-text accumulation, and B-18 parse-failure tolerance —
    // a stray malformed line is skipped, MAX_PARSE_FAILURES consecutive
    // failures fail the turn, and genuine "provider error:" events fail
    // immediately.
    let mut pump = crate::chat::streaming::ProviderSsePump::new(&mut buf, &mut full_text);

    // Token emit: stream_events channel first, app event as the fallback
    // (headless tests run without an app handle).
    let emit_token = |out: String| {
        let payload = ChatTokenPayload {
            chat_session_id: chat_session_id.to_string(),
            token: out,
        };
        if !crate::chat::stream_events::try_send(chat_session_id, &payload) {
            if let Some(app) = app {
                let _ = app.emit("chat:token", payload);
            }
        }
    };

    // D4: the done flag previously broke only the INNER line loop, so the
    // outer read kept pulling from the SSE body. Providers that hold the
    // connection open after `data: [DONE]` then parked here on the 60s
    // watchdog and FAILED the turn after the answer had already streamed.
    // The `'read` label makes `[DONE]` terminal for the whole loop; usage is
    // parsed from the accumulated buffer below either way.
    'read: loop {
        // B-9: stall watchdog — a silent connection must fail the turn, not
        // park it forever. With `ping`, silence is probed: a slow model on a
        // live endpoint is allowed to finish, and a dead endpoint fails the
        // read immediately (see streaming::stream_next_with_watchdog), which
        // is what starts the reconnect ladder in `send`.
        let chunk = match crate::chat::streaming::stream_next_with_watchdog(
            &mut stream,
            std::time::Duration::from_secs(60),
            ping,
        )
        .await
        {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(e),
        };

        let complete_lines = pending.push(&chunk);

        for line in complete_lines {
            let line = line.trim_end();
            match pump.line(provider, line) {
                Ok(crate::chat::streaming::SsePumpEvent::Token(out)) => {
                    emit_token(out);
                    perf.record_token();
                    perf.maybe_emit_perf();
                }
                Ok(crate::chat::streaming::SsePumpEvent::Done) => {
                    // Stream done — usage will be parsed from buffer below.
                    break 'read;
                }
                Ok(crate::chat::streaming::SsePumpEvent::Quiet) => {}
                Err(e) => return Err(e),
            }
        }
    }

    // EOF flush: a final line with no trailing newline (some local servers
    // close this way) is still complete and must be parsed — pre-buffering
    // behavior did so via str::lines. Parse failures here are tolerated, not
    // fatal: the stream has already ended, and erroring now would throw away
    // a turn whose tokens were all delivered.
    for trailing in pending.finish() {
        let trailing = trailing.trim_end();
        if trailing.is_empty() {
            continue;
        }
        if let Ok(crate::chat::streaming::SsePumpEvent::Token(out)) = pump.line(provider, trailing)
        {
            emit_token(out);
            perf.record_token();
            perf.maybe_emit_perf();
        }
    }

    if let Some(closing) = pump.close_think() {
        full_text.push_str(&closing);
        // Structural closer, not a model token — emit without recording so
        // the live OUT/tok/s aren't bumped by UI scaffolding.
        emit_token(closing);
    }

    let usage = provider.parse_usage(&buf);
    // Close the generation window — all subsequent time (tool exec, next
    // round's prompt build) falls outside LLM time.
    perf.end_gen();
    Ok((full_text, usage))
}

/// Force one cloud compaction pass over the session's DB history and rebuild
/// the turn request from the rewritten history. Used exclusively by the
/// compact-and-retry path when the provider rejected the original request
/// with a context-overflow error. Returns `None` when there is nothing to
/// compact, the summarizer failed, or persistence failed — the caller then
/// surfaces the original error instead of retrying.
///
/// Locking: `db` guards must never span an await; every lock here is scoped
/// to a sync block (same rule as the send path's compaction block).
#[allow(clippy::too_many_arguments)]
async fn compact_and_retry(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    client: &reqwest::Client,
    provider_id: ChatProviderId,
    base: &str,
    api_key: &str,
    sid: &str,
    chat_req: &ChatRequest,
    app: &AppHandle,
) -> Option<ChatRequest> {
    let cfg = {
        let conn = db.lock();
        crate::chat::cloud_compact::load_cloud_compaction_config(&conn)
    };
    // Rebuild the active history exactly the way the send path does — the
    // oversized request's rows are all already persisted (the user message
    // before send, any tool rounds during it).
    let entries: Vec<crate::chat::compaction::CompactionEntry> = {
        let conn = db.lock();
        db::list_active_chat_messages(&conn, sid).ok()?
    }
    .into_iter()
    .map(|r| crate::chat::compaction::CompactionEntry {
        id: r.id,
        message: ChatMessage {
            role: r.role,
            content: crate::chat::commands::strip_think_blocks(&r.content),
            images: Vec::new(),
        },
    })
    .collect();

    let _ = app.emit(
        "chat:status",
        ChatStatusPayload {
            chat_session_id: sid.to_string(),
            reason: "context_compacting".to_string(),
            message: "Context window full — compacting and retrying…".to_string(),
        },
    );
    let run = crate::chat::cloud_compact::run_cloud_compaction(
        client,
        provider_id,
        base,
        api_key,
        &chat_req.model,
        &chat_req.system,
        &entries,
        cfg.pin_exchanges,
    )
    .await
    .ok()?;
    {
        let conn = db.lock();
        crate::chat::cloud_compact::persist_summary_row(&conn, sid, &run).ok()?;
    }
    eprintln!(
        "[cloud-compaction] overflow retry: compacted {} exchange(s) (~{}→{} est. tokens)",
        run.compacted_exchange_count, run.pre_tokens, run.post_tokens,
    );
    let _ = app.emit(
        "chat:status",
        ChatStatusPayload {
            chat_session_id: sid.to_string(),
            reason: "context_compacted".to_string(),
            message: format!(
                "Context compacted (~{} → {} tokens, estimated) — retrying…",
                crate::chat::commands::format_compact_token_count(run.pre_tokens as i64),
                crate::chat::commands::format_compact_token_count(run.post_tokens as i64),
            ),
        },
    );
    let mut rebuilt = chat_req.clone();
    rebuilt.messages = run.messages;
    Some(rebuilt)
}

/// Headless one-shot for automations with API providers / local GGUF.
/// Sends the prompt via the chat HTTP API, collects the full response,
/// and persists both user + assistant messages. Blocking — runs the
/// async stream on a temporary tokio runtime.
pub fn run_one_shot_chat(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    chat_session_id: &str,
    prompt: &str,
    provider_str: &str,
    model_str: &str,
) -> Result<(), String> {
    let (api_key, base_url) = {
        let conn = db.lock();
        let key = crate::secrets::get_chat_api_key(&conn, provider_str);
        if key.is_none() && provider_str != "local_gguf" {
            return Err(format!(
                "No API key configured for {provider_str}. Set one in Settings → Connectors."
            ));
        }
        let base = crate::db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .ok()
            .flatten();
        (key.unwrap_or_default(), base)
    };

    // Persist the user message
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
        crate::db::touch_chat_session(&conn, chat_session_id).map_err(|e| e.to_string())?;
    }

    let model = if model_str.is_empty() {
        let conn = db.lock();
        crate::db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .ok()
            .flatten()
            .unwrap_or_default()
    } else {
        model_str.to_string()
    };
    if model.is_empty() && provider_str != "local_gguf" {
        return Err("No model configured for this provider".into());
    }

    let system_prompt = {
        let conn = db.lock();
        crate::db::get_setting(&conn, "assistant.systemPrompt")
            .ok()
            .flatten()
            .unwrap_or_default()
    };

    let system = system_prompt.trim().to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;

    let started_at = crate::db::now_ts();
    let (response_text, _usage) = rt.block_on(async {
        match provider_str {
            "openai" | "openrouter" => {
                let base = base_url.as_deref().unwrap_or(if provider_str == "openrouter" {
                    crate::chat::providers::OpenRouterProvider::DEFAULT_BASE
                } else {
                    crate::chat::providers::OpenAIProvider::DEFAULT_BASE
                });
                crate::chat::llm_client::openai_oneshot(
                    &client, &api_key, base, &model, &system, prompt,
                )
                .await
                .map(|t| (t, None::<crate::chat::providers::ChatUsage>))
            }
            "openai_compatible" | "local_gguf" => {
                let Some(base) = base_url.as_deref() else {
                    return Err("No base URL configured for this provider. Set one in Settings \u{2192} Connectors.".into());
                };
                crate::chat::llm_client::openai_oneshot(
                    &client, &api_key, base, &model, &system, prompt,
                )
                .await
                .map(|t| (t, None::<crate::chat::providers::ChatUsage>))
            }
            "anthropic" | "anthropic_compatible" => {
                let base = base_url.as_deref().unwrap_or(
                    crate::chat::providers::AnthropicProvider::DEFAULT_BASE,
                );
                crate::chat::llm_client::anthropic_oneshot(
                    &client, &api_key, base, &model, &system, prompt, 1024,
                )
                .await
                .map(|t| (t, None::<crate::chat::providers::ChatUsage>))
            }
            other => Err(format!("unsupported provider for one-shot: {other}")),
        }
    })?;

    // Persist the assistant response
    {
        let conn = db.lock();
        crate::db::add_chat_message(
            &conn,
            crate::db::NewChatMessage {
                chat_session_id: chat_session_id,
                role: "assistant",
                content: &response_text,
                input_tokens: None,
                output_tokens: None,
                cost_usd: None,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: None,
                model_key: None,
                pricing_estimated_usd: None,
                started_at: Some(started_at),
                completed_at: Some(crate::db::now_ts()),
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .map_err(|e| e.to_string())?;
        crate::db::touch_chat_session(&conn, chat_session_id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_trigger_fires_on_research_phrases() {
        assert!(is_research_request(
            "Research the history of the Rust language"
        ));
        assert!(is_research_request(
            "Can you find out about WebGPU adoption?"
        ));
        assert!(is_research_request(
            "What's the current state of WebGPU across browsers?"
        ));
        assert!(is_research_request(
            "Compare React and Vue for a new dashboard"
        ));
        assert!(is_research_request(
            "Do a survey of recent transformer papers"
        ));
        assert!(is_research_request("Investigate the cause of the outage"));
        assert!(is_research_request("Deep dive on CRDTs please"));
    }

    /// Fresh-turn budget guard (attach-on-demand): a fresh tool-enabled turn
    /// ships only core prompt + skills catalog + attach manifest + built-in
    /// tool specs — no connector/MCP schemas until an attach. Char proxy:
    /// the specs JSON measured ≈4.1 chars/token against llama-server's
    /// /tokenize (description-dense JSON) and prompt prose ≈3.3, so the
    /// assembled baseline must stay under ~60k chars to keep prompt_tokens
    /// < 15k. The live `[prompt-audit]` logs are ground truth; a regression
    /// here almost certainly re-inlined a schema or guide that every turn
    /// pays for (see DOC_STYLE_GUIDE for the moved-out example).
    #[test]
    fn fresh_turn_baseline_under_15k_budget() {
        let caps = tools::ToolCaps {
            // Reflect a real fresh turn: attachable sources present → the
            // attach meta-tools are advertised too.
            attachable_connectors: std::sync::Arc::new(vec![
                ("gmail".to_string(), "Gmail".to_string()),
                ("notion".to_string(), "Notion".to_string()),
            ]),
            attachable_mcp: std::sync::Arc::new(vec![("fs".to_string(), "Filesystem".to_string())]),
            ..tools::ToolCaps::default()
        };
        let sandbox = crate::chat::permission::SandboxPolicy::WorkspaceWrite;
        let all_specs = tools::openai_tool_specs(&caps, sandbox);
        let mut by_size: Vec<(usize, String)> = all_specs
            .iter()
            .map(|s| {
                (
                    serde_json::to_string(s).unwrap().len(),
                    s.pointer("/function/name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("?")
                        .to_string(),
                )
            })
            .collect();
        by_size.sort_by(|a, b| b.0.cmp(&a.0));
        for (size, name) in by_size.iter().take(10) {
            println!("[budget] {name}: {size} chars");
        }
        let specs = serde_json::to_string(&all_specs).unwrap();
        let manifest = prompts::attach_manifest_segment(
            &[prompts::ManifestEntry {
                id: "gmail".into(),
                name: "Gmail".into(),
                description: "Read and send email.".into(),
            }],
            &[],
        );
        let system = build_system_prompt(
            ChatProviderId::LocalGguf,
            "llama-3.1-8b",
            Some("always respond in english"),
            &[],
            true,
            false,
            false,
            manifest.as_deref(),
            None,
        )
        .unwrap();
        let total = system.len() + specs.len();
        println!(
            "fresh-turn baseline: system {} + specs {} = {} chars",
            system.len(),
            specs.len(),
            total
        );
        // ≈15k tokens at ~4 chars/token. The measured baseline after the
        // token-efficiency pass was ≈50.4k chars (system ≈7.9k + specs
        // ≈42.5k); it has since drifted to ≈51.4k (system ≈8.2k) from
        // shipped capabilities joining the registry (automations, artifact
        // listing) — re-baselined here so the guard keeps catching RE-BLOAT
        // instead of failing on every legitimate tool. The assert below locks
        // that in — a change that re-bloats the fixed per-turn cost fails
        // here instead of shipping a permanent tax on every request.
        // Headroom covers the per-turn date anchor, whose rendered length
        // varies with the weekday/UTC-offset strings. Re-baselined
        // 2026-09-06 (52.0k -> 55.5k) for three shipped capabilities joining
        // the registry: totp_code (2FA), browser_observe, browser_extract,
        // plus the Task tool's background param — each reviewed for length
        // before landing.
        assert!(
            total < 55_500,
            "fresh-turn baseline over fixed-cost budget: {total} chars"
        );
    }

    #[test]
    fn research_override_prefix_forces_research_mode() {
        // /research bypasses the single-fact guards even with no trigger phrase.
        assert!(is_research_request("/research the evolution of CPUs"));
        assert!(is_research_request("/Research something niche"));
    }

    #[test]
    fn single_fact_questions_do_not_trigger() {
        assert!(!is_research_request("What is the capital of France?"));
        assert!(!is_research_request("Who is the CEO of OpenAI?"));
        assert!(!is_research_request("population of japan"));
        assert!(!is_research_request("definition of recursion"));
        assert!(!is_research_request("what time is it in Tokyo"));
    }

    #[test]
    fn plain_questions_do_not_trigger() {
        assert!(!is_research_request("What is 2+2?"));
        assert!(!is_research_request("Write me a haiku about the sea"));
        assert!(!is_research_request(""));
        assert!(!is_research_request("   "));
    }

    #[test]
    fn research_segment_present_only_when_research_mode_and_tools() {
        // research_mode with tools on -> segment present.
        let p = build_system_prompt(
            ChatProviderId::Anthropic,
            "claude-sonnet-5",
            None,
            &[],
            true,
            true,
            false,
            None,
            None,
        )
        .unwrap();
        assert!(p.contains("Research mode (this turn)"));
        assert!(p.contains("reset_source_ledger"));
        // tools on but not research -> no segment.
        let p = build_system_prompt(
            ChatProviderId::Anthropic,
            "claude-sonnet-5",
            None,
            &[],
            true,
            false,
            false,
            None,
            None,
        )
        .unwrap();
        assert!(!p.contains("Research mode (this turn)"));
        // research_mode true but tools off -> segment suppressed (defense-in-depth).
        let p = build_system_prompt(
            ChatProviderId::Anthropic,
            "claude-sonnet-5",
            None,
            &[],
            false,
            true,
            false,
            None,
            None,
        )
        .unwrap();
        assert!(!p.contains("Research mode (this turn)"));
    }

    #[test]
    fn research_local_addendum_for_local_models() {
        let p = build_system_prompt(
            ChatProviderId::OpenAICompatible,
            "llama-3.1-8b",
            None,
            &[],
            true,
            true,
            false,
            None,
            None,
        )
        .unwrap();
        assert!(p.contains("cap at 8 reads"));
        // Frontier model does not get the local addendum.
        let pf = build_system_prompt(
            ChatProviderId::Anthropic,
            "claude-sonnet-5",
            None,
            &[],
            true,
            true,
            false,
            None,
            None,
        )
        .unwrap();
        assert!(!pf.contains("cap at 8 reads"));
    }

    #[test]
    fn parse_tool_args_plain_object() {
        let v = parse_tool_args(r#"{"query":"rust"}"#);
        assert_eq!(v["query"], "rust");
    }

    #[test]
    fn parse_tool_args_recovers_from_prepended_empty_object() {
        // Observed from an OpenAI-compatible proxy.
        let v = parse_tool_args(r#"{}{"query": "population of France"}"#);
        assert_eq!(v["query"], "population of France");
    }

    #[test]
    fn parse_tool_args_merges_concatenated_objects() {
        let v = parse_tool_args(r#"{"a":1}{"b":2}"#);
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], 2);
    }

    #[test]
    fn parse_tool_args_empty_is_object() {
        assert_eq!(parse_tool_args(""), json!({}));
        assert_eq!(parse_tool_args("   "), json!({}));
    }

    #[test]
    fn parse_hermes_web_search_cow() {
        // Exact payload observed from an OpenAI-compatible aggregator: the
        // model emitted its trained Hermes tool-call format as plain text in
        // `content` instead of populating `tool_calls`.
        let content = "Let me search for \"cow\" in the browser.\n\n<tool_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\" string=\"true\">cow</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).expect("should recover a call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "web_search");
        assert_eq!(calls[0].1["query"], "cow");
    }

    #[test]
    fn parse_hermes_generate_document_docx() {
        // The exact docx artifact request that was being echoed as text.
        let content = "Sure — I'll generate a clean sample Word document.\n\n<tool_calls>\n<invoke name=\"generate_document\">\n<parameter name=\"format\" type=\"string\">docx</parameter>\n<parameter name=\"instructions\" type=\"string\">Create a sample Word document with a title, sections, a bulleted list, and a 3x3 table.</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).expect("should recover a call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "generate_document");
        assert_eq!(calls[0].1["format"], "docx");
        assert!(calls[0].1["instructions"]
            .as_str()
            .unwrap()
            .contains("table"));
    }

    #[test]
    fn parse_hermes_multiple_invokes() {
        let content = "<tool_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\">one</parameter>\n</invoke>\n<invoke name=\"fetch_url\">\n<parameter name=\"url\">https://example.com</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).expect("should recover both calls");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "web_search");
        assert_eq!(calls[0].1["query"], "one");
        assert_eq!(calls[1].0, "fetch_url");
        assert_eq!(calls[1].1["url"], "https://example.com");
    }

    #[test]
    fn parse_hermes_none_when_no_block() {
        assert!(parse_hermes_tool_calls("Just a normal answer.").is_none());
        assert!(parse_hermes_tool_calls("").is_none());
    }

    #[test]
    fn parse_hermes_coerces_types() {
        // Booleans, ints, floats and JSON values should be typed, not stringified.
        let content = "<tool_calls>\n<invoke name=\"run_code\">\n<parameter name=\"language\">python</parameter>\n<parameter name=\"enabled\">true</parameter>\n<parameter name=\"count\">3</parameter>\n<parameter name=\"ratio\">1.5</parameter>\n<parameter name=\"opts\">{\"a\": 1}</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).unwrap();
        let args = &calls[0].1;
        assert_eq!(args["language"], "python");
        assert_eq!(args["enabled"], true);
        assert_eq!(args["count"], 3);
        assert!((args["ratio"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(args["opts"]["a"], 1);
    }

    #[test]
    fn strip_hermes_removes_markup_keeps_prose() {
        let content = "Let me search for \"cow\".\n\n<tool_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\">cow</parameter>\n</invoke>\n</tool_calls>";
        let stripped = strip_hermes_tool_calls(content);
        assert!(stripped.contains("Let me search"));
        assert!(!stripped.contains("tool_calls"));
        assert!(!stripped.contains("invoke"));
    }

    #[tokio::test]
    async fn finished_stream_cleanup_does_not_clobber_superseding_stream() {
        let mgr = ChatManager::new();
        let sid = "s1".to_string();

        // Two parked tasks stand in for stream A and the stream B that
        // supersedes it for the same session.
        let task_a = tokio::spawn(std::future::pending::<()>());
        let task_b = tokio::spawn(std::future::pending::<()>());

        // A registers its abort handle, then B replaces it.
        mgr.streams
            .lock()
            .insert(sid.clone(), task_a.abort_handle());
        mgr.streams
            .lock()
            .insert(sid.clone(), task_b.abort_handle());

        // A's late cleanup must NOT remove B's handle (that would leave B
        // uncancellable)…
        mgr.remove_stream_if_current(&sid, task_a.abort_handle().id());
        assert!(mgr.streams.lock().contains_key(&sid));

        // …while B's own cleanup removes the entry as before.
        mgr.remove_stream_if_current(&sid, task_b.abort_handle().id());
        assert!(!mgr.streams.lock().contains_key(&sid));

        task_a.abort();
        task_b.abort();
    }

    #[tokio::test]
    async fn cancel_aborts_registered_subagent_children() {
        // Audit #1: cancelling a turn used to detach its spawned `Task`
        // subagent loops, which kept spending provider tokens with no way to
        // stop them. The registry must abort them — and clean up so nothing
        // leaks per session.
        let mgr = ChatManager::new();
        let sid = "s-sub".to_string();

        // A real parked child task that registers itself, standing in for a
        // spawned subagent loop.
        let mgr = Arc::new(mgr);
        let child = {
            let mgr = Arc::clone(&mgr);
            let sid = sid.clone();
            tokio::spawn(async move {
                let inner = tokio::spawn(std::future::pending::<()>());
                mgr.register_child_task(&sid, inner.abort_handle());
                std::future::pending::<()>().await
            })
        };
        // Let the child register.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            mgr.child_tasks.lock().contains_key(&sid),
            "child must be registered"
        );

        // Wait — the outer child here IS the registrant but the INNER parked
        // task is what's tracked. cancel() must abort the inner task.
        mgr.cancel(&sid);
        assert!(
            !mgr.child_tasks.lock().contains_key(&sid),
            "cancel must drain the registry entry"
        );

        // The registrant outer task pends forever — abort it (the test's own
        // inner stand-in was already aborted by cancel()).
        child.abort();
    }

    #[tokio::test]
    async fn child_unregister_removes_only_its_own_id() {
        // Two children for one session; the first finishing must not drop
        // the second's registration (it would leave it uncancellable).
        let mgr = ChatManager::new();
        let sid = "s-two".to_string();

        let inner_a = tokio::spawn(std::future::pending::<()>());
        let inner_b = tokio::spawn(std::future::pending::<()>());
        let id_a = inner_a.abort_handle().id();
        mgr.register_child_task(&sid, inner_a.abort_handle());
        mgr.register_child_task(&sid, inner_b.abort_handle());

        mgr.unregister_child_task(&sid, id_a);
        assert_eq!(mgr.child_tasks.lock().get(&sid).map(|l| l.len()), Some(1));

        // Aborting the session drops the surviving child and clears the map.
        mgr.cancel(&sid);
        assert!(!mgr.child_tasks.lock().contains_key(&sid));

        inner_a.abort();
        inner_b.abort();
    }

    #[test]
    fn strip_hermes_handles_unclosed_block() {
        // A model that kept streaming the call without closing the tag.
        let content = "Thinking\u{fffd} <tool_calls><invoke name=\"web_search\"><parameter name=\"query\">cow";
        let stripped = strip_hermes_tool_calls(content);
        assert_eq!(stripped, "Thinking\u{fffd}");
    }

    // ---- D4: `data: [DONE]` must end the WHOLE read loop ----

    /// Minimal provider whose wire shape matches the fixture server below:
    /// OpenAI-style deltas, a usage-only event, then `[DONE]`.
    struct DoneHangProvider {
        url: String,
    }

    #[async_trait::async_trait]
    impl ChatProvider for DoneHangProvider {
        fn id(&self) -> ChatProviderId {
            ChatProviderId::OpenAI
        }
        fn default_model(&self) -> &'static str {
            "gpt-test"
        }
        fn build_request(
            &self,
            client: &reqwest::Client,
            _req: &ChatRequest,
            _api_key: &str,
            _base_url: Option<&str>,
        ) -> Result<reqwest::RequestBuilder, String> {
            Ok(client
                .post(&self.url)
                .header("content-type", "application/json")
                .body("{\"stream\":true}"))
        }
        fn parse_sse_chunk(
            &self,
            line: &str,
            buf: &mut String,
        ) -> Result<(Option<String>, bool), String> {
            let data = line.strip_prefix("data: ").unwrap_or(line).trim();
            if data == "[DONE]" {
                return Ok((None, true));
            }
            let v: serde_json::Value =
                serde_json::from_str(data).map_err(|e| format!("parse: {e}"))?;
            if v.get("usage").is_some() || v.pointer("/choices/0/delta/content").is_some() {
                buf.push_str(line);
                buf.push('\n');
            }
            if let Some(c) = v
                .pointer("/choices/0/delta/content")
                .and_then(|x| x.as_str())
            {
                return Ok((Some(c.to_string()), false));
            }
            Ok((None, false))
        }
        fn parse_usage(&self, buf: &str) -> Option<ChatUsage> {
            for line in buf.lines() {
                let data = line.strip_prefix("data: ").unwrap_or(line);
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(u) = v.get("usage") {
                        return Some(ChatUsage {
                            input_tokens: u["prompt_tokens"].as_i64().unwrap_or(0),
                            output_tokens: u["completion_tokens"].as_i64().unwrap_or(0),
                            cost_usd: 0.0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                            reasoning_tokens: 0,
                        });
                    }
                }
            }
            None
        }
    }

    /// One-shot SSE server: streams a delta, a usage event and `[DONE]`, then
    /// holds the connection OPEN without ever closing it (no Content-Length,
    /// no EOF) — exactly the provider behavior that used to park the turn on
    /// the 60s watchdog after the answer had already streamed.
    async fn spawn_done_then_hang_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => return,
            };
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n\
                        data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n\
                        data: [DONE]\n\n";
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n";
            if sock.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            if sock.write_all(body.as_bytes()).await.is_err() {
                return;
            }
            // Hold the socket open; drain (and ignore) anything the client
            // sends until it goes away.
            let mut buf = [0u8; 512];
            loop {
                match sock.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
        format!("http://127.0.0.1:{port}/v1/chat/completions")
    }

    #[tokio::test]
    async fn done_marker_ends_the_whole_read_loop() {
        let url = spawn_done_then_hang_server().await;
        let provider = DoneHangProvider { url };
        let req = ChatRequest {
            model: "gpt-test".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
                images: Vec::new(),
            }],
            max_tokens: Some(16),
            system: None,
            effort: None,
            thinking: None,
            local_docs_retrieval: Vec::new(),
            memory_context: None,
        };
        let client = reqwest::Client::new();
        let perf = crate::chat::turn_perf::TurnPerf::new_headless("sid-done");

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            run_chat_stream(
                &client, &provider, "sid-done", &req, "key", None, None, &perf, None,
            ),
        )
        .await
        .expect(
            "run_chat_stream must finish promptly after [DONE] — it must not \
             park on the stall watchdog because the server holds the body open",
        );
        let (text, usage) = result.expect("stream must complete Ok after [DONE]");
        assert_eq!(text, "hello");
        let usage = usage.expect("usage must be parsed from the SSE buffer");
        assert_eq!(usage.input_tokens, 7);
        assert_eq!(usage.output_tokens, 3);
    }
}
