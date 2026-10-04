//! `mobile::relay_requests` — per-request handlers for the mobile relay's
//! connection loop, carved verbatim out of `handle_connection`'s request
//! match (mechanical split; see REFACTOR_PROGRESS.md).

use std::sync::Arc;

use futures_util::StreamExt;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{DesktopMessage, MobileMessage};
use super::relay::{handle_chat_turn, handle_mid_turn_frame, send_msg, transcript_hash, warm_up_local_model, PAIRING_TIMEOUT};
use crate::chat::ChatManager;
use crate::db;

/// Drive the pairing handshake: load the expected token, send a fresh
/// per-connection challenge (`PairChallenge`), require the first frame to be
/// a `Pair`, and verify it — challenge-bound proof for v2 clients, legacy
/// static proof for pre-v2 clients (refused when
/// `mobile.pairing.require_challenge` is set). A proof is HMAC over the
/// token (so the token itself never crosses the wire) and both sides derive
/// a session key from it, which the read loop then enforces on every frame.
/// Sends the error frame and returns `Err` on every rejection path. Always
/// returns `true` (B-24 `used_e2e`), which the read loop still enforces
/// defensively.
pub(super) async fn verify_pairing<R>(
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
    read: &mut R,
) -> Result<bool, String>
where
    R: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let (expected_token, require_challenge) = {
        let conn = db.lock();
        (
            super::relay::current_pairing_token(&conn).unwrap_or_default(),
            crate::db::get_setting(&conn, "mobile.pairing.require_challenge")
                .ok()
                .flatten()
                .as_deref()
                == Some("true"),
        )
    };
    // Anti-brute-force: without a throttle an attacker can reconnect and
    // re-present captured/guessed proofs indefinitely. Five consecutive
    // failures lock pairing for 60s (success resets the counter).
    if let Err(remaining) = {
        let mut t = PAIR_ATTEMPTS.lock().expect("pairing tracker mutex");
        t.check()
    } {
        let err = DesktopMessage::ChatError {
            chat_session_id: "pair".into(),
            error: format!(
                "pairing failed: too many attempts — retry in {}s",
                remaining.as_secs()
            ),
        };
        let _ = send_msg(&write, &err).await;
        return Err(format!("pairing locked out for {remaining:?} after repeated failures"));
    }
    let result = pair_handshake(&expected_token, require_challenge, write, read).await;
    match &result {
        Ok(_) => {
            if let Ok(mut t) = PAIR_ATTEMPTS.lock() {
                t.note_success();
            }
        }
        Err(e) if e.contains("invalid") || e.contains("refused") => {
            if let Ok(mut t) = PAIR_ATTEMPTS.lock() {
                t.note_failure();
            }
        }
        Err(_) => {}
    }
    result
}

/// Consecutive-failure lockout state for pairing attempts. The logic is
/// unit-testable on its own; the process-global instance lives in
/// [`PAIR_ATTEMPTS`].
pub(super) struct PairAttemptTracker {
    consecutive_failures: u32,
    locked_until: Option<std::time::Instant>,
}

/// Five consecutive failed proofs trip the lockout.
pub(super) const PAIR_MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// Lockout window once tripped.
pub(super) const PAIR_LOCKOUT: std::time::Duration = std::time::Duration::from_secs(60);

impl PairAttemptTracker {
    pub(super) fn new() -> Self {
        Self {
            consecutive_failures: 0,
            locked_until: None,
        }
    }

    /// `Err(remaining)` while locked out.
    pub(super) fn check(&self) -> Result<(), std::time::Duration> {
        match self.locked_until {
            Some(until) if until > std::time::Instant::now() => {
                Err(until - std::time::Instant::now())
            }
            _ => Ok(()),
        }
    }

    pub(super) fn note_failure(&mut self) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= PAIR_MAX_CONSECUTIVE_FAILURES {
            self.locked_until =
                Some(std::time::Instant::now() + PAIR_LOCKOUT);
        }
    }

    pub(super) fn note_success(&mut self) {
        self.consecutive_failures = 0;
        self.locked_until = None;
    }
}

