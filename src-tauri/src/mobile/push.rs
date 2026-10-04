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
/// When the phone registered the token (epoch seconds). SS5.22: stale-token
/// cleanup — a token with no timestamp predates the audit fix and gets the
/// conservative age (registered "now", pruned later if delivery fails).
const PUSH_TOKEN_AT_KEY: &str = "mobile.push_token_at";
/// Push tokens are pruned after this long without a successful registration
/// refresh (dev-build Expo tokens churn on reinstall/rebuild).
const PUSH_TOKEN_MAX_AGE_DAYS: i64 = 90;
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
    let _ = db::set_setting(&conn, PUSH_TOKEN_AT_KEY, &db::now_ts().to_string());
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

/// The stored token, if it exists AND is fresh (SS5.22). A token older than
/// [`PUSH_TOKEN_MAX_AGE_DAYS`] — or an Expo `DeviceNotRegistered` rejection —
/// means the phone no longer accepts pushes, so the token is dropped and the
/// next registration re-arms the channel.
fn fresh_push_token(conn: &Connection) -> Option<String> {
    let token = stored_push_token(conn)?;
    let registered_at = db::get_setting(conn, PUSH_TOKEN_AT_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or_else(db::now_ts);
    if db::now_ts() - registered_at > PUSH_TOKEN_MAX_AGE_DAYS * 86_400 {
        let _ = db::set_setting(conn, PUSH_TOKEN_AT_KEY, "");
        let _ = db::set_setting(conn, PUSH_TOKEN_KEY, "");
        return None;
    }
    Some(token)
}

/// Drop the stored token + timestamp (delivery said the device is gone).
fn clear_push_token(db: &Arc<Mutex<Connection>>) {
    let conn = db.lock();
    let _ = db::set_setting(&conn, PUSH_TOKEN_KEY, "");
    let _ = db::set_setting(&conn, PUSH_TOKEN_AT_KEY, "");
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
async fn send_push(token: String, title: String, body: String, db: Arc<Mutex<Connection>>) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            crate::relay_eprintln!("[mobile-push] client build failed: {e}");
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
                crate::relay_eprintln!("[mobile-push] delivery failed: HTTP {status}: {body}");
                return;
            }
            // SS5.22: a 200 envelope can still carry a per-message error.
            // `DeviceNotRegistered` means the token is dead (app uninstalled,
            // dev build rebuilt) — prune it so every later push stops
            // paying the round-trip, and the next phone registration
            // re-arms the channel.
            let Ok(v) = resp.json::<serde_json::Value>().await else { return };
            let device_gone = v
                .get("data")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter().any(|m| {
                        m.get("status").and_then(|s| s.as_str()) == Some("error")
                            && m.pointer("/details/error").and_then(|e| e.as_str())
                                == Some("DeviceNotRegistered")
                    })
                })
                .unwrap_or(false);
            if device_gone {
                clear_push_token(&db);
                crate::relay_eprintln!("[mobile-push] token pruned (DeviceNotRegistered)");
            }
        }
        Err(e) => crate::relay_eprintln!("[mobile-push] delivery error: {e}"),
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
        fresh_push_token(&conn)
    }) else {
        return;
    };
    tauri::async_runtime::spawn(send_push(token, title, body, std::sync::Arc::clone(&db_state.0)));
}

/// Notify about an approval request on a MOBILE-originated chat session.
/// Desktop-originated sessions never push (the person at the desk is the
/// audience there); the check reads the `owner_session_id` column that
/// `SendChatMessage` sets for phone-created sessions. The chat-derived
/// `summary` is deliberately NOT pushed (plaintext through Expo's cloud) —
/// see the generic body below.
pub fn push_approval_for_mobile_session(app: &AppHandle, chat_session_id: &str, _summary: &str) {
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
        // The approval summary is model/tool-derived chat content — pushing
        // it verbatim through Expo's cloud would leak conversation detail in
        // plaintext to a third party. Ship a generic body instead; the live
        // socket path still carries the real summary when the phone is
        // connected. The title stays (no chat-derived content in it).
        push_if_phones_disconnected(
            app,
            "Relay needs your approval".to_string(),
            "Approval needed — open Relay to review.".to_string(),
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        conn
    }

    /// SS5.22: a freshly registered token is served; one registered longer
    /// than PUSH_TOKEN_MAX_AGE_DAYS ago is pruned on read (token + timestamp
    /// cleared) so pushes stop targeting a dead device registration.
    #[test]
    fn stale_push_tokens_are_pruned_on_read() {
        let conn = mem();
        handle_register_push_token_test(&conn, "ExponentPushToken[abc]", "ios");
        assert!(fresh_push_token(&conn).is_some());

        // Roll the registration timestamp past the max age.
        let old = db::now_ts() - (PUSH_TOKEN_MAX_AGE_DAYS + 1) * 86_400;
        db::set_setting(&conn, PUSH_TOKEN_AT_KEY, &old.to_string()).unwrap();
        assert!(fresh_push_token(&conn).is_none(), "aged token must be pruned");
        assert!(
            stored_push_token(&conn).is_none(),
            "pruned token must not linger in settings"
        );
    }

    /// A token WITHOUT a timestamp (pre-fix install) keeps working — treated
    /// as registered now, not as ancient (which would silently kill every
    /// existing pairing's pushes on first boot after the upgrade).
    #[test]
    fn token_without_timestamp_is_not_treated_as_ancient() {
        let conn = mem();
        db::set_setting(&conn, PUSH_TOKEN_KEY, "ExponentPushToken[legacy]").unwrap();
        assert!(fresh_push_token(&conn).is_some());
    }

    /// Test-only registration against a bare connection (the production
    /// handle_register_push_token takes the shared Arc; same DB writes).
    fn handle_register_push_token_test(conn: &Connection, token: &str, platform: &str) {
        let _ = db::set_setting(conn, PUSH_TOKEN_KEY, token.trim());
        let _ = db::set_setting(conn, PUSH_PLATFORM_KEY, platform.trim());
        let _ = db::set_setting(conn, PUSH_TOKEN_AT_KEY, &db::now_ts().to_string());
    }
}
