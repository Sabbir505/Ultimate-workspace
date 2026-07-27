//! Connectors: OAuth-based connections to third-party SaaS tools that expose
//! official, vendor-hosted remote MCP servers.
//!
//! Design: Conduit owns the OAuth plumbing (credential storage, the native
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
pub mod mcp;
pub mod oauth;
pub mod session;

pub use config::{Connector, ConnectorId, CONNECTORS, NOTION, connector_by_id};
pub use session::{AttachedConnector, RemoteToolRef, connect_all, find_tool};
