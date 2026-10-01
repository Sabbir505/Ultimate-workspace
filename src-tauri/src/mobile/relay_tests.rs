use std::sync::Arc;

use parking_lot::Mutex;

use crate::db;
use crate::mobile::relay::TempChatSessionCleanup;

// ---------------------------------------------------------------------------
// F1: mid-turn E2E frames (decrypt + counter + CancelChatTurn)
// ---------------------------------------------------------------------------

/// A real loopback WebSocket pair: the server half is wrapped in the same
/// `SharedWsWrite` shape `handle_connection` builds, with E2E enabled for
/// `key`; the client half is what the "phone" reads replies from.
async fn e2e_ws_pair(
    key: [u8; 32],
) -> (
    crate::mobile::relay_ws::SharedWsWrite,
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) {
    use futures_util::StreamExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(stream).await.unwrap()
    });
    let (client, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
        .await
        .unwrap();
    let server = server.await.unwrap();
    // The read half is dropped: the sink's BiLock keeps the socket alive, and
    // the tests feed frames to the handler directly rather than via the wire.
    let (sink, _server_read) = server.split();
    let write: crate::mobile::relay_ws::SharedWsWrite = Arc::new(tokio::sync::Mutex::new(
        crate::mobile::relay_ws::SinkState {
            sink,
            e2e: crate::mobile::relay_ws::RelayE2E::default(),
        },
    ));
    crate::mobile::relay_ws::enable_e2e(&write, key).await;
    (write, client)
}

/// Phone-side: encrypt one MobileMessage at `counter`.
fn phone_frame(
    key: &[u8; 32],
    counter: u64,
    msg: &crate::mobile::protocol::MobileMessage,
) -> Vec<u8> {
    crate::mobile::relay_crypto::encrypt(key, counter, &serde_json::to_vec(msg).unwrap())
}

/// Phone-side: read the next Binary frame from the desktop and decrypt it at
/// the phone's receive `counter`.
async fn phone_recv(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    key: &[u8; 32],
    counter: u64,
) -> crate::mobile::protocol::DesktopMessage {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
        .await
        .expect("desktop reply timed out")
        .expect("socket closed")
        .expect("ws read error");
    let Message::Binary(bytes) = frame else {
        panic!("E2E connection must answer with Binary frames, got {frame:?}");
    };
    let plain = crate::mobile::relay_crypto::decrypt(key, counter, &bytes)
        .expect("desktop frame must decrypt at the phone's receive counter");
    serde_json::from_slice(&plain).unwrap()
}

