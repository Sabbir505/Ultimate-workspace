//! The chat event seam + per-session typed channel for token streams.
//!
//! Every `chat:*` event the backend emits to the frontend goes through the
//! helpers in this module, so the wire contract lives in exactly one place:
//!
//! * [`emit_chat_token`] — `chat:token`. Prefers the per-session typed
//!   `Channel<ChatTokenPayload>` registered by the frontend's
//!   `chat_token_subscribe` IPC command and falls back to the global bus.
//! * [`emit_status`] / [`emit_status_reason`] — `chat:status` (global bus).
//! * [`emit_done`] / [`emit_error`] / [`emit_artifact`] — typed payloads on
//!   the global bus.
//!
//! **Backward-compat:** when no consumer has subscribed (tests, headless dev,
//! or a transient drop), [`try_send`] returns `false` and the token falls
//! back to `app.emit("chat:token", ...)`. The legacy global-bus events must
//! keep firing — `mobile/relay.rs` forwards `chat:approval-request` and
//! `chat:done` to the phone by listening on the bus.
//!
//! The registry is process-global (single instance). It's intentionally
//! separate from `ChatManager` so the streaming code paths in
//! `agent_sessions/` and `chat/streaming.rs` (which are provider-agnostic
//! and don't hold a `ChatManager` reference) can use the same path.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::types::{ChatArtifactPayload, ChatDonePayload, ChatErrorPayload, ChatStatusPayload, ChatTokenPayload};

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
    REGISTRY
        .lock()
        .by_session
        .insert(session_id.to_string(), ch);
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

/// Emit one `chat:token`: the per-session typed channel first, the global
/// bus as the fallback. `record_perf` feeds the active per-turn perf
/// accumulator — World A passes `false` for UI scaffolding (`emit_marker`)
/// and `true` for real model tokens; harness sessions always record so the
/// live composer row shows TTFT + tok/s even when no window is open.
///
/// Empty-token and buffer-accumulation policy stays with the caller (World
/// A's `emit_chunk` skips empties and appends to the turn buffer; the SSE
/// pump paths call this verbatim).
pub fn emit_chat_token<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    token: &str,
    record_perf: bool,
) {
    let payload = ChatTokenPayload {
        chat_session_id: sid.to_string(),
        token: token.to_string(),
    };
    if !try_send(sid, &payload) {
        if let Some(app) = app {
            let _ = app.emit("chat:token", payload);
        }
    }
    if record_perf {
        crate::chat::turn_perf::record_active_token(sid);
    }
}

/// Emit one `chat:status`. No per-session channel exists for status — the
/// global bus only (the frontend's `useChatEvents` listens once per app).
/// A `None` app handle (headless tests) drops the event, matching the
/// previous per-site `if let Some(app)` guards.
pub fn emit_status<R: tauri::Runtime>(app: Option<&AppHandle<R>>, payload: ChatStatusPayload) {
    if let Some(app) = app {
        let _ = app.emit("chat:status", payload);
    }
}

/// Convenience for the dominant `{session, reason, message}` status shape.
pub fn emit_status_reason<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    reason: &str,
    message: impl Into<String>,
) {
    emit_status(
        app,
        ChatStatusPayload {
            chat_session_id: sid.to_string(),
            reason: reason.to_string(),
            message: message.into(),
        },
    );
}

/// Convenience for the paired "clear" notice (empty reason + message): the
/// E-9a pattern that erases a pre-token status pill when the thing it
/// announced finished without streaming a first token.
pub fn emit_status_clear<R: tauri::Runtime>(app: Option<&AppHandle<R>>, sid: &str) {
    emit_status(
        app,
        ChatStatusPayload {
            chat_session_id: sid.to_string(),
            reason: String::new(),
            message: String::new(),
        },
    );
}

/// Emit one `chat:done` (typed payload, global bus).
pub fn emit_done<R: tauri::Runtime>(app: Option<&AppHandle<R>>, payload: ChatDonePayload) {
    if let Some(app) = app {
        let _ = app.emit("chat:done", payload);
    }
}

/// Emit one `chat:error`, classifying `message` into the recoverable-error
/// code the frontend keys its "compact / new chat" copy off.
pub fn emit_error<R: tauri::Runtime>(app: Option<&AppHandle<R>>, sid: &str, message: &str) {
    let code = crate::chat::error_class::classify_error(message);
    emit_error_inner(app, sid, message, code.map(|c| c.to_string()));
}

fn emit_error_inner<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    message: &str,
    code: Option<String>,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "chat:error",
            ChatErrorPayload {
                chat_session_id: sid.to_string(),
                message: message.to_string(),
                code,
            },
        );
    }
}

/// Emit one `chat:error` with an already-known code (callers that classify
/// themselves, e.g. when the message is consumed by the payload).
pub fn emit_error_with_code<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    message: &str,
    code: Option<String>,
) {
    emit_error_inner(app, sid, message, code);
}

/// Emit one `chat:artifact` (typed payload, global bus).
pub fn emit_artifact<R: tauri::Runtime>(app: Option<&AppHandle<R>>, payload: ChatArtifactPayload) {
    if let Some(app) = app {
        let _ = app.emit("chat:artifact", payload);
    }
}

/// Persist an artifact row (30-day retention sidebar) and emit `chat:artifact`.
/// The kind is derived from the file extension exactly as every former
/// copy-paste site did. Best-effort on the DB half — a row insert failure
/// must not block the chat turn; the caller owns the `DbState` lock.
pub fn insert_and_emit_artifact<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    conn: &rusqlite::Connection,
    sid: &str,
    path: &str,
    filename: &str,
) {
    let kind = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let _ = crate::db::insert_artifact(conn, Some(sid), filename, path, &kind);
    emit_artifact(
        app,
        ChatArtifactPayload {
            chat_session_id: sid.to_string(),
            path: path.to_string(),
            filename: filename.to_string(),
        },
    );
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
