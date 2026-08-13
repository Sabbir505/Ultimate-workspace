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

use crate::chat::stream_events;
use crate::chat::{permission, tools, ChatManager};
use crate::types::{
    ChatApprovalRequestPayload, ChatApprovalResolvedPayload, ChatArtifactPayload,
    ChatOpenBrowserPayload, ChatTokenPayload,
};
use crate::db;

/// Push a token to the accumulated full message and emit it to the frontend as
/// a `chat:token` event. Empty tokens are no-ops.
///
/// Perf (refactor Task 1.2): prefers the typed `Channel<ChatTokenPayload>`
/// registered by the frontend's `chat_token_subscribe` IPC command. Falls
/// back to `app.emit("chat:token", ...)` when no consumer is registered
/// (tests, headless dev, transient drops).
pub(crate) fn emit_token(app: &AppHandle, sid: &str, token: &str, full: &mut String) {
    if token.is_empty() {
        return;
    }
    full.push_str(token);
    let payload = ChatTokenPayload {
        chat_session_id: sid.to_string(),
        token: token.to_string(),
    };
    if !stream_events::try_send(sid, &payload) {
        let _ = app.emit("chat:token", payload);
    }
}

/// Setting key for the user-configured artifacts directory (Settings →
/// Storage & Data). Empty/unset = default `<Documents>/Conduit`.
pub(crate) const ARTIFACTS_DIR_SETTING_KEY: &str = "storage.artifactsDir";

/// Resolve the user-configured artifacts directory from the DB setting.
/// Returns None when unset/blank (or the read fails).
pub(crate) fn configured_artifacts_dir(conn: &rusqlite::Connection) -> Option<std::path::PathBuf> {
    match db::get_setting(conn, ARTIFACTS_DIR_SETTING_KEY) {
        Ok(Some(dir)) => {
            let dir = dir.trim();
            if dir.is_empty() {
                None
            } else {
                Some(std::path::PathBuf::from(dir))
            }
        }
        _ => None,
    }
}

/// Directory where generated artifacts are written: the configured
/// `storage.artifactsDir` when set, else `<Documents>/Conduit` (falling back
/// to home, then temp). Created if missing.
pub(crate) fn artifacts_dir(app: &AppHandle) -> std::path::PathBuf {
    if let Some(db) = app.try_state::<crate::DbState>() {
        let configured = {
            let conn = db.0.lock();
            configured_artifacts_dir(&conn)
        };
        if let Some(dir) = configured {
            let _ = std::fs::create_dir_all(&dir);
            return dir;
        }
    }
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
    } else if name == tools::DOWNLOAD_FILE {
        // download_file writes to `dest_path`, not `path`.
        args.get("dest_path")
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
        tools::WRITE_FILE => "Write a file at",
        tools::EDIT_FILE => "Edit a file at",
        tools::DELETE_FILE => "Delete",
        tools::MOVE_FILE => "Move",
        tools::COPY_FILE => "Copy",
        _ => name,
    };
    if name == tools::MOVE_FILE || name == tools::COPY_FILE {
        let src = args.get("src").and_then(|v| v.as_str()).unwrap_or("");
        format!("{verb} {src} to {path}")
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
/// approval (a Write-kind connector action under read_only/manual). Mirrors
/// `run_gated_fs_tool`:
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

    execute_connector_tool(attached, app, idx, name, args).await
}

/// Execute an approved connector tool call. Fallback tools (gmail REST while
/// Google's MCP service layer is gated) run locally; everything else forwards
/// to the vendor's MCP server.
async fn execute_connector_tool(
    attached: &[crate::connectors::AttachedConnector],
    app: &AppHandle,
    idx: usize,
    name: &str,
    args: &Value,
) -> String {
    if attached[idx].fallback.contains(name) {
        let connector_id = attached[idx].connector_id.as_str();
        let result = if connector_id == "gmail" {
            crate::connectors::gmail_api::call_tool(app, name, args).await
        } else {
            crate::connectors::google_rest::call_tool(app, connector_id, name, args).await
        };
        return match result {
            Ok(text) => text,
            Err(e) => format!("Connector tool `{name}` failed: {e}"),
        };
    }
    match attached[idx].session.call_tool(name, args).await {
        Ok(text) => text,
        Err(e) => format!("Connector tool `{name}` failed: {e}"),
    }
}

