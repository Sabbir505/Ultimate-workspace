//! ACP agent registry (roadmap #20): static entries for known Zed/Devin
//! ecosystem binaries, merged with user-defined agents from the `acp.agents`
//! app_settings JSON blob. `list_acp_agents` surfaces them to the agent menu
//! with install detection; `find_agent` resolves an `acp:<id>` chat-session
//! selection into a spawnable definition for agent_sessions.rs.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One ACP agent definition (static or user-configured).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentDef {
    pub id: String,
    pub display_name: String,
    /// Command on PATH (or an absolute path). npm-installed CLIs are `.cmd`
    /// shims on Windows — the spawn path wraps them via
    /// `harness_adapters::resolve_for_spawn`, same as the harness CLIs.
    pub command: String,
    /// Args that launch the ACP stdio server (e.g. `["--stdio"]`).
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables for the spawn (rarely needed).
    #[serde(default)]
    pub env: HashMap<String, String>,
}

const ACP_AGENTS_KEY: &str = "acp.agents";

/// Static registry entries. The flags are best-effort defaults — different
/// agent builds expose ACP on different flags, so the settings panel lets
/// users edit command/args per agent; an entry with the wrong args simply
/// fails the spawn and surfaces the error to the chat.
pub fn static_agents() -> Vec<AcpAgentDef> {
    vec![
        AcpAgentDef {
            id: "zed".into(),
            display_name: "Zed".into(),
            command: "zed".into(),
            args: vec!["--stdio".into()],
            env: HashMap::new(),
        },
        AcpAgentDef {
            id: "devin".into(),
            display_name: "Devin".into(),
            command: "devin".into(),
            args: vec!["--stdio".into()],
            env: HashMap::new(),
        },
    ]
}

/// User-defined agents from the `acp.agents` app_settings blob (an invalid
/// blob degrades to an empty list, mirroring the prompts.templates handling).
pub fn user_agents(conn: &Connection) -> Vec<AcpAgentDef> {
    match crate::db::get_setting(conn, ACP_AGENTS_KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Static + user agents; a user entry with the same id replaces the static
/// default so the settings panel can fix a broken flag set.
pub fn all_agents(conn: &Connection) -> Vec<AcpAgentDef> {
    let mut by_id: HashMap<String, AcpAgentDef> = HashMap::new();
    for a in static_agents() {
        by_id.insert(a.id.clone(), a);
    }
    for a in user_agents(conn) {
        by_id.insert(a.id.clone(), a);
    }
    by_id.into_values().collect()
}

pub fn find_agent(conn: &Connection, id: &str) -> Option<AcpAgentDef> {
    all_agents(conn).into_iter().find(|a| a.id == id)
}

/// Install probe: an existing path wins directly; a bare command is checked
/// on PATH via the same `--version` probe the harness adapters use (which
/// also confirms the binary actually executes).
pub fn is_installed(def: &AcpAgentDef) -> bool {
    let cmd = def.command.trim();
    if cmd.is_empty() {
        return false;
    }
    if cmd.contains('/') || cmd.contains('\\') {
        return std::path::Path::new(cmd).exists();
    }
    crate::harness_adapters::binary_on_path(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_registry_has_zed_and_devin() {
        let agents = static_agents();
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"zed"));
        assert!(ids.contains(&"devin"));
        for a in agents {
            assert!(!a.command.is_empty());
        }
    }

    #[test]
    fn user_entries_override_static_same_id() {
        let conn = in_memory_conn();
        crate::db::set_setting(
            &conn,
            ACP_AGENTS_KEY,
            r#"[{"id":"zed","displayName":"Zed (custom)","command":"/custom/zed","args":[]}]"#,
        )
        .unwrap();
        let all = all_agents(&conn);
        let zed = all.iter().find(|a| a.id == "zed").unwrap();
        assert_eq!(zed.display_name, "Zed (custom)");
        assert_eq!(zed.command, "/custom/zed");
        // Static entries not overridden still present.
        assert!(all.iter().any(|a| a.id == "devin"));
    }

    #[test]
    fn find_agent_resolves_static_and_missing() {
        let conn = in_memory_conn();
        assert!(find_agent(&conn, "zed").is_some());
        assert!(find_agent(&conn, "devin").is_some());
        assert!(find_agent(&conn, "no-such-agent").is_none());
    }

    #[test]
    fn corrupt_blob_degrades_to_static_only() {
        let conn = in_memory_conn();
        crate::db::set_setting(&conn, ACP_AGENTS_KEY, "{ not json").unwrap();
        let all = all_agents(&conn);
        assert_eq!(all.len(), static_agents().len());
    }

    fn in_memory_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }
}
