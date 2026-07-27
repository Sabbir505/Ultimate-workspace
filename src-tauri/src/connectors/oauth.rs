//! OAuth 2.0 authorization-code + PKCE flow for connectors.
//!
//! Opens the vendor's OAuth authorize URL in the **system browser** (not a
//! Tauri webview — see BUILD_LOG.md for why WebView2's popup restrictions
//! break Notion's OAuth page). The redirect lands on a one-shot loopback HTTP
//! server bound to `127.0.0.1` on a random high port. Once the callback is
//! captured the server shuts down and token exchange proceeds as before.
//!
//! On success the resulting tokens are stored via the credential store
//! (`secrets::set_connector_token`) and the metadata row
//! (`db::upsert_connector_credential_row`).
//!
//! Everything here is generic: the per-connector endpoints, client id, and
//! redirect URI come from the `Connector` config record. Vendor-specific
//! quirks (confidential vs. public client, scope strings, revocation
//! endpoint availability) are noted per-connector in BUILD_LOG.md.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use rand::RngCore;
use tauri::{AppHandle, Emitter, Manager};

// base64 0.22 exposes encode/decode as methods on engines; the trait must be
// in scope to call them.
use base64::Engine as _;

use crate::connectors::{Connector, connector_by_id};
use crate::db;
use crate::secrets;

/// A pending OAuth flow. Used for state validation and
/// code-verifier lookup during the callback. The system-browser
/// approach records the flow before opening the browser so the
/// callback handler can validate the `state` parameter and match
/// the code_verifier for PKCE token exchange.
#[allow(dead_code)]
struct PendingFlow {
    code_verifier: String,
    state: String,
}

/// Per-app registry of in-flight OAuth flows. Registered as Tauri state.
/// The system-browser approach records each flow's `state` and `code_verifier`
/// before opening the browser; the loopback callback handler validates the
/// returned `state` against the registry and uses the stored `code_verifier`
/// for the PKCE token exchange.
#[derive(Default)]
pub struct OAuthFlows {
    flows: Mutex<HashMap<String, PendingFlow>>,
    next: AtomicU64,
}

/// Where the auth webview's on_navigation hook sends its result. Emitted to the
/// frontend so the Settings "Connectors" panel can react (close its spinner,
/// show the connected state, or surface an error).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackEvent {
    pub flow_id: u64,
    pub connector_id: String,
    /// "connected" | "denied" | "error"; the human-readable detail, if any,
    /// travels in `error`.
    pub status: String,
    pub error: Option<String>,
    /// The displayable account/workspace name, when known after token exchange.
    pub account_display: Option<String>,
}