/// Human-facing summary for a connector tool approval card — a plain-language
/// description of the task ("Gmail: send an email to x — subject"), never the
/// raw tool name, so the card reads like a sentence rather than an API call.
fn connector_tool_summary(
    attached: &[crate::connectors::AttachedConnector],
    idx: usize,
    name: &str,
    args: &Value,
) -> String {
    let connector = attached[idx].display_name.as_str();
    let lower = name.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let has = |ks: &[&str]| ks.iter().any(|k| tokens.contains(k));
    let tos = args
        .get("to")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let subj = args.get("subject").and_then(|v| v.as_str()).unwrap_or("");
    let task = if has(&["send"]) {
        if !tos.is_empty() {
            if !subj.is_empty() {
                format!("send an email to {tos} — {subj}")
            } else {
                format!("send an email to {tos}")
            }
        } else {
            "send an email".to_string()
        }
    } else if has(&["draft"]) {
        if !tos.is_empty() {
            format!("create a draft email to {tos}")
        } else {
            "create a draft email".to_string()
        }
    } else if has(&["label", "modify", "tag"]) {
        "update labels on a thread".to_string()
    } else if has(&["delete", "remove", "trash"]) {
        "delete or remove content".to_string()
    } else if has(&["create", "insert", "add", "write"]) {
        "create content".to_string()
    } else if has(&["update", "edit", "patch"]) {
        "update content".to_string()
    } else {
        format!("run the {name} action")
    };
    format!("{connector}: {task}")
}

/// Short description of a tool execution for plan-step matching.
/// Returns a concise label the frontend can fuzzy-match against pending steps.
fn tool_step_description(name: &str, args: &Value) -> String {
    match name {
        "write_file" | "write" | "Edit" => {
            let path = args.get("file_path").or_else(|| args.get("path"))
                .and_then(|v| v.as_str()).unwrap_or("file");
            format!("Write {}", path)
        }
        "read_file" | "read" | "Read" => {
            let path = args.get("file_path").or_else(|| args.get("path"))
                .and_then(|v| v.as_str()).unwrap_or("file");
            format!("Read {}", path)
        }
        "run_shell" | "shell" | "RunShell" => {
            let cmd = args.get("command").or_else(|| args.get("cmd"))
                .and_then(|v| v.as_str()).unwrap_or("command");
            // Truncate long commands
            let short = if cmd.len() > 60 { &cmd[..57] } else { cmd };
            format!("Run {}", short)
        }
        "download_file" | "download" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("file");
            format!("Download {}", url)
        }
        other => format!("{}", other),
    }
}

/// Human-facing summary for a system-tool approval card — a plain sentence of
/// the task ("Download https://… to D:\…\model.safetensors" / "Run shell
/// command: huggingface-cli download …").
fn system_tool_summary(name: &str, args: &Value) -> String {
    match name {
        tools::DOWNLOAD_FILE => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let dest = args.get("dest_path").and_then(|v| v.as_str()).unwrap_or("");
            if !url.is_empty() && !dest.is_empty() {
                format!("Download {url} to {dest}")
            } else if !url.is_empty() {
                format!("Download {url}")
            } else {
                "Download a file from a URL".to_string()
            }
        }
        tools::RUN_SHELL => {
            let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let cmd = cmd.trim();
            let shown: String = cmd.chars().take(120).collect();
            if shown.is_empty() {
                "Run a shell command".to_string()
            } else if shown.len() < cmd.len() {
                format!("Run shell command: {shown}…")
            } else {
                format!("Run shell command: {shown}")
            }
        }
        _ => name.to_string(),
    }
}