static PAIR_ATTEMPTS: std::sync::Mutex<PairAttemptTracker> = std::sync::Mutex::new(
    PairAttemptTracker {
        consecutive_failures: 0,
        locked_until: None,
    },
);

/// The connection-level handshake, split out of [`verify_pairing`] so tests
/// can drive it with a known token (the production entry loads the token
/// from the OS keychain, which a test process cannot do).
pub(super) async fn pair_handshake<R>(
    expected_token: &str,
    require_challenge: bool,
    write: &super::relay_ws::SharedWsWrite,
    read: &mut R,
) -> Result<bool, String>
where
    R: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    // Challenge FIRST: the phone cannot prove possession of the token in a
    // connection-bound way until it holds this connection's nonce. Sent
    // plaintext (E2E is not enabled yet); pre-v2 clients ignore the unknown
    // message type and fall back to the legacy static proof.
    let challenge = super::relay_crypto::random_challenge();
    {
        use base64::Engine as _;
        let challenge_frame = DesktopMessage::PairChallenge {
            nonce: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge),
        };
        let _ = send_msg(write, &challenge_frame).await;
    }
    let first = match tokio::time::timeout(PAIRING_TIMEOUT, read.next()).await {
        Ok(Some(Ok(msg))) => msg,
        Ok(Some(Err(e))) => return Err(format!("ws read failed before pairing: {e}")),
        Ok(None) => return Err("peer disconnected before pairing".into()),
        Err(_) => return Err("pairing timed out".into()),
    };
    // The Pair frame itself is plaintext on purpose — it is what establishes
    // the key. The E2E flow (§3.2.11) carries only an HMAC proof of the
    // token, never the raw token, so a passive observer can neither derive
    // the session key nor impersonate the phone (the proof is one-way and
    // replaying it yields a connection whose frames they cannot craft).
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
    let (legacy_token, proof, v2, v3) = match paired {
        MobileMessage::Pair {
            token,
            proof,
            v2,
            v3,
        } => (token, proof, v2, v3),
        _ => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "first frame must be a Pair message".into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err("first frame was not a Pair message".into());
        }
    };
    // The legacy plaintext-token mode was removed (fix/final-audit-loose-ends):
    // pairing requires the E2E proof. A client that presents only the raw
    // token is running a pre-E2E build and must update.
    let Some(p) = proof else {
        let err = DesktopMessage::ChatError {
            chat_session_id: "pair".into(),
            error: "pairing failed: this server requires the E2E proof — update the mobile app"
                .into(),
        };
        let _ = send_msg(&write, &err).await;
        let _ = legacy_token; // accepted field on the wire; ignored
        return Err("pairing failed: no E2E proof in Pair frame".into());
    };
    {
        // S-1: fail closed when no pairing token is configured — with an
        // empty token the proof is HMAC("") and publicly computable.
        // (The verify helpers also reject empty tokens themselves; this
        // check just gives the honest error message.)
        if expected_token.is_empty() {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "pairing failed: no pairing token configured".into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err("pairing failed: no pairing token configured".into());
        }
        // Challenge-bound proof (v2 clients): verifies only against THIS
        // connection's nonce, so a Pair frame captured on an earlier
        // connection cannot be replayed here.
        let nonce_bound =
            super::relay_crypto::verify_pair_proof_with_nonce(expected_token, &challenge, &p);
        let v2_client = v2 == Some(true);
        let v3_client = v3 == Some(true);
        // A v3 client (salt-bound, audit C9) necessarily saw a challenge, so
        // its proof MUST bind it — the legacy static-proof path is closed to
        // it exactly like v2, and a non-challenge-bound proof is refused.
        let challenge_required = require_challenge || v2_client || v3_client;
        // Legacy fallback: pre-v2 clients (no `v2` flag) may present the
        // static proof. A v2/v3 client never may — its proof must bind the
        // challenge — and neither may anyone once
        // `mobile.pairing.require_challenge` is set (post-upgrade fleet).
        let legacy_ok = !nonce_bound
            && !challenge_required
            && super::relay_crypto::verify_pair_proof(expected_token, &p);
        if !nonce_bound && !legacy_ok {
            let reason = if v2_client || v3_client {
                "pairing failed: invalid challenge proof"
            } else if require_challenge {
                "pairing failed: this server requires challenge-response pairing — update the mobile app"
            } else {
                "pairing failed: invalid E2E proof"
            };
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: reason.into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err(reason.to_string());
        }
        if legacy_ok {
            crate::relay_eprintln!(
                "[mobile-relay] paired via LEGACY static proof (pre-v2 client) — replay protection inactive for this connection"
            );
        }
        // Per-connection key (audit C1): a fresh salt per pairing makes the
        // session key unique per connection, so the counters that reset on
        // reconnect can never repeat (key, nonce) pairs. The salt rides the
        // plaintext PairOk frame — it is public; secrecy rests on the token.
        // Sent BEFORE enable_e2e so it stays plaintext and WS ordering
        // guarantees the phone derives the key before any encrypted frame.
        let wire_salt = super::relay_crypto::random_salt();
        {
            use base64::Engine as _;
            let pair_ok = DesktopMessage::PairOk {
                salt: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(wire_salt),
            };
            let _ = send_msg(write, &pair_ok).await;
        }
        // v3 clients bind the public salt to this connection's challenge
        // before deriving (audit C9): the raw salt alone is replayable, so a
        // MITM replaying a recorded PairOk would otherwise make the phone
        // re-derive a previous connection's key and reuse its nonce space.
        // Pre-v3 clients derive from the raw salt, unchanged on the wire.
        let effective_salt: Vec<u8> = if v3_client {
            super::relay_crypto::bind_salt_to_challenge(&challenge, &wire_salt).to_vec()
        } else {
            wire_salt.to_vec()
        };
        let key =
            super::relay_crypto::derive_session_key_with_salt(expected_token, &effective_salt);
        super::relay_ws::enable_e2e(&write, key).await;
        crate::relay_eprintln!("[mobile-relay] paired (E2E encrypted, per-connection key); processing commands");
    }
    Ok(true)
}

