//! Tool dispatch for the chat tool loop.
//!
//! [`run_tool`] is the single entry point the streaming tool loops
//! ([`crate::chat::streaming`]) call for every model-produced tool call. It
//! routes agentic browser tools and source-ledger tools (which need app state)
//! through their own interceptors, routes filesystem tools through the central
//! [`permission::check_permission`] gate (pausing the turn on an approval
//! oneshot when the gate flags the action), and otherwise delegates to the
//! provider-agnostic [`tools::execute_tool`].
//!
//! When a tool produces a file, the artifact is persisted and the UI is
//! notified (`chat:artifact`); when it asks to open a URL, the browser pane is
//! asked to show it (`chat:open-browser`).

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::{permission, tools, ChatManager};
use crate::types::{
    ChatApprovalRequestPayload, ChatApprovalResolvedPayload, ChatArtifactPayload,
    ChatOpenBrowserPayload, ChatTokenPayload,
};
use crate::db;

/// Push a token to the accumulated full message and emit it to the frontend as
/// a `chat:token` event. Empty tokens are no-ops.
pub(crate) fn emit_token(app: &AppHandle, sid: &str, token: &str, full: &mut String) {
    if token.is_empty() {
        return;
    }
    full.push_str(token);
    let _ = app.emit(
        "chat:token",
        ChatTokenPayload {
            chat_session_id: sid.to_string(),
            token: token.to_string(),
        },
    );
}

/// Directory where generated artifacts are written (`<Documents>/Conduit`,
/// falling back to home, then temp). Created on demand by the artifact writer.
pub(crate) fn artifacts_dir(app: &AppHandle) -> std::path::PathBuf {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("Conduit")
}

