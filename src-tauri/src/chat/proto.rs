//! Wire-protocol helpers between the model and the tool loop.
//!
//! Two concerns live here:
//! - **Tool-call parsing**: recovering tool calls from both the OpenAI
//!   `choices[0].message.tool_calls` shape and the Hermes `<tool_calls>` XML
//!   fallback that some OpenAI-compatible aggregators emit as plain text in
//!   `content`. Includes the `<tool>{json}</tool>` display marker the UI
//!   renders as a collapsible card.
//! - **Message serialization**: turning a stored [`ChatMessage`] into the
//!   OpenAI or Anthropic message JSON shape, including multimodal (vision)
//!   content arrays.

use serde_json::{json, Value};

use crate::chat::tools;
use super::providers::ChatMessage;

/// Monotonic synthetic id for tool calls we fabricate (Hermes fallback or
/// fenced-block recovery). OpenAI expects every tool call to carry an `id`;
/// these are never user-visible but must be unique within a turn.
pub(crate) fn next_synthetic_tool_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("call_synth_{n}")
}

/// Parse the `arguments` string of an OpenAI-style tool call into a JSON
/// object. Some providers emit malformed payloads — e.g. a stray empty object
/// prepended (`"{}{\"query\":\"x\"}"`) or several concatenated objects. We read
/// every JSON value in the string and merge object fields (later keys win) so a
/// leading `{}` no longer wipes out the real arguments.
pub(crate) fn parse_tool_args(s: &str) -> Value {
    let s = s.trim();
    if s.is_empty() {
        return json!({});
    }
    // Fast path: a single well-formed object.
    if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(s) {
        return v;
    }
    let mut merged = serde_json::Map::new();
    let stream = serde_json::Deserializer::from_str(s).into_iter::<Value>();
    for item in stream {
        if let Ok(Value::Object(map)) = item {
            for (k, v) in map {
                merged.insert(k, v);
            }
        }
    }
    Value::Object(merged)
}

/// Some OpenAI-compatible servers (and several Qwen / DeepSeek / MiMo
/// fine-tunes served through `ai2.18.show`-style aggregators) do not translate
/// the OpenAI `tools` field into the model's native tool template. Instead of
/// populating `choices[0].message.tool_calls`, the model emits its trained
/// **Hermes-format** tool call as plain text inside `content`:
///
/// ```text
/// <tool_calls>
/// <invoke name="web_search">
/// <parameter name="query" type="string">cow</parameter>
/// </invoke>
/// </tool_calls>
/// ```
///
/// This parser recovers those calls so the existing tool loop can execute
/// them. It returns the list of `(tool_name, arguments)` pairs found, or
/// `None` when the content carries no recognizable tool block. The sibling
/// [`strip_hermes_tool_calls`] removes the raw markup so the user never sees
/// the XML in the rendered message.
pub(crate) fn parse_hermes_tool_calls(content: &str) -> Option<Vec<(String, Value)>> {
    // Locate the outer block. Tolerate models that omit the closing tag by
    // parsing from `<tool_calls>` to end-of-string.
    let start_idx = content.find("<tool_calls>")?;
    let after_open = &content[start_idx + "<tool_calls>".len()..];
    let block = match after_open.find("</tool_calls>") {
        Some(end) => &after_open[..end],
        None => after_open,
    };
    if block.trim().is_empty() {
        return None;
    }

    // The known shape is a series of `<invoke name="…">…</invoke>` regions,
    // each holding `<parameter name="…" [type="…"]>value</parameter>` entries.
    let mut calls: Vec<(String, Value)> = Vec::new();
    let mut rest = block;
    while let Some(inv) = rest.find("<invoke") {
        rest = &rest[inv + "<invoke".len()..];
        let body_end = rest.find("</invoke>").unwrap_or(rest.len());
        let tag_and_body = &rest[..body_end];
        rest = &rest[body_end..];

        // The opening `<invoke …>` tag runs up to the first `>`; the invoke
        // name lives in that slice (not in the parameter body that follows).
        let invoke_open = match tag_and_body.find('>') {
            Some(g) => &tag_and_body[..g],
            None => "",
        };
        let name = extract_quoted_attr(invoke_open, "name").unwrap_or_default();
        // The body starts after the opening `<invoke …>` tag's closing `>`.
        let body = match tag_and_body.find('>') {
            Some(g) => &tag_and_body[g + 1..],
            None => "",
        };

        let mut args = serde_json::Map::new();
        let mut pbody = body;
        while let Some(p) = pbody.find("<parameter") {
            pbody = &pbody[p + "<parameter".len()..];
            let tag_end = match pbody.find('>') {
                Some(g) => g + 1,
                None => break,
            };
            let opening = &pbody[..tag_end - 1]; // text before the closing `>`
            let pname = extract_quoted_attr(opening, "name").unwrap_or_default();
            let val_end = pbody[tag_end..]
                .find("</parameter>")
                .map(|e| tag_end + e)
                .unwrap_or(pbody.len());
            let raw = pbody[tag_end..val_end].trim();
            if !pname.is_empty() {
                args.insert(pname.to_string(), coerce_param_value(raw));
            }
            pbody = &pbody[val_end..];
        }

        if !name.is_empty() {
            calls.push((name, Value::Object(args)));
        }
    }

    if calls.is_empty() {
        None
    } else {
        Some(calls)
    }
}

