//! Direct Google REST API fallback tools for the Workspace connectors.
//!
//! Same story as `gmail_api`: Google's hosted MCP servers
//! (`drivemcp.googleapis.com/mcp/v1`, `docsmcp…`, …) accept `initialize` and
//! `tools/list`, but every `tools/call` returns `The caller does not have
//! permission` until the project is fully enrolled in the Workspace MCP
//! Developer Preview. While that gate is in effect, the chat talks to the
//! **base Google REST APIs** instead — the same family OAuth token authorizes
//! them fine (each connector's scopes cover its REST surface, and the family
//! flow stores the token under every member).
//!
//! The fallback surface is registered per-attach as `gdrive_*`, `gdocs_*`,
//! `gsheets_*`, `gslides_*`, `gcalendar_*`, `gchat_*`, `gpeople_*` tools (see
//! `session.rs`) with an EXPLICIT kind: reads auto-run under every permission
//! mode, writes route through the standard approval-card gate via
//! `dispatch::run_gated_connector_tool`.

use tauri::AppHandle;

use crate::chat::permission::ConnectorToolKind;
use crate::connectors::gmail_api::FallbackTool;
use crate::connectors::oauth::ensure_valid_access_token;

/// The fallback tool definitions for a connector, or `None` if the connector
/// has no REST fallback surface (e.g. gmail — see `gmail_api`).
pub fn fallback_tool_defs(connector_id: &str) -> Option<&'static [FallbackTool]> {
    match connector_id {
        "gdrive" => Some(GDRIVE_TOOLS),
        "gdocs" => Some(GDOCS_TOOLS),
        "gsheets" => Some(GSHEETS_TOOLS),
        "gslides" => Some(GSLIDES_TOOLS),
        "gcalendar" => Some(GCALENDAR_TOOLS),
        "gchat" => Some(GCHAT_TOOLS),
        "gpeople" => Some(GPEOPLE_TOOLS),
        _ => None,
    }
}

/// Drive (REST base `https://www.googleapis.com/drive/v3`).
static GDRIVE_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gdrive_search_files",
        description: "Search the user's Google Drive (Drive REST fallback — used while the \
         official Drive MCP tools are unavailable). Args: query (optional Drive search syntax, \
         e.g. \"name contains 'Report'\" or \"mimeType='application/pdf'\"; empty lists recent \
         files), page_size (optional, 1-100, default 20). Returns id, name, mimeType, \
         modifiedTime, size.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gdrive_get_file_metadata",
        description: "Fetch metadata for one Google Drive file by file_id (Drive REST fallback). \
         Returns id, name, mimeType, size, parents, webViewLink, createdTime, modifiedTime.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gdrive_read_file_content",
        description: "Read the text content of a Google Drive file by file_id (Drive REST \
         fallback). Google Docs/Sheets/Slides files are exported as text; other files return \
         their raw bytes as text if possible. Args: file_id (required).",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gdrive_create_file",
        description: "Create a new file in the user's Google Drive (Drive REST). This tool \
         works. Args: name (required), content (optional text content), parent_id (optional \
         folder id; empty = root), mime_type (optional, e.g. \"text/plain\", \
         \"application/pdf\"; defaults to text/plain). Returns the new file's id, name, \
         webViewLink.",
        kind: ConnectorToolKind::Write,
    },
];

/// Docs (REST base `https://docs.googleapis.com/v1/documents`).
static GDOCS_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gdocs_read_doc",
        description: "Read a Google Docs document by document_id (Docs REST fallback). \
         Returns the document title and its full plaintext body.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gdocs_update_doc",
        description: "Replace the entire body text of a Google Docs document (Docs REST). This \
         tool works. Args: document_id (required), text (required — the new body content). \
         Returns the document title and resulting text.",
        kind: ConnectorToolKind::Write,
    },
];

/// Sheets (REST base `https://sheets.googleapis.com/v4/spreadsheets`).
static GSHEETS_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gsheets_get_spreadsheet",
        description: "Get the structure of a Google Sheets spreadsheet (Sheets REST fallback). \
         Args: spreadsheet_id (required). Returns the title and every sheet tab with its \
         row/column counts.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gsheets_get_values",
        description: "Read cell values from a Google Sheets spreadsheet (Sheets REST fallback). \
         Args: spreadsheet_id (required), range (required, A1 notation, e.g. \"Sheet1!A1:D10\"), \
         major_dimension (optional: ROWS | COLUMNS, default ROWS). Returns the values as a \
         2D array.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gsheets_update_values",
        description: "Overwrite cell values in a Google Sheets spreadsheet (Sheets REST). This \
         tool works. Args: spreadsheet_id (required), range (required, A1 notation), values \
         (required, 2D array of strings/numbers, e.g. [[\"A1\",\"B1\"],[\"A2\",\"B2\"]]). \
         Returns the updated range.",
        kind: ConnectorToolKind::Write,
    },
    FallbackTool {
        name: "gsheets_append_values",
        description: "Append rows to a Google Sheets spreadsheet (Sheets REST). This tool works. \
         Args: spreadsheet_id (required), range (required — the tab, e.g. \"Sheet1\" or \
         \"Sheet1!A1\"), values (required, 2D array of strings/numbers). Returns the appended \
         range.",
        kind: ConnectorToolKind::Write,
    },
    FallbackTool {
        name: "gsheets_create_spreadsheet",
        description: "Create a new Google Sheets spreadsheet (Sheets REST). This tool works. \
         Args: title (required). Returns the new spreadsheet_id and url.",
        kind: ConnectorToolKind::Write,
    },
];

