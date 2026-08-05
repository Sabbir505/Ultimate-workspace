# Harness Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude Code / Kimi / OpenCode harness sessions Conduit's system prompt, skill catalog, and document/diagram generation tools, with conduit-safe permissions auto-approved and dangerous ops still gated by the approval card.

**Architecture:** A new `harness_bundle.rs` writes a Conduit-owned per-project config bundle (instructions, settings, MCP config) into the app data dir; spawn sites point the CLIs at it via native flags. A `conduit-tools` MCP server (same stdio→WS relay binary, extended with 5 new tools) forwards tool calls to the app's existing `chat::tools::execute_tool` over the existing loopback WebSocket, so the harness runs the exact same document/diagram pipeline as the built-in chat. Generated files land in the same artifacts dir, so the existing `DirWatch` post-turn diff surfaces them as artifact chips.

**Tech Stack:** Rust (Tauri), serde_json, tokio-tungstenite (existing bridge), reqwest (existing client), Claude Code / Kimi / OpenCode CLIs (installed on this machine).

## Global Constraints

- NEVER write into the project folder the harness runs in — all bundle files live under `<app-data>/harness/<safe-project-id>/`.
- Bundle/registration failure is never fatal: degrade to spawning without the bundle flags (exactly like the existing `resolve_mcp_config` behavior).
- Claude Code spawn runs headless (`-p --input-format stream-json`); headless mode auto-denies MCP tools NOT listed in `--allowedTools` (except bypassPermissions) — the `conduit-tools` server MUST be listed.
- Kimi `-p` mode refuses `--yolo`/`--auto` ("Cannot combine --prompt with --yolo") — do NOT add those flags to kimi's per-turn spawn; kimi's permission behavior is its own headless policy.
- Kimi `--agent-file` cannot combine with `--session`/`--continue` — only pass it when NOT resuming.
- Provider-specific chat prompt parts (`core_prompt_for` / strict addenda) are excluded from harness instructions — only `core_prompt_base` + skill catalog + environment preamble cross over.
- Reuse existing implementations: MCP tools dispatch to `chat::tools::execute_tool` (never reimplement generate logic); artifact surfacing relies on the existing `DirWatch` diff.
- Permission modes stay spawn-time only: no mid-session permission changes in this plan.
- Test commands run from `src-tauri/` (`cargo test`), except where noted. Frontend is untouched by this plan.

---

### Task 1: Bundle builders (pure) + prompt plumbing

**Files:**
- Modify: `src-tauri/src/chat/prompts.rs` (make `core_prompt_base` and `available_skills_segment` `pub(crate)`)
- Create: `src-tauri/src/harness_bundle.rs`
- Modify: `src-tauri/src/lib.rs` (register module)
- Test: `src-tauri/src/harness_bundle.rs` `#[cfg(test)]` module

**Interfaces:**
- Consumes: `prompts::core_prompt_base() -> String`, `prompts::available_skills_segment() -> Option<String>` (both newly `pub(crate)`), `installed_skills::list_all_skills() -> Vec<AvailableSkill>` (existing)
- Produces:
  - `pub fn build_instructions_md(project_path: &str, artifacts_dir: &str) -> String`
  - `pub fn build_claude_settings_json(project_path: &str, artifacts_dir: &str) -> Value`
  - `pub fn build_kimi_agent_md(project_path: &str, artifacts_dir: &str) -> String`
  - `pub fn build_tools_mcp_json(mcp_binary_path: &str, project_id: &str, ws_port: u16) -> Value`
  - `pub fn build_opencode_tools_config(mcp_binary_path: &str, project_id: &str, ws_port: u16, instructions_path: &str) -> Value`