/// Extract the value of a `name="value"` (or `'value'`) attribute from the
/// opening tag text. Returns the unquoted value, or `None` if the attribute
/// isn't present.
fn extract_quoted_attr(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=");
    let at = tag.find(&needle)?;
    let after = tag[at + needle.len()..].trim_start();
    let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = &after[quote.len_utf8()..];
    let end = inner.find(quote)?;
    Some(inner[..end].to_string())
}

/// Remove every `<tool_calls>…</tool_calls>` region (and the alternative
/// ` ```tool_call … ``` ` / ` ```tool_calls … ``` ` fenced variant) from a
/// message so the raw markup is never shown to the user or re-sent as history.
/// A dangling `<tool_calls>` with no close (the model kept streaming) is also
/// trimmed from that point onward.
pub(crate) fn strip_hermes_tool_calls(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("<tool_calls>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</tool_calls>") {
            Some(end) => rest = &rest[start + end + "</tool_calls>".len()..],
            None => {
                // Unclosed block — drop the trailing remainder.
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Coerce a raw parameter string (the text between `<parameter>…</parameter>`)
/// into a JSON value. Bare scalars that parse as bool/int/float/null are typed
/// accordingly; JSON-looking values are parsed; everything else stays a string.
fn coerce_param_value(raw: &str) -> Value {
    let s = raw.trim();
    if s.is_empty() {
        return Value::Null;
    }
    match s {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" => return Value::Null,
        _ => {}
    }
    if let Ok(n) = s.parse::<i64>() {
        return Value::from(n);
    }
    if let Ok(f) = s.parse::<f64>() {
        return json!(f);
    }
    if s.starts_with('{') || s.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            return v;
        }
    }
    Value::String(s.to_string())
}

/// Structured narration of a tool call, emitted as a `<tool>{json}</tool>`
/// marker so the UI can render each step as its own collapsible card (tool
/// calling, writing a script, etc.). `json` carries a `kind` (drives the icon),
/// a `title`, an optional one-line `detail`, and — for code-producing tools —
/// the `code`/`lang` so the user can expand and read what was written.
///
/// `<tool>` blocks are display-only and stripped from re-sent history exactly
/// like `<think>` blocks.
pub(crate) fn tool_block(name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    // A tool's own output must never contain the structural tags or it would
    // corrupt the block on the client: a literal `</tool>` truncates it, and
    // a literal `<tool>`/`<think>` opener prematurely starts a new segment
    // in the frontend's parser (e.g. a write_file of an HTML file that uses
    // a custom `<tool>` element). Neutralize both directions defensively.
    let sanitize = |mut v: String| {
        v = v.replace("</tool>", "<\\/tool>");
        v = v.replace("<tool>", "<\\tool>");
        v = v.replace("<think>", "<\\think>");
        v
    };

    let meta: Value = if name == tools::WEB_SEARCH {
        json!({ "kind": "search", "title": "Searching the web", "detail": s("query") })
    } else if name == tools::GENERATE_FILE {
        json!({
            "kind": "file",
            "title": format!("Generating {} file \"{}\"", s("format"), s("filename")),
            "lang": s("format"),
            "code": sanitize(s("content")),
        })
    } else if name == tools::GENERATE_DOCUMENT {
        json!({
            "kind": "code",
            "title": format!("Building {} document \"{}\"", s("format"), s("filename")),
            "lang": "python",
            "code": sanitize(s("code")),
        })
    } else if name == tools::GENERATE_DIAGRAM {
        json!({
            "kind": "code",
            "title": format!("Designing diagram \"{}\"", s("filename")),
            "lang": "html",
            "code": sanitize(s("html")),
        })
    } else if name == tools::FETCH_URL || name == tools::OPEN_URL {
        let verb = if name == tools::OPEN_URL { "Opening" } else { "Reading" };
        json!({ "kind": "web", "title": format!("{verb} a web page"), "detail": s("url") })
    } else if name == tools::GET_SKILL {
        json!({ "kind": "tool", "title": "Loading skill", "detail": format!("/{}", s("slug")) })
    } else if name == tools::WRITE_FILE || name == tools::EDIT_FILE {
        // File edits get a rich payload so the UI can render an inline diff
        // review card (filename, +/− stats, hunks, Accept/Reject) instead of
        // a generic "Running tool …" step. The model's args carry the old/new
        // content directly (find/replace for edit_file, full content for
        // write_file), so hunks are computed client-side — no disk read-back.
        let edit = if name == tools::WRITE_FILE {
            json!({ "mode": "write", "content": sanitize(s("content")) })
        } else if let Some(append) = args.get("append").and_then(|v| v.as_str()) {
            json!({ "mode": "append", "append": sanitize(append.to_string()) })
        } else {
            json!({
                "mode": "replace",
                "find": sanitize(s("find")),
                "replace": sanitize(s("replace")),
            })
        };
        let verb = if name == tools::WRITE_FILE { "Writing" } else { "Editing" };
        json!({
            "kind": "edit",
            "title": format!("{verb} file \"{}\"", s("path")),
            "detail": s("path"),
            "path": s("path"),
            "edit": edit,
        })
    } else if name == tools::RUN_CODE {
        let lang = args
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("code")
            .to_string();
        json!({
            "kind": "code",
            "title": format!("Running {lang} code"),
            "lang": lang,
            "code": sanitize(s("code")),
        })
    } else if name == tools::RUN_SHELL {
        json!({
            "kind": "code",
            "title": "Running shell command",
            "lang": "bash",
            "code": sanitize(s("command")),
        })
    } else if name == tools::BROWSER_READ {
        json!({ "kind": "browser", "title": "Reading the browser page" })
    } else if name == tools::BROWSER_CLICK {
        let r = args.get("ref").and_then(|v| v.as_i64()).unwrap_or(-1);
        json!({ "kind": "browser", "title": format!("Clicking element [{r}] in the browser") })
    } else if name == tools::BROWSER_TYPE {
        json!({ "kind": "browser", "title": "Typing in the browser", "detail": s("text") })
    } else if name == tools::BROWSER_SCROLL {
        json!({ "kind": "browser", "title": "Scrolling the browser page" })
    } else if name == tools::ADD_SOURCE_NOTE {
        json!({ "kind": "tool", "title": "Recording a source note", "detail": s("url") })
    } else if name == tools::GET_SOURCE_LEDGER {
        json!({ "kind": "tool", "title": "Reading the source ledger" })
    } else if name == tools::RESET_SOURCE_LEDGER {
        json!({ "kind": "tool", "title": "Resetting the source ledger" })
    } else if name == tools::TASK {
        // Subagent chip: the frontend renders this as the same "SubAgent
        // <role> · <task>" chip the git sidebar uses (shine while running,
        // click opens the Agents pane).
        let role = if s("subagent_type").is_empty() { "agent".to_string() } else { s("subagent_type") };
        json!({
            "kind": "subagent",
            "title": "SubAgent",
            "role": role,
            "task": s("description"),
            "prompt": sanitize(s("prompt")),
        })
    } else {
        json!({ "kind": "tool", "title": format!("Running tool {name}") })
    };

    format!("<tool>{meta}</tool>")
}

/// Build an OpenAI-style message object, using a multimodal `content` array
/// when the message carries images (vision), otherwise a plain string.
pub(crate) fn openai_message_json(m: &ChatMessage) -> Value {
    if m.images.is_empty() {
        return json!({ "role": m.role, "content": m.content });
    }
    let mut parts: Vec<Value> = Vec::new();
    if !m.content.is_empty() {
        parts.push(json!({ "type": "text", "text": m.content }));
    }
    for img in &m.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.media_type, img.data) }
        }));
    }
    json!({ "role": m.role, "content": parts })
}

/// Build an Anthropic-style message object, using a content-block array with
/// `image` blocks when the message carries images, otherwise a plain string.
pub(crate) fn anthropic_message_json(m: &ChatMessage) -> Value {
    if m.images.is_empty() {
        return json!({ "role": m.role, "content": m.content });
    }
    let mut blocks: Vec<Value> = Vec::new();
    if !m.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": m.content }));
    }
    for img in &m.images {
        blocks.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.media_type,
                "data": img.data,
            }
        }));
    }
    json!({ "role": m.role, "content": blocks })
}
