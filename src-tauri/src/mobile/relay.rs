//! WebSocket relay server that accepts connections from the mobile companion app.
//!
//! - Binds to 0.0.0.0 on a persistent port (saved across launches so the phone
//!   URL stays the same). Falls back to a random port if the saved one is taken.
//! - Accepts WebSocket connections; on connect sends `DesktopStatus { connected: true }`.
//! - Handles `ListAvailableProviders` by querying keys + local model state.
//! - Handles `ChatTurn` by creating a temporary DB session and running a
//!   provider-specific SSE stream that writes tokens directly to the WS.
//! - Handles `CancelChatTurn` by calling `ChatManager::cancel`.
//! - Streams tokens back as `ChatToken` messages; final usage as `ChatDone`.

use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

use crate::chat::providers::{ChatProviderId, ChatRequest, REASONING_PREFIX};
use crate::chat::ChatManager;
use crate::db;
use crate::secrets;

use super::protocol::{
    ChatUsage as MobileChatUsage, DesktopMessage, MobileMessage, ProviderInfo,
    ProjectCostEntry, LocalModelUsageEntry,
};

/// Shared relay state: the bound port and an abort handle for the accept loop.
pub struct MobileRelayState {
    pub port: Mutex<Option<u16>>,
    pub abort: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl MobileRelayState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
            abort: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/// Start the relay server on a random localhost port. Returns the bound port.
pub async fn start_relay(
    app: AppHandle,
    relay_state: Arc<MobileRelayState>,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
) -> Result<u16, String> {
    // Stop any existing relay first.
    stop_relay(&relay_state);

    // Try to reuse the persisted port from last launch so the mobile app
    // doesn't need to re-enter the URL every time. Falls back to random.
    let saved_port: Option<u16> = {
        let conn = db.lock();
        db::get_setting(&conn, "mobile.relay_port")
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
    };

    let bind_addr = if let Some(port) = saved_port {
        format!("0.0.0.0:{port}")
    } else {
        "0.0.0.0:0".to_string()
    };

    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("failed to bind relay: {e}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();

    // Persist the port in settings so the mobile app can discover it.
    {
        let conn = db.lock();
        let _ = db::set_setting(&conn, "mobile.relay_port", &port.to_string());
    }

    *relay_state.port.lock() = Some(port);

    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel();
    *relay_state.abort.lock() = Some(abort_tx);

    tokio::spawn(async move {
        eprintln!("[mobile-relay] listening on ws://0.0.0.0:{port} (persistent, survives restarts)");
        loop {
            tokio::select! {
                biased;
                _ = &mut abort_rx => {
                    eprintln!("[mobile-relay] shutting down");
                    break;
                }
                accept = listener.accept() => {
                    match accept {
                        Ok((stream, peer)) => {
                            let app = app.clone();
                            let db = Arc::clone(&db);
                            let chat_mgr = Arc::clone(&chat_mgr);
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, peer, app, db, chat_mgr).await {
                                    eprintln!("[mobile-relay] connection error: {e}");
                                }
                            });
                        }
                        Err(e) => {
                            eprintln!("[mobile-relay] accept error: {e}");
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                    }
                }
            }
        }
    });

    Ok(port)
}

/// Stop the relay server.
pub fn stop_relay(relay_state: &MobileRelayState) {
    if let Some(tx) = relay_state.abort.lock().take() {
        let _ = tx.send(());
    }
    *relay_state.port.lock() = None;
}

// ---------------------------------------------------------------------------
// Per-connection handler
// ---------------------------------------------------------------------------

