//! Conduit-owned per-project config bundle for harness sessions (design:
//! docs/superpowers/specs/2026-08-05-harness-parity-design.md).
//!
//! Everything the CLIs read (instructions, permissions, MCP registration)
//! lives under `<app-data>/harness/<safe-project-id>/` — never in the project
//! folder, so a user's hand-maintained `.claude/` / `opencode.json` is never
//! clobbered. All builders here are pure; the write side (`write_bundle`) and
//! the Claude Code spawn args live here too, consumed by agent_sessions.rs.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::connectors::HarnessMcpServer;

/// Which CLI a generated `mcp.json` is for. Claude Code and Kimi share the
/// top-level `mcpServers` shape but describe REMOTE servers differently:
/// Claude wants `"type": "http"`, Kimi infers HTTP from the presence of
/// `url` and documents no `type` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpFlavor {
    Claude,
    Kimi,
}

/// A connected connector as a remote-server entry in a claude/kimi
/// `mcp.json`. Auth rides a static `Authorization: Bearer` header (token
/// refreshed at bundle-write time); public connectors (Kiwi) send none.
fn connector_mcp_json_entry(s: &HarnessMcpServer, flavor: McpFlavor) -> Value {
    let mut v = match flavor {
        McpFlavor::Claude => json!({ "type": "http", "url": s.url }),
        McpFlavor::Kimi => json!({ "url": s.url }),
    };
    if let Some(tok) = &s.bearer_token {
        v["headers"] = json!({ "Authorization": format!("Bearer {tok}") });
    }
    v
}

/// Same, for OpenCode's config: remote servers are `"type": "remote"` under
/// the top-level `mcp` object. `oauth: false` stops OpenCode from starting
/// its own OAuth dance if the baked-in token expires mid-session — token
/// refresh is Conduit's job (done per spawn).
fn connector_opencode_entry(s: &HarnessMcpServer) -> Value {
    let mut v = json!({
        "type": "remote",
        "url": s.url,
        "enabled": true,
        "oauth": false
    });
    if let Some(tok) = &s.bearer_token {
        v["headers"] = json!({ "Authorization": format!("Bearer {tok}") });
    }
    v
}

/// Environment preamble + Conduit core system prompt + skill catalog.
/// Provider-specific parts of the built-in chat prompt are excluded — the
/// CLI has its own provider personality.
pub fn build_instructions_md(project_path: &str, artifacts_dir: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    // Project-less sessions get a bundle too (connectors + conduit-tools) —
    // the preamble just has no project path to point at.
    let location = if project_path.is_empty() {
        "No project folder is selected for this session.".to_string()
    } else {
        format!("The project is at `{project_path}`.")
    };
    parts.push(format!(
        "You are running inside Conduit. {location} \
         Generated documents and diagrams must go to `{artifacts_dir}` via the \
         `conduit-tools` MCP tools (`generate_document`, `generate_diagram`, \
         `generate_file`) — do not hand-build docx/pptx/pdf yourself. Use \
         `get_skill` to load the detailed guidance for a skill before \
         producing it."
    ));
    if let Some(catalog) = crate::chat::prompts::available_skills_segment() {
        parts.push(catalog);
    }
    parts.push(format!(
        "## In-app browser pane\n\
         You have full control of the visible in-app browser pane via the `conduit-browser` \
         MCP server. This is NOT an external browser — it is a real webview embedded in the \
         Conduit window, and every action you take is visible on screen in real time (cursor \
         movement, typing, click ripples, highlights). You are NOT limited to a terminal.\n\n\
         ### Browser MCP tools (prefix: `mcp__conduit-browser__`)\n\
         - `navigate(url, pane_id?)` — Navigate the pane to a URL. Auto-opens a pane if none \
         exists for the project. Use this (not `open_url` or `fetch_url`) when the user asks \
         to open a website, browse, or interact with a web page.\n\
         - `read_page(mode?, pane_id?)` — Read the current page. Modes: `interactive` \
         (default — returns accessibility tree with roles, labels, form state, element refs \
         for clicking/typing), `content` (readability-stripped article text), `full` (raw \
         HTML/text), `summary` (~1500 chars + headings for triage), `section` (extract under \
         a CSS selector or heading). Always call this after navigation before acting.\n\
         - `click(selector_or_description, pane_id?)` — Click an element by CSS selector or \
         by visible text/aria-label/placeholder description.\n\
         - `type_text(selector_or_description, text, pane_id?)` — Type text into an input. \
         Dispatches per-keystroke events so React/Vue controlled inputs work.\n\
         - `scroll(direction, pane_id?)` — Scroll up or down by one viewport step.\n\
         - `wait_for(condition, target?, pane_id?)` — Wait for `navigation` (URL change), \
         `selector` (element exists), or `network_idle` (page settled).\n\n\
         ### Workflow for browser tasks\n\
         1. `navigate(url)` to load the page.\n\
         2. `read_page(mode: \"interactive\")` to get the element tree with refs.\n\
         3. `click` or `type_text` using a selector or description from the read.\n\
         4. `wait_for(\"navigation\")` if the action triggers a page change.\n\
         5. `read_page` again to see the new state. Refs expire after navigation.\n\n\
         ### When to use which tool\n\
         - **Browse / search / research / social media / E2E test** → `navigate` + \
         `read_page` + `click`/`type_text`/`scroll` + `wait_for`. The pane is visible, so \
         the user watches every action live.\n\
         - **Just fetch a page's text silently** → `fetch_url(url)`. No visual feedback, \
         faster for pure content extraction. Use only when the user doesn't need to see the \
         page.\n\
         - **Open a URL in the built-in browser pane** → `navigate(url)` (MCP) or `open_url(url)` (built-in tool). Both open in the in-app pane where you can interact with the page. Always prefer these over fetch_url when the user should see the page.

\
         You are a GUI-capable agent, not a headless CLI. When the user asks you to browse, \
         search, test a web app, or interact with a website, use the browser MCP tools — \
         never say you can't because you're in a terminal."
    ));
    parts.join("\n\n")
}

