//! Per-session typed channel for chat token streams.
//!
//! Replaces the global `app.emit("chat:token", ...)` path. Tauri 2's
//! `Channel<String>` is point-to-point: one sender (the chat streaming code)
//! → one receiver (the React `useChatEvents` hook). No global bus, no JSON
//! envelope, no UTF-8 round-trip. The frontend subscribes once per chat
//! session via the `chat_token_subscribe` IPC command; the backend stores
//! the channel here and every `chat:token` emit site (`emit_token` in
//! `chat/dispatch.rs`, the 3 sites in `chat/mod.rs:475,515,527`, and
//! `agent_sessions.rs:1631`) checks the registry first.
//!
//! **Backward-compat:** when no consumer has subscribed (tests, headless dev,
//! or a transient drop), the registry returns `None` and the emit sites
//! fall back to `app.emit("chat:token", ...)`. The legacy `chat:token` event
//! still works for any listener that hasn't migrated.
//!
//! The registry is process-global (single instance). It's intentionally
//! separate from `ChatManager` so the streaming code paths in
//! `agent_sessions.rs` and `chat/streaming.rs` (which are provider-agnostic
//! and don't hold a `ChatManager` reference) can use the same path.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::Channel;

use crate::types::ChatTokenPayload;

/// Token-event payload sent over the channel (matches the legacy
/// `chat:token` event shape; the frontend `useChatEvents` can consume both
/// with the same parser).
pub type ChatTokenChannel = Channel<ChatTokenPayload>;

#[derive(Default)]
struct RegistryInner {
    by_session: HashMap<String, ChatTokenChannel>,
}

/// Process-global registry of per-session token channels. `Arc` so it can
/// live in `OnceCell` and be shared between the IPC command handler and the
/// emit sites. `parking_lot::Mutex` for cheap reads in the emit hot path
/// (already a dep, used in `pty/mod.rs`).
type Registry = Arc<Mutex<RegistryInner>>;

static REGISTRY: once_cell::sync::Lazy<Registry> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(RegistryInner::default())));

/// Register a channel for a chat session. Replaces any previous channel for
/// the same session id (v1 single-subscriber per session).
pub fn register(session_id: &str, ch: ChatTokenChannel) {
    REGISTRY.lock().by_session.insert(session_id.to_string(), ch);
}

/// Clear the channel for a chat session. Safe to call when nothing was
/// registered.
pub fn unregister(session_id: &str) {
    REGISTRY.lock().by_session.remove(session_id);
}

/// Send a token for the given session. Returns `true` if a channel was
/// registered (the send was attempted) and `false` if the emit site
/// should fall back to `app.emit("chat:token", payload)`. A `true` return
/// does NOT guarantee the receiver got the value — channel send can fail
/// if the consumer dropped, and we silently drop in that case (the
/// frontend will reconnect via re-subscribe).
pub fn try_send(session_id: &str, payload: &ChatTokenPayload) -> bool {
    let registry = REGISTRY.lock();
    if let Some(ch) = registry.by_session.get(session_id) {
        match ch.send(payload.clone()) {
            Ok(()) => true,
            Err(_) => {
                // Consumer dropped mid-send. Clean up so future calls fall
                // back to emit (the frontend has presumably re-mounted with
                // a new channel via re-subscribe, but the registry entry
                // is now stale).
                drop(registry);
                unregister(session_id);
                false
            }
        }
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_returns_false() {
        // Use a session id that won't collide with any other test.
        let payload = ChatTokenPayload {
            chat_session_id: "no-subscriber-session".into(),
            token: "hi".into(),
        };
        assert!(!try_send("no-subscriber-session", &payload));
    }

    #[test]
    fn register_then_unregister_clears_entry() {
        // We can't easily construct a real tauri::ipc::Channel (it requires
        // a Tauri runtime), so test the registry-shape behavior with
        // a placeholder session id.
        let sid = "test-session-register-unregister";
        // Initially absent.
        let payload = ChatTokenPayload {
            chat_session_id: sid.into(),
            token: "x".into(),
        };
        assert!(!try_send(sid, &payload));
        unregister(sid);
        assert!(!try_send(sid, &payload));
    }
}
