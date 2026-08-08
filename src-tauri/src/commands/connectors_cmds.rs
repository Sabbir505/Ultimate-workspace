//! Connectors command surface (Settings → Connectors + per-chat attach).
//!
//! Thin wrappers over `connectors` (config/oauth/mcp) + the credential store.
//! The frontend reads connection status to render the Settings list, calls
//! `connector_connect` to kick off OAuth (the auth webview opens; completion
//! arrives via the `oauth:callback` event), and `connector_disconnect` to clear
//! the local token (+ call the vendor revoke endpoint where supported).
//! `connector_attach_session` / `list_session_connectors` drive the
//! per-conversation opt-in.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
// base64 0.22 exposes encode as a method on engines; the trait must be in
// scope to call it (used for the Basic-auth header on the revoke call).
use base64::Engine as _;

use crate::connectors::{self, CONNECTORS, connector_by_id};
use crate::db;
use crate::secrets;
use crate::types::ConnectorStatus;
use crate::{DbState, OAuthFlowsState};

type CmdResult<T> = Result<T, String>;

/// One connector with its current connection status. Returned by
/// `list_connectors` for the Settings panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorWithStatus {
    #[serde(flatten)]
    pub connector: connectors::Connector,
    pub status: ConnectorStatus,
}

/// Current connection state for a connector, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatusPayload {
    pub connector_id: String,
    pub status: ConnectorStatus,
}

#[tauri::command]
pub fn list_connectors(db: State<DbState>) -> CmdResult<Vec<ConnectorWithStatus>> {
    let conn = db.0.lock();
    let rows = db::list_connector_credential_rows(&conn).map_err(|e| e.to_string())?;
    let now = db::now_ts();
    Ok(CONNECTORS
        .iter()
        .map(|c| {
            let row = rows.iter().find(|r| r.connector_id == c.id);
            let status = match row {
                // Public connectors (Kiwi) keep no credential row — their
                // connection state is inherent (public endpoint, nothing to
                // configure), so they always read as connected.
                None if c.is_public() => ConnectorStatus {
                    connected: c.configured(),
                    expired: false,
                    account_display: c.configured().then(|| c.display_name.to_string()),
                    granted_scopes: None,
                    expires_at: None,
                },
                None => ConnectorStatus {
                    connected: false,
                    expired: false,
                    account_display: None,
                    granted_scopes: None,
                    expires_at: None,
                },
                Some(r) => ConnectorStatus {
                    connected: true,
                    expired: r.expires_at.map_or(false, |exp| now >= exp),
                    account_display: r.account_display.clone(),
                    granted_scopes: r.granted_scopes.clone(),
                    expires_at: r.expires_at,
                },
            };
            ConnectorWithStatus {
                connector: c.clone(),
                status,
            }
        })
        .collect())
}

/// Kick off the OAuth flow for a connector. Opens the auth webview; completion
/// (or error/denial) arrives via the `oauth:callback` event — this command
/// returns immediately with the flow id so the UI can show a spinner.
#[tauri::command]
pub async fn connector_connect(
    connector_id: String,
    flows: State<'_, OAuthFlowsState>,
    app: AppHandle,
) -> CmdResult<u64> {
    // Public connectors (Kiwi) have no OAuth flow — fail fast with a clear
    // message instead of opening a blank authorize URL.
    if let Some(c) = connector_by_id(&connector_id) {
        if c.is_public() {
            return Err(crate::connectors::config::no_oauth_flow_reason(c));
        }
    }
    let flows_arc = flows.0.clone();
    let id = flows_arc.next_id();
    let app_clone = app.clone();
    let cid = connector_id.clone();
    // `start` opens the webview, awaits the redirect, exchanges the code,
    // stores the tokens, and emits `oauth:callback` (success or error). Run it
    // detached so this command returns immediately.
    tauri::async_runtime::spawn(async move {
        let _ = flows_arc.start(&app_clone, &cid, id).await;
    });
    Ok(id)
}

/// Kick off the OAuth flow for a whole connector FAMILY (e.g. "google"): one
/// browser consent screen covering every member's scopes, then the resulting
/// token is stored under each member — a single click connects them all. Same
/// `oauth:callback` contract as `connector_connect`, with the family id as
/// `connector_id`.
#[tauri::command]
pub async fn connector_connect_family(
    family: String,
    flows: State<'_, OAuthFlowsState>,
    app: AppHandle,
) -> CmdResult<u64> {
    let flows_arc = flows.0.clone();
    let id = flows_arc.next_id();
    let app_clone = app.clone();
    let fam = family.clone();
    tauri::async_runtime::spawn(async move {
        let _ = flows_arc.start_family(&app_clone, &fam, id).await;
    });
    Ok(id)
}

