//! Connector MCP registration for harness sessions (Claude Code / Kimi /
//! OpenCode running headless via `agent_sessions.rs`).
//!
//! The built-in chat attaches connectors in-process (`session::connect_all`);
//! the CLIs can't do that — they only read static MCP config files at spawn.
//! This module snapshots every connected connector as a remote-MCP server
//! entry (URL + a fresh OAuth bearer token) so `harness_bundle` can merge them
//! into the per-project `mcp.json` / `opencode.json` it writes per spawn.
//!
//! Token freshness: tokens are refreshed here (`ensure_valid_access_token`)
//! at spawn time. Kimi/OpenCode spawn per turn, so they always get a fresh
//! token; Claude Code's process is persistent (respawned only on model
//! change / cancel / restart), so a long-lived Claude session can hold a
//! token past its ~1h expiry until the next respawn.

use tauri::{AppHandle, Manager};

use crate::connectors::{CONNECTORS, connector_by_id};

/// One connected connector as a remote MCP server entry for a CLI config
/// file. `name` is the connector id (also the MCP server name, so its tools
/// appear as `mcp__<name>__<tool>`); `bearer_token` is `None` for public
/// connectors (Kiwi) that need no auth header.
#[derive(Debug, Clone)]
pub struct HarnessMcpServer {
    pub name: String,
    pub url: String,
    pub bearer_token: Option<String>,
}

/// Snapshot every usable connector as a harness MCP server entry. Mirrors the
/// chat-mode collection in `chat::commands::send_chat_message`: any connector
/// with a credential row counts as connected, plus public connectors (no
/// credentials needed). A connector whose token can't be refreshed is skipped
/// with a log line — never fails the turn.
pub async fn harness_mcp_servers(app: &AppHandle) -> Vec<HarnessMcpServer> {
    let db = app.state::<crate::DbState>();
    let mut ids: Vec<String> = {
        let conn = db.0.lock();
        crate::db::list_connector_credential_rows(&conn)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.connector_id)
            .collect()
    };
    for c in CONNECTORS {
        if c.is_public() && !ids.iter().any(|i| i == c.id) {
            ids.push(c.id.to_string());
        }
    }

    let mut out = Vec::new();
    for id in ids {
        let Some(cfg) = connector_by_id(&id) else {
            continue;
        };
        match crate::connectors::oauth::ensure_valid_access_token(app, &id).await {
            Ok(tok) => out.push(HarnessMcpServer {
                name: id.clone(),
                url: cfg.effective_mcp_server_url(),
                bearer_token: if tok.is_empty() { None } else { Some(tok) },
            }),
            Err(e) => {
                eprintln!("[conduit:connectors] {id} token resolve for harness failed: {e} — skipping");
            }
        }
    }
    out
}
