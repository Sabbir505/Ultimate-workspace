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
pub mod gmail_api;
pub mod google_rest;
pub mod harness;
pub mod mcp;
pub mod oauth;
pub mod session;

pub use config::{
    Connector, ConnectorId, CONNECTORS, GITHUB, GITHUB_CALLBACK_PORT, GMAIL, GMAIL_CALLBACK_PORT,
    GOOGLE_CALENDAR, GOOGLE_CALENDAR_CALLBACK_PORT, GOOGLE_CHAT, GOOGLE_CHAT_CALLBACK_PORT,
    GOOGLE_DOCS, GOOGLE_DOCS_CALLBACK_PORT, GOOGLE_DRIVE, GOOGLE_DRIVE_CALLBACK_PORT,
    GOOGLE_FAMILY_CALLBACK_PORT, GOOGLE_FAMILY_MEMBERS, GOOGLE_FAMILY_REDIRECT_URI, GOOGLE_PEOPLE,
    GOOGLE_PEOPLE_CALLBACK_PORT, GOOGLE_SHEETS, GOOGLE_SHEETS_CALLBACK_PORT, GOOGLE_SLIDES,
    GOOGLE_SLIDES_CALLBACK_PORT, KIWI, NOTION, NOTION_CALLBACK_PORT, connector_by_id,
    family_members, family_redirect_uri,
};
pub use session::{AttachedConnector, RemoteToolRef, connect_all, find_tool};
pub use harness::{HarnessMcpServer, harness_mcp_servers};
