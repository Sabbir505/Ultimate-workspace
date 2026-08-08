//! App-side half of the `conduit-tools` MCP server. The relay binary forwards
//! `tools/call` for generate_document / generate_diagram / generate_file /
//! get_skill / list_skills over the loopback WebSocket; this module runs them
//! through the SAME `chat::tools::execute_tool` dispatcher the built-in chat
//! uses, so the harness gets the identical output pipeline and artifact
//! classification. Generated files land in the shared artifacts dir, where
//! the session's DirWatch post-turn diff surfaces them as artifact chips.

use serde_json::{json, Value};
use crate::browser_mcp::McpError;
use crate::chat::tools::{self, ToolCaps};

/// The only chat tools the MCP relay may invoke. The WS server must not rely
/// on the relay binary's own `tool_op` whitelist for authorization: any local
/// process holding the auth token could otherwise reach mutating tools
/// (write_file/delete_file/run_shell/…) with no permission-mode gate, since
/// this path intentionally runs the same ungated dispatcher the built-in chat
/// uses (where the caller enforces the gate BEFORE reaching execute_tool).
const ALLOWED_RELAY_TOOLS: [&str; 5] = [
    tools::GENERATE_DOCUMENT,
    tools::GENERATE_DIAGRAM,
    tools::GENERATE_FILE,
    tools::GET_SKILL,
    tools::LIST_SKILLS,
];

/// Strip the `conduit_tools:` prefix from a WS op; None for non-tool ops and
/// for any tool outside the relay whitelist (those fall through to
/// `unknown_op` in the dispatcher).
pub fn tool_from_op(op: &str) -> Option<String> {
    let rest = op.strip_prefix("conduit_tools:")?;
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

/// Execute one conduit-tools call and return the text result + artifact info.
pub async fn execute_conduit_tool(
    app: &tauri::AppHandle,
    tool_name: &str,
    args: &Value,
) -> Result<Value, McpError> {
    // Same client construction the built-in chat uses (chat/mod.rs).
    let client = reqwest::Client::new();
    let artifacts_dir = crate::chat::dispatch::artifacts_dir(app);
    let caps = ToolCaps::default();
    let outcome = tools::execute_tool(&client, &artifacts_dir, &caps, tool_name, args).await;
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
        assert_eq!(tool_from_op("conduit_tools:generate_document"), Some("generate_document".to_string()));
        assert_eq!(tool_from_op("navigate"), None);
        assert_eq!(tool_from_op("conduit_tools:"), None);
        // Mutating/dangerous chat tools must be rejected server-side even
        // though they exist in chat::tools (no permission gate on this path).
        assert_eq!(tool_from_op("conduit_tools:delete_file"), None);
        assert_eq!(tool_from_op("conduit_tools:write_file"), None);
        assert_eq!(tool_from_op("conduit_tools:run_shell"), None);
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
        };
        assert_eq!(outcome_text(&o), "hello");
        assert!(outcome_artifact_json(&o).is_null());
    }
}
