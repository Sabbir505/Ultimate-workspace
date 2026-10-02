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

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::providers::ANTHROPIC_API_VERSION;
use crate::chat::stream_events;
use crate::chat::tools::ToolOutcome;
use crate::chat::{permission, tools, ChatManager};
use crate::db;
use crate::types::{
    ChatApprovalRequestPayload, ChatApprovalResolvedPayload, ChatOpenBrowserPayload,
    ChatOpenPreviewPayload,
};

/// Push a token to the accumulated full message and emit it to the frontend as
/// a `chat:token` event. Empty tokens are no-ops.
///
/// Perf (refactor Task 1.2): prefers the typed `Channel<ChatTokenPayload>`
/// registered by the frontend's `chat_token_subscribe` IPC command. Falls
/// back to `app.emit("chat:token", ...)` when no consumer is registered
/// (tests, headless dev, transient drops).
pub(crate) fn emit_token<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, token: &str, full: &mut String) {
    emit_chunk(app, sid, token, full, true);
}

/// Emit a structural marker (`<tool>` block markup, result cards, epilogues):
/// updates the message buffer and the UI exactly like `emit_token`, but does
/// NOT feed the perf accumulator — markers are UI scaffolding, not model
/// tokens, so counting them inflated the live OUT/tok/s and could capture
/// TTFT at a tool-card render instead of the model's first token.
pub(crate) fn emit_marker<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, token: &str, full: &mut String) {
    emit_chunk(app, sid, token, full, false);
}

fn emit_chunk<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, token: &str, full: &mut String, record: bool) {
    if token.is_empty() {
        return;
    }
    full.push_str(token);
    // Keep the app-exit partial buffer warm (chat/partial_buf.rs): a quit
    // mid-stream persists what the user watched instead of dropping it.
    crate::chat::partial_buf::record(sid, token);
    // Wire emission + perf recording live in the shared chat-event seam
    // (chat/stream_events.rs) — same channel-first/fallback path for both
    // chat worlds.
    stream_events::emit_chat_token(Some(app), sid, token, record);
}

/// Setting key for the user-configured artifacts directory (Settings →
/// Storage & Data). Empty/unset = default `<Documents>/Relay`.
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

/// The artifacts dir when no `storage.artifactsDir` is configured:
/// `<Documents>/Relay` (falling back to home, then temp). Lock-free — it only
/// touches the app's path resolver.
///
/// Generic over the runtime so the deadlock invariant below is unit-testable
/// with Tauri's `MockRuntime`.
pub(crate) fn default_artifacts_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> std::path::PathBuf {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    crate::user_dirs::branded_dir(&base)
}

/// Directory where generated artifacts are written: the configured
/// `storage.artifactsDir` when set, else [`default_artifacts_dir`]. Created if
/// missing.
///
/// LOCKS `DbState` internally (to read the setting) — so a caller that already
/// holds a `DbState` guard must call [`artifacts_dir_locked`] instead. See that
/// function for why: this lock is not reentrant.
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
    default_artifacts_dir(app)
}

/// Same resolution as [`artifacts_dir`], for callers that ALREADY hold the DB
/// connection. Reads `storage.artifactsDir` through the live `conn` instead of
/// re-locking `DbState`.
///
/// This exists because the other shape is a self-deadlock: `parking_lot::Mutex`
/// is not reentrant, so `artifacts_dir(app)` called with a `DbState` guard held
/// blocks that thread forever on the global DB mutex. That is exactly what the
/// former per-IPC preview-scope resolution (called from every artifact IPC with
/// the lock held) used to do — one artifact preview or one 2 s `get_file_mtime`
/// poll later the mutex was owned by a thread that would never release it,
/// every other DB command waited behind it, and once each runtime worker was
/// parked the whole IPC surface stopped answering. Pass the connection you
/// already hold.
pub(crate) fn artifacts_dir_locked<R: tauri::Runtime>(
    conn: &rusqlite::Connection,
    app: &tauri::AppHandle<R>,
) -> std::path::PathBuf {
    if let Some(dir) = configured_artifacts_dir(conn) {
        let _ = std::fs::create_dir_all(&dir);
        return dir;
    }
    default_artifacts_dir(app)
}

