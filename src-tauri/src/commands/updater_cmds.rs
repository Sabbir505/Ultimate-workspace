//! Auto-updater commands (Tauri updater plugin).
//!
//! `check_for_update` queries the configured endpoint (see tauri.conf.json
//! `plugins.updater.endpoints` — a `latest.json` on GitHub Releases) and
//! returns whether a newer version exists, plus its version, the release notes
//! (markdown), and the publish date. The frontend shows a banner with the
//! changelog and a "Download & restart" button.
//!
//! `download_and_install_update` performs the download (emitting
//! `updater:progress` events with byte counts) and, once verified against the
//! baked-in public key, installs the update. On Windows the installer runs in
//! "passive" mode (a progress bar, no dialog gauntlet) and the app is restarted
//! automatically by the plugin after install.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

type CmdResult<T> = Result<T, String>;

/// Result of an update check. `update_available` is false when the app is
/// already on the latest version (or no endpoint was reachable — a network
/// failure mid-check is treated as "no update" so the app keeps working).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub update_available: bool,
    /// The version string of the available update (e.g. "0.2.0"), or null.
    pub version: Option<String>,
    /// Markdown release notes / changelog for the available update.
    pub notes: Option<String>,
    /// The date the update was published (RFC3339 from the endpoint).
    pub pub_date: Option<String>,
}

/// Scan the configured updater endpoint for a newer version than the running
/// build. Safe to call on a timer (startup + every 4h); it is a single HTTP
/// GET plus a semver compare, no side effects.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> CmdResult<UpdateInfo> {
    let updater = app.updater().map_err(|e| format!("updater init failed: {e}"))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            update_available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            pub_date: update.date.map(|d| d.to_string()),
        }),
        Ok(None) => Ok(UpdateInfo {
            update_available: false,
            version: None,
            notes: None,
            pub_date: None,
        }),
        Err(e) => {
            // A network failure mid-check is not fatal — just report "no update".
            eprintln!("[relay:updater] check failed: {e}");
            Ok(UpdateInfo {
                update_available: false,
                version: None,
                notes: None,
                pub_date: None,
            })
        }
    }
}

/// Payload for the `updater:progress` event (raw bytes + optional total, for a
/// progress bar).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Download the pending update and install it. Emits `updater:progress`
/// periodically during download (cumulative bytes + total), then
/// `updater:installed` once the verified package is on disk. The plugin runs
/// the installer and restarts the app automatically after a successful install;
/// if it does not restart, the frontend prompts a manual restart.
///
/// Single-flight: a second call while one is running returns early. We track an
/// in-process flag so a double-trigger (startup timer + manual button) can't
/// spawn two downloads.
static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> CmdResult<()> {
    if INSTALLING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(()); // already installing
    }
    let result = run_install(&app).await;
    INSTALLING.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

async fn run_install(app: &AppHandle) -> CmdResult<()> {
    let updater = app.updater().map_err(|e| format!("updater init failed: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?
        .ok_or_else(|| "no update available".to_string())?;

    let mut total_seen: Option<u64> = None;
    let mut downloaded: u64 = 0;
    let app_handle = app.clone();
    // download_and_install: streams chunks (chunk_len, content_length),
    // verifies the signature against the baked-in pubkey, then runs the
    // installer (passive on Windows) and restarts the app.
    update
        .download_and_install(
            |chunk_len, content_length| {
                if let Some(t) = content_length {
                    total_seen = Some(t);
                }
                downloaded = downloaded.saturating_add(chunk_len as u64);
                let _ = app_handle.emit(
                    "updater:progress",
                    UpdateProgress {
                        downloaded,
                        total: total_seen,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("install failed: {e}"))?;

    let _ = app.emit("updater:installed", ());
    Ok(())
}
