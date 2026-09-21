//! Live model pricing commands (LiteLLM community registry) — see
//! pricing_live.rs for the blob shape, matching, and layering.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::DbState;

/// Manual "Refresh model prices" (the cost dashboard footer's button):
/// re-fetch the LiteLLM registry now and rewrite the `price.lite.*` blob,
/// returning {stored, fetchedAt}. The daily background cadence (lib.rs
/// setup) runs the same path. Async so the network round-trip stays off the
/// main thread (see the MAIN-THREAD RULE in lib.rs); failure keeps the
/// previous blob and surfaces as Err.
#[tauri::command(async)]
pub async fn prices_refresh_now(
    app: AppHandle,
) -> Result<crate::pricing_live::FetchReport, String> {
    let db = app.state::<DbState>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("relay-desktop")
        .build()
        .map_err(|e| format!("http client unavailable: {e}"))?;
    crate::pricing_live::refresh_prices(client, Arc::clone(&db.0)).await
}
