//! Tauri IPC commands that expose the mobile relay to the frontend.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::DbState;
use crate::MobileRelayState;

use super::relay::{start_relay, stop_relay};

type CmdResult<T> = Result<T, String>;

/// Start the mobile relay server. Returns the bound port.
#[tauri::command]
pub async fn start_mobile_relay(
    app: AppHandle,
    relay_state: State<'_, MobileRelayState>,
    db: State<'_, DbState>,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<u16> {
    let db = Arc::clone(&db.0);
    let chat_mgr = Arc::clone(&chat_state.0);
    let state = Arc::clone(&relay_state.0);
    start_relay(app, state, db, chat_mgr)
        .await
        .map_err(|e| e)
}

/// Stop the mobile relay server.
#[tauri::command]
pub fn stop_mobile_relay(relay_state: State<'_, MobileRelayState>) -> CmdResult<()> {
    stop_relay(&relay_state.0);
    Ok(())
}

/// Get the current relay status.
#[tauri::command]
pub fn get_mobile_relay_status(relay_state: State<'_, MobileRelayState>) -> CmdResult<MobileRelayStatus> {
    let port = *relay_state.0.port.lock();
    Ok(MobileRelayStatus {
        running: port.is_some(),
        port: port.unwrap_or(0),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileRelayStatus {
    pub running: bool,
    pub port: u16,
}
