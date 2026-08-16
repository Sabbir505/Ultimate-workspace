//! User-installable MCP servers for the built-in chat (§3.2.14) — the
//! "gallery": a curated catalog of popular stdio MCP servers plus custom
//! user-defined entries, one-click install, and tool exposure to the chat
//! tab's model through the same pipeline as connectors.
//!
//! - **Defs** (`McpServerDef`) persist as a JSON blob in the `mcp.servers`
//!   KV setting (same pattern as `acp.agents`). Enabling a server makes its
//!   tools available in EVERY tool-enabled chat turn — there is no
//!   per-session attach (matching how Cline treats global MCP config).
//! - **Sessions**: each connected server is a stdio child process (rmcp
//!   `TokioChildProcess`), cached in [`McpGalleryState`] across turns so a
//!   turn doesn't pay the spawn cost every time. Killed on remove/disable
//!   and on app exit.
//! - **Tools** are advertised to the model under prefixed wire names
//!   (`mcp_<server>_<tool>`) so two servers can both expose `search` without
//!   colliding, and classified Read/Write by the same keyword classifier as
//!   connector tools — Writes gate through the standard approval flow.
//! - Windows note: npm-installed CLIs (`npx`) are `.cmd` shims that
//!   CreateProcess can't run bare, so every spawn is wrapped in
//!   `cmd.exe /C` exactly like the harness spawner
//!   (`harness_adapters::resolve_for_spawn`).

use std::collections::HashMap;
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ClientInfo, ContentBlock, Implementation};
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::chat::permission::{self, ConnectorToolKind};
use crate::db;

/// Wire prefix for gallery tools. No built-in tool starts with this; the
/// dispatcher treats any `mcp_*` tool name as gallery-routed after the
/// connector branch has had its chance.
pub const TOOL_PREFIX: &str = "mcp_";

/// A user-installed MCP server definition (persisted; one per server).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServerDef {
    /// Stable slug used in tool wire names (`mcp_<id>_<tool>`).
    pub id: String,
    pub name: String,
    pub description: String,
    /// Executable, e.g. `npx`, `uvx`, or an absolute path.
    pub command: String,
    /// Args appended to the command, e.g.
    /// `["-y", "@modelcontextprotocol/server-memory"]`.
    pub args: Vec<String>,
    /// Extra env vars for the child (API keys etc.). Inherited parent env
    /// plus these.
    pub env: HashMap<String, String>,
    /// Disabled servers stay installed but attach to nothing.
    pub enabled: bool,
    /// True when installed from the built-in catalog (vs. user-defined).
    pub from_gallery: bool,
}

impl Default for McpServerDef {
    fn default() -> Self {
        McpServerDef {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            enabled: true,
            from_gallery: false,
        }
    }
}

/// One entry of the built-in catalog (what the Settings panel renders as the
/// "gallery"). `args` may contain `{home}`, replaced with the user's home
/// dir at install time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// Env keys the server wants (documented for the user; values are blank
    /// until filled in the install form).
    pub env_keys: &'static [&'static str],
}

/// The curated gallery. Stdio servers only — remote-OAuth MCP stays the
/// connectors system's job. `npx` entries need Node on PATH; `uvx` entries
/// need uv (astral.sh).
pub fn catalog() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            id: "filesystem",
            name: "Filesystem",
            description: "Read/write/search files under a root directory (your home folder by default).",
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-filesystem", "{home}"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "memory",
            name: "Memory",
            description: "Knowledge-graph memory the model can persist entities/relations into across the conversation.",
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-memory"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "sequentialthinking",
            name: "Sequential Thinking",
            description: "Structured step-by-step reasoning tool for complex problem decomposition.",
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-sequential-thinking"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "everything",
            name: "Everything (test)",
            description: "The reference MCP test server — exercises every tool/prompt/resource feature. Good for verifying the plumbing.",
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-everything"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "fetch",
            name: "Fetch",
            description: "Fetch a URL and optionally extract markdown (needs uv: astral.sh).",
            command: "uvx",
            args: &["mcp-server-fetch"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "git",
            name: "Git",
            description: "Clone/add/commit/status on local git repositories (needs uv).",
            command: "uvx",
            args: &["mcp-server-git"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "sqlite",
            name: "SQLite",
            description: "Query/write a local SQLite database at ~/conduit-mcp-sqlite.db (needs uv).",
            command: "uvx",
            args: &["mcp-server-sqlite", "--db-path", "{home}/conduit-mcp-sqlite.db"],
            env_keys: &[],
        },
        CatalogEntry {
            id: "time",
            name: "Time",
            description: "Current time + timezone conversion (needs uv).",
            command: "uvx",
            args: &["mcp-server-time"],
            env_keys: &[],
        },
    ]
}