/// The absolute target path a filesystem tool call intends to act on, used
/// only for the granted-root containment check in `check_permission`. Pulls
/// `path`/`src`/`dest` from the args; returns "" when none is present (which
/// `check_permission` treats as outside any root → gated).
/// Resolve a tool's filesystem target (write-side for move/copy, `dest_path`
/// for downloads, `path` otherwise). `pub(crate)` so the approval-resolution
/// path in commands.rs can grant the target's directory when the user
/// remembers a choice.
pub(crate) fn fs_target_path(name: &str, args: &Value) -> String {
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

/// Human-facing summary for a Claude Code tool call that arrived over the
/// can_use_tool control request (harness approval relay). The tool names are
/// the CLI's own (Write/Edit/Bash/…), so the builtin `fs_tool_summary` doesn't
/// apply — this maps the common ones and falls back to the raw name.
pub(crate) fn harness_tool_summary(tool: &str, input: &Value) -> String {
    let pick = |keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(v) = input.get(*k).and_then(|v| v.as_str()) {
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        None
    };
    // "plan" is Claude Code's ExitPlanMode payload — without it the
    // plan-mode approval card would give the user nothing to judge.
    let target = pick(&[
        "file_path",
        "path",
        "notebook_path",
        "command",
        "pattern",
        "url",
        "prompt",
        "plan",
    ])
    .map(|t| {
        if t.chars().count() > 160 {
            format!("{}…", t.chars().take(160).collect::<String>())
        } else {
            t
        }
    })
    .unwrap_or_default();
    let verb = match tool {
        "Write" => "Write a file at",
        "Edit" | "MultiEdit" | "NotebookEdit" => "Edit a file at",
        "Bash" => "Run a shell command:",
        "Read" => "Read",
        "Glob" | "Grep" => "Search for",
        "WebFetch" => "Fetch",
        "WebSearch" => "Search the web for",
        "Task" => "Launch a subagent:",
        "ExitPlanMode" => "Wants to leave plan mode and start implementing:",
        other => other,
    };
    if target.is_empty() {
        verb.to_string()
    } else {
        format!("{verb} {target}")
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

/// Shared approval gate (the approval-card contract): register a pending
/// approval, emit `chat:approval-request`, pause on the oneshot until the UI
/// resolves — a dropped sender (stream cancelled) resolves to a denial —
/// then emit `chat:approval-resolved`. Returns the user's decision; the
/// caller renders its own denial text.
pub(crate) async fn run_approval_gate(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    tool: &str,
    args: &Value,
    summary: String,
) -> bool {
    let (pending_id, rx) = mgr.register_pending_approval(sid, tool, args.clone(), summary.clone());
    let _ = app.emit(
        "chat:approval-request",
        ChatApprovalRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.clone(),
            tool: tool.to_string(),
            summary,
            args: args.clone(),
        },
    );
    let approved = rx.await.unwrap_or(false);
    emit_approval_resolved(app, sid, &pending_id, approved);
    approved
}

/// Sync-thread variant of [`run_approval_gate`] for harness reader threads
/// (claude.rs `can_use_tool`): the reader blocks on the oneshot — the CLI is
/// simultaneously blocked waiting on stdin, so neither side spins. A `None`
/// app or registry (unit tests / relay contexts) means nobody can ever answer
/// the card: deny so the CLI continues instead of waiting forever.
pub(crate) fn run_approval_gate_blocking(
    app: Option<&AppHandle>,
    mgr: Option<&Arc<ChatManager>>,
    sid: &str,
    tool: &str,
    args: &Value,
    summary: String,
) -> bool {
    let Some((app, mgr)) = app.zip(mgr) else {
        return false;
    };
    let (pending_id, rx) = mgr.register_pending_approval(sid, tool, args.clone(), summary.clone());
    let _ = app.emit(
        "chat:approval-request",
        ChatApprovalRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.clone(),
            tool: tool.to_string(),
            summary,
            args: args.clone(),
        },
    );
    let approved = rx.blocking_recv().unwrap_or(false);
    emit_approval_resolved(app, sid, &pending_id, approved);
    approved
}

fn emit_approval_resolved(app: &AppHandle, sid: &str, pending_id: &str, approved: bool) {
    let _ = app.emit(
        "chat:approval-resolved",
        ChatApprovalResolvedPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.to_string(),
            approved,
        },
    );
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
    confirm_edits: bool,
) -> String {
    let summary = fs_tool_summary(name, args);
    // Confirm-edits posture (§4.2.5): the card carries a structured preview
    // of the ACTUAL change (occurrences read from the current file — not the
    // model's claimed args), letting the user accept all of it, a subset, or
    // none. The preview rides a `__relayEditPreview` key on the CARD's args
    // copy; the executed args stay verbatim.
    let mut card_args = args.clone();
    if confirm_edits {
        if let Some(preview) = build_edit_preview(name, args) {
            card_args["__relayEditPreview"] = preview;
        }
    }
    if !run_approval_gate(mgr, app, sid, name, &card_args, summary).await {
        // Deny (or a cancelled stream) — also drop any stale selection.
        mgr.take_edit_selection(sid);
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    // Approved. A parked partial selection means the user accepted a SUBSET
    // of the edit's occurrences on the review card — rewrite the args into a
    // selected-occurrences edit instead of the model's original all-or-nothing.
    let selection = if confirm_edits { mgr.take_edit_selection(sid) } else { None };
    let effective_args: Value = match selection.as_deref() {
        Some(selected) if !selected.is_empty() && name == tools::EDIT_FILE => {
            let mut a = args.clone();
            a["__selectedOccurrences"] = serde_json::to_value(selected).unwrap_or_default();
            a
        }
        _ => args.clone(),
    };

    // Approved — execute the tool now and return its real result.
    let outcome = if name == tools::EDIT_FILE
        && effective_args.get("__selectedOccurrences").is_some()
    {
        tools::fs_edit_file_selected(&effective_args, selection.as_deref().unwrap_or(&[]))
    } else {
        tools::execute_tool(client, artifacts_dir, caps, name, &effective_args, Some(app), Some(sid)).await
    };
    if let Some(a) = outcome.artifact {
        {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            stream_events::insert_and_emit_artifact(Some(app), &conn, sid, &a.path, &a.filename);
        }
    }
    outcome.text
}

/// Build the confirm-edits card preview for a write/edit call: the real
/// state of the target file crossed with the model's proposed change.
/// `None` = no preview (the card falls back to the plain summary).
fn build_edit_preview(name: &str, args: &Value) -> Option<Value> {
    let path = args.get("path").and_then(|v| v.as_str())?;
    match name {
        tools::EDIT_FILE => {
            let find = args.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let replace = args.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            let append = args
                .get("append")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if append || find.is_empty() {
                return Some(serde_json::json!({
                    "kind": "append",
                    "path": path,
                    "replace": replace,
                    "replaceChars": replace.chars().count(),
                }));
            }
            let content = std::fs::read_to_string(path).ok()?;
            // Occurrences: 1-based indexes + the line each match starts on
            // (capped — a pathological find-everywhere edit degrades to the
            // plain card instead of a 10k-row checkbox list).
            const MAX_LISTED: usize = 50;
            let mut occurrences = Vec::new();
            let mut consumed = 0usize;
            for (i, (pos, _)) in content.match_indices(find).enumerate() {
                if i >= MAX_LISTED {
                    break;
                }
                let line = content[..pos].matches('\n').count() + 1;
                let context: String = content[pos..]
                    .chars()
                    .take(160)
                    .collect();
                occurrences.push(serde_json::json!({
                    "index": i + 1,
                    "line": line,
                    "context": context.trim_end(),
                }));
                consumed += 1;
            }
            if consumed == 0 {
                return None;
            }
            Some(serde_json::json!({
                "kind": "edit",
                "path": path,
                "findChars": find.chars().count(),
                "replaceChars": replace.chars().count(),
                "totalOccurrences": content.match_indices(find).count(),
                "occurrences": occurrences,
            }))
        }
        tools::WRITE_FILE => {
            let content = args.get("content").and_then(|v| v.as_str())?;
            let exists = std::path::Path::new(path).is_file();
            let preview: Vec<&str> = content.lines().take(40).collect();
            Some(serde_json::json!({
                "kind": "write",
                "path": path,
                "exists": exists,
                "lines": content.lines().count(),
                "chars": content.chars().count(),
                "preview": preview.join("\n"),
            }))
        }
        _ => None,
    }
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
    if !run_approval_gate(mgr, app, sid, name, args, summary).await {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    execute_connector_tool(attached, app, idx, name, args).await
}

/// MCP-gallery Write tool flagged for approval: register a pending approval,
/// emit `chat:approval-request`, pause on the oneshot until the UI resolves,
/// then forward to the server. Identical flow to `run_gated_connector_tool`.
async fn run_gated_mcp_tool(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    entry: &crate::mcp_gallery::McpToolEntry,
    args: &Value,
) -> String {
    let summary = format!(
        "{} MCP server: {}{}",
        entry.server_name,
        entry.raw_name,
        if args.is_object() && !args.as_object().unwrap().is_empty() {
            format!(" — {}", serde_json::to_string(args).unwrap_or_default())
        } else {
            String::new()
        }
    );
    if !run_approval_gate(mgr, app, sid, &entry.wire_name, args, summary).await {
        return format!(
            "The user denied the {} action ({}). Do not retry it unless the user explicitly asks.",
            entry.raw_name, entry.server_name
        );
    }

    execute_mcp_tool(app, entry, args).await
}

/// Forward a tool call to a gallery MCP server (self-healing the child
/// process if it died since the turn started).
async fn execute_mcp_tool(
    app: &AppHandle,
    entry: &crate::mcp_gallery::McpToolEntry,
    args: &Value,
) -> String {
    match crate::mcp_gallery::call_tool(app, &entry.server_id, &entry.raw_name, args).await {
        Ok(text) => text,
        Err(e) => format!("MCP tool `{}` failed: {e}", entry.raw_name),
    }
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
    // Sessionless connectors (YouTube) carry only fallback tools, so this
    // branch always matched above for them; the None arm is just a guard.
    let Some(session) = &attached[idx].session else {
        return format!(
            "Connector tool `{name}` is unavailable: `{}` has no remote server attached.",
            attached[idx].connector_id
        );
    };
    match session.call_tool(name, args).await {
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
            let path = args
                .get("file_path")
                .or_else(|| args.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("file");
            format!("Write {}", path)
        }
        "read_file" | "read" | "Read" => {
            let path = args
                .get("file_path")
                .or_else(|| args.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("file");
            format!("Read {}", path)
        }
        "run_shell" | "shell" | "RunShell" => {
            let cmd = args
                .get("command")
                .or_else(|| args.get("cmd"))
                .and_then(|v| v.as_str())
                .unwrap_or("command");
            // Truncate long commands (char-safe: the command is model text and
            // may be multibyte — a byte slice here panics mid-turn).
            let short = if cmd.chars().count() > 60 {
                crate::util::truncate_chars(cmd, 57)
            } else {
                cmd.to_string()
            };
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

/// Detect a shell command that only inspects connector / MCP-server
/// availability, returning the refusal text that redirects the model to
/// `get_capabilities` (`None` = not a probe, run it). High-precision by
/// design — the matcher requires BOTH an MCP mention and a probe verb, so
/// config mutations (`claude mcp add x`) and code search (`grep mcp src/`)
/// pass untouched while `claude mcp list`-style probes are stopped before a
/// process spawns.
pub fn capability_probe_refusal(command: &str) -> Option<String> {
    let lower = command.to_ascii_lowercase();
    if !lower.contains("mcp") {
        return None;
    }
    let probe_verb = ["list", "ls ", "status", "which ", "where ", "--version"]
        .iter()
        .any(|k| lower.contains(k));
    if !probe_verb {
        return None;
    }
    Some(
        "Refused: that command inspects connector / MCP-server availability, and \
         availability questions never need a shell process in Relay. Call \
         `get_capabilities` instead — it reports attached and attachable \
         connectors, attached and attachable MCP servers, and enabled built-in \
         tools in one in-process call (read-only, no approval). Re-issue the \
         command only if you need it for a different purpose (e.g. editing MCP \
         config files)."
            .to_string(),
    )
}

/// Execute a system tool (`download_file` / `run_shell` / status / cancel)
/// against the background TaskManager. The permission gate has already
/// decided (or the user approved); these calls either start a task, or read/
/// cancel an existing one, and return text for the model.
async fn execute_system_tool(app: &AppHandle, sid: &str, name: &str, args: &Value) -> String {
    use tools::{CANCEL_TASK, DOWNLOAD_FILE, DOWNLOAD_PROGRESS, GET_TASK_STATUS, RUN_SHELL, TASK};
    let tasks = app.state::<crate::TaskState>();
    let task_id = args
        .get("task_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    match name {
        DOWNLOAD_FILE => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let dest = args
                .get("dest_path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if url.is_empty() {
                return "Error: download_file requires a non-empty \"url\".".to_string();
            }
            if dest.is_empty() {
                return "Error: download_file requires a non-empty \"dest_path\".".to_string();
            }
            let id = tasks.0.start_download(Some(app), sid, url, dest);
            format!(
                "Download started (task {id}) — downloading {url} to {dest} in the background. \
                 Poll get_task_status with task_id=\"{id}\" to track it, and report the final \
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
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if command.is_empty() {
                return "Error: run_shell requires a non-empty \"command\".".to_string();
            }
            // Availability introspection never gets a process: refuse the
            // probe and hand the model to the report that answers it.
            if let Some(refusal) = capability_probe_refusal(command) {
                return refusal;
            }
            let workdir = args.get("workdir").and_then(|v| v.as_str());
            let background = args
                .get("background")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let timeout_secs = args.get("timeout_secs").and_then(|v| v.as_u64());

            // Background / long-running class: task id now, streaming output
            // via get_task_status, killed by cancel_task (or app exit).
            if background {
                let id = tasks
                    .0
                    .start_shell(Some(app), sid, command, workdir, timeout_secs);
                let class = if timeout_secs.is_some() {
                    "temporary (auto-killed at timeout_secs)"
                } else {
                    "long-running (no timeout — cancel_task when done)"
                };
                return format!(
                    "Background shell started (task {id}, {class}) — poll \
                     get_task_status with task_id=\"{id}\" for streamed output, \
                     and cancel_task with that id to kill it. Do not wait \
                     synchronously; report progress to the user as it streams."
                );
            }

            // Foreground: run to completion so the output flows into the turn
            // buffer and persists in the stored message. The sync runner
            // parks on the child, so it must run on the blocking pool —
            // inlining would pin a tokio worker for the whole command (up to
            // the lifecycle ceiling; an explicit timeout_secs may only
            // shorten the run, never extend it).
            let timeout = crate::chat::tasks::foreground_shell_timeout(timeout_secs);
            let cmd_owned = command.to_string();
            let wd_owned = workdir.map(str::to_string);
            tokio::task::spawn_blocking(move || {
                crate::chat::tasks::run_shell_to_completion(
                    &cmd_owned,
                    wd_owned.as_deref(),
                    timeout,
                )
            })
            .await
            .unwrap_or_else(|e| format!("shell task failed: {e}"))
        }
        TASK => {
            // Two modes (June-2026 Claude Code pattern). Foreground (default):
            // the subagent runs to completion inside this tool call and the
            // full text is the tool result — the turn waits. Background
            // (`background: true`): a task id returns immediately; the
            // subagent still streams to the Agents panel via
            // chat:subagent-tokens, the main conversation keeps working, and
            // the result lands in get_task_status (pollable) with the entry
            // finalized to Completed/Failed/Cancelled.
            let background = args
                .get("background")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let prompt = args
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if prompt.is_empty() {
                // The Task chip marker is already streaming into the
                // transcript (the round opens it before the tool executes) —
                // register the panel entry and finalize it as the failure so
                // the Agents pane shows the error instead of an empty list.
                emit_failed_task_panel_entry(app, sid, args, "Task requires a non-empty \"prompt\".");
                return "Error: Task requires a non-empty \"prompt\".".to_string();
            }
            if !background {
                let sub_id = next_subagent_id();
                return run_task_subagent(app, sid, args, &tasks, &sub_id).await;
            }
            let description = args
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("subagent")
                .trim()
                .to_string();
            let mut sub = tasks.0.register_subagent(&description);
            let task_id = sub.task_id.clone();
            let app2 = app.clone();
            let sid2 = sid.to_string();
            let args2 = args.clone();
            let sub_id2 = next_subagent_id();
            tauri::async_runtime::spawn(async move {
                let tasks_state = app2.state::<crate::TaskState>();
                tokio::select! {
                    out = run_task_subagent(&app2, &sid2, &args2, &tasks_state, &sub_id2) => {
                        let failed = out.starts_with("Error");
                        let tail = crate::util::truncate_chars(&out, 400);
                        sub.finish(Some(&app2), &sid2, failed, tail);
                    }
                    _ = &mut sub.cancel_rx => {
                        sub.mark_cancelled(Some(&app2), &sid2);
                        // The dropped future never reaches its
                        // chat:subagent-done arms — finalize the Agents panel
                        // entry here or it spins forever after a cancel.
                        let _ = app2.emit(
                            "chat:subagent-done",
                            crate::types::SubagentDonePayload {
                                chat_session_id: sid2.clone(),
                                id: sub_id2,
                                output: String::new(),
                                error: Some("Cancelled before completion.".to_string()),
                            },
                        );
                    }
                }
            });
            format!(
                "Started background subagent (task {task_id}). Continue the main conversation now;                      poll get_task_status with task_id=\"{task_id}\" (state: running → completed/failed),                      and surface the final message to the user when it finishes. cancel_task aborts it."
            )
        }
        other => format!("Error: unknown system tool \"{other}\"."),
    }
}

/// Mint the Agents-panel id for one Task dispatch (`sub-<ts>-<n>`). The
/// counter suffix is load-bearing: a round's Task calls spawn CONCURRENTLY —
/// subagents created in the same second used to collide on the plain
/// timestamp id and overwrite each other in the frontend store (keyed by id).
fn next_subagent_id() -> String {
    static SUB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let sub_seq = SUB_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("sub-{}-{sub_seq}", crate::db::now_ts())
}

/// Register a Task call's Agents-panel entry and immediately finalize it as
/// the failure. The Task chip marker is already streaming into the transcript
/// (the round opens it before the tool executes), so a bail-out that skipped
/// the spawn emit left the chip on screen with no panel entry — the pane
/// showed "No subagents yet" and the dead chip click read as broken.
fn emit_failed_task_panel_entry(app: &AppHandle, sid: &str, args: &Value, reason: &str) {
    let role = args
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .unwrap_or("agent");
    let task = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let sub_id = next_subagent_id();
    let _ = app.emit(
        "chat:subagent-spawn",
        crate::types::SubagentSpawnPayload {
            chat_session_id: sid.to_string(),
            id: sub_id.clone(),
            role: role.to_string(),
            task: task.to_string(),
            prompt: prompt.to_string(),
            model: None,
            // A bailed-out call never resolved a definition (the failure is
            // exactly why), so there is no subagent to name.
            agent_id: None,
        },
    );
    let _ = app.emit(
        "chat:subagent-done",
        crate::types::SubagentDonePayload {
            chat_session_id: sid.to_string(),
            id: sub_id,
            output: String::new(),
            error: Some(reason.to_string()),
        },
    );
}

/// The subagent's system prompt, composed. Three parts, in this order: the
/// shared preamble, the role/agent instruction, the cwd line, and the tool
/// blurb — which is derived from the run's EFFECTIVE tool set, so the prompt
/// cannot claim a capability the run does not have (or deny one it does).
///
/// `allow = None` is the default: the read-only engine default, whose blurb is
/// the pinned [`SUBAGENT_READ_ONLY_BLURB`]. A definition with an explicit
/// tool list gets a blurb generated from that list instead, and the
/// no-mutation sentence appears only when the set really has no mutating
/// tool.
fn compose_subagent_system_prompt_with_tools(
    instructions: &str,
    cwd_line: &str,
    allow: Option<&HashSet<String>>,
) -> String {
    let blurb = match allow {
        None => SUBAGENT_READ_ONLY_BLURB.to_string(),
        Some(set) => subagent_tool_blurb(set),
    };
    format!(
        "{SUBAGENT_PREAMBLE}{instructions}\n{cwd_line}\n{blurb}"
    )
}

/// The pinned prompt for a run with no definition (or one whose `tools IS
/// NULL`): byte-for-byte the text the inline `format!` produced before subagent
/// agents existed, and pinned by a characterization test.
fn compose_subagent_system_prompt(instructions: &str, cwd_line: &str) -> String {
    compose_subagent_system_prompt_with_tools(instructions, cwd_line, None)
}

/// Tool blurb for a run with an EXPLICIT allowlist. Lists what the run can
/// actually call, and only claims what is true:
///
/// * the tool names come from the effective set, sorted for a stable prompt;
/// * the "ground your answer" sentence rides only when the set can read the
///   workspace or the web;
/// * the source-ledger sentence rides only when the ledger tools are IN the
///   set — telling a subagent to call a tool it does not have is how models
///   start hallucinating tool calls;
/// * the "you CANNOT modify anything" sentence rides only when the set holds
///   no mutating tool. A `workspace_write` agent is told the opposite, and
///   told it plainly.
fn subagent_tool_blurb(allow: &HashSet<String>) -> String {
    let mut names: Vec<&str> = allow.iter().map(String::as_str).collect();
    names.sort_unstable();

    if names.is_empty() {
        // A definition that resolved to no callable tool (an allowlist whose
        // every name was outside the ceiling). Say so rather than print an
        // empty list the model will try to parse as tools.
        return "You have no tools available. Return a self-contained answer for the caller to act on."
            .to_string();
    }
    let mut out = format!("You have these tools: {}.", names.join(", "));
    if allow.iter().any(|n| is_subagent_grounding_tool(n)) {
        out.push_str(
            " Use them to ground your answer in the real workspace or web before answering.",
        );
    }
    if allow.contains(tools::ADD_SOURCE_NOTE) && allow.contains(tools::GET_SOURCE_LEDGER) {
        out.push_str(
            " When researching the web, record each source as you read it with add_source_note \
             (url + fact) and consult get_source_ledger to review what you've recorded.",
        );
    }
    if allow.iter().any(|n| is_subagent_mutating_tool(n)) {
        out.push_str(
            " You MAY modify the workspace: apply the changes the task asks for, using these \
             tools. Writes are limited to the project directory this subagent was given — a \
             path outside it is refused.",
        );
    } else {
        out.push_str(
            " You CANNOT modify anything: if changes are needed, describe the exact edits in \
             your answer instead of applying them.",
        );
    }
    out
}

/// Tools that ground an answer in something real (the workspace, the vault,
/// the web, or the capability report) rather than in the model's memory.
fn is_subagent_grounding_tool(name: &str) -> bool {
    matches!(
        name,
        tools::LIST_DIRECTORY
            | tools::READ_FILE
            | tools::SEARCH_FILES
            | tools::SEARCH_CONTENT
            | tools::VAULT_LIST
            | tools::VAULT_READ
            | tools::VAULT_SEARCH
            | tools::FETCH_URL
            | tools::WEB_SEARCH
            | tools::GET_CAPABILITIES
    )
}

/// Is this tool a workspace mutation? Drives the honest half of the blurb.
fn is_subagent_mutating_tool(name: &str) -> bool {
    crate::chat::subagents::WORKSPACE_WRITE_TOOLS.contains(&name)
}

/// Shared opener — every subagent is told who spawned it before anything
/// role-specific.
const SUBAGENT_PREAMBLE: &str = "You are a focused subagent spawned by the main assistant. ";
/// The cwd line when the chat session has no project bound.
const NO_PROJECT_ROOT_LINE: &str = "No project root is bound to this task.";
/// The blurb for a run with no definition (the read-only default). Extracted
/// verbatim out of the prompt's inline `format!` — the characterization test
/// above is what proves the extraction changed no byte.
const SUBAGENT_READ_ONLY_BLURB: &str = "You have READ-ONLY tools — list_directory, read_file, \
     search_files, search_content, fetch_url, web_search — use them to ground your answer in \
     the real workspace or web before answering. When researching the web, record each source as \
     you read it with add_source_note (url + fact) and consult get_source_ledger to review what \
     you've recorded. You CANNOT modify anything: if changes are needed, describe the exact edits \
     in your answer instead of applying them.";

/// Spawn a streaming sub-turn for the `Task` tool. Resolves the session's
/// provider/model/api_key/base_url from the DB, then applies the subagent-model
/// orchestration pick (explicit `model` tool arg → `chat.subagentModel`
/// setting) so the subagent can run on a different model than the parent —
/// see `chat::subagent_model`. Makes a streaming SSE completion call with the
/// subagent's prompt as the sole user message, and emits each token chunk as
/// `chat:subagent-tokens`. Returns the full accumulated output as the tool
/// result. `sub_id` is the panel id minted by the caller (which also drives
/// the background-cancel finalize).
async fn run_task_subagent(
    app: &AppHandle,
    sid: &str,
    args: &Value,
    _tasks: &crate::TaskState,
    sub_id: &str,
) -> String {
    use crate::chat::providers::AnthropicProvider;
    use crate::secrets;
    use crate::types::{SubagentDonePayload, SubagentSpawnPayload};

    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let role = args
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .unwrap_or("agent")
        .to_string();
    // A bail-out below happens AFTER the Task chip is already streaming but
    // BEFORE the spawn emit — register the panel entry and finalize it as the
    // failure so the pane shows the error instead of an empty list.
    let bail = |reason: &str| -> String {
        emit_failed_task_panel_entry(app, sid, args, reason);
        format!("Error: {reason}")
    };
    if prompt.is_empty() {
        return bail("Task requires a non-empty \"prompt\".");
    }

    // Resolve the subagent definition this call names, if any, and its EFFECTIVE
    // tool set. Two doors (F.5): the explicit `agent` argument (id first,
    // then name, case-insensitive) and `subagent_type` naming a subagent
    // from the dynamic enum. An unmatched `agent` value is NOT an error — the
    // call falls through to the plain role path, so a stale name in a
    // replayed history degrades instead of failing the turn.
    //
    // The effective set is resolved ONCE, here, and threaded to every
    // consumer below (schema filter, execution check, prompt blurb) so they
    // can never disagree about what the run may do. `None` from the resolver
    // means "the engine default" — no definition, `tools IS NULL`, or a
    // definition deleted between the two reads — and that default is the
    // read-only 12.
    let (subagent_def, effective_allow) = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        // A Task dispatch proves the connection works and that the schema may
        // be stale — keep the `Task` enum cache honest from the same place.
        crate::chat::subagents::refresh_registry_cache(&conn);
        let def = resolve_subagent_def(&conn, args);
        let allow = crate::chat::subagents::resolve_allowlist(&conn, def.as_ref())
            .unwrap_or_else(crate::chat::subagents::default_read_only_tools);
        (def, allow)
    };
    // The run's round budget: the definition's, clamped to the loop's own
    // ceiling; the default when there is no definition.
    let max_rounds: usize = subagent_def
        .as_ref()
        .map(|d| d.max_rounds.clamp(1, crate::chat::subagents::MAX_ROUNDS) as usize)
        .unwrap_or(SUBAGENT_MAX_ROUNDS);
    // The hook origin a user rule can be scoped to (F.5): the plain
    // "subagent" for a built-in role, the agent's ID for a subagent run.
    let hook_origin = match subagent_def.as_ref() {
        Some(def) => format!("agent:{}", def.id),
        None => "subagent".to_string(),
    };
    // `def.effort` is stored and deliberately NOT applied here: provider
    // support for a reasoning-effort level is unverified (research doc Part E
    // question 4), and sending an unsupported knob risks a 400.
    //
    // The policy string the hook payload reports, and the sandbox the schema
    // builder runs under. A `workspace_write` definition is the only thing
    // that ever turns mutating specs on for a subagent.
    let sandbox_policy = match subagent_def.as_ref().map(|d| d.sandbox_policy.as_str()) {
        Some("workspace_write") => permission::SandboxPolicy::WorkspaceWrite,
        _ => permission::SandboxPolicy::ReadOnly,
    };

    // Resolve the session's provider + model + key + base_url + project cwd.
    let (provider_str, model_str, project_id) = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        match db::get_chat_session(&conn, sid) {
            Ok(Some(cs)) => (cs.provider, cs.model, cs.project_id),
            _ => return bail("chat session not found."),
        }
    };
    // Resolve the project root (cwd) the subagent operates in, if any. The
    // old system prompt was a generic one-liner with no cwd context — subagents
    // labeled "edit"/"explore" had no idea which codebase they were in.
    let project_path = {
        if let Some(pid) = &project_id {
            let db_state = app.state::<crate::DbState>();
            let conn = db_state.0.lock();
            db::get_project(&conn, pid).ok().flatten().map(|p| p.path)
        } else {
            None
        }
    };
    let api_key = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    let api_key = api_key.unwrap_or_default();
    let base_url = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .ok()
            .flatten()
            .filter(|b| !b.trim().is_empty())
    };
    let model_override = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .ok()
            .flatten()
    };
    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return bail("no model configured."),
        }
    } else if provider_str == "local_gguf" {
        model_override
            .filter(|m| !m.trim().is_empty())
            .unwrap_or(model_str)
    } else {
        model_str
    };

    // Subagent-model orchestration: an explicit `model` tool arg wins, then
    // the Settings pick (`chat.subagentModel`), then the session resolution
    // above. The key check runs AFTER the pick so a cross-provider override
    // is judged by ITS provider's key, not the session's.
    let model_pick = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        crate::chat::subagent_model::pick_for_call(&conn, args)
    };
    let (provider_str, model, api_key, base_url) =
        crate::chat::subagent_model::apply_task_pick(
            app, provider_str, model, api_key, base_url, model_pick,
        );
    if api_key.trim().is_empty() && provider_str != "local_gguf" {
        return bail("no API key configured for this provider.");
    }

    // Where a write-capable run may write. The subagent loop deliberately
    // bypasses the main loop's approval layer (it has no approval surface),
    // so the scope gate has to be re-applied HERE for the mutating tools it
    // can now be granted — otherwise `write_file` would reach any path the OS
    // permits. The project root the task is bound to is the whole sandbox:
    // the same "granted roots" contract `permission::path_within_scope`
    // enforces for the main loop, and a run with no project bound gets none
    // (so every write is refused rather than defaulting to the whole disk).
    let run_ctx = SubagentRunContext {
        allow: effective_allow.clone(),
        sandbox: sandbox_policy,
        max_rounds,
        hook_origin,
        fs_roots: match sandbox_policy {
            permission::SandboxPolicy::WorkspaceWrite => project_path
                .as_deref()
                .map(|p| vec![p.to_string()])
                .unwrap_or_default(),
            _ => Vec::new(),
        },
    };

    // Build a role-aware system prompt. The `role` (subagent_type) enum is now
    // reflected in the instructions instead of being ignored, and the project
    // cwd is injected so the subagent knows which codebase it is operating in.
    //
    // The 7 role instructions live as DATA in `chat::subagent::BUILTIN_ROLES` —
    // the same table `db::subagent`'s builtin seed writes into the registry — so
    // the `Task` schema enum, the registry and this prompt builder cannot
    // drift apart. An unrecognized role keeps the neutral fallback.
    //
    // A SUBAGENT definition's `prompt_md` REPLACES the role instruction when it
    // is non-empty (that is the whole point of a user-written agent: it says
    // what this agent is for). With an empty body it falls back to the role
    // table, so a definition that only tunes tools/rounds still gets sensible
    // instructions. The tool blurb comes from the run's effective allowlist,
    // never from a constant, so the prompt cannot promise a tool the run
    // does not have.
    let role_instructions = subagent_def
        .as_ref()
        .map(|d| d.prompt_md.trim())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .or_else(|| {
            crate::chat::subagents::builtin_role_instruction(role.as_str()).map(str::to_string)
        })
        .unwrap_or_else(|| "Complete the task concisely.".to_string());
    let cwd_line = project_path
        .as_deref()
        .map(|p| format!("You are operating in the project at: {p}"))
        .unwrap_or_else(|| NO_PROJECT_ROOT_LINE.to_string());
    // `None` (the pinned read-only text) only when the run resolved NO
    // definition — an explicit definition always gets a blurb generated from
    // the set it actually resolved, so the two can never disagree.
    let blurb_allow: Option<&HashSet<String>> = subagent_def.as_ref().map(|_| &*effective_allow);
    let system_prompt =
        compose_subagent_system_prompt_with_tools(&role_instructions, &cwd_line, blurb_allow);

    // Emit the spawn event so the frontend creates the subagent immediately
    // (the panel id comes from the caller, which also drives the
    // background-cancel finalize).
    let _ = app.emit(
        "chat:subagent-spawn",
        SubagentSpawnPayload {
            chat_session_id: sid.to_string(),
            id: sub_id.to_string(),
            role: role.clone(),
            task: description.to_string(),
            prompt: prompt.to_string(),
            // The model this subagent actually runs on (post-orchestration) —
            // the Agents panel shows it so a different-model spawn is visible.
            model: Some(model.clone()),
            // The subagent this run resolved, so the panel can label the row
            // with the agent's name. `None` for a built-in role.
            agent_id: subagent_def.as_ref().map(|d| d.id.clone()),
        },
    );

    // Build the streaming request. OpenAI-style providers use /v1/chat/completions;
    // Anthropic uses /v1/messages with a different body shape.
    let is_anthropic = matches!(provider_str.as_str(), "anthropic" | "anthropic_compatible");
    // Local sidecars serialize prompt prefill, so their headers legitimately
    // wait on a busy server — widen the time-to-headers window for them.
    let headers_timeout = crate::chat::reconnect::headers_timeout(provider_str == "local_gguf");
    // B-10: bounded connect; stream reads are guarded by the stall watchdog.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Run-history row for a SUBAGENT run (a definition resolved; the 7 built-in
    // roles keep their pre-subagent behavior and stay out of the history). The
    // Task surface runs the in-process loop, so the row's engine is builtin
    // and its "session" is the PARENT chat — that is where the transcript
    // lives. Settled right after the loop returns: this surface has no idle
    // watcher because the loop is synchronous inside the caller's turn.
    let subagent_run_id = subagent_def.as_ref().and_then(|def| {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        crate::session_fabric::record_subagent_run_start(
            &conn,
            &def.id,
            sid,
            "task",
            prompt,
            "builtin",
            &model,
            None,
        )
    });

    let result: Result<String, String> = if is_anthropic {
        let base = base_url
            .as_deref()
            .unwrap_or(AnthropicProvider::DEFAULT_BASE);
        let url = format!("{base}/v1/messages");
        let mut body = serde_json::json!({
            "model": model,
            "max_tokens": 6144,
            "stream": true,
            "system": system_prompt,
            "messages": [{"role": "user", "content": prompt}],
            // Enable extended thinking so the subagent's reasoning streams to
            // the Agents pane (budget must stay below max_tokens). The
            // thinking blocks are display-only here — they are never echoed
            // back into the follow-up rounds' assistant messages.
            "thinking": {"type": "enabled", "budget_tokens": 2048},
        });
        run_subagent_loop(&client, &url, &api_key, &mut body, app, sid, sub_id, true, headers_timeout, &run_ctx).await
    } else {
        // Audit: compatible/local endpoints REQUIRE a configured base URL —
        // the api.openai.com fallback used to send the user's key and the
        // subagent's prompt to the wrong host. Fail the subagent with a
        // clear error instead (the Err arm below still emits
        // chat:subagent-done, so the Agents pane doesn't hang).
        match subagent_openai_base(&provider_str, base_url.as_deref()) {
            Err(e) => Err(e),
            Ok(base) => {
                let url = format!("{base}/v1/chat/completions");
                let mut body = serde_json::json!({
                    "model": model,
                    "stream": true,
                    "stream_options": {"include_usage": true},
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                    ],
                });
                run_subagent_loop(&client, &url, &api_key, &mut body, app, sid, sub_id, false, headers_timeout, &run_ctx)
                    .await
            }
        }
    };

    // Settle the task-run history row with the loop's real outcome (the
    // finish guard makes this the only settle).
    if let Some(run_id) = &subagent_run_id {
        let (status, summary) = match &result {
            Ok(_) => ("ok", None),
            Err(e) => ("error", Some(crate::util::truncate_chars(e, 240))),
        };
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        crate::db::finish_subagent_run(&conn, run_id, status, summary.as_deref());
    }

    match result {
        Ok(output) => {
            let _ = app.emit(
                "chat:subagent-done",
                SubagentDonePayload {
                    chat_session_id: sid.to_string(),
                    id: sub_id.to_string(),
                    output: output.clone(),
                    error: None,
                },
            );
            output
        }
        Err(e) => {
            let _ = app.emit(
                "chat:subagent-done",
                SubagentDonePayload {
                    chat_session_id: sid.to_string(),
                    id: sub_id.to_string(),
                    output: String::new(),
                    error: Some(e.clone()),
                },
            );
            format!("Error: subagent failed: {e}")
        }
    }
}