/// F1 regression: an encrypted CancelChatTurn read by the mid-turn select
/// loop must be decrypted (advancing the inbound counter) and acted on. The
/// old loop only parsed `Message::Text`, so on E2E connections the cancel
/// was silently dropped AND every later frame failed decryption.
#[tokio::test]
async fn mid_turn_encrypted_cancel_is_honored_and_counter_stays_in_sync() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay::handle_mid_turn_frame;
    use tokio_tungstenite::tungstenite::Message;

    let key = crate::mobile::relay_crypto::derive_session_key("f1-pairing-token");
    let (write, mut client) = e2e_ws_pair(key).await;

    let cancelled: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let record = {
        let cancelled = Arc::clone(&cancelled);
        move |sid: &str| cancelled.lock().push(sid.to_string())
    };

    // Phone frame #0: encrypted CancelChatTurn mid-turn.
    let cancel = MobileMessage::CancelChatTurn {
        chat_session_id: "cs-1".into(),
    };
    handle_mid_turn_frame(
        Message::Binary(phone_frame(&key, 0, &cancel)),
        true,
        &record,
        &write,
    )
    .await;
    assert_eq!(
        *cancelled.lock(),
        vec!["cs-1".to_string()],
        "cancel must reach ChatManager"
    );
    match phone_recv(&mut client, &key, 0).await {
        DesktopMessage::ChatDone {
            chat_session_id,
            usage,
        } => {
            assert_eq!(chat_session_id, "cs-1");
            assert!(usage.is_none());
        }
        other => panic!("expected ChatDone, got {other:?}"),
    }

    // Phone frame #1: a non-cancel command. It decrypts ONLY if frame #0
    // advanced the inbound counter to 1 — the old code never did — and is
    // answered with the busy error rather than silence.
    let other = MobileMessage::ListAvailableProviders;
    handle_mid_turn_frame(
        Message::Binary(phone_frame(&key, 1, &other)),
        true,
        &record,
        &write,
    )
    .await;
    match phone_recv(&mut client, &key, 1).await {
        DesktopMessage::ChatError { error, .. } => assert!(error.contains("busy"), "{error}"),
        other => panic!("expected busy ChatError, got {other:?}"),
    }
    assert_eq!(
        cancelled.lock().len(),
        1,
        "non-cancel commands must not cancel"
    );

    // Phone frame #2: a replayed stale frame (encrypted at counter 0) fails
    // its nonce check → undecryptable error, but the counter STILL advances
    // (main-loop parity), so...
    handle_mid_turn_frame(
        Message::Binary(phone_frame(&key, 0, &cancel)),
        true,
        &record,
        &write,
    )
    .await;
    match phone_recv(&mut client, &key, 2).await {
        DesktopMessage::ChatError { error, .. } => {
            assert!(error.contains("undecryptable"), "{error}")
        }
        other => panic!("expected undecryptable ChatError, got {other:?}"),
    }
    assert_eq!(
        cancelled.lock().len(),
        1,
        "a replayed frame must not cancel"
    );

    // ...phone frame #3 at counter 3 still decrypts and cancels.
    let cancel2 = MobileMessage::CancelChatTurn {
        chat_session_id: "cs-2".into(),
    };
    handle_mid_turn_frame(
        Message::Binary(phone_frame(&key, 3, &cancel2)),
        true,
        &record,
        &write,
    )
    .await;
    assert_eq!(
        *cancelled.lock(),
        vec!["cs-1".to_string(), "cs-2".to_string()]
    );
    match phone_recv(&mut client, &key, 3).await {
        DesktopMessage::ChatDone {
            chat_session_id, ..
        } => assert_eq!(chat_session_id, "cs-2"),
        other => panic!("expected ChatDone, got {other:?}"),
    }

    // The shared crypto state agrees: four inbound Binary frames consumed.
    assert_eq!(write.lock().await.e2e.in_counter, 4);
}

/// Main-loop parity (B-24): a plaintext Text command on an E2E connection is
/// a protocol violation mid-turn too — it must not cancel anything.
#[tokio::test]
async fn mid_turn_plaintext_frame_on_e2e_connection_is_rejected() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay::handle_mid_turn_frame;
    use tokio_tungstenite::tungstenite::Message;

    let key = crate::mobile::relay_crypto::derive_session_key("f1-plaintext-token");
    let (write, mut client) = e2e_ws_pair(key).await;
    let cancelled: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let record = {
        let cancelled = Arc::clone(&cancelled);
        move |sid: &str| cancelled.lock().push(sid.to_string())
    };

    let cancel = MobileMessage::CancelChatTurn {
        chat_session_id: "cs-1".into(),
    };
    let text = serde_json::to_string(&cancel).unwrap();
    handle_mid_turn_frame(Message::Text(text), true, &record, &write).await;
    assert!(
        cancelled.lock().is_empty(),
        "plaintext on E2E must not be honored"
    );
    match phone_recv(&mut client, &key, 0).await {
        DesktopMessage::ChatError { error, .. } => {
            assert!(error.contains("protocol violation"), "{error}")
        }
        other => panic!("expected protocol-violation ChatError, got {other:?}"),
    }
    // Text frames do not consume an inbound counter slot.
    assert_eq!(write.lock().await.e2e.in_counter, 0);
}

