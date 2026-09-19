//! Connectors: OAuth-based connections to third-party SaaS tools that expose
//! official, vendor-hosted remote MCP servers.
//!
//! Design: Relay owns the OAuth plumbing (credential storage, the native
//! webview login flow, per-conversation opt-in, approval gating) and the
//! registration of the vendor's remote MCP server URL into a session's tool
//! set — it does NOT implement vendor tools. Tool schemas come from the
//! server's own `tools/list` response (see `mcp.rs`).
//!
//! This module holds the framework: a registry of supported connectors, the
//! OAuth flow, and the MCP client. Only the `CONNECTORS` registry entries are
//! connector-specific; everything else is generic and reused as-is by the
//! follow-on connector tasks (Google Drive/Calendar, Gmail, Canva, Slack).

pub mod config;
pub mod gmail_api;
pub mod google_rest;
pub mod harness;
pub mod mcp;
pub mod oauth;
pub mod session;

pub use config::{
    Connector, CONNECTORS, connector_by_id,
    family_members, family_redirect_uri,
};
pub use session::{AttachedConnector, connect_all, find_tool};
pub use harness::{HarnessMcpServer, harness_mcp_servers, harness_mcp_servers_for_message};

// ── Bridged REST fallback tools (harness CLI surface) ─────────────────────
//
// Google's hosted Workspace/Gmail MCP servers accept `initialize`/`tools/
// list` but reject every `tools/call` while the project isn't enrolled in
// the Workspace MCP Developer Preview (see `gmail_api`'s module docs). The
// harness CLIs route around that with the local REST fallback tools via the
// relay-tools bridge. OWNER POLICY: ALL fallback tools — reads AND writes
// (gmail_send_message, gdrive_create_file, …) — bridge to harness sessions
// ungated; the user explicitly opted out of the approval-card gate for
// harness connector calls (the built-in chat keeps its card gate for writes;
// this bridge surface does not).

use tauri::AppHandle;

/// Which connector owns `name` (any fallback tool — reads and writes alike).
/// `None` for unknown names.
pub fn fallback_tool_owner(name: &str) -> Option<&'static str> {
    if let Some(def) = gmail_api::fallback_tool_defs().iter().find(|d| d.name == name) {
        return Some("gmail");
    }
    CONNECTORS.iter().find_map(|c| {
        let defs = google_rest::fallback_tool_defs(c.id)?;
        defs.iter().find(|d| d.name == name).map(|_| c.id)
    })
}

/// (connector_id, tool name, model-facing description) for EVERY fallback
/// tool of a CONNECTED connector — reads and writes alike (owner policy:
/// harness sessions get the full surface, ungated). Pure over the
/// credentialed-id list so it is unit-testable without an app handle.
pub fn connected_fallback_tools(
    credentialed: &[String],
) -> Vec<(&'static str, &'static str, &'static str)> {
    let mut out = Vec::new();
    for c in CONNECTORS {
        if !(c.is_public() || credentialed.iter().any(|id| id == c.id)) {
            continue;
        }
        let defs: &[gmail_api::FallbackTool] = if c.id == "gmail" {
            gmail_api::fallback_tool_defs()
        } else {
            google_rest::fallback_tool_defs(c.id).unwrap_or(&[])
        };
        for def in defs {
            out.push((c.id, def.name, def.description));
        }
    }
    out
}

/// Execute one bridged fallback tool (read or write — owner policy: ungated
/// over the bridge). The OAuth token refresh inside the `call_tool`
/// implementations is the connector-connectedness check — an unconnected
/// connector fails there with its own error text.
pub async fn execute_fallback_tool(
    app: &AppHandle,
    connector_id: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    if connector_id == "gmail" {
        gmail_api::call_tool(app, name, args).await
    } else {
        google_rest::call_tool(app, connector_id, name, args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_owner_maps_reads_and_writes() {
        assert_eq!(fallback_tool_owner("gmail_search_threads"), Some("gmail"));
        assert_eq!(fallback_tool_owner("gmail_get_thread"), Some("gmail"));
        assert_eq!(fallback_tool_owner("gdrive_search_files"), Some("gdrive"));
        // Writes bridge too (owner policy: ungated harness surface).
        assert_eq!(fallback_tool_owner("gmail_send_message"), Some("gmail"));
        assert_eq!(fallback_tool_owner("gmail_create_draft"), Some("gmail"));
        assert_eq!(fallback_tool_owner("nonexistent_tool"), None);
        assert_eq!(fallback_tool_owner(""), None);
    }

    #[test]
    fn connected_fallback_tools_follow_credentials() {
        // Nothing connected → nothing advertised.
        assert!(connected_fallback_tools(&[]).is_empty());
        // Gmail connected → its full surface, reads and writes.
        let tools = connected_fallback_tools(&["gmail".to_string()]);
        let names: Vec<&str> = tools.iter().map(|(_, n, _)| *n).collect();
        assert!(names.contains(&"gmail_search_threads"));
        assert!(names.contains(&"gmail_send_message"));
        assert!(names.contains(&"gmail_create_draft"));
        // A connector with no REST fallback surface (notion: vendor MCP only)
        // contributes nothing even when connected.
        assert!(connected_fallback_tools(&["notion".to_string()]).is_empty());
    }
}
