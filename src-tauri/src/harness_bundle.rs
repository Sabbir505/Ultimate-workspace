//! Conduit-owned per-project config bundle for harness sessions (design:
//! docs/superpowers/specs/2026-08-05-harness-parity-design.md).
//!
//! Everything the CLIs read (instructions, permissions, MCP registration)
//! lives under `<app-data>/harness/<safe-project-id>/` — never in the project
//! folder, so a user's hand-maintained `.claude/` / `opencode.json` is never
//! clobbered. All builders here are pure; the write side lives with the
//! spawn integration in agent_sessions.rs.

use serde_json::{json, Value};

/// Environment preamble + Conduit core system prompt + skill catalog.
/// Provider-specific parts of the built-in chat prompt are excluded — the
/// CLI has its own provider personality.
pub fn build_instructions_md(project_path: &str, artifacts_dir: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "You are running inside Conduit. The project is at `{project_path}`. \
         Generated documents and diagrams must go to `{artifacts_dir}` via the \
         `conduit-tools` MCP tools (`generate_document`, `generate_diagram`, \
         `generate_file`) — do not hand-build docx/pptx/pdf yourself. Use \
         `get_skill` to load the detailed guidance for a skill before \
         producing it. The skills catalog is:"
    ));
    if let Some(catalog) = crate::chat::prompts::available_skills_segment() {
        parts.push(catalog);
    }
    parts.push(crate::chat::prompts::core_prompt_base());
    parts.join("\n\n")
}

/// Claude Code `--settings` content: conduit-safe auto, danger gated.
pub fn build_claude_settings_json(project_path: &str, artifacts_dir: &str) -> Value {
    json!({
        "permissions": {
            "defaultMode": "acceptEdits",
            "allow": [
                "mcp__conduit-tools__*",
                "Bash(git:*)"
            ],
            "additionalDirectories": [project_path, artifacts_dir]
        }
    })
}

/// Kimi `--agent-file` content: Markdown agent definition whose body is the
/// harness instructions. Frontmatter per kimi-code's agent file format.
pub fn build_kimi_agent_md(project_path: &str, artifacts_dir: &str) -> String {
    format!(
        "---\nname: conduit\ndescription: Conduit-assisted agent with document generation skills\n---\n\n{}",
        build_instructions_md(project_path, artifacts_dir)
    )
}

/// `.mcp.json` registering BOTH conduit-browser and conduit-tools (same
/// binary, same env — the binary routes by tool name).
pub fn build_tools_mcp_json(mcp_binary_path: &str, project_id: &str, ws_port: u16) -> Value {
    let server = || {
        json!({
            "command": mcp_binary_path,
            "env": {
                "CONDUIT_PROJECT_ID": project_id,
                "CONDUIT_WS_PORT": ws_port.to_string()
            }
        })
    };
    json!({
        "mcpServers": {
            "conduit-browser": server(),
            "conduit-tools": server()
        }
    })
}

/// OpenCode config: mcp (both servers) + permission section + instructions.
pub fn build_opencode_tools_config(
    mcp_binary_path: &str,
    project_id: &str,
    ws_port: u16,
    instructions_path: &str,
) -> Value {
    let server = |name: &str| {
        json!({
            "type": "local",
            "command": [mcp_binary_path],
            "environment": {
                "CONDUIT_PROJECT_ID": project_id,
                "CONDUIT_WS_PORT": ws_port.to_string()
            }
        })
    };
    json!({
        "mcp": {
            "conduit-browser": server("conduit-browser"),
            "conduit-tools": server("conduit-tools")
        },
        "instructions": [instructions_path],
        "permission": {
            "allow": ["mcp__conduit-tools"],
            "edit": ["*"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_contain_preamble_and_skill_catalog() {
        let md = build_instructions_md("C:/work/proj", "C:/work/out");
        assert!(md.contains("You are running inside Conduit"));
        assert!(md.contains("C:/work/proj"));
        assert!(md.contains("C:/work/out"));
        // Skill catalog from available_skills_segment (docx is a built-in).
        assert!(md.contains("docx"));
    }

    #[test]
    fn claude_settings_shape() {
        let v = build_claude_settings_json("C:/work/proj", "C:/work/out");
        assert_eq!(v["permissions"]["defaultMode"], "acceptEdits");
        let allow = v["permissions"]["allow"].as_array().unwrap();
        assert!(allow.iter().any(|x| x == "mcp__conduit-tools__*"));
        assert!(allow.iter().any(|x| x == "Bash(git:*)"));
        let dirs = v["permissions"]["additionalDirectories"].as_array().unwrap();
        assert!(dirs.iter().any(|x| x == "C:/work/out"));
    }

    #[test]
    fn kimi_agent_md_has_frontmatter_and_prompt() {
        let md = build_kimi_agent_md("C:/work/proj", "C:/work/out");
        assert!(md.starts_with("---\n"));
        assert!(md.contains("name: conduit"));
        assert!(md.contains("You are running inside Conduit"));
    }

    #[test]
    fn tools_mcp_json_registers_both_servers() {
        let v = build_tools_mcp_json("C:/app/conduit-browser-mcp.exe", "p1", 7681);
        assert!(v["mcpServers"]["conduit-browser"]["command"].is_string());
        assert!(v["mcpServers"]["conduit-tools"]["command"].is_string());
        assert_eq!(v["mcpServers"]["conduit-tools"]["env"]["CONDUIT_WS_PORT"], "7681");
    }

    #[test]
    fn opencode_config_has_mcp_permission_instructions() {
        let v = build_opencode_tools_config("C:/app/exe", "p1", 7681, "C:/bundle/opencode-instructions.md");
        assert!(v["mcp"]["conduit-browser"]["type"] == "local");
        assert!(v["mcp"]["conduit-tools"]["type"] == "local");
        assert!(v["instructions"][0] == "C:/bundle/opencode-instructions.md");
        assert!(v["permission"]["allow"].as_array().unwrap().iter().any(|x| x == "mcp__conduit-tools"));
        assert!(v["permission"]["edit"].as_array().unwrap().iter().any(|x| x == "*"));
    }
}