/// The absolute target path a filesystem tool call intends to act on, used
/// only for the granted-root containment check in `check_permission`. Pulls
/// `path`/`src`/`dest` from the args; returns "" when none is present (which
/// `check_permission` treats as outside any root → gated).
fn fs_target_path(name: &str, args: &Value) -> String {
    if name == tools::MOVE_FILE || name == tools::COPY_FILE {
        // For move/copy, the destination is the write-side — check that.
        args.get("dest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        args.get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    }
}

/// Build a short human-facing summary of a filesystem tool call for the
/// approval card (e.g. "write_file → C:/…/main.rs").
fn fs_tool_summary(name: &str, args: &Value) -> String {
    let path = fs_target_path(name, args);
    let verb = match name {
        tools::WRITE_FILE => "write",
        tools::EDIT_FILE => "edit",
        tools::DELETE_FILE => "delete",
        tools::MOVE_FILE => "move",
        tools::COPY_FILE => "copy",
        _ => name,
    };
    if name == tools::MOVE_FILE || name == tools::COPY_FILE {
        let src = args.get("src").and_then(|v| v.as_str()).unwrap_or("");
        format!("{verb} {src} → {path}")
    } else {
        format!("{verb} {path}")
    }
}

/// Execute a filesystem tool that the permission gate flagged for approval.
/// Registers a pending approval, emits `chat:approval-request`, and pauses on
/// the oneshot until the UI resolves. Returns the tool result text (either the
/// real executed output, or a "user denied" message). If the stream is
/// cancelled while paused, the sender is dropped and the receiver errors —
/// treated as a denial so the model doesn't hang.
async fn run_gated_fs_tool(
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let summary = fs_tool_summary(name, args);
    let (pending_id, rx) = mgr.register_pending_approval(sid, name, args.clone(), summary.clone());

    let _ = app.emit(
        "chat:approval-request",
        ChatApprovalRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.clone(),
            tool: name.to_string(),
            summary,
            args: args.clone(),
        },
    );

    // Pause the loop until the UI resolves the card. A dropped sender
    // (stream cancelled) resolves to a denial.
    let approved = rx.await.unwrap_or(false);
    let _ = app.emit(
        "chat:approval-resolved",
        ChatApprovalResolvedPayload {
            chat_session_id: sid.to_string(),
            pending_id,
            approved,
        },
    );

    if !approved {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    // Approved — execute the tool now and return its real result.
    let outcome = tools::execute_tool(client, artifacts_dir, caps, name, args).await;
    if let Some(a) = outcome.artifact {
        let kind = std::path::Path::new(&a.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            let _ = db::insert_artifact(&conn, Some(sid), &a.filename, &a.path, &kind);
        }
        let _ = app.emit(
            "chat:artifact",
            ChatArtifactPayload {
                chat_session_id: sid.to_string(),
                path: a.path,
                filename: a.filename,
            },
        );
    }
    outcome.text
}

/// Execute a connector-originated tool that the permission gate flagged for
/// approval (any Write-kind connector action). Mirrors `run_gated_fs_tool`:
/// register a pending approval, emit `chat:approval-request`, pause on the
/// oneshot until the UI resolves, then call the vendor's MCP server. A denial
/// (or a dropped sender on stream cancel) returns a "denied" tool result.
async fn run_gated_connector_tool(
    attached: &[crate::connectors::AttachedConnector],
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    idx: usize,
    name: &str,
    args: &Value,
) -> String {
    let summary = connector_tool_summary(attached, idx, name, args);
    let (pending_id, rx) = mgr.register_pending_approval(sid, name, args.clone(), summary.clone());

    let _ = app.emit(
        "chat:approval-request",
        ChatApprovalRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.clone(),
            tool: name.to_string(),
            summary,
            args: args.clone(),
        },
    );

    let approved = rx.await.unwrap_or(false);
    let _ = app.emit(
        "chat:approval-resolved",
        ChatApprovalResolvedPayload {
            chat_session_id: sid.to_string(),
            pending_id,
            approved,
        },
    );

    if !approved {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    // Approved — forward to the vendor's MCP server.
    match attached[idx].session.call_tool(name, args).await {
        Ok(text) => text,
        Err(e) => format!("Connector tool `{name}` failed: {e}"),
    }
}

/// Human-facing summary for a connector tool approval card — surfaces the
/// connector name + tool name + a compact preview of the arguments so the
/// user can see what's about to be created/changed before approving.
fn connector_tool_summary(
    attached: &[crate::connectors::AttachedConnector],
    idx: usize,
    name: &str,
    args: &Value,
) -> String {
    let connector = attached[idx].display_name.as_str();
    let preview = compact_args_preview(args);
    format!("{connector} · {name}{preview}")
}

/// Compact, single-line preview of a tool call's arguments, capped so the
/// approval card stays readable. Falls back to the raw JSON when truncated.
fn compact_args_preview(args: &Value) -> String {
    let s = if args.is_object() {
        // Prefer a "title"/"name"/"path"/"url" hint if present, else the whole object.
        if let Some(hint) = ["title", "name", "path", "url", "query", "parent"]
            .iter()
            .find_map(|k| args.get(k).and_then(|v| v.as_str()).map(|v| format!("{k}: {v}")))
        {
            hint
        } else {
            serde_json::to_string(args).unwrap_or_default()
        }
    } else {
        serde_json::to_string(args).unwrap_or_default()
    };
    const CAP: usize = 160;
    if s.len() > CAP {
        format!(" — {}…", &s[..s.char_indices().take(CAP).last().map(|(i, _)| i).unwrap_or(CAP)])
    } else if s.is_empty() {
        String::new()
    } else {
        format!(" — {s}")
    }
}

/// Run a tool and, if it produced a file, notify the UI. Returns the text to
/// feed back to the model.
///
/// For filesystem tools, this first routes through the central
/// `permission::check_permission` gate. `AutoRun` executes immediately;
/// `NeedsApproval` registers a pending approval, emits `chat:approval-request`,
/// and **pauses the tool loop** on a oneshot until the UI resolves the card.
/// If the user denies (or the stream is cancelled), a "denied" tool result is
/// returned instead of executing.
pub(crate) async fn run_tool(
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    mode: permission::PermissionMode,
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    // Agentic browser tools act on the live browser-pane webview, so they run
    // here (where the AppHandle -> BrowserState is available) rather than in
    // the provider-agnostic execute_tool dispatcher.
    if let Some(text) = run_browser_tool(app, name, args).await {
        return text;
    }

    // Source-ledger tools read/write the per-session DB ledger, so they run
    // here (where the AppHandle -> DbState is available) rather than in the
    // provider-agnostic execute_tool dispatcher.
    if let Some(text) = run_ledger_tool(app, sid, name, args).await {
        return text;
    }

    // Connector-originated tools (OAuth-backed remote MCP tools, e.g. Notion).
    // A matched tool name routes to the vendor's MCP server — Writes (create/
    // update/delete) always gate through the approval flow (the carve-out, like
    // `delete_file`); Reads auto-run. This reuses the SAME approval oneshot as
    // filesystem tools — no parallel gating mechanism.
    if let Some((idx, kind)) = crate::connectors::find_tool(&caps.attached_connectors, name) {
        let decision = permission::check_connector_permission(mode, kind);
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_connector_tool(
                &caps.attached_connectors,
                mgr,
                app,
                sid,
                idx,
                name,
                args,
            )
            .await;
        }
        // Read-kind: auto-run, forward to the MCP server.
        return match caps.attached_connectors[idx].session.call_tool(name, args).await {
            Ok(text) => text,
            Err(e) => format!("Connector tool `{name}` failed: {e}"),
        };
    }

    // Filesystem tools route through the central permission gate. Every FS
    // tool's handler goes through this one branch — the delete-always-gated
    // rule and the mode defaults live in `permission::check_permission`, not
    // duplicated per tool.
    if permission::is_filesystem_tool(name) {
        let target = fs_target_path(name, args);
        let decision =
            permission::check_permission(mode, name, &target, &caps.fs_roots);
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_fs_tool(client, artifacts_dir, caps, mgr, app, sid, name, args)
                .await;
        }
        // AutoRun: fall through to execute_tool below.
    }

    let outcome = tools::execute_tool(client, artifacts_dir, caps, name, args).await;
    if let Some(a) = outcome.artifact {
        // Persist to the Artifacts sidebar (30-day retention) before notifying
        // the UI. A DB failure must not block the chat, so errors are ignored.
        let kind = std::path::Path::new(&a.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            let _ = db::insert_artifact(&conn, Some(sid), &a.filename, &a.path, &kind);
        }
        let _ = app.emit(
            "chat:artifact",
            ChatArtifactPayload {
                chat_session_id: sid.to_string(),
                path: a.path,
                filename: a.filename,
            },
        );
    }
    if let Some(url) = outcome.browse_url {
        let _ = app.emit(
            "chat:open-browser",
            ChatOpenBrowserPayload {
                chat_session_id: sid.to_string(),
                url,
            },
        );
    }
    outcome.text
}

