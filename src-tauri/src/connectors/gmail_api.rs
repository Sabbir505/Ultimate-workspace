//! Direct Gmail REST API fallback tools.
//!
//! Google's hosted Gmail MCP server (`gmailmcp.googleapis.com/mcp/v1`) has a
//! known server-side gate: `initialize` and `tools/list` succeed, but every
//! `tools/call` returns `The caller does not have permission` unless the
//! project is fully enrolled in the Workspace MCP Developer Preview (tracked
//! in anthropics/claude-ai-mcp#229/#424). While that gate is in effect, the
//! chat talks to the **base Gmail REST API** instead — the same OAuth token
//! (`gmail.readonly` + `gmail.compose`) authorizes it fine.
//!
//! The fallback surface is registered per-attach as `gmail_*` tools (see
//! `session.rs`) with an EXPLICIT kind (not keyword classification — these are
//! our tools, we know their intent): reads auto-run under every permission
//! mode, writes (draft/send/label) route through the standard approval-card
//! gate like every other connector write — `dispatch::run_gated_connector_tool`
//! executes them here instead of against the MCP session.

use tauri::AppHandle;

use base64::Engine as _; // for `.encode` on URL_SAFE_NO_PAD (base64 0.22)
use crate::chat::permission::ConnectorToolKind;
use crate::connectors::oauth::ensure_valid_access_token;

/// A fallback tool definition: name, model-facing description, and its
/// explicit Read/Write intent (write intent ⇒ approval-gated like any
/// connector write).
pub struct FallbackTool {
    pub name: &'static str,
    pub description: &'static str,
    pub kind: ConnectorToolKind,
}

/// The fallback tool definitions. Names are `gmail_`-prefixed so they can
/// never collide with the vendor's own MCP tool names (`search_threads`,
/// `get_thread`, `create_draft`, …).
pub fn fallback_tool_defs() -> &'static [FallbackTool] {
    &[
        FallbackTool {
            name: "gmail_search_threads",
            description: "Search the user's Gmail messages (Gmail REST fallback — used while \
             the official Gmail MCP tools are unavailable). Args: query (optional Gmail \
             search syntax, e.g. \"from:alice newer_than:7d is:unread\"; empty returns \
             the most recent messages), max_results (optional, 1-50, default 20). \
             Returns recent messages with id, threadId, from, subject, date, snippet.",
            kind: ConnectorToolKind::Read,
        },
        FallbackTool {
            name: "gmail_get_thread",
            description: "Fetch a full Gmail thread by threadId (Gmail REST fallback). Args: \
             thread_id (required), format (optional: full | minimal, default full). \
             Returns every message in the thread with senders, dates, subjects and \
             plaintext bodies.",
            kind: ConnectorToolKind::Read,
        },
        FallbackTool {
            name: "gmail_get_message",
            description: "Fetch a single Gmail message by id (Gmail REST fallback). Args: \
             message_id (required), format (optional: full | minimal, default full). \
             Returns the message with sender, date, subject, labels and body.",
            kind: ConnectorToolKind::Read,
        },
        FallbackTool {
            name: "gmail_list_labels",
            description: "List the user's Gmail labels (Gmail REST fallback). No args. \
             Returns label names with total/thread counts.",
            kind: ConnectorToolKind::Read,
        },
        FallbackTool {
            name: "gmail_create_draft",
            description: "Create a draft email in the user's Gmail (Gmail REST). This tool works. \
             Args: to (array of addresses), subject, body (plain text; optional cc/bcc arrays). \
             Returns the draft id. Does NOT send — if the user wants the email sent, call \
             gmail_send_message with the same to/subject/body.",
            kind: ConnectorToolKind::Write,
        },
        FallbackTool {
            name: "gmail_send_message",
            description: "Compose and SEND an email from the user's Gmail account (Gmail REST). \
             This tool works — call it whenever the user asks you to send an email (including to \
             send a draft you already created; pass the same to/subject/body). A confirmation card \
             is shown to the user and once they approve, the email is sent automatically — you do \
             not need user permission in advance and must never tell the user to send it manually. \
             Args: to (array of addresses), subject, body (plain text; optional cc/bcc arrays). \
             Returns the sent message id and threadId.",
            kind: ConnectorToolKind::Write,
        },
        FallbackTool {
            name: "gmail_label_thread",
            description: "Modify labels on a Gmail thread (Gmail REST). This tool works. Args: \
             thread_id (required), add (optional array of label IDs), remove (optional array of \
             label IDs). System label IDs: INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM, SENT, \
             DRAFT, CHAT; user labels by their id from gmail_list_labels. Common ops: mark read = \
             remove [\"UNREAD\"], mark unread = add [\"UNREAD\"], archive = remove [\"INBOX\"], \
             trash = add [\"TRASH\"]. Returns the thread's resulting labelIds.",
            kind: ConnectorToolKind::Write,
        },
    ]
}