/// Execute a system tool (`download_file` / `run_shell` / status / cancel)
/// against the background TaskManager. The permission gate has already
/// decided (or the user approved); these calls either start a task, or read/
/// cancel an existing one, and return text for the model.
async fn execute_system_tool(app: &AppHandle, sid: &str, name: &str, args: &Value) -> String {
    use tools::{CANCEL_TASK, DOWNLOAD_FILE, DOWNLOAD_PROGRESS, GET_TASK_STATUS, RUN_SHELL};
    let tasks = app.state::<crate::TaskState>();
    let task_id = args.get("task_id").and_then(|v| v.as_str()).unwrap_or("").trim();
    match name {
        DOWNLOAD_FILE => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
            let dest = args.get("dest_path").and_then(|v| v.as_str()).unwrap_or("").trim();
            if url.is_empty() {
                return "Error: download_file requires a non-empty \"url\".".to_string();
            }
            if dest.is_empty() {
                return "Error: download_file requires a non-empty \"dest_path\".".to_string();
            }
            let id = tasks.0.start_download(Some(app), sid, url, dest);
            format!(
                "Download started (task {id}) — downloading {url} to {dest} in the background. \
                 Poll download_progress with task_id=\"{id}\" to track it, and report the final \
                 result to the user when it completes."
            )
        }
        DOWNLOAD_PROGRESS | GET_TASK_STATUS => {
            if task_id.is_empty() {
                return format!(
                    "Error: {name} requires a non-empty \"task_id\" (returned by download_file / run_shell)."
                )
                .to_string();
            }
            tasks.0.status_json(task_id)
        }
        CANCEL_TASK => {
            if task_id.is_empty() {
                return "Error: cancel_task requires a non-empty \"task_id\".".to_string();
            }
            tasks.0.cancel(task_id)
        }
        RUN_SHELL => {
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
            if command.is_empty() {
                return "Error: run_shell requires a non-empty \"command\".".to_string();
            }
            let workdir = args.get("workdir").and_then(|v| v.as_str());
            // Run synchronously so the output flows into the turn buffer and
            // persists in the stored message (the async start_shell path sends
            // output to a separate chat:task-progress channel that doesn't
            // persist). Long-running commands block the turn.
            crate::chat::tasks::run_shell_to_completion(command, workdir)
        }
        other => format!("Error: unknown system tool \"{other}\"."),
    }
}

/// Execute a system tool that the permission gate flagged for approval.
/// Mirrors `run_gated_fs_tool`: register a pending approval, emit
/// `chat:approval-request`, pause on the oneshot until the UI resolves, then
/// execute. A denial returns a "denied" tool result.
async fn run_gated_system_tool(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let summary = system_tool_summary(name, args);
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

    execute_system_tool(app, sid, name, args).await
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
    if let Some(text) = run_browser_tool(app, name, args, artifacts_dir, sid).await {
        return text;
    }

    // Source-ledger tools read/write the per-session DB ledger, so they run
    // here (where the AppHandle -> DbState is available) rather than in the
    // provider-agnostic execute_tool dispatcher.
    if let Some(text) = run_ledger_tool(app, sid, name, args).await {
        return text;
    }

    // Connector-originated tools (OAuth-backed remote MCP tools, e.g. Notion).
    // A matched tool name routes to the vendor's MCP server. Writes are gated
    // per the session's permission mode (approval under read_only/manual,
    // auto-run under auto_edit/full_auto); Reads auto-run. This reuses the
    // SAME approval oneshot as filesystem tools — no parallel gating mechanism.
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
        // AutoRun (Read kind, or Write under auto_edit/full_auto): execute
        // immediately.
        return execute_connector_tool(&caps.attached_connectors, app, idx, name, args).await;
    }

    // System tools (background downloads + native shell). `download_file` is
    // gated like a connector write (approval under read_only/manual, auto-run
    // under auto_edit/full_auto); `run_shell` is ALWAYS gated (native code
    // execution); status/cancel tools auto-run. The gate decides BEFORE the
    // task starts — the approval card is the only guard on what a download
    // writes to disk, so it stays meaningful.
    if permission::is_system_tool(name) {
        let decision = permission::check_system_permission(mode, name);
        // download_file's dest_path can be any absolute path the model chooses;
        // a real download writes to disk the same way write_file does, so
        // enforce the same `fs_roots` containment as the mutating FS tools.
        // Without this gate, a prompt-injected model in AutoEdit/FullAuto
        // could write to startup folders, overwriting trusted binaries on PATH,
        // etc. The check is skipped when fs_roots is empty (already blocks
        // mutating FS tools) so behavior for users who never grant roots is
        // unchanged.
        if name == tools::DOWNLOAD_FILE
            && !permission::path_within_scope(
                &fs_target_path(name, args),
                &caps.fs_roots,
            )
        {
            return format!(
                "Error: {name} is gated — destination path is outside the granted roots. \
                 Add the directory under Settings → Filesystem permissions \
                 and retry, or pick a destination inside an already-granted root."
            );
        }
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_system_tool(mgr, app, sid, name, args).await;
        }
        return execute_system_tool(app, sid, name, args).await;
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
        // AutoRun: a mutating tool call still has to lie within a granted
        // root. The check below is the hard scope gate that turns
        // `fs_roots` from advisory into authoritative. Reads are exempt
        // (the user explicitly opened a file → reading is intentional).
        if permission::is_mutating_fs_tool(name)
            && !permission::path_within_scope(&target, &caps.fs_roots)
        {
            return format!(
                "Error: {name} is gated — path is outside the granted roots. \
                 Add the directory under Settings → Filesystem permissions \
                 and retry, or pick a path inside an already-granted root."
            );
        }
        // move_file ALSO has to source from within a granted root: a move is
        // copy+delete of the source, so checking only the destination let a
        // FullAuto turn delete an arbitrary file anywhere on disk by moving
        // it into a project. (copy_file stays dest-only — reads are unscoped.)
        if name == tools::MOVE_FILE {
            let src = args.get("src").and_then(|v| v.as_str()).unwrap_or("");
            if !permission::path_within_scope(src, &caps.fs_roots) {
                return format!(
                    "Error: {name} is gated — source path is outside the granted roots. \
                     Moving deletes the file at its source, so both ends of a move \
                     must lie inside a granted root."
                );
            }
        }
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

    // Emit a plan-step-progress signal so the frontend can mark the
    // corresponding checkpoint as complete. The frontend fuzzy-matches
    // the label against parsed PlanStep items.
    if !outcome.text.starts_with("Error:") {
        let desc = tool_step_description(name, args);
        crate::chat::tasks::emit_plan_step_progress(
            app,
            sid,
            &desc,
            "completed",
            Some("tool executed successfully"),
            None::<&str>,
        );
    }

    outcome.text
}

