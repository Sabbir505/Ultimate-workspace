//! OAuth 2.0 authorization-code + PKCE flow for connectors.
//!
//! Opens the vendor's OAuth authorize URL in the **system browser** (not a
//! Tauri webview — see BUILD_LOG.md for why WebView2's popup restrictions
//! break Notion's OAuth page). The redirect lands on a one-shot loopback HTTP
//! server bound to `127.0.0.1` on the connector's **fixed registered callback
//! port** (parsed from `Connector::redirect_uri`; Notion requires an exact
//! match against a pre-registered `http://localhost:<port>/…` URL and
//! rejects dynamic ports). Once the callback is captured the server shuts
//! down and token exchange proceeds as before.
//!
//! On success the resulting tokens are stored via the credential store
//! (`secrets::set_connector_token`) and the metadata row
//! (`db::upsert_connector_credential_row`).
//!
//! Everything here is generic: the per-connector endpoints, client id, and
//! redirect URI come from the `Connector` config record. Vendor-specific
//! quirks (confidential vs. public client, scope strings, revocation
//! endpoint availability) are noted per-connector in BUILD_LOG.md.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use rand::RngCore;
use tauri::{AppHandle, Emitter, Manager};

// base64 0.22 exposes encode/decode as methods on engines; the trait must be
// in scope to call them.
use base64::Engine as _;

use crate::connectors::{Connector, connector_by_id, family_members, family_redirect_uri};
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
    /// Connector ids with an OAuth flow currently in flight (browser open /
    /// loopback listener waiting on the fixed callback port). Guards against
    /// a second Connect click re-binding the port (WSAEADDRINUSE); released
    /// automatically when the flow ends, whatever the outcome.
    pending: Mutex<HashSet<String>>,
    next: AtomicU64,
}

/// Where the OAuth flow sends its result. Emitted to the
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

/// An OAuth client as known to a vendor's authorization server. Either a
/// connector's static `client_id`/`client_secret` or — when the connector
/// exposes an RFC 7591 registration endpoint — a client minted by dynamic
/// client registration. mcp.notion.com requires this: its authorize hop
/// proxies any client_id, but the callback + token hops validate the client
/// against ITS registry and reject everything else.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthClient {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    /// "none" (public client, PKCE) | "client_secret_basic" |
    /// "client_secret_post" — how token/refresh/revoke requests authenticate.
    #[serde(default = "default_auth_method")]
    pub token_endpoint_auth_method: String,
}

fn default_auth_method() -> String {
    "none".to_string()
}

/// Where dynamically registered OAuth clients are persisted (one per
/// connector), so subsequent connects reuse the same client instead of
/// minting a new one server-side each time. `<app_data_dir>/oauth-clients.json`.
fn oauth_clients_cache_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("oauth-clients.json"))
        .unwrap_or_else(|_| std::path::PathBuf::from("oauth-clients.json"))
}

fn load_cached_client(app: &AppHandle, connector_id: &str) -> Option<OAuthClient> {
    let bytes = std::fs::read(oauth_clients_cache_path(app)).ok()?;
    let map: HashMap<String, OAuthClient> = serde_json::from_slice(&bytes).ok()?;
    map.get(connector_id).cloned()
}

fn save_cached_client(app: &AppHandle, connector_id: &str, client: &OAuthClient) {
    let path = oauth_clients_cache_path(app);
    let mut map: HashMap<String, OAuthClient> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    map.insert(connector_id.to_string(), client.clone());
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(&map).unwrap_or_default());
}

