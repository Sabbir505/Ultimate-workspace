//! WebSocket relay server that accepts connections from the mobile companion app.
//!
//! - Binds to 127.0.0.1:<port> (USB-bridge / same-machine connections) AND
//!   <tailscale-ip>:<port> when the machine is on a Tailnet. The tailnet bind
//!   uses the CGNAT IP (100.64.0.0/10 range) so only tailnet peers (encrypted
//!   by WireGuard) can reach it — no LAN exposure.
//! - Port is persisted across launches so the phone URL stays stable.
//! - Pairing token is rotated on every relay start (fail-closed gate).
//! - E2E payload encryption (§3.2.11): a phone that pairs with an HMAC
//!   proof of the token (instead of the raw token) gets an
//!   XChaCha20-Poly1305 session — see `relay_crypto` for the design.
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
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::chat::providers::{ChatProviderId, ChatRequest};
use crate::chat::ChatManager;
use crate::db;
use crate::secrets;

use super::dispatch::dispatch_mobile;
use super::protocol::{
    ChatUsage as MobileChatUsage, DesktopMessage, LocalModelUsageEntry, MobileMessage,
    ProjectCostEntry, ProviderInfo,
};
use super::relay_requests;
use super::relay_ws::OwnerMap;

/// Shared relay state: the bound port, the abort handle for the accept loop,
/// and a per-launch pairing token that the phone must present on the FIRST
/// connection before any other message is honored. Subsequent reconnects from
/// the same phone within the same process re-use the same token.
/// Process-wide guard for the push listeners (audit M-9) — see start_relay.
static PUSH_LISTENERS_REGISTERED: AtomicBool = AtomicBool::new(false);

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
    /// Live WebSocket connection count (B10): the pty reader skips its
    /// per-frame vt100 screen parse when this is zero — the screen model's
    /// only consumer is the phone transcript path.
    pub active_connections: std::sync::atomic::AtomicUsize,
    /// Every live connection's channel sender, keyed by a per-process id.
    /// Powers broadcast pushes (automation-finished notices) that aren't
    /// scoped to a single mobile session.
    pub conns: Arc<Mutex<std::collections::HashMap<u64, super::relay_ws::WsSender>>>,
    /// Abort handles for every spawned connection handler, so `stop_relay`
    /// can tear the sockets down — draining senders alone left the handlers'
    /// read loops alive, and pre-existing connections kept their PRE-ROTATION
    /// E2E key and full command surface after a restart (audit M-13).
    pub handler_aborts: Mutex<Vec<tokio::task::AbortHandle>>,
    /// Caps concurrent connection handlers: the accept loop used to spawn a
    /// task per TCP stream unconditionally, so any tailnet peer (or local
    /// process) could accumulate handler+pump tasks in a tight loop (audit
    /// L-16). Acquire-owned permits held by each handler task.
    pub accept_permits: Arc<tokio::sync::Semaphore>,
}

impl MobileRelayState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
            abort: Mutex::new(None),
            pairing_token: Mutex::new(None),
            owner_map: OwnerMap::default(),
            active_connections: std::sync::atomic::AtomicUsize::new(0),
            conns: Arc::new(Mutex::new(std::collections::HashMap::new())),
            handler_aborts: Mutex::new(Vec::new()),
            accept_permits: Arc::new(tokio::sync::Semaphore::new(64)),
        }
    }
}

/// Send a message to every currently connected phone. Best-effort: a dead
/// connection's send error is ignored (its cleanup guard unregisters it).
pub fn broadcast(relay_state: &MobileRelayState, msg: DesktopMessage) {
    let conns = relay_state.conns.lock();
    for tx in conns.values() {
        // try_send: a stalled connection's buffer drops the message instead of
        // buffering without bound (audit L-12). Best-effort by contract.
        let _ = tx.try_send(msg.clone());
    }
}

/// Push an automation-finished notice to every paired phone. Called from the
/// scheduler's finalize path — app-only, since the headless
/// `relay-automation` binary has no relay. When no phone socket is connected
/// the notice falls back to a push notification.
pub fn broadcast_automation_run_finished(
    app: &AppHandle,
    automation_id: &str,
    name: &str,
    status: &str,
    summary: &str,
) {
    let Some(state) = app.try_state::<crate::MobileRelayState>() else {
        return;
    };
    broadcast(
        &state.0,
        DesktopMessage::AutomationRunFinished {
            automation_id: automation_id.to_string(),
            name: name.to_string(),
            status: status.to_string(),
            summary: summary.to_string(),
        },
    );
    let ok = status == "ok";
    super::push::push_if_phones_disconnected(
        app,
        if ok {
            format!("Automation finished: {name}")
        } else {
            format!("Automation failed: {name}")
        },
        summary.to_string(),
    );
}

/// Push a budget-alert notice to every connected phone (roadmap #10). Falls
/// back to a push notification when no phone is connected.
pub fn broadcast_budget_alert(
    app: &AppHandle,
    project_id: &str,
    project_name: &str,
    monthly_usd: f64,
    spent_usd: f64,
) {
    let Some(state) = app.try_state::<crate::MobileRelayState>() else {
        return;
    };
    broadcast(
        &state.0,
        DesktopMessage::BudgetAlert {
            project_id: project_id.to_string(),
            project_name: project_name.to_string(),
            monthly_usd,
            spent_usd,
        },
    );
    super::push::push_if_phones_disconnected(
        app,
        format!("Budget: {project_name}"),
        format!("Spent ${spent_usd:.2} of ${monthly_usd:.2} this month."),
    );
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

    // SECURITY: bind to the loopback interface so the relay is never exposed
    // to the LAN. When the machine is on a Tailnet, ALSO bind the same port
    // on the Tailscale interface (CGNAT range) — only tailnet peers can route
    // to that address, and all traffic over it is encrypted by WireGuard, so
    // the phone can connect cross-network without HTTPS serve being enabled.
    let bind_addr = if let Some(port) = saved_port {
        format!("127.0.0.1:{port}")
    } else {
        "127.0.0.1:0".to_string()
    };

    // Tailscale address probe: spawns the `tailscale` CLI (seconds against a
    // cold daemon), so it runs off the async runtime like
    // get_mobile_pairing_info does.
    let ts_ip: Option<String> = tauri::async_runtime::spawn_blocking(super::tailscale::status)
        .await
        .ok()
        .and_then(|ts| ts.tailscale_ip);

    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel();
    // Register the shutdown handle BEFORE the accept loop can go live: the
    // old registration sat after the port round-trip + keychain load + DB
    // writes, so a stop_relay (or a second start_relay, which stops first)
    // inside that window found `abort == None` and the loop kept accepting
    // forever — an orphan runtime thread that no handle could kill.
    *relay_state.abort.lock() = Some(abort_tx);
    let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();

    // DEDICATED RUNTIME. The accept loop used to be a task on the app's
    // runtime: whenever the desktop ran a blocking turn (model I/O, DB
    // sweeps), the shared workers starved the accept path and the phone's
    // socket started flapping (visible to the user as the Automations screen
    // and connection indicator blinking). The relay now owns an OS thread
    // with a 4-worker runtime, so desktop work can never keep the phone's
    // door shut. The listeners are created inside the thread because a tokio
    // listener is registered with the runtime that created it.
    let serve_app = app.clone();
    let serve_db = Arc::clone(&db);
    let serve_chat_mgr = Arc::clone(&chat_mgr);
    let serve_state = Arc::clone(&relay_state);
    let serve_bind = bind_addr.clone();
    let serve_ts_ip = ts_ip.clone();
    std::thread::Builder::new()
        .name("relay-io".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[mobile-relay] failed to build relay runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let app = serve_app;
                let db = serve_db;
                let chat_mgr = serve_chat_mgr;
                let relay_state = serve_state;
                let bind_addr = serve_bind;
                let listener = match TcpListener::bind(&bind_addr).await {
                    Ok(l) => l,
                    // Retry the saved port a few times before falling back to
                    // random: on restart the dying process's socket can linger
                    // briefly, and silently switching ports strands every
                    // paired phone behind a stale URL.
                    Err(_) => {
                        let mut l = None;
                        for _ in 0..40 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if let Ok(bound) = TcpListener::bind(&bind_addr).await {
                                l = Some(bound);
                                break;
                            }
                        }
                        match l {
                            Some(bound) => bound,
                            None => match TcpListener::bind("127.0.0.1:0").await {
                                Ok(b) => b,
                                Err(e) => {
                                    eprintln!("[mobile-relay] failed to bind relay: {e}");
                                    return;
                                }
                            },
                        }
                    }
                };
                let port = match listener.local_addr() {
                    Ok(a) => a.port(),
                    Err(e) => {
                        eprintln!("[mobile-relay] local_addr: {e}");
                        return;
                    }
                };
                // Same port on the Tailscale interface, when the machine is on
                // a tailnet (best-effort: a vanished interface leaves us
                // loopback-only).
                let tailnet_listener = match serve_ts_ip {
                    Some(ip) => TcpListener::bind(format!("{ip}:{port}"))
                        .await
                        .ok()
                        .map(Arc::new),
                    None => None,
                };
                let mut abort_rx = abort_rx;
                let _ = port_tx.send(port);
let tailnet_addr = tailnet_listener
    .as_ref()
    .and_then(|l| l.local_addr().ok().map(|a| a.to_string()));
eprintln!("[mobile-relay] listening on ws://127.0.0.1:{port} (pairing required)");
if let Some(ref addr) = tailnet_addr {
    eprintln!("[mobile-relay] also on ws://{addr} (tailnet, pairing required)");
}

// The tailnet listener runs in its own task and forwards accepted
// connections over a channel — TcpListener::accept() futures are not
// Send, so they can't be stored alongside the loopback accept in the
// same select. Shutdown is signalled via a shared atomic that the
// main loop sets right before it stops polling.
let shutdown = Arc::new(AtomicBool::new(false));
let (tailnet_tx, mut tailnet_rx) = mpsc::channel::<(TcpStream, std::net::SocketAddr)>(64);
if let Some(listener) = tailnet_listener {
    let shutdown_task = Arc::clone(&shutdown);
    tokio::spawn(async move {
        loop {
            if shutdown_task.load(Ordering::Relaxed) {
                break;
            }
            tokio::select! {
                biased;
                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                    if shutdown_task.load(Ordering::Relaxed) { break; }
                }
                accept = listener.accept() => {
                    if shutdown_task.load(Ordering::Relaxed) { break; }
                    match accept {
                        Ok((stream, peer)) => {
                            if tailnet_tx.send((stream, peer)).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                    }
                }
            }
        }
    });
}

loop {
    tokio::select! {
        biased;
        _ = &mut abort_rx => {
            eprintln!("[mobile-relay] shutting down");
            shutdown.store(true, Ordering::Relaxed);
            break;
        }
        accept = listener.accept() => {
            match accept {
                Ok((stream, peer)) => {
                    spawn_connection_handler(
                        &relay_state,
                        stream,
                        peer,
                        app.clone(),
                        Arc::clone(&db),
                        Arc::clone(&chat_mgr),
                    )
                    .await;
                }
                Err(e) => {
                    eprintln!("[mobile-relay] accept error: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
        incoming = tailnet_rx.recv() => {
            match incoming {
                Some((stream, peer)) => {
                    spawn_connection_handler(
                        &relay_state,
                        stream,
                        peer,
                        app.clone(),
                        Arc::clone(&db),
                        Arc::clone(&chat_mgr),
                    )
                    .await;
                }
                None => {
                    // Tailnet task exited; keep serving loopback.
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
        }
    }
});
            })
            .map_err(|e| format!("failed to spawn relay thread: {e}"))?;
    // The bound port arrives from the relay thread; the token persistence,
    // status, and tailscale-serve sections below all need it.
    let port = port_rx
        .await
        .map_err(|e| format!("relay thread died before binding: {e}"))?;

    // REUSE the persisted pairing token across launches so a paired phone
    // reconnects AUTOMATICALLY after a desktop restart: the phone retries its
    // saved `ws://host/#token` URL with capped backoff, and a per-launch
    // rotated token turned every restart into a manual re-scan. Rotate only
    // via Settings → Remote → "New pairing token". The token still lives in
    // the OS keychain, never the settings table (audit fix: plaintext
    // settings lingered readable).
    let pairing_token = {
        let conn = db.lock();
        match crate::secrets::generic_load(&conn, "mobile", "pairing-token") {
            Some(t) if t.len() >= 32 => {
                eprintln!(
                    "[mobile-relay] pairing token loaded from keychain ({} chars, fp {})",
                    t.len(),
                    &t.chars().take(6).collect::<String>()
                );
                t
            }
            other => {
                let t = new_pairing_token();
                let stored = crate::secrets::generic_store(&conn, "mobile", "pairing-token", &t);
                eprintln!(
                    "[mobile-relay] pairing token CREATED (load returned {}; store ok={:?}) fp {}",
                    match &other { Some(v) => format!("short({})", v.len()), None => "None".into() },
                    stored.is_ok(),
                    &t.chars().take(6).collect::<String>()
                );
                t
            }
        }
    };
    {
        let conn = db.lock();
        let _ = db::set_setting(&conn, "mobile.relay_port", &port.to_string());
        // Migration: a pre-keychain plaintext token (or a revoked stale one)
        // must not linger readable in the settings table.
        let _ = db::delete_setting(&conn, "mobile.pairing_token");
    }

    *relay_state.port.lock() = Some(port);
    *relay_state.pairing_token.lock() = Some(pairing_token.clone());
    let _ = app.emit("mobile:pairing-token", pairing_token.clone());

    // Relay-side stream forwarder: phone-started turns stream straight from
    // the backend `chat:*` events to the owning phone. Registered once per
    // process (guarded inside): repeat calls from relay restarts are no-ops.
    let owner_map = relay_state.owner_map.clone();
    super::relay_owner::start_chat_stream_forwarder(&app, owner_map);

    // Background push (Expo push service): when no phone socket is connected,
    // approval requests and completed turns on MOBILE-originated sessions
    // reach the phone as OS notifications instead of being dropped. The
    // helpers no-op when no push token is registered or a phone IS connected
    // (the socket broadcast is the delivery path then).
    // Push listeners register ONCE per process: start_relay runs on every
    // relay (re)start, and unguarded re-registration duplicated every
    // approval/done push N times after N restarts (audit M-9).
    if !PUSH_LISTENERS_REGISTERED.swap(true, Ordering::SeqCst) {
        let push_app = app.clone();
        app.listen("chat:approval-request", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let chat_id = v
                .get("chatSessionId")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            let summary = v
                .get("summary")
                .and_then(|x| x.as_str())
                .unwrap_or("A tool action is waiting for your approval.")
                .to_string();
            if !chat_id.is_empty() {
                super::push::push_approval_for_mobile_session(&push_app, &chat_id, &summary);
            }
        });
        let push_app = app.clone();
        app.listen("chat:done", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let chat_id = v
                .get("chatSessionId")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            if !chat_id.is_empty() {
                super::push::push_turn_done_for_mobile_session(&push_app, &chat_id);
            }
        });
    }

    Ok(port)
}


/// Spawn one connection handler: bounded permit (audit L-16), active-connection
/// accounting, abort-handle registration, and a reaper. Shared by the loopback
/// and tailnet accept arms, which were two verbatim copies. The reaper removes
/// the handler's abort handle (and any other finished ones) once the handler
/// ends — the registry used to grow by one dead handle per accepted connection
/// for the whole process lifetime.
async fn spawn_connection_handler(
    relay_state: &Arc<MobileRelayState>,
    stream: TcpStream,
    peer: SocketAddr,
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
) {
    // Bounded (audit L-16): the permit is held for the handler's whole
    // life; when 64 connections are live, new streams wait here instead of
    // piling up handler+pump tasks.
    let permit = match relay_state.accept_permits.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => return, // semaphore closed: relay shutting down
    };
    let counters = Arc::clone(relay_state);
    let registry = Arc::clone(&relay_state.conns);
    let owner_map = relay_state.owner_map.clone();
    let handler = tokio::spawn(async move {
        use std::sync::atomic::Ordering as AOrd;
        let _permit = permit;
        counters.active_connections.fetch_add(1, AOrd::Relaxed);
        if let Err(e) =
            handle_connection(stream, peer, app, db, chat_mgr, owner_map, registry).await
        {
            eprintln!("[mobile-relay] connection error: {e}");
        }
        counters.active_connections.fetch_sub(1, AOrd::Relaxed);
    });
    let abort_handle = handler.abort_handle();
    relay_state.handler_aborts.lock().push(abort_handle);
    let reaper_state = Arc::clone(relay_state);
    tokio::spawn(async move {
        let _ = handler.await;
        reaper_state
            .handler_aborts
            .lock()
            .retain(|h| !h.is_finished());
    });
}