/// Slides (REST base `https://slides.googleapis.com/v1/presentations`).
static GSLIDES_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gslides_read_presentation",
        description: "Read a Google Slides presentation by presentation_id (Slides REST \
         fallback). Returns the title and the text of every slide.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gslides_replace_all_text",
        description: "Replace every occurrence of a text snippet in a Google Slides \
         presentation (Slides REST). This tool works. Args: presentation_id (required), find \
         (required — the exact text to replace), replace (required — the replacement text). \
         Returns the number of replaced occurrences.",
        kind: ConnectorToolKind::Write,
    },
];

/// Calendar (REST base `https://www.googleapis.com/calendar/v3`).
static GCALENDAR_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gcalendar_list_events",
        description: "List upcoming events on the user's Google Calendar (Calendar REST \
         fallback). Args: calendar_id (optional, default \"primary\"), max_results (optional, \
         1-100, default 20), time_min (optional ISO-8601, e.g. \"2026-08-01T00:00:00Z\"; \
         default = now). Returns id, summary, start, end, attendees.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gcalendar_get_event",
        description: "Fetch a single Google Calendar event by event_id (Calendar REST fallback). \
         Args: event_id (required), calendar_id (optional, default \"primary\").",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gcalendar_list_calendars",
        description: "List the user's Google Calendars (Calendar REST fallback). No args. \
         Returns each calendar's id, summary and access role.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gcalendar_create_event",
        description: "Create a new event on the user's Google Calendar (Calendar REST). This \
         tool works. Args: summary (required), start (required, ISO-8601, e.g. \
         \"2026-08-10T14:00:00\"), end (required, ISO-8601), description (optional), \
         attendees (optional, array of email addresses), calendar_id (optional, default \
         \"primary\"). Returns the created event id, summary, start, end, hangoutLink.",
        kind: ConnectorToolKind::Write,
    },
    FallbackTool {
        name: "gcalendar_delete_event",
        description: "Delete a Google Calendar event (Calendar REST). This tool works. Args: \
         event_id (required), calendar_id (optional, default \"primary\"). Returns a \
         confirmation.",
        kind: ConnectorToolKind::Write,
    },
];

/// Chat (REST base `https://chat.googleapis.com/v1`).
static GCHAT_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gchat_list_spaces",
        description: "List the user's Google Chat spaces (Chat REST fallback). Args: page_size \
         (optional, 1-100, default 20). Returns each space's id, display name, type.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gchat_list_messages",
        description: "List recent messages in a Google Chat space (Chat REST fallback). Args: \
         space (required, e.g. \"spaces/AAAAxxxx\"), page_size (optional, 1-50, default 20). \
         Returns sender, text, createTime per message.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gchat_send_message",
        description: "Send a text message to a Google Chat space (Chat REST). This tool works. \
         Args: space (required, e.g. \"spaces/AAAAxxxx\"), text (required). Returns the created \
         message id.",
        kind: ConnectorToolKind::Write,
    },
];

/// People (REST base `https://people.googleapis.com/v1`).
static GPEOPLE_TOOLS: &[FallbackTool] = &[
    FallbackTool {
        name: "gpeople_get_user_profile",
        description: "Fetch the user's own Google profile (People REST fallback). No args. \
         Returns name, email addresses, photos.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gpeople_search_contacts",
        description: "Search the user's Google contacts (People REST fallback). Args: query \
         (required, name or email fragment), page_size (optional, 1-30, default 10). Returns \
         matching names, emails, phone numbers.",
        kind: ConnectorToolKind::Read,
    },
    FallbackTool {
        name: "gpeople_search_directory_people",
        description: "Search the organization directory (People REST fallback, Google \
         Workspace accounts only). Args: query (required, name or email fragment), page_size \
         (optional, 1-30, default 10). Returns matching names and emails.",
        kind: ConnectorToolKind::Read,
    },
];