/// Claude Code `--settings` content: always bypass permissions (the CLI is
/// spawned with `--dangerously-skip-permissions`, the settings file must
/// agree or one silently overrides the other).
pub fn build_claude_settings_json(project_path: &str, artifacts_dir: &str) -> Value {
    // Empty entries (project-less sessions have no project path) must not
    // reach the CLI — an empty additionalDirectory is meaningless.
    let dirs: Vec<&str> = [project_path, artifacts_dir]
        .into_iter()
        .filter(|d| !d.is_empty())
        .collect();
    json!({
        "permissions": {
            "defaultMode": "bypassPermissions",
            "allow": [
                "mcp__conduit-tools__*",
                "Bash(git:*)"
            ],
            "additionalDirectories": dirs
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
/// binary, same env — the binary routes by tool name) PLUS one remote server
/// per connected connector. `auth_token` is the WS auth token
/// (`browser_mcp::mcp_auth_token()`); it travels in the per-server env block
/// so only the MCP child process sees it.
pub fn build_tools_mcp_json(
    mcp_binary_path: &str,
    project_id: &str,
    ws_port: u16,
    auth_token: &str,
    connectors: &[HarnessMcpServer],
    flavor: McpFlavor,
) -> Value {
    let server = || {
        json!({
            "command": mcp_binary_path,
            "env": {
                "CONDUIT_PROJECT_ID": project_id,
                "CONDUIT_WS_PORT": ws_port.to_string(),
                "CONDUIT_MCP_AUTH_TOKEN": auth_token
            }
        })
    };
    let mut servers = json!({
        "conduit-browser": server(),
        "conduit-tools": server()
    });
    for c in connectors {
        servers[c.name.clone()] = connector_mcp_json_entry(c, flavor);
    }
    json!({ "mcpServers": servers })
}

/// OpenCode config: mcp (both servers) + permission section.
///
/// `instructions` is intentionally NOT included as a config key: the installed
/// OpenCode (`opencode --help`) exposes no such key — agents/instructions are
/// managed via the `opencode agent` subcommand and AGENTS.md auto-discovery
/// conventions the user controls. The system-prompt content is therefore
/// delivered to Claude Code / Kimi (which have explicit flags) but NOT to
/// OpenCode via config; OpenCode still gets the conduit-tools MCP server and
/// the permission section, so document/diagram generation works there too.
pub fn build_opencode_tools_config(
    mcp_binary_path: &str,
    project_id: &str,
    ws_port: u16,
    auth_token: &str,
    connectors: &[HarnessMcpServer],
) -> Value {
    let server = |name: &str| {
        json!({
            "type": "local",
            "command": [mcp_binary_path],
            "environment": {
                "CONDUIT_PROJECT_ID": project_id,
                "CONDUIT_WS_PORT": ws_port.to_string(),
                "CONDUIT_MCP_AUTH_TOKEN": auth_token
            }
        })
    };
    let mut mcp = json!({
        "conduit-browser": server("conduit-browser"),
        "conduit-tools": server("conduit-tools")
    });
    for c in connectors {
        mcp[c.name.clone()] = connector_opencode_entry(c);
    }
    json!({
        "mcp": mcp,
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
/// `connectors` are merged into the MCP configs as remote servers (tokens
/// already refreshed by the caller). Returns None only when the base dir
/// cannot be created.
pub fn write_bundle(
    data_dir: &Path,
    project_id: &str,
    project_path: Option<&str>,
    artifacts_dir: Option<&str>,
    _permission: Option<&str>,
    ws_port: u16,
    connectors: &[HarnessMcpServer],
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

    // Write errors must not be swallowed: the returned paths feed CLI spawn
    // args (`--mcp-config-file`, `--agent-file`, …) — a missing file surfaces
    // later as an opaque "cannot read instructions file" spawn error with no
    // hint it was a bundle-write failure (AV lock, read-only dir, disk full).
    // Log the failing file and drop it from the returned set where the
    // callers gate on `.exists()`; the core instructions/settings are fatal
    // (None) because every harness reads them.
    let write_or_none = |path: &std::path::PathBuf, contents: String| -> bool {
        match std::fs::write(path, contents) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[harness_bundle] failed to write {}: {e}", path.display());
                false
            }
        }
    };

    let ok_instructions =
        write_or_none(&claude_instructions, build_instructions_md(pp, ad));
    let ok_settings = write_or_none(
        &claude_settings,
        serde_json::to_string_pretty(&build_claude_settings_json(pp, ad)).unwrap_or_default(),
    );
    let ok_agent = write_or_none(&kimi_agent, build_kimi_agent_md(pp, ad));
    if !ok_instructions || !ok_settings || !ok_agent {
        return None;
    }

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
        let token = crate::browser_mcp::mcp_auth_token();
        let claude_mcp = build_tools_mcp_json(&bin_str, project_id, ws_port, token, connectors, McpFlavor::Claude);
        write_or_none(
            &paths.claude_mcp,
            serde_json::to_string_pretty(&claude_mcp).unwrap_or_default(),
        );
        let kimi_mcp = build_tools_mcp_json(&bin_str, project_id, ws_port, token, connectors, McpFlavor::Kimi);
        write_or_none(
            &paths.kimi_mcp,
            serde_json::to_string_pretty(&kimi_mcp).unwrap_or_default(),
        );
        let oc = build_opencode_tools_config(&bin_str, project_id, ws_port, token, connectors);
        write_or_none(
            &paths.opencode_config,
            serde_json::to_string_pretty(&oc).unwrap_or_default(),
        );
    }

    Some(paths)
}

/// Extra CLI args for a kimi per-turn spawn. `--agent-file` is only valid on a
/// fresh session (kimi forbids it with `--session`); `--mcp-config-file` and
/// `--add-dir` always apply when the bundle exists.
pub fn kimi_bundle_args(bundle: &HarnessBundlePaths, artifacts_dir: &str, resume: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if bundle.kimi_mcp.exists() {
        args.push("--mcp-config-file".into());
        args.push(bundle.kimi_mcp.to_string_lossy().replace('\\', "/"));
    }
    if !resume && bundle.kimi_agent.exists() {
        args.push("--agent-file".into());
        args.push(bundle.kimi_agent.to_string_lossy().replace('\\', "/"));
    }
    if !artifacts_dir.is_empty() {
        args.push("--add-dir".into());
        args.push(artifacts_dir.to_string());
    }
    args
}

/// Extra CLI args for an OpenCode per-turn spawn. None today — the bundle's
/// opencode.json is consumed via the `OPENCODE_CONFIG` env var (set on the
/// Command by the caller), so the per-spawn arg list needs no additional
/// flags. Provided for symmetry with claude/kimi and as the future home for
/// any per-spawn opencode flags.
pub fn opencode_bundle_args(_bundle: &HarnessBundlePaths, _artifacts_dir: &str) -> Vec<String> {
    Vec::new()
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
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
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
    fn project_less_bundle_tolerates_empty_project_path() {
        // Sessions with no selected project still get a bundle (connectors +
        // conduit-tools); instructions and settings must not emit empty paths.
        let md = build_instructions_md("", "C:/work/out");
        assert!(md.contains("No project folder is selected"));
        assert!(!md.contains("The project is at ``"));
        let v = build_claude_settings_json("", "C:/work/out");
        let dirs = v["permissions"]["additionalDirectories"].as_array().unwrap();
        assert_eq!(dirs.len(), 1, "empty project path must be filtered out");
        assert_eq!(dirs[0], "C:/work/out");
    }

    #[test]
    fn tools_mcp_json_registers_both_servers() {
        let v = build_tools_mcp_json("C:/app/conduit-browser-mcp.exe", "p1", 7681, "tok-abc", &[], McpFlavor::Claude);
        assert!(v["mcpServers"]["conduit-browser"]["command"].is_string());
        assert!(v["mcpServers"]["conduit-tools"]["command"].is_string());
        assert_eq!(v["mcpServers"]["conduit-tools"]["env"]["CONDUIT_WS_PORT"], "7681");
        // The WS auth token rides the per-server env block (not process env),
        // on BOTH servers — they share the binary and the WS auth gate.
        assert_eq!(v["mcpServers"]["conduit-browser"]["env"]["CONDUIT_MCP_AUTH_TOKEN"], "tok-abc");
        assert_eq!(v["mcpServers"]["conduit-tools"]["env"]["CONDUIT_MCP_AUTH_TOKEN"], "tok-abc");
    }

    #[test]
    fn tools_mcp_json_merges_connectors_per_flavor() {
        let connectors = vec![
            HarnessMcpServer {
                name: "notion".into(),
                url: "https://mcp.notion.com/mcp".into(),
                bearer_token: Some("tok-notion".into()),
            },
            // Public connector (Kiwi): no auth header at all.
            HarnessMcpServer {
                name: "kiwi".into(),
                url: "https://mcp.kiwi.com".into(),
                bearer_token: None,
            },
        ];
        // Claude flavor: remote servers carry "type": "http".
        let v = build_tools_mcp_json("C:/app/exe", "p1", 7681, "tok", &connectors, McpFlavor::Claude);
        assert_eq!(v["mcpServers"]["notion"]["type"], "http");
        assert_eq!(v["mcpServers"]["notion"]["url"], "https://mcp.notion.com/mcp");
        assert_eq!(v["mcpServers"]["notion"]["headers"]["Authorization"], "Bearer tok-notion");
        assert_eq!(v["mcpServers"]["kiwi"]["type"], "http");
        assert!(v["mcpServers"]["kiwi"]["headers"].is_null());
        // Built-in servers still present alongside connectors.
        assert!(v["mcpServers"]["conduit-tools"]["command"].is_string());
        // Kimi flavor: HTTP inferred from `url`, no "type" field.
        let v = build_tools_mcp_json("C:/app/exe", "p1", 7681, "tok", &connectors, McpFlavor::Kimi);
        assert!(v["mcpServers"]["notion"]["type"].is_null());
        assert_eq!(v["mcpServers"]["notion"]["url"], "https://mcp.notion.com/mcp");
        assert_eq!(v["mcpServers"]["notion"]["headers"]["Authorization"], "Bearer tok-notion");
        assert!(v["mcpServers"]["kiwi"]["headers"].is_null());
    }

    #[test]
    fn opencode_config_has_mcp_permission() {
        let v = build_opencode_tools_config("C:/app/exe", "p1", 7681, "tok-abc", &[]);
        assert!(v["mcp"]["conduit-browser"]["type"] == "local");
        assert!(v["mcp"]["conduit-tools"]["type"] == "local");
        assert_eq!(v["mcp"]["conduit-browser"]["environment"]["CONDUIT_MCP_AUTH_TOKEN"], "tok-abc");
        assert!(v["permission"]["allow"].as_array().unwrap().iter().any(|x| x == "mcp__conduit-tools"));
        assert!(v["permission"]["edit"].as_array().unwrap().iter().any(|x| x == "*"));
    }

    #[test]
    fn opencode_config_merges_connectors_as_remote() {
        let connectors = vec![HarnessMcpServer {
            name: "github".into(),
            url: "https://api.githubcopilot.com/mcp/".into(),
            bearer_token: Some("gho_x".into()),
        }];
        let v = build_opencode_tools_config("C:/app/exe", "p1", 7681, "tok", &connectors);
        assert_eq!(v["mcp"]["github"]["type"], "remote");
        assert_eq!(v["mcp"]["github"]["url"], "https://api.githubcopilot.com/mcp/");
        assert_eq!(v["mcp"]["github"]["headers"]["Authorization"], "Bearer gho_x");
        // Conduit owns token refresh — OpenCode must not start its own OAuth
        // flow when the baked-in token expires.
        assert_eq!(v["mcp"]["github"]["oauth"], false);
        assert!(v["mcp"]["conduit-tools"]["type"] == "local");
    }

    #[test]
    fn kimi_bundle_args_respects_resume() {
        // Both args are gated on .exists() (sidecar present), so point them
        // at real temp files — same approach as the claude_bundle_args_shape test.
        let dir = std::env::temp_dir().join(format!("conduit-kimi-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let kimi_agent = dir.join("agent.md");
        let kimi_mcp = dir.join("mcp.json");
        std::fs::write(&kimi_agent, "---\nname: conduit\n---\n").unwrap();
        std::fs::write(&kimi_mcp, "{}").unwrap();
        let agent_str = kimi_agent.to_string_lossy().replace('\\', "/");
        let mcp_str = kimi_mcp.to_string_lossy().replace('\\', "/");
        let paths = HarnessBundlePaths {
            claude_instructions: PathBuf::from("C:/b/i.md"),
            claude_settings: PathBuf::from("C:/b/s.json"),
            claude_mcp: PathBuf::from("C:/b/m.json"),
            kimi_agent,
            kimi_mcp,
            kimi_skills_dir: PathBuf::from("C:/b/skills"),
            opencode_config: PathBuf::from("C:/b/oc.json"),
        };
        // Fresh session: --agent-file + --mcp-config-file + --add-dir.
        let args = kimi_bundle_args(&paths, "C:/work/out", false);
        let s: Vec<&str> = args.iter().map(|x| x.as_str()).collect();
        assert!(s.windows(2).any(|w| w == ["--agent-file", agent_str.as_str()]));
        assert!(s.windows(2).any(|w| w == ["--mcp-config-file", mcp_str.as_str()]));
        assert!(s.windows(2).any(|w| w == ["--add-dir", "C:/work/out"]));
        // Resume: --agent-file must NOT be passed (kimi forbids it with --session).
        let args = kimi_bundle_args(&paths, "C:/work/out", true);
        let s: Vec<&str> = args.iter().map(|x| x.as_str()).collect();
        assert!(!s.iter().any(|a| *a == "--agent-file"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_bundle_creates_instruction_files() {
        let dir = std::env::temp_dir().join(format!("conduit-bundle-test-{}", uuid::Uuid::new_v4()));
        // instructions/settings/agent write unconditionally (independent of the
        // sidecar binary); the mcp.json / opencode.json parts need
        // mcp_binary_path() and are skipped in CI. Assert the unconditional ones.
        let b = write_bundle(&dir, "p1", Some("C:/work/proj"), Some("C:/work/out"), None, 7681, &[]);
        let b = b.expect("base dir should create");
        assert!(b.claude_instructions.exists(), "claude instructions written");
        assert!(b.claude_settings.exists(), "claude settings written");
        assert!(b.kimi_agent.exists(), "kimi agent written");
        let md = std::fs::read_to_string(&b.claude_instructions).unwrap();
        assert!(md.contains("You are running inside Conduit"));
        // The settings.json always has bypassPermissions under the new regime
        // (the CLI spawn uses --dangerously-skip-permissions, the settings file must agree).
        let settings: Value = serde_json::from_str(
            &std::fs::read_to_string(&b.claude_settings).unwrap()
        ).unwrap();
        assert_eq!(settings["permissions"]["defaultMode"], "bypassPermissions");
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
