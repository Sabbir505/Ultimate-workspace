//! Wire-format spec builders: render the tool registry into the OpenAI
//! `tools` array ([`openai_tool_specs`]) and the Anthropic `tools` array
//! ([`anthropic_tool_specs`]). The same registry renders into both formats;
//! [`execute_tool`] in `mod.rs` dispatches by name. Read-only filesystem
//! tools are always present; mutating ones are stripped under `read_only`
//! (schema-level exclusion — the model cannot invoke them); `run_code` is
//! gated behind the `code_exec` capability.

use super::super::permission;
use super::*;

/// The tool name a rendered spec advertises, in either wire envelope:
/// OpenAI nests it at `/function/name`, Anthropic at the top-level `name`.
///
/// This is the one place that knows the quirk. Every name-level filter in
/// the codebase (the subagent allowlist, the `ToolCaps::allow` terminal
/// filter) reads a name through here, so a future envelope change is a
/// one-line fix instead of a scavenger hunt.
fn spec_tool_name(spec: &Value, anthropic: bool) -> Option<&str> {
    if anthropic {
        spec.get("name").and_then(Value::as_str)
    } else {
        spec.pointer("/function/name").and_then(Value::as_str)
    }
}

/// TERMINAL allowlist filter, applied at the very end of a builder — after
/// every flag gate, after the sandbox strip, after connector/MCP tool
/// expansion. `allow = None` returns the list untouched (the main-loop
/// default), so this cannot perturb any existing turn's schema.
fn apply_allow_filter(specs: &mut Vec<Value>, caps: &ToolCaps, anthropic: bool) {
    let Some(allow) = caps.allow.as_ref() else {
        return;
    };
    specs.retain(|s| {
        spec_tool_name(s, anthropic)
            // A spec with no readable name is never advertised under an
            // allowlist: an unnamed tool cannot be shown to be in the set.
            .is_some_and(|n| allow.contains(n))
    });
}

pub fn openai_tool_specs(caps: &ToolCaps, sandbox: permission::SandboxPolicy) -> Vec<Value> {
    let mut specs: Vec<Value> = vec![];
    if caps.web_search {
        specs.push(openai_fn(
            WEB_SEARCH,
            WEB_SEARCH_DESC,
            web_search_parameters(),
        ));
    }
    // Attach-on-demand meta-tools: advertised only while unattached sources
    // remain, with their ids as the enum (see ToolCaps). Connector/MCP tool
    // schemas join the request only AFTER an attach.
    specs_attach_tools_openai(caps, &mut specs);
    specs.extend(vec![
        openai_fn(
            GENERATE_FILE,
            GENERATE_FILE_DESC,
            generate_file_parameters(),
        ),
        openai_fn(
            GENERATE_DOCUMENT,
            GENERATE_DOCUMENT_DESC,
            generate_document_parameters(),
        ),
        openai_fn(
            PLAN_DOCUMENT,
            PLAN_DOCUMENT_DESC,
            plan_document_parameters(),
        ),
        openai_fn(
            REVISE_DOCUMENT,
            REVISE_DOCUMENT_DESC,
            revise_document_parameters(),
        ),
        openai_fn(
            GENERATE_DIAGRAM,
            GENERATE_DIAGRAM_DESC,
            generate_diagram_parameters(),
        ),
        openai_fn(
            GENERATE_IMAGE,
            GENERATE_IMAGE_DESC,
            generate_image_parameters(),
        ),
        openai_fn(FETCH_URL, FETCH_URL_DESC, fetch_url_parameters()),
        openai_fn(OPEN_URL, OPEN_URL_DESC, fetch_url_parameters()),
        openai_fn(GET_SKILL, GET_SKILL_DESC, get_skill_parameters()),
        openai_fn(LIST_SKILLS, LIST_SKILLS_DESC, no_parameters()),
        // Live artifact listing (read-only, no gating) — answers "where does
        // the report live" from the DB, newest first, with absolute paths.
        openai_fn(
            LIST_ARTIFACTS,
            LIST_ARTIFACTS_DESC,
            list_artifacts_parameters(),
        ),
        // In-process availability introspection — always on (read-only, no
        // gating). Replaces shell probes for connector/MCP availability.
        openai_fn(GET_CAPABILITIES, GET_CAPABILITIES_DESC, no_parameters()),
        // browser_read is always advertised (with open_url it is the entry
        // point to whatever page is open); the interaction tools need a live
        // page and are gated on caps.browser below.
        openai_fn(BROWSER_READ, BROWSER_READ_DESC, browser_read_parameters()),
        // Research source ledger — rides caps.research: the research
        // scaffolding is the only prompt text that references these tools,
        // so an ordinary turn doesn't pay ~0.9k tokens for an unreachable
        // family (research turns set the flag in chat/mod.rs send()).
    ]);
    if caps.research {
        specs.extend(vec![
            openai_fn(
                ADD_SOURCE_NOTE,
                ADD_SOURCE_NOTE_DESC,
                add_source_note_parameters(),
            ),
            openai_fn(
                GET_SOURCE_LEDGER,
                GET_SOURCE_LEDGER_DESC,
                get_source_ledger_parameters(),
            ),
            openai_fn(
                RESET_SOURCE_LEDGER,
                RESET_SOURCE_LEDGER_DESC,
                no_parameters(),
            ),
            openai_fn(
                CHECK_SUFFICIENCY,
                CHECK_SUFFICIENCY_DESC,
                check_sufficiency_parameters(),
            ),
        ]);
    }
    specs.extend(vec![
        // Plan tracking — always on (session-state tools, not gated by permission
        // mode; the plan gate, not the schema, decides what's blocked per mode).
        openai_fn(TODO_WRITE, TODO_WRITE_DESC, todo_items_parameters(true)),
        openai_fn(
            ENTER_PLAN_MODE,
            ENTER_PLAN_MODE_DESC,
            enter_plan_mode_parameters(),
        ),
        openai_fn(PRESENT_PLAN, PRESENT_PLAN_DESC, plan_text_parameters()),
        // Read-only filesystem tools — present in every mode.
        openai_fn(
            LIST_DIRECTORY,
            LIST_DIRECTORY_DESC,
            list_directory_parameters(),
        ),
        openai_fn(READ_FILE, READ_FILE_DESC, read_file_parameters()),
        openai_fn(SEARCH_FILES, SEARCH_FILES_DESC, search_files_parameters()),
        openai_fn(
            SEARCH_CONTENT,
            SEARCH_CONTENT_DESC,
            search_content_parameters(),
        ),
        // Vault (the user's markdown knowledge base) — the read trio is
        // read-only and always on; the write trio follows the mutating-tool
        // gate below (see tools/mod.rs family block).
        openai_fn(VAULT_LIST, VAULT_LIST_DESC, vault_list_parameters()),
        openai_fn(VAULT_READ, VAULT_READ_DESC, vault_read_parameters()),
        openai_fn(VAULT_SEARCH, VAULT_SEARCH_DESC, vault_search_parameters()),
        // Automations — list/get are read-only and always on; the CRUD/run
        // tools below follow the mutating-tool gating (see tools/mod.rs
        // family block). Without them the model denies an app capability it
        // has.
        openai_fn(LIST_AUTOMATIONS, LIST_AUTOMATIONS_DESC, no_parameters()),
        openai_fn(
            GET_AUTOMATION,
            GET_AUTOMATION_DESC,
            automation_id_parameters(),
        ),
        // Subagent — the read-only list is always on (mirrors automations); the
        // CRUD trio rides the mutating gating + the subagent_write family flag
        // below. Lets the model author the subagent, not just run it.
        openai_fn(LIST_SUBAGENTS, LIST_SUBAGENTS_DESC, no_parameters()),
        // Session Mesh — sibling-session awareness + consultation. Locked
        // with the whole family: ~1.3k tokens of specs most turns never
        // touch; `attach_connector("session-mesh")` brings all five in for
        // the turn (see UNLOCKABLE_FAMILIES + dispatch run_attach_tool).
        // message/spawn additionally gate at dispatch (see dispatch.rs +
        // plan.rs is_mutating_tool).
    ]);
    if caps.session_mesh {
        specs.extend(vec![
            openai_fn(LIST_SESSIONS, LIST_SESSIONS_DESC, list_sessions_parameters()),
            openai_fn(READ_SESSION, READ_SESSION_DESC, read_session_parameters()),
            openai_fn(SEARCH_SESSIONS, SEARCH_SESSIONS_DESC, search_sessions_parameters()),
            openai_fn(MESSAGE_SESSION, MESSAGE_SESSION_DESC, message_session_parameters()),
            openai_fn(SPAWN_SESSION, SPAWN_SESSION_DESC, spawn_session_parameters()),
        ]);
    }
    // Browser interaction tools — advertised only when the built-in pane has
    // a page (ToolCaps.browser is sticky per session, so a turn that opened
    // a page mid-turn advertises these from the next round on — see the
    // caps refresh in streaming.rs). Saves ~2.9k chars on turns that never
    // touch the browser.
    if caps.browser {
        specs.extend(vec![
            openai_fn(BROWSER_CLICK, BROWSER_CLICK_DESC, browser_ref_parameters()),
            openai_fn(BROWSER_TYPE, BROWSER_TYPE_DESC, browser_type_parameters()),
            openai_fn(
                BROWSER_SCROLL,
                BROWSER_SCROLL_DESC,
                browser_scroll_parameters(),
            ),
            // Screenshot: no params — it shoots the pane's current page and
            // returns the artifact path.
            openai_fn(BROWSER_SCREENSHOT, BROWSER_SCREENSHOT_DESC, no_parameters()),
            openai_fn(BROWSER_OBSERVE, BROWSER_OBSERVE_DESC, no_parameters()),
            openai_fn(
                BROWSER_EXTRACT,
                BROWSER_EXTRACT_DESC,
                browser_extract_parameters(),
            ),
        ]);
    }
    // Persistent memory (MEMORY_DESIGN_ARCHITECTURE.md §12.1) — gated by the
    // Settings toggle the way search_docs is gated by corpus availability;
    // dispatch still returns a clear error as a backstop.
    if caps.memory {
        specs.extend(vec![
            openai_fn(MEMORY_SAVE, MEMORY_SAVE_DESC, memory_save_parameters()),
            openai_fn(
                MEMORY_RECALL,
                MEMORY_RECALL_DESC,
                memory_recall_parameters(),
            ),
            openai_fn(
                MEMORY_FORGET,
                MEMORY_FORGET_DESC,
                memory_forget_parameters(),
            ),
        ]);
    }
    // TOTP 2FA codes — read-only (the seed stays in the keychain / password
    // manager; only the code is returned), but locked with the family: the
    // tool rides almost no turns, so it joins the attach-on-demand built-ins
    // (`attach_connector("totp")`) instead of the standing schema.
    if caps.totp {
        specs.push(openai_fn(TOTP_CODE, TOTP_CODE_DESC, totp_code_parameters()));
    }
    // Local-docs search — exposed when at least one corpus is indexed
    // (computed per turn into ToolCaps.local_docs); hybrid search answers
    // keyword-only with the embedding sidecar down, so it doesn't gate here.
    if caps.local_docs {
        specs.push(openai_fn(
            SEARCH_DOCS,
            SEARCH_DOCS_DESC,
            search_docs_parameters(),
        ));
    }
    // Mutating filesystem tools — stripped from the schema under read_only.
    if sandbox.allows_mutating_tools() {
        specs.push(openai_fn(
            VAULT_WRITE,
            VAULT_WRITE_DESC,
            vault_write_parameters(),
        ));
        specs.push(openai_fn(VAULT_MOVE, VAULT_MOVE_DESC, vault_move_parameters()));
        specs.push(openai_fn(
            VAULT_DELETE,
            VAULT_DELETE_DESC,
            vault_delete_parameters(),
        ));
        specs.push(openai_fn(
            WRITE_FILE,
            WRITE_FILE_DESC,
            path_content_parameters(),
        ));
        specs.push(openai_fn(EDIT_FILE, EDIT_FILE_DESC, edit_file_parameters()));
        specs.push(openai_fn(DELETE_FILE, DELETE_FILE_DESC, path_parameters()));
        specs.push(openai_fn(MOVE_FILE, MOVE_FILE_DESC, src_dest_parameters()));
        specs.push(openai_fn(COPY_FILE, COPY_FILE_DESC, src_dest_parameters()));
    }
    // System tools. The mutating ones (download_file, run_shell, open_file)
    // are stripped under read_only exactly like filesystem writes; the
    // read-only task tracking/cancelling tools are always present.
    if sandbox.allows_mutating_tools() {
        specs.push(openai_fn(
            DOWNLOAD_FILE,
            DOWNLOAD_FILE_DESC,
            download_file_parameters(),
        ));
        specs.push(openai_fn(RUN_SHELL, RUN_SHELL_DESC, run_shell_parameters()));
        specs.push(openai_fn(OPEN_FILE, OPEN_FILE_DESC, path_parameters()));
    }
    // Automation CRUD/run tools — the write half is double-gated: mutating
    // (persisted schedule + unattended runs, stripped under read_only like
    // the filesystem writes) AND family-locked (unlocked via
    // `attach_connector("automations")` or the send-time keyword fast-path).
    // Schemas mirror commands::automation_cmds::validate so a call the model
    // makes cannot be rejected for shape reasons.
    if sandbox.allows_mutating_tools() && caps.automations_write {
        specs.push(openai_fn(
            CREATE_AUTOMATION,
            CREATE_AUTOMATION_DESC,
            create_automation_parameters(),
        ));
        specs.push(openai_fn(
            UPDATE_AUTOMATION,
            UPDATE_AUTOMATION_DESC,
            update_automation_parameters(),
        ));
        specs.push(openai_fn(
            DELETE_AUTOMATION,
            DELETE_AUTOMATION_DESC,
            automation_id_parameters(),
        ));
        specs.push(openai_fn(
            RUN_AUTOMATION_NOW,
            RUN_AUTOMATION_NOW_DESC,
            automation_id_parameters(),
        ));
    }
    // Subagent CRUD — the model authoring its own subagents. Gated on BOTH the
    // mutating posture AND the subagent_write family flag: the flag is false for
    // every surface that builds ToolCaps::default() (the relay bridge, the
    // subagent registries), so they never advertise tools they cannot
    // dispatch. The consent posture at dispatch is stricter still — every
    // authoring call is approval-carded in every posture (see dispatch.rs).
    if caps.subagent_write && sandbox.allows_mutating_tools() {
        specs.push(openai_fn(
            CREATE_SUBAGENT,
            CREATE_SUBAGENT_DESC,
            create_subagent_parameters(),
        ));
        specs.push(openai_fn(
            UPDATE_SUBAGENT,
            UPDATE_SUBAGENT_DESC,
            update_subagent_parameters(),
        ));
        specs.push(openai_fn(
            DELETE_SUBAGENT,
            DELETE_SUBAGENT_DESC,
            subagent_id_parameters(),
        ));
    }
    // download_progress is deliberately NOT advertised: get_task_status
    // returns the same report for any background task (the legacy name stays
    // dispatchable in dispatch.rs so old conversation histories replay).
    specs.push(openai_fn(
        GET_TASK_STATUS,
        GET_TASK_STATUS_DESC,
        task_id_parameters(),
    ));
    specs.push(openai_fn(
        CANCEL_TASK,
        CANCEL_TASK_DESC,
        task_id_parameters(),
    ));
    specs.push(openai_fn(TASK, TASK_DESC, task_parameters()));
    if caps.code_exec {
        specs.push(openai_fn(RUN_CODE, RUN_CODE_DESC, run_code_parameters()));
    }
    // Connector-originated remote tools (one entry per tool per attached
    // connector). Their schemas come from the vendor's MCP `tools/list`; since
    // we don't store the full input schema per turn, we advertise a permissive
    // object schema and let the server validate. Write-kind tools get an
    // approval note in the description so the model knows each will be gated.
    // Vendor tool descriptions are unbounded; an attached source still pays
    // per-tool on every round-trip, so cap hard (tighter for local models).
    let desc_cap = if caps.local_model { 300 } else { 800 };
    append_connector_tools_openai(&caps.attached_connectors, sandbox, &mut specs, desc_cap);
    append_mcp_tools_openai(&caps.mcp_tools, sandbox, &mut specs, desc_cap);
    // Terminal allowlist — last, so it also covers the vendor tools appended
    // just above (an MCP wire name is only in the set if the definition
    // spelled that exact name).
    apply_allow_filter(&mut specs, caps, false);
    specs
}