/// Run a fallback tool by name for a Google Workspace connector. Loads (and
/// refreshes if expired) the connector's access token, calls the product's
/// REST API, and returns the response as text for the model. Write tools are
/// called ONLY after the dispatcher's approval gate has already cleared them.
pub async fn call_tool(
    app: &AppHandle,
    connector_id: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let token = ensure_valid_access_token(app, connector_id).await?;
    let http = reqwest::Client::new();
    match connector_id {
        "gdrive" => drive_call(&http, &token, name, args).await,
        "gdocs" => docs_call(&http, &token, name, args).await,
        "gsheets" => sheets_call(&http, &token, name, args).await,
        "gslides" => slides_call(&http, &token, name, args).await,
        "gcalendar" => calendar_call(&http, &token, name, args).await,
        "gchat" => chat_call(&http, &token, name, args).await,
        "gpeople" => people_call(&http, &token, name, args).await,
        other => Err(format!("unknown Google REST connector `{other}`")),
    }
}

// ---- HTTP helpers ----

async fn get_json(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    product: &str,
    op: &str,
) -> Result<serde_json::Value, String> {
    let resp = http
        .get(url)
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("{product} {op} failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{product} {op} HTTP {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("{product} {op} response not JSON: {e}"))
}

async fn post_json(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    payload: &serde_json::Value,
    product: &str,
    op: &str,
) -> Result<serde_json::Value, String> {
    let resp = http
        .post(url)
        .bearer_auth(token)
        .json(payload)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("{product} {op} failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{product} {op} HTTP {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("{product} {op} response not JSON: {e}"))
}

async fn put_json(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    payload: &serde_json::Value,
    product: &str,
    op: &str,
) -> Result<serde_json::Value, String> {
    let resp = http
        .put(url)
        .bearer_auth(token)
        .json(payload)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("{product} {op} failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{product} {op} HTTP {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("{product} {op} response not JSON: {e}"))
}

async fn delete_req(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    product: &str,
    op: &str,
) -> Result<String, String> {
    let resp = http
        .delete(url)
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("{product} {op} failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{product} {op} HTTP {status}: {body}"));
    }
    Ok("deleted".to_string())
}

fn str_arg<'a>(args: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

fn num_arg(args: &serde_json::Value, key: &str, default: i64, max: i64, min: i64) -> i64 {
    args.get(key)
        .and_then(|v| v.as_i64())
        .unwrap_or(default)
        .clamp(min, max)
}

// ---- Drive ----

async fn drive_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://www.googleapis.com/drive/v3";
    match name {
        "gdrive_search_files" => {
            let q = str_arg(args, "query").unwrap_or("");
            let page = num_arg(args, "page_size", 20, 100, 1);
            let url = format!(
                "{BASE}/files?pageSize={page}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken"
            );
            let url = if q.is_empty() {
                url
            } else {
                format!("{url}&q={}", urlencoding::encode(q))
            };
            let json = get_json(http, &url, token, "drive", "search").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gdrive_get_file_metadata" => {
            let file_id = str_arg(args, "file_id")
                .ok_or_else(|| "gdrive_get_file_metadata: missing `file_id` argument".to_string())?;
            let url = format!(
                "{BASE}/files/{}?fields=id,name,mimeType,size,parents,webViewLink,createdTime,modifiedTime",
                urlencoding::encode(file_id)
            );
            let json = get_json(http, &url, token, "drive", "get_file_metadata").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gdrive_read_file_content" => {
            let file_id = str_arg(args, "file_id")
                .ok_or_else(|| "gdrive_read_file_content: missing `file_id` argument".to_string())?;
            let meta = get_json(
                http,
                &format!("{BASE}/files/{}?fields=mimeType,name", urlencoding::encode(file_id)),
                token,
                "drive",
                "get_file_metadata",
            )
            .await?;
            let mime = meta.get("mimeType").and_then(|v| v.as_str()).unwrap_or("");
            let export = match mime {
                "application/vnd.google-apps.document" => Some("text/plain"),
                "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
                "application/vnd.google-apps.slides" => Some("text/plain"),
                _ => None,
            };
            let url = if let Some(m) = export {
                format!(
                    "{BASE}/files/{}/export?mimeType={}",
                    urlencoding::encode(file_id),
                    urlencoding::encode(m)
                )
            } else {
                format!("{BASE}/files/{}?alt=media", urlencoding::encode(file_id))
            };
            let resp = http
                .get(&url)
                .bearer_auth(token)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| format!("drive read_file_content failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("drive read_file_content HTTP {status}: {body}"));
            }
            if export.is_none() && !body.is_ascii() && !body.is_empty() {
                return Ok("[binary file content — not displayed]".to_string());
            }
            Ok(body)
        }
        "gdrive_create_file" => {
            let name_arg = str_arg(args, "name")
                .ok_or_else(|| "gdrive_create_file: missing `name` argument".to_string())?;
            let content = str_arg(args, "content").unwrap_or("").to_string();
            let parent = str_arg(args, "parent_id");
            let mime = str_arg(args, "mime_type").unwrap_or("text/plain");
            let meta = serde_json::json!({
                "name": name_arg,
                "mimeType": mime,
                "parents": parent.map(|p| vec![p]).unwrap_or_default(),
            });
            let form = reqwest::multipart::Form::new()
                .part(
                    "metadata",
                    reqwest::multipart::Part::text(meta.to_string())
                        .mime_str("application/json")
                        .map_err(|e| e.to_string())?,
                )
                .part(
                    "file",
                    reqwest::multipart::Part::bytes(content.into_bytes()).file_name(name_arg.to_string()),
                );
            let resp = http
                .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
                .bearer_auth(token)
                .multipart(form)
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|e| format!("drive create_file failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("drive create_file HTTP {status}: {body}"));
            }
            let json: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("drive create_file response not JSON: {e}"))?;
            let id = json.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let link = json
                .get("webViewLink")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "id": id,
                "name": name_arg,
                "webViewLink": link,
            }))
            .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown drive fallback tool `{other}`")),
    }
}