/// Build the prefixed wire name for a server tool: `mcp_<server>_<tool>`,
/// with characters outside `[A-Za-z0-9_-]` collapsed to `_` (OpenAI tool
/// name rules; Anthropic is at least as permissive).
pub fn wire_tool_name(server_id: &str, tool_name: &str) -> String {
    fn sanitize(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut prev_underscore = false;
        for c in s.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                out.push(c);
                prev_underscore = false;
            } else if !prev_underscore {
                out.push('_');
                prev_underscore = true;
            }
        }
        // Trim the edges: the joiner `_` already separates the parts, and a
        // leading/trailing underscore would read as an empty segment.
        out.trim_matches('_').to_string()
    }
    format!("{TOOL_PREFIX}{}_{}", sanitize(server_id), sanitize(tool_name))
}

/// A gallery tool as the schema merger and dispatcher see it — detached from
/// the live session on purpose so specs/tests can be built without a child
/// process running. `wire_name` is what the model calls; `raw_name` is what
/// forwards to the server.
#[derive(Debug, Clone)]
pub struct McpToolEntry {
    pub server_id: String,
    pub server_name: String,
    pub wire_name: String,
    pub raw_name: String,
    pub kind: ConnectorToolKind,
    pub description: Option<String>,
}

/// Find a tool by wire name across the attached entries. Returns the index
/// into the slice (dispatcher uses it for the session lookup).
pub fn find_tool<'a>(
    entries: &'a [McpToolEntry],
    wire_name: &str,
) -> Option<(usize, &'a McpToolEntry)> {
    entries
        .iter()
        .enumerate()
        .find(|(_, e)| e.wire_name == wire_name)
        .map(|(i, e)| (i, e))
}

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

/// A connected gallery server: the rmcp client session over the child's
/// stdio. Held in `Arc` so the registry can hand copies to in-flight calls
/// while a concurrent disconnect replaces the entry.
pub struct GallerySession {
    #[allow(dead_code)]
    pub server_id: String,
    svc: RunningService<RoleClient, ClientInfo>,
}

impl GallerySession {
    /// List the server's tools as `McpToolEntry`s (prefixed + classified).
    pub async fn tool_entries(&self, def: &McpServerDef) -> Result<Vec<McpToolEntry>, String> {
        let result = self
            .svc
            .list_tools(None)
            .await
            .map_err(|e| format!("mcp tools/list failed: {e}"))?;
        Ok(result
            .tools
            .into_iter()
            .map(|t| {
                let raw_name = t.name.to_string();
                let description = t.description.as_ref().map(|d| d.to_string());
                let kind =
                    permission::classify_connector_tool(&raw_name, description.as_deref());
                McpToolEntry {
                    server_id: def.id.clone(),
                    server_name: def.name.clone(),
                    wire_name: wire_tool_name(&def.id, &raw_name),
                    raw_name,
                    kind,
                    description,
                }
            })
            .collect())
    }

    /// Forward a `tools/call` to the server (raw name). Returns the textual
    /// content the server produced.
    pub async fn call_tool(
        &self,
        raw_name: &str,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        let mut params = CallToolRequestParams::new(raw_name.to_string());
        if let serde_json::Value::Object(map) = args {
            params = params.with_arguments(map.clone());
        }
        let result = self
            .svc
            .call_tool(params)
            .await
            .map_err(|e| format!("mcp tools/call `{raw_name}` failed: {e}"))?;
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
            return Err(format!("mcp tools/call `{raw_name}` returned an error"));
        }
        Ok(out)
    }
}