fn openai_fn(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        }
    })
}

/// Enum-of-ids parameter for the attach meta-tools. `param` is the argument
/// name ("connector_id" / "server_id"). The connector enum carries the
/// unlockable built-in families alongside real connectors — one
/// `attach_connector(id)` call either attaches a source or flips a family's
/// per-turn flag (dispatch run_attach_tool branches on the id).
fn attach_source_parameters(param: &str, ids: &[(String, String)]) -> Value {
    let enum_ids: Vec<&str> = ids.iter().map(|(id, _)| id.as_str()).collect();
    json!({
        "type": "object",
        "properties": {
            param: {
                "type": "string",
                "enum": enum_ids,
                "description": "One id from the \"Connected apps & servers\" list in the system prompt.",
            }
        },
        "required": [param],
    })
}

/// Connectors available-but-not-attached PLUS the unlockable built-in
/// families — the ids `attach_connector` accepts this turn. Families ride
/// the same enum so the model always has a loadable handle for them; when
/// both lists are empty the meta-tool is not advertised at all.
fn attachable_connector_ids(caps: &ToolCaps) -> Vec<(String, String)> {
    let mut ids: Vec<(String, String)> = (*caps.attachable_connectors).clone();
    for pair in caps.unlockable_families.iter() {
        if !ids.iter().any(|(id, _)| id == &pair.0) {
            ids.push(pair.clone());
        }
    }
    ids
}

fn specs_attach_tools_openai(caps: &ToolCaps, specs: &mut Vec<Value>) {
    let connector_ids = attachable_connector_ids(caps);
    if !connector_ids.is_empty() {
        specs.push(openai_fn(
            ATTACH_CONNECTOR,
            ATTACH_CONNECTOR_DESC,
            attach_source_parameters("connector_id", &connector_ids),
        ));
    }
    if !caps.attachable_mcp.is_empty() {
        specs.push(openai_fn(
            ATTACH_MCP_SERVER,
            ATTACH_MCP_SERVER_DESC,
            attach_source_parameters("server_id", &caps.attachable_mcp),
        ));
    }
}

fn specs_attach_tools_anthropic(caps: &ToolCaps, specs: &mut Vec<Value>) {
    let connector_ids = attachable_connector_ids(caps);
    if !connector_ids.is_empty() {
        specs.push(anthropic_fn(
            ATTACH_CONNECTOR,
            ATTACH_CONNECTOR_DESC,
            attach_source_parameters("connector_id", &connector_ids),
        ));
    }
    if !caps.attachable_mcp.is_empty() {
        specs.push(anthropic_fn(
            ATTACH_MCP_SERVER,
            ATTACH_MCP_SERVER_DESC,
            attach_source_parameters("server_id", &caps.attachable_mcp),
        ));
    }
}

/// Anthropic `tools` array (`{name, description, input_schema}` entries).
/// Same read-only filtering as [`openai_tool_specs`].
pub fn anthropic_tool_specs(caps: &ToolCaps, sandbox: permission::SandboxPolicy) -> Vec<Value> {
    let mut specs: Vec<Value> = vec![];
    if caps.web_search {
        specs.push(anthropic_fn(
            WEB_SEARCH,
            WEB_SEARCH_DESC,
            web_search_parameters(),
        ));
    }
    // Attach-on-demand meta-tools (mirror of the OpenAI builder's call).
    specs_attach_tools_anthropic(caps, &mut specs);
    specs.extend(vec![
        anthropic_fn(
            GENERATE_FILE,
            GENERATE_FILE_DESC,
            generate_file_parameters(),
        ),
        anthropic_fn(
            GENERATE_DOCUMENT,
            GENERATE_DOCUMENT_DESC,
            generate_document_parameters(),
        ),
        anthropic_fn(
            PLAN_DOCUMENT,
            PLAN_DOCUMENT_DESC,
            plan_document_parameters(),
        ),
        anthropic_fn(
            REVISE_DOCUMENT,
            REVISE_DOCUMENT_DESC,
            revise_document_parameters(),
        ),
        anthropic_fn(
            GENERATE_DIAGRAM,
            GENERATE_DIAGRAM_DESC,
            generate_diagram_parameters(),
        ),
        anthropic_fn(
            GENERATE_IMAGE,
            GENERATE_IMAGE_DESC,
            generate_image_parameters(),
        ),
        anthropic_fn(FETCH_URL, FETCH_URL_DESC, fetch_url_parameters()),
        anthropic_fn(OPEN_URL, OPEN_URL_DESC, fetch_url_parameters()),
        anthropic_fn(GET_SKILL, GET_SKILL_DESC, get_skill_parameters()),
        anthropic_fn(LIST_SKILLS, LIST_SKILLS_DESC, no_parameters()),
        // Mirror of the OpenAI block's live artifact listing.
        anthropic_fn(
            LIST_ARTIFACTS,
            LIST_ARTIFACTS_DESC,
            list_artifacts_parameters(),
        ),
        // In-process availability introspection (mirror of the OpenAI block).
        anthropic_fn(GET_CAPABILITIES, GET_CAPABILITIES_DESC, no_parameters()),
        // browser_read is always advertised (with open_url it is the entry
        // point to whatever page is open); the interaction tools need a live
        // page and are gated on caps.browser below.
        anthropic_fn(BROWSER_READ, BROWSER_READ_DESC, browser_read_parameters()),
        // Research source ledger — rides caps.research (mirror of the
        // OpenAI block): only research turns reference these tools, so
        // ordinary turns don't carry them.
    ]);
    if caps.research {
        specs.extend(vec![
            anthropic_fn(
                ADD_SOURCE_NOTE,
                ADD_SOURCE_NOTE_DESC,
                add_source_note_parameters(),
            ),
            anthropic_fn(
                GET_SOURCE_LEDGER,
                GET_SOURCE_LEDGER_DESC,
                get_source_ledger_parameters(),
            ),
            anthropic_fn(
                RESET_SOURCE_LEDGER,
                RESET_SOURCE_LEDGER_DESC,
                no_parameters(),
            ),
            anthropic_fn(
                CHECK_SUFFICIENCY,
                CHECK_SUFFICIENCY_DESC,
                check_sufficiency_parameters(),
            ),
        ]);
    }
    specs.extend(vec![
        // Plan tracking — mirror of the OpenAI builder's block above.
        anthropic_fn(TODO_WRITE, TODO_WRITE_DESC, todo_items_parameters(true)),
        anthropic_fn(
            ENTER_PLAN_MODE,
            ENTER_PLAN_MODE_DESC,
            enter_plan_mode_parameters(),
        ),
        anthropic_fn(PRESENT_PLAN, PRESENT_PLAN_DESC, plan_text_parameters()),
        anthropic_fn(
            LIST_DIRECTORY,
            LIST_DIRECTORY_DESC,
            list_directory_parameters(),
        ),
        anthropic_fn(READ_FILE, READ_FILE_DESC, read_file_parameters()),
        anthropic_fn(SEARCH_FILES, SEARCH_FILES_DESC, search_files_parameters()),
        anthropic_fn(
            SEARCH_CONTENT,
            SEARCH_CONTENT_DESC,
            search_content_parameters(),
        ),
        anthropic_fn(VAULT_LIST, VAULT_LIST_DESC, vault_list_parameters()),
        anthropic_fn(VAULT_READ, VAULT_READ_DESC, vault_read_parameters()),
        anthropic_fn(VAULT_SEARCH, VAULT_SEARCH_DESC, vault_search_parameters()),
        // Automations — read-only list/get always on (mirror of the OpenAI
        // block).
        anthropic_fn(LIST_AUTOMATIONS, LIST_AUTOMATIONS_DESC, no_parameters()),
        anthropic_fn(
            GET_AUTOMATION,
            GET_AUTOMATION_DESC,
            automation_id_parameters(),
        ),
        anthropic_fn(LIST_SUBAGENTS, LIST_SUBAGENTS_DESC, no_parameters()),
        // Session Mesh — mirror of the OpenAI block above: the whole family
        // rides caps.session_mesh (locked by default, attach-to-unlock).
    ]);
    if caps.session_mesh {
        specs.extend(vec![
            anthropic_fn(LIST_SESSIONS, LIST_SESSIONS_DESC, list_sessions_parameters()),
            anthropic_fn(READ_SESSION, READ_SESSION_DESC, read_session_parameters()),
            anthropic_fn(SEARCH_SESSIONS, SEARCH_SESSIONS_DESC, search_sessions_parameters()),
            anthropic_fn(MESSAGE_SESSION, MESSAGE_SESSION_DESC, message_session_parameters()),
            anthropic_fn(SPAWN_SESSION, SPAWN_SESSION_DESC, spawn_session_parameters()),
        ]);
    }
    // Browser interaction tools — mirror of the OpenAI block's caps.browser
    // gate (sticky per session; refreshed mid-turn by streaming.rs).
    if caps.browser {
        specs.extend(vec![
            anthropic_fn(BROWSER_CLICK, BROWSER_CLICK_DESC, browser_ref_parameters()),
            anthropic_fn(BROWSER_TYPE, BROWSER_TYPE_DESC, browser_type_parameters()),
            anthropic_fn(
                BROWSER_SCROLL,
                BROWSER_SCROLL_DESC,
                browser_scroll_parameters(),
            ),
            anthropic_fn(BROWSER_SCREENSHOT, BROWSER_SCREENSHOT_DESC, no_parameters()),
            anthropic_fn(BROWSER_OBSERVE, BROWSER_OBSERVE_DESC, no_parameters()),
            anthropic_fn(
                BROWSER_EXTRACT,
                BROWSER_EXTRACT_DESC,
                browser_extract_parameters(),
            ),
        ]);
    }
    // Persistent memory — mirror of the OpenAI block's caps.memory gate.
    if caps.memory {
        specs.extend(vec![
            anthropic_fn(MEMORY_SAVE, MEMORY_SAVE_DESC, memory_save_parameters()),
            anthropic_fn(
                MEMORY_RECALL,
                MEMORY_RECALL_DESC,
                memory_recall_parameters(),
            ),
            anthropic_fn(
                MEMORY_FORGET,
                MEMORY_FORGET_DESC,
                memory_forget_parameters(),
            ),
        ]);
    }
    // TOTP 2FA — mirror of the OpenAI block: family-locked by default.
    if caps.totp {
        specs.push(anthropic_fn(
            TOTP_CODE,
            TOTP_CODE_DESC,
            totp_code_parameters(),
        ));
    }
    if caps.local_docs {
        specs.push(anthropic_fn(
            SEARCH_DOCS,
            SEARCH_DOCS_DESC,
            search_docs_parameters(),
        ));
    }
    if sandbox.allows_mutating_tools() {
        specs.push(anthropic_fn(
            VAULT_WRITE,
            VAULT_WRITE_DESC,
            vault_write_parameters(),
        ));
        specs.push(anthropic_fn(VAULT_MOVE, VAULT_MOVE_DESC, vault_move_parameters()));
        specs.push(anthropic_fn(
            VAULT_DELETE,
            VAULT_DELETE_DESC,
            vault_delete_parameters(),
        ));
        specs.push(anthropic_fn(
            WRITE_FILE,
            WRITE_FILE_DESC,
            path_content_parameters(),
        ));
        specs.push(anthropic_fn(
            EDIT_FILE,
            EDIT_FILE_DESC,
            edit_file_parameters(),
        ));
        specs.push(anthropic_fn(
            DELETE_FILE,
            DELETE_FILE_DESC,
            path_parameters(),
        ));
        specs.push(anthropic_fn(
            MOVE_FILE,
            MOVE_FILE_DESC,
            src_dest_parameters(),
        ));
        specs.push(anthropic_fn(
            COPY_FILE,
            COPY_FILE_DESC,
            src_dest_parameters(),
        ));
    }
    if sandbox.allows_mutating_tools() {
        specs.push(anthropic_fn(
            DOWNLOAD_FILE,
            DOWNLOAD_FILE_DESC,
            download_file_parameters(),
        ));
        specs.push(anthropic_fn(
            RUN_SHELL,
            RUN_SHELL_DESC,
            run_shell_parameters(),
        ));
        specs.push(anthropic_fn(OPEN_FILE, OPEN_FILE_DESC, path_parameters()));
    }
    // Automation CRUD/run tools — mirror of the OpenAI block above: the
    // write half is both mutating-gated AND family-locked.
    if sandbox.allows_mutating_tools() && caps.automations_write {
        specs.push(anthropic_fn(
            CREATE_AUTOMATION,
            CREATE_AUTOMATION_DESC,
            create_automation_parameters(),
        ));
        specs.push(anthropic_fn(
            UPDATE_AUTOMATION,
            UPDATE_AUTOMATION_DESC,
            update_automation_parameters(),
        ));
        specs.push(anthropic_fn(
            DELETE_AUTOMATION,
            DELETE_AUTOMATION_DESC,
            automation_id_parameters(),
        ));
        specs.push(anthropic_fn(
            RUN_AUTOMATION_NOW,
            RUN_AUTOMATION_NOW_DESC,
            automation_id_parameters(),
        ));
    }
    // Subagent CRUD — mirror of the OpenAI block above (flag + posture gating).
    if caps.subagent_write && sandbox.allows_mutating_tools() {
        specs.push(anthropic_fn(
            CREATE_SUBAGENT,
            CREATE_SUBAGENT_DESC,
            create_subagent_parameters(),
        ));
        specs.push(anthropic_fn(
            UPDATE_SUBAGENT,
            UPDATE_SUBAGENT_DESC,
            update_subagent_parameters(),
        ));
        specs.push(anthropic_fn(
            DELETE_SUBAGENT,
            DELETE_SUBAGENT_DESC,
            subagent_id_parameters(),
        ));
    }
    // download_progress not advertised here either (see the OpenAI builder).
    specs.push(anthropic_fn(
        GET_TASK_STATUS,
        GET_TASK_STATUS_DESC,
        task_id_parameters(),
    ));
    specs.push(anthropic_fn(
        CANCEL_TASK,
        CANCEL_TASK_DESC,
        task_id_parameters(),
    ));
    specs.push(anthropic_fn(TASK, TASK_DESC, task_parameters()));
    if caps.code_exec {
        specs.push(anthropic_fn(RUN_CODE, RUN_CODE_DESC, run_code_parameters()));
    }
    let desc_cap = if caps.local_model { 300 } else { 800 };
    append_connector_tools_anthropic(&caps.attached_connectors, sandbox, &mut specs, desc_cap);
    append_mcp_tools_anthropic(&caps.mcp_tools, sandbox, &mut specs, desc_cap);
    // Terminal allowlist — mirror of the OpenAI builder's filter above.
    apply_allow_filter(&mut specs, caps, true);
    specs
}