// ---- Docs ----

/// Extract plaintext from a Docs `body.content` array.
fn doc_to_text(body: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(items) = body.get("content").and_then(|c| c.as_array()) {
        for item in items {
            if let Some(para) = item.get("paragraph") {
                if let Some(elems) = para.get("elements").and_then(|e| e.as_array()) {
                    for el in elems {
                        if let Some(t) = el
                            .get("textRun")
                            .and_then(|t| t.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            out.push_str(t);
                        }
                    }
                }
                out.push('\n');
            }
        }
    }
    out
}

/// Build the batchUpdate requests for replace-whole-document: delete all
/// existing content EXCEPT the body's mandatory final newline, then insert
/// the new text at index 1. A Docs document always ends with a structural
/// "\n" at [end-1, end), and a deleteContentRange that includes it is
/// rejected by batchUpdate with a generic 400 — so the delete stops one
/// short (M18). `end > 2` guards so the delete range [1, end-1) is
/// non-empty (a doc holding only the newline has end == 2 → nothing to
/// delete, just insert).
fn build_replace_doc_requests(end: u64, text: &str) -> Vec<serde_json::Value> {
    let mut requests = Vec::new();
    if end > 2 {
        requests.push(serde_json::json!({
            "deleteContentRange": {
                "range": { "startIndex": 1, "endIndex": end - 1 }
            }
        }));
    }
    requests.push(serde_json::json!({
        "insertText": { "location": { "index": 1 }, "text": text }
    }));
    requests
}

async fn docs_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://docs.googleapis.com/v1/documents";
    match name {        "gdocs_read_doc" => {
            let doc_id = str_arg(args, "document_id")
                .ok_or_else(|| "gdocs_read_doc: missing `document_id` argument".to_string())?;
            let json = get_json(
                http,
                &format!("{BASE}/{}", urlencoding::encode(doc_id)),
                token,
                "docs",
                "read_doc",
            )
            .await?;
            let title = json.get("title").cloned().unwrap_or(serde_json::Value::Null);
            let text = json
                .get("body")
                .map(doc_to_text)
                .unwrap_or_default();
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "title": title,
                "text": text,
            }))
            .map_err(|e| e.to_string())?)
        }
        "gdocs_update_doc" => {
            let doc_id = str_arg(args, "document_id")
                .ok_or_else(|| "gdocs_update_doc: missing `document_id` argument".to_string())?;
            let text = str_arg(args, "text")
                .ok_or_else(|| "gdocs_update_doc: missing `text` argument".to_string())?;
            // Need the doc's endIndex to clear the old content first.
            let doc = get_json(
                http,
                &format!("{BASE}/{}", urlencoding::encode(doc_id)),
                token,
                "docs",
                "get_document",
            )
            .await?;
            let end = doc
                .pointer("/body/content")
                .and_then(|c| c.as_array())
                .and_then(|a| a.last())
                .and_then(|i| i.get("endIndex"))
                .and_then(|v| v.as_u64())
                .unwrap_or(1);
            let requests = build_replace_doc_requests(end, text);
            let json = post_json(
                http,
                &format!("{BASE}/{}:batchUpdate", urlencoding::encode(doc_id)),
                token,
                &serde_json::json!({ "requests": requests }),
                "docs",
                "update_doc",
            )
            .await?;
            let title = doc.get("title").cloned().unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "title": title,
                "updated": true,
                "replies": json.get("replies"),
            }))
            .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown docs fallback tool `{other}`")),
    }
}

// ---- Sheets ----