/// Run a fallback tool by name. Loads (and refreshes if expired) the gmail
/// access token, calls the Gmail REST API, and returns the response body as
/// text for the model. Write tools are called ONLY after the dispatcher's
/// approval gate has already cleared them.
pub async fn call_tool(
    app: &AppHandle,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let token = ensure_valid_access_token(app, "gmail").await?;
    let http = reqwest::Client::new();
    let base = "https://gmail.googleapis.com/gmail/v1/users/me";

    match name {
        "gmail_search_threads" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim();
            let max = args
                .get("max_results")
                .and_then(|v| v.as_i64())
                .unwrap_or(20)
                .clamp(1, 50);
            let mut params: Vec<(&str, String)> = vec![
                ("maxResults", max.to_string()),
                ("format", "metadata".to_string()),
                ("metadataHeaders", "From".to_string()),
                ("metadataHeaders", "Subject".to_string()),
                ("metadataHeaders", "Date".to_string()),
            ];
            if !q.is_empty() {
                params.push(("q", q.to_string()));
            }
            let resp = http
                .get(format!("{base}/messages"))
                .bearer_auth(&token)
                .query(&params)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail search failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail search HTTP {status}: {body}"));
            }
            let json: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("gmail search response not JSON: {e}"))?;
            // Lighten the payload: keep id/threadId + metadata headers + snippet.
            let mut kept = Vec::new();
            if let Some(list) = json.get("messages").and_then(|v| v.as_array()) {
                for m in list.iter().take(max as usize) {
                    let id = m.get("id").cloned().unwrap_or(serde_json::Value::Null);
                    let thread_id = m
                        .get("threadId")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let snippet = m.get("snippet").cloned().unwrap_or(serde_json::Value::Null);
                    let mut hdrs = serde_json::Map::new();
                    if let Some(payload) = m.get("payload").and_then(|p| p.get("headers")) {
                        if let Some(headers) = payload.as_array() {
                            for h in headers {
                                if let (Some(n), Some(v)) = (
                                    h.get("name").and_then(|x| x.as_str()),
                                    h.get("value").and_then(|x| x.as_str()),
                                ) {
                                    hdrs.insert(n.to_string(), serde_json::Value::String(v.to_string()));
                                }
                            }
                        }
                    }
                    kept.push(serde_json::json!({
                        "id": id,
                        "threadId": thread_id,
                        "snippet": snippet,
                        "headers": hdrs,
                    }));
                }
            }
            Ok(serde_json::to_string_pretty(&serde_json::Value::Array(kept))
                .map_err(|e| e.to_string())?)
        }
        "gmail_get_thread" => {
            let thread_id = args
                .get("thread_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "gmail_get_thread: missing `thread_id` argument".to_string())?;
            let fmt = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("full");
            let resp = http
                // Encode the id: thread/message ids come from tool args (model-editable)
                // and may contain `/`, `?`, `#` or spaces that would silently
                // reinterpret parts of the path as query/fragment (parity with
                // google_rest.rs).
                .get(format!("{base}/threads/{}", urlencoding::encode(thread_id)))
                .bearer_auth(&token)
                .query(&[("format", fmt)])
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail get_thread failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail get_thread HTTP {status}: {body}"));
            }
            Ok(body)
        }
        "gmail_get_message" => {
            let message_id = args
                .get("message_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "gmail_get_message: missing `message_id` argument".to_string())?;
            let fmt = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("full");
            let resp = http
                .get(format!("{base}/messages/{}", urlencoding::encode(message_id)))
                .bearer_auth(&token)
                .query(&[("format", fmt)])
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail get_message failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail get_message HTTP {status}: {body}"));
            }
            Ok(body)
        }
        "gmail_list_labels" => {
            let resp = http
                .get(format!("{base}/labels"))
                .bearer_auth(&token)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail list_labels failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail list_labels HTTP {status}: {body}"));
            }
            Ok(body)
        }
        "gmail_create_draft" => {
            let raw = build_mime(args)?;
            let body_json = serde_json::json!({
                "message": { "raw": base64url(raw.as_bytes()) }
            });
            let resp = http
                .post(format!("{base}/drafts"))
                .bearer_auth(&token)
                .json(&body_json)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail create_draft failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail create_draft HTTP {status}: {body}"));
            }
            let json: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("gmail create_draft response not JSON: {e}"))?;
            let id = json.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let thread_id = json
                .get("message")
                .and_then(|m| m.get("threadId"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "draftId": id,
                "threadId": thread_id,
                "note": "Draft created — not sent."
            }))
            .map_err(|e| e.to_string())?)
        }
        "gmail_send_message" => {
            let raw = build_mime(args)?;
            let body_json = serde_json::json!({
                "raw": base64url(raw.as_bytes())
            });
            let resp = http
                .post(format!("{base}/messages/send"))
                .bearer_auth(&token)
                .json(&body_json)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail send_message failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail send_message HTTP {status}: {body}"));
            }
            let json: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("gmail send_message response not JSON: {e}"))?;
            let id = json.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let thread_id = json
                .get("threadId")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "messageId": id,
                "threadId": thread_id,
                "note": "Message sent."
            }))
            .map_err(|e| e.to_string())?)
        }
        "gmail_label_thread" => {
            let thread_id = args
                .get("thread_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "gmail_label_thread: missing `thread_id` argument".to_string())?;
            let add = args
                .get("add")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            let remove = args
                .get("remove")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            if add.is_empty() && remove.is_empty() {
                return Err(
                    "gmail_label_thread: at least one of `add` or `remove` label lists is required"
                        .to_string(),
                );
            }
            let resp = http
                .post(format!("{base}/threads/{}/modify", urlencoding::encode(thread_id)))
                .bearer_auth(&token)
                .json(&serde_json::json!({
                    "addLabelIds": add,
                    "removeLabelIds": remove,
                }))
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("gmail label_thread failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("gmail label_thread HTTP {status}: {body}"));
            }
            let json: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| format!("gmail label_thread response not JSON: {e}"))?;
            let labels = json
                .get("labelIds")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string_pretty(&serde_json::json!({
                "threadId": thread_id,
                "labelIds": labels,
            }))
            .map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown gmail fallback tool `{other}`")),
    }
}