/// Stop the relay server.
pub fn stop_relay(relay_state: &MobileRelayState) {
    if let Some(tx) = relay_state.abort.lock().take() {
        let _ = tx.send(());
    }
    *relay_state.port.lock() = None;
    // Tear live connections down: draining the senders stops the push pumps,
    // and aborting the handlers kills their read loops. Without this a
    // pre-existing WebSocket kept its PRE-ROTATION E2E key and full command
    // surface across a restart — the token rotation was not fail-closed for
    // live connections (audit M-13).
    for h in relay_state.handler_aborts.lock().drain(..) {
        h.abort();
    }
    relay_state.conns.lock().clear();
    relay_state.owner_map.lock().clear();
    relay_state
        .active_connections
        .store(0, std::sync::atomic::Ordering::SeqCst);
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
        // Watch-scoped CHAT_OWNERS entries die with their last channel —
        // without this, every chat a phone ever opened accumulated in the
        // map for the whole process lifetime.
        super::relay_owner::prune_owners_without_channels(&self.map);
    }
}

/// Removes the connection's broadcast-registry entry when the handler exits
/// (any path). Companion to OwnerCleanup for the session-less `conns` set.
struct ConnCleanup {
    map: Arc<Mutex<std::collections::HashMap<u64, super::relay_ws::WsSender>>>,
    id: u64,
}