async fn sheets_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://sheets.googleapis.com/v4/spreadsheets";
    match name {
        "gsheets_get_spreadsheet" => {
            let id = str_arg(args, "spreadsheet_id")
                .ok_or_else(|| "gsheets_get_spreadsheet: missing `spreadsheet_id` argument".to_string())?;
            let json = get_json(
                http,
                &format!("{BASE}/{}", urlencoding::encode(id)),
                token,
                "sheets",
                "get_spreadsheet",
            )
            .await?;
            let title = json.get("properties").and_then(|p| p.get("title")).cloned();
            let tabs: Vec<serde_json::Value> = json
                .get("sheets")
                .and_then(|s| s.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|s| {
                            serde_json::json!({
                                "title": s.pointer("/properties/title"),
                                "rows": s.pointer("/properties/gridProperties/rowCount"),
                                "cols": s.pointer("/properties/gridProperties/columnCount"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "title": title,
                "spreadsheet_id": id,
                "tabs": tabs,
            }))
            .map_err(|e| e.to_string())?)
        }
        "gsheets_get_values" => {
            let id = str_arg(args, "spreadsheet_id")
                .ok_or_else(|| "gsheets_get_values: missing `spreadsheet_id` argument".to_string())?;
            let range = str_arg(args, "range")
                .ok_or_else(|| "gsheets_get_values: missing `range` argument".to_string())?;
            let dim = str_arg(args, "major_dimension").unwrap_or("ROWS");
            let url = format!(
                "{BASE}/{}/values/{}?majorDimension={}",
                urlencoding::encode(id),
                urlencoding::encode(range),
                dim
            );
            let json = get_json(http, &url, token, "sheets", "get_values").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gsheets_update_values" => {
            let id = str_arg(args, "spreadsheet_id")
                .ok_or_else(|| "gsheets_update_values: missing `spreadsheet_id` argument".to_string())?;
            let range = str_arg(args, "range")
                .ok_or_else(|| "gsheets_update_values: missing `range` argument".to_string())?;
            let values = args
                .get("values")
                .ok_or_else(|| "gsheets_update_values: missing `values` argument".to_string())?;
            let url = format!(
                "{BASE}/{}/values/{}?valueInputOption=RAW",
                urlencoding::encode(id),
                urlencoding::encode(range)
            );
            // Sheets values.update is PUT — POST fails every call (405/404).
            let json = put_json(
                http,
                &url,
                token,
                &serde_json::json!({ "range": range, "values": values }),
                "sheets",
                "update_values",
            )
            .await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gsheets_append_values" => {
            let id = str_arg(args, "spreadsheet_id")
                .ok_or_else(|| "gsheets_append_values: missing `spreadsheet_id` argument".to_string())?;
            let range = str_arg(args, "range")
                .ok_or_else(|| "gsheets_append_values: missing `range` argument".to_string())?;
            let values = args
                .get("values")
                .ok_or_else(|| "gsheets_append_values: missing `values` argument".to_string())?;
            let url = format!(
                "{BASE}/{}/values/{}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
                urlencoding::encode(id),
                urlencoding::encode(range)
            );
            let json = post_json(
                http,
                &url,
                token,
                &serde_json::json!({ "range": range, "values": values }),
                "sheets",
                "append_values",
            )
            .await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gsheets_create_spreadsheet" => {
            let title = str_arg(args, "title")
                .ok_or_else(|| "gsheets_create_spreadsheet: missing `title` argument".to_string())?;
            let json = post_json(
                http,
                BASE,
                token,
                &serde_json::json!({ "properties": { "title": title } }),
                "sheets",
                "create_spreadsheet",
            )
            .await?;
            let id = json.get("spreadsheetId").cloned().unwrap_or(serde_json::Value::Null);
            let url = json.get("spreadsheetUrl").cloned().unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "spreadsheet_id": id,
                "url": url,
            }))
            .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown sheets fallback tool `{other}`")),
    }
}

// ---- Slides ----

/// Extract text from a Slides `presentation.slides[]` array.
fn slides_to_text(slides: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(arr) = slides.as_array() {
        for (i, slide) in arr.iter().enumerate() {
            let mut text = String::new();
            if let Some(elems) = slide.get("pageElements").and_then(|e| e.as_array()) {
                for el in elems {
                    if let Some(runs) = el
                        .pointer("/shape/text/textElements")
                        .and_then(|t| t.as_array())
                    {
                        for te in runs {
                            if let Some(t) = te
                                .get("textRun")
                                .and_then(|t| t.get("content"))
                                .and_then(|c| c.as_str())
                            {
                                text.push_str(t);
                            }
                        }
                    }
                }
            }
            if !text.trim().is_empty() {
                out.push_str(&format!("--- Slide {} ---\n{text}\n", i + 1));
            }
        }
    }
    out
}