/// Build a minimal RFC 5322 MIME message (plain text) from tool args.
/// Sanitizes header fields against header injection (CR/LF in subject/names).
fn build_mime(args: &serde_json::Value) -> Result<String, String> {
    let to = recipients(args, "to")?;
    let cc = recipients(args, "cc")?;
    let bcc = recipients(args, "bcc")?;
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err("at least one recipient is required (`to`, `cc` or `bcc`)".to_string());
    }
    let subject = sanitize_header(args.get("subject").and_then(|v| v.as_str()).unwrap_or(""));
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if body.trim().is_empty() && subject.is_empty() {
        return Err("a message needs a `subject` or a `body`".to_string());
    }
    let mut head = String::new();
    head.push_str("MIME-Version: 1.0\r\n");
    head.push_str("Content-Type: text/plain; charset=\"UTF-8\"\r\n");
    head.push_str("Content-Transfer-Encoding: 8bit\r\n");
    if !to.is_empty() {
        head.push_str(&format!("To: {to}\r\n"));
    }
    if !cc.is_empty() {
        head.push_str(&format!("Cc: {cc}\r\n"));
    }
    if !bcc.is_empty() {
        head.push_str(&format!("Bcc: {bcc}\r\n"));
    }
    if !subject.is_empty() {
        head.push_str(&format!("Subject: {subject}\r\n"));
    }
    Ok(format!("{head}\r\n{body}"))
}

/// Join an array arg of email addresses into a header value.
fn recipients(args: &serde_json::Value, key: &str) -> Result<String, String> {
    let Some(list) = args.get(key) else {
        return Ok(String::new());
    };
    let Some(list) = list.as_array() else {
        return Err(format!("`{key}` must be an array of email addresses"));
    };
    let mut out = Vec::new();
    for item in list {
        let addr = item
            .as_str()
            .ok_or_else(|| format!("`{key}` entries must be strings"))?;
        if !addr.contains('@') {
            return Err(format!("`{key}` entry `{addr}` is not a valid email address"));
        }
        out.push(sanitize_header(addr));
    }
    Ok(out.join(", "))
}