async fn handle_connection(
    stream: TcpStream,
    _peer: SocketAddr,
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
) -> Result<(), String> {
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake failed: {e}"))?;
    let (mut write, mut read) = ws_stream.split();

    // Send immediate status so the mobile app knows it's talking to the desktop.
    let hello = DesktopMessage::DesktopStatus { connected: true };
    let hello_text = serde_json::to_string(&hello).unwrap_or_default();
    let _ = write.send(Message::Text(hello_text)).await;

    while let Some(msg) = read.next().await {
        let msg = msg.map_err(|e| format!("ws read failed: {e}"))?;
        if msg.is_close() {
            break;
        }
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(p) => {
                let _ = write.send(Message::Pong(p)).await;
                continue;
            }
            _ => continue,
        };

        let req: MobileMessage = match serde_json::from_str(&text) {
            Ok(r) => r,
            Err(e) => {
                let err = DesktopMessage::ChatError {
                    chat_session_id: "unknown".to_string(),
                    error: format!("malformed request: {e}"),
                };
                let _ = send_msg(&mut write, &err).await;
                continue;
            }
        };

        match req {
            MobileMessage::ListAvailableProviders => {
                let providers = build_available_providers(&db, &app).await;
                let resp = DesktopMessage::AvailableProviders { providers };
                let _ = send_msg(&mut write, &resp).await;
            }
            MobileMessage::ListSessions => {
                let sessions = build_session_list(&db, &app);
                eprintln!("[mobile-relay] ListSessions: {} sessions ({} live)",
                    sessions.len(),
                    sessions.iter().filter(|s| s.is_live).count());
                let resp = DesktopMessage::SessionList { sessions };
                let _ = send_msg(&mut write, &resp).await;
            }
            MobileMessage::ChatTurn {
                provider_id,
                model,
                messages,
                system,
                effort,
                gguf_path,
            } => {
                match handle_chat_turn(
                    provider_id, model, messages, system, effort, gguf_path,
                    &app, &db, &chat_mgr, write,
                )
                .await
                {
                    Ok(w) => { write = w; }
                    Err((e, w)) => {
                        write = w;
                        let err = DesktopMessage::ChatError {
                            chat_session_id: "unknown".to_string(),
                            error: e,
                        };
                        let _ = send_msg(&mut write, &err).await;
                    }
                }
            }
            MobileMessage::CancelChatTurn { chat_session_id } => {
                chat_mgr.cancel(&chat_session_id);
                let resp = DesktopMessage::ChatDone { chat_session_id, usage: None };
                let _ = send_msg(&mut write, &resp).await;
            }
            MobileMessage::SendToSession { session_id, text } => {
                eprintln!("[mobile-relay] SendToSession: session={session_id} text_len={}", text.len());
                if let Some(pty_state) = app.try_state::<crate::PtyState>() {
                    let pty = &pty_state.0;
                    if let Some(pane_id) = pty.pane_id_for_session(&session_id) {
                        eprintln!("[mobile-relay]   resolved pane_id={pane_id}");
                        let _ = pty.write(&pane_id, &text);
                    } else {
                        eprintln!("[mobile-relay]   no pane_id found, writing directly to session_id");
                        let _ = pty.write(&session_id, &text);
                    }
                }
            }
            MobileMessage::GetTranscript { session_id } => {
                // Send the rendered terminal screen (vt100 snapshot) rather than
                // the raw stripped stream: TUI apps redraw via cursor-movement
                // sequences, which are unreadable when concatenated.
                let (text, rows, cols) = app
                    .try_state::<crate::PtyState>()
                    .and_then(|p| p.0.screen_for_session(&session_id))
                    .unwrap_or_default();
                let resp = DesktopMessage::Transcript { session_id, text, cols, rows };
                let _ = send_msg(&mut write, &resp).await;
            }
            MobileMessage::GetCostSummary => {
                // Aggregate spend for the phone Settings tab: today (UTC) and
                // the rolling last 7 days. cost_events timestamps are unix secs.
                let (today, week) = {
                    let conn = db.lock();
                    let today: f64 = conn
                        .query_row(
                            "SELECT COALESCE(SUM(estimated_cost_usd), 0.0) FROM cost_events
                             WHERE date(timestamp, 'unixepoch') = date('now')",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0.0);
                    let week: f64 = conn
                        .query_row(
                            "SELECT COALESCE(SUM(estimated_cost_usd), 0.0) FROM cost_events
                             WHERE timestamp >= strftime('%s', 'now', '-7 days')",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0.0);
                    (today, week)
                };
                let _ = send_msg(&mut write, &DesktopMessage::CostSummary { today, week }).await;
            }
            MobileMessage::GetCostDetails => {
                let details = build_cost_details(&db);
                let _ = send_msg(&mut write, &DesktopMessage::CostDetails {
                    daily: details.0,
                    per_project: details.1,
                    local_models: details.2,
                }).await;
            }
            MobileMessage::StartLocalModel { model, gguf_path } => {
                // The user tapped a (possibly stopped) local model in the
                // selector. Spawn the sidecar now so it's ready by the time
                // they send their first message — instead of wedging warm-up
                // into the first ChatTurn, which left the phone's "Loading…"
                // banner spinning with no work actually started.
                match warm_up_local_model(&app, &gguf_path, &model).await {
                    Ok(base_url) => {
                        // Persist so the LocalGguf provider adapter + a later
                        // ChatTurn both pick up the live endpoint.
                        {
                            let conn = db.lock();
                            let _ = db::set_setting(&conn, "chat.local_gguf.base_url", &base_url);
                            let _ = db::set_setting(&conn, "chat.local_gguf.model", &model);
                        }
                        let _ = send_msg(&mut write, &DesktopMessage::LocalModelReady {
                            model,
                            base_url,
                        }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(&mut write, &DesktopMessage::LocalModelError {
                            model,
                            error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::SpawnSession { session_id } => {
                // Delegate spawning to the desktop frontend: it opens the session
                // in a pane via the normal session-launcher path (frontend-owned
                // pane ids, harness flags like Claude's --mcp-config, grid
                // placement rules). Spawning directly here used a `mobile-{uuid}`
                // pane id the frontend knew nothing about, so phone-spawned
                // sessions ran invisibly in the dev tab.
                let result = {
                    let conn = db.lock();
                    crate::db::get_session_with_project(&conn, &session_id)
                        .map_err(|e| format!("{e}"))
                };
                match result {
                    Ok(Some(_)) => {
                        let _ = app.emit(
                            "mobile:session-open-requested",
                            serde_json::json!({ "sessionId": session_id }),
                        );
                        // Touch the session.
                        {
                            let conn = db.lock();
                            let _ = crate::db::touch_session(&conn, &session_id);
                        }
                    }
                    Ok(None) => {
                        let _ = send_msg(&mut write, &DesktopMessage::ChatError {
                            chat_session_id: session_id.clone(), error: "session not found".to_string(),
                        }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(&mut write, &DesktopMessage::ChatError {
                            chat_session_id: session_id.clone(), error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::CreateSession { project_id, harness } => {
                let session = {
                    let conn = db.lock();
                    crate::db::create_session(&conn, &project_id, &harness)
                        .map_err(|e| format!("{e}"))
                };
                match session {
                    Ok(s) => {
                        // Tell the desktop frontend to open the new session in a
                        // dev-tab pane (and spawn it via the normal launcher
                        // path) so phone-started sessions show up on the desktop.
                        let _ = app.emit(
                            "mobile:session-open-requested",
                            serde_json::json!({ "sessionId": s.id.clone() }),
                        );
                        let pname = {
                            let conn = db.lock();
                            crate::db::get_project(&conn, &project_id).ok().flatten()
                                .map(|p| p.name).unwrap_or_default()
                        };
                        let info = super::protocol::SessionInfo {
                            id: s.id,
                            project_id: project_id.clone(),
                            project_name: pname,
                            title: s.title.unwrap_or_else(|| "Untitled".to_string()),
                            harness: s.harness,
                            status: "idle".to_string(),
                            last_active_at: s.last_active_at,
                            is_live: false,
                        };
                        let _ = send_msg(&mut write, &DesktopMessage::SessionCreated { session: info }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(&mut write, &DesktopMessage::ChatError {
                            chat_session_id: "create".to_string(), error: e,
                        }).await;
                    }
                }
            }
        }
    }

    Ok(())
}

async fn send_msg<W>(write: &mut W, msg: &DesktopMessage) -> Result<(), String>
where
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let text = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    write
        .send(Message::Text(text))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Chat turn handler
// ---------------------------------------------------------------------------

/// Build a temporary chat session and run the SSE stream, writing tokens
/// directly to the WebSocket. Returns the write half so the connection can
/// continue handling further messages.
async fn handle_chat_turn<W>(
    provider_id_str: String,
    model: String,
    messages: Vec<crate::chat::providers::ChatMessage>,
    system: Option<String>,
    effort: Option<String>,
    gguf_path: Option<String>,
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<ChatManager>,
    mut write: W,
) -> Result<W, (String, W)>
where
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    // Resolve provider id.
    let provider_id = match provider_id_str.as_str() {
        "anthropic" => ChatProviderId::Anthropic,
        "openai" => ChatProviderId::OpenAI,
        "anthropic_compatible" => ChatProviderId::AnthropicCompatible,
        "openai_compatible" => ChatProviderId::OpenAICompatible,
        "openrouter" => ChatProviderId::OpenRouter,
        "local_gguf" => ChatProviderId::LocalGguf,
        other => return Err((format!("unknown provider: {other}"), write)),
    };

    // On-demand local-model warm-up (option b): if the phone selected a GGUF
    // model that isn't running, spin up the sidecar before the first request.
    if provider_id_str == "local_gguf" {
        if let Some(path) = gguf_path.as_deref() {
            // Send a status update so the phone shows "Starting local model…"
            let status_msg = DesktopMessage::ChatToken {
                chat_session_id: "warmup".to_string(),
                token: "[STATUS] Starting local model…".to_string(),
            };
            let _ = send_msg(&mut write, &status_msg).await;

            match warm_up_local_model(app, path, &model).await {
                Ok(_base_url) => {
                    // Sidecar is ready — persist its base_url in settings so the
                    // provider adapter picks it up.
                    let conn = db.lock();
                    let _ = db::set_setting(&conn, "chat.local_gguf.base_url", &_base_url);
                    let _ = db::set_setting(&conn, "chat.local_gguf.model", &model);
                }
                Err(e) => {
                    let err = DesktopMessage::ChatError {
                        chat_session_id: "warmup".to_string(),
                        error: format!("Failed to start local model: {e}"),
                    };
                    let _ = send_msg(&mut write, &err).await;
                    return Err((format!("warm-up failed: {e}"), write));
                }
            }
        }
    }

    // Load API key from keychain. local_gguf is keyless.
    let api_key = if provider_id_str == "local_gguf" {
        "no-key".to_string()
    } else {
        let conn = db.lock();
        match secrets::get_chat_api_key(&conn, &provider_id_str) {
            Some(k) => k,
            None => {
                return Err((
                    format!("no API key configured for provider: {provider_id_str}"),
                    write,
                ));
            }
        }
    };

    // Load optional base_url from settings.
    let base_url = {
        let conn = db.lock();
        match db::get_setting(&conn, &format!("chat.{provider_id_str}.base_url")) {
            Ok(v) => v,
            Err(e) => return Err((e.to_string(), write)),
        }
    };

    // Create a temporary chat session in the DB.
    let chat_session_id = {
        let conn = db.lock();
        match db::create_chat_session(&conn, &provider_id_str, &model) {
            Ok(cs) => cs.id,
            Err(e) => return Err((e.to_string(), write)),
        }
    };

    // Persist the latest user message.
    if let Some(last) = messages.last() {
        if last.role == "user" {
            let conn = db.lock();
            let _ = db::add_chat_message(&conn, &chat_session_id, "user", &last.content, None, None, None);
            let _ = db::touch_chat_session(&conn, &chat_session_id);
        }
    }

    let sid = chat_session_id.clone();
    let client = chat_mgr.client.clone();
    let db2 = Arc::clone(db);

    let chat_req = ChatRequest {
        model: model.clone(),
        messages: messages.clone(),
        max_tokens: Some(4096),
        system: system.filter(|s| !s.trim().is_empty()),
        effort: effort.filter(|e| !e.trim().is_empty()),
    };

    let provider = crate::chat::streaming::resolve_provider(&provider_id);

    // Build and send the HTTP request.
    let request = match provider.build_request(&client, &chat_req, &api_key, base_url.as_deref()) {
        Ok(r) => r,
        Err(e) => return Err((format!("failed to build request: {e}"), write)),
    };

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return Err((format!("request failed: {e}"), write)),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err((format!("HTTP {status}: {body}"), write));
    }

    // Stream SSE chunks and forward tokens over the WebSocket.
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buf = String::new();
    let mut full_text = String::new();
    let mut in_think = false;

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let _ = send_done(&mut write, &sid, None).await;
                return Err((format!("stream read error: {e}"), write));
            }
        };
        let text = String::from_utf8_lossy(&chunk);

        for line in text.lines() {
            match provider.parse_sse_chunk(line, &mut buf) {
                Ok((Some(token), false)) => {
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
                    let token_msg = DesktopMessage::ChatToken {
                        chat_session_id: sid.clone(),
                        token: out,
                    };
                    if send_msg(&mut write, &token_msg).await.is_err() {
                        // Client disconnected — stop streaming but still clean up.
                        let _ = stream.next().await;
                        break;
                    }
                }
                Ok((_, true)) => {
                    // Stream done — usage will be parsed from buffer below.
                    break;
                }
                Ok((None, false)) => {}
                Err(e) => {
                    let _ = send_done(&mut write, &sid, None).await;
                    return Err((format!("SSE parse error: {e}"), write));
                }
            }
        }
    }

    if in_think {
        full_text.push_str("</think>");
        let token_msg = DesktopMessage::ChatToken {
            chat_session_id: sid.clone(),
            token: "</think>".to_string(),
        };
        let _ = send_msg(&mut write, &token_msg).await;
    }

    let usage = provider.parse_usage(&buf);

    // Persist assistant message.
    {
        let conn = db2.lock();
        let _ = db::add_chat_message(
            &conn,
            &sid,
            "assistant",
            &full_text,
            usage.as_ref().and_then(|u| {
                if u.input_tokens > 0 || u.output_tokens > 0 { Some(u.input_tokens) } else { None }
            }),
            usage.as_ref().and_then(|u| {
                if u.input_tokens > 0 || u.output_tokens > 0 { Some(u.output_tokens) } else { None }
            }),
            usage.as_ref().and_then(|u| {
                if u.input_tokens > 0 || u.output_tokens > 0 { Some(u.cost_usd) } else { None }
            }),
        );
        let _ = db::touch_chat_session(&conn, &sid);
    }

    // Send ChatDone with usage.
    let done_msg = DesktopMessage::ChatDone {
        chat_session_id: sid.clone(),
        usage: usage.map(|u| MobileChatUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cost_usd: u.cost_usd,
        }),
    };
    let _ = send_msg(&mut write, &done_msg).await;

    // Clean up temporary session.
    {
        let conn = db.lock();
        let _ = db::delete_chat_session(&conn, &sid);
    }

    Ok(write)
}

async fn send_done<W>(write: &mut W, sid: &str, usage: Option<MobileChatUsage>) -> Result<(), String>
where
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let msg = DesktopMessage::ChatDone {
        chat_session_id: sid.to_string(),
        usage,
    };
    send_msg(write, &msg).await
}

// ---------------------------------------------------------------------------
// Provider list builder
// ---------------------------------------------------------------------------

/// Query active CLI sessions. Uses the same db::list_sessions that the
/// desktop sidebar calls, so the phone sees exactly what the desktop sees.
fn build_session_list(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
) -> Vec<super::protocol::SessionInfo> {
    let conn = db.lock();
    let sessions = match crate::db::list_sessions(&conn, None) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let pty_state = app.try_state::<crate::PtyState>();
    sessions
        .into_iter()
        .map(|s| {
            let project_name = crate::db::get_project(&conn, &s.project_id)
                .ok()
                .flatten()
                .map(|p| p.name)
                .unwrap_or_default();
            let (is_live, status) = if let Some(pty) = pty_state.as_ref() {
                if let Some(pid) = pty.0.pane_id_for_session(&s.id) {
                    let state = pty.0.pane_state(&pid).unwrap_or_else(|| "working".to_string());
                    (true, state)
                } else {
                    (false, "idle".to_string())
                }
            } else {
                (false, "idle".to_string())
            };
            super::protocol::SessionInfo {
                id: s.id,
                project_id: s.project_id.clone(),
                project_name,
                title: s.title.unwrap_or_else(|| "Untitled".to_string()),
                harness: s.harness,
                status,
                last_active_at: s.last_active_at,
                is_live,
            }
        })
        .collect()
}

/// Build the detailed cost breakdown for the mobile Settings cost dashboard.
/// Mirrors what the desktop CostDashboard shows: daily spend (all rows, the
/// client slices the last 14), per-project totals with project names, and
/// per-local-model token usage aggregated from assistant messages on
/// local_gguf chat sessions. Returns (daily, per_project, local_models).
fn build_cost_details(
    db: &Arc<Mutex<Connection>>,
) -> (
    Vec<super::protocol::DailyCostEntry>,
    Vec<ProjectCostEntry>,
    Vec<LocalModelUsageEntry>,
) {
    let conn = db.lock();

    // Daily + per-project rollups come from the same query the desktop uses.
    let rollups = crate::db::get_cost_rollups(&conn).unwrap_or_else(|_| crate::types::CostRollups {
        per_project: Vec::new(),
        daily: Vec::new(),
    });

    let daily = rollups
        .daily
        .into_iter()
        .map(|d| super::protocol::DailyCostEntry {
            day: d.day,
            cost_usd: d.cost_usd,
        })
        .collect();

    let per_project = rollups
        .per_project
        .into_iter()
        .map(|p| {
            let project_name = crate::db::get_project(&conn, &p.project_id)
                .ok()
                .flatten()
                .map(|pr| pr.name)
                .unwrap_or_else(|| p.project_id.chars().take(6).collect());
            ProjectCostEntry {
                project_id: p.project_id,
                project_name,
                total_cost_usd: p.total_cost_usd,
                total_input_tokens: p.total_input_tokens,
                total_output_tokens: p.total_output_tokens,
            }
        })
        .collect();

    // Per-local-model usage: one row per model, summing the token columns on
    // assistant messages of local_gguf chat sessions. Mirrors the desktop
    // frontend's fetchLocalModelUsage aggregation, but in a single query.
    let mut stmt = match conn.prepare(
        "SELECT cs.model,
                COALESCE(SUM(cm.input_tokens), 0),
                COALESCE(SUM(cm.output_tokens), 0),
                COUNT(cm.id),
                MAX(cm.created_at)
         FROM chat_messages cm
         JOIN chat_sessions cs ON cs.id = cm.chat_session_id
         WHERE cs.provider = 'local_gguf' AND cm.role = 'assistant'
         GROUP BY cs.model
         ORDER BY COUNT(cm.id) DESC",
    ) {
        Ok(s) => s,
        Err(_) => return (daily, per_project, Vec::new()),
    };
    let rows = stmt.query_map([], |r| {
        let model: String = r.get(0)?;
        let last_used_ts: i64 = r.get::<_, Option<i64>>(4)?.unwrap_or(0);
        // Same day-format as the daily rollup: SQLite 'YYYY-MM-DD'.
        let last_used = if last_used_ts > 0 {
            conn.query_row(
                "SELECT date(?1, 'unixepoch')",
                rusqlite::params![last_used_ts],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default()
        } else {
            String::new()
        };
        Ok(LocalModelUsageEntry {
            model,
            input_tokens: r.get(1)?,
            output_tokens: r.get(2)?,
            message_count: r.get(3)?,
            last_used,
        })
    });
    let local_models: Vec<LocalModelUsageEntry> = match rows {
        Ok(rs) => rs.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    };

    (daily, per_project, local_models)
}


async fn fetch_model_list(client: &reqwest::Client, base: &str, key: &str, auth_style: &str) -> Vec<String> {
    let url = format!("{base}/v1/models");
    let req = match auth_style {
        // Anthropic's endpoint requires the version header alongside the key.
        "x-api-key" => client
            .get(&url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        _ => client.get(&url).header("Authorization", format!("Bearer {key}")),
    };
    match req.timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(json) = resp.json::<Value>().await {
                if let Some(data) = json.get("data").and_then(|v| v.as_array()) {
                    return data.iter()
                        .filter_map(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                        .collect();
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Check every known provider for availability and return a unified list.
pub async fn build_available_providers(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
) -> Vec<ProviderInfo> {
    let mut providers = Vec::new();

    // --- API providers (keychain check) ---
    // Native providers (anthropic, openai) don't expose /v1/models — only
    // compatible providers and OpenRouter do. For native providers, we use
    // the default model name as a fallback.
    let api_providers: &[(&str, &str, &[&str])] = &[
        ("anthropic", "Anthropic", &["claude-sonnet-4-5-20250929"]),
        ("openai", "OpenAI", &["gpt-4o"]),
        ("deepseek", "DeepSeek", &["deepseek-chat"]),
        ("kimi", "Kimi", &["kimi-k2-5"]),
        ("openrouter", "OpenRouter", &["openai/gpt-4o"]),
        ("anthropic_compatible", "Anthropic Compatible", &[]),
        ("openai_compatible", "OpenAI Compatible", &[]),
    ];

    let client = reqwest::Client::new();
    for (id, display_name, fallback_models) in api_providers {
        let (has_key, key, base_url) = {
            let conn = db.lock();
            let has_key = secrets::has_chat_api_key(&conn, id);
            let key = secrets::get_chat_api_key(&conn, id).unwrap_or_default();
            let base_url = db::get_setting(&conn, &format!("chat.{id}.base_url"))
                .ok().flatten();
            (has_key, key, base_url)
        };
        if !has_key { continue; }

        // Fetch from /v1/models for providers that support it, use fallback for others.
        let models = match *id {
            "openrouter" => {
                fetch_model_list(&client, "https://openrouter.ai/api", &key, "bearer").await
            }
            "anthropic_compatible" | "openai_compatible" => {
                if let Some(ref base) = base_url {
                    let style = if *id == "anthropic_compatible" { "x-api-key" } else { "bearer" };
                    fetch_model_list(&client, base, &key, style).await
                } else {
                    fallback_models.iter().map(|s| s.to_string()).collect()
                }
            }
            _ => {
                // Native providers — try /v1/models anyway, fall back to defaults.
                let fetched = match *id {
                    "anthropic" => {
                        if let Some(ref base) = base_url {
                            fetch_model_list(&client, base, &key, "x-api-key").await
                        } else {
                            fetch_model_list(&client, "https://api.anthropic.com", &key, "x-api-key").await
                        }
                    }
                    // Each provider has its own default API base — pointing
                    // DeepSeek/Kimi at api.openai.com just fails the fetch.
                    "openai" => {
                        let base = base_url.as_deref().unwrap_or("https://api.openai.com");
                        fetch_model_list(&client, base, &key, "bearer").await
                    }
                    "deepseek" => {
                        let base = base_url.as_deref().unwrap_or("https://api.deepseek.com");
                        fetch_model_list(&client, base, &key, "bearer").await
                    }
                    "kimi" => {
                        let base = base_url.as_deref().unwrap_or("https://api.moonshot.ai");
                        fetch_model_list(&client, base, &key, "bearer").await
                    }
                    _ => Vec::new(),
                };
                if fetched.is_empty() {
                    fallback_models.iter().map(|s| s.to_string()).collect()
                } else {
                    fetched
                }
            }
        };

        // Deduplicate case-insensitively.
        let mut seen = std::collections::HashSet::new();
        let unique_models: Vec<String> = models
            .into_iter()
            .filter(|m| seen.insert(m.to_lowercase()))
            .collect();

        if !unique_models.is_empty() {
            providers.push(ProviderInfo {
                id: id.to_string(),
                display_name: display_name.to_string(),
                models: unique_models,
                is_local: false,
                is_running: true,
                gguf_path: None,
            });
        }
    }

    // --- Local endpoints (Ollama / LM Studio health probe) ---
    let local_endpoints = [
        ("ollama", "Ollama", "http://127.0.0.1:11434"),
        ("lmstudio", "LM Studio", "http://127.0.0.1:1234"),
    ];

    for (id, display_name, base) in local_endpoints {
        let mut models = Vec::new();
        let mut is_running = false;

        if id == "ollama" {
            if let Ok(resp) = client
                .get(format!("{}/api/tags", base))
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                if resp.status().is_success() {
                    is_running = true;
                    if let Ok(body) = resp.json::<Value>().await {
                        if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
                            for m in arr {
                                if let Some(name) = m.get("name").and_then(|v| v.as_str()) {
                                    models.push(name.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        if id == "lmstudio" {
            if let Ok(resp) = client
                .get(format!("{}/v1/models", base))
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                if resp.status().is_success() {
                    is_running = true;
                    if let Ok(body) = resp.json::<Value>().await {
                        if let Some(data) = body.get("data").and_then(|v| v.as_array()) {
                            for m in data {
                                if let Some(name) = m.get("id").and_then(|v| v.as_str()) {
                                    models.push(name.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        if is_running {
            providers.push(ProviderInfo {
                id: id.to_string(),
                display_name: display_name.to_string(),
                models,
                is_local: true,
                is_running,
                gguf_path: None,
            });
        }
    }

    // --- GGUF sidecar registry (running + available but not loaded) ---
    eprintln!("[mobile-relay] build_available_providers: checking LocalModelState…");
    if let Some(local_state) = app.try_state::<crate::chat::local_models::LocalModelState>() {
        let registry = &local_state.0;

        // Currently running model (if any).
        let running_id = registry.status().map(|a| a.model_id.clone());
        eprintln!("[mobile-relay]   running_id={:?}", running_id);

        // Scanned GGUF files: default locations + user-added folders.
        let mut scanned = crate::chat::local_models::scan_default_locations();
        eprintln!("[mobile-relay]   scan_default_locations() found {} files", scanned.len());

        // Also scan user-added folders from Settings (same logic as desktop UI).
        {
            let conn = db.lock();
            if let Ok(Some(json)) = db::get_setting(&conn, "localModels.folders") {
                if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
                    let seen: std::collections::HashSet<String> = scanned.iter().map(|f| f.id.clone()).collect();
                    for folder in list.into_iter().filter(|s| !s.trim().is_empty()) {
                        eprintln!("[mobile-relay]   scanning user folder: {}", folder);
                        for file in crate::chat::local_models::scan_folder(std::path::Path::new(&folder), "user") {
                            if !seen.contains(&file.id) {
                                scanned.push(file);
                            }
                        }
                    }
                }
            }
        }
        eprintln!("[mobile-relay]   total scanned after user folders: {}", scanned.len());

        let mut seen = std::collections::HashSet::new();

        for gguf in &scanned {
            if seen.contains(&gguf.id) {
                continue;
            }
            seen.insert(gguf.id.clone());
            let is_running = running_id.as_deref() == Some(&gguf.id);
            let model_name = gguf.meta.name.clone().unwrap_or_else(|| gguf.filename.clone());
            eprintln!("[mobile-relay]   adding local model: {} (running={})", model_name, is_running);

            providers.push(ProviderInfo {
                id: "local_gguf".to_string(),
                display_name: if is_running {
                    format!("Local — {}", model_name)
                } else {
                    format!("Local — {} (stopped)", model_name)
                },
                models: vec![model_name],
                is_local: true,
                is_running,
                gguf_path: Some(gguf.path.clone()),
            });
        }

        // If nothing was scanned and nothing is running, don't add a local_gguf
        // entry. We deliberately do NOT probe a persisted `chat.local_gguf.base_url`
        // here: that emitted a pathless "running" phantom that the phone couldn't
        // restart (no gguf_path → ChatTurn warm-up + StartLocalModel both skip it),
        // and a stale /health 200 advertised a model as running when the sidecar
        // had actually died on desktop restart. Scanned files are the source of
        // truth; a stopped one is now startable from the phone via StartLocalModel.
    } else {
        eprintln!("[mobile-relay]   LocalModelState NOT found in app state — local models unavailable");
    }

    providers
}

/// Trigger on-demand warm-up for a local GGUF model from its file path.
/// Returns the base URL (http://127.0.0.1:<port>) once the sidecar is ready.
pub async fn warm_up_local_model(
    app: &AppHandle,
    model_path: &str,
    model_name: &str,
) -> Result<String, String> {
    let local_state = app
        .state::<crate::chat::local_models::LocalModelState>()
        .inner()
        .0
        .clone();
    // Check if already running — if so, return current base_url immediately.
    if let Some(active) = local_state.status() {
        if active.model_id == model_name || active.model_id == model_path {
            return Ok(active.base_url);
        }
    }
    // Spin up the sidecar.
    let result = local_state
        .start(model_name.to_string(), model_path, None, None, None)
        .await
        .map_err(|e| format!("failed to start local model: {e}"))?;
    Ok(result.base_url)
}