// ---------------------------------------------------------------------------
// F2: session_chat_event listener registered once per process
// ---------------------------------------------------------------------------

/// F2 regression: the guard `start_session_chat_event_listener` consults
/// must hand out the slot exactly once — repeat relay starts are no-ops, so
/// chat events are forwarded to the phone once, not N times.
#[test]
fn session_chat_event_listener_slot_is_claimed_exactly_once() {
    use crate::mobile::relay_owner::claim_listener_slot;
    use std::sync::atomic::{AtomicBool, Ordering};

    let flag = AtomicBool::new(false);
    assert!(
        claim_listener_slot(&flag),
        "first relay start registers the listener"
    );
    assert!(
        !claim_listener_slot(&flag),
        "second relay start must NOT register another"
    );
    assert!(!claim_listener_slot(&flag), "nor any later one");
    assert!(flag.load(Ordering::SeqCst));
}

// ---------------------------------------------------------------------------
// F3: GetTranscript "unchanged" dedup needs a stable hash
// ---------------------------------------------------------------------------

/// F3 regression: two polls of a byte-identical screen must hash equal so the
/// M11 `unchanged` marker can fire. The old code built a fresh `RandomState`
/// per poll, so the same screen never matched its previous digest.
#[test]
fn transcript_hash_is_stable_across_polls() {
    use crate::mobile::relay::transcript_hash;

    let screen = "\x1b[2J\x1b[H$ cargo test\r\nrunning 12 tests ✓";
    let first = transcript_hash(screen);
    let second = transcript_hash(screen);
    assert_eq!(first, second, "same screen must dedup as unchanged");

    // Mirrors the per-connection map logic in handle_connection.
    let mut last: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    let unchanged_first = last.get("s1") == Some(&first);
    assert!(!unchanged_first);
    last.insert("s1".into(), first);
    let unchanged_second = last.get("s1") == Some(&second);
    assert!(
        unchanged_second,
        "second poll of a static screen must report unchanged"
    );

    assert_ne!(transcript_hash("different screen"), first);
}

// (The legacy plaintext-token pairing tests were removed with the mode
// itself — pairing now requires the E2E proof exclusively; see
// relay_requests::handle_pair.)


// M29 regression: dropping the guard removes the temp chat session and its
// message rows (FK cascade), as happens on a failed ChatTurn.
#[test]
fn temp_chat_session_cleanup_deletes_session_and_messages() {
    let conn = db::mem();
    let cs = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
    db::add_chat_message(
        &conn,
        db::NewChatMessage {
            chat_session_id: &cs.id,
            role: "user",
            content: "hi",
            ..Default::default()
        },
    )
    .unwrap();
    let db = Arc::new(Mutex::new(conn));

    {
        let _guard = TempChatSessionCleanup::new(Arc::clone(&db), cs.id.clone());
    }

    let conn = db.lock();
    let sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chat_sessions WHERE id = ?1",
            rusqlite::params![&cs.id],
            |r| r.get(0),
        )
        .unwrap();
    let messages: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chat_messages WHERE chat_session_id = ?1",
            rusqlite::params![&cs.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sessions, 0);
    assert_eq!(messages, 0);
}

// ---------------------------------------------------------------------------
// Pairing handshake: challenge-bound proofs (anti-replay, 2026-10-01)
// ---------------------------------------------------------------------------

/// A loopback WebSocket pair for pairing tests: the server's sink is wrapped
/// as `SharedWsWrite` (E2E disabled — pre-pair) and the server's READ half is
/// returned for `pair_handshake`; the client half is the "phone".
async fn pairing_ws_pair() -> (
    crate::mobile::relay_ws::SharedWsWrite,
    futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>>,
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) {
    use futures_util::StreamExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(stream).await.unwrap()
    });
    let (client, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
        .await
        .unwrap();
    let server = server.await.unwrap();
    let (sink, read) = server.split();
    let write: crate::mobile::relay_ws::SharedWsWrite = Arc::new(tokio::sync::Mutex::new(
        crate::mobile::relay_ws::SinkState {
            sink,
            e2e: crate::mobile::relay_ws::RelayE2E::default(),
        },
    ));
    (write, read, client)
}