- [ ] **Step 1: Write the failing tests** (in `harness_bundle.rs`)

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test harness_bundle --lib`
Expected: FAIL — `harness_bundle.rs` doesn't exist / module not found.

- [ ] **Step 3: Make prompts fns `pub(crate)`**

In `src-tauri/src/chat/prompts.rs`:
- `fn core_prompt_base() -> String` → `pub(crate) fn core_prompt_base() -> String`
- `fn available_skills_segment() -> Option<String>` → `pub(crate) fn available_skills_segment() -> Option<String>`

- [ ] **Step 4: Create `harness_bundle.rs`**

```rust
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
```

- [ ] **Step 5: Register the module**

In `src-tauri/src/lib.rs`, add `mod harness_bundle;` next to the other `mod` declarations.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test harness_bundle --lib`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/harness_bundle.rs src-tauri/src/lib.rs src-tauri/src/chat/prompts.rs
git commit -m "feat(harness): pure builders for per-project harness bundle (instructions, settings, mcp)"
```

---

### Task 2: Extend the MCP relay binary with conduit-tools

**Files:**
- Modify: `src-tauri/src/bin/conduit_browser_mcp.rs`
- Test: `#[cfg(test)]` module in the same file

**Interfaces:**
- Consumes: Task 1's tool list (names/descriptions from `chat/tools/mod.rs` constants: `GENERATE_DOCUMENT`, `GENERATE_DIAGRAM`, `GENERATE_FILE`, `GET_SKILL`)
- Produces: `fn tool_schemas() -> Vec<Value>` (extended), `fn tool_op(tool: &str) -> Result<String, &'static str>` (maps tool name → WS op: browser tools keep their bare name, conduit tools become `conduit_tools:<name>`)

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schemas_include_conduit_tools() {
        let names: Vec<&str> = tool_schemas()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        for tool in ["navigate", "read_page", "generate_document", "generate_diagram",
                     "generate_file", "get_skill", "list_skills"] {
            assert!(names.contains(&tool), "missing tool schema: {tool}");
        }
    }

    #[test]
    fn conduit_tool_routing_uses_tools_namespace() {
        assert_eq!(tool_op("generate_document").unwrap(), "conduit_tools:generate_document");
        assert_eq!(tool_op("navigate").unwrap(), "navigate"); // browser tools unchanged
        assert!(tool_op("bogus").is_err()); // unknown tools error, not misroute
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --bin conduit-browser-mcp`
Expected: FAIL — `tool_op` not defined; schemas missing tools.

- [ ] **Step 3: Add the tool schemas**

Append to `tool_schemas()` in `src-tauri/src/bin/conduit_browser_mcp.rs`:

```rust
        json!({
            "name": "generate_document",
            "description": "Create a REAL, professionally formatted docx/pptx/xlsx/pdf file in the artifacts dir. Use this instead of hand-building office files with python. Args: format ('docx'|'pptx'|'xlsx'|'pdf'), filename, title, content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["docx", "pptx", "xlsx", "pdf"] },
                    "filename": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["format", "filename", "title", "content"]
            }
        }),
        json!({
            "name": "generate_diagram",
            "description": "Create a diagram (SVG/PNG) in the artifacts dir from a structured spec (mindmap/flow/sequence/architecture).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["mindmap", "flow", "sequence", "architecture"] },
                    "filename": { "type": "string" },
                    "title": { "type": "string" },
                    "items": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["kind", "filename", "title", "items"]
            }
        }),
        json!({
            "name": "generate_file",
            "description": "Write a plain text/code file into the artifacts dir. Args: format (extension without dot), filename, title, content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string" },
                    "filename": { "type": "string" },
                    "title": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["format", "filename", "title", "content"]
            }
        }),
        json!({
            "name": "get_skill",
            "description": "Load a skill's detailed instructions (e.g. 'docx', 'pdf', 'pptx', 'diagram') before producing that artifact.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string" }
                },
                "required": ["slug"]
            }
        }),
        json!({
            "name": "list_skills",
            "description": "List every available skill slug.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
```

- [ ] **Step 4: Add the router and wire `tools/call`**

Add above `handle_tool_call`:

```rust
/// Map an MCP tool name to the WS op the app dispatches. Browser tools keep
/// their bare op names; conduit-tools live under a `conduit_tools:<name>`
/// prefix so the app-side dispatcher can route them to
/// chat::tools::execute_tool (which receives the name back).
fn tool_op(tool: &str) -> Result<String, &'static str> {
    match tool {
        "navigate" | "read_page" | "click" | "type_text" | "scroll" | "wait_for" => Ok(tool.to_string()),
        "generate_document" | "generate_diagram" | "generate_file"
        | "get_skill" | "list_skills" => Ok(format!("conduit_tools:{tool}")),
        _ => Err("unknown tool"),
    }
}
```

In `handle_tool_call`, replace the `let op = match tool {...}` block (currently lines ~197-208, ending with `other => return Err(...)`) with:

```rust
    let op = tool_op(tool).map_err(|_| ("unknown_op", format!("unknown tool: {tool}")))?;
```

The WS frame construction below it is unchanged — it already sends `"op": op`, and `op` is now a `String` (the existing `json!` macro handles that). The app-side dispatcher (Task 3) routes any `conduit_tools:` op to the tools bridge.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --bin conduit-browser-mcp`
Expected: PASS (2 new tests — the binary had no prior test module).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/bin/conduit_browser_mcp.rs
git commit -m "feat(mcp): register conduit-tools (document/diagram/skill) tools in the relay binary"
```

---

### Task 3: App-side WS dispatch for `conduit_tools` ops

**Files:**
- Modify: `src-tauri/src/browser_mcp.rs` (dispatch arm)
- Create: `src-tauri/src/mcp_tools_bridge.rs`
- Modify: `src-tauri/src/lib.rs` (register module)
- Test: `src-tauri/src/mcp_tools_bridge.rs` `#[cfg(test)]` module

**Interfaces:**
- Consumes: `chat::tools::execute_tool(client, artifacts_dir, caps, name, args)` (existing, `pub`), `chat::dispatch::artifacts_dir(app: &AppHandle) -> PathBuf` (existing, `pub(crate)`), `chat::tools::ToolCaps::default()` (existing)
- Produces: `pub async fn execute_conduit_tool(app: &AppHandle, tool_name: &str, args: &Value) -> Result<Value, McpError>` (McpError imported from `browser_mcp`; returns `{ "text": ..., "artifact": {...} | null }`)

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_extraction() {
        assert_eq!(tool_from_op("conduit_tools:generate_document"), Some("generate_document"));
        assert_eq!(tool_from_op("navigate"), None);
        assert_eq!(tool_from_op("conduit_tools:"), None);
    }

    #[test]
    fn outcome_text_fallbacks() {
        // ToolOutcome::text → { text, artifact: null }
        let o = crate::chat::tools::ToolOutcome::text("hello");
        assert_eq!(outcome_text(&o), "hello");
        assert!(outcome_artifact_json(&o).is_null());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test mcp_tools_bridge --lib`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `mcp_tools_bridge.rs`**

```rust
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

/// Strip the `conduit_tools:` prefix from a WS op; None for non-tool ops.
pub fn tool_from_op(op: &str) -> Option<String> {
    let rest = op.strip_prefix("conduit_tools:")?;
    if rest.is_empty() { None } else { Some(rest.to_string()) }
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
```

- [ ] **Step 4: Wire the dispatch arm in `browser_mcp.rs`**

In `dispatch(...)`, add before the `other =>` arm:

```rust
        op if crate::mcp_tools_bridge::tool_from_op(op).is_some() => {
            let tool = crate::mcp_tools_bridge::tool_from_op(op).unwrap();
            let args = req.args.clone();
            match crate::mcp_tools_bridge::execute_conduit_tool(app, &tool, &args).await {
                Ok(v) => Ok(v),
                Err(e) => Err(e),
            }
        }
```

(`McpError` is already defined in this file; the bridge reuses it.)

- [ ] **Step 5: Register the module in `lib.rs`**

Add `mod mcp_tools_bridge;` (must come before or after `browser_mcp` — Rust doesn't care; place next to `mod browser_mcp;`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test mcp_tools_bridge --lib`
Expected: PASS. Then `cargo check --lib` to confirm the dispatch arm compiles.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/mcp_tools_bridge.rs src-tauri/src/browser_mcp.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): app-side dispatch for conduit-tools ops via chat::tools::execute_tool"
```

---

### Task 4: Bundle writer + Claude Code spawn integration

**Files:**
- Modify: `src-tauri/src/harness_bundle.rs` (add `write_bundle` + `claude_bundle_args`)
- Modify: `src-tauri/src/agent_sessions.rs` (spawn_claude; replace `resolve_mcp_config` usage)
- Test: in `harness_bundle.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 1 builders; `browser_mcp_register::mcp_binary_path()` (existing); Task 3's WS port constant (`browser::BROWSER_MCP_PORT`, existing)
- Produces:
  - `pub struct HarnessBundlePaths { pub claude_instructions: PathBuf, pub claude_settings: PathBuf, pub claude_mcp: PathBuf, pub kimi_agent: PathBuf, pub kimi_mcp: PathBuf, pub kimi_skills_dir: PathBuf, pub opencode_config: PathBuf }`
  - `pub fn write_bundle(data_dir: &Path, project_id: &str, project_path: Option<&str>, artifacts_dir: Option<&str>, ws_port: u16) -> Option<HarnessBundlePaths>`
  - `pub fn claude_bundle_args(bundle: &HarnessBundlePaths, artifacts_dir: &str) -> Vec<String>`

- [ ] **Step 1: Write the failing tests**

```rust
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
        let paths = HarnessBundlePaths {
            claude_instructions: PathBuf::from("C:/b/i.md"),
            claude_settings: PathBuf::from("C:/b/s.json"),
            claude_mcp: PathBuf::from("C:/b/m.json"),
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
        assert_eq!(s[idx("--mcp-config") + 1], "C:/b/m.json");
        assert_eq!(s[idx("--add-dir") + 1], "C:/work/out");
        // Both MCP servers listed in one variadic --allowedTools.
        let allow_idx = idx("--allowedTools");
        assert_eq!(s[allow_idx + 1], "mcp__conduit-browser");
        assert_eq!(s[allow_idx + 2], "mcp__conduit-tools");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test harness_bundle --lib`
Expected: FAIL — `write_bundle` / `claude_bundle_args` / `HarnessBundlePaths` not defined.

- [ ] **Step 3: Implement the writer + arg helper in `harness_bundle.rs`**

```rust
use std::path::{Path, PathBuf};

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
```

- [ ] **Step 4: Wire into `spawn_claude` in `agent_sessions.rs`**

Replace the block at `agent_sessions.rs:610-620` (the `resolve_mcp_config` → `--mcp-config`/`--allowedTools` insertion) with:

```rust
    // Conduit-owned bundle: instructions, permissions, and both MCP servers
    // (browser + tools). Registration failure degrades to no extra flags —
    // the turn still runs, just without conduit's prompt/tools.
    if let Some(bundle) = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd)) {
        args.extend(crate::harness_bundle::claude_bundle_args(&bundle, &artifacts_dir_for_bundle(app, cwd)));
    }
```

Where `artifacts_dir_for_bundle` is a small helper (spawn dir resolution already exists as `spawn_dir`; reuse it):

```rust
/// The artifacts dir the bundle should advertise: the spawn dir when set
/// (it IS the CLI's workspace), else the configured artifacts dir, else the
/// Documents/Conduit default — mirroring `spawn_dir`.
fn artifacts_dir_for_bundle(app: &AppHandle, cwd: Option<&str>) -> String {
    if let Some(c) = cwd { return c.to_string(); }
    crate::chat::dispatch::artifacts_dir(app).to_string_lossy().into_owned()
}
```

And replace `resolve_mcp_config`'s body with a `resolve_harness_bundle`:

```rust
/// Resolve (writing if needed) the per-project harness bundle. Returns None
/// when no project is selected or the write fails — bundle failure must
/// never fail the turn (same contract as the old resolve_mcp_config).
fn resolve_harness_bundle(
    app: &AppHandle,
    project_id: Option<&str>,
    cwd: Option<&str>,
    artifacts_dir: String,
) -> Option<crate::harness_bundle::HarnessBundlePaths> {
    let data_dir = app.path().app_data_dir().ok()?;
    crate::harness_bundle::write_bundle(
        &data_dir, project_id?, cwd, Some(artifacts_dir.as_str()), crate::browser::BROWSER_MCP_PORT)
}
```

Keep the old `resolve_mcp_config`/`resolve_opencode_config` functions (pty_cmds.rs still uses them for Dev-tab PTY sessions — that path is intentionally unchanged).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test harness_bundle --lib`
Expected: PASS. Then `cargo check --lib` for the spawn integration.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/harness_bundle.rs src-tauri/src/agent_sessions.rs
git commit -m "feat(harness): write per-project bundle and wire claude spawn to instructions/settings/mcp/add-dir"
```

---

### Task 5: Kimi + OpenCode spawn integration

**Files:**
- Modify: `src-tauri/src/harness_bundle.rs` (add `kimi_bundle_args`)
- Modify: `src-tauri/src/agent_sessions.rs` (spawn_per_turn)
- Test: in `harness_bundle.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 4's `HarnessBundlePaths`; `build_opencode_tools_config` (Task 1)
- Produces: `pub fn kimi_bundle_args(bundle: &HarnessBundlePaths, artifacts_dir: &str, resume: bool) -> Vec<String>`

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn kimi_bundle_args_respects_resume() {
        let paths = HarnessBundlePaths {
            claude_instructions: PathBuf::from("C:/b/i.md"),
            claude_settings: PathBuf::from("C:/b/s.json"),
            claude_mcp: PathBuf::from("C:/b/m.json"),
            kimi_agent: PathBuf::from("C:/b/a.md"),
            kimi_mcp: PathBuf::from("C:/b/km.json"),
            kimi_skills_dir: PathBuf::from("C:/b/skills"),
            opencode_config: PathBuf::from("C:/b/oc.json"),
        };
        // Fresh session: --agent-file present, --mcp-config-file present.
        let args = kimi_bundle_args(&paths, "C:/work/out", false);
        let s: Vec<&str> = args.iter().map(|x| x.as_str()).collect();
        assert!(s.windows(2).any(|w| w == ["--agent-file", "C:/b/a.md"]));
        assert!(s.windows(2).any(|w| w == ["--mcp-config-file", "C:/b/km.json"]));
        assert!(s.windows(2).any(|w| w == ["--add-dir", "C:/work/out"]));
        // Resume: --agent-file must NOT be passed (kimi forbids it with --session).
        let args = kimi_bundle_args(&paths, "C:/work/out", true);
        let s: Vec<&str> = args.iter().map(|x| x.as_str()).collect();
        assert!(!s.iter().any(|a| *a == "--agent-file"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test harness_bundle --lib kimi`
Expected: FAIL — `kimi_bundle_args` not defined.

- [ ] **Step 3: Implement `kimi_bundle_args`**

```rust
/// Extra args for a kimi per-turn spawn. `--agent-file` is only valid on a
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
```

- [ ] **Step 4: Wire into `spawn_per_turn`**

In `agent_sessions.rs` `spawn_per_turn` (around line 964), replace the `mcp_cfg` match (both kinds) with:

```rust
    // Conduit-owned bundle: instructions, permissions, and MCP registration.
    // Failure degrades to the legacy browser-only configs below (or none).
    let bundle = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd));
    // Legacy fallback: browser-only MCP when the bundle (or its mcp part)
    // didn't write — keeps pty-style browser tools working in degraded mode.
    let opencode_legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };
    let mcp_cfg = match kind {
        PerTurn::Kimi => bundle.as_ref().map(|b| b.kimi_mcp.clone()).filter(|p| p.exists()),
        PerTurn::OpenCode => None,
    };
```

Then in the `PerTurn::Kimi` arm, REPLACE the existing `if let Some(cfg) = &mcp_cfg { ... }` block (lines ~989-992) with a single `kimi_bundle_args` call — it covers mcp-config-file, agent-file, and add-dir:

```rust
            if let Some(b) = &bundle {
                args.extend(crate::harness_bundle::kimi_bundle_args(
                    b, &artifacts_dir_for_bundle(app, cwd), resume.is_some()));
            }
```

(`resume` is the `Option<String>` captured at the top of the function. `kimi_bundle_args` skips `--agent-file` when resuming — kimi forbids it with `--session`. When `bundle` is None nothing is added, matching today's degraded behavior.)

For `PerTurn::OpenCode`: the OPENCODE_CONFIG env block (line 1035-1038) stays as-is except it now prefers the bundle's opencode.json over the legacy file:

```rust
    if matches!(kind, PerTurn::OpenCode) {
        if let Some(cfg) = bundle.as_ref().map(|b| b.opencode_config.clone())
            .filter(|p| p.exists())
            .or(opencode_legacy_cfg.clone()) {
            cmd.env("OPENCODE_CONFIG", cfg);
        }
    }
```

(If the bundle wrote opencode.json, it already contains both MCP servers + permissions + instructions; the legacy path only applies when the bundle failed.)

- [ ] **Step 5: OpenCode instructions-key verification**

Run: `opencode --help 2>&1 | grep -iE "instructions|AGENTS"` and inspect whether the installed opencode documents an `instructions` config key (or uses AGENTS.md auto-discovery). If the installed version doesn't support `"instructions"` in config, remove the `"instructions"` line from `build_opencode_tools_config` (Task 1) and instead document in the code comment that OpenCode's instructions come from AGENTS.md conventions the user controls — tools + permissions still work.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test harness_bundle --lib && cargo check --lib`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/harness_bundle.rs src-tauri/src/agent_sessions.rs
git commit -m "feat(harness): kimi agent-file/mcp/add-dir args and opencode bundle config at spawn"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `cd src-tauri && cargo test`
Expected: all tests pass (existing + new).

- [ ] **Step 2: Launch the app**

Run: `npm run tauri dev` (from repo root). Wait for the window (PID `conduit` visible).

- [ ] **Step 3: Manual harness check — Claude Code**

In the app: start a Dev-tab agent session (Claude Code) against a project. Open the agent's spawn log or check `claude --help` behavior by asking the harness to "create a Word document about the project". Expected:
- The harness calls `generate_document` (conduit-tools MCP) rather than hand-building
- The generated .docx lands in the artifacts dir
- After the turn, a file chip / artifact appears in the session (DirWatch diff)
- No permission prompt appears for the conduit-tools call; a bash command still surfaces the approval card

- [ ] **Step 4: Manual harness check — permission gating**

Ask the harness to `run a shell command that deletes a file in another directory`. Expected: the approval card appears (danger gated). Deny it — the harness reports denial and does not run it.

- [ ] **Step 5: Manual harness check — Kimi/OpenCode**

Repeat Step 3 with a Kimi session (fresh, no resume) and an OpenCode session. Expected: generate_document available (mcp tools), artifacts chip appears. If a CLI's agent-file/instructions flag is rejected at spawn, the app must still run the turn without it (kimi agent-file only on fresh sessions; opencode instructions key optional per Task 5 Step 5).

- [ ] **Step 6: Report results**

Summarize what passed/failed per CLI in the conversation. Anything failing becomes a follow-up task.

---

## Self-Review Notes

- **Spec coverage:** system prompt (Task 1 builders + Task 4 claude flags + Task 5 kimi agent-file/opencode instructions) ✓; skill catalog (Task 1 `available_skills_segment` reuse + Task 2 get_skill/list_skills) ✓; tools bridge (Tasks 2-3) ✓; permissions (Task 1 settings builders + Task 4/5 flag wiring) ✓; artifacts (reuses existing DirWatch — no new code, verified in Task 6 Step 3) ✓; error handling (degrade-to-no-flags in Tasks 4-5) ✓; testing (Tasks 1-6) ✓.
- **Kimi skills-dir** (from the design's bundle layout): intentionally deferred — `get_skill` via MCP covers the same need uniformly across CLIs; the kimi/skills copy adds frontmatter-format risk with no parity benefit since the tools server serves skill bodies. Noted in the commit message of Task 1 if removed.
- **Kimi `--yolo`/`--auto`:** spec's permission table said `--yolo` for manual/auto_edit, but the codebase comment (agent_sessions.rs:976-979) documents that kimi refuses those with `-p` — the plan omits them and relies on kimi's headless policy. This is a documented deviation in the Global Constraints.