/// Dispatch the agentic browser tools (`browser_read`/`browser_click`/
/// `browser_type`/`browser_scroll`) against the active browser-pane webview.
/// Returns `None` for any other tool name so the caller falls through to the
/// normal tool dispatcher.
async fn run_browser_tool(app: &AppHandle, name: &str, args: &Value) -> Option<String> {
    use tools::{BROWSER_CLICK, BROWSER_READ, BROWSER_SCROLL, BROWSER_TYPE};
    if !matches!(name, BROWSER_READ | BROWSER_CLICK | BROWSER_TYPE | BROWSER_SCROLL) {
        return None;
    }
    let browser = app.state::<crate::BrowserState>();
    let mgr = browser.0.clone();
    let result = match name {
        BROWSER_READ => {
            let mode_str = args
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("full");
            let mode = match mode_str {
                "summary_only" => crate::browser::ReadMode::SummaryOnly,
                "section" => crate::browser::ReadMode::Section,
                _ => crate::browser::ReadMode::Full,
            };
            let selector = args.get("selector").and_then(|v| v.as_str());
            mgr.read_page(mode, selector).await
        }
        BROWSER_CLICK => match args.get("ref").and_then(|v| v.as_i64()) {
            Some(r) => mgr.click_ref(r).await,
            None => Err("browser_click requires an integer \"ref\" from browser_read.".to_string()),
        },
        BROWSER_TYPE => {
            let r = args.get("ref").and_then(|v| v.as_i64());
            let text = args.get("text").and_then(|v| v.as_str());
            match (r, text) {
                (Some(r), Some(text)) => mgr.type_into(r, text).await,
                _ => Err("browser_type requires an integer \"ref\" and \"text\".".to_string()),
            }
        }
        BROWSER_SCROLL => {
            let dy = args.get("amount").and_then(|v| v.as_i64()).unwrap_or(600);
            mgr.scroll_by(dy).await
        }
        _ => unreachable!("guarded by matches! above"),
    };
    Some(match result {
        Ok(text) => text,
        Err(e) => format!("{name} failed: {e}"),
    })
}

/// Dispatch the source-ledger tools (`add_source_note` / `get_source_ledger` /
/// `reset_source_ledger`) against the per-session DB ledger. These need DB
/// access (which the provider-agnostic `execute_tool` does not receive), so
/// they are intercepted here in `run_tool` exactly like the browser tools.
/// Returns `None` for any other tool name so the caller falls through to the
/// normal tool dispatcher.
async fn run_ledger_tool(app: &AppHandle, sid: &str, name: &str, args: &Value) -> Option<String> {
    use tools::{ADD_SOURCE_NOTE, GET_SOURCE_LEDGER, RESET_SOURCE_LEDGER};
    if !matches!(name, ADD_SOURCE_NOTE | GET_SOURCE_LEDGER | RESET_SOURCE_LEDGER) {
        return None;
    }
    let db = app.state::<crate::DbState>();
    let result: Result<String, String> = {
        let conn = db.0.lock();
        match name {
            ADD_SOURCE_NOTE => {
                let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
                let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
                let fact = args.get("fact").and_then(|v| v.as_str()).unwrap_or("").trim();
                let excerpt = args
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let unavailable = args.get("unavailable").and_then(|v| v.as_str());
                if url.is_empty() || fact.is_empty() {
                    return Some(
                        "Error: add_source_note requires a non-empty \"url\" and \"fact\".".to_string(),
                    );
                }
                match db::add_source_note(
                    &conn,
                    sid,
                    url,
                    title,
                    fact,
                    excerpt,
                    unavailable,
                ) {
                    Ok(_) => Ok(format!("Recorded source note for {url}.")),
                    Err(e) => Err(format!("add_source_note failed: {e}")),
                }
            }
            GET_SOURCE_LEDGER => match db::list_source_notes(&conn, sid) {
                Ok(notes) => Ok(serde_json::to_string(&notes).unwrap_or_else(|_| "[]".to_string())),
                Err(e) => Err(format!("get_source_ledger failed: {e}")),
            },
            RESET_SOURCE_LEDGER => match db::clear_source_notes(&conn, sid) {
                Ok(_) => Ok("Source ledger cleared.".to_string()),
                Err(e) => Err(format!("reset_source_ledger failed: {e}")),
            },
            _ => unreachable!("guarded by matches! above"),
        }
    };
    Some(match result {
        Ok(text) => text,
        Err(e) => e,
    })
}
