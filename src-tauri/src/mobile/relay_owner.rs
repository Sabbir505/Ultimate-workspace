//! Owner map helpers for mobile relay.
//!
//! The owner map tracks which mobile session owns which WebSocket connection,
//! so when the chat pipeline emits Tauri events (token, status, done, error,
//! approval, artifact), the relay can forward them to the right phone.

use super::relay_ws::OwnerMap;
use super::protocol::DesktopMessage;
use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

/// Process-global guard for the `mobile:session_chat_event` listener. Every
/// `start_relay` used to register ANOTHER listener, so after N relay restarts
/// every chat event was forwarded N times and the phone saw every token
/// duplicated. One registration for the process is correct: the OwnerMap is
/// `Arc`-shared across restarts, so the original listener keeps routing to
/// whatever connection currently owns each session.
static SESSION_CHAT_EVENT_LISTENER_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Claim the single listener slot. Returns false when it is already claimed.
pub(crate) fn claim_listener_slot(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

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
/// chat_session_id -> owner_session_id for relay-run turns. The owner's
/// WebSocket channel is looked up from the owner map at forward time; this
/// only resolves which phone a backend `chat:*` event belongs to.
static CHAT_OWNERS: once_cell::sync::Lazy<parking_lot::Mutex<std::collections::HashMap<String, Vec<String>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(std::collections::HashMap::new()));

/// Remember which phone started the turn on `chat_session_id`.
pub fn record_chat_owner(chat_session_id: &str, owner_session_id: &str) {
    let mut map = CHAT_OWNERS.lock();
    let owners = map.entry(chat_session_id.to_string()).or_default();
    if !owners.iter().any(|o| o == owner_session_id) {
        owners.push(owner_session_id.to_string());
    }
}

/// Remember that a phone is WATCHING `chat_session_id` (it just opened the
/// chat). Desktop-started turns in a watched chat stream to the phone live —
/// without this the phone only saw them after a manual refresh, because the
/// desktop frontend's re-broadcast needs an owner mapping that only a
/// phone-sent turn ever created (and it dies with the desktop store).
pub fn watch_chat(chat_session_id: &str, owner_session_id: &str) {
    record_chat_owner(chat_session_id, owner_session_id);
}

pub(crate) fn owners_for_chat(chat_session_id: &str) -> Vec<String> {
    CHAT_OWNERS.lock().get(chat_session_id).cloned().unwrap_or_default()
}

fn forward_to_owner(
    owner_map: &OwnerMap,
    chat_session_id: &str,
    build: impl Fn(String) -> super::protocol::DesktopMessage,
) {
    for owner in owners_for_chat(chat_session_id) {
        let sender = { owner_map.lock().get(&owner).cloned() };
        let Some(tx) = sender else { continue };
        let _ = tx.try_send(build(owner));
    }
}

