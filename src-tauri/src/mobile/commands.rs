//! Tauri IPC commands that expose the mobile relay to the frontend.

use std::sync::Arc;
use std::time::Duration;

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
    /// When non-empty, the relay is bound to the Tailscale interface and the
    /// phone can reach it at `ws://<tailscale-ip>:<port>/#<token>` directly
    /// over the tailnet (no HTTPS serve required).
    pub tailnet_url: Option<String>,
}

/// Get the relay port + pairing token + Tailscale state. The token is read
/// from `app_settings` (written by `start_relay` on every launch). When
/// tailscale is logged in, its DNS name is used to construct the
/// cross-network `wss://` URL.
///
/// The Tailscale probes each SPAWN the `tailscale` CLI (`status --json`,
/// `serve status`) which can take hundreds of ms to seconds against a cold
/// daemon. This used to be a sync command, so every open of the pairing QR
/// modal froze the whole window on the main thread — and the modal re-probes
/// every 3s while open. Now async with the probes off-thread; the fast DB /
/// relay reads stay inline.
#[tauri::command]
pub async fn get_mobile_pairing_info(
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
    let (ts, serving) = tauri::async_runtime::spawn_blocking(|| {
        (tailscale::status(), tailscale::serve_active())
    })
    .await
    .map_err(|e| format!("tailscale probe join failed: {e}"))?;
    let tailscale_url = match (serving, ts.installed, ts.logged_in, ts.dns_name.as_ref(), token.as_ref()) {
        (true, true, true, Some(dns), Some(t)) => Some(format!("{}#{}", tailscale::wss_url(dns), t)),
        _ => None,
    };
    // Tailnet URL: reachable from any device on the tailnet (which is
    // encrypted via WireGuard). This works even when HTTPS serve is not
    // enabled on the tailnet, so it's the reliable cross-network path.
    let tailnet_url = match (running, port, ts.logged_in, ts.tailscale_ip.as_ref(), token.as_ref()) {
        (true, Some(p), true, Some(ip), Some(t)) => Some(format!("ws://{ip}:{p}/#{t}")),
        _ => None,
    };
    Ok(MobilePairingInfo {
        running,
        port: port.unwrap_or(0),
        token,
        local_url,
        tailscale: ts,
        tailscale_url,
        tailnet_url,
    })
}

/// Enable `tailscale serve` fronting the relay's loopback port. Runs
/// asynchronously with a confirmation poll so the frontend knows serve is
/// actually up before returning. Returns the `wss://` URL on success.
#[tauri::command]
pub async fn tailscale_serve_enable(
    relay_state: State<'_, MobileRelayState>,
    db: State<'_, DbState>,
) -> CmdResult<String> {
    let port = {
        let guard = relay_state.0.port.lock();
        guard.ok_or_else(|| "relay is not running".to_string())?
    };
    let ts = tailscale::status();
    if !ts.installed {
        return Err("tailscale CLI not found on PATH".into());
    }
    if !ts.logged_in {
        return Err("tailscale is not logged in (run `tailscale up` first)".into());
    }

    // Spawn the serve command in a background thread — it exits quickly but
    // cert provisioning is async.
    let port_clone = port;
    let _join_handle = tokio::task::spawn_blocking(move || {
        let args = tailscale::serve_args(port_clone);
        let _ = tailscale::run_tailscale(&args);
    });

    // Poll serve_active() until it's up (or we time out). This is critical:
    // tailscale serve --bg exits 0 before the HTTPS config is fully live.
    let url = match ts.dns_name.as_ref() {
        Some(dns) => tailscale::wss_url(dns),
        None => return Err("tailscale is logged in but has no DNS name".into()),
    };

    const MAX_WAIT_MS: u64 = 8_000;
    const POLL_INTERVAL_MS: u64 = 500;
    let deadline = std::time::Instant::now() + Duration::from_millis(MAX_WAIT_MS);
    while std::time::Instant::now() < deadline {
        // Give serve a moment to initialise on first check.
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        if tailscale::serve_active() {
            // Persist so future get_mobile_pairing_info calls know serve is live.
            let conn = db.0.lock();
            let _ = crate::db::set_setting(&conn, "mobile.tailscale_url", &url);
            return Ok(url);
        }
    }

    // Timed out — serve never came up. This typically means HTTPS serving
    // is not enabled on this tailnet (Tailscale admin console required).
    Err(format!(
        "Tailscale serve did not activate within {MAX_WAIT_MS}ms — \
        HTTPS serving may not be enabled on your tailnet. \
        Visit https://login.tailscale.com/f/serve to enable it."
    ))
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