/// Phone-side: read the next plaintext Text frame (pre-pair) and parse it.
async fn phone_recv_text(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> crate::mobile::protocol::DesktopMessage {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
        .await
        .expect("desktop frame timed out")
        .expect("socket closed")
        .expect("ws read error");
    let Message::Text(t) = frame else {
        panic!("pre-pair desktop frames must be Text, got {frame:?}");
    };
    serde_json::from_str(t.as_str()).expect("desktop frame must parse")
}

/// Phone-side: send one plaintext Text frame.
async fn phone_send_text(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    msg: &crate::mobile::protocol::MobileMessage,
) {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    client
        .send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

/// Phone-side: send a RAW text frame (for replaying a captured handshake).
async fn phone_send_raw(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    text: String,
) {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    client.send(Message::text(text)).await.unwrap();
}

fn b64url_decode(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).unwrap()
}

/// Live v2 handshake proving BOTH directions encrypt: full challenge →
/// nonce-bound proof → PairOk, then an encrypted phone frame the server
/// receives as Binary and an encrypted desktop frame the phone decrypts
/// with the key it derived from the PairOk salt.
#[tokio::test]
async fn challenge_handshake_both_directions_encrypted() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay_crypto;
    use crate::mobile::relay_requests::pair_handshake;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let token = "pair-e2e-token-000000000000000000000000";
    let (write, mut server_read, client) = pairing_ws_pair().await;

    let phone = tokio::spawn(async move {
        let mut client = client;
        let challenge = match phone_recv_text(&mut client).await {
            DesktopMessage::PairChallenge { nonce } => b64url_decode(&nonce),
            other => panic!("expected PairChallenge, got {other:?}"),
        };
        let proof = relay_crypto::compute_pair_proof_with_nonce(token, &challenge);
        phone_send_text(
            &mut client,
            &MobileMessage::Pair {
                token: None,
                proof: Some(proof),
                v2: Some(true),
            },
        )
        .await;
        let key = match phone_recv_text(&mut client).await {
            DesktopMessage::PairOk { salt } => {
                relay_crypto::derive_session_key_with_salt(token, &b64url_decode(&salt))
            }
            other => panic!("expected PairOk, got {other:?}"),
        };
        // Phone → desktop encrypted frame at counter 0.
        client
            .send(Message::Binary(relay_crypto::encrypt(
                &key,
                0,
                &serde_json::to_vec(&MobileMessage::ListSessions).unwrap(),
            )))
            .await
            .unwrap();
        // Desktop → phone encrypted frame at counter 0.
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .unwrap()
            .expect("socket closed")
            .expect("ws read error");
        let Message::Binary(bytes) = frame else {
            panic!("post-pair desktop frames must be Binary");
        };
        let plain = relay_crypto::decrypt(&key, 0, &bytes).expect("desktop frame decrypts");
        let msg: DesktopMessage = serde_json::from_slice(&plain).unwrap();
        assert!(matches!(msg, DesktopMessage::DesktopStatus { connected: true }));
    });

    let ok = pair_handshake(token, false, &write, &mut server_read)
        .await
        .expect("v2 handshake must succeed");
    assert!(ok);

    // Desktop is keyed: an API-level send must leave as an encrypted Binary
    // frame, and the phone's ListSessions must arrive as Binary on the
    // server read half.
    crate::mobile::relay::send_msg(&write, &DesktopMessage::DesktopStatus { connected: true })
        .await
        .unwrap();
    let next = tokio::time::timeout(std::time::Duration::from_secs(5), server_read.next())
        .await
        .unwrap()
        .expect("socket closed")
        .expect("ws read error");
    assert!(
        matches!(next, Message::Binary(_)),
        "phone post-pair frames must be Binary"
    );
    phone.await.unwrap();
}