/// Strip CR/LF and other control characters from a header value (prevents
/// header injection through user/model-supplied subject or names).
fn sanitize_header(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && *c != '\r' && *c != '\n')
        .collect()
}

/// base64url (no padding) — the encoding Gmail's `raw` field expects.
fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs_by_name() -> std::collections::HashMap<&'static str, &'static FallbackTool> {
        fallback_tool_defs()
            .iter()
            .map(|d| (d.name, d))
            .collect()
    }

    #[test]
    fn fallback_tools_are_prefixed_with_explicit_kinds() {
        let defs = defs_by_name();
        for (name, def) in &defs {
            assert!(name.starts_with("gmail_"), "{name} must be gmail_-prefixed");
            assert!(!def.description.is_empty());
            // Explicit kind — never a keyword-guessing result.
            assert!(
                matches!(
                    def.kind,
                    permission::ConnectorToolKind::Read | permission::ConnectorToolKind::Write
                ),
                "{name} must carry an explicit kind"
            );
        }
        // The fallback surface is exactly these seven tools, no drift.
        let mut names: Vec<&str> = defs.keys().copied().collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "gmail_create_draft",
                "gmail_get_message",
                "gmail_get_thread",
                "gmail_label_thread",
                "gmail_list_labels",
                "gmail_search_threads",
                "gmail_send_message",
            ]
        );
        // Read side reads, write side writes.
        assert_eq!(
            defs["gmail_search_threads"].kind,
            permission::ConnectorToolKind::Read
        );
        assert_eq!(
            defs["gmail_create_draft"].kind,
            permission::ConnectorToolKind::Write
        );
        assert_eq!(
            defs["gmail_send_message"].kind,
            permission::ConnectorToolKind::Write
        );
        assert_eq!(
            defs["gmail_label_thread"].kind,
            permission::ConnectorToolKind::Write
        );
    }

    #[test]
    fn fallback_names_never_collide_with_vendor_mcp_names() {
        // The vendor's MCP server names its tools `search_threads`, `get_thread`
        // etc. — the `gmail_` prefix guarantees the fallback set is disjoint.
        let vendor: &[&str] = &[
            "search_threads",
            "get_thread",
            "get_message",
            "list_labels",
            "create_draft",
            "label_thread",
            "unlabel_thread",
            "label_message",
            "unlabel_message",
            "create_label",
            "list_drafts",
            "apply_sensitive_thread_label",
            "apply_sensitive_message_label",
        ];
        for (name, _) in fallback_tool_defs().iter().map(|d| (d.name, d)) {
            assert!(!vendor.contains(&name), "{name} collides with a vendor MCP tool");
        }
    }

    #[test]
    fn mime_message_has_headers_and_body() {
        let args = serde_json::json!({
            "to": ["a@example.com", "b@example.com"],
            "cc": ["c@example.com"],
            "subject": "Hello",
            "body": "Line one\nLine two",
        });
        let mime = build_mime(&args).unwrap();
        assert!(mime.starts_with("MIME-Version: 1.0\r\n"));
        assert!(mime.contains("To: a@example.com, b@example.com\r\n"));
        assert!(mime.contains("Cc: c@example.com\r\n"));
        assert!(mime.contains("Subject: Hello\r\n"));
        assert!(mime.ends_with("\r\n\r\nLine one\nLine two"));
    }

    #[test]
    fn mime_sanitizes_header_injection() {
        let args = serde_json::json!({
            "to": ["a@example.com"],
            "subject": "Hi\r\nBcc: evil@example.com",
            "body": "x",
        });
        let mime = build_mime(&args).unwrap();
        assert!(mime.contains("Subject: HiBcc: evil@example.com\r\n"));
        assert!(
            !mime.lines().any(|l| l.starts_with("Bcc:")),
            "injected Bcc header line must be stripped"
        );
    }

    #[test]
    fn mime_requires_recipient() {
        let err = build_mime(&serde_json::json!({ "subject": "Hi", "body": "x" })).unwrap_err();
        assert!(err.contains("recipient"), "{err}");
        let err = build_mime(&serde_json::json!({ "to": ["not-an-email"] })).unwrap_err();
        assert!(err.contains("not-a"), "{err}");
    }
}