/// Global registry of live gallery sessions, keyed by server id. Managed as
/// Tauri state; `parking_lot` is fine because no guard is ever held across
/// an `.await` (callers clone the `Arc` first).
#[derive(Default)]
pub struct McpGalleryState(pub parking_lot::Mutex<HashMap<String, std::sync::Arc<GallerySession>>>);

/// Spawn + initialize the server process and return the live session.
/// Follows the Windows `.cmd`-shim wrapping rule from the harness spawner.
pub async fn connect_server(def: &McpServerDef) -> Result<std::sync::Arc<GallerySession>, String> {
    if def.command.trim().is_empty() {
        return Err(format!("server `{}` has no command", def.name));
    }
    let mut cmd = tokio::process::Command::new(&def.command);
    cmd.args(&def.args);
    for (k, v) in &def.env {
        cmd.env(k, v);
    }
    // npm-installed CLIs are `.cmd` shims that CreateProcess cannot execute
    // bare; `cmd.exe /C` restores PATH/PATHEXT resolution (see
    // harness_adapters::resolve_for_spawn — same rule, tokio flavor).
    #[cfg(windows)]
    if !def.command.eq_ignore_ascii_case("cmd.exe") {
        let mut wrapped = tokio::process::Command::new("cmd.exe");
        wrapped.arg("/C").arg(&def.command).args(&def.args);
        for (k, v) in &def.env {
            wrapped.env(k, v);
        }
        cmd = wrapped;
    }

    // Default stdio per rmcp builder: stdin/stdout piped, stderr inherited —
    // server logs land in our console, invaluable for first-run debugging.
    let (transport, _stderr) = TokioChildProcess::builder(cmd)
        .spawn()
        .map_err(|e| format!("failed to spawn `{}`: {e}", def.command))?;
    let client_info = ClientInfo::new(
        Default::default(),
        Implementation::new("conduit", env!("CARGO_PKG_VERSION")),
    );
    let svc = client_info
        .serve(transport)
        .await
        .map_err(|e| format!("mcp initialize failed for `{}`: {e}", def.name))?;
    Ok(std::sync::Arc::new(GallerySession {
        server_id: def.id.clone(),
        svc,
    }))
}

/// The server's live session, self-healing: if it isn't connected (never
/// started, crashed, or app restarted), reconnect from the stored def. The
/// reconnect is bounded so a mid-turn self-heal can't hang the turn.
pub async fn session_for(app: &AppHandle, server_id: &str) -> Result<std::sync::Arc<GallerySession>, String> {
    let state = app.state::<McpGalleryState>();
    let existing = state.0.lock().get(server_id).map(std::sync::Arc::clone);
    if let Some(s) = existing {
        return Ok(s);
    }
    let def = load_defs(app)
        .into_iter()
        .find(|d| d.id == server_id)
        .ok_or_else(|| format!("no installed MCP server `{server_id}`"))?;
    let session = tokio::time::timeout(Duration::from_secs(30), connect_server(&def))
        .await
        .map_err(|_| format!("MCP server `{}` reconnect timed out", def.name))??;
    state
        .0
        .lock()
        .insert(server_id.to_string(), std::sync::Arc::clone(&session));
    Ok(session)
}

/// Disconnect one server (remove/disable). No-op when not connected.
pub fn disconnect_server(app: &AppHandle, server_id: &str) {
    let state = app.state::<McpGalleryState>();
    let session = state.0.lock().remove(server_id);
    // Dropping the Arc triggers rmcp's child cleanup (kill on drop);
    // cancel() additionally closes the JSON-RPC session.
    if let Some(svc) = session.and_then(std::sync::Arc::into_inner) {
        let _ = svc.svc.cancel();
    }
}