/// B-26 `ChatTurn`: run the turn on its own task while this loop keeps
/// polling the socket, so a mid-turn CancelChatTurn is never left unread.
#[allow(clippy::too_many_arguments)]
pub(super) async fn chat_turn_arm<R>(
    provider_id: String,
    model: String,
    messages: Vec<crate::chat::providers::ChatMessage>,
    system: Option<String>,
    effort: Option<String>,
    gguf_path: Option<String>,
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<ChatManager>,
    write: &super::relay_ws::SharedWsWrite,
    read: &mut R,
    used_e2e: bool,
) -> Result<(), String>
where
    R: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
                // B-26: run the turn on its own task and keep polling the
                // socket — an inline await used to make CancelChatTurn sit
                // unread in the socket for the whole stream, so the phone's
                // stop button did nothing mid-turn. Everything the turn needs
                // is cheaply cloneable (Arcs + AppHandle).
                let turn_app = app.clone();
                let turn_db = Arc::clone(&db);
                let turn_mgr = Arc::clone(&chat_mgr);
                let turn_write = Arc::clone(&write);
                let mut turn = tokio::spawn(async move {
                    handle_chat_turn(
                        provider_id,
                        model,
                        messages,
                        system,
                        effort,
                        gguf_path,
                        &turn_app,
                        &turn_db,
                        &turn_mgr,
                        &turn_write,
                    )
                    .await
                });
                // The temp-session turn registers NOTHING with ChatManager, so
                // a mid-turn `chat_mgr.cancel(sid)` used to be a no-op: the
                // phone's stop button acknowledged the cancel, the SSE loop had
                // no cancellation check, and the provider request ran to
                // completion — generation AND billing continued after the phone
                // believed the turn was over (audit H42). The abort handle lets
                // the cancel closure kill the turn task directly.
                let turn_abort = turn.abort_handle();
                loop {
                    tokio::select! {
                        res = &mut turn => {
                            if let Ok(Err(e)) = res {
                                let err = DesktopMessage::ChatError {
                                    chat_session_id: "unknown".to_string(),
                                    error: e,
                                };
                                let _ = send_msg(&write, &err).await;
                            }
                            break;
                        }
                        next = read.next() => {
                            match next {
                                Some(Ok(msg)) => {
                                    // Decrypts E2E Binary frames (advancing the
                                    // inbound counter), handles CancelChatTurn,
                                    // answers everything else with the busy
                                    // error. A mid-turn CancelChatTurn used to
                                    // ride an encrypted Binary frame straight
                                    // into the catch-all `Some(Ok(_)) => {}` —
                                    // the stop button did nothing on E2E
                                    // connections AND the stranded counter broke
                                    // decryption of every later frame.
                                    handle_mid_turn_frame(
                                        msg,
                                        used_e2e,
                                        // Kill the temp-session turn task on
                                        // cancel (audit H42); the chat-manager
                                        // route stays for parity.
                                        &|sid: &str| {
                                            chat_mgr.cancel(sid);
                                            turn_abort.abort();
                                        },
                                        &write,
                                    )
                                    .await;
                                }
                                Some(Err(e)) => {
                                    turn.abort();
                                    return Err(format!("ws read failed: {e}"));
                                }
                                None => {
                                    turn.abort();
                                    return Err("connection closed mid-turn".into());
                                }
                            }
                        }
                    }
                }
    Ok(())
}

