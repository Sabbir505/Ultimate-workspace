//! App-side half of the `relay-tools` MCP server. The relay binary forwards
//! `tools/call` for generate_document / plan_document / revise_document /
//! generate_diagram / generate_file / get_skill / list_skills / search_docs
//! over the loopback WebSocket; this
//! module runs them through the SAME `chat::tools::execute_tool` dispatcher
//! the built-in chat uses, so the harness gets the identical output pipeline
//! and artifact classification. Generated files land in the shared artifacts
//! dir, where the session's DirWatch post-turn diff surfaces them as artifact
//! chips.

use serde_json::{json, Value};
use crate::browser_mcp::McpError;
use crate::chat::tools::{self, ToolCaps};

/// The only chat tools the MCP relay may invoke. The WS server must not rely
/// on the relay binary's own `tool_op` whitelist for authorization: any local
/// process holding the auth token could otherwise reach mutating tools
/// (write_file/delete_file/run_shell/…) with no permission-mode gate, since
/// this path intentionally runs the same ungated dispatcher the built-in chat
/// uses (where the caller enforces the gate BEFORE reaching execute_tool).
/// `search_docs` is read-only and self-guards at runtime (returns
/// "unavailable" when the embedding sidecar isn't running), so it's safe here.
/// `get_capabilities` is read-only introspection — intercepted in
/// `execute_relay_tool` for the app-level report (ToolCaps::default() here
/// has no per-turn attachment state, so routing it through execute_tool would
/// report a falsely empty connector list). `list_artifacts` is read-only DB
/// introspection — the harness's always-current answer to "where does the
/// report live" (the bundle instructions only carry a spawn-time snapshot).
const ALLOWED_RELAY_TOOLS: [&str; 10] = [
    tools::GENERATE_DOCUMENT,
    tools::PLAN_DOCUMENT,
    tools::REVISE_DOCUMENT,
    tools::GENERATE_DIAGRAM,
    tools::GENERATE_FILE,
    tools::GET_SKILL,
    tools::LIST_SKILLS,
    tools::SEARCH_DOCS,
    tools::GET_CAPABILITIES,
    tools::LIST_ARTIFACTS,
];

/// Strip the `relay_tools:` prefix from a WS op; None for non-tool ops and
/// for any tool outside the relay whitelist (those fall through to
/// `unknown_op` in the dispatcher).
pub fn tool_from_op(op: &str) -> Option<String> {
    let rest = op.strip_prefix("relay_tools:")?;
    if ALLOWED_RELAY_TOOLS.contains(&rest) { Some(rest.to_string()) } else { None }
}

pub fn outcome_text(o: &tools::ToolOutcome) -> &str {
    &o.text
}

pub fn outcome_artifact_json(o: &tools::ToolOutcome) -> Value {
    match &o.artifact {
        Some(a) => json!({ "filename": a.filename, "path": a.path }),
        None => Value::Null,
    }
}

/// Execute one relay-tools call and return the text result + artifact info.
pub async fn execute_relay_tool(
    app: &tauri::AppHandle,
    tool_name: &str,
    args: &Value,
) -> Result<Value, McpError> {
    // The availability report is app-level on this path (no per-turn
    // attachment state exists for a harness CLI) — build it directly instead
    // of the ToolCaps-driven report execute_tool would produce.
    if tool_name == tools::GET_CAPABILITIES {
        let text = tools::app_capabilities_report(app).await;
        return Ok(json!({ "text": text, "artifact": Value::Null }));
    }
    // Same client construction the built-in chat uses (chat/mod.rs).
    let client = reqwest::Client::new();
    let artifacts_dir = crate::chat::dispatch::artifacts_dir(app);
    let caps = ToolCaps::default();
    let outcome = tools::execute_tool(&client, &artifacts_dir, &caps, tool_name, args, Some(app)).await;
    Ok(json!({
        "text": outcome_text(&outcome),
        "artifact": outcome_artifact_json(&outcome)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_extraction() {
        assert_eq!(tool_from_op("relay_tools:generate_document"), Some("generate_document".to_string()));
        assert_eq!(tool_from_op("relay_tools:search_docs"), Some("search_docs".to_string()));
        // Read-only introspection is allowed through the relay.
        assert_eq!(tool_from_op("relay_tools:get_capabilities"), Some("get_capabilities".to_string()));
        // The plan-compiled design path is reachable from harnesses (same
        // artifacts-dir-only risk class as generate_document).
        assert_eq!(tool_from_op("relay_tools:plan_document"), Some("plan_document".to_string()));
        assert_eq!(tool_from_op("relay_tools:revise_document"), Some("revise_document".to_string()));
        assert_eq!(tool_from_op("navigate"), None);
        assert_eq!(tool_from_op("relay_tools:"), None);
        // Mutating/dangerous chat tools must be rejected server-side even
        // though they exist in chat::tools (no permission gate on this path).
        assert_eq!(tool_from_op("relay_tools:delete_file"), None);
        assert_eq!(tool_from_op("relay_tools:write_file"), None);
        assert_eq!(tool_from_op("relay_tools:run_shell"), None);
    }

    #[test]
    fn outcome_text_fallbacks() {
        // ToolOutcome::text → { text, artifact: null }
        // (ToolOutcome's `text` constructor is private to chat::tools, so we
        // build the outcome via a struct literal — all fields are pub.)
        let o = crate::chat::tools::ToolOutcome {
            text: "hello".to_string(),
            artifact: None,
            browse_url: None,
            preview: None,
        };
        assert_eq!(outcome_text(&o), "hello");
        assert!(outcome_artifact_json(&o).is_null());
    }
}
