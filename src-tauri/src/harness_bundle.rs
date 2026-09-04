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

/// Environment preamble + skill catalog + browser workflow for harness CLIs.
/// The built-in chat's CORE prompt (identity/communication/tool-routing text
/// in `chat::prompts`) is intentionally NOT included — the CLI ships its own
/// provider personality and behavioral guidance; only the Conduit-specific
/// environment (project path, artifacts dir, conduit-tools, browser pane)
/// is additive information the CLI can't know on its own.
pub fn build_instructions_md(
    project_path: &str,
    artifacts_dir: &str,
    artifacts_section: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    // Project-less sessions get a bundle too (connectors + conduit-tools) —
    // the preamble just has no project path to point at.
    let location = if project_path.is_empty() {
        "No project folder is selected for this session.".to_string()
    } else {
        format!("The project is at `{project_path}`.")
    };
    parts.push(format!(
        "You are running inside Relay. {location} \
         Generated documents and diagrams must go to `{artifacts_dir}` via the \
         `conduit-tools` MCP tools — do not hand-build docx/pptx/pdf yourself. \
         For a polished docx/pptx/pdf, PREFER `plan_document`: you author a \
         structured plan (outline, layouts, slot text, chart data); Relay \
         validates it, compiles it against the design system, and runs design \
         QA. Fix any QA warnings by re-calling with a revised plan, or make \
         copy tweaks with `revise_document` (targeted patches, no full \
         regeneration). Fall back to `generate_document` for xlsx or when the \
         planner is unavailable. Use `get_skill` to load the detailed guidance \
         for a skill before producing it. To check which connectors / MCP \
         servers / skills are \
         available, call `get_capabilities` on `conduit-tools` — never run \
         `claude mcp list` (or similar probes) in your terminal: that spawns \
         processes to re-derive what the app already knows and reads your \
         config file instead of the live session."
    ));
    // Artifact awareness, right after the preamble: "where do artifacts live"
    // / "open the report we made" must resolve to real files, not a shrug.
    if !artifacts_section.trim().is_empty() {
        parts.push(artifacts_section.to_string());
    }
    if let Some(catalog) = crate::chat::prompts::available_skills_segment() {
        parts.push(catalog);
    }
    // Browser section stays behavioral only: the MCP `tools/list` response
    // already delivers each tool's name/params/description to the CLI, so
    // restating them here is duplicate tokens. What the schemas can't carry —
    // the observe→act loop, triage policy, and routing decisions — stays.
    parts.push(format!(
        "## In-app browser pane\n\
         You control the visible in-app browser pane via the `conduit-browser` MCP server \
         (tools prefixed `mcp__conduit-browser__`). You are a GUI-capable agent, not a headless \
         CLI — when the user asks you to browse, search, test a web app, or interact with a \
         site, use these tools; never say you can't because you're in a terminal. Every action \
         is visible on screen in real time.\n\n\
         Workflow: `navigate(url)` → `read_page(mode:\"interactive\")` for the element tree → \
         `click`/`type_text` by selector or description → `wait_for(\"navigation\")` if the page \
         changed → `read_page` again (refs expire after navigation).\n\n\
         Routing: browse/research/E2E-test → navigate + read_page + click/type_text + wait_for. \
         Silent text-only fetch the user needn't watch → `fetch_url`. Opening a site for the \
         user → `navigate` (or the built-in `open_url`) — always prefer these over fetch_url \
         when the user should see the page.\n\n\
         Previewing an app you built: a STATIC app (HTML/CSS/JS files on disk) needs NO local \
         server — `navigate` straight to its index.html via a file:/// URL (e.g. \
         file:///C:/proj/index.html). Only framework dev servers (vite/next/…) need starting \
         first as a background task, then navigate to http://localhost:PORT. Never leave a \
         serve command blocking in the foreground."
    ));
    parts.join("\n\n")
}

