//! Push notifications for the mobile companion (background alerts).
//!
//! While a phone's WebSocket is connected, every notice rides the socket.
//! When it is NOT (app backgrounded by the OS, phone locked, desktop
//! restarted mid-task), the relay now falls back to Expo push notifications:
//! the phone registers its Expo push token over the paired socket, the
//! desktop stores it, and approval-request / turn-done / automation /
//! budget events are POSTed to Expo's push service which delivers via
//! APNs/FCM.
//!
//! Delivery requires the mobile app to be a development build with
//! `expo-notifications` (Expo Go cannot receive remote pushes on Android
//! since SDK 53). Without a stored token every push call is a no-op, so the
//! desktop behaves exactly as before.

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::db;

use super::protocol::DesktopMessage;

const PUSH_TOKEN_KEY: &str = "mobile.push_token";
const PUSH_PLATFORM_KEY: &str = "mobile.push_platform";
const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

/// Handle `RegisterPushToken` from a paired phone: persist the token so the
/// desktop can reach the phone when its socket is not connected. One phone
/// per desktop today (matching the single-pairing model) — a new
/// registration replaces the old token.
pub fn handle_register_push_token(
    db: &Arc<Mutex<Connection>>,
    token: String,
    platform: String,
) -> Result<Vec<DesktopMessage>, String> {
    if token.trim().is_empty() {
        return Err("push token must not be empty".to_string());
    }
    let conn = db.lock();
    let _ = db::set_setting(&conn, PUSH_TOKEN_KEY, token.trim());
    let _ = db::set_setting(&conn, PUSH_PLATFORM_KEY, platform.trim());
    Ok(vec![DesktopMessage::PushAck {
        ok: true,
        error: None,
    }])
}

fn stored_push_token(conn: &Connection) -> Option<String> {
    db::get_setting(conn, PUSH_TOKEN_KEY)
        .ok()
        .flatten()
        .filter(|t| !t.trim().is_empty())
}

/// True when at least one phone socket is currently connected — if so, the
/// socket broadcast is the delivery path and push would only duplicate it.
fn phones_disconnected(app: &AppHandle) -> bool {
    app.try_state::<crate::MobileRelayState>()
        .map(|s| s.0.conns.lock().is_empty())
        .unwrap_or(true)
}

/// POST one notification to Expo's push service. Fire-and-forget from the
/// caller's perspective (spawned); failures are logged, never propagated —
/// a push outage must not break the chat pipeline that triggered it.
async fn send_push(token: String, title: String, body: String) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[mobile-push] client build failed: {e}");
            return;
        }
    };
    let payload = serde_json::json!({
        "to": token,
        "title": title,
        "body": body,
        "sound": "default",
        // Per-channel docs: Android 8+ requires a channel id to render.
        "channelId": "default",
    });
    match client.post(EXPO_PUSH_URL).json(&payload).send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                eprintln!("[mobile-push] delivery failed: HTTP {status}: {body}");
            }
        }
        Err(e) => eprintln!("[mobile-push] delivery error: {e}"),
    }
}

/// Push a notice to the phone when it is NOT connected over the socket.
/// Callers run on sync/async hot paths — this never blocks: the token lookup
/// takes the DB lock briefly, the HTTP call is spawned.
pub fn push_if_phones_disconnected(app: &AppHandle, title: String, body: String) {
    if !phones_disconnected(app) {
        return;
    }
    let Some(db_state) = app.try_state::<crate::DbState>() else {
        return;
    };
    let Some(token) = ({
        let conn = db_state.0.lock();
        stored_push_token(&conn)
    }) else {
        return;
    };
    tauri::async_runtime::spawn(send_push(token, title, body));
}

/// Notify about an approval request on a MOBILE-originated chat session.
/// Desktop-originated sessions never push (the person at the desk is the
/// audience there); the check reads the `owner_session_id` column that
/// `SendChatMessage` sets for phone-created sessions.
pub fn push_approval_for_mobile_session(app: &AppHandle, chat_session_id: &str, summary: &str) {
    let is_mobile = {
        let Some(db_state) = app.try_state::<crate::DbState>() else {
            return;
        };
        let conn = db_state.0.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM chat_sessions WHERE id = ?1 AND owner_session_id IS NOT NULL",
            rusqlite::params![chat_session_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    };
    if is_mobile {
        push_if_phones_disconnected(app, "Relay needs your approval".to_string(), summary.to_string());
    }
}

/// Notify that a turn on a MOBILE-originated session finished.
pub fn push_turn_done_for_mobile_session(app: &AppHandle, chat_session_id: &str) {
    let is_mobile = {
        let Some(db_state) = app.try_state::<crate::DbState>() else {
            return;
        };
        let conn = db_state.0.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM chat_sessions WHERE id = ?1 AND owner_session_id IS NOT NULL",
            rusqlite::params![chat_session_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    };
    if is_mobile {
        push_if_phones_disconnected(
            app,
            "Relay turn complete".to_string(),
            "Your agent finished — the reply is ready.".to_string(),
        );
    }
}
