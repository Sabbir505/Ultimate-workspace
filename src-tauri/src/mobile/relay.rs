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
use rand::RngCore;
use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

use crate::chat::providers::{ChatProviderId, ChatRequest, REASONING_PREFIX};
use crate::chat::ChatManager;
use crate::db;
use crate::secrets;

use super::dispatch::dispatch_mobile;
use super::protocol::{
    ChatUsage as MobileChatUsage, DesktopMessage, MobileMessage, ProviderInfo,
    ProjectCostEntry, LocalModelUsageEntry,
};
use super::relay_ws::OwnerMap;

/// Shared relay state: the bound port, the abort handle for the accept loop,
/// and a per-launch pairing token that the phone must present on the FIRST
/// connection before any other message is honored. Subsequent reconnects from
/// the same phone within the same process re-use the same token.
pub struct MobileRelayState {
    pub port: Mutex<Option<u16>>,
    pub abort: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// 32-byte URL-safe pairing token. Generated fresh each time the relay
    /// starts; rotated on every app launch. Emitted via `mobile:pairing-token`
    /// (the QR-code pairing screen scans this), and persisted in app_settings
    /// so the Settings panel can re-display it after a hot reload.
    pub pairing_token: Mutex<Option<String>>,
    /// Tracks which WebSocket connection owns which mobile session id.
    /// Used to route `mobile:session_chat_event` Tauri events back to the
    /// right phone.
    pub owner_map: OwnerMap,
}

impl MobileRelayState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
            abort: Mutex::new(None),
            pairing_token: Mutex::new(None),
            owner_map: OwnerMap::default(),
        }
    }
}

