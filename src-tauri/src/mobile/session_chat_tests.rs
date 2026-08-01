use crate::mobile::protocol::*;

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