/// TRUE streaming for relay-run (phone-originated) turns.
///
/// The desktop frontend re-broadcasts `chat:*` events as
/// `mobile:session_chat_event` ONLY for the chat it currently has open, so a
/// turn the PHONE started streamed nowhere: not to the phone (it appeared
/// only after a manual refresh) and not live on the desktop either. The
/// backend already emits `chat:token` / `chat:status` / `chat:done` /
/// `chat:error` / `chat:approval_request` / `chat:artifact` for every turn
/// the relay runs — so the relay listens to them itself and ships frames to
/// the owning phone. The frontend path stays for desktop-started turns.
pub fn start_chat_stream_forwarder(app: &AppHandle, owner_map: OwnerMap) {
    use serde_json::Value;
    // Owned clone: the listener closures are 'static and must not capture
    // the borrowed &AppHandle.
    let app_owned = app.clone();

    {
        let owner_map = owner_map.clone();
        let _ = app.listen("chat:token", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let (Some(cid), Some(tok)) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("token").and_then(Value::as_str),
            ) else { return };
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionChatToken {
                    session_id: owner,
                    token: tok.to_string(),
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        let _ = app.listen("chat:status", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let Some(cid) = v.get("chatSessionId").and_then(Value::as_str) else { return };
            let reason = v.get("reason").and_then(Value::as_str).unwrap_or_default().to_string();
            let message = v.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionChatStatus {
                    session_id: owner,
                    reason: reason.clone(),
                    message: message.clone(),
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        let _ = app.listen("chat:done", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let Some(cid) = v.get("chatSessionId").and_then(Value::as_str) else { return };
            let usage = v.get("usage").and_then(|u| {
                Some(super::protocol::MobileChatUsage {
                    input_tokens: u.get("inputTokens").and_then(Value::as_i64).unwrap_or(0),
                    output_tokens: u.get("outputTokens").and_then(Value::as_i64).unwrap_or(0),
                    cost_usd: u.get("costUsd").and_then(Value::as_f64),
                })
            });
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionChatDone {
                    session_id: owner,
                    usage: usage.clone(),
                }
            });
            // A RELAY_ASK question is surfaced right AFTER this event, so
            // dropping the owner mapping here made the question card
            // undeliverable to the phone (forward_to_owner found no owners).
            // Keep the mapping while a card is still waiting for an answer.
            let awaiting_question = app_owned
                .try_state::<crate::agent_sessions::AgentSessionState>()
                .map(|s| s.0.has_pending_ask(cid))
                .unwrap_or(false);
            if !awaiting_question {
                CHAT_OWNERS.lock().remove(cid);
            }

            // Relay-run turns never hit the desktop frontend's
            // after-first-turn title hook, so the chat stayed "Untitled"
            // forever (desktop parity: name it with the same generator).
            let app2 = app_owned.clone();
            let cid2 = cid.to_string();
            tauri::async_runtime::spawn(async move {
                let state = app2.state::<crate::DbState>();
                let untitled = {
                    let conn = state.0.lock();
                    crate::db::get_chat_session(&conn, &cid2)
                        .ok()
                        .flatten()
                        .and_then(|s| s.title)
                        .map(|t| {
                            let t = t.trim();
                            t.is_empty() || t == "Untitled"
                        })
                        .unwrap_or(false)
                };
                if untitled {
                    let _ = crate::chat::commands::generators::generate_chat_title(cid2, state).await;
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        let _ = app.listen("chat:error", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            // ChatErrorPayload serializes camelCase: {chatSessionId, message, code}.
            // The legacy "error" key is kept as a fallback for hand-built payloads.
            let (Some(cid), Some(err)) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("message")
                    .or_else(|| v.get("error"))
                    .and_then(Value::as_str),
            ) else { return };
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionChatError {
                    session_id: owner,
                    error: err.to_string(),
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        let _ = app.listen("chat:approval_request", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let (Some(cid), Some(pending_id), Some(tool)) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("pendingId").and_then(Value::as_str),
                v.get("tool").and_then(Value::as_str),
            ) else { return };
            let summary = v
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("A tool action is waiting for your approval.")
                .to_string();
            let args = v.get("args").cloned().unwrap_or(Value::Null);
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionApprovalRequest {
                    session_id: owner,
                    pending_id: pending_id.to_string(),
                    tool: tool.to_string(),
                    summary: summary.clone(),
                    args: args.clone(),
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        // A harness asking the user a question parks the turn — the phone
        // must show the same card the desktop does, or the turn deadlocks
        // until the user walks to the desktop.
        let _ = app.listen("chat:question-request", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let (Some(cid), Some(pending_id), questions) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("pendingId").and_then(Value::as_str),
                v.get("questions").cloned(),
            ) else { return };
            let questions = questions.unwrap_or(Value::Null);
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionQuestionRequest {
                    session_id: owner,
                    pending_id: pending_id.to_string(),
                    questions: questions.clone(),
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        let _ = app.listen("chat:artifact", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let (Some(cid), Some(path), Some(filename)) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("path").and_then(Value::as_str),
                v.get("filename").and_then(Value::as_str),
            ) else { return };
            let message_id = v.get("messageId").and_then(Value::as_i64);
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionArtifact {
                    session_id: owner,
                    message_id,
                    artifact: super::protocol::ChatArtifactPayload {
                        path: path.to_string(),
                        filename: filename.to_string(),
                        kind: v
                            .get("kind")
                            .and_then(Value::as_str)
                            .map(|k| k.to_string()),
                        inline: None,
                    },
                }
            });
        });
    }
}

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
) -> tokio::sync::mpsc::Receiver<super::protocol::DesktopMessage> {
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
        // The approval was resolved on ANY surface (desktop card, another
        // phone, the mobile resolve path itself) — dismiss matching cards.
        "approval-resolved" => {
            #[derive(Deserialize)]
            struct ResolvedPayload {
                #[serde(default)]
                pendingId: Option<String>,
                #[serde(default)]
                pending_id: Option<String>,
            }
            let p: ResolvedPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid approval-resolved payload: {e}"))?;
            DesktopMessage::SessionApprovalResolved {
                session_id: payload.session_id,
                pending_id: p.pendingId.or(p.pending_id).unwrap_or_default(),
            }
        }
        // Plan-proposal cards (present_plan): the phone gets the same
        // Approve / Revise affordance the desktop card offers.
        "plan-proposal" => {
            #[derive(Deserialize)]
            struct PlanPayload {
                #[serde(default)]
                pendingId: Option<String>,
                #[serde(default)]
                pending_id: Option<String>,
                #[serde(default)]
                title: Option<String>,
                #[serde(default)]
                plan: Option<String>,
            }
            let p: PlanPayload = serde_json::from_value(payload.payload)
                .map_err(|e| format!("invalid plan-proposal payload: {e}"))?;
            DesktopMessage::SessionPlanProposal {
                session_id: payload.session_id,
                pending_id: p.pendingId.or(p.pending_id).unwrap_or_default(),
                title: p.title.unwrap_or_else(|| "Plan proposal".to_string()),
                plan: p.plan.unwrap_or_default(),
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
        .try_send(desktop_msg)
        .map_err(|e| format!("failed to send to owner: {e}"))?;

    Ok(())
}

/// Start listening for Tauri `mobile:session_chat_event` events and forward them
/// to the appropriate WebSocket connection via the owner map. Idempotent: the
/// listener is registered once per process (see the guard above) — repeat calls
/// from relay restarts are no-ops, since the Arc-shared owner map means the
/// original registration already routes to live connections.
pub fn start_session_chat_event_listener(
    app: &tauri::AppHandle,
    owner: OwnerMap,
) -> Result<(), String> {
    if !claim_listener_slot(&SESSION_CHAT_EVENT_LISTENER_REGISTERED) {
        eprintln!("[mobile-relay] session_chat_event listener already registered; skipping");
        return Ok(());
    }
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