use std::sync::Arc;

use parking_lot::Mutex;

use crate::db;
use crate::mobile::relay::{pairing_token_accepted, TempChatSessionCleanup};

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
    let cs = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5").unwrap();
    db::add_chat_message(&conn, &cs.id, "user", "hi", None, None, None, None, None, None, None, None, None).unwrap();
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