fn anthropic_fn(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "input_schema": input_schema,
    })
}

fn web_search_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query.",
            }
        },
        "required": ["query"],
    })
}

fn generate_file_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "format": {
                "type": "string",
                "description": "Document format (pdf, docx, pptx, xlsx, csv, md, \
                    txt, html, json) or a source-code language for the right \
                    extension (python, rust, typescript, …).",
            },
            "filename": {
                "type": "string",
                "description": "Base file name. Extension optional; if you add \
                    one, use the real language extension (main.py), not .txt.",
            },
            "title": {
                "type": "string",
                "description": "Optional document/deck title.",
            },
            "content": {
                "type": "string",
                "description": "The textual content of the file.",
            }
        },
        "required": ["format", "filename", "content"],
    })
}

fn generate_document_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "format": {
                "type": "string",
                "enum": ["docx", "pptx", "xlsx", "pdf"],
                "description": "The document format to generate.",
            },
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional).",
            },
            "language": {
                "type": "string",
                "enum": ["javascript", "html", "python"],
                "description": "Engine for `code`. javascript (default docx/pptx): \
                    program against the preloaded `docx` / `PptxGenJS` globals, \
                    deliver via `await relay.save(...)`. html (default pdf): a \
                    complete styled HTML document rendered by a real browser \
                    engine. python (fallback): python-docx / python-pptx / \
                    openpyxl / reportlab, saving to the RELAY_OUTPUT path.",
            },
            "code": {
                "type": "string",
                "description": "Complete program/source for the chosen `language` \
                    that builds the document. The style guide and engine \
                    cheatsheet arrive with the tool result.",
            }
        },
        "required": ["format", "filename", "code"],
    })
}

fn plan_document_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "format": {
                "type": "string",
                "enum": ["pptx", "docx", "pdf"],
                "description": "pptx: deck plan (slides/layouts). docx|pdf: document plan (sections/blocks).",
            },
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional; .pptx is used).",
            },
            "theme": {
                "type": "string",
                "enum": ["ink", "midnight", "emerald", "plum", "amber", "crimson", "teal"],
                "description": "Design-system theme. Optional; defaults to ink, or the plan's own theme field.",
            },
            "system": {
                "type": "string",
                "enum": ["editorial", "consulting", "product", "minimal"],
                "description": "Named design system: defaults the theme and nudges layout selection (editorial=reports/prose, consulting=analysis decks, product=launch decks, minimal=memos). Optional.",
            },
            "plan": {
                "type": "object",
                "description": "The deck plan: { v: 1, kind: \"deck\", title, theme?, slides: [{ id, layout, slots, notes? }] }. Layouts: cover, section, agenda, bullets, two-col, chart-text, chart-full, kpi, quote, timeline, table, statement, closing.",
            }
        },
        "required": ["format", "filename", "plan"],
    })
}

fn revise_document_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Artifact path from the original plan_document result.",
            },
            "patches": {
                "type": "array",
                "description": "Targeted edits. Deck: {\"slide\": id, \"slot\": id, \"value\": any} or {\"slide\": id, \"notes\": str}. Document: {\"section\": id, \"heading\": str}, {\"section\": id, \"block\": index, \"value\": str|object}, or {\"section\": id, \"block\": index, \"remove\": true}.",
                "items": { "type": "object" },
            }
        },
        "required": ["path", "patches"],
    })
}

fn generate_diagram_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional; .html is used).",
            },
            "title": {
                "type": "string",
                "description": "Diagram title, shown above the flow.",
            },
            "html": {
                "type": "string",
                "description": "Complete self-contained HTML document for the \
                    diagram (inline <style>, no external resources, no scripts). \
                    This is written verbatim to the .html file.",
            }
        },
        "required": ["filename", "html"],
    })
}

fn generate_image_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "What to draw: subject, style/medium, lighting, \
                    composition (e.g. \"a red fox curled on moss, dawn mist, \
                    watercolor\")."
            },
            "width": {
                "type": "integer",
                "description": "Width in pixels (OPTIONAL — default: the model's native \
                    render size). Rounded to the 64px grid, clamped 256-2048. On ~6GB GPUs \
                    use 512-768 for SDXL/full checkpoints."
            },
            "height": {
                "type": "integer",
                "description": "Height in pixels. Same default, grid and clamp as width."
            },
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional; .png is used)."
            }
        },
        "required": ["prompt"]
    })
}

/// Empty parameter schema for tools that take no arguments (e.g. the
/// read-only `get_source_ledger` / `reset_source_ledger` ledger tools).
fn no_parameters() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn list_artifacts_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Optional filename substring filter (case-insensitive), \
                    e.g. \"digest\" or \"report\"."
            },
            "limit": {
                "type": "integer",
                "description": "Max entries to return (1–50, default 10)."
            }
        }
    })
}

/// `get_source_ledger` takes an optional read mode: default returns full
/// notes (fact + verbatim excerpt); `"compact"` returns the claim index
/// without excerpts for small-context models / huge ledgers.
fn get_source_ledger_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["full", "compact"],
                "description": "'full' (default) = every note with its verbatim excerpt; 'compact' = claim index only (id, url, title, fact, publisher, publishedAt, unavailable — NO excerpts) when the ledger is too large for the context window."
            }
        },
        "additionalProperties": false
    })
}

/// Parameter schema for the local-docs `search_docs` tool. `query` is the
/// natural-language question; `top_k` (optional, capped server-side at 20)
/// controls how many hits to return.

// ---- Vault parameter schemas (shape-mirrors of the vault command args) ----

fn vault_list_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "folder": {
                "type": "string",
                "description": "Optional vault-relative folder to scope the listing (e.g. \"Projects\"). Omit for the whole vault."
            }
        }
    })
}

fn vault_read_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Vault-relative note path with extension, e.g. \"Projects/Ideas.md\"."
            }
        },
        "required": ["path"]
    })
}

fn vault_search_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search text. Operators: tag:work, path:Projects, file:2026, \"quoted phrase\", -exclude."
            },
            "limit": {
                "type": "integer",
                "description": "Max hits (default 20, max 50)."
            }
        },
        "required": ["query"]
    })
}

fn vault_write_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Vault-relative note path ending in .md (folders are created as needed). Overwrites when the note exists."
            },
            "content": {
                "type": "string",
                "description": "The complete markdown content of the note (overwrite is wholesale). Optional YAML frontmatter first."
            }
        },
        "required": ["path", "content"]
    })
}

fn vault_move_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "from": {
                "type": "string",
                "description": "Current vault-relative .md path."
            },
            "to": {
                "type": "string",
                "description": "New vault-relative .md path. Inbound links are rewritten vault-wide."
            }
        },
        "required": ["from", "to"]
    })
}

fn vault_delete_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Vault-relative .md path of the note to delete (moves to .trash)."
            }
        },
        "required": ["path"]
    })
}

fn search_docs_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["query"],
        "properties": {
            "query": {
                "type": "string",
                "description": "The natural-language question or keywords to \
                    search the user's local-doc corpora for. Phrase the query \
                    the way the answer would be written (e.g. 'how do we \
                    authenticate API calls?' rather than 'auth')."
            },
            "top_k": {
                "type": "integer",
                "description": "How many top hits to return. Defaults to 5. \
                    The server caps this at 20.",
                "minimum": 1,
                "maximum": 20,
                "default": 5,
            },
        },
    })
}

fn memory_save_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["content"],
        "properties": {
            "content": {
                "type": "string",
                "description": "The fact to remember, as ONE self-contained \
                    sentence in third person, timeless tense (e.g. 'User \
                    prefers pnpm over npm'). Never include secrets or code."
            },
            "kind": {
                "type": "string",
                "enum": ["identity", "preference", "fact", "project", "feedback", "episode"],
                "description": "The memory category. Defaults to 'fact'.",
            },
            "subject": {
                "type": "string",
                "description": "What the fact is about: 'user' (default), \
                    'project', or a short topic slug.",
            },
            "importance": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9,
                "description": "How much this should shape future behavior: \
                    1-2 mundane, 5-6 shapes how you help, 7-8 high-impact \
                    (workflow corrections, core constraints), 9 identity/safety. \
                    Defaults to 6.",
            },
        },
    })
}

fn totp_code_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["key"],
        "properties": {
            "key": {
                "type": "string",
                "description": "Which seed to use: the project secret key \
                    (source 'keyring', default), a Bitwarden item name/id \
                    (source 'bitwarden'), or a full op:// secret reference \
                    (source '1password')."
            },
            "source": {
                "type": "string",
                "enum": ["keyring", "bitwarden", "1password"],
                "description": "Where the seed lives. Default 'keyring' \
                    (project secrets). 'bitwarden' shells to `bw get totp`; \
                    '1password' shells to `op read`."
            },
            "digits": {
                "type": "integer",
                "enum": [6, 8],
                "description": "Code length for keyring seeds. Default 6; \
                    ignored for CLI sources (they return the code directly)."
            },
            "period": {
                "type": "integer",
                "description": "Rotation period in seconds for keyring seeds. \
                    Default 30."
            },
        },
    })
}

