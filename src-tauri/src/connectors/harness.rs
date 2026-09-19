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
    harness_mcp_servers_for_message(app, chat_session_id, None).await
}

/// Same, but ALSO runs the built-in chat's keyword fast-path over this
/// turn's text: a mention of "@gmail", "my inbox", … attaches the connector
/// AND persists the `chat_session_connectors` row, so the CLI's config picks
/// it up this turn and on every following one. Without this the harness send
/// path had NO automatic attach at all — a connected connector stayed
/// invisible to the model unless the user @-pinned it, while the CLI's
/// capabilities report still advertised it as "connected" (the exact
/// "Gmail shows as connected but I have no Gmail tool" failure).
pub async fn harness_mcp_servers_for_message(
    app: &AppHandle,
    chat_session_id: &str,
    user_message: Option<&str>,
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
    let usable: Vec<String> = {
        let conn = db.0.lock();
        crate::db::list_connector_credential_rows(&conn)
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.connector_id)
            .chain(CONNECTORS.iter().filter(|c| c.is_public()).map(|c| c.id.to_string()))
            .collect()
    };
    // Keyword fast-path (same detection the built-in send path runs): the
    // mention both attaches for THIS turn and persists for the session —
    // the CLIs can't attach mid-turn themselves.
    if let Some(msg) = user_message {
        let trimmed = msg.trim();
        if !trimmed.is_empty() {
            let refs: Vec<&str> = usable.iter().map(|s| s.as_str()).collect();
            for id in crate::chat::prompts::detect_connector_mentions(trimmed, &refs) {
                if !ids.contains(&id) {
                    ids.push(id.clone());
                }
                let conn = db.0.lock();
                let _ = crate::db::add_chat_session_connector(&conn, chat_session_id, &id);
            }
        }
    }
    ids.retain(|id| usable.iter().any(|u| u == id));

    let mut out = Vec::new();
    for id in ids {
        let Some(cfg) = connector_by_id(&id) else {
            continue;
        };
        // Fallback-only connectors (YouTube — Google ships no hosted MCP
        // server for it) have no remote entry to register: an empty-URL
        // `http`/`remote` entry is a dead server in mcp.json / opencode.json
        // (and on OpenCode a malformed remote entry can fail the whole MCP
        // config load, taking every other connector down with it). Their
        // harness surface is the relay-tools bridge's REST fallback reads,
        // which key off credentials, not off this list.
        if cfg.effective_mcp_server_url().is_empty() {
            eprintln!(
                "[relay:connectors] {id} has no hosted MCP server — harness surface is the relay-tools fallback reads only"
            );
            continue;
        }
        match crate::connectors::oauth::ensure_valid_access_token(app, &id).await {
            Ok(tok) => out.push(HarnessMcpServer {
                name: id.clone(),
                url: cfg.effective_mcp_server_url(),
                bearer_token: if tok.is_empty() { None } else { Some(tok) },
            }),
            Err(e) => {
                eprintln!("[relay:connectors] {id} token resolve for harness failed: {e} — skipping");
            }
        }
    }
    out
}