/// Replay: the exact Pair frame captured on connection A must be rejected on
/// connection B (fresh challenge → the bound proof no longer verifies).
#[tokio::test]
async fn captured_pair_frame_cannot_be_replayed_on_a_new_connection() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay_crypto;
    use crate::mobile::relay_requests::pair_handshake;

    let token = "pair-replay-token-0000000000000000000000";

    // Connection A: complete a v2 handshake, capturing the exact Pair text.
    let (write_a, mut read_a, client_a) = pairing_ws_pair().await;
    let capture = tokio::spawn(async move {
        let mut client = client_a;
        let challenge = match phone_recv_text(&mut client).await {
            DesktopMessage::PairChallenge { nonce } => b64url_decode(&nonce),
            other => panic!("expected PairChallenge, got {other:?}"),
        };
        let proof = relay_crypto::compute_pair_proof_with_nonce(token, &challenge);
        let pair = MobileMessage::Pair {
            token: None,
            proof: Some(proof),
            v2: Some(true),
        };
        let text = serde_json::to_string(&pair).unwrap();
        phone_send_raw(&mut client, text.clone()).await;
        assert!(matches!(
            phone_recv_text(&mut client).await,
            DesktopMessage::PairOk { .. }
        ));
        text
    });
    pair_handshake(token, false, &write_a, &mut read_a)
        .await
        .expect("connection A must pair");
    let captured = capture.await.unwrap();

    // Connection B: a fresh challenge is sent; the attacker replays the
    // captured Pair verbatim and must be rejected.
    let (write_b, mut read_b, client_b) = pairing_ws_pair().await;
    let replay = tokio::spawn(async move {
        let mut client = client_b;
        // The attacker ignores the challenge entirely.
        assert!(matches!(
            phone_recv_text(&mut client).await,
            DesktopMessage::PairChallenge { .. }
        ));
        phone_send_raw(&mut client, captured).await;
        phone_recv_text(&mut client).await
    });
    let result = pair_handshake(token, false, &write_b, &mut read_b).await;
    assert!(result.is_err(), "replayed Pair frame must not pair");
    let err = replay.await.unwrap();
    assert!(
        matches!(err, DesktopMessage::ChatError { .. }),
        "rejection must send an error frame, got {err:?}"
    );
}

/// A v2 client (claims the flag) can never fall back to the static proof —
/// that would re-open the replay hole to anyone with a captured legacy frame.
#[tokio::test]
async fn v2_client_cannot_fall_back_to_static_proof() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay_crypto;
    use crate::mobile::relay_requests::pair_handshake;

    let token = "pair-v2strict-token-000000000000000000000";
    let (write, mut server_read, client) = pairing_ws_pair().await;
    let phone = tokio::spawn(async move {
        let mut client = client;
        assert!(matches!(
            phone_recv_text(&mut client).await,
            DesktopMessage::PairChallenge { .. }
        ));
        phone_send_text(
            &mut client,
            &MobileMessage::Pair {
                token: None,
                proof: Some(relay_crypto::compute_pair_proof(token)),
                v2: Some(true),
            },
        )
        .await;
        phone_recv_text(&mut client).await
    });
    let result = pair_handshake(token, false, &write, &mut server_read).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("invalid challenge proof"));
    assert!(matches!(
        phone.await.unwrap(),
        DesktopMessage::ChatError { .. }
    ));
}