fn memory_recall_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["query"],
        "properties": {
            "query": {
                "type": "string",
                "description": "Keywords or a natural-language question to \
                    search remembered facts for (e.g. 'pdf pipeline decision')."
            },
            "kind": {
                "type": "string",
                "description": "Optional filter: identity | preference | fact | \
                    project | feedback | episode.",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 20,
                "description": "Max records to return. Defaults to 8.",
            },
        },
    })
}

fn memory_forget_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["memory_id"],
        "properties": {
            "memory_id": {
                "type": "string",
                "description": "The memory id (from memory_recall) to retire."
            },
        },
    })
}

fn browser_extract_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {
                "type": "string",
                "description": "What to look for on the page. Keywords score the page's sections (e.g. 'pricing tiers', 'return policy', 'rate limits')."
            },
            "max_chars": {
                "type": "integer",
                "description": "Cap on returned text. Default 2500, max 20000.",
            },
        },
    })
}

fn browser_read_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["full", "summary_only", "section"],
                "default": "full",
                "description": "'full' = complete cleaned article; \
                    'summary_only' = headings + first ~1500 chars (cheap triage); \
                    'section' = content under the given selector/heading."
            },
            "selector": {
                "type": "string",
                "description": "CSS selector (#id, .class) or heading text \
                    (contains match). Only used when mode='section'."
            }
        },
        "additionalProperties": false
    })
}

fn browser_ref_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ref": {
                "type": "integer",
                "description": "The element's ref number from the latest browser_read.",
            }
        },
        "required": ["ref"],
    })
}

fn browser_type_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "ref": {
                "type": "integer",
                "description": "The input's ref number from the latest browser_read.",
            },
            "text": {
                "type": "string",
                "description": "The text to type into the field.",
            }
        },
        "required": ["ref", "text"],
    })
}

fn browser_scroll_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "amount": {
                "type": "integer",
                "description": "Pixels to scroll vertically; negative scrolls up. Default 600.",
            }
        },
    })
}

fn add_source_note_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The source page's URL (prefer canonicalUrl when cleaner)."
            },
            "title": {
                "type": "string",
                "description": "The source page's title."
            },
            "fact": {
                "type": "string",
                "description": "ONE concrete fact you extracted — a single sentence, not a paragraph."
            },
            "excerpt": {
                "type": "string",
                "description": "A short VERBATIM QUOTE from the page that supports the fact (not a paraphrase)."
            },
            "unavailable": {
                "type": "string",
                "enum": ["paywalled", "login_required", "extraction_failed", "blocked"],
                "description": "Set to the browser_read failureReason when the source could not be read; omit when usable."
            },
            "publisher": {
                "type": "string",
                "description": "Publisher/site name (e.g. 'Nature') — used to weight conflicting claims."
            },
            "publishedAt": {
                "type": "string",
                "description": "Publish date when shown (e.g. '2026-05-14') — used to prefer fresher sources."
            }
        },
        "required": ["url", "title", "fact", "excerpt"]
    })
}

fn check_sufficiency_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "subquestions": {
                "type": "array",
                "description": "One entry per planned sub-question.",
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "The sub-question."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["sufficient", "insufficient"],
                            "description": "'sufficient' only when the ledger holds ≥2 notes from independent domains that answer it."
                        },
                        "independent_sources": {
                            "type": "integer",
                            "description": "How many distinct domains corroborate the answer in the ledger."
                        },
                        "opposing_view_found": {
                            "type": "boolean",
                            "description": "Whether you found dissenting/outdated views worth reporting."
                        },
                        "gaps": {
                            "type": "string",
                            "description": "When insufficient: exactly what is missing (e.g. 'no primary source for the pricing claim')."
                        }
                    },
                    "required": ["question", "status"]
                }
            }
        },
        "required": ["subquestions"]
    })
}

fn fetch_url_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The absolute http(s) URL to fetch.",
            }
        },
        "required": ["url"],
    })
}

fn get_skill_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "slug": {
                "type": "string",
                "description": "The skill's slash-command slug, e.g. \"docx\", \"pptx\", \"pdf\", or \"diagram\". One of the Available skills listed in the system prompt."
            }
        },
        "required": ["slug"],
    })
}

fn run_code_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "language": {
                "type": "string",
                "enum": ["python", "javascript", "bash"],
                "description": "The language of the snippet.",
            },
            "code": {
                "type": "string",
                "description": "The source code to execute.",
            }
        },
        "required": ["language", "code"],
    })
}

// ---- System tool parameter schemas ----

fn download_file_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The absolute http(s) URL of the file to download \
                    (e.g. a Hugging Face resolve URL for a .safetensors / .bin \
                    weight file).",
            },
            "dest_path": {
                "type": "string",
                "description": "Absolute destination path on this machine, e.g. \
                    \"D:\\local models\\model.safetensors\". Parent directories \
                    are created automatically. Any drive/directory is allowed.",
            }
        },
        "required": ["url", "dest_path"],
    })
}

fn run_shell_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to run natively (cmd.exe / sh).",
            },
            "workdir": {
                "type": "string",
                "description": "Optional working directory for the command. Defaults \
                    to the user's home directory when omitted or invalid.",
            },
            "background": {
                "type": "boolean",
                "description": "Run as a BACKGROUND task (long-running work: dev \
                    servers, watchers, long installs). Returns a task id \
                    immediately; poll get_task_status for streamed output and \
                    cancel_task to kill it. Required for anything longer than the \
                    120s foreground ceiling.",
            },
            "timeout_secs": {
                "type": "integer",
                "description": "TEMPORARY processes only: auto-kill at this \
                    deadline (5–3600). The task is marked failed with a \
                    timeout notice when it fires.",
            }
        },
        "required": ["command"],
    })
}

/// `subagent_type` values: the 7 built-in roles, ALWAYS present, plus every
/// subagent name from the registry cache (F.5). Builtins come from
/// `chat::subagent::BUILTIN_ROLES` — the same table the registry seeds and the
/// runtime prompt builder read, so the three cannot drift — and the subagent
/// names are deduped against them, so a row that somehow shares a role name
/// does not produce a two-value enum.
///
/// Cached with a 30s TTL and invalidated on every registry write (see
/// `chat::subagent::cached_agent_names`), because this function is on the
/// per-turn spec-build path and has no DB handle of its own.
///
/// Growth note (C.8.2): the enum is a fat-list design and is right while the
/// subagent is small. Past roughly twenty agents the right move is a `list_agents`
/// / `run_agent(name, …)` meta-tool instead — this is the seam that would
/// carry it, so the threshold is recorded here rather than rediscovered.
fn subagent_type_values() -> Vec<String> {
    let mut values: Vec<String> = crate::chat::subagents::BUILTIN_ROLES
        .iter()
        .map(|r| r.name.to_string())
        .collect();
    for name in crate::chat::subagents::cached_agent_names().iter() {
        if !values.iter().any(|v| v.eq_ignore_ascii_case(name)) {
            values.push(name.clone());
        }
    }
    values
}

fn task_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Human-readable one-line summary of what the subagent should do.",
            },
            "prompt": {
                "type": "string",
                "description": "The full prompt the subagent will execute. It is the subagent's only input — no conversation history is injected.",
            },
            "subagent_type": {
                "type": "string",
                "description": "Role label for the Agents panel. The built-in roles are listed first; any further values are the user's own agents from Settings → Agents.",
                "enum": subagent_type_values(),
            },
            "agent": {
                "type": "string",
                "description": "Subagent id or name (overrides subagent_type). Use it when the caller names an agent that is not one of the built-in roles.",
            },
            "model": {
                "type": "string",
                "description": "Model override when the subagent should run on a different \
                     model: bare id keeps the session\'s provider; \"provider::model\"\
                     targets another (API providers only; CLI engines go via \
                     spawn_session). Omit for the session default.",
            },
            "background": {
                "type": "boolean",
                "description": "Run WITHOUT blocking the main conversation. Returns a task id immediately; poll get_task_status with it (the result lands there when the subagent finishes) and cancel_task to abort. Prefer this for anything long."
            },
        },
        "required": ["description", "prompt", "subagent_type"],
    })
}

fn task_id_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task id returned by download_file / run_shell.",
            }
        },
        "required": ["task_id"],
    })
}

// ---- Automation tool descriptions + schemas ----
//
// Kept in sync with commands::automation_cmds::validate: same agent set, same
// 5-field-cron rule, same required fields. The execution side
// (chat/tools/automations.rs) re-validates, so a stale schema degrades into
// an error message, never a bad row.

const LIST_AUTOMATIONS_DESC: &str = "List the user's scheduled automations (cron \
    headless agent runs): id, name, agent, schedule, next fire, last status. \
    Prompts appear truncated — call get_automation for the full text. Call \
    before update/delete/run to get ids.";

const GET_AUTOMATION_DESC: &str = "Read one automation in full by id (from \
    list_automations): the COMPLETE prompt plus agent, model, cwd, schedule, \
    enabled, status. update_automation overwrites whole fields — read this \
    verbatim text before editing.";

const CREATE_AUTOMATION_DESC: &str = "Create an automation: `prompt` runs \
    unattended via the chosen agent — default trigger is a 5-field local-time \
    cron `schedule`; set trigger_type+trigger for webhook / file-change / \
    git-commit / new-email firing instead. Confirm an ambiguous schedule \
    first. Runs have no conversation memory.";

const UPDATE_AUTOMATION_DESC: &str = "Update an automation by id (from \
    list_automations). Only passed fields change; `enabled` toggles it.";

const DELETE_AUTOMATION_DESC: &str = "Delete an automation by id, permanently and \
    with its run history.";

const RUN_AUTOMATION_NOW_DESC: &str = "Fire one run of an automation immediately; \
    it executes in the background and lands in the run history.";

// ---- Subagent (declarative subagents) tool descriptions + schemas ----

const LIST_SUBAGENTS_DESC: &str = "List the user's subagents (named reusable \
    subagents): id, name, prompt, allowlist, engine/model, scope. Call before \
    create/update/delete for ids.";

const CREATE_SUBAGENT_DESC: &str = "Create a subagent: a named reusable \
    subagent spawnable via Task, spawn_session or an automation. name \
    (lowercase-hyphen), description, prompt_md (standing instructions), \
    optional tools allowlist (omit = read-only default), engine/model, \
    sandbox_policy. User confirms before save.";

const UPDATE_SUBAGENT_DESC: &str = "Update a subagent by id or name (from \
    list_subagents). Only passed fields change.";

const DELETE_SUBAGENT_DESC: &str = "Delete a subagent by id or name, \
    permanently. Builtins and in-flight agents are refused.";

fn subagent_id_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["agent_id"],
        "properties": {
            "agent_id": {
                "type": "string",
                "description": "Subagent id or unique name - from \
                    list_subagents."
            }
        }
    })
}

fn create_subagent_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["name"],
        "properties": {
            "name": {
                "type": "string",
                "description": "Unique lowercase-hyphen name (e.g. \
                    \"pr-reviewer\"). Becomes the Task enum value."
            },
            "description": {
                "type": "string",
                "description": "One line on what it is for."
            },
            "prompt_md": {
                "type": "string",
                "description": "Standing instructions (markdown), prepended \
                    to every run's task."
            },
            "tools": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Allowlist (vocabulary from list_subagents). \
                    Omit = read-only default; disallowed tools are dropped, \
                    never granted."
            },
            "engine": {
                "type": "string",
                "description": "\"builtin\" (default), \"local\", or \
                    \"harness:<id>\". builtin = enforced; harness = advisory."
            },
            "model": {
                "type": "string",
                "description": "\"provider::model\" or bare id; omit for the \
                    provider default."
            },
            "sandbox_policy": {
                "type": "string",
                "enum": ["read_only", "workspace_write"],
                "description": "Default read_only."
            },
            "approval_policy": {
                "type": "string",
                "enum": ["on_request", "auto_edit", "full_access"],
                "description": "Default on_request."
            },
            "worktree_policy": {
                "type": "string",
                "enum": ["inherit", "always", "never"],
                "description": "\"always\" = isolated git worktree per run. \
                    Default inherit."
            }
        }
    })
}

fn update_subagent_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["agent_id"],
        "properties": {
            "agent_id": {
                "type": "string",
                "description": "Subagent id or unique name."
            },
            "name": { "type": "string", "description": "New unique name." },
            "description": { "type": "string" },
            "prompt_md": { "type": "string", "description": "New standing \
                instructions (replaces the body)." },
            "tools": {
                "type": "array",
                "items": { "type": "string" },
                "description": "New allowlist; null clears to default."
            },
            "engine": { "type": "string" },
            "model": { "type": "string" },
            "sandbox_policy": { "type": "string",
                "enum": ["read_only", "workspace_write"] },
            "approval_policy": { "type": "string",
                "enum": ["on_request", "auto_edit", "full_access"] },
            "worktree_policy": { "type": "string",
                "enum": ["inherit", "always", "never"] }
        }
    })
}

