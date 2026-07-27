//! Wire-format spec builders: render the tool registry into the OpenAI
//! `tools` array ([`openai_tool_specs`]) and the Anthropic `tools` array
//! ([`anthropic_tool_specs`]). The same registry renders into both formats;
//! [`execute_tool`] in `mod.rs` dispatches by name. Read-only filesystem
//! tools are always present; mutating ones are stripped under `read_only`
//! (schema-level exclusion — the model cannot invoke them); `run_code` is
//! gated behind the `code_exec` capability.

use super::super::permission;
use super::*;

pub fn openai_tool_specs(caps: &ToolCaps, mode: permission::PermissionMode) -> Vec<Value> {
    let mut specs: Vec<Value> = vec![];
    if caps.web_search {
        specs.push(openai_fn(WEB_SEARCH, WEB_SEARCH_DESC, web_search_parameters()));
    }
    specs.extend(vec![
        openai_fn(GENERATE_FILE, GENERATE_FILE_DESC, generate_file_parameters()),
        openai_fn(
            GENERATE_DOCUMENT,
            GENERATE_DOCUMENT_DESC,
            generate_document_parameters(),
        ),
        openai_fn(GENERATE_DIAGRAM, GENERATE_DIAGRAM_DESC, generate_diagram_parameters()),
        openai_fn(FETCH_URL, FETCH_URL_DESC, fetch_url_parameters()),
        openai_fn(OPEN_URL, OPEN_URL_DESC, fetch_url_parameters()),
        openai_fn(BROWSER_READ, BROWSER_READ_DESC, browser_read_parameters()),
        openai_fn(BROWSER_CLICK, BROWSER_CLICK_DESC, browser_ref_parameters()),
        openai_fn(BROWSER_TYPE, BROWSER_TYPE_DESC, browser_type_parameters()),
        openai_fn(BROWSER_SCROLL, BROWSER_SCROLL_DESC, browser_scroll_parameters()),
        // Research source ledger — always on (state tools, not gated by permission mode).
        openai_fn(ADD_SOURCE_NOTE, ADD_SOURCE_NOTE_DESC, add_source_note_parameters()),
        openai_fn(GET_SOURCE_LEDGER, GET_SOURCE_LEDGER_DESC, no_parameters()),
        openai_fn(RESET_SOURCE_LEDGER, RESET_SOURCE_LEDGER_DESC, no_parameters()),
        // Read-only filesystem tools — present in every mode.
        openai_fn(LIST_DIRECTORY, LIST_DIRECTORY_DESC, list_directory_parameters()),
        openai_fn(READ_FILE, READ_FILE_DESC, read_file_parameters()),
        openai_fn(SEARCH_FILES, SEARCH_FILES_DESC, search_files_parameters()),
    ]);
    // Mutating filesystem tools — stripped from the schema under read_only.
    if mode != permission::PermissionMode::ReadOnly {
        specs.push(openai_fn(WRITE_FILE, WRITE_FILE_DESC, path_content_parameters()));
        specs.push(openai_fn(EDIT_FILE, EDIT_FILE_DESC, edit_file_parameters()));
        specs.push(openai_fn(DELETE_FILE, DELETE_FILE_DESC, path_parameters()));
        specs.push(openai_fn(MOVE_FILE, MOVE_FILE_DESC, src_dest_parameters()));
        specs.push(openai_fn(COPY_FILE, COPY_FILE_DESC, src_dest_parameters()));
    }
    if caps.code_exec {
        specs.push(openai_fn(RUN_CODE, RUN_CODE_DESC, run_code_parameters()));
    }
    // Connector-originated remote tools (one entry per tool per attached
    // connector). Their schemas come from the vendor's MCP `tools/list`; since
    // we don't store the full input schema per turn, we advertise a permissive
    // object schema and let the server validate. Write-kind tools get an
    // approval note in the description so the model knows each will be gated.
    append_connector_tools_openai(&caps.attached_connectors, &mut specs);
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

/// Anthropic `tools` array (`{name, description, input_schema}` entries).
/// Same read-only filtering as [`openai_tool_specs`].
pub fn anthropic_tool_specs(caps: &ToolCaps, mode: permission::PermissionMode) -> Vec<Value> {
    let mut specs: Vec<Value> = vec![];
    if caps.web_search {
        specs.push(anthropic_fn(WEB_SEARCH, WEB_SEARCH_DESC, web_search_parameters()));
    }
    specs.extend(vec![
        anthropic_fn(GENERATE_FILE, GENERATE_FILE_DESC, generate_file_parameters()),
        anthropic_fn(
            GENERATE_DOCUMENT,
            GENERATE_DOCUMENT_DESC,
            generate_document_parameters(),
        ),
        anthropic_fn(GENERATE_DIAGRAM, GENERATE_DIAGRAM_DESC, generate_diagram_parameters()),
        anthropic_fn(FETCH_URL, FETCH_URL_DESC, fetch_url_parameters()),
        anthropic_fn(OPEN_URL, OPEN_URL_DESC, fetch_url_parameters()),
        anthropic_fn(BROWSER_READ, BROWSER_READ_DESC, browser_read_parameters()),
        anthropic_fn(BROWSER_CLICK, BROWSER_CLICK_DESC, browser_ref_parameters()),
        anthropic_fn(BROWSER_TYPE, BROWSER_TYPE_DESC, browser_type_parameters()),
        anthropic_fn(BROWSER_SCROLL, BROWSER_SCROLL_DESC, browser_scroll_parameters()),
        // Research source ledger — always on (state tools, not gated by permission mode).
        anthropic_fn(ADD_SOURCE_NOTE, ADD_SOURCE_NOTE_DESC, add_source_note_parameters()),
        anthropic_fn(GET_SOURCE_LEDGER, GET_SOURCE_LEDGER_DESC, no_parameters()),
        anthropic_fn(RESET_SOURCE_LEDGER, RESET_SOURCE_LEDGER_DESC, no_parameters()),
        anthropic_fn(LIST_DIRECTORY, LIST_DIRECTORY_DESC, list_directory_parameters()),
        anthropic_fn(READ_FILE, READ_FILE_DESC, read_file_parameters()),
        anthropic_fn(SEARCH_FILES, SEARCH_FILES_DESC, search_files_parameters()),
    ]);
    if mode != permission::PermissionMode::ReadOnly {
        specs.push(anthropic_fn(WRITE_FILE, WRITE_FILE_DESC, path_content_parameters()));
        specs.push(anthropic_fn(EDIT_FILE, EDIT_FILE_DESC, edit_file_parameters()));
        specs.push(anthropic_fn(DELETE_FILE, DELETE_FILE_DESC, path_parameters()));
        specs.push(anthropic_fn(MOVE_FILE, MOVE_FILE_DESC, src_dest_parameters()));
        specs.push(anthropic_fn(COPY_FILE, COPY_FILE_DESC, src_dest_parameters()));
    }
    if caps.code_exec {
        specs.push(anthropic_fn(RUN_CODE, RUN_CODE_DESC, run_code_parameters()));
    }
    append_connector_tools_anthropic(&caps.attached_connectors, &mut specs);
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
                "description": "The file format: a document format (pdf, docx, \
                    pptx, xlsx, csv, md, txt, html, json) OR a source-code \
                    language so the file gets the right extension (python, \
                    javascript, typescript, jsx, tsx, java, c, cpp, csharp, go, \
                    rust, ruby, php, swift, kotlin, sql, bash, yaml, css, …).",
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
            "code": {
                "type": "string",
                "description": "Complete Python source that builds the document \
                    and saves it to the CONDUIT_OUTPUT path. For docx/pptx \
                    prefer `import conduit_docgen as cd` (pre-installed styled \
                    toolkit); otherwise use python-docx / python-pptx / openpyxl \
                    / reportlab directly. Produce a polished, themed result with \
                    real content — not a plain text dump.",
            }
        },
        "required": ["format", "filename", "code"],
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

fn browser_read_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["full", "summary_only", "section"],
                "default": "full",
                "description": "Extraction mode: 'full' for complete cleaned article \
                    (default), 'summary_only' for just headings + first ~1500 chars of \
                    body (lightweight, for context-budget triage), 'section' to extract \
                    only content under a given CSS selector or heading text."
            },
            "selector": {
                "type": "string",
                "description": "CSS selector or heading text (case-insensitive contains \
                    match). Only used when mode='section'. If it looks like a CSS selector \
                    (#id, .class, > child), the first matching element's subtree is \
                    extracted; otherwise the first heading whose text contains it is \
                    located and content is extracted from there to the next same-or-higher \
                    level heading."
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
                "description": "The source page's URL (take from the browser_read/fetch_url result; prefer canonicalUrl when cleaner)."
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
                "description": "Set this to the browser_read failureReason when the source could not be read; omit when usable."
            }
        },
        "required": ["url", "title", "fact", "excerpt"]
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
                "description": "The exact substring to replace (first occurrence).",
            },
            "replace": {
                "type": "string",
                "description": "The replacement text.",
            },
            "append": {
                "type": "string",
                "description": "If set, append this text to the end of the file instead of find/replace.",
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


// ---- Connector remote-tool schema merge ----
//
// The vendor's MCP server defines its own tools (e.g. Notion's search/create-
// page tools); Conduit does NOT hardcode them. At turn start each attached
// connector's `tools/list` is fetched and classified (Read/Write) in
// `connectors::session`. Here we advertise those tools to the model with a
// permissive object schema (the server validates the real args) and tag the
// Write-kind tools' descriptions with an approval note so the model knows each
// mutating call will be gated.

fn connector_tool_description(att: &crate::connectors::AttachedConnector, name: &str) -> String {
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
        format!("{header}{base}")
    }
}

fn permissive_params() -> Value {
    // Permissive object schema: the server validates the real argument shape.
    json!({ "type": "object", "additionalProperties": true })
}

fn append_connector_tools_openai(
    attached: &[crate::connectors::AttachedConnector],
    specs: &mut Vec<Value>,
) {
    for att in attached {
        for name in att.tools.keys() {
            let description = connector_tool_description(att, name);
            specs.push(openai_fn(name, &description, permissive_params()));
        }
    }
}

fn append_connector_tools_anthropic(
    attached: &[crate::connectors::AttachedConnector],
    specs: &mut Vec<Value>,
) {
    for att in attached {
        for name in att.tools.keys() {
            let description = connector_tool_description(att, name);
            specs.push(anthropic_fn(name, &description, permissive_params()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(params.get("required").is_none() || params["required"].as_array().map(|a| a.is_empty()).unwrap_or(true));
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
        let enums: Vec<&str> = unavail["enum"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(enums, vec!["paywalled", "login_required", "extraction_failed", "blocked"]);
    }
}
