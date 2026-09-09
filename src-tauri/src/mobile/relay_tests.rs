use std::sync::Arc;

use parking_lot::Mutex;

use crate::db;
use crate::mobile::relay::{pairing_token_accepted, TempChatSessionCleanup};

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

// L11 regression: an empty pairing token must never authenticate.
#[test]
fn pairing_fails_closed_when_no_token_configured() {
    assert!(!pairing_token_accepted("", ""));
    assert!(!pairing_token_accepted("", "anything"));
}

#[test]
fn pairing_rejects_empty_presented_token() {
    assert!(!pairing_token_accepted("real-token", ""));
}

#[test]
fn pairing_accepts_only_matching_nonempty_tokens() {
    assert!(pairing_token_accepted("real-token", "real-token"));
    assert!(!pairing_token_accepted("real-token", "other-token"));
}

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