// ---- Session Mesh tool descriptions + schemas ----
//
// SESSION_MESH_DESIGN_ARCHITECTURE.md. Dispatched by crate::session_fabric
// (NOT execute_tool) so harness CLIs reach the identical handlers through the
// relay-tools bridge. The registry block injected into both prompt paths
// states the caller's own session id — the `session_id` argument here refers
// to PEER sessions from list_sessions.

const LIST_SESSIONS_DESC: &str = "List the user's OTHER Relay chat sessions (peer     awareness): id, title, engine, project, live status, and a one-line summary of     what each covers. Use when the user references another conversation ('the auth     chat', 'what we decided earlier') or before duplicating work that may already     be in progress elsewhere. Same-project sessions rank first.";

const READ_SESSION_DESC: &str = "Read another Relay chat session's knowledge: mode=\"summary\"     (default) returns its distilled abstract; \"recent_turns\" returns the latest     role-tagged messages; \"transcript\" returns the fuller history (capped). Use     after list_sessions/search_sessions point at a peer.";

const SEARCH_SESSIONS_DESC: &str = "Full-text search across ALL Relay chat sessions'     messages and titles — 'which conversation covered X?'. Returns matching     sessions with excerpts; pair with read_session for depth. This is your own     history, not the web.";

const MESSAGE_SESSION_DESC: &str = "Send a message to another Relay chat session.     mode=\"question\" (default) waits up to timeout_s for that session's answer and     returns it; on timeout the reply still arrives later as a follow-up turn.     mode=\"notify\" delivers without expecting a reply. The target receives it as a     turn marked as coming from you (NOT the user) — the user sees the exchange in     the UI. Use to consult a peer's context or request something of it; NOT for     chatting with the user.";

const SPAWN_SESSION_DESC: &str = "Spawn a NEW, separate Relay chat session: a real, \
    sidebar-visible session (any installed engine — it may differ from yours) whose \
    first turn is `task`. A SEPARATE conversation the user can watch and take over — \
    NOT an in-session subagent; for that use your engine's Task tool (its result \
    returns to you directly). Use this when the user explicitly asks for a new/separate \
    chat or delegation that should outlive this conversation. When the spawned session \
    finishes the task, its result is automatically messaged back into this session. \
    mode=\"background\" (default) returns the new session's id immediately; mode=\"wait\" \
    blocks (bounded) and returns its first-turn output. Leave `agent`/`model` \
    unset unless the task needs a specific engine/model — the configured \
    default subagent model applies. A named model the target engine lacks is \
    replaced by that engine's default (the spawn result says so).";

fn list_sessions_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "scope": {
                "type": "string",
                "enum": ["project", "all"],
                "description": "\"project\" (default) = this session's project plus                     project-less chats; \"all\" = every session in the app."
            },
            "limit": {
                "type": "integer",
                "description": "Max sessions to return (1-24, default 12).",
                "minimum": 1,
                "maximum": 24
            }
        }
    })
}

fn read_session_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["session_id"],
        "properties": {
            "session_id": {
                "type": "string",
                "description": "The peer session's id (from list_sessions / search_sessions)."
            },
            "mode": {
                "type": "string",
                "enum": ["summary", "recent_turns", "transcript"],
                "description": "\"summary\" (default) = distilled abstract;                     \"recent_turns\" = latest messages (8k chars); \"transcript\" = fuller                     history (24k chars)."
            }
        }
    })
}

fn search_sessions_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["query"],
        "properties": {
            "query": {
                "type": "string",
                "description": "Keywords or a phrase to find across all sessions'                     messages and titles."
            },
            "limit": {
                "type": "integer",
                "description": "Max sessions to return (1-10, default 5).",
                "minimum": 1,
                "maximum": 10
            }
        }
    })
}

fn message_session_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["session_id", "body"],
        "properties": {
            "caller_session_id": {
                "type": "string",
                "description": "YOUR own Relay session id (stated in your Session Mesh                     context). Harness sessions should include it so replies can be                     routed back; built-in chats can omit it."
            },
            "session_id": {
                "type": "string",
                "description": "The TARGET session's id (from list_sessions) — the peer                     you are addressing, never your own id."
            },
            "body": {
                "type": "string",
                "description": "The message/question text. Be self-contained — the peer                     cannot see this conversation."
            },
            "mode": {
                "type": "string",
                "enum": ["question", "notify"],
                "description": "\"question\" (default) waits for the peer's answer;                     \"notify\" fires and returns."
            },
            "timeout_s": {
                "type": "integer",
                "description": "question mode: how long to wait (5-120, default 25s).                     Later answers still arrive as a follow-up turn.",
                "minimum": 5,
                "maximum": 120
            }
        }
    })
}

/// The `agent` parameter's description, rebuilt per spec-build so it carries
/// the LIVE registry vocabulary. `agent` has to stay a free-form string (a
/// bare value is an engine id, an `agent:`-prefixed one is a subagent), so it
/// cannot use the hard `enum` the `Task` `subagent_type` param gets — the
/// names go in the prose instead, which is the only place both halves of the
/// dual meaning can be stated together.
///
/// The list is capped (same fat-list concern as [`subagent_type_values`]): past
/// a dozen agents `list_subagents` is the better answer anyway, and inlining
/// every name would grow this description with the registry until it dominated
/// the request.
///
/// Two claims this description deliberately makes, because the runtime does
/// them:
/// * the unknown-name behavior — the spawn SUCCEEDS on the parent's engine and
///   says so in its reply, so a model that guesses wrong would otherwise read
///   it as a subagent having run;
/// * what a definition actually transfers. The prompt and the sandbox/approval
///   scope do; the tool allowlist does NOT, because a mesh spawn is a NORMAL
///   chat session and runs the engine's own toolset. The old text promised all
///   three, which was a false promise about sandboxing.
fn spawn_agent_description() -> String {
    const INLINE_LIMIT: usize = 12;
    let names = crate::chat::subagents::cached_agent_names();
    let vocabulary = match names.len() {
        0 => "No user agents yet — call `list_subagents` to confirm.".to_string(),
        n if n <= INLINE_LIMIT => format!(
            "Passable now: {}. `list_subagents` has their prompts.",
            names
                .iter()
                .map(|n| format!("{n:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        n => format!(
            "{n} agents are defined — call `list_subagents` for their names rather \
             than guessing one."
        ),
    };
    format!(
        "Engine for the new session: \"claude_code\", \"opencode\", \"builtin\", \
         \"local\" (defaults to yours). An \"agent:<id-or-name>\" value instead \
         spawns a SUBAGENT — its prompt, permission scope and engine/model apply, \
         but its tool allowlist does not (the child is a normal chat on the \
         engine's own tools). An unknown name does not fail: the spawn runs on \
         your engine and says so. {vocabulary}"
    )
}

fn spawn_session_parameters() -> Value {
    json!({
        "type": "object",
        "required": ["task"],
        "properties": {
            "caller_session_id": {
                "type": "string",
                "description": "YOUR own Relay session id (stated in your Session Mesh                     context). Harness sessions should include it so the spawn tree is                     tracked; built-in chats can omit it."
            },
            "task": {
                "type": "string",
                "description": "The new session's first instruction — a complete,                     self-contained task description."
            },
            "title": {
                "type": "string",
                "description": "Short sidebar title for the new session (defaults to                     the task's first words)."
            },
            "agent": {
                "type": "string",
                "description": spawn_agent_description(),
            },
            "model": {
                "type": "string",
                "description": "Model/engine for the child: bare id keeps your provider; \"provider::model\" switches provider (builtin); \"claude_code::sonnet\" runs another CLI harness. Omit for the configured default (preferred)."
            },
            "mode": {
                "type": "string",
                "enum": ["background", "wait"],
                "description": "\"background\" (default) returns the session id now;                     \"wait\" blocks for the first turn's output (bounded)."
            }
        }
    })
}

/// Agent enum for the automation create/update schemas — mirrors
/// commands::automation_cmds::ALLOWED_AGENTS (+ local_gguf).
const AUTOMATION_AGENTS: [&str; 8] = [
    "claude_code",
    "opencode",
    "anthropic",
    "openai",
    "openrouter",
    "anthropic_compatible",
    "openai_compatible",
    "local_gguf",
];

fn create_automation_parameters() -> Value {
    // The engine list stays static, but `agent:...` values route through the
    // subagent registry — the enum can't enumerate user rows (they change between
    // turns), so the description carries the contract.
    json!({
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Short name, e.g. \"Morning news digest\".",
            },
            "prompt": {
                "type": "string",
                "description": "FULL instruction run unattended — self-contained, \
                    no reference to this conversation.",
            },
            "schedule": {
                "type": "string",
                "description": "5-field cron in LOCAL time, minute-first \
                    (\"0 9 * * 1-5\" = 09:00 weekdays). Leave empty for \
                    webhook/file/git/gmail triggers.",
            },
            "agent": {
                "type": "string",
                "enum": AUTOMATION_AGENTS,
                "description": "Agent engine. Default claude_code. An \
                    \"agent:<id-or-name>\" value instead runs a SUBAGENT agent \
                    (a user-defined subagent — `list_subagents` is the \
                    authority, `get_capabilities` indexes their names) \
                    with that definition's engine, model and permission scope.",
            },
            "enabled": {
                "type": "boolean",
                "description": "Active. Default true.",
            },
            "trigger_type": {
                "type": "string",
                "enum": ["cron", "webhook", "file", "git", "gmail"],
                "description": "Firing engine. Default cron. webhook = \
                    authenticated HTTP call (URL in reply); file = watched \
                    folder changes; git = repo HEAD changes; gmail = new \
                    email in the connected Gmail account.",
            },
            "trigger": {
                "type": "object",
                "description": "Config per type. webhook: {}. file: {path, \
                    minIntervalSecs? (default 60)}. git: {cwd, branch? \
                    (default HEAD)}. gmail: {label? (default inbox)}.",
            },
        },
        "required": ["name", "prompt"],
    })
}

fn update_automation_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "automation_id": {
                "type": "string",
                "description": "The id from list_automations.",
            },
            "name": { "type": "string", "description": "New name (optional)." },
            "prompt": { "type": "string", "description": "New prompt (optional)." },
            "schedule": {
                "type": "string",
                "description": "New 5-field local-time cron (optional; empty \
                    is valid for webhook/file/git/gmail triggers).",
            },
            "agent": {
                "type": "string",
                "description": "New agent engine (optional) — one of \
                    create_automation's agent values.",
            },
            "model": {
                "type": "string",
                "description": "Model override; omit = keep, empty = default.",
            },
            "cwd": {
                "type": "string",
                "description": "Working directory; omit = keep, empty = none.",
            },
            "enabled": {
                "type": "boolean",
                "description": "Turn on/off (optional).",
            },
            "trigger_type": {
                "type": "string",
                "enum": ["cron", "webhook", "file", "git", "gmail"],
                "description": "Switch the firing engine (optional); omit \
                    trigger_type+trigger to keep the stored engine.",
            },
            "trigger": {
                "type": "object",
                "description": "New trigger config (create_automation's \
                    trigger shape).",
            },
        },
        "required": ["automation_id"],
    })
}

/// Schema for the id-taking automation tools (delete / run-now).
fn automation_id_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "automation_id": {
                "type": "string",
                "description": "The automation id from list_automations.",
            }
        },
        "required": ["automation_id"],
    })
}

// ---- Filesystem tool parameter schemas ----

fn path_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path to the target file or directory.",
            }
        },
        "required": ["path"],
    })
}

fn path_content_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the file to write.",
            },
            "content": {
                "type": "string",
                "description": "The full text content to write (overwrites any existing file).",
            }
        },
        "required": ["path", "content"],
    })
}

fn edit_file_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the file to edit.",
            },
            "find": {
                "type": "string",
                "description": "The exact substring to replace. Must be unique in the file unless expected_matches or all_occurrences is also set.",
            },
            "replace": {
                "type": "string",
                "description": "The replacement text.",
            },
            "append": {
                "type": "string",
                "description": "If set, append this text to the end of the file instead of find/replace.",
            },
            "expected_matches": {
                "type": "integer",
                "description": "How many times 'find' should occur. If the actual count differs, the edit is REJECTED with a line-numbered list of all matches so you can disambiguate. Omit to require uniqueness by default (the safest path).",
            },
            "all_occurrences": {
                "type": "boolean",
                "default": false,
                "description": "If true, replace every occurrence of 'find' (bulk rename / refactor).",
            }
        },
        "required": ["path"],
    })
}

fn src_dest_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "src": {
                "type": "string",
                "description": "Absolute path of the source file/directory.",
            },
            "dest": {
                "type": "string",
                "description": "Absolute destination path.",
            }
        },
        "required": ["src", "dest"],
    })
}

fn list_directory_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the directory to list.",
            }
        },
        "required": ["path"],
    })
}

fn read_file_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the file to read.",
            }
        },
        "required": ["path"],
    })
}

fn search_files_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the directory to search under.",
            },
            "query": {
                "type": "string",
                "description": "Substring to match against file/directory names (case-insensitive).",
            }
        },
        "required": ["path", "query"],
    })
}