/// Send the rendered terminal screen for a session, with the M11
/// unchanged-screen suppression keyed on this connection's hash map.
pub(super) async fn get_transcript_arm(
    session_id: String,
    app: &AppHandle,
    write: &super::relay_ws::SharedWsWrite,
    transcript_hashes: &mut std::collections::HashMap<String, u64>,
) {
                // Send the rendered terminal screen (vt100 snapshot) rather than
                // the raw stripped stream: TUI apps redraw via cursor-movement
                // sequences, which are unreadable when concatenated.
                let (text, rows, cols) = app
                    .try_state::<crate::PtyState>()
                    .and_then(|p| p.0.screen_for_session(&session_id))
                    .unwrap_or_default();
                // M11: skip re-sending a byte-identical screen — the phone
                // polls this on a timer and terminal screens are static far
                // more often than not.
                let hash = transcript_hash(&text);
                let unchanged = transcript_hashes.get(&session_id) == Some(&hash);
                if !unchanged {
                    transcript_hashes.insert(session_id.clone(), hash);
                }
                let resp = DesktopMessage::Transcript {
                    session_id,
                    text: if unchanged { String::new() } else { text },
                    cols,
                    rows,
                    unchanged,
                };
                let _ = send_msg(&write, &resp).await;
}

/// Cached (computed_at, today, week) spend summary. The phone polls
/// GetCostSummary every 5s and each uncached answer scans cost_events twice
/// with per-row pricing under the global DB mutex; spend only changes when a
/// turn completes, so a 60s TTL keeps the steady-state poll O(1).
static COST_SUMMARY_CACHE: std::sync::Mutex<Option<(std::time::Instant, f64, f64)>> =
    std::sync::Mutex::new(None);
