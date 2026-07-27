//! Remote MCP client for connectors.
//!
//! When a connector is attached to a chat session, its vendor-hosted remote
//! MCP server (e.g. `https://mcp.notion.com/mcp`) is registered into that
//! turn's tool set. This module owns the connection to that server: it
//! initializes the session, lists the server's tools (whose schemas are then
//! merged into the request sent to the LLM), and forwards `tools/call`
//! invocations.
//!
//! Auth: a standard `Authorization: Bearer <oauth_access_token>` header,
//! attached to the underlying `reqwest::Client` (the same crate the chat
//! providers use). The token is refreshed transparently before each call if
//! it has expired (see `oauth::ensure_valid_access_token`).
//!
//! Tool *schemas* are never hardcoded here — they come from the server's own
//! `tools/list` response. That is the whole point of vendor-hosted remote MCP
//! servers: Conduit does OAuth + plumbing, the vendor defines the tools.

use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientInfo, ContentBlock, Implementation};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{RoleClient, ServiceExt};
use tauri::AppHandle;

use crate::connectors::connector_by_id;
use crate::connectors::oauth::ensure_valid_access_token;

/// A live MCP client session connected to a connector's remote server.
/// Cheap to hold for the duration of a chat turn; `cancel()` (via Drop-ish
/// semantics) closes the session when the turn ends.
pub struct McpSession {
    #[allow(dead_code)]
    connector_id: String,
    svc: RunningService<RoleClient, ClientInfo>,
}

/// A remote tool's name + JSON schema, in the vendor-neutral shape the MCP
/// `tools/list` response returns. Converted to provider-specific specs at the
/// chat-tool-merge site (see chat/tools/specs.rs).
pub struct RemoteTool {
    pub name: String,
    pub description: Option<String>,
    /// The raw `inputSchema` JSON from the server, as-is.
    pub input_schema: serde_json::Value,
}

/// Connect (and initialize) an MCP session for a connector, refreshing the
/// access token first if it has expired.
pub async fn connect(app: &AppHandle, connector_id: &str) -> Result<McpSession, String> {
    let connector = connector_by_id(connector_id)
        .ok_or_else(|| format!("unknown connector `{connector_id}`"))?;
    let access_token = ensure_valid_access_token(app, connector_id).await?;

    // rmcp owns its own reqwest::Client (0.13, rustls via the `reqwest` cargo
    // feature). The OAuth bearer is passed via `auth_header` — rmcp adds the
    // `Authorization: Bearer <token>` header to every request. We do NOT
    // build a reqwest::Client ourselves here: the app's reqwest is pinned to
    // 0.12, and the `StreamableHttpClient` impl is for rmcp's 0.13 client.
    let config =
        StreamableHttpClientTransportConfig::with_uri(connector.mcp_server_url)
            .auth_header(access_token);
    let transport = StreamableHttpClientTransport::from_config(config);

    // ClientInfo is `pub type ClientInfo = InitializeRequestParams`; the
    // `ClientHandler` trait is already impl'd for it (default get_info), so a
    // tool-calling client needs no custom handler struct or macro.
    let client_info = ClientInfo::new(
        Default::default(),
        Implementation::new("conduit", env!("CARGO_PKG_VERSION")),
    );

    let svc = client_info
        .serve(transport)
        .await
        .map_err(|e| format!("mcp initialize failed: {e}"))?;

    Ok(McpSession {
        connector_id: connector.id.to_string(),
        svc,
    })
}

impl McpSession {
    /// List the remote server's tools. Called once per turn (per attached
    /// connector) to merge into the LLM request's tool set.
    pub async fn list_tools(&self) -> Result<Vec<RemoteTool>, String> {
        let result = self
            .svc
            .list_tools(None)
            .await
            .map_err(|e| format!("mcp tools/list failed: {e}"))?;
        Ok(result
            .tools
            .into_iter()
            .map(|t| RemoteTool {
                name: t.name.to_string(),
                description: t.description.as_ref().map(|d| d.to_string()),
                input_schema: serde_json::to_value(&t.input_schema)
                    .unwrap_or(serde_json::Value::Object(Default::default())),
            })
            .collect())
    }

    /// Invoke a remote tool by name. Returns the textual content the server
    /// produced (non-text blocks are represented as placeholders). Used by
    /// `dispatch::run_tool` when a tool name matches a connector's remote tool
    /// (and none of the local tools).
    pub async fn call_tool(&self, name: &str, args: &serde_json::Value) -> Result<String, String> {
        // `with_arguments` takes a JsonObject (serde_json::Map<String, Value>).
        // When the model passed no arguments (or non-object), call with none.
        // `CallToolRequestParams::new` wants a `Cow<'static, str>`, so convert
        // the borrowed tool name to an owned String.
        let mut params = CallToolRequestParams::new(name.to_string());
        if let serde_json::Value::Object(map) = args {
            params = params.with_arguments(map.clone());
        }
        let result = self
            .svc
            .call_tool(params)
            .await
            .map_err(|e| format!("mcp tools/call `{name}` failed: {e}"))?;

        // Flatten text blocks into a single string; non-text blocks become a
        // placeholder so the model knows they existed.
        let mut out = String::new();
        for block in result.content.iter() {
            if !out.is_empty() {
                out.push('\n');
            }
            match block {
                ContentBlock::Text(t) => out.push_str(&t.text),
                _ => out.push_str("[non-text content block]"),
            }
        }
        if result.is_error == Some(true) && out.is_empty() {
            return Err(format!("mcp tools/call `{name}` returned an error"));
        }
        Ok(out)
    }
}
