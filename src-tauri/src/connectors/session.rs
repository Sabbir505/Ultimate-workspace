//! Per-turn connector state: the live MCP sessions + the tool-name → intent
//! map for each attached connector.
//!
//! At the start of a tool-enabled turn, for each connector attached to the
//! session, [`connect`] opens an MCP session, lists its tools, classifies each
//! as Read or Write ([`crate::chat::permission::classify_connector_tool`]), and
//! stores the result in an [`AttachedConnector`]. The whole list lives on
//! [`crate::chat::tools::ToolCaps`] for the duration of the turn, so the schema
//! merger ([`crate::chat::tools::specs`]) can add the remote tools to the LLM
//! request and the dispatcher ([`crate::chat::dispatch`]) can route a matched
//! tool name to the right MCP session — gating Writes through the approval
//! flow, auto-running Reads.

use std::collections::HashMap;

use tauri::AppHandle;

use crate::chat::permission::{self, ConnectorToolKind};
use crate::connectors::mcp::{McpSession, RemoteTool};
use crate::connectors::connector_by_id;

/// A connector attached to a turn, with its live MCP session and the
/// classification of every tool the server exposed.
pub struct AttachedConnector {
    pub connector_id: String,
    pub display_name: String,
    pub session: McpSession,
    /// tool name → (kind, description) for every tool the server listed.
    pub tools: HashMap<String, (ConnectorToolKind, Option<String>)>,
    /// Tool names implemented locally via the Gmail REST fallback
    /// (`gmail_api`), routed by the dispatcher instead of the MCP session.
    /// Currently only populated for gmail while Google's MCP service layer
    /// denies every `tools/call` (see `gmail_api` module docs).
    pub fallback: std::collections::HashSet<String>,
}

impl AttachedConnector {
    /// Is `tool_name` one of this connector's remote tools, and what kind?
    pub fn lookup(&self, tool_name: &str) -> Option<ConnectorToolKind> {
        self.tools.get(tool_name).map(|(k, _)| *k)
    }
}

/// The remote tools of an attached connector, in a shape the schema merger
/// (specs.rs) consumes: name, optional description, raw input-schema JSON,
/// and the classified kind (so writes can be tagged in the description the
/// model sees, and so dispatch knows how to gate).
pub fn remote_specs(_att: &AttachedConnector) -> Vec<RemoteToolRef> {
    // Deprecated: This function is no longer used. Kept for compatibility.
    Vec::new()
}

/// A lightweight reference to a remote tool for schema merging.
pub struct RemoteToolRef {
    pub name: String,
    pub description: Option<String>,
    pub kind: ConnectorToolKind,
}

/// Connect to every attached connector, list + classify its tools, and return
/// the `AttachedConnector` list (one per connector that connected successfully).
/// A connector that fails to connect is skipped with an error logged — the turn
/// proceeds with the remaining connectors rather than failing the whole chat.
pub async fn connect_all(
    app: &AppHandle,
    connector_ids: &[String],
) -> Vec<AttachedConnector> {
    let mut out = Vec::new();
    for id in connector_ids {
        let Some(cfg) = connector_by_id(id) else {
            eprintln!("[conduit:connectors] unknown connector id `{id}` — skipping");
            continue;
        };
        match crate::connectors::mcp::connect(app, id).await {
            Ok(session) => {
                let tools: Vec<RemoteTool> = match session.list_tools().await {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!(
                            "[conduit:connectors] {id} tools/list failed: {e} — attaching with no tools"
                        );
                        Vec::new()
                    }
                };
                let mut map = HashMap::new();
                for t in &tools {
                    let kind = permission::classify_connector_tool(&t.name, t.description.as_deref());
                    map.insert(t.name.clone(), (kind, t.description.clone()));
                }
                // REST fallbacks: Google's MCP service layer denies every
                // `tools/call` while the project isn't fully enrolled in the
                // Workspace MCP Developer Preview, so also advertise local
                // tools backed by the base Google APIs (gmail: `gmail_*`,
                // the Workspace products: `gdrive_*`/`gdocs_*`/… — explicit
                // Read/Write kinds — reads auto-run, writes approval-gate).
                let fallback_defs: &[crate::connectors::gmail_api::FallbackTool] = if id == "gmail"
                {
                    crate::connectors::gmail_api::fallback_tool_defs()
                } else {
                    crate::connectors::google_rest::fallback_tool_defs(id).unwrap_or(&[])
                };
                let mut fallback = std::collections::HashSet::new();
                for def in fallback_defs {
                    map.insert(
                        def.name.to_string(),
                        (def.kind, Some(def.description.to_string())),
                    );
                    fallback.insert(def.name.to_string());
                }
                out.push(AttachedConnector {
                    connector_id: id.to_string(),
                    display_name: cfg.display_name.to_string(),
                    session,
                    tools: map,
                    fallback,
                });
            }
            Err(e) => {
                eprintln!(
                    "[conduit:connectors] {id} connect failed: {e} — skipping for this turn"
                );
            }
        }
    }
    out
}

/// Look up a tool name across all attached connectors. Returns the connector
/// (by index) and the tool's kind, so the dispatcher can route a matched call
/// to the right MCP session and gate it correctly.
pub fn find_tool<'a>(
    attached: &'a [AttachedConnector],
    tool_name: &str,
) -> Option<(usize, ConnectorToolKind)> {
    for (i, c) in attached.iter().enumerate() {
        if let Some(kind) = c.lookup(tool_name) {
            return Some((i, kind));
        }
    }
    None
}