/// Tools a subagent may use when NO subagent definition resolved — the same 12
/// read-only names `chat::subagent::BUILTIN_READ_ONLY_TOOLS` pins, which is also
/// the default when a definition's `tools IS NULL`. Enough to ground an
/// answer in the actual workspace/web, no mutation (so no approval card can
/// ever be needed — reads are exempt from the fs scope gate by contract), no
/// browser pane takeover, no background tasks, no spawning.
///
/// Research agents get the full read-side research stack: web_search to find
/// sources, add_source_note/get_source_ledger to record them against the
/// session's ledger (the ledger tools live in the per-session DB, dispatched
/// by `run_ledger_tool` — intercepted in the subagent loop the same way the
/// main tool loop does). `reset_source_ledger` stays EXCLUDED: a subagent
/// must never wipe the session's ledger.
///
/// The list itself now lives in `chat::subagent` (Phase 2 removed this const in
/// favour of that table, so there is exactly one copy to keep honest); the
/// set form is `chat::subagent::default_read_only_tools()`.
/// Max model rounds (tool rounds + final answer) per subagent. Deliberately
/// generous (100): research subagents that read many files per round need
/// room, and each round is a bounded tool batch — the RESULT cap below is
/// what keeps context size in check, not the round count. A subagent definition
/// may lower it (`max_rounds`, clamped to 1..=this).
const SUBAGENT_MAX_ROUNDS: usize = 100;
/// Cap per tool result fed back to the subagent (keeps context bounded).
const SUBAGENT_RESULT_CAP: usize = 6_000;

/// Everything ONE subagent run needs to know about its own permissions,
/// resolved once by `run_task_subagent` and then handed down unchanged to
/// the schema builder, the execution check and the hook pass. One struct
/// rather than four more parameters on three functions: the point is that
/// these four can never disagree about what the run may do.
struct SubagentRunContext {
    /// The run's EFFECTIVE tool set (`chat::subagent::resolve_allowlist`, or the
    /// read-only default).
    allow: Arc<HashSet<String>>,
    /// `WorkspaceWrite` only for a `workspace_write` definition.
    sandbox: permission::SandboxPolicy,
    /// The run's round budget, already clamped to `SUBAGENT_MAX_ROUNDS`.
    max_rounds: usize,
    /// Hook origin: `"subagent"` for a built-in role, `"agent:<id>"` when a
    /// definition resolved (F.5) — the discriminator a per-agent deny rule
    /// will be scoped on in Phase 4.
    hook_origin: String,
    /// The roots a mutating tool call must land in. Empty means "no writes
    /// at all" (the `path_within_scope` contract).
    fs_roots: Vec<String>,
}

/// Spec list for one subagent run, in the provider's format, filtered to the
/// run's effective set.
///
/// The filtering itself is `ToolCaps::allow`, the terminal filter the shared
/// builders apply (see `specs::apply_allow_filter`) — so the OpenAI
/// `/function/name` envelope quirk is handled once, in the builders, instead
/// of a second copy here.
fn subagent_tool_specs(is_anthropic: bool, run: &SubagentRunContext) -> Vec<Value> {
    // research: the default allowlist carries the ledger tools (research
    // fan-out records against the SESSION's ledger — see the allowlist
    // comment), so the subagent registry renders with the research family on
    // even though a subagent never runs "in research mode" itself. A subagent
    // agent that did NOT ask for the ledger tools is still filtered out of
    // the wire schema by `allow` — the family only rides to be available.
    let caps = tools::ToolCaps {
        research: true,
        allow: Some(run.allow.clone()),
        allows_mutating: run.sandbox.allows_mutating_tools(),
        fs_roots: run.fs_roots.clone(),
        ..tools::ToolCaps::default()
    };
    if is_anthropic {
        tools::anthropic_tool_specs(&caps, run.sandbox)
    } else {
        tools::openai_tool_specs(&caps, run.sandbox)
    }
}

/// Execute one subagent tool call, wrapped with the user-hook pass (origin
/// `"subagent"` for a built-in role, `"agent:<id>"` for a subagent run).
/// Subagents can't pause for an approval card of their own — a hook's `ask`
/// degrades to a refusal pointing at the main chat, mirroring how the
/// subagent loop has no other interactive surface.
async fn subagent_run_tool(
    app: &AppHandle,
    sid: &str,
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    run: &SubagentRunContext,
    name: &str,
    args: &Value,
) -> ToolOutcome {
    if crate::hooks::is_exempt(name) {
        return subagent_run_tool_inner(app, sid, client, artifacts_dir, caps, run, name, args).await;
    }
    let mut hook_args = args.clone();
    match crate::hooks::run_pre_tool(
        app,
        Some(sid),
        name,
        &mut hook_args,
        &run.hook_origin,
        run.sandbox.as_db(),
    )
    .await
    {
        crate::hooks::PreVerdict::Deny { reason } => {
            return ToolOutcome::text(format!(
                "Error: `{name}` was blocked by a user hook — {reason}"
            ));
        }
        crate::hooks::PreVerdict::Ask { .. } => {
            return ToolOutcome::text(crate::hooks::refuse_ask(name));
        }
        crate::hooks::PreVerdict::Proceed { .. } => {}
    }
    let outcome =
        subagent_run_tool_inner(app, sid, client, artifacts_dir, caps, run, name, &hook_args).await;
    let text = crate::hooks::run_post_tool(
        app,
        Some(sid),
        name,
        &hook_args,
        outcome.text,
        &run.hook_origin,
        run.sandbox.as_db(),
    )
    .await;
    ToolOutcome { text, ..outcome }
}

/// The execution-time allowlist check, as text. `None` when the call is
/// allowed.
///
/// The refusal STRING is load-bearing: it is the tool result a model reads
/// when it guesses a tool, and models (and the transcripts users read) are
/// calibrated to it. Kept verbatim from the pre-subagent const-filter era.
fn subagent_tool_refusal(allow: &HashSet<String>, name: &str) -> Option<String> {
    if allow.contains(name) {
        return None;
    }
    Some(format!(
        "Error: `{name}` is not available to subagents (read-only tool set). Use one of the listed read-only tools instead."
    ))
}

/// Scope gate for a mutating filesystem call made from inside a subagent.
///
/// The main loop gates these through `permission::check_permission`, which
/// fires an approval card and falls back to a lexical/canonical scope check
/// (`path_within_scope`). A subagent has no approval surface at all, so the
/// card arm is unavailable and the scope arm is the WHOLE gate — it is
/// applied here, per call, before dispatch. `None` means the call is in
/// scope; `Some(text)` is the refusal to return as the tool result.
///
/// Both endpoints of a move/copy are checked: a rename out of the project is
/// a delete from it.
fn subagent_fs_scope_refusal(
    name: &str,
    args: &Value,
    granted_roots: &[String],
) -> Option<String> {
    let arg = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
    let paths: Vec<&str> = match name {
        tools::MOVE_FILE | tools::COPY_FILE => vec![arg("source"), arg("destination")],
        tools::WRITE_FILE | tools::EDIT_FILE | tools::DELETE_FILE => vec![arg("path")],
        _ => Vec::new(),
    };
    for p in paths {
        if p.is_empty() {
            // The tool itself reports the missing argument; not a scope call.
            return None;
        }
        if !permission::path_within_scope(p, granted_roots) {
            return Some(format!(
                "Error: `{name}` is limited to the project this subagent was given. \
Refused: {p} is outside it."
            ));
        }
    }
    None
}

/// The subagent dispatcher proper — allowlist enforcement at execution, then
/// the ledger/vault/web intercepts and the shared `execute_tool`. Wrapped by
/// [`subagent_run_tool`], which owns the user-hook pass.
async fn subagent_run_tool_inner(
    app: &AppHandle,
    sid: &str,
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    run: &SubagentRunContext,
    name: &str,
    args: &Value,
) -> ToolOutcome {
    // Execution-time enforcement of the SAME set the schema advertised. A
    // model can always emit a name that was not in the schema (a replayed
    // history, a confused provider, a stale turn), so this is the check that
    // actually holds.
    if let Some(refusal) = subagent_tool_refusal(&run.allow, name) {
        return ToolOutcome::text(refusal);
    }
    // The scope gate for the mutating tools a `workspace_write` agent can be
    // granted. The main loop's `check_permission` never runs here (a
    // subagent has no approval surface), so this is the only thing standing
    // between a granted `write_file` and the whole filesystem.
    if permission::is_mutating_fs_tool(name) {
        if let Some(refusal) = subagent_fs_scope_refusal(name, args, &run.fs_roots) {
            return ToolOutcome::text(refusal);
        }
    }
    if let Some(result) = run_ledger_tool(app, sid, name, args).await {
        return ToolOutcome::text(result);
    }
    // Vault read trio: dispatched here like the ledger tools. The write trio
    // is not a filesystem tool, so it is NOT scope-gated above — a vault write
    // lands inside the user's own knowledge base, which is what the agent was
    // granted.
    if tools::is_vault_tool(name) {
        return ToolOutcome::text(tools::execute_vault_tool(app, name, args).await);
    }
    if name == tools::WEB_SEARCH || name == tools::FETCH_URL {
        return ToolOutcome::text(
            run_cached_web_tool(client, artifacts_dir, caps, app, sid, name, args).await,
        );
    }
    tools::execute_tool(client, artifacts_dir, caps, name, args, Some(app), Some(sid)).await
}

/// Resolve the subagent definition a `Task` call names, or `None` for a plain
/// built-in-role run.
///
/// Two doors, in this order (F.5):
/// 1. the explicit `agent` argument — matched by id first (an id is
///    unambiguous), then by name, case-insensitively (the registry's own
///    uniqueness rule, so `Doc Writer` and `doc-writer` are one agent);
/// 2. `subagent_type` naming a subagent — the dynamic enum the schema
///    advertises, so the model can pick one by name alone.
///
/// An unmatched value is NOT an error: `None` degrades to the role path
/// (unknown role → the neutral instruction), which is exactly what a replayed
/// history naming a since-deleted agent needs. A model that guessed a name
/// gets an ordinary read-only subagent, not a failed turn.
///
/// A BUILT-IN row never resolves a definition, through either door. Role
/// names are reserved (`validate_name` refuses a custom agent named after
/// one), so a `builtin=1` match is never the user's intent — and keeping it
/// out of the subagent path is what guarantees a role's prompt, tools, rounds and
/// hook origin are byte-identical to the pre-subagent behaviour no matter which
/// argument the model reached for.
fn resolve_subagent_def(
    conn: &rusqlite::Connection,
    args: &Value,
) -> Option<crate::chat::subagents::Subagent> {
    let by_id = |raw: &str| crate::chat::subagents::get(conn, raw);
    let by_name = |raw: &str| crate::db::find_subagent_by_name(conn, raw).ok().flatten();
    let subagent_only = |row: Option<crate::chat::subagents::Subagent>| row.filter(|r| !r.builtin);

    let agent_arg = args
        .get("agent")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(raw) = agent_arg {
        if let Some(row) = subagent_only(by_id(raw).or_else(|| by_name(raw))) {
            return Some(row);
        }
    }
    let role = args
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if role.is_empty() || crate::chat::subagents::is_builtin_role(role) {
        return None;
    }
    subagent_only(by_name(role))
}