/// Register an OAuth client at the connector's RFC 7591 registration endpoint
/// (or return the cached registration). The redirect_uri must match what the
/// authorize flow uses verbatim. Public client (PKCE, no secret).
pub async fn ensure_registered_client(
    app: &AppHandle,
    connector: &Connector,
) -> Result<OAuthClient, String> {
    if let Some(cached) = load_cached_client(app, connector.id) {
        return Ok(cached);
    }
    let url = connector.registration_url.ok_or_else(|| {
        format!(
            "connector `{}` has no dynamic client registration endpoint configured",
            connector.id
        )
    })?;
    let body = serde_json::json!({
        "client_name": "Conduit",
        "client_uri": "https://conduit.app",
        "redirect_uris": [connector.redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("client registration failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("registration response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("client registration HTTP {status}: {text}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("registration response not JSON: {e}"))?;
    let client = OAuthClient {
        client_id: v
            .get("client_id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "registration response missing client_id".to_string())?
            .to_string(),
        client_secret: v
            .get("client_secret")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        token_endpoint_auth_method: v
            .get("token_endpoint_auth_method")
            .and_then(|x| x.as_str())
            .unwrap_or("none")
            .to_string(),
    };
    save_cached_client(app, connector.id, &client);
    Ok(client)
}

/// The OAuth client a connector authenticates with: a dynamically registered
/// client when the connector exposes a registration endpoint (cached after
/// the first call), otherwise its static client credentials.
pub async fn resolve_oauth_client(
    app: &AppHandle,
    connector: &Connector,
) -> Result<OAuthClient, String> {
    if connector.registration_url.is_some() {
        return ensure_registered_client(app, connector).await;
    }
    resolve_static_oauth_client(connector)
}

/// Static build-time client config — no AppHandle needed, so the headless
/// `conduit-automation` binary can refresh tokens too. Dynamic-registration
/// connectors are rejected here (they need the app's DB-backed registrar).
fn resolve_static_oauth_client(connector: &Connector) -> Result<OAuthClient, String> {
    if connector.registration_url.is_some() {
        return Err(format!(
            "connector `{}` uses dynamic registration — not available headless",
            connector.id
        ));
    }
    if connector.client_id.is_empty() {
        return Err(format!(
            "connector `{}` has no client_id configured — set the build-time env vars \
             (e.g. GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) and rebuild",
            connector.id
        ));
    }
    Ok(OAuthClient {
        client_id: connector.client_id.to_string(),
        client_secret: if connector.client_secret.is_empty() {
            None
        } else {
            Some(connector.client_secret.to_string())
        },
        token_endpoint_auth_method: if connector.confidential() {
            "client_secret_basic".to_string()
        } else {
            "none".to_string()
        },
    })
}

/// Where a finished flow stores its exchanged token.
enum FlowStore<'a> {
    /// Single connector: store under `connector.id` with the token response's
    /// granted-scope string.
    One(&'a Connector),
    /// Family: store the SAME token under every member's credential row, each
    /// row displaying its own requested scope set.
    Many(&'a [&'a Connector]),
}

impl OAuthFlows {
    /// Kick off the OAuth flow for a connector: build the authorize URL (with
    /// PKCE + state), open the system browser, and await the redirect
    /// callback.
    /// Returns the flow id (so the caller can correlate the `oauth:callback`
    /// event). Completion (or error/denial) is emitted via `oauth:callback`.
    pub async fn start(&self, app: &AppHandle, connector_id: &str, flow_id: u64) -> Result<u64, String> {
        let connector = match connector_by_id(connector_id) {
            Some(c) => c,
            None => {
                let e = format!("unknown connector `{connector_id}`");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector_id.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                return Err(e);
            }
        };
        // Non-OAuth connectors have no flow to run: Kiwi's endpoint is
        // public. Surface a clear error instead of opening a blank URL.
        if connector.is_public() {
            let e = crate::connectors::config::no_oauth_flow_reason(connector);
            let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                flow_id,
                connector_id: connector.id.to_string(),
                status: "error".to_string(),
                error: Some(e.clone()),
                account_display: None,
            });
            return Err(e);
        }
        // Resolve the OAuth client BEFORE anything else: connectors with a
        // registration endpoint (Notion's MCP AS validates clients against its
        // own registry) register once here; failure means we never reach the
        // pending/port machinery.
        let client = match resolve_oauth_client(app, &connector).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[conduit:oauth] {connector_id} client resolution failed: {e}");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: connector.id.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                return Err(e);
            }
        };

        self.run_flow(
            app,
            flow_id,
            connector.id,
            &connector,
            &client,
            connector.redirect_uri,
            connector.scopes,
            FlowStore::One(&connector),
        )
        .await
    }

    /// Family variant of [`Self::start`]: ONE authorize/exchange flow for the
    /// whole product family (Google: a single consent screen covering every
    /// member's scopes), then the resulting token is stored under EACH
    /// member's credential row — one "Connect" click connects the entire
    /// family. The `oauth:callback` event carries the family id (e.g.
    /// "google") as `connector_id`. `flow_id` is allocated ONCE by the caller
    /// ([`Self::next_id`]), same contract as [`Self::start`].
    pub async fn start_family(&self, app: &AppHandle, family: &str, flow_id: u64) -> Result<u64, String> {
        let members = match family_members(family) {
            Some(m) => m,
            None => {
                let e = format!("unknown connector family `{family}`");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: family.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                return Err(e);
            }
        };
        let head = members[0];
        // All family members share one OAuth client/consent (Google desktop
        // app client), so resolving the head covers every member.
        let client = match resolve_oauth_client(app, head).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[conduit:oauth] {family} client resolution failed: {e}");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: family.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                return Err(e);
            }
        };
        // Combined scope set: every member's scopes in one consent screen.
        let scopes = members
            .iter()
            .filter_map(|m| (!m.scopes.is_empty()).then_some(m.scopes))
            .collect::<Vec<_>>()
            .join(" ");
        // `family_redirect_uri` is registered for every family `family_members`
        // knows about — they are kept in sync in config.rs.
        let redirect_uri = family_redirect_uri(family)
            .expect("family registered with redirect uri");
        self.run_flow(
            app,
            flow_id,
            family,
            head,
            &client,
            redirect_uri,
            &scopes,
            FlowStore::Many(members),
        )
        .await
    }

    /// Shared flow machinery for both [`Self::start`] (single connector) and
    /// [`Self::start_family`] (all members of a family at once): pending
    /// guard, PKCE + state, loopback callback server, browser, callback wait,
    /// token exchange, and storage (per `store`). `key` is what the
    /// `oauth:callback` event and pending-guard error messages report (a
    /// connector id, or the family id for family flows). `flow_id` is the id
    /// the caller allocated via [`Self::next_id`] — this function never
    /// allocates one itself, so the command's returned id always matches the
    /// id in the emitted `oauth:callback` events.
    #[allow(clippy::too_many_arguments)]
    async fn run_flow(
        &self,
        app: &AppHandle,
        flow_id: u64,
        key: &str,
        connector: &Connector,
        client: &OAuthClient,
        redirect_uri: &'static str,
        scopes: &str,
        store: FlowStore<'_>,
    ) -> Result<u64, String> {
        // One flow per connector/family at a time: the callback server binds a
        // FIXED port, so a second Connect while one is pending cannot bind.
        // Surface a clear error instead of the OS EADDRINUSE.
        {
            let mut pending = self.pending.lock();
            if pending.contains(key) {
                let e = format!(
                    "an authorization flow for `{key}` is already in progress — finish it \
                     in the browser or wait for it to time out (5 minutes), then try again"
                );
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: key.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                return Err(e);
            }
            pending.insert(key.to_string());
        }
        // RAII release of the pending marker on ANY exit from this flow
        // (callback, denial, timeout, bind failure — all of them).
        struct FlowActive<'a>(&'a OAuthFlows, String);
        impl Drop for FlowActive<'_> {
            fn drop(&mut self) {
                self.0.pending.lock().remove(&self.1);
            }
        }
        let _active = FlowActive(self, key.to_string());

        let code_verifier = random_pkce_verifier();
        let code_challenge = pkce_challenge(&code_verifier);
        let state = format!("flow-{flow_id}-{:016x}", rand::random::<u64>());
        eprintln!(
            "[conduit:oauth] flow {flow_id} start key={key} client_id={} method={}",
            client.client_id, client.token_endpoint_auth_method
        );
        // Register the pending flow so accept_one_callback can validate the
        // returned `state` parameter against what we sent.
        {
            let mut flows = self.flows.lock();
            flows.insert(state.clone(), PendingFlow {
                code_verifier: code_verifier.clone(),
                state: state.clone(),
            });
        }

        // The connector's `redirect_uri` doubles as the callback server
        // config: it must be an `http://localhost:<fixed-port>/…` URL that is
        // also registered verbatim with the vendor (Notion does strict string
        // matching and rejects dynamic/unregistered loopback ports). Family
        // flows use the family's own fixed-port URI.
        let port = loopback_callback_port(redirect_uri).ok_or_else(|| {
            let e = format!(
                "connector `{}` redirect_uri `{redirect_uri}` is not a loopback http URL — \
                 register an `http://localhost:<fixed-port>/…` callback with the vendor",
                connector.id
            );
            let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                flow_id,
                connector_id: key.to_string(),
                status: "error".to_string(),
                error: Some(e.clone()),
                account_display: None,
            });
            e
        })?;
        // Bind with a short retry loop: right after a previous flow's
        // listener closes, Windows may briefly hold the port (transient
        // WSAEADDRINUSE) — retry rather than fail the click.
        let mut listener = None;
        let mut last_err = String::new();
        for _ in 0..5 {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(l) => {
                    listener = Some(l);
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if e.kind() != std::io::ErrorKind::AddrInUse {
                        break;
                    }
                    // mi14: tokio sleep — std::thread::sleep blocks the
                    // runtime worker thread for 250 ms per retry.
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
        let Some(listener) = listener else {
            eprintln!("[conduit:oauth] flow {flow_id} bind failed on 127.0.0.1:{port}: {last_err}");
            let msg = format!(
                "failed to bind OAuth callback server on 127.0.0.1:{port} \
                 (redirect_uri `{redirect_uri}`) — close the app holding the port and retry: {last_err}"
            );
            let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                flow_id,
                connector_id: key.to_string(),
                status: "error".to_string(),
                error: Some(msg.clone()),
                account_display: None,
            });
            return Err(msg);
        };

        let authorize_url = build_authorize_url(
            connector,
            &client.client_id,
            &code_challenge,
            &state,
            redirect_uri,
            scopes,
        );
        eprintln!(
            "[conduit:oauth] flow {flow_id} listener bound on 127.0.0.1:{port}; opening browser"
        );

        if let Err(e) = open::that(&authorize_url) {
            eprintln!("[conduit:oauth] flow {flow_id} open::that failed: {e}");
            self.cancel(flow_id);
            let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                flow_id,
                connector_id: key.to_string(),
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
            Ok(Ok(Ok(c))) => {
                eprintln!("[conduit:oauth] flow {flow_id} callback received (code len {})", c.len());
                c
            }
            Ok(Ok(Err(msg))) => {
                eprintln!("[conduit:oauth] flow {flow_id} callback error: {msg}");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: key.to_string(),
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
                    connector_id: key.to_string(),
                    status: "error".to_string(),
                    error: Some(msg.clone()),
                    account_display: None,
                });
                return Err(msg);
            }
            Err(_elapsed) => {
                eprintln!("[conduit:oauth] flow {flow_id} timed out waiting for callback (5 min)");
                // The spawn_blocking acceptor can't be cancelled and still
                // owns the listener — without a nudge it blocks in accept()
                // until app exit, holding the port so every later Connect
                // fails with AddrInUse (M15). Poke it so it wakes, fails
                // state validation, and drops the listener.
                unblock_acceptor_async(port).await;
                let msg = "Authorization timed out — no callback received within 5 minutes. Please try Connect again.".to_string();
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: key.to_string(),
                    status: "error".to_string(),
                    error: Some(msg.clone()),
                    account_display: None,
                });
                return Err(msg);
            }
        };

        // Exchange once, then store per `store`: one connector (with the
        // response's granted scopes) or every family member (each row shows
        // the scopes its own server needs; the token carries the full grant).
        //
        // The `?` operators live inside an async block so an exchange/store
        // failure lands in `exchanged` as an Err — the match below logs it and
        // emits the `oauth:callback` error event. (Before this, a `?` here
        // returned straight out of `run_flow` and the failure died silently:
        // no event, no log, keychain/DB untouched — exactly the first GitHub
        // connect failure.)
        let exchanged: Result<Option<String>, String> = (async {
            match &store {
                FlowStore::One(_) => {
                    let token =
                        exchange_token(connector, client, &code, &code_verifier, redirect_uri)
                            .await?;
                    let display = token.granted_scopes.clone();
                    store_exchanged(app, connector.id, &token, display.as_deref())?;
                    Ok(token.account_display)
                }
                FlowStore::Many(members) => {
                    let token =
                        exchange_token(connector, client, &code, &code_verifier, redirect_uri)
                            .await?;
                    let account_display = token.account_display.clone();
                    for m in *members {
                        let display = if m.scopes.is_empty() {
                            token.granted_scopes.clone()
                        } else {
                            Some(m.scopes.to_string())
                        };
                        store_exchanged(app, m.id, &token, display.as_deref())?;
                    }
                    Ok(account_display)
                }
            }
        })
        .await;
        match exchanged {
            Ok(account_display) => {
                eprintln!("[conduit:oauth] flow {flow_id} exchange OK, account={account_display:?}");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: key.to_string(),
                    status: "connected".to_string(),
                    error: None,
                    account_display,
                });
                Ok(flow_id)
            }
            Err(e) => {
                eprintln!("[conduit:oauth] flow {flow_id} exchange FAILED: {e}");
                let _ = app.emit("oauth:callback", OAuthCallbackEvent {
                    flow_id,
                    connector_id: key.to_string(),
                    status: "error".to_string(),
                    error: Some(e.clone()),
                    account_display: None,
                });
                Err(e)
            }
        }
    }

    /// Allocate the next flow id. The command layer calls this BEFORE
    /// spawning `start`/`start_family` so it can return an id immediately;
    /// the SAME id is then threaded through the flow and lands in every
    /// `oauth:callback` event. It must allocate atomically (fetch_add): a
    /// plain load would hand the SAME id to two concurrent Connect commands
    /// while their flows later fetched different ones — the events would no
    /// longer correlate with the id the UI holds (M27).
    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
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
/// Nudge a leaked loopback acceptor so it finishes (M15): connect and send
/// one throwaway request line. The acceptor's accept()+read_line return, the
/// request fails state validation (it carries no OAuth `state`), it writes
/// its 400 and returns — dropping the listener and freeing the port. Without
/// this a timed-out flow leaks the bound port until app restart because
/// `spawn_blocking` cannot be cancelled.
// Sync variant retained for the test at the bottom of this file (which has no
// runtime); production call sites use unblock_acceptor_async.
#[allow(dead_code)]
fn unblock_acceptor(port: u16) {
    if let Ok(mut s) = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)) {
        let _ = s.write_all(b"GET /conduit-timeout HTTP/1.0\r\n\r\n");
        let _ = s.flush();
    }
}