const COST_SUMMARY_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// Aggregate spend for the phone Settings tab: today (UTC) + rolling week.
pub(super) async fn get_cost_summary_arm(
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
) {
                // Serve a fresh-enough cache entry without touching
                // cost_events at all (see the cache doc above). The guard is
                // dropped before the await — std MutexGuard is !Send and the
                // handler future must stay Send.
                let cached = COST_SUMMARY_CACHE
                    .lock()
                    .ok()
                    .and_then(|g| *g)
                    .filter(|(at, _, _)| at.elapsed() < COST_SUMMARY_TTL);
                if let Some((_, today, week)) = cached {
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::CostSummary { today, week, version: 2 },
                    )
                    .await;
                    return;
                }
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
                              WHERE timestamp >= ?1",
                        ) {
                            Ok(s) => s,
                            Err(_) => return 0.0,
                        };
                        let rows = stmt
                            .query_map(rusqlite::params![since], |r| {
                                Ok((
                                    r.get::<_, Option<i64>>(0)?,
                                    r.get::<_, Option<i64>>(1)?,
                                    r.get::<_, Option<String>>(2)?,
                                    r.get::<_, Option<i64>>(3)?,
                                    r.get::<_, Option<i64>>(4)?,
                                    r.get::<_, Option<i64>>(5)?,
                                ))
                            })
                            .ok();
                        if let Some(rows) = rows {
                            for row in rows.flatten() {
                                let (i, o, k, cc, cr, r) = row;
                                let usage = crate::harness_adapters::UsageInfo {
                                    input_tokens: i,
                                    output_tokens: o,
                                    cache_creation_input_tokens: cc,
                                    cache_read_input_tokens: cr,
                                    reasoning_output_tokens: r,
                                    cost_usd: None,
                                };
                                if let Some(c) = crate::harness_adapters::pricing::price_usage(
                                    &usage,
                                    k.as_deref(),
                                    &overrides,
                                ) {
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
                // Publish to the cache so the next 60s of 5s polls skip the
                // scans entirely.
                if let Ok(mut cache) = COST_SUMMARY_CACHE.lock() {
                    *cache = Some((std::time::Instant::now(), today, week));
                }
                let _ = send_msg(
                    &write,
                    &DesktopMessage::CostSummary {
                        today,
                        week,
                        version: 2,
                    },
                )
                .await;
}

/// Warm a local GGUF sidecar from the phone (model picker's Local pane):
/// spawn now so the first message is instant, persist the live endpoint.
pub(super) async fn start_local_model_arm(
    model: String,
    gguf_path: String,
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    write: &super::relay_ws::SharedWsWrite,
) {
                // Phone-supplied path: only GGUF files the desktop scanner
                // actually listed may be spawned — an arbitrary `gguf_path`
                // would point llama-server at any file on disk.
                if !super::relay::is_known_model_path(db, &gguf_path) {
                    let _ = send_msg(
                        &write,
                        &DesktopMessage::LocalModelError {
                            model,
                            error: format!("unknown local model path: {gguf_path}"),
                        },
                    )
                    .await;
                    return;
                }
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
                        let _ =
                            send_msg(&write, &DesktopMessage::LocalModelReady { model, base_url })
                                .await;
                    }
                    Err(e) => {
                        let _ =
                            send_msg(&write, &DesktopMessage::LocalModelError { model, error: e })
                                .await;
                    }
                }
}

/// Delegate spawning to the desktop frontend (mobile:session-open-requested):
/// frontend-owned pane ids and harness flags only it knows.
pub(super) async fn spawn_session_arm(
    session_id: String,
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
) {
                // Chat sessions (chat_sessions — everything the phone's list
                // shows) are chat-driven: harness turns spawn per-send via the
                // session bundle, so there is no terminal pane to open. Just
                // bump activity so the phone's list ordering follows.
                let chat_hit = {
                    let conn = db.lock();
                    crate::db::get_chat_session(&conn, &session_id)
                        .map(|hit| hit.is_some())
                        .map_err(|e| format!("{e}"))
                };
                if chat_hit == Ok(true) {
                    let conn = db.lock();
                    let _ = crate::db::touch_chat_session(&conn, &session_id);
                    return;
                }
                // Legacy `sessions` ids keep the old path. Delegate spawning to
                // the desktop frontend: it opens the session in a pane via the
                // normal session-launcher path (frontend-owned pane ids, harness
                // flags like Claude's --mcp-config, grid placement rules).
                // Spawning directly here used a `mobile-{uuid}` pane id the
                // frontend knew nothing about, so phone-spawned sessions ran
                // invisibly in the dev tab.
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
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: session_id.clone(),
                                error: "session not found".to_string(),
                            },
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: session_id.clone(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
}