/// Stream a subagent completion WITH tools. Runs up to the run's round
/// budget (`run.max_rounds`, itself clamped to `SUBAGENT_MAX_ROUNDS`)
/// streaming rounds: text deltas emit live as `chat:subagent-tokens`; tool
/// calls are announced as `<tool>` markers in the same stream (so the Agents
/// pane renders live activity rows), executed through
/// [`subagent_run_tool`] against the run's effective allowlist, and their
/// results are fed back for the next round. Returns the full accumulated
/// output (text + markers) as the tool result for the MAIN agent.
#[allow(clippy::too_many_arguments)]
async fn run_subagent_loop(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &mut Value,
    app: &AppHandle,
    sid: &str,
    sub_id: &str,
    is_anthropic: bool,
    headers_timeout: std::time::Duration,
    run: &SubagentRunContext,
) -> Result<String, String> {
    use crate::types::SubagentTokenPayload;
    use futures_util::StreamExt;
    use std::collections::BTreeMap;

    let emit = |chunk: &str| {
        let _ = app.emit(
            "chat:subagent-tokens",
            SubagentTokenPayload {
                chat_session_id: sid.to_string(),
                subagent_id: sub_id.to_string(),
                chunk: chunk.to_string(),
            },
        );
    };

    let artifacts_dir = artifacts_dir(app);
    // The per-call caps the web-cache helper reads (`allows_mutating` mirrors
    // the run's sandbox, so `get_capabilities` can never claim a write the run
    // does not have). The tool ALLOWLIST rides `run`, not here — it is the
    // terminal filter inside the spec builders, and the execution check in
    // `subagent_run_tool_inner`.
    let caps = tools::ToolCaps {
        allows_mutating: run.sandbox.allows_mutating_tools(),
        fs_roots: run.fs_roots.clone(),
        ..tools::ToolCaps::default()
    };
    let tool_specs = subagent_tool_specs(is_anthropic, run);
    let has_tools = !tool_specs.is_empty();
    if has_tools {
        if is_anthropic {
            body["tools"] = Value::Array(tool_specs);
        } else {
            body["tools"] = Value::Array(tool_specs);
        }
    }

    let mut output = String::new();

    for round in 0..run.max_rounds {
        let mut req = client
            .post(url)
            .header("content-type", "application/json")
            .json(body);
        if is_anthropic {
            req = req
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_API_VERSION);
        } else {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
        // B-10: bound time-to-headers (a hung subagent request used to hang
        // the whole parent turn).
        let resp = tokio::time::timeout(headers_timeout, req.send())
            .await
            .map_err(|_| {
                format!(
                    "subagent request timed out waiting for response headers ({}s)",
                    headers_timeout.as_secs()
                )
            })?
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let b = resp.text().await.unwrap_or_default();
            return Err(format!(
                "HTTP {status}: {}",
                crate::util::truncate_chars(&b, 500)
            ));
        }

        let mut stream = resp.bytes_stream();
        let mut pending = crate::util::SseLineBuffer::new();
        // Round accumulators.
        let mut round_text = String::new();
        // Reasoning streams display-only into the pane wrapped in
        // <think></think> (the chat view's markup) — never re-sent to the
        // provider, never echoed into the assistant round_text.
        let mut in_think = false;
        // OpenAI: index → (id, name, arguments-json-accumulated).
        let mut oai_calls: BTreeMap<i64, (String, String, String)> = BTreeMap::new();
        // Anthropic: block index → (id, name, partial-json-accumulated).
        let mut ant_calls: BTreeMap<i64, (String, String, String)> = BTreeMap::new();
        // B-11: Anthropic thinking blocks (index → (raw text, signature)).
        // With extended thinking enabled, rounds 2+ MUST echo the thinking
        // block back or the API 400s ("Expected thinking or redacted_thinking
        // …"). These are display-captured separately from `output` (which
        // wraps them in <think> for the pane).
        let mut ant_think: BTreeMap<i64, (String, String)> = BTreeMap::new();

        loop {
            // B-9: same 60s stall watchdog as the main loops — a stuck
            // subagent stream must not wedge the parent turn. No ping target
            // here: a subagent round has no reconnect ladder behind it, so it
            // keeps the flat deadline.
            let chunk = match crate::chat::streaming::stream_next_with_watchdog(
                &mut stream,
                std::time::Duration::from_secs(60),
                None,
            )
            .await
            {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => return Err(e),
            };
            for line in pending.push(&chunk) {
                let line = line.trim_end();
                // B-18: tolerate `data:` without the trailing space.
                let data = match line.strip_prefix("data:").map(|s| s.trim_start()) {
                    Some(d) => d,
                    None => continue,
                };
                if data == "[DONE]" {
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if is_anthropic {
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("error") => {
                            // B-17: fail the subagent on a mid-stream provider
                            // error instead of returning truncated text.
                            let msg = v
                                .pointer("/error/message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("provider returned an error event");
                            return Err(format!("provider error: {msg}"));
                        }
                        Some("content_block_delta") => {
                            let idx = v.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
                            let dtype = v.pointer("/delta/type").and_then(|x| x.as_str());
                            if dtype == Some("thinking_delta") {
                                // Extended-thinking delta: open the <think>
                                // block lazily, stream the reasoning text.
                                if let Some(c) =
                                    v.pointer("/delta/thinking").and_then(|x| x.as_str())
                                {
                                    if !c.is_empty() {
                                        if !in_think {
                                            output.push_str("<think>");
                                            emit("<think>");
                                            in_think = true;
                                        }
                                        // B-11: accumulate raw for the round-2 echo.
                                        ant_think
                                            .entry(idx)
                                            .or_insert_with(|| (String::new(), String::new()))
                                            .0
                                            .push_str(c);
                                        let clean = crate::chat::streaming::sanitize_stream_text(c);
                                        output.push_str(&clean);
                                        emit(&clean);
                                    }
                                }
                            } else if dtype == Some("signature_delta") {
                                // B-11: the signature rides with the thinking
                                // block in the round-2 echo.
                                if let Some(s) =
                                    v.pointer("/delta/signature").and_then(|x| x.as_str())
                                {
                                    ant_think
                                        .entry(idx)
                                        .or_insert_with(|| (String::new(), String::new()))
                                        .1
                                        .push_str(s);
                                }
                            } else if let Some(c) =
                                v.pointer("/delta/text").and_then(|x| x.as_str())
                            {
                                if !c.is_empty() {
                                    if in_think {
                                        output.push_str("</think>");
                                        emit("</think>");
                                        in_think = false;
                                    }
                                    // D6: same hygiene as the reasoning branch
                                    // — raw `c` feeds the round echo, the UI /
                                    // persisted output gets the sanitized text.
                                    round_text.push_str(c);
                                    let clean = crate::chat::streaming::sanitize_stream_text(c);
                                    output.push_str(&clean);
                                    emit(&clean);
                                }
                            }
                            if dtype == Some("input_json_delta") {
                                if let Some(idx) = v.get("index").and_then(|i| i.as_i64()) {
                                    let piece = v
                                        .pointer("/delta/partial_json")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("");
                                    ant_calls
                                        .entry(idx)
                                        .or_insert_with(|| {
                                            (String::new(), String::new(), String::new())
                                        })
                                        .2
                                        .push_str(piece);
                                }
                            }
                        }
                        Some("content_block_start") => {
                            let block = v.pointer("/content_block");
                            if block.and_then(|b| b.get("type")).and_then(|t| t.as_str())
                                == Some("tool_use")
                            {
                                if let Some(idx) = v.get("index").and_then(|i| i.as_i64()) {
                                    let id = block
                                        .and_then(|b| b.get("id"))
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let name = block
                                        .and_then(|b| b.get("name"))
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    ant_calls.insert(idx, (id, name, String::new()));
                                }
                            }
                        }
                        _ => {}
                    }
                } else {
                    // OpenAI-style deltas.
                    // B-17: a mid-stream {"error": …} event fails the round
                    // instead of silently truncating the subagent answer.
                    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("provider returned an error event");
                        return Err(format!("provider error: {msg}"));
                    }
                    // Reasoning-first providers (DeepSeek, OpenRouter
                    // reasoning models) stream `reasoning_content` / `reasoning`
                    // alongside content — wrap in <think> like the main loop.
                    if let Some(r) = v
                        .pointer("/choices/0/delta/reasoning_content")
                        .and_then(|x| x.as_str())
                        .or_else(|| {
                            v.pointer("/choices/0/delta/reasoning")
                                .and_then(|x| x.as_str())
                        })
                    {
                        if !r.is_empty() {
                            if !in_think {
                                output.push_str("<think>");
                                emit("<think>");
                                in_think = true;
                            }
                            let clean = crate::chat::streaming::sanitize_stream_text(r);
                            output.push_str(&clean);
                            emit(&clean);
                        }
                    }
                    if let Some(c) = v
                        .pointer("/choices/0/delta/content")
                        .and_then(|x| x.as_str())
                    {
                        if !c.is_empty() {
                            if in_think {
                                output.push_str("</think>");
                                emit("</think>");
                                in_think = false;
                            }
                            // D6: sanitize like the reasoning branch above —
                            // the OpenAI main round applies the same filter.
                            round_text.push_str(c);
                            let clean = crate::chat::streaming::sanitize_stream_text(c);
                            output.push_str(&clean);
                            emit(&clean);
                        }
                    }
                    if let Some(tcs) = v
                        .pointer("/choices/0/delta/tool_calls")
                        .and_then(|x| x.as_array())
                    {
                        for tc in tcs {
                            let idx = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
                            // Same clamp as the main stream rounds: base URLs
                            // are user-configured (untrusted), and oai_calls
                            // grows one entry per distinct index a hostile or
                            // buggy endpoint sends.
                            if idx < 0
                                || idx as usize > crate::chat::streaming::MAX_STREAM_BLOCK_INDEX
                            {
                                continue;
                            }
                            let entry = oai_calls
                                .entry(idx)
                                .or_insert_with(|| (String::new(), String::new(), String::new()));
                            if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                                if !id.is_empty() {
                                    entry.0 = id.to_string();
                                }
                            }
                            if let Some(n) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                                if !n.is_empty() {
                                    entry.1 = n.to_string();
                                }
                            }
                            if let Some(a) =
                                tc.pointer("/function/arguments").and_then(|x| x.as_str())
                            {
                                entry.2.push_str(a);
                            }
                        }
                    }
                }
            }
        }

        // Round end: a reasoning block that never saw a text delta still
        // needs its closing tag, or the pane renders it open forever.
        if in_think {
            output.push_str("</think>");
            emit("</think>");
            in_think = false;
        }

        // No tool calls → this round's text is the final answer.
        let has_calls = !oai_calls.is_empty() || !ant_calls.is_empty();
        if !has_calls {
            break;
        }
        if round + 1 >= run.max_rounds {
            // Out of rounds — tell the model (and the pane) the loop ends here.
            let note = "\n\n_[Subagent reached its tool-round limit; returning findings so far.]_";
            output.push_str(note);
            emit(note);
            break;
        }

        if is_anthropic {
            // Echo the assistant turn: thinking blocks (B-11 — required when
            // extended thinking is enabled, in block order, BEFORE anything
            // else), then text blocks + tool_use blocks.
            let mut blocks: Vec<Value> = Vec::new();
            for (_idx, (text, sig)) in ant_think.iter() {
                if !text.is_empty() {
                    blocks.push(json!({ "type": "thinking", "thinking": text, "signature": sig }));
                }
            }
            if !round_text.trim().is_empty() {
                blocks.push(json!({ "type": "text", "text": round_text }));
            }
            let mut results: Vec<Value> = Vec::new();
            for (_idx, (id, name, args_acc)) in ant_calls.iter_mut() {
                // Some compatible endpoints emit a tool_use block with no id;
                // echoing `id: ""` made Anthropic reject round 2 (ids are
                // required and must pair with the tool_result). Synthesize
                // one — the same fallback the OpenAI rounds use for id-less
                // calls.
                if id.is_empty() {
                    *id = crate::chat::proto::next_synthetic_tool_id();
                }
                let args = parse_subagent_args(args_acc);
                blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": args }));
                let result =
                    run_subagent_call(&emit, app, sid, client, &artifacts_dir, &caps, run, name, &args)
                        .await;
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result,
                }));
            }
            body["messages"].as_array_mut().map(|m| {
                m.push(json!({ "role": "assistant", "content": blocks }));
                m.push(json!({ "role": "user", "content": results }));
            });
        } else {
            // Echo assistant tool_calls + feed results back (OpenAI format).
            let mut calls_json: Vec<Value> = Vec::new();
            let mut results: Vec<Value> = Vec::new();
            for (_idx, (id, name, args_acc)) in oai_calls.iter() {
                calls_json.push(json!({
                    "id": id, "type": "function",
                    "function": { "name": name, "arguments": args_acc },
                }));
                let args = parse_subagent_args(args_acc);
                let result =
                    run_subagent_call(&emit, app, sid, client, &artifacts_dir, &caps, run, name, &args)
                        .await;
                results.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": result,
                }));
            }
            body["messages"].as_array_mut().map(|m| {
                let mut echo = json!({ "role": "assistant", "tool_calls": calls_json });
                if !round_text.trim().is_empty() {
                    echo["content"] = json!(round_text);
                }
                m.push(echo);
                for r in results {
                    m.push(r);
                }
            });
        }
    }

    if output.trim().is_empty() {
        return Err("subagent produced no output".to_string());
    }
    Ok(output)
}

/// Base URL for an OpenAI-format subagent round. OpenRouter has a fixed
/// endpoint and native OpenAI a well-known default; compatible/local
/// endpoints have NO sensible fallback — a missing base URL is a
/// configuration error, not a reason to hit api.openai.com.
fn subagent_openai_base<'a>(
    provider_str: &str,
    base_url: Option<&'a str>,
) -> Result<&'a str, String> {
    use crate::chat::providers::{OpenAIProvider, OpenRouterProvider};
    match base_url {
        Some(b) => Ok(b),
        None if provider_str == "openrouter" => Ok(OpenRouterProvider::DEFAULT_BASE),
        None if provider_str == "openai" => Ok(OpenAIProvider::DEFAULT_BASE),
        None => Err(format!(
            "no base URL configured for {provider_str}; set one in Settings \u{2192} Connectors"
        )),
    }
}

/// Shared argument-assembly for a subagent tool call: the streamed
/// `arguments` accumulator is raw partial JSON — empty means no arguments.
fn parse_subagent_args(args_acc: &str) -> Value {
    if args_acc.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(args_acc).unwrap_or(json!({}))
    }
}

/// Shared per-call tail of the subagent loop's two format branches: emit the
/// step marker, execute via the subagent wrapper, cap the result, and emit
/// the collapsible output marker. The result text feeds the format-specific
/// tool-result message the caller assembles.
#[allow(clippy::too_many_arguments)]
async fn run_subagent_call<E: Fn(&str) + Sync>(
    emit: &E,
    app: &AppHandle,
    sid: &str,
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    run: &SubagentRunContext,
    name: &str,
    args: &Value,
) -> String {
    let meta = crate::agent_sessions::tool_meta_generic(name, args);
    emit(&format!("<tool>{meta}</tool>"));
    let outcome = subagent_run_tool(app, sid, client, artifacts_dir, caps, run, name, args).await;
    let result = crate::util::truncate_chars(&outcome.text, SUBAGENT_RESULT_CAP);
    emit(&format!(
        "<tool>{}</tool>",
        json!({"kind": "result", "title": "Output", "result": crate::chat::streaming::neutralize_markers(&result)})
    ));
    result
}

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
    if !run_approval_gate(mgr, app, sid, name, args, summary).await {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    execute_system_tool(app, sid, name, args).await
}

/// Human-facing summary for an automation tool approval card. The card is the
/// only guard on create/delete/run-now in the safer modes, so it must name
/// what will change.
fn automation_tool_summary(name: &str, args: &Value) -> String {
    let id = args
        .get("automation_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let label = |v: &Value| {
        v.get("name")
            .and_then(|n| n.as_str())
            .unwrap_or(id)
            .to_string()
    };
    match name {
        tools::CREATE_AUTOMATION => format!(
            "Create automation \"{}\" on schedule \"{}\"",
            label(args),
            args.get("schedule").and_then(|v| v.as_str()).unwrap_or("?")
        ),
        tools::UPDATE_AUTOMATION => format!("Update automation \"{id}\""),
        tools::DELETE_AUTOMATION => format!("Delete automation \"{id}\""),
        tools::RUN_AUTOMATION_NOW => format!("Run automation \"{id}\" now"),
        other => other.to_string(),
    }
}