/// Compat: a pre-v2 client (no `v2` flag) still pairs with the static proof.
#[tokio::test]
async fn legacy_static_proof_still_pairs() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay_crypto;
    use crate::mobile::relay_requests::pair_handshake;

    let token = "pair-legacy-token-00000000000000000000000";
    let (write, mut server_read, client) = pairing_ws_pair().await;
    let phone = tokio::spawn(async move {
        let mut client = client;
        assert!(matches!(
            phone_recv_text(&mut client).await,
            DesktopMessage::PairChallenge { .. }
        ));
        phone_send_text(
            &mut client,
            &MobileMessage::Pair {
                token: None,
                proof: Some(relay_crypto::compute_pair_proof(token)),
                v2: None,
            },
        )
        .await;
        phone_recv_text(&mut client).await
    });
    pair_handshake(token, false, &write, &mut server_read)
        .await
        .expect("legacy static proof must still pair (compat)");
    assert!(matches!(
        phone.await.unwrap(),
        DesktopMessage::PairOk { .. }
    ));
}

/// With `mobile.pairing.require_challenge` set (post-upgrade fleet), the
/// legacy static proof is refused outright.
#[tokio::test]
async fn require_challenge_refuses_legacy_proof() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay_crypto;
    use crate::mobile::relay_requests::pair_handshake;

    let token = "pair-strict-token-00000000000000000000000";
    let (write, mut server_read, client) = pairing_ws_pair().await;
    let phone = tokio::spawn(async move {
        let mut client = client;
        assert!(matches!(
            phone_recv_text(&mut client).await,
            DesktopMessage::PairChallenge { .. }
        ));
        phone_send_text(
            &mut client,
            &MobileMessage::Pair {
                token: None,
                proof: Some(relay_crypto::compute_pair_proof(token)),
                v2: None,
            },
        )
        .await;
        phone_recv_text(&mut client).await
    });
    let result = pair_handshake(token, true, &write, &mut server_read).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("challenge-response"));
    assert!(matches!(
        phone.await.unwrap(),
        DesktopMessage::ChatError { .. }
    ));
}

/// Lockout tracker: N-1 consecutive failures still allow an attempt, the
/// Nth trips a lockout, and a success resets everything.
#[test]
fn pairing_attempt_tracker_locks_after_repeated_failures() {
    use crate::mobile::relay_requests::{
        PairAttemptTracker, PAIR_LOCKOUT, PAIR_MAX_CONSECUTIVE_FAILURES,
    };

    let mut t = PairAttemptTracker::new();
    for _ in 0..PAIR_MAX_CONSECUTIVE_FAILURES - 1 {
        assert!(t.check().is_ok());
        t.note_failure();
    }
    assert!(t.check().is_ok(), "below the threshold there is no lockout");
    t.note_failure();
    let remaining = t.check().expect_err("threshold reached must lock out");
    assert!(remaining <= PAIR_LOCKOUT);
    t.note_success();
    assert!(t.check().is_ok());
}

/// Wrong token: the challenge proof verifies against the EXPECTED token, so
/// an attacker with a different token fails even with the fresh challenge.
#[tokio::test]
async fn challenge_proof_with_wrong_token_is_rejected() {
    use crate::mobile::protocol::{DesktopMessage, MobileMessage};
    use crate::mobile::relay_crypto;
    use crate::mobile::relay_requests::pair_handshake;

    let token = "pair-correct-token-0000000000000000000000";
    let (write, mut server_read, client) = pairing_ws_pair().await;
    let phone = tokio::spawn(async move {
        let mut client = client;
        let challenge = match phone_recv_text(&mut client).await {
            DesktopMessage::PairChallenge { nonce } => b64url_decode(&nonce),
            other => panic!("expected PairChallenge, got {other:?}"),
        };
        // The attacker proves a DIFFERENT token.
        let proof = relay_crypto::compute_pair_proof_with_nonce("attacker-token", &challenge);
        phone_send_text(
            &mut client,
            &MobileMessage::Pair {
                token: None,
                proof: Some(proof),
                v2: Some(true),
            },
        )
        .await;
        phone_recv_text(&mut client).await
    });
    let result = pair_handshake(token, false, &write, &mut server_read).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("invalid challenge proof"));
    assert!(matches!(
        phone.await.unwrap(),
        DesktopMessage::ChatError { .. }
    ));
}