/// Async variant for async call sites (PERFORMANCE_AUDIT.md B5): the sync
/// `std::net::TcpStream::connect` above blocks the calling runtime thread for
/// the duration of the TCP handshake. Usually ~1 ms to localhost, but a
/// stuck loopback stack (VPN/filter driver) can stall it much longer.
async fn unblock_acceptor_async(port: u16) {
    use tokio::io::AsyncWriteExt;
    if let Ok(mut s) = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await {
        let _ = s.write_all(b"GET /conduit-timeout HTTP/1.0\r\n\r\n").await;
        let _ = s.flush().await;
    }
}

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
    eprintln!("[conduit:oauth] callback request: {path}");

    let query: HashMap<String, String> = url::form_urlencoded::parse(query_str.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    // Validate the state parameter to prevent CSRF (RFC 6749 §10.12). Notion's
    // MCP AS echoes our state back RAW on the final redirect, but on some
    // paths wraps it in a base64url JSON envelope
    // (`{"responseType":"code","state":"<our state>"...}`) — accept either so
    // the flow survives whatever Notion emits.
    let returned_state = query.get("state").cloned().unwrap_or_default();
    let state_matches = |candidate: &str| {
        if candidate == expected_state {
            return true;
        }
        match base64url_decode(candidate) {
            Some(json) => serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(|s| s.to_string()))
                .map(|s| s == expected_state)
                .unwrap_or(false),
            None => false,
        }
    };
    if !state_matches(&returned_state) {
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
        ("Authorization denied", format!("The authorization was denied. Reason: {}",
            html_escape(err)))
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

/// Minimal HTML-entity escaper for the OAuth callback page. Replaces the five
/// characters that can break out of element / attribute / script context.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Build the authorization URL: vendor endpoint + client_id + redirect_uri +
/// response_type=code + state + (PKCE) code_challenge/code_challenge_method.
/// `scopes` is explicit (not `c.scopes`) so a FAMILY flow can send the combined
/// scope set of every member in one consent screen.
fn build_authorize_url(
    c: &Connector,
    client_id: &str,
    code_challenge: &str,
    state: &str,
    redirect_uri: &str,
    scopes: &str,
) -> String {
    let mut url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&state={}",
        c.authorize_url,
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state),
    );
    if c.id == "notion" {
        url.push_str("&owner=user");
        // RFC 8707 resource indicator: mcp.notion.com's OAuth server mints
        // tokens scoped to its MCP resource — without this the flow may fail.
        url.push_str(&format!("&resource={}", urlencoding::encode(c.mcp_server_url)));
    }
    if c.is_google() {
        // Google: `access_type=offline` is required or no refresh token is
        // issued; `prompt=consent` forces the consent screen every time so a
        // refresh token is guaranteed even on repeat connects. Applies to
        // every Google Workspace MCP connector (gmail + drive/docs/sheets/
        // slides/calendar/chat/people) — all share `is_google()`.
        url.push_str("&access_type=offline&prompt=consent");
    }
    if !scopes.is_empty() {
        url.push_str(&format!("&scope={}", urlencoding::encode(scopes)));
    }
    url.push_str(&format!(
        "&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(code_challenge)
    ));
    url
}

