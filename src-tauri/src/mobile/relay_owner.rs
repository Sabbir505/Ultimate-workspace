//! Owner map helpers for mobile relay.
//!
//! The owner map tracks which mobile session owns which WebSocket connection,
//! so when the chat pipeline emits Tauri events (token, status, done, error,
//! approval, artifact), the relay can forward them to the right phone.

use super::relay_ws::OwnerMap;
use super::protocol::DesktopMessage;
use serde::Deserialize;
use tauri::Listener;

/// Payload structure for the `mobile:session_chat_event` Tauri event emitted by
/// the React side. The relay listens for these and forwards them to the
/// appropriate WebSocket connection.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionChatEventPayload {
    pub session_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
}

/// Payload structure for the `mobile:session_chat_owner` Tauri event emitted
/// by the Rust side. The React side listens and stores the mapping.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionChatOwnerPayload {
    pub chat_session_id: String,
    pub owner_session_id: String,
}

/// Register a mobile session in the owner map.
pub fn register_owner(owner: &OwnerMap, session_id: String, sender: super::relay_ws::WsSender) {
    owner.lock().insert(session_id, sender);
}

/// Create a new channel for a connection, register the sender in the owner map,
/// and return the receiver so the caller can spawn `pump_to_ws`.
#[allow(dead_code)] // Reserved for the per-connection pump wiring (Task 6).
pub fn register_connection(
    owner: &OwnerMap,
    session_id: String,
) -> tokio::sync::mpsc::UnboundedReceiver<super::protocol::DesktopMessage> {
    let (tx, rx) = super::relay_ws::make_channel();
    register_owner(owner, session_id, tx);
    rx
}

/// Remove a mobile session from the owner map.
#[allow(dead_code)] // Called on disconnect in Task 6.
pub fn unregister_owner(owner: &OwnerMap, session_id: &str) {
    owner.lock().remove(session_id);
}

/// Forward a Tauri `mobile:session_chat_event` payload to the owner of the session.
/// Maps the `kind` field to the corresponding `DesktopMessage` variant.
pub fn forward_session_chat_event(
    owner: &OwnerMap,
    payload: SessionChatEventPayload,
) -> Result<(), String> {
    let sender = {
        let map = owner.lock();
        map.get(&payload.session_id).cloned()
    };

    let sender = match sender {
        Some(s) => s,
        None => {
            // No owner for this session — silently drop.
            // This can happen if the phone disconnected between event emission and delivery.
            return Ok(());
        }
    };

    let desktop_msg = match payload.kind.as_str() {
        "token" => {
            #[derive(Deserialize)]
            struct TokenPayload {
                token: String,
            }
            let p: TokenPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid token payload: {e}"))?;
            DesktopMessage::SessionChatToken {
                session_id: payload.session_id,
                token: p.token,
            }
        }
        "status" => {
            #[derive(Deserialize)]
            struct StatusPayload {
                reason: String,
                message: String,
            }
            let p: StatusPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid status payload: {e}"))?;
            DesktopMessage::SessionChatStatus {
                session_id: payload.session_id,
                reason: p.reason,
                message: p.message,
            }
        }
        "done" => {
            #[derive(Deserialize)]
            struct DonePayload {
                usage: Option<super::protocol::MobileChatUsage>,
            }
            let p: DonePayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid done payload: {e}"))?;
            DesktopMessage::SessionChatDone {
                session_id: payload.session_id,
                usage: p.usage,
            }
        }
        "error" => {
            #[derive(Deserialize)]
            struct ErrorPayload {
                error: String,
            }
            let p: ErrorPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid error payload: {e}"))?;
            DesktopMessage::SessionChatError {
                session_id: payload.session_id,
                error: p.error,
            }
        }
        "approval" => {
            #[derive(Deserialize)]
            struct ApprovalPayload {
                pending_id: String,
                tool: String,
                summary: String,
                args: serde_json::Value,
            }
            let p: ApprovalPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid approval payload: {e}"))?;
            DesktopMessage::SessionApprovalRequest {
                session_id: payload.session_id,
                pending_id: p.pending_id,
                tool: p.tool,
                summary: p.summary,
                args: p.args,
            }
        }
        "artifact" => {
            #[derive(Deserialize)]
            struct ArtifactPayload {
                message_id: Option<i64>,
                artifact: super::protocol::ChatArtifactPayload,
            }
            let p: ArtifactPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid artifact payload: {e}"))?;
            DesktopMessage::SessionArtifact {
                session_id: payload.session_id,
                message_id: p.message_id,
                artifact: p.artifact,
            }
        }
        other => {
            return Err(format!("unknown session chat event kind: {other}"));
        }
    };

    sender
        .send(desktop_msg)
        .map_err(|e| format!("failed to send to owner: {e}"))?;

    Ok(())
}

/// Start listening for Tauri `mobile:session_chat_event` events and forward them
/// to the appropriate WebSocket connection via the owner map.
/// Returns a handle that can be used to stop the listener (currently a no-op
/// since the listener runs for the lifetime of the relay).
pub fn start_session_chat_event_listener(
    app: &tauri::AppHandle,
    owner: OwnerMap,
) -> Result<(), String> {
    let _app_clone = app.clone();
    app.listen("mobile:session_chat_event", move |event| {
        let payload_str = event.payload();
        let payload: SessionChatEventPayload = match serde_json::from_str(payload_str) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[mobile-relay] malformed session_chat_event: {e}");
                return;
            }
        };

        if let Err(e) = forward_session_chat_event(&owner, payload) {
            eprintln!("[mobile-relay] failed to forward session_chat_event: {e}");
        }
    });

    eprintln!("[mobile-relay] session_chat_event listener registered");
    Ok(())
}