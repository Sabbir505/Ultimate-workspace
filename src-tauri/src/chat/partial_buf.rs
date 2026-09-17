//! Per-session accumulation of the live built-in-chat stream, so an app quit
//! mid-stream can persist the partial text the user watched.
//!
//! The audit found the one drop window in the streaming state machine: cancel
//! and error paths persist the partial (frontend `persist_partial_chat_message`),
//! but `cancel_all` on app exit aborted every turn task and DISCARDED the
//! backend's accumulated buffer — the streamed text vanished. This registry
//! keeps an append-only copy (O(token) appends; front-trimmed at a cap) at the
//! two World-A emit sites, cleared when the final row is persisted (turn OK)
//! or handed to the persist command (frontend cancel/error). The exit handler
//! in lib.rs drains whatever survives and writes the rows.
//!
//! Harness sessions are deliberately NOT recorded here: their CLI owns the
//! transcript and `finish_turn` persists the assistant row unconditionally.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// Front-trim cap (chars) — the tail is what renders; persistence just needs
/// a bounded copy of what was streamed.
const MAX_PARTIAL_CHARS: usize = 400_000;

static PARTIALS: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Append one streamed chunk to the session's buffer. Cheap: a push_str per
/// token, no full-buffer copies.
pub fn record(chat_session_id: &str, token: &str) {
    if token.is_empty() {
        return;
    }
    let mut map = PARTIALS.lock();
    let entry = map.entry(chat_session_id.to_string()).or_default();
    entry.push_str(token);
    if entry.len() > MAX_PARTIAL_CHARS {
        let skip = entry.len() - MAX_PARTIAL_CHARS;
        // Trim on a char boundary (tokens can split multi-byte chars).
        let boundary = (skip..entry.len())
            .find(|&i| entry.is_char_boundary(i))
            .unwrap_or(entry.len());
        entry.drain(..boundary);
    }
}

/// Remove and return the session's buffer — called when the text is persisted
/// somewhere (final assistant row, persist command, or app-exit drain), so a
/// later quit can never double-persist the same turn.
pub fn take(chat_session_id: &str) -> Option<String> {
    PARTIALS.lock().remove(chat_session_id).map(close_dangling_tool)
}

/// Drain everything (app exit). Returns (session_id, partial_text) pairs.
pub fn drain_all() -> Vec<(String, String)> {
    PARTIALS
        .lock()
        .drain()
        .map(|(sid, text)| (sid, close_dangling_tool(text)))
        .collect()
}

/// Close an unterminated `<tool>` block before the partial is persisted. The
/// task fan-out opens every Task marker BEFORE the tools run (streaming.rs);
/// a cancel/abort between that pre-pass and the closing emit used to leave a
/// dangling marker in the persisted partial, which the segment parser renders
/// as an eternally "working" step after reload (audit M-6).
fn close_dangling_tool(mut text: String) -> String {
    let opens = text.matches("<tool>").count();
    let closes = text.matches("</tool>").count();
    if opens > closes {
        for _ in 0..(opens - closes) {
            text.push_str("</tool>");
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_take_roundtrip_and_cap() {
        let sid = "partial-buf-test-session";
        record(sid, "hello ");
        record(sid, "world");
        assert_eq!(take(sid).as_deref(), Some("hello world"));
        assert!(take(sid).is_none()); // cleared after take

        // Cap: pushing 10× the cap keeps the buffer bounded at ~cap chars.
        let chunk = "x".repeat(50_000);
        for _ in 0..10 {
            record(sid, &chunk);
        }
        let buf = take(sid).unwrap();
        assert!(buf.len() <= MAX_PARTIAL_CHARS + 50_000);
        assert!(buf.chars().all(|c| c == 'x'));
    }
}