/// The port a connector's `redirect_uri` binds its loopback callback server
/// to. Only `http://localhost:<port>/…`, `http://127.0.0.1:<port>/…`, and
/// `http://[::1]:<port>/…` are accepted — Notion requires a FIXED port that
/// is pre-registered verbatim (no dynamic ports, no `https://` sentinels).
pub(crate) fn loopback_callback_port(uri: &str) -> Option<u16> {
    let rest = uri.strip_prefix("http://")?;
    let host = rest.split('/').next()?;
    let (host, port) = host.rsplit_once(':')?;
    if !(host == "localhost" || host == "127.0.0.1" || host == "[::1]") {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(port)
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

/// Decode a base64url (no padding) string to UTF-8, if possible. Used to
/// unwrap Notion's MCP AS state envelope on the OAuth callback.
fn base64url_decode(s: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()?;
    String::from_utf8(bytes).ok()
}


/// A token + metadata parsed from a token-endpoint response, before storage.
struct ExchangedToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
    granted_scopes: Option<String>,
    account_display: Option<String>,
}

/// Exchange the authorization code at the connector's token endpoint. The
/// request shape depends on the OAuth client type:
/// - "none" (public, PKCE — Notion's MCP AS): form-encoded body with
///   `client_id`; the AS REJECTS JSON bodies (`invalid_request:
///   Content-Type must be application/x-www-form-urlencoded`).
/// - "client_secret_basic"/"client_secret_post": Basic header or body secret.
/// The response shape is vendor-specific; Notion's MCP AS returns
/// `access_token` + rotating `refresh_token` + `expires_in` (~1 hour).
async fn exchange_token(
    connector: &Connector,
    client: &OAuthClient,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ExchangedToken, String> {
    let http = reqwest::Client::new();
    let mut req = http.post(connector.token_url);
    // GitHub's OAuth App token endpoint returns `application/x-www-form-urlencoded`
    // unless the client explicitly asks for JSON (verified live: the first
    // GitHub connect returned `access_token=…&scope=…&token_type=bearer` and
    // silently failed the JSON parse). The header is harmless for every other
    // vendor (they return JSON regardless).
    req = req.header(reqwest::header::ACCEPT, "application/json");

    match client.token_endpoint_auth_method.as_str() {
        "client_secret_basic" => {
            // Basic auth header + form-encoded body (RFC 6749 §2.3.1): this is
            // what Google's token endpoint accepts (it rejects JSON bodies).
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", client.client_id, client.client_secret.as_deref().unwrap_or("")));
            req = req
                .header("Authorization", format!("Basic {basic}"))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    ("redirect_uri", redirect_uri),
                    ("client_id", client.client_id.as_str()),
                    ("code_verifier", code_verifier),
                ]);
        }
        "client_secret_post" => {
            let mut params = vec![
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", client.client_id.as_str()),
                ("code_verifier", code_verifier),
            ];
            if let Some(secret) = &client.client_secret {
                params.push(("client_secret", secret));
            }
            req = req.form(&params);
        }
        _ => {
            // Public client (PKCE-only): client_id in the body, form-encoded.
            req = req.form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", client.client_id.as_str()),
                ("code_verifier", code_verifier),
            ]);
        }
    }

    let resp = req.send().await.map_err(|e| format!("token exchange failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("token response read failed: {e}"))?;
    // Never log the response body: on success it contains live access/refresh
    // tokens. Log only the connector id and status code.
    eprintln!("[conduit:oauth] token exchange {} {status}", connector.id);
    if !status.is_success() {
        return Err(format!("token exchange HTTP {status}: {body}"));
    }

    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        // GitHub-style fallback: vendors whose token endpoint returns
        // form-urlencoded even when `Accept: application/json` is sent.
        Err(_) => parse_form_body(&body)?,
    };

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

    Ok(ExchangedToken {
        access_token,
        refresh_token,
        expires_at: expires_in.map(|secs| crate::db::now_ts() + secs),
        granted_scopes,
        account_display,
    })
}

