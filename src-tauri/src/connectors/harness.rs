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

/// Snapshot the session's ATTACHED connectors as harness MCP server entries.
/// Attach-on-demand parity with the built-in chat: only connectors attached to
/// the conversation (`chat_session_connectors` rows — the composer's @-picker
/// or a keyword mention) are registered; the CLIs have no mid-turn attach
/// mechanism of their own, so their manifest equivalent is nothing at all.
/// Rows are validated against the credential store + public connectors so a
/// stale row (connector since disconnected) can't reach the config. A
/// connector whose token can't be refreshed is skipped with a log line —
/// never fails the turn.
pub async fn harness_mcp_servers(
    app: &AppHandle,
    chat_session_id: &str,
) -> Vec<HarnessMcpServer> {
    let db = app.state::<crate::DbState>();
    let mut ids: Vec<String> = {
        let conn = db.0.lock();
        // Connector rows only (`mcp:` rows have no harness meaning).
        crate::db::list_chat_session_connectors(&conn, chat_session_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !r.starts_with("mcp:"))
            .collect()
    };
    // Keep only genuinely usable ids (credentialed or public).
    {
        let conn = db.0.lock();
        let usable: Vec<String> = crate::db::list_connector_credential_rows(&conn)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.connector_id)
            .chain(CONNECTORS.iter().filter(|c| c.is_public()).map(|c| c.id.to_string()))
            .collect();
        ids.retain(|id| usable.iter().any(|u| u == id));
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