/// Execute an automation tool that the permission gate flagged for approval.
/// Mirrors `run_gated_system_tool`: register the pending approval, pause on
/// the oneshot until the UI resolves, then run the real handler.
async fn run_gated_automation_tool(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let summary = automation_tool_summary(name, args);
    if !run_approval_gate(mgr, app, sid, name, args, summary).await {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    tools::execute_automation_tool(app, name, args).await
}

/// One-line card summary for a gated subagent call.
fn subagent_tool_summary(name: &str, args: &Value) -> String {
    let id = args
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    match name {
        tools::CREATE_SUBAGENT => format!(
            "Create subagent \"{}\"",
            args.get("name").and_then(|n| n.as_str()).unwrap_or(id)
        ),
        tools::UPDATE_SUBAGENT => format!("Update subagent \"{id}\""),
        tools::DELETE_SUBAGENT => format!("Delete subagent \"{id}\""),
        other => other.to_string(),
    }
}

/// Approval-card wrapper for the subagent write trio — mirrors
/// `run_gated_automation_tool`: authoring or deleting an agent is the moment
/// of consent, in every posture.
async fn run_gated_subagent_tool(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let summary = subagent_tool_summary(name, args);
    if !run_approval_gate(mgr, app, sid, name, args, summary).await {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    tools::execute_subagent_tool(app, name, args).await
}

/// Approval-card wrapper for the mesh write pair (`message_session` /
/// `spawn_session`) — mirrors `run_gated_automation_tool`: the card is the
/// only guard on cross-session token spend, so it stays meaningful under
/// every approval posture that asks.
async fn run_gated_mesh_tool(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let summary = mesh_tool_summary(name, args);
    if !run_approval_gate(mgr, app, sid, name, args, summary).await {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }

    crate::session_fabric::execute_mesh_tool(app, Some(sid), name, args).await
}

/// Approval-card wrapper for the vault write trio — mirrors
/// run_gated_mesh_tool: the card is the only guard when the posture asks
/// (read_only strips the schemas; auto postures never reach here).
async fn run_gated_vault_tool(
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let summary = vault_tool_summary(name, args);
    if !run_approval_gate(mgr, app, sid, name, args, summary).await {
        return format!(
            "The user denied the {name} action. Do not retry it unless the user explicitly asks."
        );
    }
    tools::execute_vault_tool(app, name, args).await
}

/// One-line card summary for a gated vault call.
fn vault_tool_summary(name: &str, args: &Value) -> String {
    let path = args
        .get("path")
        .or_else(|| args.get("from"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    match name {
        tools::VAULT_MOVE => format!(
            "move a vault note ({} → {})",
            path,
            args.get("to").and_then(|v| v.as_str()).unwrap_or("?")
        ),
        tools::VAULT_DELETE => format!("delete the vault note {path} (moves to .trash)"),
        _ => format!("write the vault note {path}"),
    }
}

/// One-line card summary for a gated mesh call.
fn mesh_tool_summary(name: &str, args: &Value) -> String {
    let target = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    match name {
        tools::MESSAGE_SESSION => format!(
            "message another chat session ({target}): \"{}\"",
            args.get("body")
                .or_else(|| args.get("message"))
                .and_then(|v| v.as_str())
                .map(|b| crate::util::truncate_chars(b, 80))
                .unwrap_or_default()
        ),
        tools::SPAWN_SESSION => format!(
            "spawn a new chat session: \"{}\"",
            args.get("task")
                .and_then(|v| v.as_str())
                .map(|t| crate::util::truncate_chars(t, 80))
                .unwrap_or_default()
        ),
        other => format!("{other}"),
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
/// Attach-on-demand meta-tools (`attach_connector` / `attach_mcp_server`).
/// Validates the id against this turn's attachable catalog, connects the
/// source, and hands the live tool table to the turn's tool loop via the
/// manager's late-attach slot — the next round can call the tools directly.
/// Model-driven attaches are TURN-SCOPED on purpose: they are tool discovery,
/// not user intent, so no `chat_session_connectors` row is written and the
/// composer never sprouts chips for sources the model merely probed. The
/// attachable manifest is rebuilt every turn, so a later turn that needs the
/// source again just re-attaches. User-pinned attachments (the composer's
/// @-picker, the send-time keyword fast-path) still persist. Read-kind by
/// design: the source is one the user already connected in Settings, so no
/// approval card gates the attach itself.
async fn run_attach_tool(
    caps: &tools::ToolCaps,
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let is_mcp = name == tools::ATTACH_MCP_SERVER;
    let key = if is_mcp { "server_id" } else { "connector_id" };
    let id = args
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return format!(
            "Error: {name} requires a \"{key}\" argument — pick one from the \
             \"Connected apps & servers\" list in the system prompt."
        );
    }
    // Built-in family unlocks ride the same meta-tool: the id flips the
    // family's per-turn flag (fold_late_attaches picks it up and the round's
    // rebuilt specs admit its tools) instead of connecting a source. Same
    // turn-scoped, read-kind contract — no approval card, no DB row.
    if tools::is_unlockable_family(&id) {
        let display = caps
            .unlockable_families
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| id.clone());
        let already = match id.as_str() {
            tools::FAMILY_SESSION_MESH => caps.session_mesh,
            tools::FAMILY_AUTOMATIONS => caps.automations_write,
            _ => caps.totp,
        };
        if already {
            return format!(
                "{display} is already unlocked — its tools are in your tool list; call them directly."
            );
        }
        if let Some(slot) = mgr.late_attach_slot(sid) {
            slot.lock().families.push(id.clone());
        }
        stream_events::emit_status_reason(
            Some(app),
            sid,
            "connector_attached",
            format!("Unlocked {display}"),
        );
        stream_events::emit_status_clear(Some(app), sid);
        return format!(
            "Unlocked {display}: {} are in your tool list from your next call and \
             stay unlocked for the rest of this turn.",
            tools::family_tool_list(&id)
        );
    }
    let attachable = if is_mcp {
        caps.attachable_mcp.iter().any(|(i, _)| *i == id)
    } else {
        caps.attachable_connectors.iter().any(|(i, _)| *i == id)
    };
    let display = if is_mcp {
        caps.attachable_mcp
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| id.clone())
    } else {
        caps.attachable_connectors
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| id.clone())
    };
    if !attachable {
        let already_attached = if is_mcp {
            caps.mcp_tools.iter().any(|e| e.server_id == id)
        } else {
            caps.attached_connectors
                .iter()
                .any(|c| c.connector_id == id)
        };
        if already_attached {
            return format!("{display} is already attached — its tools are in your tool list; call them directly.");
        }
        return format!(
            "Error: \"{id}\" is not attachable. Use an id from the \"Connected apps & servers\" list."
        );
    }

    // Connect the source (OAuth refresh + tools/list + classify).
    if is_mcp {
        let entries = crate::mcp_gallery::attach_filtered(app, Some(&[id.clone()])).await;
        if entries.is_empty() {
            return format!("Error: MCP server \"{id}\" failed to connect — it may be starting up; try once more.");
        }
        let names: Vec<&str> = entries.iter().map(|e| e.wire_name.as_str()).collect();
        let n = names.len();
        let listing = names.join(", ");
        stream_events::emit_status_reason(
            Some(app),
            sid,
            "connector_attached",
            format!("Attached {display} ({n} tools)"),
        );
        if let Some(slot) = mgr.late_attach_slot(sid) {
            slot.lock().mcp.extend(entries);
        }
        // E-9a: paired clear for the status above — an attach-only tool round
        // streams no model tokens, so the first-token clear never fires and
        // the pill used to stick until the turn ended.
        stream_events::emit_status_clear(Some(app), sid);
        // No DB row: the attach lives only in this turn's late-attach slot,
        // so tool discovery never leaks into the session's pinned set.
        format!("Attached {display} ({n} tools): {listing}")
    } else {
        let attached = crate::connectors::connect_all(app, &[id.clone()]).await;
        let Some(att) = attached.into_iter().next() else {
            return format!(
                "Error: {display} failed to connect — the account may need re-authentication in Settings → Connectors."
            );
        };
        let n = att.tools.len();
        let names: Vec<&str> = att.tools.keys().map(|k| k.as_str()).collect();
        let listing = if names.len() > 30 {
            format!("{} … ({} total)", names[..30].join(", "), n)
        } else {
            names.join(", ")
        };
        stream_events::emit_status_reason(
            Some(app),
            sid,
            "connector_attached",
            format!("Attached {display} ({n} tools)"),
        );
        if let Some(slot) = mgr.late_attach_slot(sid) {
            slot.lock().connectors.push(att);
        }
        // E-9a: paired clear (see the MCP branch).
        stream_events::emit_status_clear(Some(app), sid);
        // Persisted for the session: an explicit attach_connector call is an
        // instruction to make the source available, so its tools ship on every
        // following turn too. Turn-scoping here made turn N+1 silently lose
        // what the model attached in turn N — the model then reported
        // "Gmail shows as connected but this session exposes no Gmail tool",
        // exactly what the manifest/capabilities had led it to expect. The
        // composer chip appearing is the honest UI (removable like any other).
        {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            let _ = crate::db::add_chat_session_connector(&conn, sid, &id);
        }
        format!("Attached {display} ({n} tools): {listing} — attached for the rest of this conversation.")
    }
}

/// Owned-argument `run_tool` wrapper that runs on its own tokio task. Used by
/// the tool loops to fan a round's `Task` calls out CONCURRENTLY: tokio::spawn
/// needs 'static, so everything run_tool borrows is cloned/moved in. Behavior
/// is identical to the inline path (same gating, same marker tail).
pub(crate) fn spawn_run_tool(
    client: reqwest::Client,
    artifacts_dir: std::path::PathBuf,
    caps: std::sync::Arc<tools::ToolCaps>,
    sandbox: permission::SandboxPolicy,
    approval: permission::ApprovalPolicy,
    mgr: Arc<ChatManager>,
    app: AppHandle,
    sid: String,
    name: String,
    args: Value,
) -> tokio::task::JoinHandle<String> {
    let sid_reg = sid.clone();
    let mgr_reg = Arc::clone(&mgr);
    let inner = tokio::spawn(async move {
        run_tool(
            &client,
            &artifacts_dir,
            &caps,
            sandbox,
            approval,
            &mgr,
            &app,
            &sid,
            &name,
            &args,
        )
        .await
    });
    // Register the child so a cancelled (or superseded) turn aborts it —
    // dropping the turn's JoinHandle used to DETACH the subagent loop, which
    // then kept running provider rounds with no way to stop it.
    let inner_id = inner.abort_handle().id();
    mgr_reg.register_child_task(&sid_reg, inner.abort_handle());
    let mgr_reaper = Arc::clone(&mgr_reg);
    let sid_reaper = sid_reg;
    tokio::spawn(async move {
        let result = inner
            .await
            .unwrap_or_else(|e| format!("Error: subagent task failed: {e}"));
        mgr_reaper.unregister_child_task(&sid_reaper, inner_id);
        result
    })
}

/// Public tool entry for the built-in chat loop: user hooks wrap the whole
/// family ladder below. Plan tools are exempt (they ARE a consent surface);
/// every other call — reads and writes, main loop and spawned subagent Tasks
/// alike — passes through here, so one pre/post pair covers the engine.
/// `pre_tool_use` may deny (refusal text), ask (the same approval oneshot the
/// gated families use), or rewrite the args; `post_tool_use` annotates the
/// result text. See `src/hooks.rs` and docs/research/HOOKS_SYSTEM_RESEARCH.md.
pub(crate) async fn run_tool(
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    sandbox: permission::SandboxPolicy,
    approval: permission::ApprovalPolicy,
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    if crate::chat::plan::is_plan_tool(name) || crate::hooks::is_exempt(name) {
        return run_tool_inner(client, artifacts_dir, caps, sandbox, approval, mgr, app, sid, name, args)
            .await;
    }
    let mut hook_args = args.clone();
    let mut pre_note: Option<String> = None;
    match crate::hooks::run_pre_tool(app, Some(sid), name, &mut hook_args, "chat", approval.as_db())
        .await
    {
        crate::hooks::PreVerdict::Deny { reason } => {
            return format!(
                "Error: `{name}` was blocked by a user hook — {reason} The user's hook scripts are \
                 authoritative here; adjust the approach instead of retrying the same call."
            );
        }
        crate::hooks::PreVerdict::Ask { reason } => {
            let summary = format!("User hook asks for approval — {name}: {reason}");
            if !run_approval_gate(mgr, app, sid, name, &hook_args, summary).await {
                return format!(
                    "The user denied the {name} action (asked by a user hook). Do not retry it \
                     unless the user explicitly asks."
                );
            }
        }
        crate::hooks::PreVerdict::Proceed { note } => pre_note = note,
    }

    let result =
        run_tool_inner(client, artifacts_dir, caps, sandbox, approval, mgr, app, sid, name, &hook_args)
            .await;
    let annotated = crate::hooks::run_post_tool(
        app,
        Some(sid),
        name,
        &hook_args,
        result,
        "chat",
        approval.as_db(),
    )
    .await;
    match pre_note {
        Some(note) => format!(
            "{annotated}\n\n[user hook] {}",
            crate::util::truncate_chars(note.trim(), 2_000)
        ),
        None => annotated,
    }
}

/// The family ladder proper — plan gate, browser, ledger, web, automations,
/// vault, memory/mesh, connector/MCP, system, filesystem, then the shared
/// `execute_tool` fallback. Wrapped by [`run_tool`], which owns the user-hook
/// pass.
async fn run_tool_inner(
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    sandbox: permission::SandboxPolicy,
    approval: permission::ApprovalPolicy,
    mgr: &Arc<ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    // Plan-mode gate + plan tools, BEFORE every other family: while a session
    // is in plan mode every mutating tool is refused (reads stay allowed), and
    // the three plan tools dispatch here because they need PlanState and — for
    // present_plan — the shared approval oneshot. Plan mode can only flip
    // inside these handlers (one turn per session), so one read per call is
    // authoritative.
    let plan_mode = {
        let plan = app.state::<crate::chat::plan::PlanState>();
        if crate::chat::plan::is_plan_tool(name) {
            // E-9d: an unknown plan tool returned "" (looked like success).
            // Surface it like every other tool family's error text.
            return crate::chat::plan::run_plan_tool(&plan, mgr, app, sid, name, args)
                .await
                .unwrap_or_else(|| format!("Error: unknown plan tool {name}"));
        }
        plan.plan_mode(sid)
    };
    if let Some(denial) = crate::chat::plan::gate_denial(plan_mode, name) {
        return denial;
    }

    // Agentic browser tools act on the live browser-pane webview, so they run
    // here (where the AppHandle -> BrowserState is available) rather than in
    // the provider-agnostic execute_tool dispatcher.
    if let Some(text) = run_browser_tool(app, name, args, artifacts_dir, sid).await {
        return text;
    }

    // Attach-on-demand meta-tools: connect a connector / MCP server mid-turn
    // and hand its tools to the loop via the late-attach slot. Runs before
    // everything else — no permission gate, no artifacts dir involvement.
    if name == tools::ATTACH_CONNECTOR || name == tools::ATTACH_MCP_SERVER {
        return run_attach_tool(caps, mgr, app, sid, name, args).await;
    }

    // Source-ledger tools read/write the per-session DB ledger, so they run
    // here (where the AppHandle -> DbState is available) rather than in the
    // provider-agnostic execute_tool dispatcher.
    if let Some(text) = run_ledger_tool(app, sid, name, args).await {
        return text;
    }

    // Cached web tools: `web_search` / `fetch_url` hit the SQLite research
    // caches before touching the network, and every search is recorded in the
    // session's query history (repeat-query nudge + audit trail).
    if name == tools::WEB_SEARCH || name == tools::FETCH_URL {
        return run_cached_web_tool(client, artifacts_dir, caps, app, sid, name, args).await;
    }

    // Automation tools (get/list/create/update/delete/run-now) — DB +
    // scheduler via the AppHandle, like the ledger tools above. The reads
    // (list, full get) are read-only and auto-run. Runs execute unattended at
    // full permission by design (an unattended turn can never answer a
    // prompt), so the human gate lives at CONTENT-WRITING time: create/update
    // are approval-carded in EVERY posture including full_auto — an
    // automation must never exist that the user didn't explicitly click yes
    // on. delete keeps the stricter delete_file posture; run_now launches an
    // already-approved automation. Plan mode has already refused the mutating
    // ones above via is_mutating_tool.
    if tools::is_automation_tool(name) {
        let decision = if name == tools::LIST_AUTOMATIONS || name == tools::GET_AUTOMATION {
            permission::PermissionDecision::AutoRun
        } else if name == tools::CREATE_AUTOMATION || name == tools::UPDATE_AUTOMATION {
            // Runs are full_auto by design (product decision 2026-09-13), so
            // authoring one is the moment of consent — no posture bypasses it.
            permission::PermissionDecision::NeedsApproval
        } else if name == tools::DELETE_AUTOMATION {
            if matches!(approval, permission::ApprovalPolicy::FullAccess) {
                permission::PermissionDecision::AutoRun
            } else {
                permission::PermissionDecision::NeedsApproval
            }
        } else if !sandbox.allows_mutating_tools() {
            // Schema-stripped under read_only; a call reaching here anyway
            // fails closed.
            permission::PermissionDecision::NeedsApproval
        } else {
            permission::check_connector_permission(
                sandbox,
                approval,
                permission::ConnectorToolKind::Write,
            )
        };
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_automation_tool(mgr, app, sid, name, args).await;
        }
        return tools::execute_automation_tool(app, name, args).await;
    }

    // Subagent tools (list/create/update/delete agent definitions) — same family
    // shape as automations. The read list auto-runs; authoring/deleting is
    // approval-carded in EVERY posture including full_auto — an agent must
    // never exist (or vanish) that the user did not explicitly click yes on.
    // Plan mode has already refused the mutating ones via is_mutating_tool.
    if tools::is_subagent_tool(name) {
        let decision = if name == tools::LIST_SUBAGENTS {
            permission::PermissionDecision::AutoRun
        } else if name == tools::DELETE_SUBAGENT {
            if matches!(approval, permission::ApprovalPolicy::FullAccess) {
                permission::PermissionDecision::AutoRun
            } else {
                permission::PermissionDecision::NeedsApproval
            }
        } else {
            // create/update: consent at authoring, no posture bypasses it.
            permission::PermissionDecision::NeedsApproval
        };
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_subagent_tool(mgr, app, sid, name, args).await;
        }
        return tools::execute_subagent_tool(app, name, args).await;
    }

    // Vault tools (vault_list/read/search + write/move/delete) — crate::vault
    // via the AppHandle, like the automation and mesh families. The read trio
    // auto-runs everywhere; the write trio follows the connector-write
    // posture (auto under auto_edit/full_auto, approval card otherwise).
    // Plan mode already refused the writes above via is_mutating_tool.
    if tools::is_vault_tool(name) {
        let decision = if !tools::is_vault_write_tool(name) {
            permission::PermissionDecision::AutoRun
        } else if !sandbox.allows_mutating_tools() {
            permission::PermissionDecision::NeedsApproval
        } else {
            permission::check_connector_permission(
                sandbox,
                approval,
                permission::ConnectorToolKind::Write,
            )
        };
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_vault_tool(mgr, app, sid, name, args).await;
        }
        return tools::execute_vault_tool(app, name, args).await;
    }

    // Session Mesh tools (list/read/search sessions + message/spawn) —
    // DB + AgentSessionState/ChatState via the AppHandle, like the automation
    // family above. The read trio auto-runs in every mode; messaging/spawning
    // follow the connector-write posture (approval under read_only/manual,
    // auto-run under auto_edit/full_auto) and are plan-mode-refused upstream
    // via plan::is_mutating_tool. `sid` is the caller identity the runtime
    // needs (self-exclusion, mail routing) — harness callers come through the
    // relay-tools bridge instead, carrying a model-supplied session_id.
    if tools::is_mesh_tool(name) {
        let decision = if tools::is_mesh_write_tool(name)
            && !sandbox.allows_mutating_tools()
        {
            // Schema keeps the write pair visible under read_only (awareness
            // stays useful); a call reaching here fails closed to a card.
            permission::PermissionDecision::NeedsApproval
        } else if tools::is_mesh_write_tool(name) {
            permission::check_connector_permission(
                sandbox,
                approval,
                permission::ConnectorToolKind::Write,
            )
        } else {
            permission::PermissionDecision::AutoRun
        };
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_mesh_tool(mgr, app, sid, name, args).await;
        }
        return crate::session_fabric::execute_mesh_tool(app, Some(sid), name, args).await;
    }

    // Local-docs search: needs the DB (corpora + chunks) and dispatches here
    // rather than in execute_tool; the embedding sidecar is optional (hybrid
    // search degrades to keyword-only when it's down). Gated at the schema
    // level via ToolCaps.local_docs, but we double-check the gate cheaply in
    // case a model calls a removed tool.
    if name == tools::SEARCH_DOCS {
        return run_search_docs_tool(app, name, args).await;
    }

    // Project-wiki tools (§6.15): read-only, DB-only, handled outside
    // execute_tool because they need the AppHandle. Gated at the schema
    // level via ToolCaps.wiki; a call on a wiki-less project gets a clear
    // error rather than a schema ghost.
    if tools::is_wiki_tool(name) {
        return crate::wiki::tools_impl::run_wiki_tool(app, name, args).await;
    }

    // Persistent-memory tools (MEMORY_DESIGN_ARCHITECTURE.md §12.1): DB +
    // session state via the AppHandle, like search_docs above. `memory_save`
    // is async (judge LLM call); recall/forget are sync. Always registered in
    // the schema; a disabled feature returns a clear error to the model.
    if tools::is_memory_tool(name) {
        return run_memory_tool(app, sid, name, args).await;
    }

    // TOTP (2FA) code generation: the seed stays in the keychain / password
    // manager — this handler returns only the current code. Read-only.
    if name == tools::TOTP_CODE {
        return run_totp_tool(app, sid, args).await;
    }

    // Connector-originated tools (OAuth-backed remote MCP tools, e.g. Notion).
    // A matched tool name routes to the vendor's MCP server. Writes are gated
    // per the session's permission mode (approval under read_only/manual,
    // auto-run under auto_edit/full_auto); Reads auto-run. This reuses the
    // SAME approval oneshot as filesystem tools — no parallel gating mechanism.
    if let Some((idx, kind)) = crate::connectors::find_tool(&caps.attached_connectors, name) {
        // Vendor tools aren't covered by the name-based plan gate above — a
        // Write-kind remote tool mutates the connected account, so plan mode
        // refuses it with the same guidance.
        if plan_mode && matches!(kind, permission::ConnectorToolKind::Write) {
            return crate::chat::plan::plan_denial_message(name, "connector");
        }
        let decision = permission::check_connector_permission(sandbox, approval, kind);
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

    // MCP-gallery tools (§3.2.14): user-installed stdio MCP servers, matched
    // by prefixed wire name (`mcp_<server>_<tool>`). Same gating as connector
    // tools — classified Read/Write at attach, Writes approval-gated under
    // read_only/manual — and the same approval oneshot, so there is exactly
    // one gating UX for every remote tool.
    if let Some((_, entry)) = crate::mcp_gallery::find_tool(&caps.mcp_tools, name) {
        // Same plan-mode refusal as connector writes (see above).
        if plan_mode && matches!(entry.kind, permission::ConnectorToolKind::Write) {
            return crate::chat::plan::plan_denial_message(name, "MCP server");
        }
        let decision = permission::check_connector_permission(sandbox, approval, entry.kind);
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_mcp_tool(mgr, app, sid, entry, args).await;
        }
        return execute_mcp_tool(app, entry, args).await;
    }

    // System tools (background downloads + native shell). `download_file` is
    // gated like a connector write (approval under read_only/manual, auto-run
    // under auto_edit/full_auto); `run_shell` is ALWAYS gated (native code
    // execution); status/cancel tools auto-run. The gate decides BEFORE the
    // task starts — the approval card is the only guard on what a download
    // writes to disk, so it stays meaningful.
    if permission::is_system_tool(name) {
        let decision = permission::check_system_permission(sandbox, approval, name);
        // download_file's dest_path can be any absolute path the model chooses;
        // a real download writes to disk the same way write_file does, so
        // enforce the same `fs_roots` containment as the mutating FS tools.
        // Without this gate, a prompt-injected model in AutoEdit/FullAuto
        // could write to startup folders, overwriting trusted binaries on PATH,
        // etc. The check is skipped when fs_roots is empty — the mutating FS
        // tools are already blocked outright with no roots granted, and
        // enforcing containment here would hard-block Manual-mode users from
        // ever seeing the approval card (`path_within_scope` is always false
        // against an empty root list).
        if name == tools::DOWNLOAD_FILE
            && !caps.fs_roots.is_empty()
            && !permission::path_within_scope(&fs_target_path(name, args), &caps.fs_roots)
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
        // An approval rule ("always allow tool + glob") auto-approves past the
        // per-action card. The hard scope-gate below still runs for mutating
        // tools, so a rule can never grant writes outside the enabled/dir
        // scope — it only suppresses the approval prompt.
        let decision = if permission::any_rule_allows(&caps.fs_rules, name, &target) {
            permission::PermissionDecision::AutoRun
        } else {
            permission::check_permission(sandbox, approval, name, &target, &caps.fs_roots)
        };
        if matches!(decision, permission::PermissionDecision::NeedsApproval) {
            return run_gated_fs_tool(
                client, artifacts_dir, caps, mgr, app, sid, name, args,
                approval == permission::ApprovalPolicy::ConfirmEdits,
            )
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

    let outcome = tools::execute_tool(client, artifacts_dir, caps, name, args, Some(app), Some(sid)).await;
    if let Some(a) = outcome.artifact {
        // Persist to the Artifacts sidebar (30-day retention) before notifying
        // the UI. A DB failure must not block the chat, so errors are ignored.
        {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            stream_events::insert_and_emit_artifact(Some(app), &conn, sid, &a.path, &a.filename);
        }
    }
    if let Some(url) = outcome.browse_url {
        // The model just opened a page in the built-in pane: mark the session
        // browser-live so the NEXT round's specs advertise the browser
        // interaction tools (click/type/... were absent at turn start).
        app.state::<crate::ChatState>().0.mark_browser_live(sid);
        let _ = app.emit(
            "chat:open-browser",
            ChatOpenBrowserPayload {
                chat_session_id: sid.to_string(),
                url,
            },
        );
    }
    if let Some(p) = outcome.preview {
        let _ = app.emit(
            "chat:open-preview",
            ChatOpenPreviewPayload {
                chat_session_id: sid.to_string(),
                path: p.path,
                filename: p.filename,
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
    use tools::{
        BROWSER_CLICK, BROWSER_EXTRACT, BROWSER_OBSERVE, BROWSER_READ, BROWSER_SCREENSHOT,
        BROWSER_SCROLL, BROWSER_TYPE, BROWSER_UPLOAD_FILE,
    };
    if !matches!(
        name,
        BROWSER_READ
            | BROWSER_CLICK
            | BROWSER_TYPE
            | BROWSER_SCROLL
            | BROWSER_SCREENSHOT
            | BROWSER_OBSERVE
            | BROWSER_EXTRACT
            | BROWSER_UPLOAD_FILE
    ) {
        return None;
    }
    // Surface the Browser tab so the user can watch the agent work (same
    // auto-open contract as generated artifacts and the harness MCP path).
    // The pane id matters: with it the frontend surfaces/binds THIS pane's
    // chip; the old `null` made the frontend guess the most-recently-used
    // pane, which in a multi-session layout lit up the wrong session's
    // browser. (Key is camelCase — the frontend reads `paneId`.)
    let browser = app.state::<crate::BrowserState>();
    let mgr = browser.0.clone();
    let _ = app.emit(
        "browser:activity",
        serde_json::json!({ "paneId": mgr.active_pane_id() }),
    );
    // Any browser tool use marks the session browser-live (sticky), so the
    // interaction tools stay advertised for the rest of the session.
    app.state::<crate::ChatState>().0.mark_browser_live(sid);

    // Screenshot goes through the CDP execution layer (compositor-rendered,
    // no COM IStream roundtrip) — a blocking main-thread roundtrip, so
    // spawn_blocking as before.
    if name == BROWSER_SCREENSHOT {
        let png = match tokio::task::spawn_blocking(move || mgr.capture_active_png()).await
        {
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
            return Some(format!(
                "browser_screenshot failed: could not save PNG: {e}"
            ));
        }
        let path_str = path.to_string_lossy().into_owned();
        // Deliberately NOT registered as an artifact (is_temp_like_artifact
        // filters the browser-shot- prefix): the shot is the agent's own
        // scaffolding, so it never enters the Artifacts library or pops open
        // the canvas. Embedding it in the reply still works — the inline
        // image reads the file by path.
        return Some(format!(
            "Screenshot saved to {path_str}. To show it inline, embed it in your reply as ![screenshot]({path_str})."
        ));
    }

    let result = match name {
        BROWSER_READ => {
            let mode_str = args.get("mode").and_then(|v| v.as_str()).unwrap_or("full");
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
        BROWSER_UPLOAD_FILE => {
            match (
                args.get("ref").and_then(|v| v.as_i64()),
                args.get("path").and_then(|v| v.as_str()),
            ) {
                (Some(r), Some(path)) => {
                    let mgr2 = std::sync::Arc::clone(&mgr);
                    let path = path.trim().to_string();
                    let dir = artifacts_dir.to_path_buf();
                    match tokio::task::spawn_blocking(move || mgr2.upload_file_active(r, &path, &dir)).await {
                        Ok(res) => res,
                        Err(e) => Err(format!("browser_upload_file failed: {e}")),
                    }
                }
                _ => Err("browser_upload_file requires an integer \"ref\" (from browser_read) and a \"path\" inside the workspace.".to_string()),
            }
        }
        BROWSER_OBSERVE => mgr.observe_active().await,
        BROWSER_EXTRACT => {
            let prompt = args
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if prompt.is_empty() {
                Err(
                    "browser_extract requires a non-empty \"prompt\" (what to look for)."
                        .to_string(),
                )
            } else {
                let max_chars = args
                    .get("max_chars")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(2500)
                    .clamp(200, 20_000) as usize;
                mgr.extract_active(&prompt, max_chars).await
            }
        }
        _ => unreachable!("guarded by matches! above"),
    };
    Some(match result {
        Ok(text) => text,
        Err(e) => format!("{name} failed: {e}"),
    })
}

/// Escalation chain for a degraded `web_search`: the keyless SERP engines are
/// bot-walled (CAPTCHA/403 — an engine-block, not an empty result set) or all
/// errored outright. Re-run the query (1) in the app's own browser pane — a
/// real WebView passes the TLS/header fingerprint checks the plain HTTP
/// scraper fails — and (2) through the keyless Jina Reader, whose
/// server-side headless browser fetches the SERP from different IPs. The
/// merged hits are re-rendered with the escalation engines in the health
/// footer so the model (and the user, via the audit trail) can see where the
/// results actually came from.
async fn escalate_degraded_search(
    client: &reqwest::Client,
    app: &AppHandle,
    query: &str,
    mut outcome: tools::SearchOutcome,
) -> tools::SearchOutcome {
    let mut hits = std::mem::take(&mut outcome.hits);
    let mut status = std::mem::take(&mut outcome.engine_status);
    let mut tag = std::mem::take(&mut outcome.engine_tag);

    // 1. The built-in browser pane.
    let browser_ok = match tools::browser_serp_search(app, query).await {
        Ok(mut h) => {
            let n = h.len();
            hits.append(&mut h);
            status.push(format!("browser-pane ok ({n})"));
            tag.push("browser:ok".to_string());
            true
        }
        Err(e) => {
            status.push(format!("browser-pane FAILED: {e}"));
            tag.push("browser:fail".to_string());
            false
        }
    };

    // 2. Jina Reader SERP — only when the browser sweep didn't deliver.
    if !browser_ok {
        match tools::serp_via_reader(client, query).await {
            Ok(mut h) => {
                let n = h.len();
                hits.append(&mut h);
                status.push(format!("reader ok ({n})"));
                tag.push("reader:ok".to_string());
            }
            Err(e) => {
                status.push(format!("reader FAILED: {e}"));
                tag.push("reader:fail".to_string());
            }
        }
    }

    tools::render_search_results(query, hits, status, tag)
}

/// Cached dispatch for the two network research tools.
///
/// `web_search`: results are served from the SQLite search cache (12 h TTL)
/// when fresh, and every executed search is recorded in the session's query
/// history — a repeat query gets an explicit nudge (research quality rule:
/// each query must explore new ground) and leaves an audit trail either way.
///
/// `fetch_url`: extracted page content is cached per canonical URL (7 day
/// TTL) so re-reading the same source never re-hits the wire. Errors are
/// never cached.
async fn run_cached_web_tool(
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: &tools::ToolCaps,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    let db = app.state::<crate::DbState>();
    match name {
        tools::WEB_SEARCH => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if query.trim().is_empty() {
                return "Error: web_search requires a non-empty \"query\".".to_string();
            }
            let cache_key = format!(
                "q:{}",
                db::content_hash(&format!("v1:{}", query.trim().to_ascii_lowercase()))
            );
            let mut repeat = false;
            {
                let conn = db.0.lock();
                if let Ok(Some(cached)) =
                    db::search_cache_get(&conn, &cache_key, db::SEARCH_CACHE_TTL_SECS)
                {
                    return format!("(cached from earlier this session)\n\n{cached}");
                }
            }
            // BYO-key provider (Settings → search.provider / search.<p>_key)
            // replaces the keyless SERP engines when configured.
            let provider = {
                let conn = db.0.lock();
                tools::configured_provider(&conn)
            };
            // Degraded searches escalate before the model ever sees them:
            // when the SERP engines are bot-walled (CAPTCHA/403 — the
            // anti-bot walls the plain-HTTP scrapers increasingly hit), the
            // same query is re-run in the app's own browser pane (a real
            // WebView passes the fingerprint checks) and, failing that,
            // through the keyless Jina Reader. Escalation re-renders the
            // result list with the extra engines in the health footer, so
            // the model sees WHERE the results came from.
            let outcome = match tools::web_search_with_status(client, query, provider.as_ref())
                .await
            {
                Ok(o) if o.serp_degraded => escalate_degraded_search(client, app, query, o).await,
                Ok(o) => o,
                Err(e) => {
                    // Every engine errored outright — run the fallbacks; if
                    // they produce nothing either, report the original error.
                    let empty = tools::SearchOutcome {
                        text: String::new(),
                        tag: String::new(),
                        hits: Vec::new(),
                        engine_status: vec![format!("(all engines failed: {e})")],
                        engine_tag: Vec::new(),
                        serp_degraded: true,
                    };
                    match escalate_degraded_search(client, app, query, empty).await {
                        o if !o.text.is_empty() => o,
                        _ => return format!("web_search failed: {e}"),
                    }
                }
            };
            let (text, engines_tag) = (outcome.text.clone(), outcome.tag.clone());
            {
                let conn = db.0.lock();
                // Count result lines ("N. title — url") for the audit row.
                let result_count = text
                    .lines()
                    .filter(|l| l.starts_with(|c: char| c.is_ascii_digit()) && l.contains(" — "))
                    .count() as i64;
                if let Ok(already) =
                    db::record_search(&conn, sid, query, &engines_tag, result_count)
                {
                    repeat = already;
                }
                let _ = db::search_cache_put(&conn, &cache_key, &engines_tag, &text);
            }
            if repeat {
                format!(
                    "NOTE: you already ran this exact query earlier in this session. \
                     Each research query should explore NEW ground — rephrase with \
                     different terms unless you are deliberately re-checking.\n\n{text}"
                )
            } else {
                text
            }
        }
        tools::FETCH_URL => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let canonical = db::canonical_url_key(url);
            {
                let conn = db.0.lock();
                if let Ok(Some(cached)) =
                    db::page_cache_get(&conn, &canonical, db::PAGE_CACHE_TTL_SECS)
                {
                    return format!("(cached from earlier this session)\n\n{cached}");
                }
            }
            match tools::fetch_url(client, url).await {
                Ok(text) => {
                    let conn = db.0.lock();
                    let _ = db::page_cache_put(&conn, &canonical, &text);
                    text
                }
                Err(e) => format!("fetch_url failed: {e}"),
            }
        }
        _ => {
            // Guarded by the matches! at the call site; delegate as a fallback.
            tools::execute_tool(client, artifacts_dir, caps, name, args, Some(app), Some(sid))
                .await
                .text
        }
    }
}

/// Dispatch the source-ledger tools (`add_source_note` / `get_source_ledger` /
/// `reset_source_ledger`) against the per-session DB ledger. These need DB
/// access (which the provider-agnostic `execute_tool` does not receive), so
/// they are intercepted here in `run_tool` exactly like the browser tools.
/// Returns `None` for any other tool name so the caller falls through to the
/// normal tool dispatcher.
async fn run_ledger_tool(app: &AppHandle, sid: &str, name: &str, args: &Value) -> Option<String> {
    use tools::{ADD_SOURCE_NOTE, CHECK_SUFFICIENCY, GET_SOURCE_LEDGER, RESET_SOURCE_LEDGER};
    if !matches!(
        name,
        ADD_SOURCE_NOTE | GET_SOURCE_LEDGER | RESET_SOURCE_LEDGER | CHECK_SUFFICIENCY
    ) {
        return None;
    }
    let db = app.state::<crate::DbState>();
    let result: Result<String, String> = {
        let conn = db.0.lock();
        match name {
            ADD_SOURCE_NOTE => {
                let url = args
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let fact = args
                    .get("fact")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let excerpt = args
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let unavailable = args.get("unavailable").and_then(|v| v.as_str());
                let publisher = args
                    .get("publisher")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let published_at = args
                    .get("publishedAt")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if url.is_empty() || fact.is_empty() {
                    return Some(
                        "Error: add_source_note requires a non-empty \"url\" and \"fact\"."
                            .to_string(),
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
                    publisher,
                    published_at,
                ) {
                    Ok(_) => Ok(format!("Recorded source note for {url}.")),
                    Err(e) => Err(format!("add_source_note failed: {e}")),
                }
            }
            // mi5: fetch rows under the lock, serialize AFTER releasing it —
            // serde of the full notes vector under the DB mutex stalled every
            // other DB reader for the duration.
            GET_SOURCE_LEDGER => {
                // mode="compact" returns the claim INDEX without verbatim
                // excerpts (id, url, title, fact, publisher, publishedAt,
                // unavailable) — the local-model context-pressure valve: when
                // the ledger grew past what a small window can hold, synthesis
                // re-reads the index and pulls only the notes it needs.
                let compact = args
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .is_some_and(|m| m == "compact");
                let notes = match db::list_source_notes(&conn, sid) {
                    Ok(n) => n,
                    Err(e) => return Some(format!("get_source_ledger failed: {e}")),
                };
                drop(conn);
                if compact {
                    let index: Vec<serde_json::Value> = notes
                        .iter()
                        .map(|n| {
                            serde_json::json!({
                                "id": n.id,
                                "url": n.url,
                                "title": n.title,
                                "fact": n.fact,
                                "publisher": n.publisher,
                                "publishedAt": n.published_at,
                                "unavailable": n.unavailable,
                            })
                        })
                        .collect();
                    return Some(
                        serde_json::to_string(&index).unwrap_or_else(|_| "[]".to_string()),
                    );
                }
                return Some(serde_json::to_string(&notes).unwrap_or_else(|_| "[]".to_string()));
            }
            RESET_SOURCE_LEDGER => {
                // A fresh research task starts from a clean ledger AND a clean
                // query history — the repeat-query nudge must not fire on
                // queries from the previous task.
                let clear_q = db::clear_searches(&conn, sid).map_err(|e| e.to_string());
                match clear_q
                    .and_then(|_| db::clear_source_notes(&conn, sid).map_err(|e| e.to_string()))
                {
                    Ok(_) => Ok("Source ledger and query history cleared.".to_string()),
                    Err(e) => Err(format!("reset_source_ledger failed: {e}")),
                }
            }
            CHECK_SUFFICIENCY => {
                // Stateless evidence-sufficiency gate: evaluate the model's
                // own declared per-sub-question status against the research
                // quality bars (independent corroboration, opposing views,
                // no unexplained gaps) and tell it exactly what's missing.
                let Some(items) = args.get("subquestions").and_then(|v| v.as_array()) else {
                    return Some(
                        "Error: check_sufficiency requires a \"subquestions\" array.".to_string(),
                    );
                };
                if items.is_empty() {
                    return Some(
                        "Error: check_sufficiency got an empty \"subquestions\" array.".to_string(),
                    );
                }
                let mut insufficient: Vec<String> = Vec::new();
                let mut checked = 0usize;
                for item in items {
                    checked += 1;
                    let question = item
                        .get("question")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(unlabeled sub-question)")
                        .trim();
                    let status = item
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("insufficient")
                        .trim()
                        .to_ascii_lowercase();
                    let independent = item
                        .get("independent_sources")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let opposing = item
                        .get("opposing_view_found")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let gap = item
                        .get("gaps")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let weak =
                        status != "sufficient" || independent < 2 || (!opposing && gap.is_none());
                    if weak {
                        let detail = gap.unwrap_or("no opposing/stale view was looked for");
                        insufficient.push(format!(
                            "“{question}”: {independent} independent source(s), \
                             opposing view {}. Fix before synthesis: {detail}.",
                            if opposing { "found" } else { "missing" }
                        ));
                    }
                }
                if insufficient.is_empty() {
                    Ok(format!(
                        "SUFFICIENT — all {checked} sub-question(s) meet the evidence \
                         bars (≥2 independent sources each, opposing views looked for). \
                         Proceed to synthesis: get_source_ledger → write report → Sources."
                    ))
                } else if items.len() == 1 {
                    Ok(format!("NOT SUFFICIENT — {}", insufficient.join(" ")))
                } else {
                    Ok(format!(
                        "NOT SUFFICIENT — {} of {checked} sub-question(s) fall short:\n- {}",
                        insufficient.len(),
                        insufficient.join("\n- ")
                    ))
                }
            }
            _ => unreachable!("guarded by matches! above"),
        }
    };
    Some(match result {
        Ok(text) => text,
        Err(e) => e,
    })
}

/// Reorder fused hybrid hits by reranker scores. Scored hits lead, ordered by
/// score (best first); hits the reranker didn't score keep their fused order
/// at the end. The sort is stable, so equal scores never shuffle fused ties.
/// Pure function — unit-tested below without any network.
fn apply_rerank_order(
    hits: Vec<crate::db::ChunkHit>,
    reranked: &[(usize, f64)],
) -> Vec<crate::db::ChunkHit> {
    let scores: std::collections::HashMap<usize, f64> = reranked.iter().copied().collect();
    let mut keyed: Vec<(Option<f64>, crate::db::ChunkHit)> = hits
        .into_iter()
        .enumerate()
        .map(|(i, h)| (scores.get(&i).copied(), h))
        .collect();
    keyed.sort_by(|a, b| match (a.0, b.0) {
        (Some(sa), Some(sb)) => sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    keyed.into_iter().map(|(_, h)| h).collect()
}

/// Dispatch the local-docs `search_docs` tool: hybrid retrieval over all
/// enabled corpora — an FTS5 keyword leg fused with the cosine vector leg via
/// Reciprocal Rank Fusion. The embedding sidecar is OPTIONAL: the query is
/// embedded only when the sidecar is up, and a dead sidecar (or a failed
/// embed) degrades cleanly to keyword-only search instead of failing the
/// tool. Image hits include a path citation only (no inline pixels).
///
/// Reranker stage (opt-in `docs.rerank`, default off): when enabled, the
/// reranker sidecar is up, and `top_k > 1`, the fused top-50 is re-scored
/// through the sidecar's `/v1/rerank` and reordered before the final
/// `top_k` cut. The stage lives here (not in db/) because it needs the async
/// HTTP client, and it FAILS OPEN: any rerank failure keeps the fused order.
/// `pub(crate)` because the relay-tools bridge reaches this handler through
/// `tools::execute_tool`'s `SEARCH_DOCS` arm (mcp_tools_bridge advertises
/// `search_docs` and runs the shared dispatcher, so the arm must exist there).
/// The built-in chat keeps its early intercept in `run_tool_inner` above.
pub(crate) async fn run_search_docs_tool(app: &AppHandle, _name: &str, args: &Value) -> String {
    // Parse args.
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if query.is_empty() {
        return "Error: search_docs requires a non-empty \"query\".".to_string();
    }
    let top_k = args
        .get("top_k")
        .and_then(|v| v.as_u64())
        .map(|v| v.min(20).max(1) as usize)
        .unwrap_or(5);

    // Embed the query ONLY when the sidecar is up (one query here). Any
    // failure downgrades to keyword-only — the tool must never fail just
    // because the embedder is off.
    let query_vec: Option<Vec<f32>> =
        match app.try_state::<crate::chat::local_models::LocalModelState>() {
            Some(state) => match state.0.embedding_status() {
                Some(active) => {
                    match crate::chat::local_models::embed_texts(&active.base_url, &[query.to_string()])
                        .await
                    {
                        Ok(v) => v.into_iter().next(),
                        Err(e) => {
                            eprintln!("[docs] query embedding failed, falling back to keyword-only: {e}");
                            None
                        }
                    }
                }
                None => None,
            },
            None => None,
        };

    // The hybrid search scans a cosine leg over ALL indexed chunks (the DB's
    // own doc says so) — hundreds of ms on a large corpus. Run it on the
    // blocking pool like `compute_docs_retrieval` does for the same query:
    // holding the shared DB mutex across that scan on the async runtime
    // stalled every IPC command and stream persist.
    // Each leg is cut at 50 before fusion (top_k is at most 20) — the same
    // width the reranker stage consumes.
    const LEG_LIMIT: usize = 50;
    // Reranker-stage width: when active, keep the full fused top-50 for
    // re-scoring and cut to top_k only afterwards.
    const RERANK_FETCH: usize = 50;
    // Per-document char cap for the rerank call (~400 tokens — the model was
    // fine-tuned at a 1024-token window, so keep query + doc well inside it).
    const RERANK_DOC_CHARS: usize = 1500;

    let db = Arc::clone(&app.state::<crate::DbState>().0);
    let query_owned = query.to_string();

    // Reranker gate: only when the `docs.rerank` setting is on (default
    // "false"), the reranker sidecar is up, and the caller wants more than
    // one hit. Latency-sensitive auto-retrieval (compute_docs_retrieval)
    // never reranks.
    let rerank_base_url = app
        .try_state::<crate::chat::local_models::LocalModelState>()
        .and_then(|s| s.0.reranker_status())
        .map(|a| a.base_url);
    let rerank_on = rerank_base_url.is_some()
        && top_k > 1
        && {
            let conn = db.lock();
            crate::db::get_setting(&conn, "docs.rerank")
                .ok()
                .flatten()
                .as_deref()
                == Some("true")
        };

    // Prompt firewall (§4.1.8): indexed documents are untrusted content —
    // guard each excerpt individually before it becomes a tool result. Mode
    // is read up front: `db` moves into the spawn_blocking search below.
    let firewall_mode = {
        let conn = db.lock();
        crate::prompt_firewall::mode_from_db(&conn)
    };

    let hits = match tokio::task::spawn_blocking(move || {
        let conn = db.lock();
        crate::db::search_chunks_hybrid(
            &conn,
            &query_owned,
            query_vec.as_deref(),
            None,
            LEG_LIMIT,
            if rerank_on { RERANK_FETCH } else { top_k },
        )
    })
    .await
    {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => return format!("search_docs search failed: {e}"),
        Err(e) => return format!("search_docs search task failed: {e}"),
    };

    if hits.is_empty() {
        return "No local documents matched your query.".to_string();
    }

    // Reranker stage: one /v1/rerank call over the fused hits' content
    // (truncated — see RERANK_DOC_CHARS), reorder by returned scores, then
    // cut to top_k. Fail-open: ANY failure (sidecar down mid-flight, HTTP
    // error, parse error) keeps the fused order — one diagnostic line.
    // Docs are passed in their enriched form (path · heading + content, the
    // same input the embedder saw) so the reranker judges the chunk in its
    // section context, not as free-floating text.
    let hits = if rerank_on {
        let documents: Vec<String> = hits
            .iter()
            .map(|h| {
                crate::util::truncate_chars(
                    &crate::chat::docs::enriched_embed_text(&h.path, &h.heading, &h.content),
                    RERANK_DOC_CHARS,
                )
            })
            .collect();
        match crate::chat::local_models::rerank_texts(
            rerank_base_url.as_deref().unwrap_or_default(),
            crate::chat::local_models::RERANKER_MODEL_KEY,
            query,
            &documents,
        )
        .await
        {
            Ok(scores) => apply_rerank_order(hits, &scores)
                .into_iter()
                .take(top_k)
                .collect(),
            Err(e) => {
                eprintln!("[docs] rerank failed, keeping fused order: {e}");
                hits
            }
        }
    } else {
        hits
    };

    // Format hits. Cap per-chunk content at 800 chars and the whole response at
    // ~6k chars so a single tool result can't blow out the context window.
    const MAX_CHUNK: usize = 800;
    const MAX_TOTAL: usize = 6_000;
    let mut out = String::new();
    for (i, hit) in hits.iter().enumerate() {
        let tag = if hit.kind == "image" {
            // Image surrogate — give the model a citation to open rather than
            // embedding the surrogate verbatim (which is a generated caption,
            // not what the pixels show).
            format!(
                "[{}] {}  ·  image  ·  score={:.3}\n(Use read_file to view this image locally.)",
                i + 1,
                hit.path,
                hit.score,
            )
        } else {
            // Heading enrichment: situate the excerpt with a `path · heading`
            // first line when the chunk carries a markdown heading trail.
            let locator = if hit.heading.is_empty() {
                hit.path.clone()
            } else {
                format!("{} · {}", hit.path, hit.heading)
            };
            // Char-safe cap — a byte slice panics mid-codepoint (B-1), and
            // this runs inline in the tool loop, killing the whole turn.
            let content = if hit.content.chars().count() > MAX_CHUNK {
                format!("{}…", crate::util::truncate_chars(&hit.content, MAX_CHUNK))
            } else {
                hit.content.clone()
            };
            let content = crate::prompt_firewall::guard(firewall_mode, &content);
            format!(
                "[{}] {}  ·  {}  ·  score={:.3}\n{}",
                i + 1,
                locator,
                hit.kind,
                hit.score,
                content,
            )
        };
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&tag);
        if out.len() > MAX_TOTAL {
            break;
        }
    }

    out
}

#[cfg(test)]
mod tests {

    /// Confirm-edits (§4.2.5): the card preview is computed from the REAL
    /// file, not the model's claims — occurrences carry 1-based indexes and
    /// the line each match starts on.
    #[test]
    fn edit_preview_lists_occurrences_with_line_numbers() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("code.rs");
        std::fs::write(&path, "fn one() {}\nlet x = TODO;\nfn two() {}\nlet y = TODO;").unwrap();
        let preview = build_edit_preview(
            "edit_file",
            &serde_json::json!({
                "path": path.to_str().unwrap(),
                "find": "TODO",
                "replace": "done()",
            }),
        )
        .expect("edit preview");
        assert_eq!(preview["kind"], "edit");
        assert_eq!(preview["totalOccurrences"], 2);
        let occ = preview["occurrences"].as_array().unwrap();
        assert_eq!(occ.len(), 2);
        assert_eq!(occ[0]["index"], 1);
        assert_eq!(occ[0]["line"], 2);
        assert_eq!(occ[1]["index"], 2);
        assert_eq!(occ[1]["line"], 4);
        assert!(occ[0]["context"].as_str().unwrap().contains("TODO"));

        // write_file preview: exists-flag + bounded content preview.
        let preview = build_edit_preview(
            "write_file",
            &serde_json::json!({
                "path": path.to_str().unwrap(),
                "content": "l1\nl2\nl3",
            }),
        )
        .expect("write preview");
        assert_eq!(preview["kind"], "write");
        assert_eq!(preview["exists"], true);
        assert_eq!(preview["lines"], 3);
        assert!(preview["preview"].as_str().unwrap().starts_with("l1"));

        // A find with no matches yields no preview (plain card fallback).
        assert!(build_edit_preview(
            "edit_file",
            &serde_json::json!({
                "path": path.to_str().unwrap(),
                "find": "nope-not-there",
                "replace": "x",
            }),
        )
        .is_none());
    }

    use super::*;

    /// CHARACTERIZATION (written before the subagent refactor, pinned against the
    /// prompt the inline `format!` produced): a built-in role's composed
    /// system prompt is byte-identical to the pre-subagent text, with a project
    /// root bound. The three consts below are that text, split out of the
    /// `format!` WITHOUT retyping a character — this test is the guard that
    /// the extraction was a no-op.
    #[test]
    fn builtin_role_prompt_is_byte_identical_to_the_pre_subagent_text() {
        let role = "explore";
        let prompt = compose_subagent_system_prompt(
            crate::chat::subagents::builtin_role_instruction(role).unwrap(),
            "You are operating in the project at: C:\\work\\repo",
        );
        let expected = concat!(
            "You are a focused subagent spawned by the main assistant. ",
            "Your job is to explore the codebase and report findings: file paths, key symbols, and how things connect. Do not propose edits.\n",
            "You are operating in the project at: C:\\work\\repo\n",
            "You have READ-ONLY tools — list_directory, read_file, search_files, search_content, fetch_url, web_search — use them to ground your answer in the real workspace or web before answering. When researching the web, record each source as you read it with add_source_note (url + fact) and consult get_source_ledger to review what you've recorded. You CANNOT modify anything: if changes are needed, describe the exact edits in your answer instead of applying them."
        );
        assert_eq!(prompt, expected);
    }

    /// The same guard with no project root: the cwd line degrades to the
    /// "no project root" sentence, nothing else moves.
    #[test]
    fn builtin_role_prompt_without_a_project_root_is_also_byte_identical() {
        let role = "test";
        let prompt = compose_subagent_system_prompt(
            crate::chat::subagents::builtin_role_instruction(role).unwrap(),
            NO_PROJECT_ROOT_LINE,
        );
        let expected = format!(
            "{SUBAGENT_PREAMBLE}{}\n{NO_PROJECT_ROOT_LINE}\n{SUBAGENT_READ_ONLY_BLURB}",
            crate::chat::subagents::builtin_role_instruction(role).unwrap()
        );
        assert_eq!(prompt, expected);
        assert!(prompt.contains(NO_PROJECT_ROOT_LINE));
    }

    /// CONTRACT (the pre-subagent invariant, generalized -- C.4): the subagent
    /// loop bypasses the main loop's permission layer (no approval cards by
    /// design), so the effective tool set IS the permission boundary. Three
    /// properties, checked under both policies:
    ///
    /// 1. no spawn-capable tool is reachable in ANY effective set -- depth
    ///    stays 1 whatever a definition asks for;
    /// 2. mutating tools appear only when the definition's own policy is
    ///    `workspace_write` -- a stored allowlist can narrow the ceiling,
    ///    never widen past the policy it was granted;
    /// 3. with no definition the effective set is exactly today's 12 names.
    #[test]
    fn subagent_effective_allowlist_holds_the_depth_and_policy_invariants() {
        const SPAWN_CAPABLE: [&str; 5] = [
            "Task",
            tools::RUN_SHELL,
            tools::SPAWN_SESSION,
            tools::MESSAGE_SESSION,
            tools::RUN_CODE,
        ];
        let conn = crate::db::mem();
        let input = |name: &str, tools_json: &str, sandbox: &str| {
            crate::chat::subagents::SubagentInput {
                name: name.into(),
                description: String::new(),
                prompt_md: String::new(),
                tools: Some(tools_json.into()),
                engine: None,
                model: None,
                effort: None,
                sandbox_policy: sandbox.into(),
                approval_policy: "on_request".into(),
                worktree_policy: "inherit".into(),
                max_rounds: 10,
                max_concurrent: 2,
            }
        };

        // (1)+(2): an explicit list under each policy, asking for everything
        // including every spawn-capable tool.
        let greedy = r#"["read_file","write_file","delete_file","vault_write","Task","run_shell","spawn_session","message_session","run_code","not_a_tool"]"#;
        for (slug, sandbox, expect_write) in [
            ("greedy-reader", "read_only", false),
            ("greedy-writer", "workspace_write", true),
        ] {
            let def = crate::chat::subagents::create(&conn, &input(slug, greedy, sandbox)).unwrap();
            let set =
                crate::chat::subagents::resolve_allowlist(&conn, Some(&def)).expect("explicit list");
            for name in SPAWN_CAPABLE {
                assert!(
                    !set.contains(name),
                    "{name} must stay unreachable under {sandbox}: depth is 1"
                );
            }
            assert!(set.contains(tools::READ_FILE));
            assert!(!set.contains("not_a_tool"), "unknown names drop out");
            assert_eq!(
                set.contains(tools::WRITE_FILE),
                expect_write,
                "a mutating tool follows the definition's own policy ({sandbox})"
            );
            assert_eq!(
                set.contains(tools::VAULT_WRITE),
                expect_write,
                "vault writes follow the same policy ({sandbox})"
            );
        }

        // (3): no definition = no registry set = today's 12 read-only names.
        let dflt = crate::chat::subagents::default_read_only_tools();
        let mut got: Vec<&str> = dflt.iter().map(String::as_str).collect();
        got.sort_unstable();
        let mut want: Vec<&str> = crate::chat::subagents::BUILTIN_READ_ONLY_TOOLS.to_vec();
        want.sort_unstable();
        assert_eq!(got, want, "the default effective set must not drift");
        assert!(dflt.contains(tools::READ_FILE));
        assert!(dflt.contains(tools::FETCH_URL));
        for name in SPAWN_CAPABLE {
            assert!(!dflt.contains(name), "{name} in the default set");
        }
        for name in crate::chat::subagents::WORKSPACE_WRITE_TOOLS {
            assert!(!dflt.contains(name), "{name} is mutating");
        }
    }

    /// `tools IS NULL` (and a definition deleted between resolution and use)
    /// both fall back to the engine default, so "just the usual read-only
    /// set" stays a single field edit.
    #[test]
    fn subagent_null_tool_list_falls_back_to_the_default() {
        let conn = crate::db::mem();
        let def = crate::chat::subagents::create(
            &conn,
            &crate::chat::subagents::SubagentInput {
                name: "planner".into(),
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
            },
        )
        .unwrap();
        assert!(crate::chat::subagents::resolve_allowlist(&conn, Some(&def)).is_none());
    }

    /// The execution check refuses a tool outside the effective set with the
    /// SAME string it has always used -- a refusal a model reads is not text
    /// we get to change quietly.
    #[test]
    fn subagent_execution_check_keeps_its_refusal_text() {
        let dflt = crate::chat::subagents::default_read_only_tools();
        let expected = format!(
            "Error: `{}` is not available to subagents (read-only tool set). \
Use one of the listed read-only tools instead.",
            tools::RUN_SHELL
        )
        .replace(" @", "");
        assert_eq!(
            subagent_tool_refusal(&dflt, tools::RUN_SHELL).as_deref(),
            Some(expected.as_str())
        );
        assert!(subagent_tool_refusal(&dflt, tools::READ_FILE).is_none());
    }

    /// A definition's round budget is clamped, not trusted: zero rounds would
    /// make the agent unable to answer at all, and an unbounded value would
    /// let one `Task` call spend a fortune.
    #[test]
    fn subagent_max_rounds_clamps_to_the_loop_ceiling() {
        let clamp = |raw: i64| raw.clamp(1, crate::chat::subagents::MAX_ROUNDS) as usize;
        assert_eq!(clamp(500), SUBAGENT_MAX_ROUNDS);
        assert_eq!(clamp(0), 1);
        assert_eq!(clamp(-3), 1);
        assert_eq!(clamp(40), 40);
        assert_eq!(SUBAGENT_MAX_ROUNDS as i64, crate::chat::subagents::MAX_ROUNDS);
    }

    /// A `workspace_write` definition may write INSIDE the project it was
    /// given and nowhere else. The subagent loop has no approval card, so
    /// this scope check is the only gate between a granted `write_file` and
    /// the rest of the disk.
    #[test]
    fn subagent_write_scope_is_the_project_root() {
        let roots = vec!["C:/work/repo".to_string()];
        let inside = json!({"path": "C:/work/repo/src/main.rs"});
        let outside = json!({"path": "C:/Windows/System32/etc/hosts"});
        assert!(subagent_fs_scope_refusal(tools::WRITE_FILE, &inside, &roots).is_none());
        let refusal = subagent_fs_scope_refusal(tools::WRITE_FILE, &outside, &roots)
            .expect("a path outside the project is refused");
        assert!(refusal.contains("outside it"), "{refusal}");
        // No project bound -> no roots -> every write is refused.
        assert!(subagent_fs_scope_refusal(tools::WRITE_FILE, &inside, &[]).is_some());
        // move/copy check BOTH ends.
        let escape = json!({"source": "C:/work/repo/a.txt", "destination": "C:/tmp/a.txt"});
        assert!(subagent_fs_scope_refusal(tools::MOVE_FILE, &escape, &roots).is_some());
        // Reads stay unscoped (the documented read exemption).
        assert!(subagent_fs_scope_refusal(tools::READ_FILE, &outside, &roots).is_none());
    }

    /// A subagent definition's composed prompt says what the run can ACTUALLY do
    /// -- the whole reason the blurb is generated from the effective set
    /// rather than kept as a constant.
    #[test]
    fn subagent_prompt_uses_its_body_and_its_real_tool_set() {
        let instructions = "You are the release notes writer.";
        let cwd = "You are operating in the project at: C:/work/repo";
        let set = |names: &[&str]| -> HashSet<String> {
            names.iter().map(|s| (*s).to_string()).collect()
        };
        let prompt = compose_subagent_system_prompt_with_tools(
            instructions,
            cwd,
            Some(&set(&[tools::READ_FILE, tools::WRITE_FILE, tools::EDIT_FILE])),
        );
        assert!(prompt.contains(instructions), "the custom body is used");
        assert!(prompt.contains(cwd), "the cwd line is appended");
        assert!(
            !prompt.to_lowercase().contains("cannot modify anything"),
            "a write-capable run must not be told it cannot write:\n{prompt}"
        );
        assert!(prompt.contains("MAY modify the workspace"), "{prompt}");
        for t in [tools::WRITE_FILE, tools::EDIT_FILE, tools::READ_FILE] {
            assert!(prompt.contains(t), "{t} missing from the blurb:\n{prompt}");
        }
        // The ledger hint rides the ledger tools only.
        assert!(
            !prompt.contains("get_source_ledger"),
            "no ledger tools in the set -> no ledger instruction:\n{prompt}"
        );
        let ledger_run = set(&[tools::READ_FILE, tools::GET_SOURCE_LEDGER, tools::ADD_SOURCE_NOTE]);
        let with_ledger =
            compose_subagent_system_prompt_with_tools(instructions, cwd, Some(&ledger_run));
        assert!(with_ledger.contains("get_source_ledger"), "{with_ledger}");
        // ...and that same read-only set keeps the no-mutation sentence.
        assert!(with_ledger.contains("CANNOT modify anything"), "{with_ledger}");
        assert!(!with_ledger.contains("MAY modify"), "{with_ledger}");
    }

    /// `resolve_subagent_def` is the only place that decides what a `Task` call
    /// may become: id before name, case-insensitive name, a built-in role
    /// never resolving a definition, and an unknown name degrading rather
    /// than failing the turn.
    #[test]
    fn subagent_def_resolution_prefers_id_then_name_and_never_fails_a_call() {
        let conn = crate::db::mem();
        let def = crate::chat::subagents::create(
            &conn,
            &crate::chat::subagents::SubagentInput {
                name: "doc-writer".into(),
                description: String::new(),
                prompt_md: "Write the docs.".into(),
                tools: None,
                engine: None,
                model: None,
                effort: None,
                sandbox_policy: "read_only".into(),
                approval_policy: "on_request".into(),
                worktree_policy: "inherit".into(),
                max_rounds: 10,
                max_concurrent: 2,
            },
        )
        .unwrap();
        let call = |v: Value| resolve_subagent_def(&conn, &v).map(|d| d.id);

        assert_eq!(
            call(json!({"agent": def.id, "subagent_type": "explore"})),
            Some(def.id.clone()),
            "an id wins over the role"
        );
        assert_eq!(
            call(json!({"agent": "DOC-WRITER", "subagent_type": "explore"})),
            Some(def.id.clone()),
            "names match case-insensitively (spaces/hyphens normalize at write time)"
        );
        assert_eq!(
            call(json!({"subagent_type": "DOC-WRITER"})),
            Some(def.id.clone()),
            "the dynamic enum path resolves by name"
        );
        for role in crate::chat::subagents::BUILTIN_ROLES {
            assert!(
                call(json!({"subagent_type": role.name})).is_none(),
                "role {} must not resolve a def",
                role.name
            );
            // ...through the `agent` door either: a reserved role name is
            // never the user's intent, and the role path stays byte-identical.
            assert!(
                call(json!({"agent": role.name, "subagent_type": "agent"})).is_none(),
                "role {} must not resolve a def via `agent`",
                role.name
            );
            assert!(
                call(json!({"agent": format!("builtin-{}", role.name)})).is_none(),
                "seeded id {} must not resolve a def",
                role.name
            );
        }
        // Unknown values degrade (a replayed history with a deleted agent).
        assert!(call(json!({"agent": "ghost", "subagent_type": "explore"})).is_none());
        assert!(call(json!({"subagent_type": "nonsense"})).is_none());
        assert!(call(json!({})).is_none());
    }

    #[test]
    fn subagent_base_url_is_required_for_compatible_providers() {
        // Audit: compatible/local endpoints fell back to api.openai.com when
        // no base URL was configured — sending the user's key and the
        // subagent's prompt to the wrong host. OpenRouter and native OpenAI
        // keep their defaults; everything else must be a clear error.
        assert!(subagent_openai_base("openai", None).is_ok());
        assert!(subagent_openai_base("openrouter", None).is_ok());
        let err = subagent_openai_base("openai_compatible", None).unwrap_err();
        assert!(err.contains("no base URL configured"), "{err}");
        let err = subagent_openai_base("local_gguf", None).unwrap_err();
        assert!(err.contains("local_gguf"), "{err}");
        // A configured base URL always wins.
        assert_eq!(
            subagent_openai_base("openai_compatible", Some("http://127.0.0.1:8999")).unwrap(),
            "http://127.0.0.1:8999"
        );
    }

    // ---- reranker reorder-merge (run_search_docs_tool stage) ----

    fn hit(path: &str) -> crate::db::ChunkHit {
        crate::db::ChunkHit {
            corpus_id: "c".into(),
            path: path.into(),
            kind: "text".into(),
            content: String::new(),
            heading: String::new(),
            score: 0.0,
        }
    }

    #[test]
    fn rerank_order_puts_scored_hits_first_missing_keep_fused_order_at_end() {
        // Fused order a,b,c,d. Reranker scores b best, d second; a and c are
        // unscored → they trail in their original fused order.
        let fused = vec![hit("a"), hit("b"), hit("c"), hit("d")];
        let out = apply_rerank_order(fused, &[(1, 0.9), (3, 0.1)]);
        let paths: Vec<_> = out.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["b", "d", "a", "c"]);
    }

    #[test]
    fn rerank_order_ignores_out_of_range_indexes_and_keeps_ties_stable() {
        let fused = vec![hit("a"), hit("b")];
        // Index 9 doesn't exist (server bug) → ignored; equal scores keep the
        // fused order for the scored pair.
        let out = apply_rerank_order(fused, &[(9, 0.5), (0, 0.5), (1, 0.5)]);
        let paths: Vec<_> = out.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["a", "b"]);
    }

    #[test]
    fn rerank_order_with_no_scores_is_identity() {
        let fused = vec![hit("a"), hit("b"), hit("c")];
        let out = apply_rerank_order(fused.clone(), &[]);
        assert_eq!(out.len(), 3);
        assert!(out.iter().zip(fused.iter()).all(|(o, f)| o.path == f.path));
    }

    // ---- run_shell availability-probe guard ----

    #[test]
    fn probe_guard_refuses_mcp_listing_probes() {
        for cmd in [
            "claude mcp list",
            "claude mcp list --json",
            "kimi mcp list",
            "opencode mcp status",
            "which mcp",
            "where mcp",
            "claude --version mcp",
            "ls mcp.json",
            "npm ls mcp-server-memory",
        ] {
            let refusal = capability_probe_refusal(cmd);
            assert!(refusal.is_some(), "must refuse: {cmd}");
            assert!(
                refusal.unwrap().contains("get_capabilities"),
                "refusal must redirect to the report: {cmd}"
            );
        }
    }

    #[test]
    fn probe_guard_passes_real_work() {
        for cmd in [
            "claude mcp add my-server -- npx -y @acme/server",
            "grep -rn mcp src/",
            "npm run dev",
            "git status",
            "git stash list",
            "python gen_mcp_docs.py",
            "echo mcp > out.txt",
            "claude --version",
            "node server.js",
        ] {
            assert!(capability_probe_refusal(cmd).is_none(), "must pass: {cmd}");
        }
    }
}

/// Dispatch the persistent-memory tools (MEMORY_DESIGN_ARCHITECTURE.md §12.1).
/// `memory_save` runs the judge LLM call (async); `memory_recall` runs an
/// FTS/recency search synchronously; `memory_forget` retires by id. All three
/// degrade to explanatory errors when the feature is toggled off.
async fn run_memory_tool(app: &AppHandle, sid: &str, name: &str, args: &Value) -> String {
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        if !crate::memory::memory_enabled(&conn) {
            return "Memory is disabled — the user turned it off in Settings → \
                    Memory. Do not retry; answer without remembered context."
                .to_string();
        }
    }
    match name {
        tools::MEMORY_SAVE => crate::memory::tools_impl::memory_save(app, sid, args).await,
        tools::MEMORY_RECALL => crate::memory::tools_impl::memory_recall(app, args),
        tools::MEMORY_FORGET => crate::memory::tools_impl::memory_forget(app, args),
        _ => format!("Error: unknown memory tool {name}"),
    }
}

/// `totp_code` — RFC 6238 code generation for 2FA flows (chat/totp.rs).
/// Three seed sources, keyed by `args.source`:
/// - `keyring` (default): the project's OS-keychain secret store. Requires a
///   project-bound session (the store is per-project) and a key the user
///   saved via Settings → project → Secrets holding the Base32 seed or a full
///   `otpauth://` URI.
/// - `bitwarden`: shells `bw get totp <item>` with the user's own environment
///   (their BW_SESSION unlocks the vault — no secret transits Relay).
/// - `1password`: shells `op read <op://reference>` likewise.
///
/// The tool result contains ONLY the code + its remaining validity. Errors
/// are agent-actionable (which setting is missing) and never echo the seed.
async fn run_totp_tool(app: &AppHandle, sid: &str, args: &Value) -> String {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    if key.is_empty() {
        return "Error: totp_code requires 'key' (the stored seed's key or the password-manager item/reference).".to_string();
    }
    let source = args
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("keyring");

    match source {
        "keyring" => {
            let project_id = {
                let db = app.state::<crate::DbState>();
                let conn = db.0.lock();
                crate::db::get_chat_session(&conn, sid)
                    .ok()
                    .flatten()
                    .and_then(|s| s.project_id)
            };
            let Some(project_id) = project_id else {
                return "Error: this chat has no project bound, and keyring seeds are stored per project. Ask the user to open the chat inside its project (or store the seed and re-bind).".to_string();
            };
            let seed = {
                let db = app.state::<crate::DbState>();
                let conn = db.0.lock();
                crate::secrets::get_secret(&conn, &project_id, key)
            };
            let Some(seed) = seed else {
                return format!(
                    "Error: no project secret keyed {key:?}. The user can add it in the project's settings (Secrets) — the value should be the TOTP Base32 seed or the full otpauth:// URI from the 2FA QR code."
                );
            };
            let digits = args.get("digits").and_then(|v| v.as_u64()).unwrap_or(6) as u32;
            let period = args.get("period").and_then(|v| v.as_u64()).unwrap_or(30);
            let cfg = match crate::chat::totp::TotpConfig::from_seed(&seed, digits, period) {
                Ok(c) => c,
                Err(e) => return format!("Error: stored seed for {key:?} is not usable: {e}"),
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            match crate::chat::totp::generate(&cfg, now) {
                Ok(code) => format!(
                    "{} (valid for ~{}s, rotates every {}s)",
                    code,
                    crate::chat::totp::valid_for(&cfg, now),
                    cfg.period
                ),
                Err(e) => format!("Error: {e}"),
            }
        }
        "bitwarden" => {
            // `bw get totp <item>` prints the current code. The user's own
            // environment (BW_SESSION) unlocks the vault; without a session
            // bw fails with its own message, surfaced verbatim.
            let mut cmd = tokio::process::Command::new("bw");
            cmd.args(["get", "totp", key]);
            crate::util::no_console_window_tokio(&mut cmd);
            // The CLI can stall on a locked vault / network sync; bound it so
            // the tool call always returns.
            match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
                Ok(Ok(out)) if out.status.success() => {
                    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if code.is_empty() {
                        format!("Error: bw returned an empty code for {key:?}.")
                    } else {
                        code
                    }
                }
                Ok(Ok(out)) => {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    format!(
                        "Error: Bitwarden CLI failed for {key:?}: {}. Is the bw CLI installed and the vault unlocked (BW_SESSION)?",
                        if err.is_empty() { "unknown error" } else { &err }
                    )
                }
                Ok(Err(e)) => format!(
                    "Error: could not run the Bitwarden CLI (`bw`): {e}. Install it or use source 'keyring'."
                ),
                Err(_) => "Error: password-manager CLI timed out.".to_string(),
            }
        }
        "1password" => {
            // `op read <op://...>` with a one-time-code reference prints the
            // current code, e.g. op://Private/GitHub/one-time-code?attribute=totp
            if !key.starts_with("op://") {
                return "Error: for source '1password', 'key' must be a full op:// secret reference (e.g. op://Private/GitHub/one-time-code).".to_string();
            }
            let mut cmd = tokio::process::Command::new("op");
            cmd.args(["read", key]);
            crate::util::no_console_window_tokio(&mut cmd);
            match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
                Ok(Ok(out)) if out.status.success() => {
                    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if code.is_empty() {
                        format!("Error: op returned an empty code for {key:?}.")
                    } else {
                        code
                    }
                }
                Ok(Ok(out)) => {
                    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    format!(
                        "Error: 1Password CLI failed: {}. Is the op CLI installed and signed in?",
                        if err.is_empty() { "unknown error" } else { &err }
                    )
                }
                Ok(Err(e)) => format!(
                    "Error: could not run the 1Password CLI (`op`): {e}. Install it or use source 'keyring'."
                ),
                Err(_) => "Error: password-manager CLI timed out.".to_string(),
            }
        }
        other => format!("Error: unknown totp_code source {other:?} — use 'keyring', 'bitwarden', or '1password'."),
    }
}