/// Dispatch the agentic browser tools (`browser_read`/`browser_click`/
/// `browser_type`/`browser_scroll`/`browser_screenshot`) against the active
/// browser-pane webview. Returns `None` for any other tool name so the caller
/// falls through to the normal tool dispatcher.
async fn run_browser_tool(
    app: &AppHandle,
    name: &str,
    args: &Value,
    artifacts_dir: &std::path::Path,
    sid: &str,
) -> Option<String> {
    use tools::{BROWSER_CLICK, BROWSER_READ, BROWSER_SCREENSHOT, BROWSER_SCROLL, BROWSER_TYPE};
    if !matches!(name, BROWSER_READ | BROWSER_CLICK | BROWSER_TYPE | BROWSER_SCROLL | BROWSER_SCREENSHOT) {
        return None;
    }
    // Surface the Browser tab so the user can watch the agent work (same
    // auto-open contract as generated artifacts and the harness MCP path).
    let _ = app.emit("browser:activity", serde_json::json!({ "pane_id": null }));
    let browser = app.state::<crate::BrowserState>();
    let mgr = browser.0.clone();

    // Screenshot is blocking COM work (UI-thread CapturePreview roundtrip) and
    // unlike the other tools it saves a file + emits an artifact event, so it
    // gets its own branch instead of the shared match below.
    if name == BROWSER_SCREENSHOT {
        let png = match tokio::task::spawn_blocking(move || mgr.capture_active_png()).await {
            Ok(Some(png)) => png,
            Ok(None) => {
                return Some("browser_screenshot failed: capture unavailable (no page is open in the browser pane, or the platform doesn't support capture).".to_string())
            }
            Err(e) => return Some(format!("browser_screenshot failed: {e}")),
        };
        let _ = std::fs::create_dir_all(artifacts_dir);
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let filename = format!("browser-shot-{millis}.png");
        let path = artifacts_dir.join(&filename);
        if let Err(e) = std::fs::write(&path, &png) {
            return Some(format!("browser_screenshot failed: could not save PNG: {e}"));
        }
        let path_str = path.to_string_lossy().into_owned();
        // Persist + surface like a generated artifact: the shot pops open in
        // the canvas immediately and lands in the Artifacts sidebar.
        {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            let _ = db::insert_artifact(&conn, Some(sid), &filename, &path_str, "png");
        }
        let _ = app.emit(
            "chat:artifact",
            ChatArtifactPayload {
                chat_session_id: sid.to_string(),
                path: path_str.clone(),
                filename,
            },
        );
        return Some(format!(
            "Screenshot saved to {path_str}. It has been opened in the user's canvas. To show it inline, embed it in your reply as ![screenshot]({path_str})."
        ));
    }

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
