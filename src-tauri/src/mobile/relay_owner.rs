//! Owner map helpers for mobile relay.
//!
//! The owner map tracks which mobile session owns which WebSocket connection,
//! so when the chat pipeline emits Tauri events (token, status, done, error,
//! approval, artifact), the relay can forward them to the right phone.

use super::relay_ws::OwnerMap;
use super::protocol::DesktopMessage;
use tauri::{AppHandle, Listener, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

/// Process-global guard for the `chat:*` → phone stream forwarder. Every
/// `start_relay` used to register ANOTHER set of listeners, so after N relay
/// restarts every chat event was forwarded N times and the phone saw every
/// streamed token duplicated N times. One registration for the process is
/// correct: the OwnerMap is `Arc`-shared across restarts, so the original
/// listeners keep routing to whatever connection currently owns each session.
static CHAT_STREAM_FORWARDER_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Claim the single listener slot. Returns false when it is already claimed.
pub(crate) fn claim_listener_slot(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// One chat's owner mapping: which phone connection ids receive this chat's
/// `chat:*` events, and whether the phone is WATCHING the chat (it opened it)
/// or only started a turn in it. Watch entries survive turn boundaries —
/// desktop-started turns in an open chat must keep streaming — and die with
/// the phone's connection (OwnerCleanup); turn-scoped entries are removed by
/// the chat:done / chat:error forwarders.
#[derive(Default)]
struct ChatOwnerEntry {
    channels: Vec<String>,
    watch: bool,
}

/// chat_session_id -> owner mapping for relay-run turns. The owner's
/// WebSocket channel is looked up from the owner map at forward time; this
/// only resolves which phone a backend `chat:*` event belongs to.
static CHAT_OWNERS: once_cell::sync::Lazy<parking_lot::Mutex<std::collections::HashMap<String, ChatOwnerEntry>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(std::collections::HashMap::new()));

/// Remember which phone started the turn on `chat_session_id`.
pub fn record_chat_owner(chat_session_id: &str, owner_session_id: &str) {
    let mut map = CHAT_OWNERS.lock();
    let entry = map.entry(chat_session_id.to_string()).or_default();
    if !entry.channels.iter().any(|o| o == owner_session_id) {
        entry.channels.push(owner_session_id.to_string());
    }
}

/// Remember that a phone is WATCHING `chat_session_id` (it just opened the
/// chat). Desktop-started turns in a watched chat stream to the phone live —
/// without this the phone only saw them after a manual refresh, because the
/// desktop frontend's re-broadcast needs an owner mapping that only a
/// phone-sent turn ever created (and it dies with the desktop store).
pub fn watch_chat(chat_session_id: &str, owner_session_id: &str) {
    let mut map = CHAT_OWNERS.lock();
    let entry = map.entry(chat_session_id.to_string()).or_default();
    entry.watch = true;
    if !entry.channels.iter().any(|o| o == owner_session_id) {
        entry.channels.push(owner_session_id.to_string());
    }
}

pub(crate) fn owners_for_chat(chat_session_id: &str) -> Vec<String> {
    CHAT_OWNERS
        .lock()
        .get(chat_session_id)
        .map(|e| e.channels.clone())
        .unwrap_or_default()
}

/// Remove a turn-scoped owner mapping (chat:done / chat:error exit). Watch
/// entries survive: the phone still has the chat open, and dropping the
/// mapping on the first done made every later desktop-started turn invisible
/// until the phone happened to re-fetch.
fn drop_turn_owner(chat_session_id: &str) {
    let mut map = CHAT_OWNERS.lock();
    let remove = map
        .get(chat_session_id)
        .map(|e| !e.watch)
        .unwrap_or(false);
    if remove {
        map.remove(chat_session_id);
    }
}

/// Drop CHAT_OWNERS entries whose every owner channel died with a
/// disconnected connection (watch entries are bounded by the phone's
/// connection lifetime; without this they accumulated forever). Called from
/// OwnerCleanup after the dead channels are pruned from the owner map.
pub(crate) fn prune_owners_without_channels(owner_map: &OwnerMap) {
    let channels = owner_map.lock();
    CHAT_OWNERS
        .lock()
        .retain(|_, entry| entry.channels.iter().any(|o| channels.contains_key(o)));
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

/// TRUE streaming for relay-run turns — the single delivery path for every
/// `chat:*` event a phone should see.
///
/// The backend emits `chat:token` / `chat:status` / `chat:done` /
/// `chat:error` / `chat:approval_request` / `chat:question-request` /
/// `chat:artifact` / `chat:approval-resolved` / `chat:plan-proposal` for
/// every turn, no matter which surface started it — this forwarder listens
/// to them and ships the matching frames to every phone connection that
/// owns or is watching the chat (CHAT_OWNERS). The old frontend
/// re-broadcast (`mobile:session_chat_event`) this replaced was removed: it
/// only ever covered the chat open on the desktop, and its owner map was
/// never populated once the `mobile:session_chat_owner` emit went away.
pub fn start_chat_stream_forwarder(app: &AppHandle, owner_map: OwnerMap) {
    use serde_json::Value;
    // One registration per process (same guard pattern as the push
    // listeners): start_relay runs on every relay (re)start, and an
    // unguarded re-registration made Tauri invoke every chat:* handler N
    // times after N restarts — the phone saw every streamed token duplicated
    // N times, and one pairing-token rotation already doubled the stream.
    if !claim_listener_slot(&CHAT_STREAM_FORWARDER_REGISTERED) {
        eprintln!("[mobile-relay] chat stream forwarder already registered; skipping");
        return;
    }
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
                drop_turn_owner(cid);
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
            // A failed turn never emits chat:done, so the turn-scoped
            // mapping would linger for the process lifetime — same cleanup
            // as the done path (watch entries survive either way).
            drop_turn_owner(cid);
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
    {
        let owner_map = owner_map.clone();
        // Desktop-resolved approvals must dismiss the phone's card: the
        // turn resumes on the desktop while the phone still shows "waiting
        // for approval" (tapping the stale card then errors with "unknown
        // pending approval id"). This forwarder is the only delivery path —
        // the frontend re-broadcast died with the mobile:session_chat_owner
        // emit, and the legacy owner_session_id emit never fires for modern
        // sessions (CreateSession doesn't set the column).
        let _ = app.listen("chat:approval-resolved", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let (Some(cid), Some(pending_id)) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("pendingId").and_then(Value::as_str),
            ) else { return };
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionApprovalResolved {
                    session_id: owner,
                    pending_id: pending_id.to_string(),
                }
            });
        });
    }
    {
        let owner_map = owner_map.clone();
        // present_plan cards: the phone gets the same Approve / Revise
        // affordance the desktop card offers (it answers via
        // ResolvePlanProposal).
        let _ = app.listen("chat:plan-proposal", move |event| {
            let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
            let (Some(cid), Some(pending_id)) = (
                v.get("chatSessionId").and_then(Value::as_str),
                v.get("pendingId").and_then(Value::as_str),
            ) else { return };
            let title = v
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Plan proposal")
                .to_string();
            let plan = v
                .get("plan")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            forward_to_owner(&owner_map, cid, |owner| {
                super::protocol::DesktopMessage::SessionPlanProposal {
                    session_id: owner,
                    pending_id: pending_id.to_string(),
                    title: title.clone(),
                    plan: plan.clone(),
                }
            });
        });
    }
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