impl OAuthFlows {
    /// Kick off the OAuth flow for a connector: build the authorize URL (with
    /// PKCE + state), open the auth webview, and await the redirect callback.
    /// Returns the flow id (so the caller can correlate the `oauth:callback`
    /// event). Completion (or error/denial) is emitted via `oauth:callback`.
    pub async fn start(
        &self,
        app: &AppHandle,
        connector_id: &str,
    ) -> Result<u64, String> {
        let connector = match connector_by_id(connector_id) {
            Some(c) => c,
            None => {
                let e = format!("unknown connector `{connector_id}`");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id: self.next.fetch_add(1, Ordering::Relaxed),
                    connector_id: connector_id.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                return Err(e);
            }
        };
        if connector.client_id.is_empty() {
            let e = format!(
                "connector `{}` has no client_id configured (set it before connecting)",
                connector.id
            );
            let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                flow_id: self.next.fetch_add(1, Ordering::Relaxed),
                connector_id: connector.id.to_string(),
                status: "error".to_string(),
                error: Some(e.clone()),
                account_display: None,
            });
            return Err(e);
        }

        let code_verifier = random_pkce_verifier();
        let code_challenge = pkce_challenge(&code_verifier);
        let flow_id = self.next.fetch_add(1, Ordering::Relaxed);
        let state = format!("flow-{flow_id}-{:016x}", rand::random::<u64>());
        // Register the pending flow so accept_one_callback can validate the
        // returned `state` parameter against what we sent.
        {
            let mut flows = self.flows.lock();
            flows.insert(state.clone(), PendingFlow {
                code_verifier: code_verifier.clone(),
                state: state.clone(),
            });
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("failed to bind loopback server: {e}"))?;
        let port = listener.local_addr()
            .map_err(|e| format!("failed to read loopback port: {e}"))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");

        let authorize_url = build_authorize_url(connector, &code_challenge, &state, &redirect_uri);

        if let Err(e) = open::that(&authorize_url) {
            self.cancel(flow_id);
            let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                flow_id,
                connector_id: connector.id.to_string(),
                status: "error".to_string(),
                error: Some(format!("failed to open browser: {e}")),
                account_display: None,
            });
            return Err(format!("failed to open browser: {e}"));
        }

        let expected_state = state.clone();
        // Cap the wait for a callback at 5 minutes — if the user never
        // completes (or closes) the browser flow, surface an error instead of
        // leaving the "Authorizing…" spinner stuck forever.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            tokio::task::spawn_blocking(move || accept_one_callback(&listener, &expected_state)),
        ).await;

        // Remove the pending flow entry regardless of outcome.
        {
            let mut flows = self.flows.lock();
            flows.remove(&state);
        }

        let code = match result {
            Ok(Ok(Ok(c))) => c,
            Ok(Ok(Err(msg))) => {
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector.id.to_string(),
                    status: if msg.starts_with("oauth denied") { "denied".to_string() } else { "error".to_string() },
                    error: Some(msg.clone()),
                    account_display: None,
                });
                return Err(msg);
            }
            Ok(Err(join_err)) => {
                let msg = format!("loopback server error: {join_err}");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector.id.to_string(),
                    status: "error".to_string(),
                    error: Some(msg.clone()),
                    account_display: None,
                });
                return Err(msg);
            }
            Err(_elapsed) => {
                let msg = "Authorization timed out — no callback received within 5 minutes. Please try Connect again.".to_string();
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector.id.to_string(),
                    status: "error".to_string(),
                    error: Some(msg.clone()),
                    account_display: None,
                });
                return Err(msg);
            }
        };

        match exchange_and_store(app, connector, &code, &code_verifier, &redirect_uri).await {
            Ok(account_display) => {
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector.id.to_string(),
                    status: "connected".to_string(),
                    error: None,
                    account_display,
                });
                Ok(flow_id)
            }
            Err(e) => {
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector.id.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                Err(e)
            }
        }
    }

    /// The next flow id — exposed so the command layer can return an id
    /// immediately even before `start` allocates one (the latter emits the
    /// `oauth:callback` event with the real id once it runs).
    pub fn next_id(&self) -> u64 {
        self.next.load(Ordering::Relaxed)
    }

    /// Cancel a pending flow. No-op for the system-browser approach (the user
    /// can just close the browser tab).
    pub fn cancel(&self, flow_id: u64) {
        // The loopback server accepts one connection and exits, so there's
        // nothing to tear down here. Kept for API compatibility with the
        // commands layer.
        let _ = flow_id;
    }
}

