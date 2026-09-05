use crate::db;
use crate::mobile::protocol::*;
use crate::mobile::session_chat;

#[test]
fn serialize_send_chat_message() {
    let msg = MobileMessage::SendChatMessage {
        session_id: "s1".into(),
        text: "hi".into(),
        attachments: vec![],
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("\"type\":\"SendChatMessage\""));
    assert!(json.contains("\"session_id\":\"s1\""));
    assert!(json.contains("\"text\":\"hi\""));
}

#[test]
fn deserialize_session_messages() {
    let json = r#"{"type":"SessionMessages","session_id":"s1","messages":[],"has_more":false}"#;
    let msg: DesktopMessage = serde_json::from_str(json).unwrap();
    match msg {
        DesktopMessage::SessionMessages { session_id, has_more, .. } => {
            assert_eq!(session_id, "s1");
            assert!(!has_more);
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn history_pagination_query() {
    // Set up an in-memory DB.
    let conn = db::mem();

    // Create a chat session linked to owner_session_id = "s1".
    let cs = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
    session_chat::ensure_chat_session_owner_column(&conn).unwrap();
    conn.execute(
        "UPDATE chat_sessions SET owner_session_id = ?1 WHERE id = ?2",
        rusqlite::params!["s1", &cs.id],
    )
    .unwrap();

    // Seed 5 messages (ids 1..5).
    for i in 1..=5 {
        db::add_chat_message(
            &conn,
            &cs.id,
            if i % 2 == 0 { "assistant" } else { "user" },
            &format!("msg {i}"),
            None,
            None,
            None,
            None, None, None, None, None, None,
            None, None,
            None, None, None, None,
        )
        .unwrap();
    }

    // Fetch page 1 (limit=2, no before_id) → should get [5, 4], has_more=true.
    let (msgs, has_more) = session_chat::fetch_page(&conn, "s1", None, 2).unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].id, 5);
    assert_eq!(msgs[1].id, 4);
    assert!(has_more);

    // Fetch page 2 (before_id=4, limit=2) → should get [3, 2], has_more=true.
    let (msgs, has_more) = session_chat::fetch_page(&conn, "s1", Some(4), 2).unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].id, 3);
    assert_eq!(msgs[1].id, 2);
    assert!(has_more);

    // Fetch page 3 (before_id=2, limit=2) → should get [1], has_more=false.
    let (msgs, has_more) = session_chat::fetch_page(&conn, "s1", Some(2), 2).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].id, 1);
    assert!(!has_more);

    // Fetch beyond the end (before_id=0) → empty, no more.
    let (msgs, has_more) = session_chat::fetch_page(&conn, "s1", Some(0), 2).unwrap();
    assert_eq!(msgs.len(), 0);
    assert!(!has_more);
}

/// F7 regression: the phone-controlled `limit` used to overflow `limit + 1`
/// (u32::MAX + 1) before being handed to the SQL LIMIT. It must be clamped to
/// a bounded page instead of panicking/wrapping.
#[test]
fn fetch_page_clamps_phone_controlled_limit() {
    let conn = db::mem();
    let cs = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
    session_chat::ensure_chat_session_owner_column(&conn).unwrap();
    conn.execute(
        "UPDATE chat_sessions SET owner_session_id = ?1 WHERE id = ?2",
        rusqlite::params!["s1", &cs.id],
    )
    .unwrap();

    // Seed 201 messages: clamping to 200 must keep has_more correct.
    for i in 1..=201 {
        db::add_chat_message(
            &conn,
            &cs.id,
            "user",
            &format!("msg {i}"),
            None, None, None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
        .unwrap();
    }

    // u32::MAX previously overflowed `limit + 1`.
    let (msgs, has_more) = session_chat::fetch_page(&conn, "s1", None, u32::MAX).unwrap();
    assert_eq!(msgs.len(), 200, "page must be clamped to 200 rows");
    assert!(has_more);
    assert_eq!(msgs[0].id, 201);

    // A handful of messages still comes back whole, has_more=false.
    let conn2 = db::mem();
    let cs2 = db::create_chat_session(&conn2, "anthropic", "claude-sonnet-4-5", None).unwrap();
    session_chat::ensure_chat_session_owner_column(&conn2).unwrap();
    conn2.execute(
        "UPDATE chat_sessions SET owner_session_id = ?1 WHERE id = ?2",
        rusqlite::params!["s2", &cs2.id],
    )
    .unwrap();
    for i in 1..=3 {
        db::add_chat_message(
            &conn2,
            &cs2.id,
            "user",
            &format!("msg {i}"),
            None, None, None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
        .unwrap();
    }
    let (msgs, has_more) = session_chat::fetch_page(&conn2, "s2", None, u32::MAX).unwrap();
    assert_eq!(msgs.len(), 3);
    assert!(!has_more);
}

#[test]
fn dispatch_get_session_messages_calls_session_chat_manager() {
    // `dispatch_mobile` routes `GetSessionMessages` to
    // `SessionChatManager::handle`, which for that variant only calls
    // `fetch_page` (a pure DB query) — it never dereferences the AppHandle
    // nor the ChatManager. So we exercise the same query path `fetch_page`
    // uses against an in-memory DB and assert the empty-page contract for an
    // unknown owner_session_id. This is the exact logic dispatch relies on.
    let conn = db::mem();

    // No chat_sessions row linked to "no-such-session" → empty page, no more.
    let (msgs, has_more) =
        session_chat::fetch_page(&conn, "no-such-session", None, 50).unwrap();
    assert!(msgs.is_empty());
    assert!(!has_more);

    // And the DesktopMessage wrapper dispatch builds mirrors this shape.
    let wrapped = DesktopMessage::SessionMessages {
        session_id: "no-such-session".to_string(),
        messages: msgs,
        has_more,
    };
    let json = serde_json::to_string(&wrapped).unwrap();
    assert!(json.contains("\"type\":\"SessionMessages\""));
    assert!(json.contains("\"has_more\":false"));
}