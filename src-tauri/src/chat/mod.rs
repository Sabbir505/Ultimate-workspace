//! Chat mode — direct LLM HTTP API streaming (separate from CLI agent panes).
//!
//! Four providers: Anthropic, OpenAI, AnthropicCompatible, OpenAICompatible.
//! All SSE streaming, API keys stored in the OS keychain, HTTP in Rust backend.

pub mod artifacts;
pub mod codeexec;
pub mod compaction;
pub mod commands;
pub mod dispatch;
pub mod docs;
pub mod docs_images;
pub mod export;
pub mod local_models;
pub mod office;
pub mod permission;
pub mod prompts;
pub mod proto;
pub mod providers;
pub mod pygen;
pub mod python_runtime;
pub mod stream_events;
pub mod streaming;
pub mod tasks;
pub mod tools;
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
    /// PERF (PERFORMANCE_AUDIT.md B11): memoized context-meter token counts.
    /// The frontend polls `count_context_tokens` every 2 s while a local
    /// session is idle, and each call used to re-send the ENTIRE active
    /// history to llama-server's /tokenize even when nothing had changed.
    /// Keyed by chat_session_id → (fingerprint, used_tokens); the
    /// fingerprint covers (last active message id, active message count,
    /// system prompt, model) so any transcript / prompt / model change
    /// invalidates. Entries are removed on session delete.
    context_token_cache: Mutex<HashMap<String, (String, u32)>>,
}

impl ChatManager {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            streams: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            context_token_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Look up a memoized token count for the given fingerprint.
    pub(crate) fn cached_context_tokens(&self, chat_session_id: &str, fingerprint: &str) -> Option<u32> {
        self.context_token_cache
            .lock()
            .get(chat_session_id)
            .and_then(|(fp, tokens)| if fp == fingerprint { Some(*tokens) } else { None })
    }

