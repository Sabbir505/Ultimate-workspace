//! `get_capabilities` — the in-process availability/introspection report.
//!
//! Two variants, one contract:
//!
//!   * [`capabilities_report`] — THIS TURN's truth for the built-in chat and
//!     subagents: which connectors/MCP servers are attached right now (with
//!     their live tool lists), which are attachable on demand, and which
//!     built-in tools are enabled. Source of truth: the turn's `ToolCaps` —
//!     the same struct that decides the tool schema, so the report can never
//!     disagree with what the model can actually call.
//!   * [`app_capabilities_report`] — app-level truth for harness CLIs
//!     (Claude Code / Kimi / OpenCode) arriving through the `relay-tools`
//!     MCP relay: every connected connector, installed/enabled MCP-gallery
//!     server, the in-app browser MCP surface, and the skill catalog.
//!
//! WHY this exists: models used to answer "which MCP servers do you have?"
//! by spawning a shell (`claude mcp list`, curl probes, version checks) —
//! a slow, approval-gated process launch whose answer reflects the CLI's
//! config file, not the session's actual toolset. The report is generated in
//! microseconds with no process, and its `note` field says so, which is what
//! lets the shell dispatch REFUSE `mcp list`-style probes
//! (`dispatch::capability_probe_refusal`) without leaving the model stuck.

use serde_json::{json, Value};

use super::ToolCaps;
use crate::chat::tasks::terminal_lifecycle_json;

/// The anti-probe note shipped in every variant — the model-facing line the
/// shell-probe refusal points back to.
const NOTE: &str = "Authoritative availability report, generated in-process. \
Never start a shell process (`claude mcp list`, curl probes, version checks) \
to check connector/MCP availability — call get_capabilities instead. \
Not listed here = not available in this session.";

/// THIS TURN's capability report (built-in chat + subagents). JSON text.
pub fn capabilities_report(caps: &ToolCaps) -> String {
    // Attached connectors: live sessions + the full tool list the model can
    // already call without another attach.
    let attached: Vec<Value> = caps
        .attached_connectors
        .iter()
        .map(|att| {
            let mut tools: Vec<&str> = att.tools.keys().map(|s| s.as_str()).collect();
            tools.sort_unstable();
            let mut fallback: Vec<&str> = att.fallback.iter().map(|s| s.as_str()).collect();
            fallback.sort_unstable();
            json!({
                "id": att.connector_id,
                "name": att.display_name,
                "session": if att.session.is_some() { "live" } else { "local_only" },
                "tools": tools,
                "local_fallback_tools": fallback,
            })
        })
        .collect();

    let attachable: Vec<Value> = caps
        .attachable_connectors
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect();

    // Attached MCP-gallery tools grouped by server, keyed by the WIRE names
    // the model must actually call (`mcp_<server>_<tool>`).
    let mut mcp_attached: Vec<Value> = Vec::new();
    for entry in caps.mcp_tools.iter() {
        match mcp_attached
            .iter_mut()
            .find(|s| s["id"] == entry.server_id.as_str())
        {
            Some(server) => {
                let arr = server["tools"].as_array_mut().unwrap();
                arr.push(Value::String(entry.wire_name.clone()));
            }
            None => mcp_attached.push(json!({
                "id": entry.server_id,
                "name": entry.server_name,
                "tools": [entry.wire_name.clone()],
            })),
        }
    }
    let mcp_attachable: Vec<Value> = caps
        .attachable_mcp
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect();

    let report = json!({
        "note": NOTE,
        "connectors": {
            "attached": attached,
            "attachable": attachable,
            "attach_how": "attach_connector(id) loads a listed connector's tools into this turn",
        },
        "mcp_servers": {
            "attached": mcp_attached,
            "attachable": mcp_attachable,
            "attach_how": "attach_mcp_server(id) loads a listed server's tools into this turn",
        },
        "built_in": {
            "web_search": caps.web_search,
            "code_execution": caps.code_exec,
            "local_docs_search": caps.local_docs,
            "connect_on_demand": !caps.attachable_connectors.is_empty()
                || !caps.attachable_mcp.is_empty(),
            "filesystem_tools": true,
            "browser_pane_tools": true,
            "automations": true,
            "subagents": true,
            "skills": "listed under '## Available skills' in the system prompt; get_skill(slug) loads one",
        },
        "terminal": terminal_lifecycle_json(),
    });
    serde_json::to_string_pretty(&report).unwrap_or_else(|_| format!("{{\"note\":\"{NOTE}\"}}"))
}

