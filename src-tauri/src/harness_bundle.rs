//! Conduit-owned per-project config bundle for harness sessions (design:
//! docs/superpowers/specs/2026-08-05-harness-parity-design.md).
//!
//! Everything the CLIs read (instructions, permissions, MCP registration)
//! lives under `<app-data>/harness/<safe-project-id>/` — never in the project
//! folder, so a user's hand-maintained `.claude/` / `opencode.json` is never
//! clobbered. All builders here are pure; the write side (`write_bundle`) and
//! the Claude Code spawn args live here too, consumed by agent_sessions.rs.

use std::path::{Path, PathBuf};

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

pub struct HarnessBundlePaths {
    pub claude_instructions: PathBuf,
    pub claude_settings: PathBuf,
    pub claude_mcp: PathBuf,
    pub kimi_agent: PathBuf,
    pub kimi_mcp: PathBuf,
    pub kimi_skills_dir: PathBuf,
    pub opencode_config: PathBuf,
}

/// Sanitize a project id into a filesystem-safe segment.
fn safe_id(project_id: &str) -> String {
    project_id.chars().map(|c| {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }
    }).collect()
}

/// Write the full per-project harness bundle. The mcp.json / opencode.json
/// parts require the sidecar binary (mcp_binary_path()); when it's absent
/// those two files are skipped but instructions/settings/agent still write.
/// Returns None only when the base dir cannot be created.
pub fn write_bundle(
    data_dir: &Path,
    project_id: &str,
    project_path: Option<&str>,
    artifacts_dir: Option<&str>,
    ws_port: u16,
) -> Option<HarnessBundlePaths> {
    let base = data_dir.join("harness").join(safe_id(project_id));
    if std::fs::create_dir_all(&base).is_err() {
        return None;
    }
    let claude_dir = base.join("claude");
    let kimi_dir = base.join("kimi");
    let _ = std::fs::create_dir_all(&claude_dir);
    let _ = std::fs::create_dir_all(&kimi_dir);

    let pp = project_path.unwrap_or("");
    let ad = artifacts_dir.unwrap_or("");

    let claude_instructions = claude_dir.join("instructions.md");
    let claude_settings = claude_dir.join("settings.json");
    let kimi_agent = kimi_dir.join("agent.md");
    let _ = std::fs::write(&claude_instructions, build_instructions_md(pp, ad));
    let _ = std::fs::write(&claude_settings,
        serde_json::to_string_pretty(&build_claude_settings_json(pp, ad)).unwrap_or_default());
    let _ = std::fs::write(&kimi_agent, build_kimi_agent_md(pp, ad));

    let mut paths = HarnessBundlePaths {
        claude_instructions, claude_settings,
        claude_mcp: claude_dir.join("mcp.json"),
        kimi_agent,
        kimi_mcp: kimi_dir.join("mcp.json"),
        kimi_skills_dir: kimi_dir.join("skills"),
        opencode_config: base.join("opencode.json"),
    };

    // MCP registration needs the sidecar binary; skip silently if absent.
    if let Some(bin) = crate::browser_mcp_register::mcp_binary_path() {
        let bin_str = bin.to_string_lossy().replace('\\', "/");
        let mcp = build_tools_mcp_json(&bin_str, project_id, ws_port);
        let _ = std::fs::write(&paths.claude_mcp,
            serde_json::to_string_pretty(&mcp).unwrap_or_default());
        let _ = std::fs::write(&paths.kimi_mcp,
            serde_json::to_string_pretty(&mcp).unwrap_or_default());
        let oc = build_opencode_tools_config(&bin_str, project_id, ws_port,
            &paths.claude_instructions.to_string_lossy().replace('\\', "/"));
        let _ = std::fs::write(&paths.opencode_config,
            serde_json::to_string_pretty(&oc).unwrap_or_default());
    }

    Some(paths)
}

/// Extra CLI args for a Claude Code spawn carrying the bundle. The MCP args
/// are only added when the mcp.json exists (sidecar present).
pub fn claude_bundle_args(bundle: &HarnessBundlePaths, artifacts_dir: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("--append-system-prompt-file".into());
    args.push(bundle.claude_instructions.to_string_lossy().replace('\\', "/"));
    args.push("--settings".into());
    args.push(bundle.claude_settings.to_string_lossy().replace('\\', "/"));
    if bundle.claude_mcp.exists() {
        args.push("--mcp-config".into());
        args.push(bundle.claude_mcp.to_string_lossy().replace('\\', "/"));
        args.push("--allowedTools".into());
        args.push("mcp__conduit-browser".into());
        args.push("mcp__conduit-tools".into());
    }
    if !artifacts_dir.is_empty() {
        args.push("--add-dir".into());
        args.push(artifacts_dir.to_string());
    }
    args
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

    #[test]
    fn write_bundle_creates_instruction_files() {
        let dir = std::env::temp_dir().join(format!("conduit-bundle-test-{}", uuid::Uuid::new_v4()));
        // instructions/settings/agent write unconditionally (independent of the
        // sidecar binary); the mcp.json / opencode.json parts need
        // mcp_binary_path() and are skipped in CI. Assert the unconditional ones.
        let b = write_bundle(&dir, "p1", Some("C:/work/proj"), Some("C:/work/out"), 7681);
        let b = b.expect("base dir should create");
        assert!(b.claude_instructions.exists(), "claude instructions written");
        assert!(b.claude_settings.exists(), "claude settings written");
        assert!(b.kimi_agent.exists(), "kimi agent written");
        let md = std::fs::read_to_string(&b.claude_instructions).unwrap();
        assert!(md.contains("You are running inside Conduit"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_bundle_args_shape() {
        // The MCP args are gated on claude_mcp existing (sidecar present), so
        // point it at a real file to exercise the full arg shape.
        let mcp_dir = std::env::temp_dir().join(format!("conduit-bundle-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&mcp_dir).unwrap();
        let mcp_json = mcp_dir.join("m.json");
        std::fs::write(&mcp_json, "{}").unwrap();
        let mcp_str = mcp_json.to_string_lossy().replace('\\', "/");
        let paths = HarnessBundlePaths {
            claude_instructions: PathBuf::from("C:/b/i.md"),
            claude_settings: PathBuf::from("C:/b/s.json"),
            claude_mcp: mcp_json,
            kimi_agent: PathBuf::from("C:/b/a.md"),
            kimi_mcp: PathBuf::from("C:/b/km.json"),
            kimi_skills_dir: PathBuf::from("C:/b/skills"),
            opencode_config: PathBuf::from("C:/b/oc.json"),
        };
        let args = claude_bundle_args(&paths, "C:/work/out");
        let s: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let idx = |f: &str| s.iter().position(|a| *a == f).unwrap();
        assert_eq!(s[idx("--append-system-prompt-file") + 1], "C:/b/i.md");
        assert_eq!(s[idx("--settings") + 1], "C:/b/s.json");
        assert_eq!(s[idx("--mcp-config") + 1], mcp_str.as_str());
        assert_eq!(s[idx("--add-dir") + 1], "C:/work/out");
        // Both MCP servers listed in one variadic --allowedTools.
        let allow_idx = idx("--allowedTools");
        assert_eq!(s[allow_idx + 1], "mcp__conduit-browser");
        assert_eq!(s[allow_idx + 2], "mcp__conduit-tools");
        let _ = std::fs::remove_dir_all(&mcp_dir);
    }
}
