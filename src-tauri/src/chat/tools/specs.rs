//! Wire-format spec builders: render the tool registry into the OpenAI
//! `tools` array ([`openai_tool_specs`]) and the Anthropic `tools` array
//! ([`anthropic_tool_specs`]). The same registry renders into both formats;
//! [`execute_tool`] in `mod.rs` dispatches by name. Read-only filesystem
//! tools are always present; mutating ones are stripped under `read_only`
//! (schema-level exclusion — the model cannot invoke them); `run_code` is
//! gated behind the `code_exec` capability.

use super::super::permission;
use super::*;

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
        // Research source ledger — always on (state tools, not gated by permission mode).
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
        // Automations — list is read-only and always on; the CRUD/run tools
        // below follow the mutating-tool gating (see tools/mod.rs family
        // block). Without them the model denies an app capability it has.
        openai_fn(LIST_AUTOMATIONS, LIST_AUTOMATIONS_DESC, no_parameters()),
    ]);
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
    // Settings toggle the way search_docs is gated by its sidecar; dispatch
    // still returns a clear error as a backstop.
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
    // manager; only the code is returned), always registered.
    specs.push(openai_fn(TOTP_CODE, TOTP_CODE_DESC, totp_code_parameters()));
    // Local-docs search — only exposed when the embedding sidecar is up and at
    // least one corpus is indexed (computed per turn into ToolCaps.local_docs).
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
    // Automation CRUD/run tools — mutating (persisted schedule + unattended
    // runs), stripped under read_only like the filesystem writes. Schemas
    // mirror commands::automation_cmds::validate so a call the model makes
    // cannot be rejected for shape reasons.
    if sandbox.allows_mutating_tools() {
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
/// name ("connector_id" / "server_id").
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

fn specs_attach_tools_openai(caps: &ToolCaps, specs: &mut Vec<Value>) {
    if !caps.attachable_connectors.is_empty() {
        specs.push(openai_fn(
            ATTACH_CONNECTOR,
            ATTACH_CONNECTOR_DESC,
            attach_source_parameters("connector_id", &caps.attachable_connectors),
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
    if !caps.attachable_connectors.is_empty() {
        specs.push(anthropic_fn(
            ATTACH_CONNECTOR,
            ATTACH_CONNECTOR_DESC,
            attach_source_parameters("connector_id", &caps.attachable_connectors),
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
        // Research source ledger — always on (state tools, not gated by permission mode).
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
        // Automations — read-only list always on (mirror of the OpenAI block).
        anthropic_fn(LIST_AUTOMATIONS, LIST_AUTOMATIONS_DESC, no_parameters()),
    ]);
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
    specs.push(anthropic_fn(
        TOTP_CODE,
        TOTP_CODE_DESC,
        totp_code_parameters(),
    ));
    if caps.local_docs {
        specs.push(anthropic_fn(
            SEARCH_DOCS,
            SEARCH_DOCS_DESC,
            search_docs_parameters(),
        ));
    }
    if sandbox.allows_mutating_tools() {
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
    // Automation CRUD/run tools — mirror of the OpenAI block above.
    if sandbox.allows_mutating_tools() {
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
                "description": "Role label for the Agents panel.",
                "enum": ["explore", "edit", "analyze", "research", "write", "test", "refactor"],
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
    Call before update/delete/run to get ids.";

const CREATE_AUTOMATION_DESC: &str = "Create a scheduled automation: `prompt` runs \
    unattended on a 5-field local-time cron `schedule` via the chosen agent. \
    Use when the user asks to schedule/repeat/automate a task — never claim \
    scheduling is impossible; confirm an ambiguous schedule first. Runs have \
    no conversation memory.";

const UPDATE_AUTOMATION_DESC: &str = "Update an automation by id (from \
    list_automations). Only passed fields change; `enabled` toggles it.";

const DELETE_AUTOMATION_DESC: &str = "Delete an automation by id, permanently and \
    with its run history.";

const RUN_AUTOMATION_NOW_DESC: &str = "Fire one run of an automation immediately; \
    it executes in the background and lands in the run history.";

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
                    (\"0 9 * * 1-5\" = 09:00 weekdays).",
            },
            "agent": {
                "type": "string",
                "enum": AUTOMATION_AGENTS,
                "description": "Agent engine. Default claude_code.",
            },
            "enabled": {
                "type": "boolean",
                "description": "Active. Default true.",
            },
        },
        "required": ["name", "prompt", "schedule"],
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
                "description": "New 5-field local-time cron (optional).",
            },
            "agent": {
                "type": "string",
                "description": "New agent engine (optional) — one of \
                    create_automation's agent values.",
            },
            "enabled": {
                "type": "boolean",
                "description": "Turn on/off (optional).",
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
        // no code exec). ALL-ON: same but with the browser interaction tools
        // advertised. Tool specs are re-sent on every request and every tool
        // round, so sum creep is a per-turn tax forever. HEADROOM ≈ 4% above
        // the measured sizes at the diet pass — a deliberate bump needs a
        // reason in the PR.
        assert!(
            total < 38_000,
            "default tool specs total {total} chars (budget 38_000) — the registry is re-bloating; trim descriptions/schemas or raise the budget deliberately"
        );
        let all_on_caps = ToolCaps {
            browser: true,
            ..ToolCaps::default()
        };
        let all_on: usize = openai_tool_specs(&all_on_caps, permission::SandboxPolicy::WorkspaceWrite)
            .iter()
            .map(|s| serde_json::to_string(s).unwrap_or_default().len())
            .sum();
        println!("all-on specs JSON: {all_on} chars");
        assert!(
            all_on < 41_000,
            "all-on tool specs total {all_on} chars (budget 41_000) — the registry is re-bloating; trim descriptions/schemas or raise the budget deliberately"
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
        // strips them like search_docs' sidecar gate does).
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
}