/// Parse a form-urlencoded token response (GitHub's OAuth App token endpoint
/// returns `application/x-www-form-urlencoded` unless the client sends
/// `Accept: application/json`) into the same JSON-object shape the rest of
/// the token pipeline expects. Percent-decodes both keys and values.
fn parse_form_body(body: &str) -> Result<serde_json::Value, String> {
    let mut map = serde_json::Map::new();
    for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
        map.insert(k.into_owned(), serde_json::Value::String(v.into_owned()));
    }
    if map.is_empty() {
        return Err(format!("token response is neither JSON nor form-encoded: {body}"));
    }
    Ok(serde_json::Value::Object(map))
}

/// Persist an exchanged token for one connector: tokens in the keychain,
/// metadata in the SQLite row. `display_scopes` is what the Settings UI shows
/// for that connector's "Scopes:" line — the response's granted scope string
/// for single-connector flows, or the member's own requested scopes for family
/// rows (the token itself always carries the full combined grant).
fn store_exchanged(
    app: &AppHandle,
    connector_id: &str,
    token: &ExchangedToken,
    display_scopes: Option<&str>,
) -> Result<(), String> {
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let now = crate::db::now_ts();

    eprintln!("[conduit:oauth] store_exchanged {connector_id}: keychain access_token");
    secrets::set_connector_token(&conn, connector_id, "access_token", &token.access_token)?;
    if let Some(ref rt) = token.refresh_token {
        eprintln!("[conduit:oauth] store_exchanged {connector_id}: keychain refresh_token");
        secrets::set_connector_token(&conn, connector_id, "refresh_token", rt)?;
    } else {
        // No refresh token — clear any stale one so we don't try to refresh
        // with a token from a previous connection.
        let _ = secrets::delete_connector_tokens(&conn, connector_id);
        secrets::set_connector_token(&conn, connector_id, "access_token", &token.access_token)?;
    }
    eprintln!("[conduit:oauth] store_exchanged {connector_id}: credential row");
    db::upsert_connector_credential_row(
        &conn,
        connector_id,
        token.expires_at,
        display_scopes,
        token.account_display.as_deref(),
        now,
    )
    .map_err(|e| e.to_string())?;
    eprintln!("[conduit:oauth] store_exchanged {connector_id}: done");

    Ok(())
}