/// App-level report for harness CLIs via the `relay-tools` MCP relay.
/// Unlike [`capabilities_report`] there is no per-turn attachment state here
/// (harness sessions register connectors into their CLI config at spawn), so
/// it reports what the APP has connected/installed overall.
pub async fn app_capabilities_report(app: &tauri::AppHandle) -> String {
    use tauri::Manager;
    let db = app.state::<crate::DbState>();
    let (connected_ids, account_displays) = {
        let conn = db.0.lock();
        let rows = crate::db::list_connector_credential_rows(&conn).unwrap_or_default();
        (
            rows.iter().map(|r| r.connector_id.clone()).collect::<Vec<_>>(),
            rows.iter()
                .filter_map(|r| r.account_display.clone())
                .collect::<Vec<_>>(),
        )
    };
    drop(db);

    let mut connected: Vec<Value> = Vec::new();
    for c in crate::connectors::CONNECTORS {
        let id = c.id.to_string();
        if c.is_public() || connected_ids.iter().any(|cid| cid == &id) {
            connected.push(json!({
                "id": id,
                "name": c.display_name,
                "description": c.description,
            }));
        }
    }

    let mcp_gallery: Vec<Value> = crate::mcp_gallery::load_defs(app)
        .iter()
        .map(|d| json!({
            "id": d.id,
            "name": d.name,
            "enabled": d.enabled,
        }))
        .collect();

    let skills: Vec<String> = crate::installed_skills::list_all_skills()
        .iter()
        .map(|s| s.slug.clone())
        .collect();

    let browser_live = crate::browser_mcp::bound_port() != 0;

    let report = json!({
        "note": NOTE,
        "harness_context": "You are a CLI harness running inside Relay (the desktop app). \
This report describes the APP's connections — what Relay registered into your \
MCP config at spawn. Connected connectors appear as MCP servers in your own \
config; do not probe them with shell commands.",
        "connectors": {
            "connected": connected,
            "accounts": account_displays,
        },
        "mcp_gallery": {
            "installed": mcp_gallery,
        },
        "in_app_browser": {
            "available": browser_live,
            "how": "the relay-browser MCP server (tools prefixed mcp__relay-browser__)",
        },
        "relay_tools": [
            "generate_document", "generate_diagram", "generate_file",
            "get_skill", "list_skills", "search_docs", "get_capabilities",
        ],
        "skills": skills,
        "terminal": terminal_lifecycle_json(),
    });
    serde_json::to_string_pretty(&report).unwrap_or_else(|_| format!("{{\"note\":\"{NOTE}\"}}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn caps_with(
        attached: Vec<crate::connectors::AttachedConnector>,
        attachable: Vec<(String, String)>,
    ) -> ToolCaps {
        ToolCaps {
            attached_connectors: Arc::new(attached),
            attachable_connectors: Arc::new(attachable),
            ..Default::default()
        }
    }

    fn attached(id: &str, name: &str, tools: &[&str]) -> crate::connectors::AttachedConnector {
        crate::connectors::AttachedConnector {
            connector_id: id.to_string(),
            display_name: name.to_string(),
            session: None,
            tools: tools
                .iter()
                .map(|t| {
                    (
                        t.to_string(),
                        (crate::chat::permission::ConnectorToolKind::Read, None),
                    )
                })
                .collect::<HashMap<_, _>>(),
            fallback: std::collections::HashSet::new(),
        }
    }

    #[test]
    fn empty_caps_reports_nothing_available_but_valid_json() {
        let out = capabilities_report(&ToolCaps::default());
        let v: Value = serde_json::from_str(&out).expect("report must be valid JSON");
        assert_eq!(v["connectors"]["attached"].as_array().unwrap().len(), 0);
        assert_eq!(v["connectors"]["attachable"].as_array().unwrap().len(), 0);
        // The note is the anti-probe contract — must always ship.
        assert!(v["note"].as_str().unwrap().contains("Never"));
        // Lifecycle contract present (get_capabilities is also how the model
        // learns the terminal rules).
        assert!(v["terminal"]["foreground"]["ceiling_seconds"].is_u64());
    }

    #[test]
    fn report_lists_attached_and_attachable_sources() {
        let caps = caps_with(
            vec![
                attached("gmail", "Gmail", &["search", "send"]),
                attached("gdrive", "Drive", &["find"]),
            ],
            vec![("notion".into(), "Notion".into())],
        );
        let v: Value = serde_json::from_str(&capabilities_report(&caps)).unwrap();
        let attached = v["connectors"]["attached"].as_array().unwrap();
        assert_eq!(attached.len(), 2);
        assert_eq!(attached[0]["id"], "gmail");
        assert_eq!(attached[0]["tools"].as_array().unwrap().len(), 2);
        let attachable = v["connectors"]["attachable"].as_array().unwrap();
        assert_eq!(attachable[0]["id"], "notion");
        assert_eq!(v["built_in"]["connect_on_demand"], json!(true));
    }

    #[test]
    fn mcp_tools_group_by_server_under_wire_names() {
        let mut caps = ToolCaps::default();
        caps.mcp_tools = Arc::new(vec![
            crate::mcp_gallery::McpToolEntry {
                server_id: "memory".into(),
                server_name: "Memory".into(),
                wire_name: "mcp_memory_store".into(),
                raw_name: "store".into(),
                kind: crate::chat::permission::ConnectorToolKind::Write,
                description: None,
            },
            crate::mcp_gallery::McpToolEntry {
                server_id: "memory".into(),
                server_name: "Memory".into(),
                wire_name: "mcp_memory_fetch".into(),
                raw_name: "fetch".into(),
                kind: crate::chat::permission::ConnectorToolKind::Read,
                description: None,
            },
        ]);
        let v: Value = serde_json::from_str(&capabilities_report(&caps)).unwrap();
        let servers = v["mcp_servers"]["attached"].as_array().unwrap();
        assert_eq!(servers.len(), 1, "tools of one server must group together");
        assert_eq!(servers[0]["id"], "memory");
        assert_eq!(servers[0]["tools"].as_array().unwrap().len(), 2);
    }
}