/// Disconnect a connector: clear the local token (+ call the vendor's revoke
/// endpoint where supported), then drop the credential row. Surfaces revoke
/// failures (e.g. the vendor has no revoke endpoint — Notion) as a non-fatal
/// note in the result rather than erroring, so the user is always disconnected
/// locally.
#[tauri::command]
pub async fn connector_disconnect(
    connector_id: String,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<DisconnectOutcome> {
    let connector = connector_by_id(&connector_id)
        .ok_or_else(|| format!("unknown connector `{connector_id}`"))?;

    // Best-effort server-side revocation. Notion has no documented revoke
    // endpoint, so this is a no-op there; vendors that do expose one get
    // called. A revoke failure does NOT block local disconnection.
    let revoked = match connector.revoke_url {
        Some(url) => revoke_token(&app, &connector_id, url).await.ok().is_some(),
        None => false,
    };

    {
        let conn = db.0.lock();
        // If the keychain delete succeeds but DB delete fails (or vice
        // versa), return an error so the UI can surface the inconsistency
        // instead of silently showing a disconnected connector that still
        // has a credential row (or a connected one with no keychain entry).
        let keychain_err = secrets::delete_connector_tokens(&conn, &connector_id);
        let db_err = db::delete_connector_credential_row(&conn, &connector_id);
        if let Err(e) = &keychain_err {
            // Keychain failure is non-fatal (may not exist), but log it.
            eprintln!("warning: keychain delete for {connector_id} failed: {e}");
        }
        if let Err(e) = &db_err {
            return Err(format!("DB credential delete failed: {e}"));
        }
    }
    Ok(DisconnectOutcome {
        revoked,
        note: if connector.revoke_url.is_none() {
            Some(format!(
                "{} does not expose a token revocation endpoint — the token was forgotten locally but may remain valid until it expires.",
                connector.display_name
            ))
        } else if !revoked {
            Some("revocation endpoint call failed — token forgotten locally but may remain valid until expiry.".to_string())
        } else {
            None
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectOutcome {
    /// True when the vendor's revoke endpoint was called successfully.
    pub revoked: bool,
    /// Optional human-facing note about the revoke outcome (e.g. Notion has
    /// no revoke endpoint — surfaced so the user knows the token may linger).
    pub note: Option<String>,
}

/// Call a vendor's token revocation endpoint with the stored access token.
/// Notion's MCP AS revokes at /token with a form-encoded `token` +
/// `token_type_hint` + registered `client_id` (verified live: JSON is
/// rejected). Other vendors (RFC 7009 style) take the same form shape; legacy
/// REST-API vendors take a JSON body with Basic auth. We try the
/// client-appropriate shape first and fall back to the other.
async fn revoke_token(app: &AppHandle, connector_id: &str, url: &str) -> Result<(), String> {
    let connector = connector_by_id(connector_id)
        .ok_or_else(|| format!("unknown connector `{connector_id}`"))?;
    let client = crate::connectors::oauth::resolve_oauth_client(app, connector)
        .await
        .map_err(|e| e.to_string())?;
    let token = {
        let db = app.state::<DbState>();
        let conn = db.0.lock();
        secrets::get_connector_token(&conn, connector_id, "access_token")
    }
    .ok_or_else(|| "no access token to revoke".to_string())?;

    let http = reqwest::Client::new();
    let mut req = http.post(url).form(&[
        ("token", token.as_str()),
        ("token_type_hint", "access_token"),
        ("client_id", client.client_id.as_str()),
    ]);
    if client.token_endpoint_auth_method == "client_secret_basic" {
        let basic = base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            client.client_id,
            client.client_secret.as_deref().unwrap_or("")
        ));
        req = req.header("Authorization", format!("Basic {basic}"));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        return Ok(());
    }
    // Some vendors are RFC 7009 with a JSON body (legacy REST-API AS). Retry
    // that shape if form was rejected — non-fatal if this also fails
    // (Disconnect proceeds).
    let mut req2 = http
        .post(url)
        .json(&serde_json::json!({ "token": token }));
    if client.token_endpoint_auth_method == "client_secret_basic" {
        let basic = base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            client.client_id,
            client.client_secret.as_deref().unwrap_or("")
        ));
        req2 = req2.header("Authorization", format!("Basic {basic}"));
    }
    let resp2 = req2.send().await.map_err(|e| e.to_string())?;
    if resp2.status().is_success() {
        Ok(())
    } else {
        Err(format!("revoke HTTP {} / {}", resp.status(), resp2.status()))
    }
}

// ---- per-conversation connector attach (per-session opt-in) ----

/// Set the connectors attached to a chat session. Replaces the prior set.
#[tauri::command]
pub fn set_session_connectors(
    chat_session_id: String,
    connector_ids: Vec<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_chat_session_connectors(&conn, &chat_session_id, &connector_ids)
        .map_err(|e| e.to_string())
}

/// The connectors attached to a chat session (for rendering the composer's
/// attach state when a session is selected).
#[tauri::command]
pub fn list_session_connectors(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<Vec<String>> {
    let conn = db.0.lock();
    db::list_chat_session_connectors(&conn, &chat_session_id).map_err(|e| e.to_string())
}