/// Single-flight guards for token refresh (M16): concurrent refreshes of the
/// same connector would each present the SAME old refresh token — vendors
/// that rotate refresh tokens (Google, GitHub) invalidate it on first use,
/// so the loser gets `invalid_grant` (spurious disconnect) or, racing the
/// other way, persists an already-invalidated token over the fresh one.
/// BTreeMap only because `BTreeMap::new` is const.
static REFRESH_LOCKS: Mutex<
    BTreeMap<&'static str, std::sync::Arc<tokio::sync::Mutex<()>>>,
> = Mutex::new(BTreeMap::new());

fn refresh_lock_for(connector_id: &'static str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    REFRESH_LOCKS
        .lock()
        .entry(connector_id)
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Refresh an expired access token using the stored refresh token. Returns the
/// new access token. Best-effort: vendors that don't issue refresh tokens
/// (Notion, per docs) will return Err here and the caller should prompt the
/// user to reconnect rather than retry silently.
pub async fn refresh_access_token(
    app: &AppHandle,
    connector: &Connector,
) -> Result<String, String> {
    let client = resolve_oauth_client(app, connector).await?;
    let db = std::sync::Arc::clone(&app.state::<crate::DbState>().0);
    refresh_access_token_inner(&db, connector, &client).await
}

/// Headless variant for the `conduit-automation` binary (no AppHandle): uses
/// the static build-time client config. Dynamic-registration connectors error
/// out — none of them support unattended runs today.
pub async fn refresh_access_token_headless(
    db: &std::sync::Arc<Mutex<rusqlite::Connection>>,
    connector: &Connector,
) -> Result<String, String> {
    let client = resolve_static_oauth_client(connector)?;
    refresh_access_token_inner(db, connector, &client).await
}

async fn refresh_access_token_inner(
    db: &std::sync::Arc<Mutex<rusqlite::Connection>>,
    connector: &Connector,
    client: &OAuthClient,
) -> Result<String, String> {
    // Hold the per-connector single-flight for the whole read → HTTP → store
    // cycle (M16). The refresh token is read AFTER acquiring the lock so a
    // queued caller picks up the token the previous holder just stored — not
    // the invalidated predecessor it raced with.
    let refresh_lock = refresh_lock_for(connector.id);
    let _refresh_guard = refresh_lock.lock().await;
    let refresh_token = {
        let conn = db.lock();
        secrets::get_connector_token(&conn, connector.id, "refresh_token")
    }
    .ok_or_else(|| "no refresh token stored — reconnect required".to_string())?;

    let http = reqwest::Client::new();
    let mut req = http.post(connector.token_url);
    // Same Accept header as the exchange: a vendor that honors it returns
    // JSON here too.
    req = req.header(reqwest::header::ACCEPT, "application/json");

    match client.token_endpoint_auth_method.as_str() {
        "client_secret_basic" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", client.client_id, client.client_secret.as_deref().unwrap_or("")));
            req = req
                .header("Authorization", format!("Basic {basic}"))
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token.as_str()),
                    ("client_id", client.client_id.as_str()),
                ]);
        }
        "client_secret_post" => {
            let mut params = vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token.as_str()),
                ("client_id", client.client_id.as_str()),
            ];
            if let Some(secret) = &client.client_secret {
                params.push(("client_secret", secret));
            }
            req = req.form(&params);
        }
        _ => {
            // Public client: client_id in the body, form-encoded.
            req = req.form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token.as_str()),
                ("client_id", client.client_id.as_str()),
            ]);
        }
    }

    let resp = req.send().await.map_err(|e| format!("refresh failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("refresh response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("refresh HTTP {status}: {body}"));
    }
    let json: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => parse_form_body(&body)?,
    };

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

    let conn = db.lock();
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

    // Public connectors (Kiwi.com) have no token: return an empty string and
    // `mcp::connect` sends no auth header for it. Everyone else must have a
    // stored OAuth token.
    if connector.is_public() {
        return Ok(String::new());
    }

    match current_access_token(&app.state::<crate::DbState>().0, connector.id)? {
        Some(token) => Ok(token),
        // Transparent refresh; if it fails, the caller surfaces the error
        // (which will tell the user to reconnect).
        None => refresh_access_token(app, connector).await,
    }
}