/// Generate a 256-bit URL-safe pairing token.
fn new_pairing_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
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

    // SECURITY: bind ONLY to the loopback interface. The previous 0.0.0.0
    // bind exposed the relay to the entire LAN — anyone on the same network
    // could connect, send chat turns, write to active PTYs, and read
    // transcripts. Mobile devices pair over an SSH tunnel / USB bridge, so
    // 127.0.0.1 is sufficient and reduces the attack surface to processes on
    // the same host.
    let bind_addr = if let Some(port) = saved_port {
        format!("127.0.0.1:{port}")
    } else {
        "127.0.0.1:0".to_string()
    };

    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind relay: {e}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();

    // Persist the port + a fresh per-launch pairing token. The token must be
    // presented on the first frame of the first WebSocket connection from a
    // phone; the handler validates it before doing anything else.
    let pairing_token = new_pairing_token();
    {
        let conn = db.lock();
        let _ = db::set_setting(&conn, "mobile.relay_port", &port.to_string());
        let _ = db::set_setting(&conn, "mobile.pairing_token", &pairing_token);
    }

    *relay_state.port.lock() = Some(port);
    *relay_state.pairing_token.lock() = Some(pairing_token.clone());
    let _ = app.emit("mobile:pairing-token", pairing_token.clone());

    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel();
    *relay_state.abort.lock() = Some(abort_tx);

    // Start the Tauri event listener that forwards `mobile:session_chat_event`
    // payloads to the right WebSocket connection via the owner map.
    let owner_map = relay_state.owner_map.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        if let Err(e) = super::relay_owner::start_session_chat_event_listener(&app_handle, owner_map) {
            eprintln!("[mobile-relay] failed to start session_chat_event listener: {e}");
        }
    });

    tokio::spawn(async move {
        eprintln!("[mobile-relay] listening on ws://127.0.0.1:{port} (pairing required)");
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
                            let owner_map = relay_state.owner_map.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, peer, app, db, chat_mgr, owner_map).await {
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

/// Removes every owner-map registration whose sender belongs to this
/// connection when the handler exits (any path: clean close, read error,
/// pairing failure). Without it, reconnecting phones accumulate dead
/// registrations in the shared OwnerMap — and the pump task would keep a
/// stale sender alive forever.
struct OwnerCleanup {
    map: OwnerMap,
    tx: super::relay_ws::WsSender,
}

impl Drop for OwnerCleanup {
    fn drop(&mut self) {
        self.map
            .lock()
            .retain(|_, sender| !sender.same_channel(&self.tx));
    }
}

/// Aborts the per-connection ping keepalive task when the handler exits —
/// otherwise the task would hold the shared write half (and the connection)
/// alive forever after a half-open disconnect.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Deletes the temporary chat session created for a mobile ChatTurn (message
/// rows go with it via FK cascade) on EVERY exit path. Previously only the
/// success path cleaned up, so each failed turn leaked a chat_sessions row
/// plus its chat_messages rows.
pub(crate) struct TempChatSessionCleanup {
    db: Arc<Mutex<Connection>>,
    sid: String,
}

impl TempChatSessionCleanup {
    pub(crate) fn new(db: Arc<Mutex<Connection>>, sid: String) -> Self {
        Self { db, sid }
    }
}

impl Drop for TempChatSessionCleanup {
    fn drop(&mut self) {
        let conn = self.db.lock();
        let _ = db::delete_chat_session(&conn, &self.sid);
    }
}

/// Fail-closed pairing check: a missing configured token (relay not fully
/// started / DB read failed) or an empty presented token must NEVER
/// authenticate. Previously `unwrap_or_default` turned "no token configured"
/// into an empty expected token, so presenting an empty token paired
/// successfully.
pub(crate) fn pairing_token_accepted(expected: &str, presented: &str) -> bool {
    !expected.is_empty() && !presented.is_empty() && presented == expected
}

/// How long a fresh connection may take to present its Pair frame.
const PAIRING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Keepalive ping cadence once paired.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(25);
/// Any inbound frame (message or pong) resets this; exceeding it means the
/// TCP connection is half-open and the handler tears down.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(75);

async fn handle_connection(
    stream: TcpStream,
    _peer: SocketAddr,
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
    owner_map: OwnerMap,
) -> Result<(), String> {
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake failed: {e}"))?;
    let (write, mut read) = ws_stream.split();
    // Share the write half with the per-connection owner-channel pump: the
    // request loop writes request/response messages directly while streaming
    // session-chat events arrive out-of-band on the channel registered in
    // the owner map (mobile:session_chat_event → relay_owner::forward → tx)
    // and must be pumped onto the SAME socket concurrently. Previously the
    // receiver was dropped on the floor, so every forwarded event failed
    // with "failed to send to owner" and the phone never saw tokens/done.
    let write: super::relay_ws::SharedWsWrite = Arc::new(tokio::sync::Mutex::new(write));
    let (conn_tx, conn_rx) = super::relay_ws::make_channel();
    {
        let pump_write = Arc::clone(&write);
        tokio::spawn(async move {
            if let Err(e) = super::relay_ws::pump_to_ws_shared(conn_rx, pump_write).await {
                eprintln!("[mobile-relay] owner-channel pump ended: {e}");
            }
        });
    }
    let _owner_cleanup = OwnerCleanup {
        map: Arc::clone(&owner_map),
        tx: conn_tx.clone(),
    };

    // Send immediate status so the mobile app knows it's talking to the desktop.
    let hello = DesktopMessage::DesktopStatus { connected: true };
    let hello_text = serde_json::to_string(&hello).unwrap_or_default();
    let _ = write.lock().await.send(Message::Text(hello_text)).await;

    // Load the current pairing token. The first inbound frame MUST be a
    // Pair { token } — anything else is rejected and the connection is
    // dropped. This prevents an unauthenticated peer from issuing commands
    // like SendToSession, StartLocalModel, or CreateSession before a phone
    // has paired.
    let expected_token = {
        let conn = db.lock();
        db::get_setting(&conn, "mobile.pairing_token")
            .ok()
            .flatten()
            .unwrap_or_default()
    };

    let first = match tokio::time::timeout(PAIRING_TIMEOUT, read.next()).await {
        Ok(Some(Ok(msg))) => msg,
        Ok(Some(Err(e))) => return Err(format!("ws read failed before pairing: {e}")),
        Ok(None) => return Err("peer disconnected before pairing".into()),
        Err(_) => return Err("pairing timed out".into()),
    };
    let first_text = match first {
        Message::Text(t) => t,
        _ => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "first frame must be a Pair message".into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err("first frame was not a Pair message".into());
        }
    };
    let paired: MobileMessage = match serde_json::from_str(&first_text) {
        Ok(m) => m,
        Err(e) => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: format!("malformed Pair frame: {e}"),
            };
            let _ = send_msg(&write, &err).await;
            return Err(format!("malformed Pair frame: {e}"));
        }
    };
    let presented = match paired {
        MobileMessage::Pair { token } => token,
        _ => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "first frame must be a Pair message".into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err("first frame was not a Pair message".into());
        }
    };
    if !pairing_token_accepted(&expected_token, &presented) {
        // Constant-time-ish comparison via length-trim to avoid leaking the
        // token length. The token is 256 bits so brute force is moot; this
        // is just defense-in-depth.
        if presented.len() != expected_token.len() {
            return Err("pairing token length mismatch".into());
        }
        let err = DesktopMessage::ChatError {
            chat_session_id: "pair".into(),
            error: "pairing failed: invalid token".into(),
        };
        let _ = send_msg(&write, &err).await;
        return Err("pairing failed: invalid token".into());
    }
    eprintln!("[mobile-relay] paired; processing commands");

    // Keepalive: ping the phone on a fixed cadence and treat the connection
    // as dead if NO inbound frame (message or pong) arrives within
    // IDLE_TIMEOUT. Without this, a half-open TCP connection (phone dropped
    // off Wi-Fi without a close frame) would park the handler on
    // `read.next()` forever, leaking this task, the owner-channel pump, and
    // every owner-map registration for the connection (OwnerCleanup only
    // runs once the handler actually exits).
    let _ping_task = {
        let ping_write = Arc::clone(&write);
        AbortOnDrop(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(PING_INTERVAL);
            loop {
                ticker.tick().await;
                if ping_write
                    .lock()
                    .await
                    .send(Message::Ping(Vec::new()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }))
    };

    loop {
        let msg = match tokio::time::timeout(IDLE_TIMEOUT, read.next()).await {
            Ok(Some(msg)) => msg.map_err(|e| format!("ws read failed: {e}"))?,
            Ok(None) => break,
            Err(_) => return Err("connection idle timeout (no pong)".into()),
        };
        if msg.is_close() {
            break;
        }
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(p) => {
                let _ = write.lock().await.send(Message::Pong(p)).await;
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
                let _ = send_msg(&write, &err).await;
                continue;
            }
        };

        // A phone that sends another Pair frame after pairing is a protocol
        // violation; reject it. (We do not kill the connection — the next
        // legit message will be processed normally.)
        if matches!(req, MobileMessage::Pair { .. }) {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "already paired".into(),
            };
            let _ = send_msg(&write, &err).await;
            continue;
        }

        match req {
            MobileMessage::ListAvailableProviders => {
                let providers = build_available_providers(&db, &app).await;
                let resp = DesktopMessage::AvailableProviders { providers };
                let _ = send_msg(&write, &resp).await;
            }
            MobileMessage::ListSessions => {
                let sessions = build_session_list(&db, &app);
                eprintln!("[mobile-relay] ListSessions: {} sessions ({} live)",
                    sessions.len(),
                    sessions.iter().filter(|s| s.is_live).count());
                let resp = DesktopMessage::SessionList { sessions };
                let _ = send_msg(&write, &resp).await;
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
                    &app, &db, &chat_mgr, &write,
                )
                .await
                {
                    Ok(()) => {}
                    Err(e) => {
                        let err = DesktopMessage::ChatError {
                            chat_session_id: "unknown".to_string(),
                            error: e,
                        };
                        let _ = send_msg(&write, &err).await;
                    }
                }
            }
            MobileMessage::CancelChatTurn { chat_session_id } => {
                chat_mgr.cancel(&chat_session_id);
                let resp = DesktopMessage::ChatDone { chat_session_id, usage: None };
                let _ = send_msg(&write, &resp).await;
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
                let _ = send_msg(&write, &resp).await;
            }
            MobileMessage::GetCostSummary => {
                // Aggregate spend for the phone Settings tab: today (UTC) and
                // the rolling last 7 days. Read-time priced via the shared
                // pricing module (same source of truth as the desktop rollup).
                let overrides = {
                    let conn = db.lock();
                    crate::db::read_rate_overrides(&conn)
                };
                let (today, week) = {
                    let conn = db.lock();
                    let priced_sum = |since: i64| -> f64 {
                        let mut total = 0.0;
                        let mut stmt = match conn.prepare(
                            "SELECT input_tokens, output_tokens, model_key,
                                    cache_creation_input_tokens, cache_read_input_tokens,
                                    reasoning_output_tokens
                               FROM cost_events
                              WHERE timestamp >= ?1"
                        ) { Ok(s) => s, Err(_) => return 0.0 };
                        let rows = stmt.query_map(rusqlite::params![since], |r| {
                            Ok((
                                r.get::<_, Option<i64>>(0)?,
                                r.get::<_, Option<i64>>(1)?,
                                r.get::<_, Option<String>>(2)?,
                                r.get::<_, Option<i64>>(3)?,
                                r.get::<_, Option<i64>>(4)?,
                                r.get::<_, Option<i64>>(5)?,
                            ))
                        }).ok();
                        if let Some(rows) = rows {
                            for row in rows.flatten() {
                                let (i, o, k, cc, cr, r) = row;
                                let usage = crate::harness_adapters::UsageInfo {
                                    input_tokens: i, output_tokens: o,
                                    cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
                                    reasoning_output_tokens: r, cost_usd: None,
                                };
                                if let Some(c) = crate::harness_adapters::pricing::price_usage(&usage, k.as_deref(), &overrides) {
                                    total += c;
                                }
                            }
                        }
                        total
                    };
                    let now = crate::db::now_ts();
                    let today = priced_sum(now - 86_400);
                    let week = priced_sum(now - 7 * 86_400);
                    (today, week)
                };
                let _ = send_msg(&write, &DesktopMessage::CostSummary {
                    today, week, version: 2,
                }).await;
            }
            MobileMessage::GetCostDetails => {
                let details = build_cost_details(&db);
                let _ = send_msg(&write, &DesktopMessage::CostDetails {
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
                        let _ = send_msg(&write, &DesktopMessage::LocalModelReady {
                            model,
                            base_url,
                        }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::LocalModelError {
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
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: session_id.clone(), error: "session not found".to_string(),
                        }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
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
                        let _ = send_msg(&write, &DesktopMessage::SessionCreated { session: info }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: "create".to_string(), error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::GetSessionMessages {
                session_id,
                before_id,
                limit,
            } => {
                match dispatch_mobile(
                    MobileMessage::GetSessionMessages {
                        session_id,
                        before_id,
                        limit,
                    },
                    &app,
                    Arc::clone(&db),
                    Arc::clone(&chat_mgr),
                    owner_map.clone(),
                ) {
                    Ok(msgs) => {
                        for m in msgs {
                            let _ = send_msg(&write, &m).await;
                        }
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: "session-chat".to_string(),
                            error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::SendChatMessage {
                session_id,
                text,
                attachments,
            } => {
                // Register this session in the owner map BEFORE dispatching,
                // so streaming events (re-broadcast by the React side as
                // `mobile:session_chat_event` and forwarded by the listener in
                // relay_owner.rs) have a destination. The sender is THIS
                // connection's channel; the per-connection pump task (spawned
                // at connect time) writes whatever lands on it to the socket,
                // and the OwnerCleanup guard removes the registration when
                // this connection drops.
                super::relay_owner::register_owner(&owner_map, session_id.clone(), conn_tx.clone());
                match dispatch_mobile(
                    MobileMessage::SendChatMessage {
                        session_id,
                        text,
                        attachments,
                    },
                    &app,
                    Arc::clone(&db),
                    Arc::clone(&chat_mgr),
                    owner_map.clone(),
                ) {
                    Ok(msgs) => {
                        for m in msgs {
                            let _ = send_msg(&write, &m).await;
                        }
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: "session-chat".to_string(),
                            error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::CancelSessionStream { session_id } => {
                match dispatch_mobile(
                    MobileMessage::CancelSessionStream { session_id },
                    &app,
                    Arc::clone(&db),
                    Arc::clone(&chat_mgr),
                    owner_map.clone(),
                ) {
                    Ok(msgs) => {
                        for m in msgs {
                            let _ = send_msg(&write, &m).await;
                        }
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: "session-chat".to_string(),
                            error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::ResolveSessionApproval {
                session_id,
                pending_id,
                decision,
            } => {
                match dispatch_mobile(
                    MobileMessage::ResolveSessionApproval {
                        session_id,
                        pending_id,
                        decision,
                    },
                    &app,
                    Arc::clone(&db),
                    Arc::clone(&chat_mgr),
                    owner_map.clone(),
                ) {
                    Ok(msgs) => {
                        for m in msgs {
                            let _ = send_msg(&write, &m).await;
                        }
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: "session-chat".to_string(),
                            error: e,
                        }).await;
                    }
                }
            }
            MobileMessage::RenameSession { session_id, title } => {
                match dispatch_mobile(
                    MobileMessage::RenameSession { session_id, title },
                    &app,
                    Arc::clone(&db),
                    Arc::clone(&chat_mgr),
                    owner_map.clone(),
                ) {
                    Ok(msgs) => {
                        for m in msgs {
                            let _ = send_msg(&write, &m).await;
                        }
                    }
                    Err(e) => {
                        let _ = send_msg(&write, &DesktopMessage::ChatError {
                            chat_session_id: "session-chat".to_string(),
                            error: e,
                        }).await;
                    }
                }
            }
            // A second Pair frame after a successful pairing is a protocol
            // violation — already handled above before this match.
            MobileMessage::Pair { .. } => unreachable!("Pair is intercepted above"),
        }
    }

    Ok(())
}

async fn send_msg(
    write: &super::relay_ws::SharedWsWrite,
    msg: &DesktopMessage,
) -> Result<(), String> {
    let text = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    write
        .lock()
        .await
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
async fn handle_chat_turn(
    provider_id_str: String,
    model: String,
    messages: Vec<crate::chat::providers::ChatMessage>,
    system: Option<String>,
    effort: Option<String>,
    gguf_path: Option<String>,
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<ChatManager>,
    write: &super::relay_ws::SharedWsWrite,
) -> Result<(), String> {
    // Resolve provider id.
    let provider_id = match provider_id_str.as_str() {
        "anthropic" => ChatProviderId::Anthropic,
        "openai" => ChatProviderId::OpenAI,
        "anthropic_compatible" => ChatProviderId::AnthropicCompatible,
        "openai_compatible" => ChatProviderId::OpenAICompatible,
        "openrouter" => ChatProviderId::OpenRouter,
        "local_gguf" => ChatProviderId::LocalGguf,
        other => return Err(format!("unknown provider: {other}")),
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
            let _ = send_msg(&write, &status_msg).await;

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
                    let _ = send_msg(&write, &err).await;
                    return Err(format!("warm-up failed: {e}"));
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
                return Err(format!("no API key configured for provider: {provider_id_str}"));
            }
        }
    };

    // Load optional base_url from settings.
    let base_url = {
        let conn = db.lock();
        match db::get_setting(&conn, &format!("chat.{provider_id_str}.base_url")) {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        }
    };

    // Create a temporary chat session in the DB.
    let chat_session_id = {
        let conn = db.lock();
        match db::create_chat_session(&conn, &provider_id_str, &model, None) {
            Ok(cs) => cs.id,
            Err(e) => return Err(e.to_string()),
        }
    };
    // Drop guard removes the temp session + its message rows on every exit
    // path below (request/build/stream errors included), not just success.
    let _session_cleanup = TempChatSessionCleanup::new(Arc::clone(db), chat_session_id.clone());

    // Persist the latest user message.
    if let Some(last) = messages.last() {
        if last.role == "user" {
            let conn = db.lock();
            let _ = db::add_chat_message(&conn, &chat_session_id, "user", &last.content, None, None, None, None, None, None, None, None, None);
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
        // Mobile relay doesn't yet surface a per-turn thinking toggle; leave
        // it at the provider default.
        thinking: None,
    };

    let provider = crate::chat::streaming::resolve_provider(&provider_id);

    // Build and send the HTTP request.
    let request = match provider.build_request(&client, &chat_req, &api_key, base_url.as_deref()) {
        Ok(r) => r,
        Err(e) => return Err(format!("failed to build request: {e}")),
    };

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("request failed: {e}")),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    // Stream SSE chunks and forward tokens over the WebSocket.
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buf = String::new();
    // Partial-line carry-over (same fix as chat::run_chat_stream): TCP chunks
    // split SSE `data:` lines arbitrarily, and parse_sse_chunk is fatal on a
    // half line. Only complete newline-terminated lines may be parsed.
    let mut pending = String::new();
    let mut full_text = String::new();
    let mut in_think = false;

    'chunks: while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let _ = send_done(&write, &sid, None).await;
                return Err(format!("stream read error: {e}"));
            }
        };
        pending.push_str(&String::from_utf8_lossy(&chunk));

        let mut complete_lines: Vec<String> = Vec::new();
        while let Some(nl) = pending.find('\n') {
            complete_lines.push(pending.drain(..=nl).collect());
        }

        for line in complete_lines {
            let line = line.trim_end();
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
                    if send_msg(&write, &token_msg).await.is_err() {
                        // Client disconnected — stop streaming but still clean up.
                        let _ = stream.next().await;
                        break 'chunks;
                    }
                }
                Ok((_, true)) => {
                    // Stream done — usage will be parsed from buffer below.
                    break 'chunks;
                }
                Ok((None, false)) => {}
                Err(e) => {
                    let _ = send_done(&write, &sid, None).await;
                    return Err(format!("SSE parse error: {e}"));
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
        let _ = send_msg(&write, &token_msg).await;
    }

    let usage = provider.parse_usage(&buf);

    // Persist assistant message.
    {
        let conn = db2.lock();
        // provider + model_key from the chat session so the rollup groups
        // phone chat under chat:<provider> and prices by the session's model.
        let (provider, model): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT provider, model FROM chat_sessions WHERE id = ?1",
                rusqlite::params![&sid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
            .unwrap_or((None, None));
        let model_key = model
            .as_deref()
            .and_then(crate::harness_adapters::canonical_model_key);
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
            None, None, None, provider.as_deref(), model_key, None,
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
    let _ = send_msg(&write, &done_msg).await;

    // Temp session cleanup happens via the guard on scope exit.
    Ok(())
}

async fn send_done(
    write: &super::relay_ws::SharedWsWrite,
    sid: &str,
    usage: Option<MobileChatUsage>,
) -> Result<(), String> {
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

    // Daily + per-project rollups come from the same read-time priced query
    // the desktop uses (spec §8), so retro rate changes apply on the phone too.
    // The phone only needs the last 14 days.
    let rollups = crate::db::get_cost_rollups_v2(&conn, 14).unwrap_or_else(|_| crate::types::CostRollups {
        totals: crate::types::CostTotals::default(),
        per_provider: Vec::new(),
        daily: Vec::new(),
        by_kind: crate::types::CostByKind::default(),
        per_model: Vec::new(),
        cost_quality: crate::types::CostQuality::default(),
        per_project: Vec::new(),
        range_start: String::new(),
        range_end: String::new(),
        range_days: 14,
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