/// "## Artifacts" awareness block for the harness instructions. The CLI has no
/// other way to learn where Relay keeps generated artifacts, so questions like
/// "open the report we made" otherwise resolve to a shrug. `recent` lines are
/// pre-rendered by the caller ("- path (kind, date)") since they need the DB;
/// empty inputs (no dir, no artifacts) produce no section.
pub fn build_artifacts_section(default_export_dir: &str, recent: &[String]) -> String {
    if default_export_dir.trim().is_empty() && recent.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "## Artifacts\n\n\
         Everything Relay generates for you (documents, charts, exports, \
         reports) is saved on disk and stays readable. Relay's default export \
         folder",
    );
    if !default_export_dir.trim().is_empty() {
        s.push_str(&format!(" is `{default_export_dir}`"));
    }
    s.push_str(
        ". When the user asks about an artifact — a report, a document, a chart, \
         an export, even by an approximate name — list and read files from that \
         folder and the project folder with your file tools instead of saying \
         you don't have it.\n",
    );
    if !recent.is_empty() {
        s.push_str("\nMost recent artifacts:\n");
        for line in recent {
            s.push_str(line);
            s.push('\n');
        }
    }
    s
}

/// Claude Code `--settings` content. `sandbox` + `approval` are the chat
/// session's dual policies: `full_access` approval keeps the historical
/// bypass (paired with `--dangerously-skip-permissions` at spawn — the two
/// must agree or one silently overrides the other); `auto_edit` maps to
/// `acceptEdits`; `read_only` sandbox and `on_request` approval use
/// `default`, which routes every unmatched tool call to Conduit's approval
/// card via `--permission-prompt-tool stdio`.
pub fn build_claude_settings_json(
    project_path: &str,
    artifacts_dir: &str,
    sandbox: Option<&str>,
    approval: Option<&str>,
) -> Value {
    // Empty entries (project-less sessions have no project path) must not
    // reach the CLI — an empty additionalDirectory is meaningless.
    let dirs: Vec<&str> = [project_path, artifacts_dir]
        .into_iter()
        .filter(|d| !d.is_empty())
        .collect();
    // Map the dual policies to Claude Code's single defaultMode. The approval
    // dimension dominates: full_access → bypass, auto_edit → acceptEdits,
    // on_request → default. read_only sandbox also forces default.
    let default_mode = match (sandbox.unwrap_or("workspace_write"), approval.unwrap_or("full_access")) {
        ("read_only", _) => "default",
        (_, "full_access") => "bypassPermissions",
        (_, "auto_edit") => "acceptEdits",
        // on_request / unknown → prompt. Fail CLOSED: a stray value must
        // never widen permissions.
        _ => "default",
    };
    json!({
        "permissions": {
            "defaultMode": default_mode,
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
pub fn build_kimi_agent_md(
    project_path: &str,
    artifacts_dir: &str,
    artifacts_section: &str,
) -> String {
    format!(
        "---\nname: conduit\ndescription: Relay-assisted agent with document generation skills\n---\n\n{}",
        build_instructions_md(project_path, artifacts_dir, artifacts_section)
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
///
/// `approval` mirrors the chat-session approval policy. The allow-all
/// permission block is emitted ONLY for unattended runs (`full_access`, or
/// `None` — the headless historical default): interactive PTY panes pass
/// `on_request`, which OMITS the block so OpenCode's own TUI accept/deny
/// prompts stay in charge instead of silently auto-approving edits.
pub fn build_opencode_tools_config(
    mcp_binary_path: &str,
    project_id: &str,
    ws_port: u16,
    auth_token: &str,
    connectors: &[HarnessMcpServer],
    approval: Option<&str>,
) -> Value {
    let server = |_name: &str| {
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
    // Permission values MUST be OpenCode's rule shape ("allow"/"ask"/"deny"
    // strings or pattern→string maps) — Claude-Code-style arrays fail
    // validation and make every `opencode run` exit instantly with
    // "Configuration is invalid". Full-auto here: headless runs have no
    // approval channel (matches the `--auto` spawn flag).
    //
    // `external_directory` MUST be allowed too: opencode's read/glob/grep
    // tools route every path outside the session's working directory through
    // a `permission:"external_directory"` ask (Tool.assertExternalDirectory).
    // Headless there is nobody to answer it, so an attachment saved under the
    // artifacts dir would hang the turn forever on "reading file". Composer
    // attachments live outside the cwd by design, so this allow is what makes
    // harness attachment viewing work at all.
    let mut v = json!({ "mcp": mcp });
    if approval.unwrap_or("full_access") == "full_access" {
        v["permission"] = json!({
            "edit": "allow",
            "bash": "allow",
            "webfetch": "allow",
            "external_directory": "allow"
        });
    }
    v
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
    sandbox: Option<&str>,
    approval: Option<&str>,
    ws_port: u16,
    connectors: &[HarnessMcpServer],
    artifacts_section: &str,
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
        write_or_none(&claude_instructions, build_instructions_md(pp, ad, artifacts_section));
    let ok_settings = write_or_none(
        &claude_settings,
        serde_json::to_string_pretty(&build_claude_settings_json(pp, ad, sandbox, approval))
            .unwrap_or_default(),
    );
    let ok_agent = write_or_none(&kimi_agent, build_kimi_agent_md(pp, ad, artifacts_section));
    if !ok_instructions || !ok_settings || !ok_agent {
        return None;
    }

    let paths = HarnessBundlePaths {
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
        let oc = build_opencode_tools_config(&bin_str, project_id, ws_port, token, connectors, approval);
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
        let md = build_instructions_md("C:/work/proj", "C:/work/out", "");
        assert!(md.contains("You are running inside Relay"));
        assert!(md.contains("C:/work/proj"));
        assert!(md.contains("C:/work/out"));
        // Skill catalog from available_skills_segment (docx is a built-in).
        assert!(md.contains("docx"));
        // The plan-compiled design path must be advertised to harness agents
        // (and preferred over the legacy generate_document).
        assert!(md.contains("plan_document"), "instructions must mention plan_document");
        assert!(md.contains("revise_document"), "instructions must mention revise_document");
    }

    #[test]
    fn artifacts_section_lists_dir_and_recent_files() {
        let section = build_artifacts_section(
            "C:/Users/x/Documents/Conduit",
            &["- report.docx (docx, 2026-09-01)".into()],
        );
        assert!(section.contains("## Artifacts"));
        assert!(section.contains("C:/Users/x/Documents/Conduit"));
        assert!(section.contains("report.docx"));

        // Nothing known → no section at all (the instructions skip it).
        assert!(build_artifacts_section("", &[]).is_empty());

        // The section is only appended when non-empty.
        let md = build_instructions_md("C:/work/proj", "C:/work/out", "");
        assert!(!md.contains("## Artifacts"));
        let md = build_instructions_md(
            "C:/work/proj",
            "C:/work/out",
            &build_artifacts_section("C:/export", &["- a.csv (csv, 2026-09-04)".into()]),
        );
        assert!(md.contains("## Artifacts"));
        assert!(md.contains("a.csv"));
    }

    #[test]
    fn claude_settings_shape() {
        // No mode passed (legacy callers) = the historical bypass default.
        let v = build_claude_settings_json("C:/work/proj", "C:/work/out", None, None);
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
        let allow = v["permissions"]["allow"].as_array().unwrap();
        assert!(allow.iter().any(|x| x == "mcp__conduit-tools__*"));
        assert!(allow.iter().any(|x| x == "Bash(git:*)"));
        let dirs = v["permissions"]["additionalDirectories"].as_array().unwrap();
        assert!(dirs.iter().any(|x| x == "C:/work/out"));
    }

    #[test]
    fn claude_settings_permission_mode_mapping() {
        // full_access approval stays bypass (paired with --dangerously-skip-permissions);
        // auto_edit approval pre-approves edits; on_request approval and
        // read_only sandbox route everything unmatched to the stdio permission
        // prompt.
        let v = build_claude_settings_json("C:/p", "C:/out", Some("workspace_write"), Some("full_access"));
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
        let v = build_claude_settings_json("C:/p", "C:/out", Some("workspace_write"), Some("auto_edit"));
        assert_eq!(v["permissions"]["defaultMode"], "acceptEdits");
        let v = build_claude_settings_json("C:/p", "C:/out", Some("workspace_write"), Some("on_request"));
        assert_eq!(v["permissions"]["defaultMode"], "default", "on_request");
        let v = build_claude_settings_json("C:/p", "C:/out", Some("read_only"), Some("on_request"));
        assert_eq!(v["permissions"]["defaultMode"], "default", "read_only");
        // Unknown approval values fail closed to prompting, NOT bypass.
        let v = build_claude_settings_json("C:/p", "C:/out", Some("workspace_write"), Some("bogus"));
        assert_eq!(v["permissions"]["defaultMode"], "default");
    }

    #[test]
    fn kimi_agent_md_has_frontmatter_and_prompt() {
        let md = build_kimi_agent_md("C:/work/proj", "C:/work/out", "");
        assert!(md.starts_with("---\n"));
        assert!(md.contains("name: conduit"));
        assert!(md.contains("You are running inside Relay"));
    }

    #[test]
    fn project_less_bundle_tolerates_empty_project_path() {
        // Sessions with no selected project still get a bundle (connectors +
        // conduit-tools); instructions and settings must not emit empty paths.
        let md = build_instructions_md("", "C:/work/out", "");
        assert!(md.contains("No project folder is selected"));
        assert!(!md.contains("The project is at ``"));
        let v = build_claude_settings_json("", "C:/work/out", None, None);
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
        // None approval = headless historical default → full-auto block present.
        let v = build_opencode_tools_config("C:/app/exe", "p1", 7681, "tok-abc", &[], None);
        assert!(v["mcp"]["conduit-browser"]["type"] == "local");
        assert!(v["mcp"]["conduit-tools"]["type"] == "local");
        assert_eq!(v["mcp"]["conduit-browser"]["environment"]["CONDUIT_MCP_AUTH_TOKEN"], "tok-abc");
        // Values must be OpenCode rule strings — arrays fail config
        // validation and the CLI exits before running the turn.
        assert_eq!(v["permission"]["edit"], "allow");
        assert_eq!(v["permission"]["bash"], "allow");
        assert_eq!(v["permission"]["webfetch"], "allow");
        // Without this, reads of attachment files outside the session cwd
        // hang forever on an unanswerable external_directory permission ask.
        assert_eq!(v["permission"]["external_directory"], "allow");
    }

    #[test]
    fn opencode_config_merges_connectors_as_remote() {
        let connectors = vec![HarnessMcpServer {
            name: "github".into(),
            url: "https://api.githubcopilot.com/mcp/".into(),
            bearer_token: Some("gho_x".into()),
        }];
        let v = build_opencode_tools_config("C:/app/exe", "p1", 7681, "tok", &connectors, None);
        assert_eq!(v["mcp"]["github"]["type"], "remote");
        assert_eq!(v["mcp"]["github"]["url"], "https://api.githubcopilot.com/mcp/");
        assert_eq!(v["mcp"]["github"]["headers"]["Authorization"], "Bearer gho_x");
        // Conduit owns token refresh — OpenCode must not start its own OAuth
        // flow when the baked-in token expires.
        assert_eq!(v["mcp"]["github"]["oauth"], false);
        assert!(v["mcp"]["conduit-tools"]["type"] == "local");
    }

    #[test]
    fn opencode_config_interactive_omits_permission_block() {
        // Interactive PTY panes pass on_request: the allow-all block must be
        // omitted so the TUI's own prompts decide; auto_edit likewise (it
        // maps to per-edit prompting, not silent allow).
        for approval in ["on_request", "auto_edit"] {
            let v = build_opencode_tools_config("C:/app/exe", "p1", 7681, "tok-abc", &[], Some(approval));
            assert!(v["permission"].is_null(), "{approval} must not auto-approve");
            // MCP servers are unaffected by the approval policy.
            assert!(v["mcp"]["conduit-tools"]["type"] == "local");
        }
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
        let b = write_bundle(&dir, "p1", Some("C:/work/proj"), Some("C:/work/out"), None, None, 7681, &[], "");
        let b = b.expect("base dir should create");
        assert!(b.claude_instructions.exists(), "claude instructions written");
        assert!(b.claude_settings.exists(), "claude settings written");
        assert!(b.kimi_agent.exists(), "kimi agent written");
        let md = std::fs::read_to_string(&b.claude_instructions).unwrap();
        assert!(md.contains("You are running inside Relay"));
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
