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
            "attach_how": "attach_connector(id) loads a listed connector's tools into this turn. Listed = connected, NOT loaded: if a request touches one, attach FIRST — never answer that you can't access a connector listed here.",
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
                || !caps.attachable_mcp.is_empty()
                || !caps.unlockable_families.is_empty(),
            // Match the schema: the mutating half is stripped under a
            // read-only posture, so a plain `true` would promise writes the
            // model cannot call.
            "filesystem_tools": if caps.allows_mutating {
                "read + write (list/read/search/search_content + write/edit/delete/move/copy)"
            } else {
                "read-only (list/read/search/search_content; the write tools are stripped in this read-only posture)"
            },
            // Interaction tools (click/type/scroll/screenshot/observe/extract)
            // need a live page or prior browser use this session; browser_read
            // and open_url are always available.
            "browser_pane_tools": caps.browser,
            "memory": caps.memory,
            // Match the schema: the write trio is stripped under a read-only
            // posture, so the report must not claim full CRUD there.
            "vault": if caps.allows_mutating {
                "bound folder of markdown notes; vault_list/read/search + vault_write/move/delete (full CRUD)"
            } else {
                "bound folder of markdown notes; vault_list/read/search only (write tools are stripped in this read-only posture)"
            },
            // Match the schema: list/get are always on, but the CRUD/run half
            // is family-locked (unlocked via attach_connector("automations")
            // or the send-time keyword fast-path) AND stripped under a
            // read-only posture, so the report must not claim full CRUD
            // unless both gates are open.
            "automations": if caps.automations_write && caps.allows_mutating {
                "list_automations/get_automation + create/update/delete/run_automation_now (full CRUD)"
            } else if caps.allows_mutating {
                "list_automations/get_automation only — the write tools are family-locked: attach_connector(\"automations\") unlocks them for this turn"
            } else {
                "list_automations/get_automation only (the write tools are stripped in this read-only posture)"
            },
            // Match the schema: the read list is always on; the CRUD trio is
            // stripped under a read-only posture and absent from surfaces
            // that build ToolCaps::default() (subagent_write=false). A run with
            // a PINNED allowlist (a subagent) may not even carry the read
            // list — the ceiling never includes it — so the report must not
            // claim a tool the run cannot call.
            "subagents": if caps.subagent_write && caps.allows_mutating {
                "list_subagents + create/update/delete_subagent (full CRUD — you can author \
                 the user's reusable subagents; authoring is approval-carded)"
            } else if caps
                .allow
                .as_ref()
                .is_some_and(|set| !set.contains(super::LIST_SUBAGENTS))
            {
                "none (this run's pinned tool set does not include the subagent tools)"
            } else if caps.allows_mutating {
                "list_subagents only"
            } else {
                "list_subagents only (the write tools are stripped in this read-only posture)"
            },
            // Family-locked built-ins (see UNLOCKABLE_FAMILIES): the schema
            // hides them until attach_connector("<id>") unlocks, which the
            // manifest lists every turn. The report must state the lock the
            // same way it states an attachable connector — available, not
            // loaded.
            "session_mesh": if caps.session_mesh {
                "list_sessions/read_session/search_sessions/message_session/spawn_session — unlocked this turn"
            } else {
                "locked — attach_connector(\"session-mesh\") unlocks list/read/search/message/spawn for this turn"
            },
            "totp_codes": if caps.totp {
                "totp_code — unlocked this turn"
            } else {
                "locked — attach_connector(\"totp\") unlocks totp_code for this turn"
            },
            // Unconditionally callable — there is NO availability gate: the
            // tool ships in every schema (specs.rs) and every call reaches the
            // engine (an unconfigured engine degrades to a "set it up in
            // Settings" error, not a missing tool). The report must claim it
            // exactly as unconditionally as the schema advertises it.
            "image_generation": "generate_image — local diffusion (no cloud); always available as a tool (a missing engine/model returns setup guidance instead of a failure)",
            // NOT the registry report above — this flag is the built-in Task
            // tool's own subagent system, which is unconditionally callable:
            // it ships in every schema and every call reaches the engine (an
            // unconfigured engine degrades to a "set it up in Settings"
            // error, not a missing tool). The report must claim it exactly as
            // unconditionally as the schema advertises it.
            "task_subagents": true,
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
    let (connected_ids, account_displays, fallback_tool_names, subagents) = {
        let conn = db.0.lock();
        let rows = crate::db::list_connector_credential_rows(&conn).unwrap_or_default();
        let credentialed: Vec<String> =
            rows.iter().map(|r| r.connector_id.clone()).collect();
        // The registry, as name + one-line description. This is the section the
        // automation schema's `agent:` docs have pointed at ("get_capabilities
        // lists them") since before this report had one — without it a harness
        // could run `spawn_session agent:<id>` only by guessing the name.
        // Reading through `list` also refreshes the shared name cache the spec
        // builders use, so the two views can never disagree.
        let subagents: Vec<Value> = crate::chat::subagents::list(&conn)
            .iter()
            .map(|a| {
                json!({
                    "name": a.name,
                    "description": a.description,
                    "builtin": a.builtin,
                })
            })
            .collect();
        (
            credentialed.clone(),
            rows.iter()
                .filter_map(|r| r.account_display.clone())
                .collect::<Vec<_>>(),
            crate::connectors::connected_fallback_tools(&credentialed)
                .into_iter()
                .map(|(_, name, _)| name.to_string())
                .collect::<Vec<_>>(),
            subagents,
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
        .map(|d| {
            json!({
                "id": d.id,
                "name": d.name,
                "enabled": d.enabled,
            })
        })
        .collect();

    let skills: Vec<String> = crate::installed_skills::list_all_skills()
        .iter()
        .map(|s| s.slug.clone())
        .collect();

    let browser_live = crate::browser_mcp::bound_port() != 0;

    let report = json!({
        "note": NOTE,
        "harness_context": "You are a CLI harness running inside Relay (the desktop app). \
    A CONNECTED connector below is authorized app-wide but is NOT automatically in \
    your toolset: only connectors attached to your chat session are registered into \
    your MCP config (refreshed each turn), and a mention of one in the task text \
    (\"@gmail\", \"my inbox\", …) attaches it automatically. Independent of attach \
    state, the fallback tools under connector_fallback_tools run app-side for \
    connected connectors — READS and WRITES alike (gmail_send_message sends \
    immediately; there is no confirmation prompt on this bridge) — call them \
    directly. Never claim access you don't have (your own tool list is the truth), \
    and never answer 'I can't access X' for a connected connector whose fallback \
    tools you DO have. Do not probe connectors with shell commands.",
        "connectors": {
            "connected": connected,
            "accounts": account_displays,
        },
        "connector_fallback_tools": fallback_tool_names,
        "mcp_gallery": {
            "installed": mcp_gallery,
        },
        "in_app_browser": {
            "available": browser_live,
            "how": "the relay-browser MCP server (tools prefixed mcp__relay-browser__)",
        },
        // Derived from the bridge allowlist — one source of truth, so a new
        // bridged tool reports itself without a manual edit here.
        "relay_tools": crate::mcp_tools_bridge::ALLOWED_RELAY_TOOLS.to_vec(),

        // The subagent registry — names you can pass to
        // `spawn_session(agent="agent:<name>")` (or an automation's `agent`).
        // `list_subagents` returns the full rows (prompt, allowlist, policies);
        // this is the cheap index of what exists.
        "subagents": subagents,
        // The authoring surface, and its one limit. Stated here as well as in
        // the bundle so a model that calls `get_capabilities` — or that hits
        // the read-only rule on a create — can explain the boundary rather than
        // concluding it has no write access at all.
        "subagent_authoring": "create_subagent / update_subagent / delete_subagent — \
            build a reusable agent when asked for one. Agents you create are badged \
            'made by agent' in Settings → Agents → Subagents, and are created \
            READ-ONLY: you can change what an agent does, but only the user can widen \
            what it is allowed to do.",

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

    /// Report/schema parity for the unconditional tools: generate_image ships
    /// in EVERY schema (openai + anthropic, all caps/postures) and every call
    /// dispatches (an unconfigured engine returns setup guidance, not a
    /// missing tool) — so the report must claim it, unconditionally, on the
    /// same surface. (It used to be absent entirely while the built-in CORE
    /// prompt said "never claim image generation is impossible".)
    #[test]
    fn report_claims_image_generation_like_the_schema_does() {
        let v: Value = serde_json::from_str(&capabilities_report(&ToolCaps::default())).unwrap();
        let img = v["built_in"]["image_generation"]
            .as_str()
            .expect("image_generation must be listed");
        assert!(img.contains("generate_image"));
        // And the schema side of the parity really is unconditional: both
        // wire formats advertise it with default caps. The name's envelope
        // path differs — OpenAI nests it under "function", Anthropic puts it
        // top-level — so probe both (a miss on either format means the
        // report overclaims on that wire).
        for specs in [
            crate::chat::tools::openai_tool_specs(
                &ToolCaps::default(),
                crate::chat::permission::SandboxPolicy::ReadOnly,
            ),
            crate::chat::tools::anthropic_tool_specs(
                &ToolCaps::default(),
                crate::chat::permission::SandboxPolicy::ReadOnly,
            ),
        ] {
            assert!(
                specs.iter().any(|s| {
                    s["name"] == crate::chat::tools::GENERATE_IMAGE
                        || s["function"]["name"] == crate::chat::tools::GENERATE_IMAGE
                }),
                "generate_image left the schema — the report now overclaims"
            );
        }
    }

    /// Report/schema parity for the posture-gated families: under a read-only
    /// posture the write half of fs/vault/automations is STRIPPED from the
    /// schema, so the report must not claim full CRUD there (a plain
    /// `automations: true` made the model call create_automation the schema
    /// no longer carried). The strings must name the write half only when it
    /// is actually callable.
    #[test]
    fn report_matches_posture_for_gated_families() {
        // "Full" = mutating posture AND the write families unlocked — the
        // gates the schema applies to each write half (subagent_write rides the
        // main loop unconditionally; the bridge/subagent defaults lack it).
        let full = ToolCaps {
            automations_write: true,
            subagent_write: true,
            ..ToolCaps::default()
        };
        let mut read_only = ToolCaps {
            automations_write: true,
            subagent_write: true,
            ..ToolCaps::default()
        };
        read_only.allows_mutating = false;

        let full: Value =
            serde_json::from_str(&capabilities_report(&full)).unwrap();
        let ro: Value =
            serde_json::from_str(&capabilities_report(&read_only)).unwrap();

        assert!(full["built_in"]["automations"].as_str().unwrap().contains("create"));
        assert!(!ro["built_in"]["automations"].as_str().unwrap().contains("create"));
        assert!(ro["built_in"]["automations"].as_str().unwrap().contains("list_automations"));

        assert!(full["built_in"]["filesystem_tools"].as_str().unwrap().contains("read + write"));
        assert!(!ro["built_in"]["filesystem_tools"].as_str().unwrap().contains("read + write"));
        assert!(ro["built_in"]["filesystem_tools"].as_str().unwrap().contains("read-only"));

        assert!(full["built_in"]["vault"].as_str().unwrap().contains("vault_write"));
        assert!(!ro["built_in"]["vault"].as_str().unwrap().contains("vault_write"));

        // Subagent: full CRUD only when both gates are open; the list always on.
        assert!(full["built_in"]["subagents"].as_str().unwrap().contains("create"));
        assert!(!ro["built_in"]["subagents"].as_str().unwrap().contains("create"));
        assert!(ro["built_in"]["subagents"].as_str().unwrap().contains("list_subagents"));
    }

    /// A run with a PINNED allowlist (a subagent) may not carry the subagent
    /// read tool at all — the ceiling never includes it, the schema filter
    /// strips it, execution refuses it — so the report must not claim it
    /// (the module contract: the report can never disagree with what the
    /// model can actually call).
    #[test]
    fn report_claims_no_subagent_tool_when_the_pinned_set_lacks_it() {
        let pinned = ToolCaps {
            allows_mutating: true,
            allow: Some(std::sync::Arc::new(
                ["read_file", "write_file"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            )),
            ..ToolCaps::default()
        };
        let v: Value = serde_json::from_str(&capabilities_report(&pinned)).unwrap();
        let line = v["built_in"]["subagents"].as_str().unwrap();
        assert!(
            !line.contains("list_subagents"),
            "a pinned set without the tool must not be told it exists: {line}"
        );
    }

    /// Report/schema parity for the family-locked built-ins: a LOCKED family
    /// must be absent from the schema yet named with its unlock in the
    /// report (never silently missing), and unlocking flips both sides.
    #[test]
    fn report_matches_family_locks_in_both_directions() {
        for format in ["openai", "anthropic"] {
            let specs = |caps: &ToolCaps| -> Vec<String> {
                let raw = if format == "openai" {
                    crate::chat::tools::openai_tool_specs(
                        caps,
                        crate::chat::permission::SandboxPolicy::WorkspaceWrite,
                    )
                } else {
                    crate::chat::tools::anthropic_tool_specs(
                        caps,
                        crate::chat::permission::SandboxPolicy::WorkspaceWrite,
                    )
                };
                raw.iter()
                    .map(|s| {
                        s["function"]["name"]
                            .as_str()
                            .or_else(|| s["name"].as_str())
                            .unwrap_or("?")
                            .to_string()
                    })
                    .collect()
            };
            let locked = ToolCaps::default();
            let mut unlocked = ToolCaps::default();
            unlocked.unlock_family(crate::chat::tools::FAMILY_SESSION_MESH);
            unlocked.unlock_family(crate::chat::tools::FAMILY_AUTOMATIONS);
            unlocked.unlock_family(crate::chat::tools::FAMILY_TOTP);

            let locked_names = specs(&locked);
            let unlocked_names = specs(&unlocked);
            // Locked: the family tools are NOT in the schema…
            assert!(!locked_names.iter().any(|n| n == crate::chat::tools::LIST_SESSIONS));
            assert!(!locked_names.iter().any(|n| n == crate::chat::tools::TOTP_CODE));
            assert!(!locked_names.iter().any(|n| n == crate::chat::tools::CREATE_AUTOMATION));
            // …but list_automations/get_automation stay (the read half)…
            assert!(locked_names.iter().any(|n| n == crate::chat::tools::LIST_AUTOMATIONS));
            // …and the attach meta-tool carries the family ids in its enum.
            let attach = locked_names.iter().any(|n| *n == crate::chat::tools::ATTACH_CONNECTOR);
            assert!(attach, "{format}: attach_connector must be advertised while families are locked");

            // Unlocked: everything is in the schema.
            for n in [
                crate::chat::tools::LIST_SESSIONS,
                crate::chat::tools::SPAWN_SESSION,
                crate::chat::tools::TOTP_CODE,
                crate::chat::tools::CREATE_AUTOMATION,
            ] {
                assert!(unlocked_names.iter().any(|x| x == n), "{format}: {n} missing after unlock");
            }

            // And the report agrees with the schema on both sides.
            let report_locked: Value =
                serde_json::from_str(&capabilities_report(&locked)).unwrap();
            let report_unlocked: Value =
                serde_json::from_str(&capabilities_report(&unlocked)).unwrap();
            assert!(report_locked["built_in"]["session_mesh"].as_str().unwrap().contains("locked"));
            assert!(report_unlocked["built_in"]["session_mesh"].as_str().unwrap().contains("unlocked"));
            assert!(report_locked["built_in"]["automations"].as_str().unwrap().contains("attach_connector"));
            assert!(!report_unlocked["built_in"]["automations"].as_str().unwrap().contains("attach_connector"));
            assert!(report_locked["built_in"]["totp_codes"].as_str().unwrap().contains("locked"));
            assert!(report_unlocked["built_in"]["totp_codes"].as_str().unwrap().contains("unlocked"));
        }
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
            hints: None,
            },
            crate::mcp_gallery::McpToolEntry {
                server_id: "memory".into(),
                server_name: "Memory".into(),
                wire_name: "mcp_memory_fetch".into(),
                raw_name: "fetch".into(),
                kind: crate::chat::permission::ConnectorToolKind::Read,
                description: None,
            hints: None,
            },
        ]);
        let v: Value = serde_json::from_str(&capabilities_report(&caps)).unwrap();
        let servers = v["mcp_servers"]["attached"].as_array().unwrap();
        assert_eq!(servers.len(), 1, "tools of one server must group together");
        assert_eq!(servers[0]["id"], "memory");
        assert_eq!(servers[0]["tools"].as_array().unwrap().len(), 2);
    }
}