/// Create a session from the phone and tell the desktop frontend to open it.
pub(super) async fn create_session_arm(
    project_id: String,
    harness: String,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    connectors: Option<Vec<String>>,
    _app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
) {
                // Create a real chat_sessions row — the store the desktop's
                // chat rail lists — so a phone-started chat exists everywhere.
                // The legacy `sessions` insert previously produced rows no
                // surface (desktop or phone) ever listed again.
                let session = {
                    let conn = db.lock();
                    // Provider/model: the phone's model chip, or "auto"
                    // routing (the desktop's fresh-chat default) when omitted.
                    let prov = provider.unwrap_or_else(|| "auto".to_string());
                    let mdl = model.unwrap_or_else(|| "auto".to_string());
                    let prov = if harness == "local" { "local_gguf".to_string() } else { prov };
                    crate::db::create_chat_session(
                        &conn,
                        &prov,
                        &mdl,
                        if project_id.is_empty() { None } else { Some(project_id.as_str()) },
                    )
                    .and_then(|mut chat| {
                        if !harness.is_empty() && harness != "auto" {
                            crate::db::update_chat_session_agent(
                                &conn,
                                &chat.id,
                                Some(&format!("harness:{harness}")),
                            )?;
                            chat.agent = Some(format!("harness:{harness}"));
                        }
                        // The picker's effort slider rides the same create —
                        // "" normalizes to NULL (provider default) inside.
                        if let Some(effort) = &effort {
                            crate::db::update_chat_session_effort(&conn, &chat.id, effort)?;
                            chat.effort_level = {
                                let e = effort.trim();
                                if e.is_empty() { None } else { Some(e.to_string()) }
                            };
                        }
                        // Connectors attached from the composer's @-menu before
                        // the chat existed — same per-session set the desktop
                        // composer edits.
                        if let Some(ids) = &connectors {
                            if !ids.is_empty() {
                                crate::db::set_chat_session_connectors(&conn, &chat.id, ids)?;
                            }
                        }
                        Ok(chat)
                    })
                    .map_err(|e| format!("{e}"))
                };
                match session {
                    Ok(s) => {
                        // No mobile:session-open-requested: a fresh chat has no
                        // terminal pane to open — it surfaces in the desktop's
                        // chat rail on its next list refresh.
                        let pname = {
                            let conn = db.lock();
                            crate::db::get_project(&conn, &project_id)
                                .ok()
                                .flatten()
                                .map(|p| p.name)
                                .unwrap_or_default()
                        };
                        let info = super::protocol::SessionInfo {
                            id: s.id,
                            project_id: project_id.clone(),
                            project_name: pname,
                            title: s.title.unwrap_or_else(|| "Untitled".to_string()),
                            harness: harness.clone(),
                            status: "idle".to_string(),
                            last_active_at: s.last_active_at,
                            is_live: false,
                            starred: false,
                            unread: false,
                            effort: s.effort_level,
                        };
                        let _ = send_msg(&write, &DesktopMessage::SessionCreated { session: info })
                            .await;
                    }
                    Err(e) => {
                        let _ = send_msg(
                            &write,
                            &DesktopMessage::ChatError {
                                chat_session_id: "create".to_string(),
                                error: e,
                            },
                        )
                        .await;
                    }
                }
}

/// Voice notes ride the desktop's whisper sidecar via the same transcribe
/// core the desktop push-to-talk uses (async; not through dispatch_mobile).
pub(super) async fn transcribe_audio_arm(
    data_base64: String,
    media_type: Option<String>,
    app: &AppHandle,
    write: &super::relay_ws::SharedWsWrite,
) {
                // Voice notes ride the desktop's whisper sidecar via the same
                // transcribe core the desktop push-to-talk uses. Async because
                // the sidecar HTTP call is; handled inline (not through
                // dispatch_mobile, which is sync).
                let result = crate::commands::speech::transcribe_audio(
                    app.state::<crate::DbState>(),
                    app.state::<crate::commands::stt::SttState>(),
                    data_base64,
                    media_type,
                    None,
                    None,
                )
                .await;
                let resp = match result {
                    Ok(r) => DesktopMessage::Transcription {
                        text: Some(r.text),
                        error: None,
                    },
                    Err(e) => DesktopMessage::Transcription {
                        text: None,
                        error: Some(e.to_string()),
                    },
                };
                let _ = send_msg(&write, &resp).await;
}