/// Accept a single HTTP connection, respond with a browser-friendly page, and
/// extract the OAuth `code` (or `error`) from the query string. Validates that
/// the returned `state` parameter matches the one sent in the authorize URL
/// (CSRF protection per RFC 6749 §10.12).
fn accept_one_callback(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    let (mut stream, _addr) = listener
        .accept()
        .map_err(|e| format!("loopback accept failed: {e}"))?;
    let mut reader = BufReader::new(&mut stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)
        .map_err(|e| format!("loopback read failed: {e}"))?;

    let path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let query_str = path.split('?').nth(1).unwrap_or("");

    let query: HashMap<String, String> = url::form_urlencoded::parse(query_str.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    // Validate the state parameter to prevent CSRF (RFC 6749 §10.12).
    let returned_state = query.get("state").cloned().unwrap_or_default();
    if returned_state != expected_state {
        let html = format!(
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Conduit — State Mismatch</title>\
             <style>body{{font-family:system-ui,sans-serif;display:flex;justify-content:center;\
             align-items:center;min-height:100vh;margin:0;background:#fff5f5;color:#7f1d1d}}\
             .card{{background:#fff;padding:2rem 3rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);\
             text-align:center}}h1{{font-size:1.25rem;margin:0 0 0.5rem}}p{{color:#991b1b;margin:0}}\
             </style></head><body><div class=\"card\"><h1>State Mismatch</h1>\
             <p>The request could not be verified. You may close this window.</p></div></body></html>"
        );
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(), html
        );
        let _ = stream.write_all(response.as_bytes());
        return Err("state parameter mismatch — possible CSRF attack".into());
    }

    let (status, body): (&str, String) = if let Some(err) = query.get("error") {
        ("Authorization denied", format!("The authorization was denied. Reason: {err}"))
    } else if query.contains_key("code") {
        ("Connected!", "Authorization successful. You may close this window.".to_string())
    } else {
        ("Missing code", "No authorization code was received. You may close this window.".to_string())
    };
    let html = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Conduit — {status}</title>\
         <style>body{{font-family:system-ui,sans-serif;display:flex;justify-content:center;\
         align-items:center;min-height:100vh;margin:0;background:#f5f0eb;color:#3d3027}}\
         .card{{background:#fff;padding:2rem 3rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);\
         text-align:center}}h1{{font-size:1.25rem;margin:0 0 0.5rem}}p{{color:#6b5e53;margin:0}}\
         </style></head><body><div class=\"card\"><h1>{status}</h1><p>{body}</p></div></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(), html
    );
    let _ = stream.write_all(response.as_bytes());

    if let Some(err) = query.get("error") {
        let desc = query.get("error_description").cloned().unwrap_or_default();
        let extra = if desc.is_empty() { String::new() } else { format!(" — {desc}") };
        return Err(format!("oauth denied: {err}{extra}"));
    }
    query.get("code").cloned()
        .ok_or_else(|| "redirect callback missing `code` parameter".into())
}

/// Build the authorization URL: vendor endpoint + client_id + redirect_uri +
/// response_type=code + state + (PKCE) code_challenge/code_challenge_method.
fn build_authorize_url(c: &Connector, code_challenge: &str, state: &str, redirect_uri: &str) -> String {
    let mut url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&state={}",
        c.authorize_url,
        urlencoding::encode(c.client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state),
    );
    if c.id == "notion" {
        url.push_str("&owner=user");
    }
    if !c.scopes.is_empty() {
        url.push_str(&format!("&scope={}", urlencoding::encode(c.scopes)));
    }
    url.push_str(&format!(
        "&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(code_challenge)
    ));
    url
}

/// 43-128 char random url-safe string (RFC 7636 §4.1).
fn random_pkce_verifier() -> String {
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64url_no_pad(&bytes)
}

/// S256 code challenge = base64url_no_pad(SHA256(verifier)).
fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(verifier.as_bytes());
    base64url_no_pad(&hash)
}

fn base64url_no_pad(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}


/// Exchange the authorization code for tokens and persist them. Notion is a
/// confidential client: the exchange uses `Authorization: Basic
/// base64(client_id:client_secret)`. The response shape is vendor-specific;
/// Notion returns `access_token`, `workspace_name`/`workspace_icon`, `bot_id`,
/// and (per docs) a `duplicated_template_id` — but notably does NOT document a
/// `refresh_token` or `expires_in`, so refresh is best-effort (see
/// BUILD_LOG.md).
async fn exchange_and_store(
    app: &AppHandle,
    connector: &Connector,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<Option<String>, String> {
    let client = reqwest::Client::new();

    let mut req = client
        .post(connector.token_url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        }));

    if connector.confidential() {
        let basic = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", connector.client_id, connector.client_secret));
        req = req.header("Authorization", format!("Basic {basic}"));
    }

    let resp = req.send().await.map_err(|e| format!("token exchange failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("token response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("token exchange HTTP {status}: {body}"));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("token response not JSON: {e}"))?;

    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "token response missing access_token".to_string())?
        .to_string();
    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64());
    let granted_scopes = json
        .get("scope")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Notion's displayable account: workspace_name > owner.user.email > bot_id.
    let account_display = json
        .get("workspace_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            json.get("owner")
                .and_then(|o| o.get("user"))
                .and_then(|u| u.get("email"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    // Persist: tokens in the keychain, metadata in the SQLite row.
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let now = crate::db::now_ts();
    let expires_at = expires_in.map(|secs| now + secs);

    secrets::set_connector_token(&conn, connector.id, "access_token", &access_token)?;
    if let Some(ref rt) = refresh_token {
        secrets::set_connector_token(&conn, connector.id, "refresh_token", rt)?;
    } else {
        // No refresh token — clear any stale one so we don't try to refresh
        // with a token from a previous connection.
        let _ = secrets::delete_connector_tokens(&conn, connector.id);
        secrets::set_connector_token(&conn, connector.id, "access_token", &access_token)?;
    }
    db::upsert_connector_credential_row(
        &conn,
        connector.id,
        expires_at,
        granted_scopes.as_deref(),
        account_display.as_deref(),
        now,
    )
    .map_err(|e| e.to_string())?;

    Ok(account_display)
}

/// Refresh an expired access token using the stored refresh token. Returns the
/// new access token. Best-effort: vendors that don't issue refresh tokens
/// (Notion, per docs) will return Err here and the caller should prompt the
/// user to reconnect rather than retry silently.
pub async fn refresh_access_token(
    app: &AppHandle,
    connector: &Connector,
) -> Result<String, String> {
    let db = app.state::<crate::DbState>();
    let refresh_token = {
        let conn = db.0.lock();
        secrets::get_connector_token(&conn, connector.id, "refresh_token")
    }
    .ok_or_else(|| "no refresh token stored — reconnect required".to_string())?;

    let client = reqwest::Client::new();
    let mut req = client
        .post(connector.token_url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }));
    if connector.confidential() {
        let basic = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", connector.client_id, connector.client_secret));
        req = req.header("Authorization", format!("Basic {basic}"));
    }

    let resp = req.send().await.map_err(|e| format!("refresh failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("refresh response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("refresh HTTP {status}: {body}"));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("refresh response not JSON: {e}"))?;

    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "refresh response missing access_token".to_string())?
        .to_string();
    let new_refresh = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64());

    let conn = db.0.lock();
    secrets::set_connector_token(&conn, connector.id, "access_token", &access_token)?;
    if let Some(rt) = new_refresh {
        secrets::set_connector_token(&conn, connector.id, "refresh_token", &rt)?;
    }
    let now = db::now_ts();
    let row = db::get_connector_credential_row(&conn, connector.id).map_err(|e| e.to_string())?;
    let (granted_scopes, account_display) = row
        .map(|r| (r.granted_scopes, r.account_display))
        .unwrap_or((None, None));
    db::upsert_connector_credential_row(
        &conn,
        connector.id,
        expires_in.map(|s| now + s),
        granted_scopes.as_deref(),
        account_display.as_deref(),
        now,
    )
    .map_err(|e| e.to_string())?;

    Ok(access_token)
}

/// Resolve a non-expired access token for a connector, refreshing first if the
/// stored one has expired (and a refresh token exists). This is the single
/// entry point the MCP client uses before every connector-backed tool call.
pub async fn ensure_valid_access_token(
    app: &AppHandle,
    connector_id: &str,
) -> Result<String, String> {
    let connector = connector_by_id(connector_id)
        .ok_or_else(|| format!("unknown connector `{connector_id}`"))?;
    let db = app.state::<crate::DbState>();
    let (access_token, expires_at) = {
        let conn = db.0.lock();
        let tok = secrets::get_connector_token(&conn, connector.id, "access_token");
        let exp = db::get_connector_credential_row(&conn, connector.id)
            .ok()
            .flatten()
            .and_then(|r| r.expires_at);
        (tok, exp)
    };
    let access_token = access_token.ok_or_else(|| "connector not connected".to_string())?;

    let now = db::now_ts();
    let expired = expires_at.map_or(false, |exp| now >= exp);
    if expired {
        // Transparent refresh; if it fails, the caller surfaces the error
        // (which will tell the user to reconnect).
        return refresh_access_token(app, connector).await;
    }
    Ok(access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_and_challenge_are_url_safe_and_correct_len() {
        let v = random_pkce_verifier();
        assert!(v.len() >= 43 && v.len() <= 128);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        let c = pkce_challenge(&v);
        // S256 challenge is 32 bytes → 43 base64url chars (no padding).
        assert_eq!(c.len(), 43);
        assert!(c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }

    #[test]
    fn authorize_url_has_required_params() {
        let c = crate::connectors::NOTION;
        let url = build_authorize_url(&c, "CHALLENGE", "STATE123", "http://127.0.0.1:9876/oauth/callback");
        assert!(url.starts_with(c.authorize_url));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("owner=user")); // Notion-specific
        assert!(url.contains("code_challenge=CHALLENGE"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE123"));
    }
}