fn search_content_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the directory to search under.",
            },
            "query": {
                "type": "string",
                "description": "Substring (default) or regex (when regex: true) to match inside files.",
            },
            "regex": {
                "type": "boolean",
                "default": false,
                "description": "If true, query is a regex (regex crate syntax).",
            },
            "glob": {
                "type": "string",
                "description": "Optional file-name glob filter, e.g. '*.rs' or '**/test_*.py'.",
            },
            "case_insensitive": {
                "type": "boolean",
                "default": false,
                "description": "Match case-insensitively.",
            },
            "max_results": {
                "type": "integer",
                "default": 100,
                "description": "Cap on matches returned.",
            },
            "include_hidden": {
                "type": "boolean",
                "default": false,
                "description": "Include dotfile/dotdir entries (build/cache dirs stay skipped regardless).",
            }
        },
        "required": ["path", "query"],
    })
}

// ---- Connector remote-tool schema merge ----
//
// The vendor's MCP server defines its own tools (e.g. Notion's search/create-
// page tools); Relay does NOT hardcode them. At turn start each attached
// connector's `tools/list` is fetched and classified (Read/Write) in
// `connectors::session`. Here we advertise those tools to the model with a
// permissive object schema (the server validates the real args) and tag the
// Write-kind tools' descriptions with an approval note so the model knows each
// mutating call will be gated.

fn connector_tool_description(
    att: &crate::connectors::AttachedConnector,
    name: &str,
    desc_cap: usize,
) -> String {
    let kind = att.tools.get(name).map(|(k, _)| *k);
    let base = att
        .tools
        .get(name)
        .and_then(|(_, d)| d.clone())
        .unwrap_or_default();
    let header = format!(
        "[{} connector{}] ",
        att.display_name,
        match kind {
            Some(crate::chat::permission::ConnectorToolKind::Write) => " · WRITES — gated",
            _ => "",
        }
    );
    if base.is_empty() {
        format!("{header}{name}")
    } else {
        format!("{header}{}", truncate_desc(&base, desc_cap))
    }
}

/// Hard-cap a vendor tool description. Vendor descriptions are unbounded
/// (Notion ships single descriptions of 8k chars); once a source is attached
/// its per-tool line still ships on every round-trip of every turn, so the
/// local tier especially needs a tight cap.
fn truncate_desc(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let cut: String = s.chars().take(cap).collect();
    let trimmed = trimmed_char_boundary(&cut);
    format!("{trimmed}…")
}

