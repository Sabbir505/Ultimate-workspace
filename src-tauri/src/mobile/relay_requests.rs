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
use super::relay::{
    handle_chat_turn, handle_mid_turn_frame, pairing_token_accepted, send_msg, transcript_hash,
    warm_up_local_model, PAIRING_TIMEOUT,
};
use crate::chat::ChatManager;
use crate::db;

/// Drive the pairing handshake: load the expected token, require the first
/// frame to be a `Pair`, and verify it via the E2E proof or the legacy token
/// compare. Sends the error frame and returns `Err` on every rejection path.
/// Returns the B-24 `used_e2e` flag the read loop enforces afterwards.
pub(super) async fn verify_pairing<R>(
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
    read: &mut R,
) -> Result<bool, String>
where
    R: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
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
    let (legacy_token, proof) = match paired {
        MobileMessage::Pair { token, proof } => (token, proof),
        _ => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "first frame must be a Pair message".into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err("first frame was not a Pair message".into());
        }
    };
    // B-24: which pairing mode won — E2E connections must reject plaintext
    // Text command frames (relay_ws's protocol doc promises exactly that).
    let used_e2e = proof.is_some();
    match (proof, legacy_token) {
        // E2E path: proof-only. Verify the HMAC against the expected token,
        // then both sides derive the same session key from the shared PSK.
        (Some(p), _) => {
            // S-1: fail closed when no pairing token is configured — with an
            // empty token the proof is HMAC("") and publicly computable.
            // (verify_pair_proof now also rejects empty tokens itself; this
            // check just gives the honest error message.)
            if expected_token.is_empty() {
                let err = DesktopMessage::ChatError {
                    chat_session_id: "pair".into(),
                    error: "pairing failed: no pairing token configured".into(),
                };
                let _ = send_msg(&write, &err).await;
                return Err("pairing failed: no pairing token configured".into());
            }
            if !super::relay_crypto::verify_pair_proof(&expected_token, &p) {
                let err = DesktopMessage::ChatError {
                    chat_session_id: "pair".into(),
                    error: "pairing failed: invalid E2E proof".into(),
                };
                let _ = send_msg(&write, &err).await;
                return Err("pairing failed: invalid E2E proof".into());
            }
            let key = super::relay_crypto::derive_session_key(&expected_token);
            super::relay_ws::enable_e2e(&write, key).await;
            eprintln!("[mobile-relay] paired (E2E encrypted); processing commands");
        }
        // Legacy plaintext path: raw token compare (pre-E2E clients).
        (None, Some(presented)) => {
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
            eprintln!("[mobile-relay] paired (legacy plaintext); processing commands");
        }
        // Neither field: not a valid Pair frame.
        (None, None) => {
            let err = DesktopMessage::ChatError {
                chat_session_id: "pair".into(),
                error: "pairing failed: Pair frame must carry a proof or a token".into(),
            };
            let _ = send_msg(&write, &err).await;
            return Err("pairing failed: Pair frame carried neither proof nor token".into());
        }
    }
    Ok(used_e2e)
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
                                        &|sid: &str| chat_mgr.cancel(sid),
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

/// Aggregate spend for the phone Settings tab: today (UTC) + rolling week.
pub(super) async fn get_cost_summary_arm(
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
) {
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
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    write: &super::relay_ws::SharedWsWrite,
) {
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
                            harness: s.harness,
                            status: "idle".to_string(),
                            last_active_at: s.last_active_at,
                            is_live: false,
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