/// Kill every live gallery child. Called from the app-exit handler.
pub fn kill_all(app: &AppHandle) {
    let state = app.state::<McpGalleryState>();
    let sessions: Vec<_> = state.0.lock().drain().collect();
    for (_, session) in sessions {
        if let Some(s) = std::sync::Arc::into_inner(session) {
            let _ = s.svc.cancel();
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence + attach
// ---------------------------------------------------------------------------

/// Load the installed server defs (`mcp.servers` KV). Invalid JSON settles
/// to an empty list — never fails a turn.
pub fn load_defs(app: &AppHandle) -> Vec<McpServerDef> {
    let db_state = app.state::<crate::DbState>();
    let conn = db_state.0.lock();
    db::get_setting(&conn, "mcp.servers")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Persist the installed server defs.
pub fn save_defs(app: &AppHandle, defs: &[McpServerDef]) {
    let db_state = app.state::<crate::DbState>();
    let conn = db_state.0.lock();
    let _ = db::set_setting(
        &conn,
        "mcp.servers",
        &serde_json::to_string(defs).unwrap_or_else(|_| "[]".into()),
    );
}

/// Connect every enabled installed server (reusing cached sessions) and
/// return the flat tool table for this turn. Same resilience contract as
/// `connectors::connect_all`: a server that fails to start is skipped with
/// a log line, not a failed turn. The spawn+initialize is bounded so a
/// first-run `npx` download can't stall the turn indefinitely.
pub async fn attach_enabled(app: &AppHandle) -> Vec<McpToolEntry> {
    let defs: Vec<McpServerDef> = load_defs(app).into_iter().filter(|d| d.enabled).collect();
    if defs.is_empty() {
        return Vec::new();
    }
    let state = app.state::<McpGalleryState>();
    let mut entries = Vec::new();
    let mut seen_wire_names = std::collections::HashSet::new();
    for def in &defs {
        // Snapshot the cached session (clone the Arc) BEFORE any await —
        // the parking_lot guard must never cross an await, and re-locking
        // inside a held guard would deadlock on the same mutex.
        let existing = state.0.lock().get(&def.id).map(std::sync::Arc::clone);
        let session = match existing {
            Some(s) => s,
            None => {
                let connected =
                    tokio::time::timeout(Duration::from_secs(30), connect_server(def)).await;
                match connected {
                    Ok(Ok(s)) => {
                        state
                            .0
                            .lock()
                            .insert(def.id.clone(), std::sync::Arc::clone(&s));
                        s
                    }
                    Ok(Err(e)) => {
                        eprintln!("[mcp-gallery] `{}` connect failed: {e} — skipping", def.name);
                        continue;
                    }
                    Err(_) => {
                        eprintln!(
                            "[mcp-gallery] `{}` connect timed out (first-run download?) — skipping",
                            def.name
                        );
                        continue;
                    }
                }
            }
        };
        match session.tool_entries(def).await {
            Ok(mut tools) => {
                // First wire name wins on cross-server collisions after
                // prefixing (e.g. two custom servers with the same slug).
                tools.retain(|t| seen_wire_names.insert(t.wire_name.clone()));
                eprintln!(
                    "[mcp-gallery] `{}` attached with {} tool(s)",
                    def.name,
                    tools.len()
                );
                entries.extend(tools);
            }
            Err(e) => {
                eprintln!("[mcp-gallery] `{}` tools/list failed: {e}", def.name);
            }
        }
    }
    entries
}

/// Forward a tool call to a gallery server by id, self-healing the session
/// if the child died since the turn started.
pub async fn call_tool(
    app: &AppHandle,
    server_id: &str,
    raw_name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let session = session_for(app, server_id).await?;
    session.call_tool(raw_name, args).await
}

/// Slugify a display name into a server id (`"Git Tools!"` → `"git_tools"`).
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_underscore = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_underscore = false;
        } else if !prev_underscore && !out.is_empty() {
            out.push('_');
            prev_underscore = true;
        }
    }
    out.trim_end_matches('_').to_string()
}

/// Instantiate a catalog entry into a def, expanding `{home}` in args.
pub fn def_from_catalog(entry: &CatalogEntry) -> McpServerDef {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    McpServerDef {
        id: entry.id.to_string(),
        name: entry.name.to_string(),
        description: entry.description.to_string(),
        command: entry.command.to_string(),
        args: entry
            .args
            .iter()
            .map(|a| a.replace("{home}", &home))
            .collect(),
        env: HashMap::new(),
        enabled: true,
        from_gallery: true,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (Settings → MCP Gallery panel)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryList {
    pub catalog: Vec<CatalogEntry>,
    pub installed: Vec<McpServerDef>,
}

#[tauri::command]
pub fn mcp_gallery_list(app: AppHandle) -> GalleryList {
    GalleryList {
        catalog: catalog(),
        installed: load_defs(&app),
    }
}

/// Install a server: either `catalog_id` (one-click from the gallery) or a
/// `custom` def (name + command + args + env from the form). The def id is
/// the catalog id, or a slug of the custom name with a uniqueness suffix.
#[tauri::command]
pub fn mcp_gallery_install(
    app: AppHandle,
    catalog_id: Option<String>,
    custom: Option<McpServerDef>,
) -> Result<McpServerDef, String> {
    let mut defs = load_defs(&app);
    let mut def = match (catalog_id, &custom) {
        (Some(id), _) => catalog()
            .into_iter()
            .find(|e| e.id == id)
            .map(|e| def_from_catalog(&e))
            .ok_or_else(|| format!("unknown gallery entry `{id}`"))?,
        (None, Some(c)) => {
            let mut d = c.clone();
            if d.name.trim().is_empty() {
                return Err("server name is required".into());
            }
            if d.command.trim().is_empty() {
                return Err("server command is required".into());
            }
            d.id = slugify(&d.name);
            d.from_gallery = false;
            d
        }
        (None, None) => return Err("provide catalogId or custom".into()),
    };
    // Unique id: prefer the plain slug, then slug_2, slug_3, …
    if defs.iter().any(|d| d.id == def.id) {
        let mut n = 2;
        while defs.iter().any(|d| d.id == format!("{}_{n}", def.id)) {
            n += 1;
        }
        def.id = format!("{}_{n}", def.id);
    }
    defs.push(def.clone());
    save_defs(&app, &defs);
    Ok(def)
}

/// Remove an installed server and kill its child process (if live).
#[tauri::command]
pub fn mcp_gallery_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mut defs = load_defs(&app);
    let before = defs.len();
    defs.retain(|d| d.id != id);
    if defs.len() == before {
        return Err(format!("no installed MCP server `{id}`"));
    }
    save_defs(&app, &defs);
    disconnect_server(&app, &id);
    Ok(())
}

/// Enable/disable a server. Disabling disconnects the child so it stops
/// attaching to new turns immediately.
#[tauri::command]
pub fn mcp_gallery_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let mut defs = load_defs(&app);
    let def = defs
        .iter_mut()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("no installed MCP server `{id}`"))?;
    def.enabled = enabled;
    let def = def.clone();
    save_defs(&app, &defs);
    if !enabled {
        disconnect_server(&app, &id);
    }
    let _ = def;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolView {
    pub wire_name: String,
    pub raw_name: String,
    pub description: Option<String>,
    /// "read" | "write" — same classification as connector tools.
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResult {
    pub server_id: String,
    pub tools: Vec<McpToolView>,
}

/// Explicitly connect a server (Settings panel "Test / Connect"). No
/// timeout on purpose: a first `npx -y` run downloads the package and can
/// legitimately take a while — the user pressed the button and is watching.
#[tauri::command]
pub async fn mcp_gallery_connect(app: AppHandle, id: String) -> Result<McpConnectResult, String> {
    let def = load_defs(&app)
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("no installed MCP server `{id}`"))?;
    let state = app.state::<McpGalleryState>();
    let existing = state.0.lock().get(&id).map(std::sync::Arc::clone);
    let session = match existing {
        Some(s) => s,
        None => {
            let s = connect_server(&def).await?;
            state.0.lock().insert(id.clone(), std::sync::Arc::clone(&s));
            s
        }
    };
    let tools = session
        .tool_entries(&def)
        .await?
        .into_iter()
        .map(|t| McpToolView {
            wire_name: t.wire_name,
            raw_name: t.raw_name,
            description: t.description,
            kind: match t.kind {
                ConnectorToolKind::Write => "write".into(),
                ConnectorToolKind::Read => "read".into(),
            },
        })
        .collect();
    Ok(McpConnectResult { server_id: id, tools })
}

/// Disconnect a server's child process (it reconnects on the next turn that
/// needs it, or the next explicit Connect).
#[tauri::command]
pub fn mcp_gallery_disconnect(app: AppHandle, id: String) {
    disconnect_server(&app, &id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_prefixed_sanitized_and_collision_safe() {
        assert_eq!(wire_tool_name("memory", "create_entities"), "mcp_memory_create_entities");
        // Invalid chars collapse; never leading/trailing underscore noise.
        assert_eq!(wire_tool_name("my server!", "read file"), "mcp_my_server_read_file");
        // Same raw tool on two servers stays distinct.
        assert_ne!(wire_tool_name("a", "search"), wire_tool_name("b", "search"));
        // Everything produced is OpenAI-tool-name safe.
        for (sid, tool) in [("a b", "x/y"), ("ünïcode", "t.o.o.l")] {
            for c in wire_tool_name(sid, tool).chars() {
                assert!(c.is_ascii_alphanumeric() || c == '_' || c == '-');
            }
        }
    }

    #[test]
    fn slugify_produces_stable_ids() {
        assert_eq!(slugify("Git Tools!"), "git_tools");
        assert_eq!(slugify("  Memory  "), "memory");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn catalog_entries_are_wellformed_and_unique() {
        let cat = catalog();
        assert!(cat.len() >= 6, "gallery should have a meaningful catalog");
        let mut ids = std::collections::HashSet::new();
        for e in &cat {
            assert!(ids.insert(e.id), "duplicate catalog id `{}`", e.id);
            assert!(!e.command.is_empty());
            assert!(!e.name.is_empty());
            assert!(!e.description.is_empty());
        }
        // Filesystem server is the flagship entry: needs a root arg.
        let fs = cat.iter().find(|e| e.id == "filesystem").expect("filesystem entry");
        assert!(fs.args.iter().any(|a| a.contains("{home}")));
    }

    #[test]
    fn def_from_catalog_expands_home_placeholder() {
        let cat = catalog();
        let fs = cat.iter().find(|e| e.id == "filesystem").unwrap();
        let def = def_from_catalog(fs);
        assert!(def.from_gallery && def.enabled);
        assert!(def.args.iter().all(|a| !a.contains("{home}")));
        assert_eq!(def.id, "filesystem");
    }

    #[test]
    fn find_tool_matches_wire_names_only() {
        let entries = vec![McpToolEntry {
            server_id: "memory".into(),
            server_name: "Memory".into(),
            wire_name: wire_tool_name("memory", "create_entities"),
            raw_name: "create_entities".into(),
            kind: ConnectorToolKind::Write,
            description: None,
        }];
        assert!(find_tool(&entries, "mcp_memory_create_entities").is_some());
        // The RAW name must not match — that's the whole point of prefixing.
        assert!(find_tool(&entries, "create_entities").is_none());
    }

    /// Full live round-trip through the exact production path: spawn
    /// (including the Windows cmd.exe /C wrap), initialize, tools/list,
    /// tools/call. Run explicitly with:
    /// cargo test -p conduit everything_server -- --ignored
    /// (first run downloads the package via npx).
    #[test]
    #[ignore = "spawns npx and downloads @modelcontextprotocol/server-everything"]
    fn everything_server_connects_lists_and_calls() {
        let entry = catalog().into_iter().find(|e| e.id == "everything").unwrap();
        let def = def_from_catalog(&entry);
        tauri::async_runtime::block_on(async {
            let session = connect_server(&def).await.expect("spawn + initialize");
            let tools = session.tool_entries(&def).await.expect("tools/list");
            assert!(!tools.is_empty(), "everything server always exposes tools");
            assert!(
                tools.iter().all(|t| t.wire_name.starts_with("mcp_everything_")),
                "wire names must be prefixed, got: {:?}",
                tools.iter().map(|t| t.wire_name.as_str()).take(3).collect::<Vec<_>>()
            );
            let echo = session
                .call_tool("echo", &serde_json::json!({ "message": "gallery smoke" }))
                .await
                .expect("tools/call echo");
            assert!(echo.contains("gallery smoke"), "echo must return the message: {echo}");
        });
    }
}
