//! Harness MCP server wiring: per-connector remote-server entries merged into
//! the per-spawn harness bundle (`.mcp.json` / `opencode.json`).
//!
//! Each `HarnessMcpServer` is the JSON-shaped entry a CLI (claude_code,
//! kimi_code, opencode) needs to know how to launch a remote MCP server. For
//! Conduit's connected connectors (Settings → Connectors), the "command" is
//! actually an `mcp-remote`-style HTTP URL + bearer token; the harness spawn
//! process invokes the configured `command` with the supplied env, so
//! `mcp-remote` is what receives the URL + token and bridges to the vendor's
//! streamable-HTTP endpoint.
//!
//! This module is the rot-fix shim: it lives next to the other connector
//! modules and exposes a single async `harness_mcp_servers(app)` helper that
//! the `send_agent_chat_message` IPC command calls right before spawning a
//! harness. The shape is the minimum needed to make the agent_sessions.rs
//! callers compile and to give the harness bundle the per-connector entries
//! the bundle already accepts as its trailing `connectors` argument.

use serde::Serialize;
use tauri::AppHandle;

use crate::connectors::{connector_by_id, CONNECTORS};
use crate::db;

/// One remote-MCP server entry to merge into a harness bundle's MCP config.
/// Serialized to the per-server JSON object a harness CLI consumes:
/// `{"type": "http", "url": "...", "headers": {"Authorization": "Bearer …"}}`
/// for remote servers, or `{"command": "...", "args": [...], "env": {...}}`
/// for stdio-launched ones.
///
/// For the rot fix we only use the HTTP form (the connector list is
/// vendor-hosted remote MCP servers). The struct is generic enough that a
/// future stdio entry (e.g. an internal tool broker) can be added without
/// breaking the bundle writer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HarnessMcpServer {
    /// `mcp-remote` style bridge: the harness launches `mcp-remote` with the
    /// vendor's URL and the OAuth bearer in env, and `mcp-remote` proxies the
    /// stdio MCP transport to the vendor's streamable-HTTP endpoint.
    #[serde(rename = "http")]
    Http {
        /// Stable id used by the bundle writer when naming the server
        /// (`mcp__<connector_id>`).
        id: &'static str,
        display_name: String,
        url: String,
        /// Bearer token (already refreshed by the caller).
        token: String,
    },
    /// Stdio-launched server: harness runs `command` with `args` and `env`.
    /// Not used by the rot fix (no stdio connectors today); included for
    /// completeness and to keep the enum non-exhaustive in spirit.
    Stdio {
        id: &'static str,
        display_name: String,
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
}

/// Build the per-connector harness MCP entries. Iterates the `CONNECTORS`
/// registry, refreshes each connected one's access token (the bundle is
/// static once the spawn starts, so this MUST happen right before the
/// spawn), and emits a `HarnessMcpServer` per connected connector.
///
/// Connectors that fail to refresh are silently dropped — the bundle's
/// browser + conduit-tools servers still work, and the user can reconnect
/// from Settings → Connectors. Public connectors (Kiwi.com) include a no-auth
/// entry so the harness can call their public MCP without an OAuth dance.
pub async fn harness_mcp_servers(app: &AppHandle) -> Vec<HarnessMcpServer> {
    let mut out: Vec<HarnessMcpServer> = Vec::new();
    for cfg in CONNECTORS.iter() {
        // Public connectors: always include (no token, no refresh).
        if cfg.is_public() {
            if !cfg.configured() {
                continue;
            }
            out.push(HarnessMcpServer::Http {
                id: cfg.id,
                display_name: cfg.display_name.to_string(),
                url: cfg.effective_mcp_server_url(),
                token: String::new(),
            });
            continue;
        }

        // Connected connectors: refresh token if needed, then emit an entry.
        match crate::connectors::oauth::ensure_valid_access_token(app, cfg.id).await {
            Ok(token) if !token.is_empty() => {
                out.push(HarnessMcpServer::Http {
                    id: cfg.id,
                    display_name: cfg.display_name.to_string(),
                    url: cfg.effective_mcp_server_url(),
                    token,
                });
            }
            Ok(_) => {
                // Empty token from a non-public connector is unexpected; skip
                // rather than emit a no-auth entry that would 401.
            }
            Err(e) => {
                eprintln!(
                    "[conduit:connectors] harness_mcp_servers: refresh failed for `{}`: {e}",
                    cfg.id
                );
            }
        }
    }
    out
}

/// Look up a static `&'static str` for a connector id. The registry's
/// `Connector::id` is already a `&'static str` (a `pub type ConnectorId =
/// &'static str`); this helper exists so the call site reads clearly.
#[allow(dead_code)]
fn connector_id_to_static(id: &str) -> &'static str {
    connector_by_id(id).map(|c| c.id).unwrap_or("unknown")
}

/// Convenience: same as [`harness_mcp_servers`] but only returns the ids,
/// for callers that want to know "what got registered" without the full
/// entry (currently unused; kept for symmetry with the chat path's
/// `connected_connector_ids` query).
#[allow(dead_code)]
pub async fn harness_mcp_server_ids(app: &AppHandle) -> Vec<String> {
    use tauri::Manager;
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let rows = db::list_connector_credential_rows(&conn).unwrap_or_default();
    drop(conn);
    rows.into_iter().map(|r| r.connector_id).collect()
}
