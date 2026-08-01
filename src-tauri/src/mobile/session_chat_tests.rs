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
    let cs = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5").unwrap();
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