/// Headless variant for the `conduit-automation` binary: same semantics as
/// `ensure_valid_access_token` but takes the raw DB handle so no Tauri
/// runtime is required. Used by automation failure emails.
pub async fn ensure_valid_access_token_with_db(
    db: &std::sync::Arc<Mutex<rusqlite::Connection>>,
    connector_id: &str,
) -> Result<String, String> {
    let connector = connector_by_id(connector_id)
        .ok_or_else(|| format!("unknown connector `{connector_id}`"))?;
    if connector.is_public() {
        return Ok(String::new());
    }
    match current_access_token(db, connector.id)? {
        Some(token) => Ok(token),
        None => refresh_access_token_headless(db, connector).await,
    }
}

/// The stored access token when present and unexpired; None when a refresh is
/// needed. Err only when the connector was never connected.
fn current_access_token(
    db: &std::sync::Arc<Mutex<rusqlite::Connection>>,
    connector_id: &str,
) -> Result<Option<String>, String> {
    let (access_token, expires_at) = {
        let conn = db.lock();
        let tok = secrets::get_connector_token(&conn, connector_id, "access_token");
        let exp = db::get_connector_credential_row(&conn, connector_id)
            .ok()
            .flatten()
            .and_then(|r| r.expires_at);
        (tok, exp)
    };
    let access_token = access_token.ok_or_else(|| "connector not connected".to_string())?;
    let now = db::now_ts();
    let expired = expires_at.map_or(false, |exp| now >= exp);
    Ok(if expired { None } else { Some(access_token) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_encoded_token_response_parses_like_json() {
        // The EXACT body GitHub's OAuth App token endpoint returned for the
        // first live GitHub connect (form-urlencoded, percent-encoded scope):
        // parsing it as JSON fails, which used to kill the whole flow silently.
        let body = "access_token=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&scope=read%3Aorg%2Cread%3Auser%2Crepo%2Cuser%3Aemail&token_type=bearer";
        let v = parse_form_body(body).expect("form body parses");
        assert_eq!(
            v["access_token"].as_str(),
            Some("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")
        );
        assert_eq!(
            v["scope"].as_str(),
            Some("read:org,read:user,repo,user:email") // percent-decoded
        );
        assert_eq!(v["token_type"].as_str(), Some("bearer"));
        // A garbage body is a clear error, not a silently swallowed parse.
        assert!(parse_form_body("").is_err());
        assert!(parse_form_body("&&&").is_err());
    }

    #[test]
    fn unblock_acceptor_ends_the_accept_loop_and_frees_the_port() {
        // M15: a timed-out flow leaves accept_one_callback blocked in a
        // spawn_blocking that owns the listener. The poke must wake it, fail
        // state validation, and let the listener drop — so the port can be
        // bound again immediately.
        std::thread::scope(|scope| {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            // The closure OWNS the listener (mirrors production, where the
            // spawn_blocking owns it): when the acceptor returns, the
            // listener drops inside the thread and the port is freed.
            let acceptor = scope.spawn(move || accept_one_callback(&listener, "expected-state"));
            // Give the acceptor a beat to block in accept().
            std::thread::sleep(std::time::Duration::from_millis(100));

            unblock_acceptor(port);

            let result = acceptor
                .join()
                .expect("acceptor must finish after the poke — without M15 it hangs forever");
            assert!(result.is_err(), "throwaway request must fail state validation");
            // The port is bindable again right away.
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .expect("port must be freed once the acceptor returns");
        });
    }

    #[test]
    fn refresh_lock_is_shared_per_connector() {
        // M16: the single-flight map must hand the SAME lock to concurrent
        // refreshes of one connector and distinct locks to distinct
        // connectors.
        let a1 = refresh_lock_for("m16_test_a");
        let a2 = refresh_lock_for("m16_test_a");
        let b = refresh_lock_for("m16_test_b");
        assert!(std::sync::Arc::ptr_eq(&a1, &a2), "same connector → same lock");
        assert!(!std::sync::Arc::ptr_eq(&a1, &b), "distinct connectors → distinct locks");
    }

    #[test]
    fn next_id_allocates_unique_ids_under_concurrency() {
        // M27: next_id used to be a plain load(), so two concurrent Connect
        // commands could return the SAME id while their flows later allocated
        // different ones in run_flow — the `oauth:callback` events then no
        // longer correlated with the id the UI was holding. It must allocate
        // atomically: every call returns a distinct id.
        let flows = std::sync::Arc::new(OAuthFlows::default());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let f = flows.clone();
            handles.push(std::thread::spawn(move || {
                (0..100).map(|_| f.next_id()).collect::<Vec<u64>>()
            }));
        }
        let mut ids: Vec<u64> = handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "next_id must never hand out a duplicate id");
    }

    #[test]
    fn pkce_verifier_and_challenge_are_url_safe_and_correct_len() {        let v = random_pkce_verifier();
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
        let url = build_authorize_url(&c, "CLIENT_ID", "CHALLENGE", "STATE123", "http://127.0.0.1:9876/oauth/callback", c.scopes);
        assert!(url.starts_with(c.authorize_url));
        assert!(url.contains("client_id=CLIENT_ID"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("owner=user")); // Notion-specific
        assert!(url.contains("resource=https%3A%2F%2Fmcp.notion.com%2Fmcp")); // RFC 8707 resource indicator
        assert!(url.contains("code_challenge=CHALLENGE"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE123"));
    }

    #[test]
    fn gmail_authorize_url_has_google_params() {
        let g = crate::connectors::GMAIL;
        let url = build_authorize_url(&g, "CLIENT_ID", "CHALLENGE", "STATE123", "http://127.0.0.1:45124/oauth/callback", g.scopes);
        assert!(url.contains("access_type=offline")); // refresh token required
        assert!(url.contains("prompt=consent")); // re-consent every time
        assert!(url.contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn workspace_authorize_url_has_google_params() {
        // Every Google Workspace MCP connector must get the offline/consent
        // extras via `is_google()`, not a gmail-only id check.
        for c in [
            crate::connectors::GOOGLE_DOCS,
            crate::connectors::GOOGLE_CALENDAR,
            crate::connectors::GOOGLE_DRIVE,
        ] {
            let url = build_authorize_url(&c, "CLIENT_ID", "CHALLENGE", "STATE123", c.redirect_uri, c.scopes);
            assert!(url.contains("access_type=offline"), "{}", c.id);
            assert!(url.contains("prompt=consent"), "{}", c.id);
            assert!(
                url.contains("scope=") && url.contains("googleapis.com%2Fauth"),
                "{}: scope parameter required",
                c.id
            );
        }
    }

    #[test]
    fn family_authorize_url_combines_all_member_scopes() {
        // The family flow sends ONE consent screen with every member's scopes.
        let members = crate::connectors::config::family_members("google").expect("google family");
        let head = members[0];
        let scopes = members
            .iter()
            .filter_map(|m| (!m.scopes.is_empty()).then_some(m.scopes))
            .collect::<Vec<_>>()
            .join(" ");
        let redirect_uri = crate::connectors::config::family_redirect_uri("google")
            .expect("family redirect uri");
        let url = build_authorize_url(head, "CLIENT_ID", "CHALLENGE", "STATE123", redirect_uri, &scopes);
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        // Every member's scope set must be present in the combined parameter.
        for m in members {
            if !m.scopes.is_empty() {
                assert!(
                    url.contains(urlencoding::encode(m.scopes).as_ref()),
                    "{}: scope `{}` must be in the family authorize URL",
                    m.id,
                    m.scopes
                );
            }
        }
        // The family flow uses the family's own loopback callback URI.
        assert!(url.contains(urlencoding::encode(redirect_uri).as_ref()));
    }

    #[test]
    fn state_envelope_is_unwrapped_for_validation() {
        // Notion's MCP AS wraps our raw state in a base64url JSON envelope on
        // some callback paths — `base64url_decode` + the envelope's `state`
        // field must round-trip our raw value.
        let raw = "flow-1-deadbeef";
        let envelope = serde_json::json!({
            "responseType": "code",
            "clientId": "OfDxuQk3rjkepSlg",
            "state": raw,
            "codeChallengeMethod": "S256",
        });
        let b64 = base64url_no_pad(envelope.to_string().as_bytes());
        let decoded = base64url_decode(&b64).expect("decodable");
        let parsed = serde_json::from_str::<serde_json::Value>(&decoded).expect("valid json");
        let state = parsed
            .get("state")
            .and_then(|s| s.as_str())
            .expect("state present");
        assert_eq!(state, raw);
        // Garbage must not decode.
        assert!(base64url_decode("!!!not-base64!!!").is_none());
    }

    #[test]
    fn loopback_port_parsed_from_connector_redirect_uri() {
        // Notion's registered redirect URI is a fixed-port localhost URL — the
        // callback server binds this exact port (Notion rejects dynamic
        // ports; strict string matching).
        assert_eq!(
            loopback_callback_port(crate::connectors::NOTION.redirect_uri),
            Some(crate::connectors::NOTION_CALLBACK_PORT)
        );
        assert_eq!(loopback_callback_port("http://127.0.0.1:9876/oauth/callback"), Some(9876));
        assert_eq!(loopback_callback_port("http://[::1]:9876/callback"), Some(9876));
        // Non-loopback hosts / sentinels / missing or zero ports are rejected.
        assert_eq!(loopback_callback_port("https://conduit.local/oauth/callback"), None);
        assert_eq!(loopback_callback_port("http://localhost/oauth/callback"), None);
        assert_eq!(loopback_callback_port("http://example.com:9876/callback"), None);
    }
}