impl Drop for ConnCleanup {
    fn drop(&mut self) {
        self.map.lock().remove(&self.id);
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

/// The live pairing token. Lives in the OS keychain (secrets generic store)
/// since the at-rest fix — relay start writes it there and deletes the old
/// plaintext settings row, so no fallback read remains.
pub(crate) fn current_pairing_token(conn: &rusqlite::Connection) -> Option<String> {
    crate::secrets::generic_load(conn, "mobile", "pairing-token")
}

/// How long a fresh connection may take to present its Pair frame.
pub(super) const PAIRING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Keepalive ping cadence once paired.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(25);
/// Any inbound frame (message or pong) resets this; exceeding it means the
/// TCP connection is half-open and the handler tears down.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(75);

/// One copy of the dispatch-and-reply block that a dozen op arms shared
/// verbatim (`match dispatch_mobile(...) { Ok(msgs) => send each,
/// Err(e) => ChatError("session-chat") }`). Arms that must register the
/// owner map first (SendChatMessage, GetSessionMessages) do that themselves
/// and then call this.
async fn dispatch_and_send(
    req: MobileMessage,
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<ChatManager>,
    owner_map: &super::relay_ws::OwnerMap,
    write: &super::relay_ws::SharedWsWrite,
) {
    match dispatch_mobile(req, app, Arc::clone(db), Arc::clone(chat_mgr), owner_map.clone()) {
        Ok(msgs) => {
            for m in msgs {
                let _ = send_msg(write, &m).await;
            }
        }
        Err(e) => {
            let _ = send_msg(
                write,
                &DesktopMessage::ChatError {
                    chat_session_id: "session-chat".to_string(),
                    error: e,
                },
            )
            .await;
        }
    }
}

/// Assemble the phone's `AvailableProviders` reply (providers + harness list +
/// the current sync-default pick). Shared by the live reply and the post-warm
/// push so the two assemblies can't drift.
async fn build_available_providers_msg(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
) -> DesktopMessage {
    let providers = build_available_providers(db, app).await;
    let harnesses = build_harness_list();
    let (default_provider, default_model) = {
        let conn = db.lock();
        match crate::chat::auto_router::resolve_sync_default(&conn, db::now_ts()) {
            Some((p, m)) => (Some(p), Some(m)),
            None => (None, None),
        }
    };
    DesktopMessage::AvailableProviders {
        providers,
        harnesses,
        default_provider,
        default_model,
    }
}

/// Resolve project ids → display names with one deduplicated `IN` query,
/// under the caller's short lock. Shared by the session-list and cost-details
/// builders (the block used to be duplicated verbatim in both).
fn resolve_project_names(
    conn: &Connection,
    ids: impl IntoIterator<Item = String>,
) -> std::collections::HashMap<String, String> {
    let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<String> = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if unique.is_empty() {
        return names;
    }
    let placeholders = std::iter::repeat("?")
        .take(unique.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id, name FROM projects WHERE id IN ({placeholders})");
    if let Ok(mut stmt) = conn.prepare(&sql) {
        let params = rusqlite::params_from_iter(unique.iter());
        if let Ok(rows) = stmt.query_map(params, |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                names.insert(row.0, row.1);
            }
        }
    }
    names
}

async fn handle_connection(
    stream: TcpStream,
    _peer: SocketAddr,
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
    owner_map: OwnerMap,
    conn_registry: Arc<Mutex<std::collections::HashMap<u64, super::relay_ws::WsSender>>>,
) -> Result<(), String> {
    let ws_stream = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| format!("ws handshake failed: {e}"))?;
    let (sink, mut read) = ws_stream.split();
    // Share the write half with the per-connection owner-channel pump: the
    // request loop writes request/response messages directly while streaming
    // session-chat events arrive out-of-band on the channel registered in
    // the owner map (mobile:session_chat_event → relay_owner::forward → tx)
    // and must be pumped onto the SAME socket concurrently. Previously the
    // receiver was dropped on the floor, so every forwarded event failed
    // with "failed to send to owner" and the phone never saw tokens/done.
    // The sink carries the per-connection E2E state alongside it so the
    // request loop, the pump, and the decryptor all share one crypto
    // context (§3.2.11).
    let write: super::relay_ws::SharedWsWrite =
        Arc::new(tokio::sync::Mutex::new(super::relay_ws::SinkState {
            sink,
            e2e: super::relay_ws::RelayE2E::default(),
        }));
    let (conn_tx, conn_rx) = super::relay_ws::make_channel();
    // B-25: broadcast registration is DEFERRED until pairing succeeds (the
    // insert used to happen here, so any peer that opened the socket and
    // idled in the pairing window received every automation/budget push).
    // Removed by the cleanup guard when this handler exits, on any path.
    let conn_id = {
        static NEXT_CONN_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        NEXT_CONN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    };
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
    // Plaintext on purpose: it precedes pairing, so no key exists yet.
    let hello = DesktopMessage::DesktopStatus { connected: true };
    let _ = send_msg(&write, &hello).await;

    // Load the current pairing token. The first inbound frame MUST be a
    // Pair { token } — anything else is rejected and the connection is
    // dropped. This prevents an unauthenticated peer from issuing commands
    // like SendToSession, StartLocalModel, or CreateSession before a phone
    // has paired.
    let used_e2e = relay_requests::verify_pairing(&db, &write, &mut read).await?;

    // B-25: pairing succeeded — NOW register for broadcast pushes. Every
    // failure path above returned before this line, so unauthenticated peers
    // never enter the registry.
    conn_registry.lock().insert(conn_id, conn_tx.clone());
    let _conn_cleanup = ConnCleanup {
        map: Arc::clone(&conn_registry),
        id: conn_id,
    };

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
                    .sink
                    .send(Message::Ping(Vec::new()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }))
    };

    // M11: last-sent transcript hash per session for THIS connection — a
    // GetTranscript poll whose screen hasn't changed gets a tiny
    // `unchanged` marker instead of another full SGR snapshot.
    let mut transcript_hashes: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();

    loop {
        let msg = match tokio::time::timeout(IDLE_TIMEOUT, read.next()).await {
            Ok(Some(msg)) => msg.map_err(|e| format!("ws read failed: {e}"))?,
            Ok(None) => break,
            Err(_) => return Err("connection idle timeout (no pong)".into()),
        };
        if msg.is_close() {
            break;
        }
        // Ping/Pong are WebSocket control frames and stay unencrypted by
        // protocol. Application payloads arrive as Binary (E2E-encrypted) or
        // Text (legacy plaintext connections).
        let text = match msg {
            Message::Text(t) => {
                if used_e2e {
                    // B-24: an E2E-paired connection must not accept
                    // plaintext command frames — that would reduce E2E to
                    // response-only confidentiality (a replayed proof plus
                    // plaintext commands would fully control the desktop).
                    // relay_ws's protocol doc already declares Text frames a
                    // protocol violation in E2E mode; enforce it.
                    let err = DesktopMessage::ChatError {
                        chat_session_id: "pair".into(),
                        error: "protocol violation: plaintext frame on an E2E connection".into(),
                    };
                    let _ = send_msg(&write, &err).await;
                    continue;
                }
                t
            }
            Message::Binary(b) => {
                let plain = match super::relay_ws::decrypt_binary(&write, &b).await {
                    Some(p) => p,
                    None => {
                        // E2E not enabled (protocol violation) or tag
                        // mismatch. The inbound counter already advanced, so
                        // later frames stay decryptable — report and move on.
                        let err = DesktopMessage::ChatError {
                            chat_session_id: "unknown".to_string(),
                            error: "undecryptable frame (E2E not enabled or tag mismatch)".into(),
                        };
                        let _ = send_msg(&write, &err).await;
                        continue;
                    }
                };
                match String::from_utf8(plain) {
                    Ok(s) => s,
                    Err(_) => {
                        let err = DesktopMessage::ChatError {
                            chat_session_id: "unknown".to_string(),
                            error: "binary frame was not valid UTF-8".into(),
                        };
                        let _ = send_msg(&write, &err).await;
                        continue;
                    }
                }
            }
            Message::Ping(p) => {
                let _ = write.lock().await.sink.send(Message::Pong(p)).await;
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
                let resp = build_available_providers_msg(&db, &app).await;
                let _ = send_msg(&write, &resp).await;
                // A freshly started relay has COLD harness caches — the rail
                // would tell the user every CLI is "not installed" with no
                // models (they read warm caches only, never probe inline).
                // Probe once in the background, then PUSH the warmed list so
                // the already-connected phone repaints without reconnecting.
                if !HARNESS_WARMING.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    let warm_write = Arc::clone(&write);
                    let warm_db = Arc::clone(&db);
                    let warm_app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        // Clear the latch on EVERY exit path — the plain
                        // trailing store stayed true forever if the warm task
                        // panicked, and harness caches were never warmed again
                        // for the rest of the process.
                        let _reset = ResetHarnessWarming;
                        warm_harness_caches().await;
                        let resp = build_available_providers_msg(&warm_db, &warm_app).await;
                        let _ = send_msg(&warm_write, &resp).await;
                    });
                }
            }
            MobileMessage::ListSessions => {
                match build_session_list(&db, &app) {
                    Ok(sessions) => {
                        eprintln!(
                            "[mobile-relay] ListSessions: {} sessions ({} live)",
                            sessions.len(),
                            sessions.iter().filter(|s| s.is_live).count()
                        );
                        let _ = send_msg(&write, &DesktopMessage::SessionList { sessions }).await;
                    }
                    Err(e) => domain_error(&write, "sessions", e).await,
                }
            }
            MobileMessage::SetSessionStarred { .. } => {
                dispatch_and_send(req, &app, &db, &chat_mgr, &owner_map, &write).await;
            }
            MobileMessage::ListArtifacts => {
                let rows = {
                    let conn = db.lock();
                    db::list_artifacts(&conn)
                };
                match rows {
                    Ok(rows) => {
                        let artifacts = rows
                            .into_iter()
                            .map(|r| super::protocol::ArtifactLibraryEntry {
                                chat_session_id: r.chat_session_id,
                                filename: r.filename,
                                path: r.path,
                                kind: r.kind,
                                created_at: r.created_at,
                            })
                            .collect();
                        let _ = send_msg(&write, &DesktopMessage::ArtifactLibrary { artifacts }).await;
                    }
                    Err(e) => domain_error(&write, "artifacts", e.to_string()).await,
                }
            }
            MobileMessage::GetCostRollups { days } => {
                let days = days.unwrap_or(7).clamp(1, 90);
                let rollups = {
                    let conn = db.lock();
                    db::get_cost_rollups_v2(&conn, days)
                };
                match rollups {
                    Ok(r) => {
                        let value = serde_json::to_value(&r)
                            .unwrap_or_else(|_| serde_json::Value::Null);
                        let resp = DesktopMessage::CostRollups { rollups: value };
                        let _ = send_msg(&write, &resp).await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "cost-rollups".to_string(),
                                error: format!("{e}"),
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::ChatTurn {
                provider_id,
                model,
                messages,
                system,
                effort,
                gguf_path,
            } => {
                relay_requests::chat_turn_arm(
                    provider_id,
                    model,
                    messages,
                    system,
                    effort,
                    gguf_path,
                    &app,
                    &db,
                    &chat_mgr,
                    &write,
                    &mut read,
                    used_e2e,
                )
                .await?;
            }
            MobileMessage::CancelChatTurn { chat_session_id } => {
                chat_mgr.cancel(&chat_session_id);
                let resp = DesktopMessage::ChatDone {
                    chat_session_id,
                    usage: None,
                };
                let _ = send_msg(&write, &resp).await;
            }
            MobileMessage::SendToSession { session_id, text } => {
                eprintln!(
                    "[mobile-relay] SendToSession: session={session_id} text_len={}",
                    text.len()
                );
                if let Some(pty_state) = app.try_state::<crate::PtyState>() {
                    let pty = &pty_state.0;
                    if let Some(pane_id) = pty.pane_id_for_session(&session_id) {
                        eprintln!("[mobile-relay]   resolved pane_id={pane_id}");
                        let _ = pty.write(&pane_id, &text);
                    } else {
                        eprintln!(
                            "[mobile-relay]   no pane_id found, writing directly to session_id"
                        );
                        let _ = pty.write(&session_id, &text);
                    }
                }
            }
            MobileMessage::GetTranscript { session_id } => {
                relay_requests::get_transcript_arm(session_id, &app, &write, &mut transcript_hashes).await;
            }
            MobileMessage::GetCostSummary => {
                relay_requests::get_cost_summary_arm(&db, &write).await;
            }
            MobileMessage::GetCostDetails => {
                let details = build_cost_details(&db);
                let _ = send_msg(
                    &write,
                    &DesktopMessage::CostDetails {
                        daily: details.0,
                        per_project: details.1,
                        local_models: details.2,
                    },
                )
                .await;
            }
            MobileMessage::StartLocalModel { model, gguf_path } => {
                relay_requests::start_local_model_arm(model, gguf_path, &db, &app, &write).await;
            }
            MobileMessage::SpawnSession { session_id } => {
                relay_requests::spawn_session_arm(session_id, &app, &db, &write).await;
            }
            MobileMessage::CreateSession {
                project_id,
                harness,
                provider,
                model,
                effort,
                connectors,
            } => {
                relay_requests::create_session_arm(
                    project_id,
                    harness,
                    provider,
                    model,
                    effort,
                    connectors,
                    &app,
                    &db,
                    &write,
                )
                .await;
            }
            MobileMessage::ReadArtifactPreview { path } => {
                // Same containment gate as the full read — a preview op that
                // skipped it would be an arbitrary-file-read primitive.
                let granted = [
                    crate::chat::dispatch::artifacts_dir(&app).to_string_lossy().to_string(),
                    crate::user_dirs::app_data_dir(&app)
                        .join("generated-images")
                        .to_string_lossy()
                        .to_string(),
                ];
                if !crate::chat::permission::path_within_scope(&path, &granted) {
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::ChatError {
                            chat_session_id: "preview".to_string(),
                            error: "artifact path is outside the artifacts directory".into(),
                        },
                    )
                    .await;
                } else {
                    match crate::chat::commands::preview::read_artifact_preview(path.clone()).await
                    {
                        Ok(p) => {
                            let _ = send_msg(
                                &write,
                                &DesktopMessage::ArtifactPreviewMsg {
                                    path: p.path,
                                    filename: p.filename,
                                    ext: p.ext,
                                    kind: p.kind,
                                    text: p.text,
                                    data_uri: p.data_uri,
                                    truncated: p.truncated,
                                },
                            )
                            .await;
                        }
                        Err(e) => {
                            let _ = send_msg(
                                &write,
                                &DesktopMessage::ChatError {
                                    chat_session_id: "preview".to_string(),
                                    error: e,
                                },
                            )
                            .await;
                        }
                    }
                }
            }
            MobileMessage::ListConnectors => {
                let app2 = app.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::connectors_cmds::list_connectors(
                        app2.state::<crate::DbState>(),
                    )
                })
                .await
                .unwrap_or_else(|e| Err(format!("connectors worker failed: {e}")));
                match result {
                    Ok(rows) => {
                        let list = rows
                            .into_iter()
                            .map(|c| super::protocol::ConnectorInfo {
                                id: c.connector.id.to_string(),
                                display_name: c.connector.display_name.to_string(),
                                icon: c.connector.icon.to_string(),
                                family: c.connector.family.to_string(),
                                description: c.connector.description.to_string(),
                                connected: c.status.connected,
                                account_display: c.status.account_display,
                            })
                            .collect();
                        let _ =
                            send_msg(&write, &DesktopMessage::ConnectorList { connectors: list })
                                .await;
                    }
                    Err(e) => domain_error(&write, "connectors", e).await,
                }
            }
            MobileMessage::SetSessionConnectors { session_id, connector_ids } => {
                // Resolve FIRST and drop the DB guard before any await — a
                // parking_lot guard held across a send makes the whole
                // connection future non-Send.
                let resolved = {
                    let conn = db.lock();
                    super::session_chat::resolve_session_to_chat_id(&conn, &session_id)
                };
                let chat_session_id = match resolved {
                    Some(id) => id,
                    None => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "session-connectors".into(),
                                error: format!("session not found: {session_id}"),
                            },
                        )
                        .await;
                        continue;
                    }
                };
                // Lock the shared handle INSIDE the blocking worker — a
                // parking_lot guard can't cross the thread boundary.
                let db_inner = Arc::clone(&db);
                let ids = connector_ids.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let conn = db_inner.lock();
                    db::set_chat_session_connectors(&conn, &chat_session_id, &ids)
                        .map_err(|e| e.to_string())
                })
                .await
                .unwrap_or_else(|e| Err(format!("join failed: {e}")));
                let msg = match result {
                    Ok(()) => DesktopMessage::SessionConnectorsSet {
                        session_id,
                        connector_ids,
                    },
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "session-connectors".into(),
                        error: e,
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::GetSessionConnectors { session_id } => {
                let chat_session_id = {
                    let conn = db.lock();
                    super::session_chat::resolve_session_to_chat_id(&conn, &session_id)
                };
                let id = match chat_session_id {
                    Some(id) => id,
                    None => {
                        domain_error(
                            &write,
                            "session-connectors",
                            format!("session not found: {session_id}"),
                        )
                        .await;
                        continue;
                    }
                };
                let rows = {
                    let conn = db.lock();
                    db::list_chat_session_connectors(&conn, &id)
                };
                match rows {
                    Ok(connector_ids) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::SessionConnectors { session_id, connector_ids },
                        )
                        .await;
                    }
                    Err(e) => domain_error(&write, "session-connectors", e.to_string()).await,
                }
            }
            MobileMessage::ListAcpAgents => {
                // Probes CLI binaries off the WS task (same as the desktop's
                // own list_acp_agents).
                match crate::commands::agent_cmds::list_acp_agents(
                    app.state::<crate::DbState>(),
                )
                .await
                {
                    Ok(list) => {
                        let agents = list
                            .into_iter()
                            .map(|a| super::protocol::AcpAgentInfo {
                                id: a.id,
                                display_name: a.display_name,
                                installed: a.installed,
                            })
                            .collect();
                        let _ = send_msg(&write, &DesktopMessage::AcpAgentList { agents }).await;
                    }
                    Err(e) => domain_error(&write, "acp-agents", e).await,
                }
            }
            MobileMessage::ListMemoryRecords { include_inactive } => {
                match crate::commands::memory_cmds::memory_list(
                    include_inactive,
                    app.state::<crate::DbState>(),
                )
                .await
                {
                    Ok(list) => {
                        let records = list
                            .into_iter()
                            .map(|m| super::protocol::MemoryInfo {
                                id: m.id,
                                kind: m.kind,
                                content: m.content,
                                keywords: m.keywords,
                                importance: m.importance,
                                confidence: m.confidence,
                                status: m.status,
                                created_at: m.created_at,
                                updated_at: m.updated_at,
                            })
                            .collect();
                        let _ = send_msg(&write, &DesktopMessage::MemoryList { records }).await;
                    }
                    Err(e) => domain_error(&write, "memory", e).await,
                }
            }
            MobileMessage::UpdateMemoryRecord { memory_id, content, importance } => {
                let result = crate::commands::memory_cmds::memory_update(
                    memory_id.clone(),
                    content,
                    importance,
                    app.state::<crate::DbState>(),
                )
                .await;
                let msg = match result {
                    Ok(()) => DesktopMessage::MemoryUpdated { memory_id },
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "memory".into(),
                        error: e,
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::DeleteMemoryRecord { memory_id } => {
                let result = crate::commands::memory_cmds::memory_delete(
                    memory_id.clone(),
                    app.state::<crate::DbState>(),
                )
                .await;
                let msg = match result {
                    Ok(()) => DesktopMessage::MemoryDeleted { memory_id },
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "memory".into(),
                        error: e,
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::PurgeMemories => {
                match crate::commands::memory_cmds::memory_purge(
                    None,
                    app.state::<crate::DbState>(),
                )
                .await
                {
                    Ok(count) => {
                        let _ = send_msg(&write, &DesktopMessage::MemoryPurged { count }).await;
                    }
                    Err(e) => domain_error(&write, "memory", e).await,
                }
            }
            MobileMessage::ListInstalledSkills { kind } => {
                let kind_key = if kind.trim_end_matches('s') == "loop" { "loop" } else { "skill" };
                let result: Result<Vec<crate::installed_skills::InstalledSkill>, String> =
                    if kind_key == "loop" {
                        Ok(crate::installed_skills::list_installed("loops"))
                    } else {
                        Ok(crate::installed_skills::list_installed("skills"))
                    };
                match result {
                    Ok(list) => {
                        let skills = list
                            .into_iter()
                            .map(|k| super::protocol::InstalledSkillInfo {
                                slug: k.slug,
                                name: k.name,
                                description: k.description,
                                source: k.source,
                                kind: k.kind,
                            })
                            .collect();
                        let _ = send_msg(&write, &DesktopMessage::InstalledSkillList { skills }).await;
                    }
                    Err(e) => domain_error(&write, "skills", e).await,
                }
            }
            MobileMessage::ReadInstalledSkill { slug, kind } => {
                let (slug2, kind2) = (slug.clone(), kind.clone());
                let result = tauri::async_runtime::spawn_blocking(move || {
                    Ok(crate::installed_skills::read_installed(&slug2, &skill_kind_dir(&kind2)))
                })
                .await
                .unwrap_or_else(|e| Err(format!("skill read worker failed: {e}")));
                match result {
                    // None = the slug simply isn't installed; that's a real
                    // answer, not a failure. Err is a failure.
                    Ok(found) => {
                        let content = found.unwrap_or_default();
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::InstalledSkillContent { slug, kind, content },
                        )
                        .await;
                    }
                    Err(e) => domain_error(&write, "skills", e).await,
                }
            }
            MobileMessage::SaveInstalledSkill { slug, kind, content } => {
                let (slug2, kind2, content2) = (slug.clone(), kind.clone(), content);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::installed_skills::save_installed(&slug2, &skill_kind_dir(&kind2), &content2)
                })
                .await
                .unwrap_or_else(|e| Err(format!("join failed: {e}")));
                let msg = match result {
                    Ok(()) => DesktopMessage::InstalledSkillAck { slug, mirrored: 0 },
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "skills".into(),
                        error: e,
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::CreateInstalledSkill { name, kind, content } => {
                let (name2, kind2, content2) = (name.clone(), kind.clone(), content);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::skills_cmds::create_installed_skill(name2, kind2, content2)
                })
                .await
                .unwrap_or_else(|e| Err(format!("join failed: {e}")));
                let msg = match result {
                    Ok(k) => DesktopMessage::InstalledSkillList {
                        skills: vec![super::protocol::InstalledSkillInfo {
                            slug: k.slug,
                            name: k.name,
                            description: k.description,
                            source: k.source,
                            kind: k.kind,
                        }],
                    },
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "skills".into(),
                        error: e,
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::DeleteInstalledSkill { slug, kind } => {
                let (slug2, kind2) = (slug.clone(), kind.clone());
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::installed_skills::delete_installed(&slug2, &skill_kind_dir(&kind2))
                })
                .await
                .unwrap_or_else(|e| Err(format!("join failed: {e}")));
                let msg = match result {
                    Ok(()) => DesktopMessage::InstalledSkillAck { slug, mirrored: 0 },
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "skills".into(),
                        error: e,
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::MakeInstalledSkillsGlobal { kind } => {
                let kind2 = kind.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::skills_cmds::make_installed_global(kind2)
                })
                .await
                .unwrap_or_else(|e| Err(format!("globalize worker failed: {e}")));
                match result {
                    Ok(mirrored) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::InstalledSkillAck { slug: String::new(), mirrored },
                        )
                        .await;
                    }
                    Err(e) => domain_error(&write, "skills", e).await,
                }
            }
            MobileMessage::GitStatus { project_id } => {
                match project_path(&db, &project_id) {
                    Some(dir) => {
                        let dir2 = dir.clone();
                        let status = tauri::async_runtime::spawn_blocking(move || {
                            let p = std::path::Path::new(&dir2);
                            let st = crate::git::get_git_status(p);
                            let changed: Vec<serde_json::Value> =
                                serde_json::to_value(crate::git::get_changed_files(p))
                                    .ok()
                                    .and_then(|v| v.as_array().cloned())
                                    .unwrap_or_default();
                            (st, changed, crate::git::get_remote_url(p).map(|s| s.to_string()))
                        })
                        .await
                        .unwrap_or_else(|e| {
                            eprintln!("[mobile-relay] git status join failed: {e}");
                            (
                                crate::types::GitStatusInfo {
                                    is_repo: false,
                                    branch: None,
                                    dirty: false,
                                    ahead: 0,
                                    behind: 0,
                                },
                                Vec::new(),
                                None,
                            )
                        });
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::GitStatusMsg {
                                is_repo: status.0.is_repo,
                                branch: status.0.branch,
                                dirty: status.0.dirty,
                                ahead: status.0.ahead,
                                behind: status.0.behind,
                                remote_url: status.2,
                                changed_files: status.1,
                            },
                        )
                        .await;
                    }
                    None => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "git".into(),
                                error: format!("unknown project: {project_id}"),
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::GitDiff { project_id, path } => {
                let dir = match project_path(&db, &project_id) {
                    Some(dir) => dir,
                    None => {
                        domain_error(
                            &write,
                            "git",
                            format!("unknown project: {project_id}"),
                        )
                        .await;
                        continue;
                    }
                };
                let (d2, f2) = (dir, path.clone());
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let p = std::path::Path::new(&d2);
                    match &f2 {
                        Some(f) if !f.is_empty() => {
                            let full = crate::git::get_git_diff(p)?;
                            Ok(filter_diff_to_path(&full, f))
                        }
                        _ => crate::git::get_git_diff(p),
                    }
                })
                .await
                .unwrap_or_else(|e| Err(format!("diff worker failed: {e}")));
                match result {
                    Ok(out) => {
                        let _ = send_msg(&write, &DesktopMessage::GitOutput { output: out }).await;
                    }
                    Err(e) => domain_error(&write, "git", e).await,
                }
            }
            MobileMessage::GitCommit { project_id, message } => {
                let out = match project_path(&db, &project_id) {
                    Some(dir) => {
                        let (d2, m2) = (dir.clone(), message.clone());
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::git::git_commit(std::path::Path::new(&d2), &m2)
                        })
                        .await
                        .unwrap_or_else(|e| Err(format!("join failed: {e}")))
                        .unwrap_or_else(|e| e)
                    }
                    None => format!("unknown project: {project_id}"),
                };
                let _ = send_msg(&write, &DesktopMessage::GitOutput { output: out }).await;
            }
            MobileMessage::GitPush { project_id } => {
                let out = match project_path(&db, &project_id) {
                    Some(dir) => {
                        let d2 = dir.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::git::git_push(std::path::Path::new(&d2))
                        })
                        .await
                        .unwrap_or_else(|e| Err(format!("join failed: {e}")))
                        .unwrap_or_else(|e| e)
                    }
                    None => format!("unknown project: {project_id}"),
                };
                let _ = send_msg(&write, &DesktopMessage::GitOutput { output: out }).await;
            }
            MobileMessage::GitBranches { project_id } => {
                let dir = match project_path(&db, &project_id) {
                    Some(dir) => dir,
                    None => {
                        domain_error(
                            &write,
                            "git",
                            format!("unknown project: {project_id}"),
                        )
                        .await;
                        continue;
                    }
                };
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::git::list_branches(std::path::Path::new(&dir))
                        .map(|list| {
                            serde_json::to_value(list)
                                .ok()
                                .and_then(|v| v.as_array().cloned())
                                .unwrap_or_default()
                        })
                })
                .await
                .unwrap_or_else(|e| Err(format!("branch worker failed: {e}")));
                match result {
                    Ok(branches) => {
                        let _ = send_msg(&write, &DesktopMessage::GitBranchesMsg { branches }).await;
                    }
                    Err(e) => domain_error(&write, "git", e).await,
                }
            }
            MobileMessage::GitLog { project_id, limit } => {
                let dir = match project_path(&db, &project_id) {
                    Some(dir) => dir,
                    None => {
                        domain_error(
                            &write,
                            "git",
                            format!("unknown project: {project_id}"),
                        )
                        .await;
                        continue;
                    }
                };
                let limit2 = limit.unwrap_or(30).clamp(1, 200);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::git::get_git_log(std::path::Path::new(&dir)).map(|mut entries| {
                        entries.truncate(limit2);
                        serde_json::to_value(entries)
                            .ok()
                            .and_then(|v| v.as_array().cloned())
                            .unwrap_or_default()
                    })
                })
                .await
                .unwrap_or_else(|e| Err(format!("log worker failed: {e}")));
                match result {
                    Ok(entries) => {
                        let _ = send_msg(&write, &DesktopMessage::GitLogMsg { entries }).await;
                    }
                    Err(e) => domain_error(&write, "git", e).await,
                }
            }
            MobileMessage::ListBudgets => {
                match crate::commands::budget::list_budgets(app.state::<crate::DbState>()) {
                    Ok(list) => {
                        let budgets = list.into_iter().map(to_budget_info).collect();
                        let _ = send_msg(&write, &DesktopMessage::BudgetList { budgets }).await;
                    }
                    Err(e) => domain_error(&write, "budget", e).await,
                }
            }
            MobileMessage::SetBudget { project_id, monthly_usd, threshold_pct } => {
                let result = crate::commands::budget::set_budget(
                    app.state::<crate::DbState>(),
                    project_id.clone(),
                    monthly_usd,
                    threshold_pct,
                );
                match result {
                    Ok(cfg) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::BudgetList { budgets: vec![to_budget_info(cfg)] },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "budget".to_string(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::RemoveBudget { project_id } => {
                let result = crate::commands::budget::remove_budget(
                    app.state::<crate::DbState>(),
                    project_id.clone(),
                );
                match result {
                    Ok(()) => {
                        let budgets = crate::commands::budget::list_budgets(
                            app.state::<crate::DbState>(),
                        )
                        .unwrap_or_default()
                        .into_iter()
                        .map(to_budget_info)
                        .collect();
                        let _ = send_msg(&write, &DesktopMessage::BudgetList { budgets }).await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "budget".to_string(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::ListHiddenCostProjects => {
                match crate::commands::budget::list_hidden_cost_projects(
                    app.state::<crate::DbState>(),
                ) {
                    Ok(project_ids) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::HiddenCostProjects { project_ids },
                        )
                        .await;
                    }
                    Err(e) => domain_error(&write, "budget", e).await,
                }
            }
            MobileMessage::HideCostProject { project_id } => {
                if let Err(e) = crate::commands::budget::hide_cost_project(
                    app.state::<crate::DbState>(),
                    project_id.clone(),
                ) {
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::ChatError {
                            chat_session_id: "budget".to_string(),
                            error: e,
                        },
                    )
                    .await;
                } else {
                        let project_ids = crate::commands::budget::list_hidden_cost_projects(
                        app.state::<crate::DbState>(),
                    )
                    .unwrap_or_default();
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::HiddenCostProjects { project_ids },
                    )
                    .await;
                }
            }
            MobileMessage::UnhideCostProject { project_id } => {
                if let Err(e) = crate::commands::budget::unhide_cost_project(
                    app.state::<crate::DbState>(),
                    project_id.clone(),
                ) {
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::ChatError {
                            chat_session_id: "budget".to_string(),
                            error: e,
                        },
                    )
                    .await;
                } else {
                    let project_ids = crate::commands::budget::list_hidden_cost_projects(
                        app.state::<crate::DbState>(),
                    )
                    .unwrap_or_default();
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::HiddenCostProjects { project_ids },
                    )
                    .await;
                }
            }
            MobileMessage::ListProjects => {
                let rows = {
                    let conn = db.lock();
                    crate::db::list_projects(&conn)
                };
                match rows {
                    Ok(list) => {
                        let projects = list.into_iter().map(to_project_info).collect();
                        let _ = send_msg(&write, &DesktopMessage::ProjectList { projects }).await;
                    }
                    Err(e) => domain_error(&write, "projects", e.to_string()).await,
                }
            }
            MobileMessage::AddProject { path, name } => {
                let path = path.trim().to_string();
                if path.is_empty() {
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::ChatError {
                            chat_session_id: "project".to_string(),
                            error: "project path must not be empty".into(),
                        },
                    )
                    .await;
                } else {
                    // Name defaults to the folder's last segment (the desktop
                    // derives the same way when the user doesn't rename it).
                    let name = name
                        .map(|n| n.trim().to_string())
                        .filter(|n| !n.is_empty());
                    // The desktop command validates the dir, canonicalizes,
                    // strips the Windows UNC prefix, derives the folder name,
                    // and detects git — the phone must not invent rows.
                    let result = crate::commands::projects::add_project(
                        path,
                        app.state::<crate::DbState>(),
                    )
                    .await;
                    let result = result.inspect(|p| {
                        if let Some(n) = name {
                            let conn = db.lock();
                            let _ = crate::db::rename_project(&conn, &p.id, &n);
                        }
                    });
                    match result {
                        Ok(p) => {
                            let _ = send_msg(
                                &write,
                                &DesktopMessage::ProjectUpserted { project: to_project_info(p) },
                            )
                            .await;
                        }
                        Err(e) => {
                            let _ = send_msg(
                                &write,
                                &DesktopMessage::ChatError {
                                    chat_session_id: "project".to_string(),
                                    error: e,
                                },
                            )
                            .await;
                        }
                    }
                }
            }
            MobileMessage::RenameProject { project_id, name } => {
                let name = name.trim().to_string();
                let result = if name.is_empty() {
                    Err("project name must not be empty".to_string())
                } else {
                    let conn = db.lock();
                    crate::db::rename_project(&conn, &project_id, &name)
                        .map_err(|e| e.to_string())?;
                    crate::db::list_projects(&conn)
                        .ok()
                        .and_then(|ps| ps.into_iter().find(|p| p.id == project_id))
                        .ok_or_else(|| "project vanished after rename".to_string())
                };
                match result {
                    Ok(p) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ProjectUpserted { project: to_project_info(p) },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "project".to_string(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::RemoveProject { project_id } => {
                // Desktop command: also tears down the project's git worktrees
                // before dropping the row (the db fn alone leaked worktrees).
                let result = crate::commands::projects::remove_project(
                    project_id.clone(),
                    app.state::<crate::DbState>(),
                )
                .await
                .map_err(|e| e.to_string());
                match result {
                    Ok(()) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ProjectRemoved { project_id },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "project".to_string(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::ListAutomations => {
                let app2 = app.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::automation_cmds::list_automations(
                        app2.state::<crate::DbState>(),
                    )
                })
                .await
                .unwrap_or_else(|e| Err(format!("automation worker failed: {e}")));
                match result {
                    Ok(list) => {
                        let automations = list.into_iter().map(to_automation_info).collect();
                        let _ = send_msg(&write, &DesktopMessage::AutomationList { automations }).await;
                    }
                    Err(e) => domain_error(&write, "automation", e).await,
                }
            }
            MobileMessage::CreateAutomation { input } => {
                let parsed: Result<crate::db::automations::AutomationInput, _> =
                    serde_json::from_value(input);
                let result = match parsed {
                    Err(e) => Err(e.to_string()),
                    Ok(i) => {
                        let app2 = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let app_state = app2.clone();
                            let state = app_state.state::<crate::DbState>();
                            crate::commands::automation_cmds::create_automation(app2, state, i)
                        })
                        .await
                        .unwrap_or_else(|e| Err(format!("automation create join failed: {e}")))
                    }
                };
                match result {
                    Ok(a) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::AutomationUpdated { automation_id: a.id },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "automation".into(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::UpdateAutomation { automation_id, input } => {
                let parsed: Result<crate::db::automations::AutomationInput, _> =
                    serde_json::from_value(input);
                let result = match parsed {
                    Err(e) => Err(e.to_string()),
                    Ok(i) => {
                        let app2 = app.clone();
                        let id2 = automation_id.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let app_state = app2.clone();
                            let state = app_state.state::<crate::DbState>();
                            crate::commands::automation_cmds::update_automation(app2, state, id2, i)
                        })
                        .await
                        .unwrap_or_else(|e| Err(format!("automation update join failed: {e}")))
                    }
                };
                automation_ack(&write, automation_id, result).await;
            }
            MobileMessage::DeleteAutomation { automation_id } => {
                let app2 = app.clone();
                let id2 = automation_id.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let app_state = app2.clone();
                    let state = app_state.state::<crate::DbState>();
                    crate::commands::automation_cmds::delete_automation(app2, state, id2)
                })
                .await
                .unwrap_or_else(|e| Err(format!("automation delete join failed: {e}")));
                match result {
                    Ok(()) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::AutomationDeleted { automation_id },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "automation".into(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::SetAutomationEnabled { automation_id, enabled } => {
                let app2 = app.clone();
                let id2 = automation_id.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let app_state = app2.clone();
                    let state = app_state.state::<crate::DbState>();
                    crate::commands::automation_cmds::set_automation_enabled(app2, state, id2, enabled)
                })
                .await
                .unwrap_or_else(|e| Err(format!("automation toggle join failed: {e}")));
                automation_ack(&write, automation_id, result).await;
            }
            MobileMessage::RunAutomationNow { automation_id } => {
                let app2 = app.clone();
                let id2 = automation_id.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let app_state = app2.clone();
                    let state = app_state.state::<crate::DbState>();
                    crate::commands::automation_cmds::run_automation_now(app2, state, id2)
                })
                .await
                .unwrap_or_else(|e| Err(format!("automation run join failed: {e}")));
                match result {
                    Ok(()) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::AutomationRunStarted { automation_id },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "automation".into(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::StopAutomationRun { automation_id } => {
                match crate::commands::automation_cmds::stop_automation_run(automation_id.clone()) {
                    Ok(stopped) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::AutomationRunStopped { automation_id, stopped },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "automation".into(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::ListAutomationRuns { automation_id, limit } => {
                let app2 = app.clone();
                let id2 = automation_id.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::automation_cmds::list_automation_runs(
                        app2.state::<crate::DbState>(),
                        id2,
                        limit,
                        None,
                    )
                })
                .await
                .unwrap_or_else(|e| Err(format!("runs worker failed: {e}")));
                match result {
                    Ok(list) => {
                        let runs = list
                            .into_iter()
                            .map(|r| super::protocol::AutomationRunInfo {
                                id: r.id,
                                automation_id: r.automation_id,
                                started_at: r.started_at,
                                finished_at: r.finished_at,
                                status: r.status,
                                summary: r.summary,
                                chat_session_id: r.chat_session_id,
                                source: r.source,
                            })
                            .collect();
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::AutomationRuns { automation_id, runs },
                        )
                        .await;
                    }
                    Err(e) => domain_error(&write, "automation", e).await,
                }
            }
            MobileMessage::ListChatSkills => {
                // Small directory scan over skill roots (ms-scale, same scan the
                // desktop slash menu triggers on keystroke).
                match crate::commands::skills_cmds::list_chat_skills() {
                    Ok(list) => {
                        let skills = list
                            .into_iter()
                            .map(|s| super::protocol::ChatSkillInfo {
                                slug: s.slug,
                                name: s.name,
                                description: s.description,
                                origin: s.origin,
                            })
                            .collect();
                        let _ = send_msg(&write, &DesktopMessage::ChatSkills { skills }).await;
                    }
                    Err(e) => domain_error(&write, "chat-skills", e).await,
                }
            }
            MobileMessage::ListHarnessModels { harness_id } => {
                // Same shared probe cache the desktop picker uses; the
                // blocking CLI probe runs off the WS task.
                let outcome =
                    crate::commands::agent_cmds::harness_models_cached(harness_id.clone(), false)
                        .await;
                let msg = match outcome {
                    Ok(cfg) => DesktopMessage::HarnessModels {
                        harness_id,
                        models: cfg
                            .models
                            .iter()
                            .map(|m| super::protocol::HarnessModelRow {
                                id: m.id.clone(),
                                label: m.label.clone(),
                                source: m.source.to_string(),
                                thinking: m.thinking.clone(),
                            })
                            .collect(),
                        default_model: cfg.default_model,
                        endpoint: cfg.endpoint,
                        effort: cfg.effort,
                        effort_options: cfg.effort_options,
                    },
                    // Tag the DOMAIN, not the harness id: a ChatError
                    // carrying "claude_code" is indistinguishable from a real
                    // session id, so the phone routed it to the chat's error
                    // banner (invisible here) and the picker's pending spinner
                    // never cleared.
                    Err(e) => DesktopMessage::ChatError {
                        chat_session_id: "harness-models".to_string(),
                        error: format!("harness models: {e}"),
                    },
                };
                let _ = send_msg(&write, &msg).await;
            }
            MobileMessage::GetSessionMessages {
                session_id,
                before_id,
                limit,
            } => {
                // Opening a chat registers this connection's channel for the
                // chat id: watch entries stream desktop-started turns through
                // forward_to_owner, which resolves via the owner map — a chat
                // the phone opened but never turned on had no channel to
                // deliver to. Same registration order as SendChatMessage.
                super::relay_owner::register_owner(&owner_map, session_id.clone(), conn_tx.clone());
                dispatch_and_send(
                    MobileMessage::GetSessionMessages {
                        session_id,
                        before_id,
                        limit,
                    },
                    &app,
                    &db,
                    &chat_mgr,
                    &owner_map,
                    &write,
                )
                .await;
            }
            MobileMessage::SendChatMessage {
                session_id,
                text,
                attachments,
            } => {
                // Register this session in the owner map BEFORE dispatching,
                // so streaming events have a destination: the per-connection
                // pump task (spawned at connect time) writes whatever lands
                // on this channel to the socket, and the OwnerCleanup guard
                // removes the registration when this connection drops.
                super::relay_owner::register_owner(&owner_map, session_id.clone(), conn_tx.clone());
                dispatch_and_send(
                    MobileMessage::SendChatMessage {
                        session_id,
                        text,
                        attachments,
                    },
                    &app,
                    &db,
                    &chat_mgr,
                    &owner_map,
                    &write,
                )
                .await;
            }
            MobileMessage::CancelSessionStream { .. }
            | MobileMessage::ResolveSessionApproval { .. }
            | MobileMessage::RenameSession { .. }
            | MobileMessage::SetSessionModel { .. }
            | MobileMessage::DeleteChatSession { .. }
            | MobileMessage::GetSessionMeta { .. }
            | MobileMessage::RegisterPushToken { .. }
            | MobileMessage::ListSessionArtifacts { .. }
            | MobileMessage::ReadArtifact { .. }
            | MobileMessage::ResolvePlanProposal { .. } => {
                dispatch_and_send(req, &app, &db, &chat_mgr, &owner_map, &write).await;
            }
            MobileMessage::TranscribeAudio {
                data_base64,
                media_type,
            } => {
                relay_requests::transcribe_audio_arm(data_base64, media_type, &app, &write).await;
            }
            MobileMessage::SearchChatMessages { query, limit } => {
                match super::session_chat::handle_search_chat_messages(&db, query, limit) {
                    Ok(msgs) => {
                        for m in msgs {
                            let _ = send_msg(&write, &m).await;
                        }
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "search".to_string(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
            }
            MobileMessage::CompactSession { session_id } => {
                // Compaction is a full LLM summarization turn (seconds to
                // minutes). Awaiting it inline left every other phone op —
                // including CancelSessionStream and the terminal screen's
                // transcript polls — unread in the socket until the 75s idle
                // timeout tore the connection down. Run it on its own task:
                // replies carry no request id, so late delivery is fine, and
                // the pump keeps streaming while it runs.
                let compact_app = app.clone();
                let compact_db = Arc::clone(&db);
                let compact_write = Arc::clone(&write);
                tauri::async_runtime::spawn(async move {
                    match super::session_chat::handle_compact_session(&compact_app, &compact_db, session_id).await {
                        Ok(msgs) => {
                            for m in msgs {
                                let _ = send_msg(&compact_write, &m).await;
                            }
                        }
                        Err(e) => {
                            let _ = send_msg(
                                &compact_write,
                                &DesktopMessage::ChatError {
                                    chat_session_id: "compact".to_string(),
                                    error: e,
                                },
                            )
                            .await;
                        }
                    }
                });
            }
            MobileMessage::DeleteChatMessage { .. }
            | MobileMessage::EditUserMessage { .. }
            | MobileMessage::RegenerateMessage { .. }
            | MobileMessage::ListChatCheckpoints { .. }
            | MobileMessage::RestoreChatCheckpoint { .. }
            | MobileMessage::SetSessionPermissionMode { .. }
            | MobileMessage::ResolveSessionQuestion { .. } => {
                dispatch_and_send(req, &app, &db, &chat_mgr, &owner_map, &write).await;
            }
            // A second Pair frame after a successful pairing is a protocol
            // violation — already handled above before this match.
            MobileMessage::Pair { .. } => unreachable!("Pair is intercepted above"),
        }
    }

    Ok(())
}

fn to_budget_info(b: crate::commands::budget::BudgetConfig) -> super::protocol::BudgetInfo {
    super::protocol::BudgetInfo {
        project_id: b.project_id,
        monthly_usd: b.monthly_usd,
        threshold_pct: b.threshold_pct,
    }
}

/// Registered project id → its folder path. Git ops resolve through this:
/// the phone can only touch repos the desktop already knows as projects.
fn project_path(
    db: &Arc<Mutex<Connection>>,
    project_id: &str,
) -> Option<String> {
    let conn = db.lock();
    crate::db::list_projects(&conn)
        .ok()?
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.path)
}

/// Keep only the file-diff sections a single file's diff should show.
/// Returns an empty string when the diff has no section for `path` — the
/// caller must NOT fall back to the whole-repo diff, or a per-file peek
/// would render every file's change (and a quoted/escaped path git emits
/// would silently miss). Matching anchors on the `b/` side of the
/// `diff --git` header (`diff --git a/P b/P`, or its quoted form) so asking
/// for `src/foo` no longer also matches `src/foo-bar`.
fn filter_diff_to_path(diff: &str, path: &str) -> String {
    let target = path.trim_start_matches("./").trim_start_matches('/');
    let b_unquoted = format!(" b/{target}");
    let b_quoted = format!(" b/{target}\"");
    let mut out = String::new();
    let mut keep = false;
    for line in diff.lines() {
        if let Some(head) = line.strip_prefix("diff --git ") {
            keep = head.ends_with(&b_unquoted) || head.ends_with(&b_quoted);
        }
        if keep {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn to_project_info(p: crate::types::Project) -> super::protocol::ProjectInfo {
    super::protocol::ProjectInfo {
        id: p.id,
        path: p.path,
        name: p.name,
        is_git_repo: p.is_git_repo,
        created_at: p.created_at,
        last_opened_at: p.last_opened_at,
    }
}

/// The mobile protocol speaks "skill"/"loop"; the scanner works in on-disk
/// directory names ("skills"/"loops").
fn skill_kind_dir(kind: &str) -> &'static str {
    if kind.trim_end_matches('s') == "loop" {
        "loops"
    } else {
        "skills"
    }
}

/// Send a domain error to the phone instead of a plausible empty success —
/// an error-shaped answer is how the UI can tell "nothing yet" from
/// "the backend failed".
async fn domain_error(write: &super::relay_ws::SharedWsWrite, domain: &str, e: String) {
    let _ = send_msg(
        write,
        &DesktopMessage::ChatError {
            chat_session_id: domain.to_string(),
            error: e,
        },
    )
    .await;
}

fn to_automation_info(a: crate::db::automations::Automation) -> super::protocol::AutomationInfo {
    super::protocol::AutomationInfo {
        id: a.id,
        name: a.name,
        prompt: a.prompt,
        harness: a.harness,
        model: a.model,
        cwd: a.cwd,
        schedule: a.schedule,
        enabled: a.enabled,
        last_run_at: a.last_run_at,
        last_status: a.last_status,
        chat_session_id: a.chat_session_id,
        created_at: a.created_at,
        origin: a.origin,
        trigger_type: a.trigger_type,
    }
}

async fn automation_ack(
    write: &super::relay_ws::SharedWsWrite,
    automation_id: String,
    result: Result<(), String>,
) {
    let msg = match result {
        Ok(()) => DesktopMessage::AutomationUpdated { automation_id },
        Err(e) => DesktopMessage::ChatError {
            chat_session_id: "automation".into(),
            error: e,
        },
    };
    let _ = send_msg(write, &msg).await;
}

/// Send one DesktopMessage on the socket. Delegates to the shared sink
/// helper, which encrypts to a Binary frame when the connection paired with
/// an E2E proof (§3.2.11) and falls back to plaintext Text otherwise.
pub(super) async fn send_msg(
    write: &super::relay_ws::SharedWsWrite,
    msg: &DesktopMessage,
) -> Result<(), String> {
    super::relay_ws::send_ws_message(write, msg).await
}

/// Stable per-process digest of a transcript screen (M11 dedup). Uses
/// `DefaultHasher` (fixed SipHash keys), NOT a fresh `RandomState` — a new
/// `RandomState` per call gave every poll a different digest for the same
/// screen, so the `unchanged` dedup could never fire.
pub(crate) fn transcript_hash(text: &str) -> u64 {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(text.as_bytes());
    h.finish()
}

/// Handle ONE inbound frame read in the mid-turn select loop (B-26): decrypt
/// E2E `Binary` frames (advancing the inbound counter — skipping that
/// stranded the counter and broke decryption of every later frame), act on
/// `CancelChatTurn`, answer everything else with the busy error. `on_cancel`
/// receives the chat session id to cancel (production passes
/// `ChatManager::cancel`; tests record the call).
pub(crate) async fn handle_mid_turn_frame(
    msg: Message,
    used_e2e: bool,
    on_cancel: &(dyn Fn(&str) + Sync),
    write: &super::relay_ws::SharedWsWrite,
) {
    let text = match msg {
        Message::Text(t) => {
            if used_e2e {
                // Main-loop parity (B-24): plaintext command frames on an
                // E2E connection are a protocol violation.
                let err = DesktopMessage::ChatError {
                    chat_session_id: "pair".into(),
                    error: "protocol violation: plaintext frame on an E2E connection".into(),
                };
                let _ = send_msg(write, &err).await;
                return;
            }
            t
        }
        Message::Binary(b) => {
            // E2E frames must be decrypted mid-turn too. The inbound counter
            // advances for every Binary frame — decrypt success or not — so
            // it stays in lockstep with the phone's send counter.
            let plain = match super::relay_ws::decrypt_binary(write, &b).await {
                Some(p) => p,
                None => {
                    let err = DesktopMessage::ChatError {
                        chat_session_id: "unknown".to_string(),
                        error: "undecryptable frame (E2E not enabled or tag mismatch)".into(),
                    };
                    let _ = send_msg(write, &err).await;
                    return;
                }
            };
            match String::from_utf8(plain) {
                Ok(s) => s,
                Err(_) => {
                    let err = DesktopMessage::ChatError {
                        chat_session_id: "unknown".to_string(),
                        error: "binary frame was not valid UTF-8".into(),
                    };
                    let _ = send_msg(write, &err).await;
                    return;
                }
            }
        }
        Message::Ping(p) => {
            let _ = write.lock().await.sink.send(Message::Pong(p)).await;
            return;
        }
        _ => return,
    };

    match serde_json::from_str::<MobileMessage>(&text) {
        Ok(MobileMessage::CancelChatTurn { chat_session_id }) => {
            eprintln!("[mobile-relay] CancelChatTurn mid-turn (B-26)");
            on_cancel(&chat_session_id);
            let resp = DesktopMessage::ChatDone {
                chat_session_id,
                usage: None,
            };
            let _ = send_msg(write, &resp).await;
        }
        Ok(_) => {
            // One turn at a time: queueing other commands mid-stream would
            // need the full dispatch loop reentrant; tell the phone honestly.
            let err = DesktopMessage::ChatError {
                chat_session_id: "unknown".to_string(),
                error: "busy: a chat turn is in flight".into(),
            };
            let _ = send_msg(write, &err).await;
        }
        Err(e) => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "unknown".to_string(),
                error: format!("malformed request: {e}"),
            };
            let _ = send_msg(write, &err).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Chat turn handler
// ---------------------------------------------------------------------------

/// Build a temporary chat session and run the SSE stream, writing tokens
/// directly to the WebSocket. Returns the write half so the connection can
/// continue handling further messages.
pub(super) async fn handle_chat_turn(
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
    // Resolve provider id. Phone sessions may point at a named extra
    // endpoint ("openai_compatible-x7f2") — resolve its protocol kind; the
    // key/base lookups below stay keyed by the raw endpoint id.
    let provider_id = match crate::chat::providers::provider_kind(&provider_id_str) {
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
            // Phone-supplied path: only GGUF files the desktop scanner listed
            // may be spawned — an arbitrary `gguf_path` would point the
            // sidecar at any file on disk.
            if !is_known_model_path(db, path) {
                let err = DesktopMessage::ChatError {
                    chat_session_id: "warmup".to_string(),
                    error: format!("unknown local model path: {path}"),
                };
                let _ = send_msg(&write, &err).await;
                return Err("rejected unknown gguf_path".to_string());
            }
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
                return Err(format!(
                    "no API key configured for provider: {provider_id_str}"
                ));
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
            let _ = db::add_user_chat_message(&conn, &chat_session_id, &last.content);
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
        // Per-turn auto-retrieval is not wired through the mobile relay path yet.
        local_docs_retrieval: Vec::new(),
        memory_context: None,
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
    // Partial-line carry-over (same fix as chat::run_chat_stream): TCP chunks
    // split SSE `data:` lines arbitrarily, and parse_sse_chunk is fatal on a
    // half line. Only complete newline-terminated lines may be parsed.
    let mut pending = crate::util::SseLineBuffer::new();
    let mut buf = String::new();
    let mut full_text = String::new();
    // Shared provider-SSE pump: reasoning-sentinel <think> wrapping, full-text
    // accumulation, and B-18 parse-failure tolerance (a stray malformed line
    // is skipped instead of killing the turn — same contract as the builtin
    // chat path).
    let mut pump =
        crate::chat::streaming::ProviderSsePump::new(&mut buf, &mut full_text);

    'chunks: while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let _ = send_done(&write, &sid, None).await;
                return Err(format!("stream read error: {e}"));
            }
        };
        let complete_lines = pending.push(&chunk);

        for line in complete_lines {
            let line = line.trim_end();
            match pump.line(provider.as_ref(), line) {
                Ok(crate::chat::streaming::SsePumpEvent::Token(out)) => {
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
                Ok(crate::chat::streaming::SsePumpEvent::Done) => {
                    // Stream done — usage will be parsed from buffer below.
                    break 'chunks;
                }
                Ok(crate::chat::streaming::SsePumpEvent::Quiet) => {}
                Err(e) => {
                    let _ = send_done(&write, &sid, None).await;
                    return Err(format!("SSE parse error: {e}"));
                }
            }
        }
    }

    // EOF flush: a trailing line without a final newline (some servers close
    // this way) is still parsed — failures tolerated, the stream has ended.
    for trailing in pending.finish() {
        let trailing = trailing.trim_end();
        if trailing.is_empty() {
            continue;
        }
        if let Ok(crate::chat::streaming::SsePumpEvent::Token(out)) = pump.line(provider.as_ref(), trailing) {
            let token_msg = DesktopMessage::ChatToken {
                chat_session_id: sid.clone(),
                token: out,
            };
            let _ = send_msg(&write, &token_msg).await;
        }
    }

    if let Some(closing) = pump.close_think() {
        full_text.push_str(&closing);
        let token_msg = DesktopMessage::ChatToken {
            chat_session_id: sid.clone(),
            token: closing,
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
            db::NewChatMessage {
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
                provider: provider.as_deref(),
                model_key,
                completed_at: Some(db::now_ts()),
                ..db::NewChatMessage::assistant(&sid, &full_text)
            },
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

/// Query the desktop's chat list for the phone. Reads `chat_sessions` — the
/// same store the desktop sidebar's chat rail lists — not the legacy
/// `sessions` table (empty on every fresh install, which made the phone see
/// zero chats). Agent mapping: `harness:<id>` agents lose the prefix;
/// builtin/local chats fall back to their provider so the phone still shows
/// a meaningful agent label.
///
/// PERF (PERFORMANCE_AUDIT.md C5): previously this held the SQLite mutex
/// across N `get_project` calls (one per session). For 20+ sessions that
/// meant 20+ extra SELECTs while the lock blocked every other DB reader
/// (chat, pty, automation). Now: collect all session rows under one short
/// lock, release the lock, then bulk-resolve project names with a single
/// `IN (?, ?, ...)` query — also under one short lock. Lock-hold time
/// drops from O(N) to O(1).
fn build_session_list(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
) -> Result<Vec<super::protocol::SessionInfo>, String> {
    // Phase 1: read chats under one short lock.
    let sessions = {
        let conn = db.lock();
        crate::db::list_chat_sessions(&conn).map_err(|e| e.to_string())?
    };
    // Phase 2: bulk-resolve all referenced projects in one query (still
    // under one short lock — the previous code held the lock per row).
    let project_names: std::collections::HashMap<String, String> = {
        let conn = db.lock();
        resolve_project_names(&conn, sessions.iter().filter_map(|s| s.project_id.clone()))
    };
    let pty_state = app.try_state::<crate::PtyState>();
    let list = sessions
        .into_iter()
        .map(|s| {
            let project_id = s.project_id.clone().unwrap_or_default();
            let project_name = project_names
                .get(&project_id)
                .cloned()
                .unwrap_or_default();
            // `harness:<family>` agents carry the family the phone's UI keys
            // on; builtin chats fall back to their model provider and `local`
            // keeps its GGUF name.
            let harness = match s.agent.as_deref().and_then(|a| a.strip_prefix("harness:")) {
                Some(family) => family.to_string(),
                None => match s.agent.as_deref() {
                    Some(a) if a != "builtin" => a.to_string(),
                    _ => s.provider.clone(),
                },
            };
            let (is_live, status) = if let Some(pty) = pty_state.as_ref() {
                if let Some(pid) = pty.0.pane_id_for_session(&s.id) {
                    let state = pty
                        .0
                        .pane_state(&pid)
                        .unwrap_or_else(|| "working".to_string());
                    (true, state)
                } else {
                    (false, "idle".to_string())
                }
            } else {
                (false, "idle".to_string())
            };
            super::protocol::SessionInfo {
                id: s.id,
                project_id,
                project_name,
                title: s.title.unwrap_or_else(|| "Untitled".to_string()),
                harness,
                status,
                last_active_at: s.last_active_at,
                is_live,
                starred: s.starred,
                unread: s.unread,
                effort: s.effort_level,
            }
        })
        .collect::<Vec<_>>();
    Ok(list)
}

/// Agent-harness families for the phone's composer chips — the same adapter
/// registry the desktop agent picker lists. `installed` comes from the 30s
/// probe cache when warm (populated at boot / agent-menu opens); the cache's
/// CLI probes spawn each binary with --version, far too slow to run inline
/// on the relay's async path, so a cold cache simply reports not-installed.
/// Set while the background harness-cache warm-up runs — at most one.
static HARNESS_WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Clears HARNESS_WARMING on drop, so the warm latch can't stick `true` if
/// the warm task panics (which permanently froze harness-cache warm-up until
/// the next app restart).
struct ResetHarnessWarming;

impl Drop for ResetHarnessWarming {
    fn drop(&mut self) {
        HARNESS_WARMING.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// One background pass over the harness probe caches (install status via
/// `list_harnesses`, then each harness's model catalog). Probes spawn one
/// CLI process each (~5s worst case) — never run these on the WS task.
async fn warm_harness_caches() {
    let _ = crate::commands::pty_cmds::list_harnesses(None).await;
    for a in crate::harness_adapters::all_adapters() {
        let _ =
            crate::commands::agent_cmds::harness_models_cached(a.id().to_string(), false).await;
    }
}

fn build_harness_list() -> Vec<super::protocol::HarnessInfo> {
    crate::harness_adapters::all_adapters()
        .into_iter()
        .map(|a| {
            // Catalog from the WARM probe cache only — probing inline would
            // stall the relay's WS task for seconds per CLI. A cold pane is
            // fetched by the phone via ListHarnessModels on pane open.
            let cfg = crate::commands::agent_cmds::harness_models_cache_get(a.id());
            super::protocol::HarnessInfo {
                id: a.id().to_string(),
                display_name: a.display_name().to_string(),
                installed: crate::commands::pty_cmds::harness_status_cached_installed(a.id()),
                models: cfg
                    .as_ref()
                    .map(|c| {
                        c.models
                            .iter()
                            .map(|m| super::protocol::HarnessModelRow {
                                id: m.id.clone(),
                                label: m.label.clone(),
                                source: m.source.to_string(),
                                thinking: m.thinking.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                default_model: cfg.as_ref().and_then(|c| c.default_model.clone()),
                endpoint: cfg.as_ref().and_then(|c| c.endpoint.clone()),
                effort: cfg.as_ref().and_then(|c| c.effort.clone()),
                effort_options: cfg
                    .as_ref()
                    .map(|c| c.effort_options.clone())
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// Build the detailed cost breakdown for the mobile Settings cost dashboard.
/// Mirrors what the desktop CostDashboard shows: daily spend (all rows, the
/// client slices the last 14), per-project totals with project names, and
/// per-local-model token usage aggregated from assistant messages on
/// local_gguf chat sessions. Returns (daily, per_project, local_models).
///
/// PERF (PERFORMANCE_AUDIT.md C5): the per-project loop previously did an
/// N+1 `get_project` while still holding the DB lock. Now: collect
/// per-project rows under one short lock, release the lock, then
/// bulk-resolve names via a single `IN (...)` query — same O(1) lock-hold
/// pattern as `build_session_list`.
fn build_cost_details(
    db: &Arc<Mutex<Connection>>,
) -> (
    Vec<super::protocol::DailyCostEntry>,
    Vec<ProjectCostEntry>,
    Vec<LocalModelUsageEntry>,
) {
    // Phase 1: read rollups + local-model usage under one short lock.
    let (daily, per_project_ids, local_models) = {
        let conn = db.lock();
        let rollups = crate::db::get_cost_rollups_v2(&conn, 14).unwrap_or_else(|_| {
            crate::types::CostRollups {
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
            }
        });
        let daily: Vec<super::protocol::DailyCostEntry> = rollups
            .daily
            .into_iter()
            .map(|d| super::protocol::DailyCostEntry {
                day: d.day,
                cost_usd: d.cost_usd,
            })
            .collect();
        // Collect just the IDs (cheap clone of strings) so we can look up
        // names outside the lock.
        let per_project_ids: Vec<crate::types::ProjectCostRollup> = rollups.per_project;

        // Per-local-model usage: one row per model, summing the token columns
        // on assistant messages of local_gguf chat sessions.
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
            Err(_) => {
                return (daily, Vec::new(), Vec::new());
            }
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
        (daily, per_project_ids, local_models)
    };

    // Phase 2: bulk-resolve project names via a single IN-clause query.
    let per_project: Vec<ProjectCostEntry> = {
        let conn = db.lock();
        let names = resolve_project_names(
            &conn,
            per_project_ids.iter().map(|p| p.project_id.clone()),
        );
        per_project_ids
            .into_iter()
            .map(|p| {
                let project_name = names
                    .get(&p.project_id)
                    .cloned()
                    .unwrap_or_else(|| p.project_id.chars().take(6).collect());
                ProjectCostEntry {
                    project_id: p.project_id,
                    project_name,
                    total_cost_usd: p.total_cost_usd,
                    total_input_tokens: p.total_input_tokens,
                    total_output_tokens: p.total_output_tokens,
                }
            })
            .collect()
    };

    (daily, per_project, local_models)
}

async fn fetch_model_list(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    auth_style: &str,
) -> Vec<String> {
    let url = format!("{base}/v1/models");
    let req = match auth_style {
        // Anthropic's endpoint requires the version header alongside the key.
        "x-api-key" => client.get(&url).header("x-api-key", key).header(
            "anthropic-version",
            crate::chat::providers::ANTHROPIC_API_VERSION,
        ),
        _ => client
            .get(&url)
            .header("Authorization", format!("Bearer {key}")),
    };
    match req.timeout(std::time::Duration::from_secs(5)).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(json) = resp.json::<Value>().await {
                if let Some(data) = json.get("data").and_then(|v| v.as_array()) {
                    return data
                        .iter()
                        .filter_map(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                        .collect();
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Probe a single API provider for its model list. Returns an empty vec on
/// any failure (no key, network error, parse error). Caller deduplicates.
async fn probe_api_provider(
    client: &reqwest::Client,
    id: &str,
    fallback_models: &[&str],
    base_url: Option<&str>,
    key: &str,
) -> Vec<String> {
    // Suffixed endpoint ids probe by their protocol kind (auth style and
    // default bases are per kind, not per endpoint).
    let id = crate::chat::providers::provider_kind(id);
    let fetched = match id {
        "openrouter" => fetch_model_list(client, "https://openrouter.ai/api", key, "bearer").await,
        "anthropic_compatible" | "openai_compatible" => {
            if let Some(base) = base_url {
                let style = if id == "anthropic_compatible" {
                    "x-api-key"
                } else {
                    "bearer"
                };
                fetch_model_list(client, base, key, style).await
            } else {
                Vec::new()
            }
        }
        // Native providers — try /v1/models anyway, fall back to defaults.
        "anthropic" => {
            let base = base_url.unwrap_or("https://api.anthropic.com");
            fetch_model_list(client, base, key, "x-api-key").await
        }
        // Each native provider has its own default API base — pointing
        // DeepSeek/Kimi at api.openai.com just fails the fetch.
        "openai" => {
            let base = base_url.unwrap_or("https://api.openai.com");
            fetch_model_list(client, base, key, "bearer").await
        }
        "deepseek" => {
            let base = base_url.unwrap_or("https://api.deepseek.com");
            fetch_model_list(client, base, key, "bearer").await
        }
        "kimi" => {
            let base = base_url.unwrap_or("https://api.moonshot.ai");
            fetch_model_list(client, base, key, "bearer").await
        }
        _ => Vec::new(),
    };
    if fetched.is_empty() {
        fallback_models.iter().map(|s| s.to_string()).collect()
    } else {
        fetched
    }
}

/// Probe a local endpoint (Ollama / LM Studio) and return (models, is_running).
/// 2s timeout, returns false on any failure.
async fn probe_local_endpoint(
    client: &reqwest::Client,
    kind: &str,
    base: &str,
) -> (Vec<String>, bool) {
    let url = if kind == "ollama" {
        format!("{}/api/tags", base)
    } else {
        format!("{}/v1/models", base)
    };
    let Ok(resp) = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    else {
        return (Vec::new(), false);
    };
    if !resp.status().is_success() {
        return (Vec::new(), false);
    }
    let Ok(body) = resp.json::<Value>().await else {
        return (Vec::new(), true);
    };
    let models: Vec<String> = if kind == "ollama" {
        body.get("models")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        body.get("data")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    (models, true)
}

/// Check every known provider for availability and return a unified list.
///
/// PERF (PERFORMANCE_AUDIT.md C7): all API providers and local endpoints
/// are now probed CONCURRENTLY via `join_all` with an overall 5s wall-time
/// cap. The previous sequential implementation took up to ~49s worst-case
/// (11 HTTP probes × 5s timeout each) blocking the WS reply. With
/// `join_all`, total wall time is bounded by the slowest single probe (≤5s
/// for API providers, ≤2s for local).
pub async fn build_available_providers(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
) -> Vec<ProviderInfo> {
    // --- API providers (keychain check) ---
    // Native providers (anthropic, openai) don't expose /v1/models — only
    // compatible providers and OpenRouter do. For native providers, we use
    // the default model name as a fallback.
    // Defaults the desktop providers own are referenced from providers.rs so
    // the two catalogs can't drift; deepseek/kimi are mobile-only additions.
    let api_providers: &[(&str, &str, &[&str])] = &[
        (
            "anthropic",
            "Anthropic",
            &[crate::chat::providers::ANTHROPIC_DEFAULT_MODEL],
        ),
        (
            "openai",
            "OpenAI",
            &[crate::chat::providers::OPENAI_DEFAULT_MODEL],
        ),
        ("deepseek", "DeepSeek", &["deepseek-chat"]),
        ("kimi", "Kimi", &["kimi-k2-5"]),
        (
            "openrouter",
            "OpenRouter",
            &[crate::chat::providers::OPENROUTER_DEFAULT_MODEL],
        ),
        ("anthropic_compatible", "Anthropic Compatible", &[]),
        ("openai_compatible", "OpenAI Compatible", &[]),
    ];

    // Reuse a single reqwest::Client (PERF M9): constructing one per call
    // forced a fresh connection pool + DNS resolver + TLS config each time.
    // Cheap to share across providers; they all share a process-wide pool.
    static PROBE_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = PROBE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

    // Gather (id, display_name, fallback, base_url, key) for providers that
    // have a stored API key. ONE db lock acquisition to fetch all of them,
    // then drop the lock before kicking off any HTTP work.
    let providers_to_probe: Vec<(String, String, Vec<String>, Option<String>, String)> = {
        let conn = db.lock();
        let mut out = Vec::new();
        for (id, display_name, fallback_models) in api_providers {
            if !secrets::has_chat_api_key(&conn, id) {
                continue;
            }
            let key = secrets::get_chat_api_key(&conn, id).unwrap_or_default();
            let base_url = db::get_setting(&conn, &format!("chat.{id}.base_url"))
                .ok()
                .flatten();
            out.push((
                id.to_string(),
                display_name.to_string(),
                fallback_models.iter().map(|s| s.to_string()).collect(),
                base_url,
                key,
            ));
        }
        out
    };

    // Fire all probes concurrently. join_all awaits them all; each probe
    // already has its own 5s timeout so the worst-case total wall time is
    // 5s (the slowest one) — typically <1s.
    let probes = providers_to_probe
        .iter()
        .map(|(id, _display, _fb, base_url, key)| {
            let id = id.clone();
            let fallback = api_providers
                .iter()
                .find(|(pid, _, _)| *pid == id.as_str())
                .map(|(_, _, fb)| *fb)
                .unwrap_or(&[]);
            let base_str = base_url.clone();
            let key_str = key.clone();
            let client_ref = client;
            async move {
                let models =
                    probe_api_provider(client_ref, &id, fallback, base_str.as_deref(), &key_str)
                        .await;
                (id, models)
            }
        });
    let probed: Vec<(String, Vec<String>)> = futures_util::future::join_all(probes).await;

    let mut providers: Vec<ProviderInfo> = Vec::new();
    for (id, models) in probed {
        // Deduplicate case-insensitively.
        let mut seen = std::collections::HashSet::new();
        let unique_models: Vec<String> = models
            .into_iter()
            .filter(|m| seen.insert(m.to_lowercase()))
            .collect();
        if !unique_models.is_empty() {
            let display_name = api_providers
                .iter()
                .find(|(pid, _, _)| *pid == id.as_str())
                .map(|(_, dn, _)| (*dn).to_string())
                .unwrap_or_else(|| id.clone());
            providers.push(ProviderInfo {
                id,
                display_name,
                models: unique_models,
                is_local: false,
                is_running: true,
                gguf_path: None,
            });
        }
    }

    // --- Local endpoints (Ollama / LM Studio health probe) — also parallel. ---
    let local_endpoints = [
        ("ollama", "Ollama", "http://127.0.0.1:11434"),
        ("lmstudio", "LM Studio", "http://127.0.0.1:1234"),
    ];
    let local_probes = local_endpoints.iter().map(|(kind, _display, base)| {
        let kind = kind.to_string();
        let base = base.to_string();
        let client_ref = client;
        async move {
            let (models, is_running) = probe_local_endpoint(client_ref, &kind, &base).await;
            (kind, models, is_running)
        }
    });
    let local_results: Vec<(String, Vec<String>, bool)> =
        futures_util::future::join_all(local_probes).await;
    for (id, models, is_running) in local_results {
        let display_name = local_endpoints
            .iter()
            .find(|(k, _, _)| *k == id.as_str())
            .map(|(_, dn, _)| (*dn).to_string())
            .unwrap_or_else(|| id.clone());
        if is_running {
            providers.push(ProviderInfo {
                id,
                display_name,
                models,
                is_local: true,
                is_running,
                gguf_path: None,
            });
        }
    }

    // --- GGUF sidecar registry (running + available but not loaded) ---
    if let Some(local_state) = app.try_state::<crate::chat::local_models::LocalModelState>() {
        let registry = &local_state.0;

        // Currently running model (if any).
        let running_id = registry.status().map(|a| a.model_id.clone());

        // Scanned GGUF files: default locations + user-added folders,
        // through the shared 60s TTL cache (same source is_known_model_path
        // uses). The inline walk here used to re-read every GGUF header on
        // every ListAvailableProviders request AND on every post-warm push,
        // on the WS connection task.
        let scanned = known_models_cached(db);

        let mut seen = std::collections::HashSet::new();

        for gguf in &scanned {
            if seen.contains(&gguf.id) {
                continue;
            }
            seen.insert(gguf.id.clone());
            let is_running = running_id.as_deref() == Some(&gguf.id);
            let model_name = gguf
                .meta
                .name
                .clone()
                .unwrap_or_else(|| gguf.filename.clone());

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
        // row at all — the phone just shows the cloud providers.
        if scanned.is_empty() && running_id.is_none() {
            // no-op
        }
    }

    providers
}

/// True when `path` is a GGUF file the desktop scanner actually lists
/// (default model locations + the user-added folders from Settings). Every
/// phone-supplied `gguf_path` must resolve here before the desktop spawns
/// llama-server over it — an arbitrary path would hand a paired peer an
/// arbitrary-binary-execution primitive. Mirrors the scan in
/// `build_available_providers` (same sources, same dedup) so a path the
/// phone received from `AvailableProviders` always validates.
pub(crate) fn is_known_model_path(db: &Arc<Mutex<Connection>>, path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    let known = known_models_cached(db);
    known.iter().any(|f| f.path == path)
}

/// TTL cache for the known-model scan (audit L-13): `is_known_model_path`
/// runs inside the async relay handler per frame and used to full-walk every
/// configured model dir on EVERY call. Cache the combined scan for 60s,
/// keyed by the folder list so a settings change invalidates immediately.
fn known_models_cached(db: &Arc<Mutex<Connection>>) -> Vec<crate::chat::local_models::GgufFile> {
    static CACHE: std::sync::OnceLock<
        Mutex<Option<(std::time::Instant, String, Vec<crate::chat::local_models::GgufFile>)>>,
    > = std::sync::OnceLock::new();
    let folders_json = {
        let conn = db.lock();
        db::get_setting(&conn, "localModels.folders")
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, key, files)) = cache.lock().as_ref() {
        if *key == folders_json && at.elapsed() < std::time::Duration::from_secs(60) {
            return files.clone();
        }
    }
    let mut known = crate::chat::local_models::scan_default_locations();
    if let Ok(list) = serde_json::from_str::<Vec<String>>(&folders_json) {
        let seen: std::collections::HashSet<String> =
            known.iter().map(|f| f.id.clone()).collect();
        for folder in list.into_iter().filter(|s| !s.trim().is_empty()) {
            for file in
                crate::chat::local_models::scan_folder(std::path::Path::new(&folder), "user")
            {
                if !seen.contains(&file.id) {
                    known.push(file);
                }
            }
        }
    }
    *cache.lock() = Some((
        std::time::Instant::now(),
        folders_json,
        known.clone(),
    ));
    known
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
    // Spin up the sidecar with the persisted per-model runtime overrides
    // (incl. last-good ngl) so phone-triggered warm-ups behave exactly like
    // desktop restarts.
    let overrides = {
        let conn = app.state::<crate::DbState>().inner().0.lock();
        crate::chat::local_models::load_overrides(&conn, model_name)
    };
    // Pre-read the llama-server path (must not hold the lock across await).
    let user_llama_path = {
        let conn = app.state::<crate::DbState>().inner().0.lock();
        crate::db::get_setting(&conn, crate::chat::local_models::LLAMA_SERVER_PATH_KEY)
            .ok()
            .flatten()
    };
    let result = local_state
        .start(
            model_name.to_string(),
            model_path,
            None,
            Some(&overrides),
            user_llama_path,
        )
        .await
        .map_err(|e| format!("failed to start local model: {e}"))?;
    {
        let conn = app.state::<crate::DbState>().inner().0.lock();
        crate::chat::local_models::save_last_good_ngl(&conn, &result.model_id, result.n_gpu_layers);
    }
    Ok(result.base_url)
}