async fn slides_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://slides.googleapis.com/v1/presentations";
    match name {
        "gslides_read_presentation" => {
            let id = str_arg(args, "presentation_id").ok_or_else(|| {
                "gslides_read_presentation: missing `presentation_id` argument".to_string()
            })?;
            let json = get_json(
                http,
                &format!("{BASE}/{}", urlencoding::encode(id)),
                token,
                "slides",
                "read_presentation",
            )
            .await?;
            let title = json.get("title").cloned().unwrap_or(serde_json::Value::Null);
            let text = json
                .get("slides")
                .map(slides_to_text)
                .unwrap_or_default();
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "title": title,
                "slides_text": text,
            }))
            .map_err(|e| e.to_string())?)
        }
        "gslides_replace_all_text" => {
            let id = str_arg(args, "presentation_id").ok_or_else(|| {
                "gslides_replace_all_text: missing `presentation_id` argument".to_string()
            })?;
            let find = str_arg(args, "find")
                .ok_or_else(|| "gslides_replace_all_text: missing `find` argument".to_string())?;
            let replace = str_arg(args, "replace").ok_or_else(|| {
                "gslides_replace_all_text: missing `replace` argument".to_string()
            })?;
            let json = post_json(
                http,
                &format!("{BASE}/{}:batchUpdate", urlencoding::encode(id)),
                token,
                &serde_json::json!({
                    "requests": [{
                        "replaceAllText": {
                            "containsText": { "text": find, "matchCase": false },
                            "replaceText": replace,
                        }
                    }]
                }),
                "slides",
                "replace_all_text",
            )
            .await?;
            let count = json
                .pointer("/replies/0/replaceAllText/occurrencesChanged")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "replaced_occurrences": count,
            }))
            .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown slides fallback tool `{other}`")),
    }
}

// ---- Calendar ----

async fn calendar_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://www.googleapis.com/calendar/v3";
    fn cal_id(args: &serde_json::Value) -> &str {
        str_arg(args, "calendar_id").unwrap_or("primary")
    }
    match name {
        "gcalendar_list_events" => {
            let max = num_arg(args, "max_results", 20, 100, 1);
            let mut url = format!(
                "{BASE}/calendars/{}/events?maxResults={max}&singleEvents=true&orderBy=startTime",
                urlencoding::encode(cal_id(args))
            );
            if let Some(t) = str_arg(args, "time_min") {
                url.push_str(&format!("&timeMin={}", urlencoding::encode(t)));
            }
            let json = get_json(http, &url, token, "calendar", "list_events").await?;
            let events: Vec<serde_json::Value> = json
                .get("items")
                .and_then(|i| i.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|e| {
                            serde_json::json!({
                                "id": e.get("id"),
                                "summary": e.get("summary"),
                                "start": e.pointer("/start/dateTime").or_else(|| e.pointer("/start/date")),
                                "end": e.pointer("/end/dateTime").or_else(|| e.pointer("/end/date")),
                                "attendees": e.get("attendees"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(serde_json::to_string_pretty(&serde_json::json!({ "events": events }))
                .map_err(|e| e.to_string())?)
        }
        "gcalendar_get_event" => {
            let event_id = str_arg(args, "event_id")
                .ok_or_else(|| "gcalendar_get_event: missing `event_id` argument".to_string())?;
            let url = format!(
                "{BASE}/calendars/{}/events/{}",
                urlencoding::encode(cal_id(args)),
                urlencoding::encode(event_id)
            );
            let json = get_json(http, &url, token, "calendar", "get_event").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gcalendar_list_calendars" => {
            let json = get_json(
                http,
                &format!("{BASE}/users/me/calendarList"),
                token,
                "calendar",
                "list_calendars",
            )
            .await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gcalendar_create_event" => {
            let summary = str_arg(args, "summary")
                .ok_or_else(|| "gcalendar_create_event: missing `summary` argument".to_string())?;
            let start = str_arg(args, "start")
                .ok_or_else(|| "gcalendar_create_event: missing `start` argument".to_string())?;
            let end = str_arg(args, "end")
                .ok_or_else(|| "gcalendar_create_event: missing `end` argument".to_string())?;
            let mut body = serde_json::json!({
                "summary": summary,
                "start": { "dateTime": start },
                "end": { "dateTime": end },
            });
            if let Some(d) = str_arg(args, "description") {
                body["description"] = serde_json::Value::String(d.to_string());
            }
            if let Some(atts) = args.get("attendees").and_then(|a| a.as_array()) {
                let list: Vec<serde_json::Value> = atts
                    .iter()
                    .filter_map(|a| {
                        a.as_str()
                            .map(|email| serde_json::json!({ "email": email }))
                    })
                    .collect();
                if !list.is_empty() {
                    body["attendees"] = serde_json::Value::Array(list);
                }
            }
            let url = format!(
                "{BASE}/calendars/{}/events",
                urlencoding::encode(cal_id(args))
            );
            let json = post_json(http, &url, token, &body, "calendar", "create_event").await?;
            let id = json.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let hangout = json
                .get("hangoutLink")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "event_id": id,
                "summary": summary,
                "start": start,
                "end": end,
                "hangoutLink": hangout,
            }))
            .map_err(|e| e.to_string())?)
        }
        "gcalendar_delete_event" => {
            let event_id = str_arg(args, "event_id")
                .ok_or_else(|| "gcalendar_delete_event: missing `event_id` argument".to_string())?;
            let url = format!(
                "{BASE}/calendars/{}/events/{}",
                urlencoding::encode(cal_id(args)),
                urlencoding::encode(event_id)
            );
            delete_req(http, &url, token, "calendar", "delete_event").await?;
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "event_id": event_id,
                "deleted": true,
            }))
            .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown calendar fallback tool `{other}`")),
    }
}

