//! Tauri IPC commands that expose the mobile relay to the frontend.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::DbState;
use crate::MobileRelayState;

use super::relay::{start_relay, stop_relay};
use super::tailscale;

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

// ---------------------------------------------------------------------------
// Pairing + Tailscale remote-access commands
// ---------------------------------------------------------------------------

/// Everything the desktop "Remote" settings panel needs in one call: relay
/// port + token, the local ws:// URL for USB-bridge fallback, and the
/// current Tailscale state (installed/logged-in/DNS + whether serve is
/// active). The phone pairs by scanning a QR of the active URL with the
/// token in the fragment: `<scheme>://<host>[:<port>]/#<token>`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingInfo {
    pub running: bool,
    pub port: u16,
    pub token: Option<String>,
    pub local_url: Option<String>,
    pub tailscale: tailscale::TailscaleStatus,
    /// When non-empty, `tailscale serve` is active and the phone should use
    /// this `wss://<machine>.<tailnet>.ts.net/#<token>` URL instead of the
    /// local one. Cross-network access without exposing the relay to the LAN.
    pub tailscale_url: Option<String>,
}

/// Get the relay port + pairing token + Tailscale state. The token is read
/// from `app_settings` (written by `start_relay` on every launch). When
/// tailscale is logged in, its DNS name is used to construct the cross-network
/// `wss://` URL.
#[tauri::command]
pub fn get_mobile_pairing_info(
    relay_state: State<'_, MobileRelayState>,
    db: State<'_, DbState>,
) -> CmdResult<MobilePairingInfo> {
    let port = *relay_state.0.port.lock();
    let running = port.is_some();
    let token = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, "mobile.pairing_token")
            .ok()
            .flatten()
    };
    let local_url = match (running, port, token.as_ref()) {
        (true, Some(p), Some(t)) => Some(format!("ws://127.0.0.1:{p}/#{t}")),
        _ => None,
    };
    let ts = tailscale::status();
    let serving = tailscale::serve_active();
    let tailscale_url = match (serving, ts.installed, ts.logged_in, ts.dns_name.as_ref(), token.as_ref()) {
        (true, true, true, Some(dns), Some(t)) => Some(format!("{}#{}", tailscale::wss_url(dns), t)),
        _ => None,
    };
    Ok(MobilePairingInfo {
        running,
        port: port.unwrap_or(0),
        token,
        local_url,
        tailscale: ts,
        tailscale_url,
    })
}

/// Enable `tailscale serve` fronting the relay's loopback port. Returns the
/// resulting `wss://<machine>.<tailnet>.ts.net` URL. Requires the relay to
/// be running (so the port is known) and tailscale to be logged in.
#[tauri::command]
pub fn tailscale_serve_enable(
    relay_state: State<'_, MobileRelayState>,
    db: State<'_, DbState>,
) -> CmdResult<String> {
    let port = *relay_state.0.port.lock();
    let port = port.ok_or_else(|| "relay is not running".to_string())?;
    let ts = tailscale::status();
    if !ts.installed {
        return Err("tailscale CLI not found on PATH".into());
    }
    if !ts.logged_in {
        return Err("tailscale is not logged in (run `tailscale up` first)".into());
    }
    let args = tailscale::serve_args(port);
    let _ = tailscale::run_tailscale(&args)?;
    // Persist the URL so get_mobile_pairing_info can report it even before
    // the next tailscale status poll.
    let url = match ts.dns_name.as_ref() {
        Some(dns) => tailscale::wss_url(dns),
        None => return Err("tailscale is logged in but has no DNS name".into()),
    };
    {
        let conn = db.0.lock();
        let _ = crate::db::set_setting(&conn, "mobile.tailscale_url", &url);
    }
    Ok(url)
}

/// Disable `tailscale serve` (tears down ALL serve paths on this node).
#[tauri::command]
pub fn tailscale_serve_disable(db: State<'_, DbState>) -> CmdResult<()> {
    let args = tailscale::serve_off_args();
    let _ = tailscale::run_tailscale(&args)?;
    let conn = db.0.lock();
    let _ = crate::db::set_setting(&conn, "mobile.tailscale_url", "");
    Ok(())
}

/// Start the Tailscale login flow (`tailscale up` in the background — the
/// CLI opens the browser automatically). Poll `get_mobile_pairing_info` for
/// the logged-in transition.
#[tauri::command]
pub fn tailscale_login() -> CmdResult<()> {
    tailscale::spawn_login()
}
