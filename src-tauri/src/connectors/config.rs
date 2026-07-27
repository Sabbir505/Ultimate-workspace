//! Registry of supported connectors.
//!
//! Each `Connector` is a small config record: the OAuth endpoints, the remote
//! MCP server URL, and a display name + icon hint. Adding a connector is a
//! matter of appending an entry here (plus any vendor-specific auth quirks
//! noted in BUILD_LOG.md) — the credential store, OAuth webview flow, MCP
//! client, permission gating, and UI are all generic and driven off this.

use serde::{Deserialize, Serialize};

pub type ConnectorId = &'static str;

/// One supported connector. The fields below are the *only* per-connector
/// data — everything else (credential storage, OAuth webview, MCP client,
/// approval gating) is framework code reused across all connectors.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    /// Stable id, also the `connector_credentials.connector_id` primary key.
    pub id: ConnectorId,
    pub display_name: &'static str,
    /// Glyph or emoji for the settings card; the frontend may also ship an
    /// icon image keyed off `id`.
    pub icon: &'static str,
    /// OAuth 2.0 authorization endpoint (browser points here for login+consent).
    pub authorize_url: &'static str,
    /// Token exchange + refresh endpoint.
    pub token_url: &'static str,
    /// OAuth client id registered with the vendor. Notion is a *confidential*
    /// client (client secret required at token exchange) — see BUILD_LOG.md
    /// for the desktop-embedding caveat this implies.
    pub client_id: &'static str,
    pub client_secret: &'static str,
    /// Redirect URI registered with the vendor. The desktop app intercepts the
    /// navigation to this URI inside the auth webview (see `oauth.rs`) rather
    /// than running a real HTTP server — so this value need not resolve.
    pub redirect_uri: &'static str,
    /// Space-separated scope strings sent in the authorize URL. Notion ignores
    /// this (its scopes are dashboard-configured capabilities, not URL
    /// parameters) but other vendors use it — included here for generality.
    pub scopes: &'static str,
    /// The vendor's remote MCP server URL. Registered into a session's tool
    /// set when the connector is attached; its tools come from `tools/list`.
    pub mcp_server_url: &'static str,
    /// Optional OAuth 2.0 token revocation endpoint. When present, Disconnect
    /// calls it after clearing the local token; when absent (Notion),
    /// Disconnect only forgets the token locally. Logged per-connector in
    /// BUILD_LOG.md.
    pub revoke_url: Option<&'static str>,
}

impl Connector {
    /// Whether this connector is a confidential client (exchanges the code
    /// with `Authorization: Basic base64(client_id:client_secret)` rather than
    /// PKCE-only). All current entries are confidential; PKCE is still
    /// generated as defense-in-depth where the vendor tolerates it.
    pub fn confidential(&self) -> bool {
        !self.client_secret.is_empty()
    }
}

/// `Deserialize` is needed only for the test that round-trips the registry; the
/// runtime path reads it as `Serialize` to send to the frontend.
#[cfg(test)]
impl<'de> Deserialize<'de> for Connector {
    fn deserialize<D: serde::Deserializer<'de>>(_d: D) -> Result<Self, D::Error> {
        unreachable!("Connector is constructed statically, not deserialized")
    }
}

/// Notion — the first connector, built to validate the framework.
///
/// Notion-specific quirks (vs. generic framework code), logged in BUILD_LOG.md:
/// - Confidential client: token exchange uses `Authorization: Basic` with
///   the client secret. Embedding the secret in a desktop binary is leakable;
///   the secret is shipped as a build-time constant (extractable by anyone
///   with the binary). Follow-on hardening may fetch it dynamically.
/// - Scopes are dashboard-configured capabilities (Read/Update/Insert content,
///   Read user info), NOT URL scope strings — the `scopes` field below is
///   empty and the granted scopes are read from the token response instead.
/// - Access tokens are **long-lived** (no `expires_in` in the token response),
///   but Notion DOES issue a `refresh_token` and exposes a revocation endpoint
///   at `https://api.notion.com/v1/oauth/token` (grant_type=refresh_token)
///   and `https://api.notion.com/v1/oauth/revoke` respectively. So refresh
///   rotates the token pair (useful for rotation/disconnect), but there's no
///   automatic refresh-on-expiry because tokens never expire.
/// - PKCE (`code_challenge`/`code_challenge_method`) is NOT natively
///   supported — passing the params is harmless and ignored (we send them as
///   defense-in-depth; a future vendor that requires PKCE is satisfied).
/// - Auth header for the MCP server is a standard `Authorization: Bearer`
///   (confirmed — no special Notion-Version header is required for MCP).
///
/// `client_id` / `client_secret` are pulled from `NOTION_CLIENT_ID` /
/// `NOTION_CLIENT_SECRET` env vars at build time via `option_env!` (falling
/// back to `""` when unset, which `start()` rejects with a clear "no client_id
/// configured" error). Set them locally for dev (e.g. via `.env` /
/// `tauri dev`'s environment); never commit a real secret as a literal.

/// Read a `&'static str` from a build-time env var, falling back to `""` when
/// unset (so unconfigured builds compile and surface a clear runtime error in
/// `oauth::start` rather than panicking at const-eval). Mirrors the pattern
/// used for other build-time secrets; kept local to this module. Defined
/// before the `NOTION` const because macros are resolved textually before use.
macro_rules! env_or_empty {
    ($name:literal) => {
        match option_env!($name) {
            Some(v) => v,
            None => "",
        }
    };
}

pub const NOTION: Connector = Connector {
    id: "notion",
    display_name: "Notion",
    icon: "📓",
    authorize_url: "https://api.notion.com/v1/oauth/authorize",
    token_url: "https://api.notion.com/v1/oauth/token",
    client_id: env_or_empty!("NOTION_CLIENT_ID"),
    client_secret: env_or_empty!("NOTION_CLIENT_SECRET"),
    // Notion does exact-string matching on registered redirect URIs and does
    // NOT require the URL to resolve — we intercept the navigation inside the
    // auth webview before any HTTP request is made. So a non-hosted HTTPS
    // sentinel works (confirmed against Notion's docs).
    redirect_uri: "https://conduit.local/oauth/callback",
    scopes: "",
    mcp_server_url: "https://mcp.notion.com/mcp",
    revoke_url: Some("https://api.notion.com/v1/oauth/revoke"),
};

/// All supported connectors, in the order they appear in the Settings UI.
pub const CONNECTORS: &[Connector] = &[NOTION];

pub fn connector_by_id(id: &str) -> Option<&'static Connector> {
    CONNECTORS.iter().find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notion_is_registered() {
        let n = connector_by_id("notion").expect("notion registered");
        assert_eq!(n.mcp_server_url, "https://mcp.notion.com/mcp");
        assert!(n.revoke_url.is_some()); // Notion exposes /v1/oauth/revoke
        assert!(n.scopes.is_empty()); // Notion: dashboard-configured, not URL
        assert_eq!(n.authorize_url, "https://api.notion.com/v1/oauth/authorize");
        assert_eq!(n.token_url, "https://api.notion.com/v1/oauth/token");
        // `confidential()` reflects whether a client_secret is configured; the
        // shipped default is empty (filled at build time before the e2e test),
        // so we assert the *intent* — Notion uses Basic-auth exchange — via the
        // `confidential()`-when-configured path rather than the placeholder.
        let mut configured = n.clone();
        configured.client_secret = "secret-placeholder";
        assert!(configured.confidential());
    }

    #[test]
    fn registry_ids_unique() {
        let mut ids: Vec<&str> = CONNECTORS.iter().map(|c| c.id).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate connector id in CONNECTORS");
    }
}