// ---- Chat ----

async fn chat_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://chat.googleapis.com/v1";
    match name {
        "gchat_list_spaces" => {
            let page = num_arg(args, "page_size", 20, 100, 1);
            let url = format!("{BASE}/spaces?pageSize={page}");
            let json = get_json(http, &url, token, "chat", "list_spaces").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gchat_list_messages" => {
            let space = str_arg(args, "space")
                .ok_or_else(|| "gchat_list_messages: missing `space` argument".to_string())?;
            let page = num_arg(args, "page_size", 20, 50, 1);
            let url = format!("{BASE}/{}/messages?pageSize={page}", urlencoding::encode(space));
            let json = get_json(http, &url, token, "chat", "list_messages").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gchat_send_message" => {
            let space = str_arg(args, "space")
                .ok_or_else(|| "gchat_send_message: missing `space` argument".to_string())?;
            let text = str_arg(args, "text")
                .ok_or_else(|| "gchat_send_message: missing `text` argument".to_string())?;
            let url = format!("{BASE}/{}/messages", urlencoding::encode(space));
            let json = post_json(
                http,
                &url,
                token,
                &serde_json::json!({ "text": text }),
                "chat",
                "send_message",
            )
            .await?;
            let id = json.get("name").cloned().unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({ "message_id": id }))
                .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown chat fallback tool `{other}`")),
    }
}

// ---- People ----