    /// Store a token count under the given fingerprint (replaces any stale
    /// entry for the session).
    pub(crate) fn store_context_tokens(&self, chat_session_id: &str, fingerprint: String, tokens: u32) {
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
        permission_mode: permission::PermissionMode,
        fs_roots: Vec<String>,
        // Connector ids attached to this conversation (per-session opt-in).
        // When tools are enabled, each is connected (OAuth token refreshed,
        // MCP session opened, tools listed + classified) at the start of the
        // spawned turn; their remote tools are merged into the schema and
        // routed through the connector permission gate in dispatch.
        connector_ids: Vec<String>,
        system: Option<String>,
        messages: Vec<ChatMessage>,
        db: Arc<Mutex<Connection>>,
        app: AppHandle,
        research_mode: bool,
        thinking: Option<bool>,
    ) {
        // Cancel any existing stream for this session.
        self.cancel(&chat_session_id);

        let provider = resolve_provider(&provider_id);
        let chat_req = ChatRequest {
            model,
            messages,
            max_tokens: Some(4096),
            system: system.filter(|s| !s.trim().is_empty()),
            effort,
            thinking,
        };

        // OpenRouter and LocalGguf speak the OpenAI wire format, so they ride
        // the OpenAI request/tool path.
        let is_openai = matches!(
            provider_id,
            ChatProviderId::OpenAI
                | ChatProviderId::OpenAICompatible
                | ChatProviderId::OpenRouter
                | ChatProviderId::LocalGguf
        );
        let is_anthropic = matches!(
            provider_id,
            ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible
        );
        // Tools need a base URL; compatible providers already carry one, native
        // providers fall back to their default endpoint. LocalGguf requires the
        // stored base_url (written by the sidecar-start command).
        let tool_base = base_url.clone().unwrap_or_else(|| {
            if matches!(provider_id, ChatProviderId::OpenRouter) {
                providers::OpenRouterProvider::DEFAULT_BASE.to_string()
            } else if is_openai {
                OpenAIProvider::DEFAULT_BASE.to_string()
            } else {
                AnthropicProvider::DEFAULT_BASE.to_string()
            }
        });

        let client = self.client.clone();
        let sid = chat_session_id.clone();
        let pcaps = prompts::provider_capabilities(provider_id.clone(), &chat_req.model);
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
        let caps = tools::ToolCaps {
            code_exec: code_exec_enabled,
            fs_roots,
            web_search: pcaps.native_web_search,
            requires_local_sandbox: pcaps.requires_local_sandbox,
            attached_connectors: Arc::new(Vec::new()),
            local_docs,
        };
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
            // failures are logged inside and never fail the turn. Must run
            // BEFORE the turn starts — the snapshot has to be truly pre-turn.
            {
                let conn = db.lock();
                if let Some(repo) = db::chat_session_repo_path(&conn, &sid) {
                    crate::checkpoints::maybe_baseline(
                        Some(&app),
                        &conn,
                        &sid,
                        std::path::Path::new(&repo),
                    );
                }
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
            let result = if tools_enabled && is_openai {
                run_openai_tool_loop(
                    &client, &tool_base, &api_key, &chat_req, &caps, permission_mode, &mgr, &sid, &app, research_mode, perf.clone(),
                )
                .await
            } else if tools_enabled && is_anthropic {
                run_anthropic_tool_loop(
                    &client, &tool_base, &api_key, &chat_req, &caps, permission_mode, &mgr, &sid, &app, research_mode, perf.clone(),
                )
                .await
            } else {
                run_chat_stream(
                    &client,
                    provider.as_ref(),
                    &sid,
                    &chat_req,
                    &api_key,
                    base_url.as_deref(),
                    &app,
                    &perf,
                )
                .await
            };

            match result {
                Ok((full_response, usage)) => {
                    // Persist the assistant message with usage.
                    // The turn's message id escapes this block for the
                    // post-done checkpoint (chip attaches to this message).
                    let mut turn_message_id: Option<i64> = None;
                    {
                        let conn = db.lock();
                        // provider + model_key on the row let the rollup group
                        // in-app chat under chat:<provider> and price by the
                        // session's model (spec §8 / §10.3).
                        let model_key = crate::harness_adapters::canonical_model_key(&chat_req.model);
                        let persisted = db::add_chat_message(
                            &conn,
                            &sid,
                            "assistant",
                            &full_response,
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.input_tokens)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.output_tokens)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.cost_usd)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| if u.cache_creation_input_tokens > 0 { Some(u.cache_creation_input_tokens) } else { None }),
                            usage.as_ref().and_then(|u| if u.cache_read_input_tokens > 0 { Some(u.cache_read_input_tokens) } else { None }),
                            usage.as_ref().and_then(|u| if u.reasoning_tokens > 0 { Some(u.reasoning_tokens) } else { None }),
                            Some(provider_id.as_str()),
                            model_key,
                            None,
                            Some(started_at),
                            Some(db::now_ts()),
                            perf.llm_time_ms(),
                            perf.tool_time_ms(),
                            perf.ttft_ms(),
                            perf.tokens_per_second(
                                usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                            ),
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
                    let _ = app.emit(
                        "chat:done",
                        ChatDonePayload {
                            chat_session_id: sid.clone(),
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
                    let _ = app.emit(
                        "chat:error",
                        ChatErrorPayload {
                            chat_session_id: sid.clone(),
                            message: e,
                            code: None,
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
            // Clear the active per-turn perf accumulator so a later turn
            // starts fresh (and so `emit_token` stops recording to it).
            crate::chat::turn_perf::unregister(&sid);
        });

        self.streams
            .lock()
            .insert(chat_session_id.clone(), handle.abort_handle());
    }

    /// Remove the abort-handle registry entry for a finished stream — but only
    /// if the entry still maps to that stream's own handle (identified by its
    /// task id). A superseding `send` for the same session replaces the entry;
    /// without this check the old stream's cleanup would clobber the newer
    /// stream's handle and leave it uncancellable.
    fn remove_stream_if_current(&self, chat_session_id: &str, task_id: tokio::task::Id) {
        let mut streams = self.streams.lock();
        if streams.get(chat_session_id).is_some_and(|h| h.id() == task_id) {
            streams.remove(chat_session_id);
        }
    }

    /// Cancel an active stream for the given session (no-op if none active).
    /// Also drops any pending per-action approvals for the session so their
    /// paused loops resume as "denied" rather than hanging forever.
    pub fn cancel(&self, chat_session_id: &str) {
        if let Some(handle) = self.streams.lock().remove(chat_session_id) {
            handle.abort();
        }
        self.drop_pending_for_session(chat_session_id);
    }

    /// App-exit cleanup: cancel all active streams.
    pub fn cancel_all(&self) {
        let handles: Vec<_> = self.streams.lock().drain().map(|(_, h)| h).collect();
        for handle in handles {
            handle.abort();
        }
        // Drop all pending approvals too.
        let ids: Vec<String> = self.pending.lock().keys().cloned().collect();
        for id in ids {
            self.pending.lock().remove(&id);
        }
    }
}

/// Runs the full SSE stream lifecycle for one chat request.
/// Returns the accumulated assistant text and optional usage info.
pub(crate) async fn run_chat_stream(
    client: &reqwest::Client,
    provider: &dyn ChatProvider,
    chat_session_id: &str,
    req: &ChatRequest,
    api_key: &str,
    base_url: Option<&str>,
    app: &AppHandle,
    perf: &turn_perf::TurnPerf,
) -> Result<(String, Option<ChatUsage>), String> {
    let request = provider
        .build_request(client, req, api_key, base_url)
        .map_err(|e| format!("failed to build request: {e}"))?;

    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    use futures_util::StreamExt;

    let mut stream = response.bytes_stream();
    let mut buf = String::new(); // SSE buffer passed to provider parser
    // Carry-over for partial lines: TCP chunks split SSE `data:` lines
    // arbitrarily, and feeding half a line into parse_sse_chunk is fatal
    // (its serde_json::from_str fails and kills the whole turn). Only
    // complete, newline-terminated lines may be parsed — same pattern the
    // tool-loop rounds use in streaming.rs.
    let mut pending = String::new();
    let mut full_text = String::new();
    let mut in_think = false;
    // Open the generation window: all tokens flowing from this SSE read are
    // model-generation time (not tool time or approval waits).
    perf.begin_gen();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("stream read error: {e}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));

        let mut complete_lines: Vec<String> = Vec::new();
        while let Some(nl) = pending.find('\n') {
            complete_lines.push(pending.drain(..=nl).collect());
        }

        for line in complete_lines {
            let line = line.trim_end();
            match provider.parse_sse_chunk(line, &mut buf)? {
                (Some(token), false) => {
                    // Reasoning tokens are sentinel-prefixed by the parser;
                    // wrap contiguous runs in <think>…</think> so the UI can
                    // render a collapsible thinking block.
                    let mut out = String::new();
                    if let Some(reasoning) = token.strip_prefix(REASONING_PREFIX) {
                        if !in_think {
                            out.push_str("<think>");
                            in_think = true;
                        }
                        out.push_str(reasoning);
                    } else {
                        if in_think {
                            out.push_str("</think>");
                            in_think = false;
                        }
                        out.push_str(&token);
                    }
                    full_text.push_str(&out);
                    let payload = ChatTokenPayload {
                        chat_session_id: chat_session_id.to_string(),
                        token: out,
                    };
                    if !crate::chat::stream_events::try_send(chat_session_id, &payload) {
                        let _ = app.emit("chat:token", payload);
                    }
                    perf.record_token();
                    perf.maybe_emit_perf();
                }
                (_, true) => {
                    // Stream done — usage will be parsed from buffer below.
                    break;
                }
                _ => {}
            }
        }
    }

    // EOF flush: a final line with no trailing newline (some local servers
    // close this way) is still complete and must be parsed — pre-buffering
    // behavior did so via str::lines. Parse failures here are tolerated, not
    // fatal: the stream has already ended, and erroring now would throw away
    // a turn whose tokens were all delivered.
    let trailing = pending.trim_end().to_string();
    if !trailing.is_empty() {
        if let Ok((Some(token), _)) = provider.parse_sse_chunk(&trailing, &mut buf) {
            let mut out = String::new();
            if let Some(reasoning) = token.strip_prefix(REASONING_PREFIX) {
                if !in_think {
                    out.push_str("<think>");
                    in_think = true;
                }
                out.push_str(reasoning);
            } else {
                if in_think {
                    out.push_str("</think>");
                    in_think = false;
                }
                out.push_str(&token);
            }
            full_text.push_str(&out);
            let payload = ChatTokenPayload {
                chat_session_id: chat_session_id.to_string(),
                token: out,
            };
            if !crate::chat::stream_events::try_send(chat_session_id, &payload) {
                let _ = app.emit("chat:token", payload);
            }
            perf.record_token();
            perf.maybe_emit_perf();
        }
    }

    if in_think {
        full_text.push_str("</think>");
        let payload = ChatTokenPayload {
                chat_session_id: chat_session_id.to_string(),
                token: "</think>".to_string(),
            };
            if !crate::chat::stream_events::try_send(chat_session_id, &payload) {
                let _ = app.emit("chat:token", payload);
            }
            perf.record_token();
            perf.maybe_emit_perf();
    }

    let usage = provider.parse_usage(&buf);
    // Close the generation window — all subsequent time (tool exec, next
    // round's prompt build) falls outside LLM time.
    perf.end_gen();
    Ok((full_text, usage))
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
            &conn, chat_session_id, "user",
            prompt, None, None, None, None, None, None, None, None, None, None, None,
            None, None, None, None,
        ).map_err(|e| e.to_string())?;
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
                crate::chat::commands::openai_oneshot(
                    &client, &api_key, base, &model, &system, prompt,
                )
                .await
                .map(|t| (t, None::<crate::chat::providers::ChatUsage>))
            }
            "openai_compatible" | "local_gguf" => {
                let Some(base) = base_url.as_deref() else {
                    return Err("No base URL configured for this provider. Set one in Settings \u{2192} Connectors.".into());
                };
                crate::chat::commands::openai_oneshot(
                    &client, &api_key, base, &model, &system, prompt,
                )
                .await
                .map(|t| (t, None::<crate::chat::providers::ChatUsage>))
            }
            "anthropic" | "anthropic_compatible" => {
                let base = base_url.as_deref().unwrap_or(
                    crate::chat::providers::AnthropicProvider::DEFAULT_BASE,
                );
                crate::chat::commands::anthropic_oneshot(
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
            &conn, chat_session_id, "assistant",
            &response_text,
            None, None, None, None, None, None, None, None, None,
            Some(started_at), Some(crate::db::now_ts()),
            None, None, None, None,
        ).map_err(|e| e.to_string())?;
        crate::db::touch_chat_session(&conn, chat_session_id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_trigger_fires_on_research_phrases() {
        assert!(is_research_request("Research the history of the Rust language"));
        assert!(is_research_request("Can you find out about WebGPU adoption?"));
        assert!(is_research_request("What's the current state of WebGPU across browsers?"));
        assert!(is_research_request("Compare React and Vue for a new dashboard"));
        assert!(is_research_request("Do a survey of recent transformer papers"));
        assert!(is_research_request("Investigate the cause of the outage"));
        assert!(is_research_request("Deep dive on CRDTs please"));
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
        assert!(calls[0].1["instructions"].as_str().unwrap().contains("table"));
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

    #[test]
    fn strip_hermes_handles_unclosed_block() {
        // A model that kept streaming the call without closing the tag.
        let content = "Thinking�?� <tool_calls><invoke name=\"web_search\"><parameter name=\"query\">cow";
        let stripped = strip_hermes_tool_calls(content);
        assert_eq!(stripped, "Thinking�?�");
    }
}