/// Floor a char-count cut to a byte boundary without pulling in
/// `str::floor_char_boundary` (still unstable).
fn trimmed_char_boundary(s: &str) -> &str {
    let mut end = s.len();
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn permissive_params() -> Value {
    // Permissive object schema: the server validates the real argument shape.
    json!({ "type": "object", "additionalProperties": true })
}

fn append_connector_tools_openai(
    attached: &[crate::connectors::AttachedConnector],
    sandbox: permission::SandboxPolicy,
    specs: &mut Vec<Value>,
    desc_cap: usize,
) {
    for att in attached {
        for name in att.tools.keys() {
            // Under read_only, connector Write tools are stripped from the
            // schema (mirrors the filesystem mutating tools) so the model
            // cannot even propose them.
            if !sandbox.allows_mutating_tools()
                && att.tools.get(name).map(|(k, _)| *k)
                    == Some(permission::ConnectorToolKind::Write)
            {
                continue;
            }
            let description = connector_tool_description(att, name, desc_cap);
            specs.push(openai_fn(name, &description, permissive_params()));
        }
    }
}

fn append_connector_tools_anthropic(
    attached: &[crate::connectors::AttachedConnector],
    sandbox: permission::SandboxPolicy,
    specs: &mut Vec<Value>,
    desc_cap: usize,
) {
    for att in attached {
        for name in att.tools.keys() {
            if !sandbox.allows_mutating_tools()
                && att.tools.get(name).map(|(k, _)| *k)
                    == Some(permission::ConnectorToolKind::Write)
            {
                continue;
            }
            let description = connector_tool_description(att, name, desc_cap);
            specs.push(anthropic_fn(name, &description, permissive_params()));
        }
    }
}

// MCP-gallery tools (§3.2.14): user-installed stdio MCP servers. Same
// contract as connector tools — permissive schema (the server validates the
// real args), Write-kind tools tagged in the description and stripped under
// read_only — but advertised under prefixed wire names
// (`mcp_<server>_<tool>`) so two servers can expose the same raw tool name
// without colliding with each other or the built-ins.

fn mcp_tool_description(entry: &crate::mcp_gallery::McpToolEntry, desc_cap: usize) -> String {
    let header = format!(
        "[{} MCP server{}] ",
        entry.server_name,
        match entry.kind {
            permission::ConnectorToolKind::Write => " · WRITES — gated",
            _ => "",
        }
    );
    match &entry.description {
        Some(d) if !d.is_empty() => format!("{header}{}", truncate_desc(d, desc_cap)),
        _ => format!("{header}{}", entry.raw_name),
    }
}

pub(crate) fn append_mcp_tools_openai(
    entries: &[crate::mcp_gallery::McpToolEntry],
    sandbox: permission::SandboxPolicy,
    specs: &mut Vec<Value>,
    desc_cap: usize,
) {
    for entry in entries {
        if !sandbox.allows_mutating_tools() && entry.kind == permission::ConnectorToolKind::Write {
            continue;
        }
        specs.push(openai_fn(
            &entry.wire_name,
            &mcp_tool_description(entry, desc_cap),
            permissive_params(),
        ));
    }
}

pub(crate) fn append_mcp_tools_anthropic(
    entries: &[crate::mcp_gallery::McpToolEntry],
    sandbox: permission::SandboxPolicy,
    specs: &mut Vec<Value>,
    desc_cap: usize,
) {
    for entry in entries {
        if !sandbox.allows_mutating_tools() && entry.kind == permission::ConnectorToolKind::Write {
            continue;
        }
        specs.push(anthropic_fn(
            &entry.wire_name,
            &mcp_tool_description(entry, desc_cap),
            permissive_params(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Task schema: the dynamic `subagent_type` enum ----

    /// The registry name cache is a process-wide static shared with the
    /// parallel test runner, so every test that reads the `Task` schema
    /// brackets itself with an invalidate and asserts MEMBERSHIP, never an
    /// exact length (a count would be a race, not a contract).
    struct CacheGuard;

    impl CacheGuard {
        fn start() -> Self {
            crate::chat::subagents::invalidate_registry_cache();
            Self
        }
    }

    impl Drop for CacheGuard {
        fn drop(&mut self) {
            crate::chat::subagents::invalidate_registry_cache();
        }
    }

    fn enum_values(params: &Value) -> Vec<String> {
        params["properties"]["subagent_type"]["enum"]
            .as_array()
            .expect("subagent_type must stay an enum")
            .iter()
            .map(|v| v.as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn subagent_input(name: &str) -> crate::chat::subagents::SubagentInput {
        crate::chat::subagents::SubagentInput {
            name: name.into(),
            description: String::new(),
            prompt_md: String::new(),
            tools: None,
            engine: None,
            model: None,
            effort: None,
            sandbox_policy: "read_only".into(),
            approval_policy: "on_request".into(),
            worktree_policy: "inherit".into(),
            max_rounds: 10,
            max_concurrent: 2,
        }
    }

    #[test]
    fn task_enum_carries_the_seven_builtin_roles_plus_the_subagent() {
        let _guard = CacheGuard::start();
        let conn = crate::db::mem();
        // A cold cache still advertises the 7 roles: they are a constant, not
        // registry data.
        for role in crate::chat::subagents::BUILTIN_ROLES {
            assert!(
                enum_values(&task_parameters()).iter().any(|v| v == role.name),
                "builtin role {} missing from the enum",
                role.name
            );
        }

        crate::chat::subagents::create(&conn, &subagent_input("doc-writer")).unwrap();
        // Republish from THIS connection, then read. The cache is
        // process-wide and a parallel test can invalidate it between the write
        // and the read, so the contract under test ("a write is visible to
        // the next read") is asserted against a re-read rather than fought
        // for with a lock every other registry-touching test would also have
        // to take. Bounded, so a genuine regression still fails.
        let mut values = Vec::new();
        for _ in 0..5 {
            crate::chat::subagents::refresh_registry_cache(&conn);
            values = enum_values(&task_parameters());
            if values.iter().any(|v| v == "doc-writer") {
                break;
            }
            std::thread::yield_now();
        }
        assert!(
            values.iter().any(|v| v == "doc-writer"),
            "a created agent joins the enum: {values:?}"
        );
        // The roles keep their canonical order at the head of the enum.
        let head: Vec<&str> = values
            .iter()
            .take(crate::chat::subagents::BUILTIN_ROLES.len())
            .map(String::as_str)
            .collect();
        let want: Vec<&str> = crate::chat::subagents::BUILTIN_ROLES
            .iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(head, want, "the 7 roles lead the enum, in order");

        // No duplicates, case-insensitively (a hand-edited registry row that
        // collides with a role name must not produce a two-value enum).
        let mut seen: Vec<String> = values.clone();
        seen.sort_by_key(|v| v.to_lowercase());
        let before = seen.len();
        seen.dedup();
        assert_eq!(before, seen.len(), "duplicate enum values: {values:?}");
    }

    #[test]
    fn task_schema_exposes_the_agent_parameter() {
        let params = task_parameters();
        let agent = &params["properties"]["agent"];
        assert_eq!(agent["type"], "string", "the agent param is a string");
        assert!(
            !params["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "agent"),
            "`agent` is an optional override, never required"
        );
        let desc = agent["description"].as_str().unwrap_or_default();
        assert!(desc.contains("id or name"), "doc must say id or name: {desc}");
        // `subagent_type` stays required — the panel label still needs one.
        assert!(params["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "subagent_type"));
    }

    #[test]
    fn task_enum_picks_up_an_agent_created_after_a_cached_read() {
        let _guard = CacheGuard::start();
        let conn = crate::db::mem();
        crate::chat::subagents::refresh_registry_cache(&conn);
        assert!(!enum_values(&task_parameters())
            .iter()
            .any(|v| v == "late-comer"));

        let agent = crate::chat::subagents::create(&conn, &subagent_input("late-comer")).unwrap();
        // `create` invalidates + refreshes, so the next build already has it.
        assert!(enum_values(&task_parameters())
            .iter()
            .any(|v| v == "late-comer"));
        crate::chat::subagents::delete(&conn, &agent.id).unwrap();
        assert!(!enum_values(&task_parameters())
            .iter()
            .any(|v| v == "late-comer"));
    }

    // ---- `ToolCaps::allow`: the terminal name filter ----

    fn allow_caps(names: &[&str]) -> ToolCaps {
        ToolCaps {
            allow: Some(std::sync::Arc::new(
                names.iter().map(|s| (*s).to_string()).collect(),
            )),
            ..ToolCaps::default()
        }
    }

    #[test]
    fn allow_none_is_byte_identical_to_never_having_the_field() {
        // The default must not perturb a single byte of the registry, or
        // every existing turn's cached prompt changes.
        let plain = ToolCaps::default();
        assert!(plain.allow.is_none());
        let explicit_none = ToolCaps {
            allow: None,
            ..ToolCaps::default()
        };
        for sandbox in [
            permission::SandboxPolicy::ReadOnly,
            permission::SandboxPolicy::WorkspaceWrite,
        ] {
            assert_eq!(
                openai_tool_specs(&plain, sandbox),
                openai_tool_specs(&explicit_none, sandbox)
            );
            assert_eq!(
                anthropic_tool_specs(&plain, sandbox),
                anthropic_tool_specs(&explicit_none, sandbox)
            );
        }
    }

    #[test]
    fn allow_set_yields_exactly_one_spec_in_both_wire_formats() {
        let caps = allow_caps(&[READ_FILE]);
        let oai = openai_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite);
        assert_eq!(oai.len(), 1, "one allowed name, one OpenAI spec");
        assert_eq!(oai[0]["function"]["name"], READ_FILE);
        let ant = anthropic_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite);
        assert_eq!(ant.len(), 1, "one allowed name, one Anthropic spec");
        assert_eq!(ant[0]["name"], READ_FILE);
        // The envelope is the whole point of doing this in the builders: the
        // OpenAI name really is nested, the Anthropic one really is top-level.
        assert!(oai[0].get("name").is_none());
        assert!(ant[0].get("function").is_none());
    }

    #[test]
    fn allow_runs_after_the_sandbox_strip_so_a_mutating_name_cannot_smuggle_in() {
        // `write_file` IS in the allow set, but the sandbox strips it from
        // the registry first — the terminal filter only ever removes.
        let caps = allow_caps(&[READ_FILE, WRITE_FILE]);
        let ro = openai_tool_specs(&caps, permission::SandboxPolicy::ReadOnly);
        assert_eq!(ro.len(), 1);
        assert_eq!(ro[0]["function"]["name"], READ_FILE);
        let ro_ant = anthropic_tool_specs(&caps, permission::SandboxPolicy::ReadOnly);
        assert_eq!(ro_ant.len(), 1);
        assert_eq!(ro_ant[0]["name"], READ_FILE);
        // Under the write sandbox it does come through — the policy, not the
        // filter, is what grants it.
        let rw = openai_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite);
        assert_eq!(rw.len(), 2);
    }

    #[test]
    fn allow_also_filters_connector_and_mcp_specs() {
        use crate::chat::permission::ConnectorToolKind;
        use crate::mcp_gallery::McpToolEntry;

        // Connector + MCP wire names are ordinary strings at the filter, so a
        // definition CAN name one — and one that does not is stripped even
        // though it survived every flag gate.
        let mcp = vec![McpToolEntry {
            server_id: "memory".into(),
            server_name: "Memory".into(),
            wire_name: crate::mcp_gallery::wire_tool_name("memory", "search_nodes"),
            raw_name: "search_nodes".into(),
            kind: ConnectorToolKind::Read,
            description: Some("Search the graph".into()),
        }];
        let mut caps = allow_caps(&[READ_FILE, "mcp_memory_search_nodes"]);
        caps.mcp_tools = std::sync::Arc::new(mcp);
        let specs = openai_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite);
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|s| s.pointer("/function/name").and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"mcp_memory_search_nodes"), "{names:?}");
        assert!(!names.contains(&"memory_recall"), "unlisted tools: {names:?}");

        // And the same set in the Anthropic envelope.
        let ant = anthropic_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite);
        let ant_names: Vec<&str> = ant
            .iter()
            .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(ant_names.contains(&"mcp_memory_search_nodes"), "{ant_names:?}");
        assert_eq!(ant_names.len(), 2, "{ant_names:?}");
    }

    #[test]
    fn allow_count_matches_the_unfiltered_registry_when_it_admits_everything() {
        let all: std::collections::HashSet<String> = openai_tool_specs(
            &ToolCaps::default(),
            permission::SandboxPolicy::WorkspaceWrite,
        )
        .iter()
        .filter_map(|s| s.pointer("/function/name").and_then(|n| n.as_str()))
        .map(str::to_string)
        .collect();
        let caps = allow_caps(&all.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(
            openai_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite).len(),
            all.len(),
            "an allow-all set must not change the count"
        );
    }

    /// The two delegation tools used to steer models in OPPOSITE directions:
    /// spawn_session said "Prefer this over doing a big parallel task inside
    /// this conversation" while users expect a subagent to run in-session —
    /// so models kept spawning separate sidebar chats whose results never
    /// reached the parent. Both descriptions must carry the disambiguation
    /// (Task = in-session, spawn_session = separate chat) and spawn_session
    /// must document the result auto-report.
    #[test]
    fn delegation_tool_descriptions_disambiguate_task_vs_spawn_session() {
        assert!(
            TASK_DESC.contains("IN-SESSION subagent"),
            "Task desc must say in-session: {TASK_DESC}"
        );
        assert!(
            TASK_DESC.contains("spawn_session"),
            "Task desc must point separate-chat asks at spawn_session: {TASK_DESC}"
        );
        assert!(
            !SPAWN_SESSION_DESC.contains("Prefer this over"),
            "spawn_session must not claim preference over in-session work: {SPAWN_SESSION_DESC}"
        );
        assert!(
            SPAWN_SESSION_DESC.contains("Task tool"),
            "spawn_session desc must point subagent asks at the Task tool: {SPAWN_SESSION_DESC}"
        );
        assert!(
            SPAWN_SESSION_DESC.contains("automatically messaged back"),
            "spawn_session desc must document the result auto-report: {SPAWN_SESSION_DESC}"
        );
    }

    /// Per-spec size report + regression guard. Tool specs ride EVERY request
    /// (every turn, every tool round), so a single bloated spec taxes every
    /// turn forever. Run with `--nocapture` to see the distribution; the
    /// assertions keep any one spec — and the whole registry — from silently
    /// re-bloating. The budgets were set after the token-diet pass trimmed
    /// description/schema duplication and gated the browser interaction tools
    /// on `ToolCaps.browser` / memory on `ToolCaps.memory` (default surface
    /// 45.0k → 36.5k chars; every-tool-on 39.4k).
    #[test]
    fn no_single_tool_spec_blows_its_budget() {
        // The `Task` enum is registry-driven, so a parallel test republishing
        // its own subagent would move this total for reasons that have nothing to
        // do with the registry's size. Pin it: the budget guards the built-in
        // surface.
        crate::chat::subagents::invalidate_registry_cache();
        let caps = ToolCaps::default();
        let specs = openai_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite);
        let mut sizes: Vec<(usize, String)> = specs
            .iter()
            .map(|s| {
                let name = s["function"]["name"].as_str().unwrap_or("?").to_string();
                let len = serde_json::to_string(s).unwrap_or_default().len();
                (len, name)
            })
            .collect();
        sizes.sort_by(|a, b| b.0.cmp(&a.0));
        for (len, name) in &sizes {
            println!("{len:>6}  {name}");
        }
        let total: usize = sizes.iter().map(|(l, _)| l).sum();
        println!(
            "total specs JSON: {total} chars across {} tools",
            sizes.len()
        );
        // The worst offenders as of the token-efficiency pass were the
        // document tools (~2.5k each). Anything past this needs a reason.
        if let Some((worst, name)) = sizes.first() {
            assert!(
                *worst < 2_600,
                "tool spec `{name}` bloated to {worst} chars — trim the description/schema or raise the budget deliberately"
            );
        }
        // Whole-registry budgets. DEFAULT: the fresh-turn surface (web search
        // + memory on; no live browser pane, no connectors/MCP, no local docs,
        // no code exec; the family-locked built-ins — ledger/mesh/automation
        // writes/totp — are NOT in this surface, they return via
        // attach_connector). ALL-ON: same plus the browser interaction tools
        // AND every family unlocked — the full registry, so its sizes stay
        // guarded even though no single chat turn carries all of it. Tool
        // specs are re-sent on every request and every tool round, so sum
        // creep is a per-turn tax forever. HEADROOM ≈ 4% above the measured
        // sizes — a deliberate bump needs a reason in the PR.
        // Bumped 38_000→42_000 / 41_000→45_000 for Session Mesh
        // (SESSION_MESH_DESIGN_ARCHITECTURE.md): five tools (~3.2k chars)
        // giving sibling-session awareness, messaging, and spawning. The read
        // trio replaces asking the user about other chats; the write pair
        // replaces re-doing work that already happened elsewhere.
        // Bumped 42_000→42_500 for subagent-model orchestration: an optional
        // `model` parameter on `task` and `spawn_session` (~0.4k) so a parent
        // can route spawned work to a different model/CLI engine.
        // Bumped 42_500→43_000 for the Task ↔ spawn_session disambiguation:
        // both descriptions now cross-reference each other (users expect
        // subagents IN-session; the old texts steered models into separate-
        // chat spawns whose results never reached the parent) and
        // spawn_session documents the result auto-report.
        // Bumped 43_000→44_500 for `generate_image`: local text-to-image via
        // the sd-server sidecar (~1.6k chars) — a new user-facing capability
        // (Settings → Local Models → Images), not description rot.
        // Bumped 44_500→47_500 for the vault CRUD family (vault_list/read/
        // search/write/move/delete, ~2.9k): the model's only structured write
        // path into the user's markdown knowledge base — filesystem tools
        // cannot carry the link-rewrite/index semantics.
        // Bumped 47_500→48_000 for update_automation model/cwd parameters
        // (~0.2k): correctness fix — the tool used to silently WIPE the
        // stored model/working-directory on every update, so they must be
        // expressible (and preserved) via the schema.
        // 48_000 stays: get_automation (~0.5k) fit inside the existing
        // headroom after trimming its description to schema-carrying essentials.
        // Bumped 48_000→49_000 for automation trigger engines beyond cron
        // (create/update automation, ~0.9k): trigger_type + trigger config
        // params (webhook / file-watch / git) — without them the model can
        // only schedule cron rows and must claim the other triggers are
        // impossible.
        // 36_000 STANDS for the subagent `Task` schema (Phase 2): `subagent_type`
        // became a DYNAMIC enum (the 7 roles plus the user's subagent names, from
        // the 30s registry cache) and gained an optional `agent` override —
        // ~0.25k on the `Task` spec, and it is the feature that makes the
        // enum worth anything. With an empty subagent the enum is exactly today's
        // 7 values; a large subagent grows this spec, and the meta-tool escape
        // hatch is called out in `subagent_type_values`.
        // TIGHTENED 49_000→36_000 (2026-09-21, token-efficiency pass II):
        // the source ledger now rides `caps.research`, and Session Mesh /
        // automation writes / totp_code became family-locked attach-on-demand
        // built-ins — the default fresh-turn surface dropped 48.8k → 35.1k
        // chars (57 → 44 tools). Locked families return via one
        // attach_connector call; the manifest line keeps them discoverable.
        assert!(
            total < 36_000,
            "default tool specs total {total} chars (budget 36_000) — the registry is re-bloating; trim descriptions/schemas or raise the budget deliberately"
        );
        let all_on_caps = ToolCaps {
            browser: true,
            ..ToolCaps::unlocked_registry()
        };
        let all_on: usize = openai_tool_specs(&all_on_caps, permission::SandboxPolicy::WorkspaceWrite)
            .iter()
            .map(|s| serde_json::to_string(s).unwrap_or_default().len())
            .sum();
        println!("all-on specs JSON: {all_on} chars");
        // Same orchestration bump: 45_000→45_500 (the `model` params ride
        // the all-on surface too); 45_500→46_000 mirrors the default-budget
        // disambiguation bump above; 46_000→47_500 mirrors the
        // generate_image bump above (the spec rides the all-on surface too);
        // 47_500→50_500 mirrors the vault CRUD family bump above (all six
        // vault specs ride the all-on surface).
        // Bumped 50_500→51_000 for `get_automation` (~0.5k): the full-prompt
        // read path (list_automations truncates to a one-liner) — an edit
        // turn must start from verbatim text, not a reconstruction.
        // Bumped 51_000→52_000 for automation trigger engines beyond cron
        // (create/update automation trigger_type+trigger params, ~0.9k) —
        // both specs ride the all-on surface too.
        // Bumped 52_000→53_500 (2026-09-21, token-efficiency pass II): the
        // all-on surface is now the FULL registry — `unlocked_registry()` +
        // browser — including every family-locked built-in AND the
        // attach_connector meta-tool (its enum carries the three family ids,
        // so it renders even with no connectors attachable). No single chat
        // turn carries this whole surface any more; the budget guards the
        // registry's aggregate size.
        // Bumped 53_500→55_800 for the subagent CRUD family (list/create/update/
        // delete_subagent, ~2.3k): the model can AUTHOR the user's
        // declarative subagents on request, not just run them — the same
        // authoring surface create_automation already provides, with the
        // identical always-carded consent posture. The default fresh-turn
        // surface is unaffected: the CRUD trio rides `caps.subagent_write` and is
        // stripped from the bridge/subagent registries (ToolCaps::default()).
        assert!(
            all_on < 55_800,
            "all-on tool specs total {all_on} chars (budget 55_800) — the registry is re-bloating; trim descriptions/schemas or raise the budget deliberately"
        );
    }

    #[test]
    fn mcp_gallery_tools_merge_with_prefix_and_write_stripping() {
        use crate::chat::permission::ConnectorToolKind;
        use crate::mcp_gallery::McpToolEntry;

        let entries = vec![
            McpToolEntry {
                server_id: "memory".into(),
                server_name: "Memory".into(),
                wire_name: crate::mcp_gallery::wire_tool_name("memory", "search_nodes"),
                raw_name: "search_nodes".into(),
                kind: ConnectorToolKind::Read,
                description: Some("Search the knowledge graph".into()),
            },
            McpToolEntry {
                server_id: "memory".into(),
                server_name: "Memory".into(),
                wire_name: crate::mcp_gallery::wire_tool_name("memory", "create_entities"),
                raw_name: "create_entities".into(),
                kind: ConnectorToolKind::Write,
                description: Some("Create entities".into()),
            },
        ];

        // FullAuto: both tools advertised, write tagged in the description.
        let mut specs = Vec::new();
        append_mcp_tools_openai(
            &entries,
            permission::SandboxPolicy::WorkspaceWrite,
            &mut specs,
            800,
        );
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0]["function"]["name"], "mcp_memory_search_nodes");
        assert!(specs[0]["function"]["description"]
            .as_str()
            .unwrap()
            .starts_with("[Memory MCP server] Search the knowledge graph"));
        assert!(specs[1]["function"]["description"]
            .as_str()
            .unwrap()
            .contains("WRITES — gated"));

        // read_only: the Write tool is stripped entirely.
        let mut ro = Vec::new();
        append_mcp_tools_anthropic(&entries, permission::SandboxPolicy::ReadOnly, &mut ro, 800);
        assert_eq!(ro.len(), 1);
        assert_eq!(ro[0]["name"], "mcp_memory_search_nodes");
    }

    #[test]
    fn browser_read_parameters_schema_has_mode_and_selector() {
        let params = browser_read_parameters();
        assert_eq!(params["type"], "object");
        assert_eq!(params["additionalProperties"], false);
        // Mode property
        let mode = &params["properties"]["mode"];
        assert_eq!(mode["type"], "string");
        assert_eq!(mode["default"], "full");
        let enums: Vec<&str> = mode["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(enums, vec!["full", "summary_only", "section"]);
        // Selector property
        let sel = &params["properties"]["selector"];
        assert_eq!(sel["type"], "string");
        // No required fields (mode defaults, selector is optional)
        assert!(
            params.get("required").is_none()
                || params["required"]
                    .as_array()
                    .map(|a| a.is_empty())
                    .unwrap_or(true)
        );
    }

    #[test]
    fn add_source_note_schema_requires_core_fields() {
        let params = add_source_note_parameters();
        let required: Vec<&str> = params["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(required, vec!["url", "title", "fact", "excerpt"]);
        let unavail = &params["properties"]["unavailable"];
        let enums: Vec<&str> = unavail["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(
            enums,
            vec![
                "paywalled",
                "login_required",
                "extraction_failed",
                "blocked"
            ]
        );
    }

    #[test]
    fn browser_screenshot_advertised_in_both_wire_formats() {
        // Schema-drift regression: browser_screenshot was dispatchable in the
        // dispatcher but missing from BOTH spec builders, so the model was
        // never told it exists. Both wire formats must advertise it when the
        // browser gate is live.
        let caps = ToolCaps {
            browser: true,
            ..ToolCaps::default()
        };
        for (name, specs) in [
            (
                "openai",
                openai_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite),
            ),
            (
                "anthropic",
                anthropic_tool_specs(&caps, permission::SandboxPolicy::WorkspaceWrite),
            ),
        ] {
            let found = specs.iter().any(|s| {
                s["function"]["name"]
                    .as_str()
                    .or_else(|| s["name"].as_str())
                    == Some(crate::chat::tools::BROWSER_SCREENSHOT)
            });
            assert!(found, "{name} tool specs must advertise browser_screenshot");
        }
    }

    #[test]
    fn browser_and_memory_tools_gated_by_caps_in_both_wire_formats() {
        // The browser interaction tools ride caps.browser (default off: an
        // idle session shouldn't pay ~2.9k chars for tools there's nothing to
        // click on), while browser_read stays always-on as the entry point.
        // The memory tools ride caps.memory (default on; the Settings toggle
        // strips them like search_docs' corpus-availability gate does).
        let default_caps = ToolCaps::default();
        let mut no_memory = ToolCaps::default();
        no_memory.memory = false;
        let mut browser_on = ToolCaps::default();
        browser_on.browser = true;
        for (name, build) in [
            ("openai", openai_tool_specs as fn(&ToolCaps, permission::SandboxPolicy) -> Vec<Value>),
            ("anthropic", anthropic_tool_specs as fn(&ToolCaps, permission::SandboxPolicy) -> Vec<Value>),
        ] {
            let names = |caps: &ToolCaps| -> Vec<String> {
                build(caps, permission::SandboxPolicy::WorkspaceWrite)
                    .iter()
                    .map(|s| {
                        s["function"]["name"]
                            .as_str()
                            .or_else(|| s["name"].as_str())
                            .unwrap_or("?")
                            .to_string()
                    })
                    .collect()
            };
            let d = names(&default_caps);
            assert!(!d.iter().any(|n| n == crate::chat::tools::BROWSER_CLICK),
                "{name}: browser_click must be absent while no page is open");
            assert!(d.iter().any(|n| n == crate::chat::tools::BROWSER_READ),
                "{name}: browser_read must stay advertised (entry point)");
            assert!(d.iter().any(|n| n == crate::chat::tools::MEMORY_RECALL),
                "{name}: memory tools default to advertised (feature unset = on)");
            assert!(!names(&no_memory).iter().any(|n| n == crate::chat::tools::MEMORY_RECALL),
                "{name}: memory tools must be stripped when the feature is off");
            assert!(names(&browser_on).iter().any(|n| n == crate::chat::tools::BROWSER_CLICK),
                "{name}: browser_click must be advertised once the pane is live");
        }
    }

    /// The family-locked built-ins: ledger rides `caps.research`, mesh /
    /// automation-writes / totp ride their unlock flags. Locked families are
    /// absent from BOTH wire formats; the read half of automations
    /// (list/get) always stays; unlocking admits exactly the family's tools.
    /// The unlock result must never be a silent drop: `unlocked − locked`
    /// is EXACTLY the 14 family tools, so a rename or refactor that moves a
    /// tool between states fails here instead of quietly deleting a
    /// capability from a turn.
    #[test]
    fn family_locked_tools_gate_in_both_wire_formats() {
        let locked = ToolCaps::default();
        let mut unlocked = ToolCaps::unlocked_registry();
        unlocked.unlock_family(crate::chat::tools::FAMILY_SESSION_MESH);
        unlocked.unlock_family(crate::chat::tools::FAMILY_AUTOMATIONS);
        unlocked.unlock_family(crate::chat::tools::FAMILY_TOTP);
        let mut research_on = ToolCaps::default();
        research_on.research = true;
        for (name, build) in [
            ("openai", openai_tool_specs as fn(&ToolCaps, permission::SandboxPolicy) -> Vec<Value>),
            ("anthropic", anthropic_tool_specs as fn(&ToolCaps, permission::SandboxPolicy) -> Vec<Value>),
        ] {
            let names = |caps: &ToolCaps| -> Vec<String> {
                build(caps, permission::SandboxPolicy::WorkspaceWrite)
                    .iter()
                    .map(|s| {
                        s["function"]["name"]
                            .as_str()
                            .or_else(|| s["name"].as_str())
                            .unwrap_or("?")
                            .to_string()
                    })
                    .collect()
            };
            let l = names(&locked);
            // Ledger, mesh, automation writes and totp absent while locked…
            for gone in [
                crate::chat::tools::ADD_SOURCE_NOTE,
                crate::chat::tools::GET_SOURCE_LEDGER,
                crate::chat::tools::RESET_SOURCE_LEDGER,
                crate::chat::tools::CHECK_SUFFICIENCY,
                crate::chat::tools::LIST_SESSIONS,
                crate::chat::tools::READ_SESSION,
                crate::chat::tools::SEARCH_SESSIONS,
                crate::chat::tools::MESSAGE_SESSION,
                crate::chat::tools::SPAWN_SESSION,
                crate::chat::tools::CREATE_AUTOMATION,
                crate::chat::tools::UPDATE_AUTOMATION,
                crate::chat::tools::DELETE_AUTOMATION,
                crate::chat::tools::RUN_AUTOMATION_NOW,
                crate::chat::tools::TOTP_CODE,
            ] {
                assert!(!l.iter().any(|x| x == gone),
                    "{name}: `{gone}` must be family-locked out of the default schema");
            }
            // …but the automations READ half never locks (the model must be
            // able to see what's scheduled before unlocking writes), and the
            // attach meta-tool carries every family id in its enum so the
            // locked families are always one call away.
            assert!(l.iter().any(|x| x == crate::chat::tools::LIST_AUTOMATIONS));
            assert!(l.iter().any(|x| x == crate::chat::tools::GET_AUTOMATION));
            let attach_spec = build(&locked, permission::SandboxPolicy::WorkspaceWrite)
                .into_iter()
                .find(|s| {
                    s["function"]["name"]
                        .as_str()
                        .or_else(|| s["name"].as_str())
                        == Some(crate::chat::tools::ATTACH_CONNECTOR)
                })
                .expect("attach_connector must be advertised while families are locked");
            let enum_ids: Vec<String> = attach_spec
                .pointer("/function/parameters/properties/connector_id/enum")
                .or_else(|| attach_spec.pointer("/input_schema/properties/connector_id/enum"))
                .and_then(|e| e.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            for family in crate::chat::tools::UNLOCKABLE_FAMILIES {
                assert!(
                    enum_ids.iter().any(|e| e == family.0),
                    "{name}: family id `{}` missing from the attach_connector enum",
                    family.0
                );
            }
            // Research mode admits exactly the four ledger tools…
            let r = names(&research_on);
            for ledger in [
                crate::chat::tools::ADD_SOURCE_NOTE,
                crate::chat::tools::GET_SOURCE_LEDGER,
                crate::chat::tools::RESET_SOURCE_LEDGER,
                crate::chat::tools::CHECK_SUFFICIENCY,
            ] {
                assert!(r.iter().any(|x| x == ledger),
                    "{name}: `{ledger}` must ride research mode");
            }
            assert!(!r.iter().any(|x| x == crate::chat::tools::LIST_SESSIONS),
                "{name}: research mode must not silently unlock the mesh family");
            // …and a full unlock admits exactly locked+14 (family tools),
            // with wire-format parity of the whole array.
            let u = names(&unlocked);
            assert_eq!(
                l.len() + 17,
                u.len(),
                "{name}: unlock delta must be exactly the 17 family tools (mesh 5 + 
                 automations 6 + totp 1 + research 2 + subagent CRUD 3)"
            );
            for gone in [
                crate::chat::tools::ADD_SOURCE_NOTE,
                crate::chat::tools::LIST_SESSIONS,
                crate::chat::tools::MESSAGE_SESSION,
                crate::chat::tools::SPAWN_SESSION,
                crate::chat::tools::CREATE_AUTOMATION,
                crate::chat::tools::RUN_AUTOMATION_NOW,
                crate::chat::tools::TOTP_CODE,
            ] {
                assert!(u.iter().any(|x| x == gone),
                    "{name}: `{gone}` missing after unlock — nothing may go missing");
            }
            // Wire parity: both formats render the same name set per state.
            let mut l_sorted = l.clone();
            l_sorted.sort();
            assert_eq!(l_sorted, {
                let mut v = build_anthropic_names(&locked);
                v.sort();
                v
            });
        }
    }

    fn build_anthropic_names(caps: &ToolCaps) -> Vec<String> {
        anthropic_tool_specs(caps, permission::SandboxPolicy::WorkspaceWrite)
            .iter()
            .map(|s| {
                s["function"]["name"]
                    .as_str()
                    .or_else(|| s["name"].as_str())
                    .unwrap_or("?")
                    .to_string()
            })
            .collect()
    }

    /// NOTHING GOES MISSING — the inventory contract. Every tool name any
    /// surface can reach must be present in at least one standard cap state:
    /// the locked default schema, the fully unlocked registry, or the
    /// read-only posture. The only deliberate exception is
    /// `download_progress` (kept dispatchable for history replay, never
    /// advertised — see its const doc). A new tool that joins the registry
    /// without landing in a spec state fails here.
    #[test]
    fn every_tool_is_reachable_in_some_cap_state() {
        let ws = permission::SandboxPolicy::WorkspaceWrite;
        let names_of = |specs: &[Value]| -> Vec<String> {
            specs
                .iter()
                .map(|s| {
                    s["function"]["name"]
                        .as_str()
                        .or_else(|| s["name"].as_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect()
        };
        let mut reachable = names_of(&openai_tool_specs(&ToolCaps::default(), ws));
        reachable.extend(names_of(&openai_tool_specs(&ToolCaps::unlocked_registry(), ws)));
        reachable.extend(names_of(&openai_tool_specs(
            &ToolCaps {
                browser: true,
                local_docs: true,
                code_exec: true,
                memory: true,
                attachable_connectors: std::sync::Arc::new(vec![(
                    "gmail".to_string(),
                    "Gmail".to_string(),
                )]),
                attachable_mcp: std::sync::Arc::new(vec![(
                    "filesystem".to_string(),
                    "Filesystem".to_string(),
                )]),
                ..ToolCaps::unlocked_registry()
            },
            ws,
        )));
        let required = [
            // web / browser entry
            WEB_SEARCH, FETCH_URL, OPEN_URL, BROWSER_READ,
            // generate family
            GENERATE_FILE, GENERATE_DOCUMENT, PLAN_DOCUMENT, REVISE_DOCUMENT,
            GENERATE_DIAGRAM, GENERATE_IMAGE,
            // skills / artifacts / introspection / attach
            GET_SKILL, LIST_SKILLS, LIST_ARTIFACTS, GET_CAPABILITIES,
            ATTACH_CONNECTOR, ATTACH_MCP_SERVER,
            // fs
            LIST_DIRECTORY, READ_FILE, SEARCH_FILES, SEARCH_CONTENT, SEARCH_DOCS,
            WRITE_FILE, EDIT_FILE, DELETE_FILE, MOVE_FILE, COPY_FILE,
            // vault
            VAULT_LIST, VAULT_READ, VAULT_SEARCH, VAULT_WRITE, VAULT_MOVE, VAULT_DELETE,
            // system
            DOWNLOAD_FILE, RUN_SHELL, OPEN_FILE, GET_TASK_STATUS, CANCEL_TASK, RUN_CODE,
            // subagent + plan
            TASK, TODO_WRITE, ENTER_PLAN_MODE, PRESENT_PLAN,
            // research ledger
            ADD_SOURCE_NOTE, GET_SOURCE_LEDGER, RESET_SOURCE_LEDGER, CHECK_SUFFICIENCY,
            // automations (read half + unlocked write half)
            LIST_AUTOMATIONS, GET_AUTOMATION, CREATE_AUTOMATION, UPDATE_AUTOMATION,
            DELETE_AUTOMATION, RUN_AUTOMATION_NOW,
            // session mesh
            LIST_SESSIONS, READ_SESSION, SEARCH_SESSIONS, MESSAGE_SESSION, SPAWN_SESSION,
            // memory + totp
            MEMORY_SAVE, MEMORY_RECALL, MEMORY_FORGET, TOTP_CODE,
        ];
        for name in required {
            assert!(
                reachable.iter().any(|n| n == name),
                "`{name}` is not advertised in ANY cap state — a capability went missing"
            );
        }
        // download_progress is the ONLY deliberate ghost: dispatchable for
        // replay, never advertised (get_task_status covers it).
        assert!(
            !reachable.iter().any(|n| n == DOWNLOAD_PROGRESS),
            "download_progress must stay unadvertised"
        );
    }
}