async fn people_call(
    http: &reqwest::Client,
    token: &str,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    const BASE: &str = "https://people.googleapis.com/v1";
    match name {
        "gpeople_get_user_profile" => {
            let json = get_json(
                http,
                &format!("{BASE}/people/me?personFields=names,emailAddresses,photos"),
                token,
                "people",
                "get_user_profile",
            )
            .await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gpeople_search_contacts" => {
            let query = str_arg(args, "query")
                .ok_or_else(|| "gpeople_search_contacts: missing `query` argument".to_string())?;
            let page = num_arg(args, "page_size", 10, 30, 1);
            let url = format!(
                "{BASE}/people:searchContacts?query={}&readMask=names,emailAddresses,phoneNumbers&pageSize={page}",
                urlencoding::encode(query)
            );
            let json = get_json(http, &url, token, "people", "search_contacts").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        "gpeople_search_directory_people" => {
            let query = str_arg(args, "query").ok_or_else(|| {
                "gpeople_search_directory_people: missing `query` argument".to_string()
            })?;
            let page = num_arg(args, "page_size", 10, 30, 1);
            let url = format!(
                "{BASE}/people:searchDirectoryPeople?query={}&readMask=names,emailAddresses&pageSize={page}&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
                urlencoding::encode(query)
            );
            let json = get_json(http, &url, token, "people", "search_directory_people").await?;
            Ok(serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown people fallback tool `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vendor MCP tool names per product (from live `tools/list` responses
    /// of the official servers) — the `g*_` prefixes must keep the fallback
    /// surface disjoint.
    const VENDOR_TOOLS: &[(&str, &[&str])] = &[
        (
            "gdrive",
            &[
                "copy_file", "create_file", "download_file_content", "get_file_metadata",
                "get_file_permissions", "list_recent_files", "read_file_content", "search_files",
            ],
        ),
        ("gdocs", &["read_doc", "update_doc"]),
        (
            "gsheets",
            &[
                "get_values", "get_spreadsheet", "update_spreadsheet", "update_values",
                "update_formulas", "insert_dimension", "copy_sheet_to_another_spreadsheet",
                "batch_clear_values", "append_values",
            ],
        ),
        ("gslides", &["read_presentation", "update_presentation"]),
        (
            "gcalendar",
            &[
                "list_events", "get_event", "list_calendars", "suggest_time", "create_event",
                "update_event", "delete_event", "respond_to_event", "search_events",
            ],
        ),
        ("gchat", &["list_messages", "search_messages", "search_conversations", "send_message"]),
        (
            "gpeople",
            &["search_directory_people", "search_contacts", "get_user_profile"],
        ),
    ];

    #[test]
    fn every_connector_has_prefixed_tools_with_explicit_kinds() {
        let expected_prefixes: &[(&str, &str)] = &[
            ("gdrive", "gdrive_"),
            ("gdocs", "gdocs_"),
            ("gsheets", "gsheets_"),
            ("gslides", "gslides_"),
            ("gcalendar", "gcalendar_"),
            ("gchat", "gchat_"),
            ("gpeople", "gpeople_"),
        ];
        for (id, prefix) in expected_prefixes {
            let defs = fallback_tool_defs(id).unwrap_or_else(|| panic!("{id} has no defs"));
            assert!(!defs.is_empty(), "{id} has an empty fallback surface");
            for def in defs {
                assert!(
                    def.name.starts_with(prefix),
                    "{} must be {prefix}-prefixed",
                    def.name
                );
                assert!(!def.description.is_empty());
                assert!(
                    matches!(
                        def.kind,
                        permission::ConnectorToolKind::Read | permission::ConnectorToolKind::Write
                    ),
                    "{} must carry an explicit kind",
                    def.name
                );
            }
        }
        // gmail is handled by gmail_api, not here.
        assert!(fallback_tool_defs("gmail").is_none());
        assert!(fallback_tool_defs("notion").is_none());
    }

    #[test]
    fn fallback_names_never_collide_with_vendor_mcp_names() {
        for (id, vendor) in VENDOR_TOOLS {
            let defs = fallback_tool_defs(id).unwrap();
            for def in defs {
                assert!(
                    !vendor.contains(&def.name),
                    "{} collides with a vendor MCP tool",
                    def.name
                );
            }
        }
    }

    #[test]
    fn every_fallback_name_is_unique_across_connectors() {
        let mut seen = std::collections::HashSet::new();
        for (id, _) in VENDOR_TOOLS {
            for def in fallback_tool_defs(id).unwrap() {
                assert!(seen.insert(def.name), "duplicate fallback name {}", def.name);
            }
        }
    }

    #[test]
    fn write_tools_are_explicitly_flagged() {
        let writes: &[&str] = &[
            "gdrive_create_file",
            "gdocs_update_doc",
            "gsheets_update_values",
            "gsheets_append_values",
            "gsheets_create_spreadsheet",
            "gslides_replace_all_text",
            "gcalendar_create_event",
            "gcalendar_delete_event",
            "gchat_send_message",
        ];
        for (id, _) in VENDOR_TOOLS {
            for def in fallback_tool_defs(id).unwrap() {
                if writes.contains(&def.name) {
                    assert_eq!(
                        def.kind,
                        permission::ConnectorToolKind::Write,
                        "{} must be Write",
                        def.name
                    );
                } else {
                    assert_eq!(
                        def.kind,
                        permission::ConnectorToolKind::Read,
                        "{} must be Read",
                        def.name
                    );
                }
            }
        }
    }

    #[test]
    fn doc_text_extraction_joins_runs() {
        let body = serde_json::json!({
            "content": [
                { "paragraph": { "elements": [
                    { "textRun": { "content": "Hello " } },
                    { "textRun": { "content": "world" } }
                ] } },
                { "paragraph": { "elements": [
                    { "textRun": { "content": "Second line" } }
                ] } }
            ]
        });
        assert_eq!(doc_to_text(&body), "Hello world\nSecond line\n");
    }

    #[test]
    fn replace_doc_requests_never_delete_the_final_newline() {
        // M18 regression: deleting [1, end) includes the doc's mandatory
        // trailing newline, and batchUpdate rejects the whole request.
        let reqs = build_replace_doc_requests(10, "fresh");
        assert_eq!(reqs.len(), 2);
        assert_eq!(
            reqs[0].pointer("/deleteContentRange/range/endIndex").and_then(|v| v.as_u64()),
            Some(9),
            "delete must stop one short of the structural newline"
        );
        assert_eq!(
            reqs[1].pointer("/insertText/location/index").and_then(|v| v.as_u64()),
            Some(1)
        );
        // A doc holding only the newline (end == 2) or nothing (end == 1):
        // no delete request at all — just the insert.
        for end in [1, 2] {
            let reqs = build_replace_doc_requests(end, "fresh");
            assert_eq!(reqs.len(), 1, "end={end} must skip the delete");
            assert!(reqs[0].get("insertText").is_some());
        }
    }

    #[test]
    fn put_json_sends_put_not_post() {
        // M17 regression: Sheets values.update requires PUT; POST fails 405.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let seen = tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let (tx, rx) = tokio::sync::oneshot::channel::<String>();
            tauri::async_runtime::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let req = String::from_utf8_lossy(&buf).to_string();
                let _ = sock
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                    .await;
                let _ = tx.send(req);
            });
            let http = reqwest::Client::new();
            put_json(
                &http,
                &format!("http://127.0.0.1:{port}/values/A1"),
                "tok",
                &serde_json::json!({ "values": [[1]] }),
                "sheets",
                "update_values",
            )
            .await
            .unwrap();
            rx.await.unwrap()
        });
        let request_line = seen.lines().next().unwrap_or("");
        assert!(request_line.starts_with("PUT "), "expected PUT, got: {request_line}");
        assert!(
            seen.to_ascii_lowercase().contains("authorization: bearer tok"),
            "bearer token must ride along:\n{seen}"
        );
    }

    #[test]
    fn slides_text_extraction_joins_runs() {
        let slides = serde_json::json!([
            { "pageElements": [
                { "shape": { "text": { "textElements": [
                    { "textRun": { "content": "Title slide" } }
                ] } } }
            ] },
            { "pageElements": [] }
        ]);
        let out = slides_to_text(&slides);
        assert!(out.contains("--- Slide 1 ---"));
        assert!(out.contains("Title slide"));
        assert!(!out.contains("Slide 2"));
    }
}
