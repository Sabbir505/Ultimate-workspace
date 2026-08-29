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

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::stream_events;
use crate::chat::{permission, tools, ChatManager};
use crate::types::{
    ChatApprovalRequestPayload, ChatApprovalResolvedPayload, ChatArtifactPayload,
    ChatOpenBrowserPayload, ChatOpenPreviewPayload, ChatTokenPayload,
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
    crate::chat::turn_perf::record_active_token(sid);
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
    let target = pick(&["file_path", "path", "notebook_path", "command", "pattern", "url", "prompt"])
        .map(|t| if t.chars().count() > 160 { format!("{}…", t.chars().take(160).collect::<String>()) } else { t })
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
    let outcome = tools::execute_tool(client, artifacts_dir, caps, name, args, Some(app)).await;
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
    let (pending_id, rx) = mgr.register_pending_approval(sid, &entry.wire_name, args.clone(), summary.clone());

    let _ = app.emit(
        "chat:approval-request",
        ChatApprovalRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.clone(),
            tool: entry.wire_name.clone(),
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

/// Execute a system tool (`download_file` / `run_shell` / status / cancel)
/// against the background TaskManager. The permission gate has already
/// decided (or the user approved); these calls either start a task, or read/
/// cancel an existing one, and return text for the model.
async fn execute_system_tool(app: &AppHandle, sid: &str, name: &str, args: &Value) -> String {
    use tools::{CANCEL_TASK, DOWNLOAD_FILE, DOWNLOAD_PROGRESS, GET_TASK_STATUS, RUN_SHELL, TASK};
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
            // Run to completion so the output flows into the turn buffer and
            // persists in the stored message (the async start_shell path sends
            // output to a separate chat:task-progress channel that doesn't
            // persist). The sync runner parks on the child, so it must run on
            // the blocking pool — inline it would pin a tokio worker for the
            // whole command (up to the runner's 120 s ceiling).
            let cmd_owned = command.to_string();
            let wd_owned = workdir.map(str::to_string);
            tokio::task::spawn_blocking(move || {
                crate::chat::tasks::run_shell_to_completion(&cmd_owned, wd_owned.as_deref())
            })
            .await
            .unwrap_or_else(|e| format!("shell task failed: {e}"))
        }
        TASK => {
            // Spawn a streaming sub-turn using the SAME provider+model as this
            // session. The subagent's prompt is its only input; its output is
            // streamed token-by-token to the Agents panel via chat:subagent-tokens,
            // and the full text is returned as the tool result.
            run_task_subagent(app, sid, args, &tasks).await
        }
        other => format!("Error: unknown system tool \"{other}\"."),
    }
}

/// Spawn a streaming sub-turn for the `Task` tool. Resolves the session's
/// provider/model/api_key/base_url from the DB, makes a streaming SSE
/// completion call with the subagent's prompt as the sole user message, and
/// emits each token chunk as `chat:subagent-tokens`. Returns the full
/// accumulated output as the tool result.
async fn run_task_subagent(
    app: &AppHandle,
    sid: &str,
    args: &Value,
    _tasks: &crate::TaskState,
) -> String {
    use crate::chat::providers::{
        AnthropicProvider, OpenAIProvider, OpenRouterProvider,
    };
    use crate::secrets;
    use crate::types::{
        SubagentDonePayload, SubagentSpawnPayload,
    };

    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("").trim();
    let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim();
    let role = args.get("subagent_type").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
    if prompt.is_empty() {
        return "Error: Task requires a non-empty \"prompt\".".to_string();
    }

    // Resolve the session's provider + model + key + base_url + project cwd.
    let (provider_str, model_str, project_id) = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        match db::get_chat_session(&conn, sid) {
            Ok(Some(cs)) => (cs.provider, cs.model, cs.project_id),
            _ => return "Error: chat session not found.".to_string(),
        }
    };
    // Resolve the project root (cwd) the subagent operates in, if any. The
    // old system prompt was a generic one-liner with no cwd context — subagents
    // labeled "edit"/"explore" had no idea which codebase they were in.
    let project_path = {
        if let Some(pid) = &project_id {
            let db_state = app.state::<crate::DbState>();
            let conn = db_state.0.lock();
            db::get_project(&conn, pid)
                .ok()
                .flatten()
                .map(|p| p.path)
        } else {
            None
        }
    };
    let api_key = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    if api_key.is_none() && provider_str != "local_gguf" {
        return "Error: no API key configured for this provider.".to_string();
    }
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
            _ => return "Error: no model configured.".to_string(),
        }
    } else if provider_str == "local_gguf" {
        model_override
            .filter(|m| !m.trim().is_empty())
            .unwrap_or(model_str)
    } else {
        model_str
    };

    // Build a role-aware system prompt. The `role` (subagent_type) enum is now
    // reflected in the instructions instead of being ignored, and the project
    // cwd is injected so the subagent knows which codebase it is operating in.
    // The subagent has NO tools — it returns a self-contained answer/plan that
    // the caller (main agent) can act on. Stating this explicitly prevents the
    // subagent from hallucinating tool calls it can't actually make.
    let role_instructions = match role.as_str() {
        "explore" => "Your job is to explore the codebase and report findings: file paths, key symbols, and how things connect. Do not propose edits.",
        "edit" | "refactor" => "Your job is to produce the concrete edits required (full file contents or unified diffs). The caller will apply them. Be precise about file paths.",
        "analyze" => "Your job is to analyze the described code/behavior and report root cause, risks, and a recommendation. Do not edit.",
        "research" => "Your job is to research the topic and report a concise summary with citations/references where applicable.",
        "test" => "Your job is to specify tests (cases + expected outcomes, or test code) for the described behavior. Be specific.",
        "write" => "Your job is to write the requested content (docs, config, code) in full.",
        _ => "Complete the task concisely.",
    };
    let cwd_line = project_path
        .as_deref()
        .map(|p| format!("You are operating in the project at: {p}"))
        .unwrap_or_else(|| "No project root is bound to this task.".to_string());
    let system_prompt = format!(
        "You are a focused subagent spawned by the main assistant. {role_instructions}\n{cwd_line}\n\
         You have READ-ONLY tools — list_directory, read_file, search_files, search_content, \
         fetch_url — use them to ground your answer in the real workspace or web before \
         answering. You CANNOT modify anything: if changes are needed, describe the exact \
         edits in your answer instead of applying them."
    );

    // Generate a subagent id and emit the spawn event. The counter suffix is
    // load-bearing now that a round's Task calls spawn CONCURRENTLY — subagents
    // created in the same second used to collide on the plain timestamp id and
    // overwrite each other in the frontend store (keyed by id).
    static SUB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let sub_seq = SUB_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sub_id = format!("sub-{}-{sub_seq}", crate::db::now_ts());
    let _ = app.emit(
        "chat:subagent-spawn",
        SubagentSpawnPayload {
            chat_session_id: sid.to_string(),
            id: sub_id.clone(),
            role: role.clone(),
            task: description.to_string(),
            prompt: prompt.to_string(),
        },
    );

    // Build the streaming request. OpenAI-style providers use /v1/chat/completions;
    // Anthropic uses /v1/messages with a different body shape.
    let is_anthropic = matches!(provider_str.as_str(), "anthropic" | "anthropic_compatible");
    let client = reqwest::Client::new();

    let result: Result<String, String> = if is_anthropic {
        let base = base_url
            .as_deref()
            .unwrap_or(AnthropicProvider::DEFAULT_BASE);
        let url = format!("{base}/v1/messages");
        let mut body = serde_json::json!({
            "model": model,
            "max_tokens": 4096,
            "stream": true,
            "system": system_prompt,
            "messages": [{"role": "user", "content": prompt}],
        });
        run_subagent_loop(
            &client, &url, &api_key, &mut body, app, sid, &sub_id, true,
        ).await
    } else {
        let base = base_url
            .as_deref()
            .unwrap_or(if provider_str == "openrouter" {
                OpenRouterProvider::DEFAULT_BASE
            } else {
                OpenAIProvider::DEFAULT_BASE
            });
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
        run_subagent_loop(
            &client, &url, &api_key, &mut body, app, sid, &sub_id, false,
        ).await
    };

    match result {
        Ok(output) => {
            let _ = app.emit(
                "chat:subagent-done",
                SubagentDonePayload {
                    chat_session_id: sid.to_string(),
                    id: sub_id,
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
                    id: sub_id,
                    output: String::new(),
                    error: Some(e.clone()),
                },
            );
            format!("Error: subagent failed: {e}")
        }
    }
}

/// Read-only tools a subagent may use: enough to ground its answer in the
/// actual workspace/web, no mutation (so no approval cards can ever be
/// needed — reads are exempt from the fs scope gate by contract), no browser
/// pane takeover, no background tasks. Filtered out of the shared spec
/// builders so the wire schema only advertises these.
const SUBAGENT_TOOL_ALLOW: &[&str] = &[
    tools::LIST_DIRECTORY,
    tools::READ_FILE,
    tools::SEARCH_FILES,
    tools::SEARCH_CONTENT,
    tools::FETCH_URL,
];
/// Max model rounds (tool rounds + final answer) per subagent. Deliberately
/// generous (100): research subagents that read many files per round need
/// room, and each round is a bounded tool batch — the RESULT cap below is
/// what keeps context size in check, not the round count.
const SUBAGENT_MAX_ROUNDS: usize = 100;
/// Cap per tool result fed back to the subagent (keeps context bounded).
const SUBAGENT_RESULT_CAP: usize = 6_000;

/// Spec list for the subagent's provider format, filtered to the read-only
/// allowlist above.
fn subagent_tool_specs(is_anthropic: bool) -> Vec<Value> {
    let caps = tools::ToolCaps::default();
    let all = if is_anthropic {
        tools::anthropic_tool_specs(&caps, permission::SandboxPolicy::ReadOnly)
    } else {
        tools::openai_tool_specs(&caps, permission::SandboxPolicy::ReadOnly)
    };
    all.into_iter()
        .filter(|s| {
            let name = if is_anthropic {
                s.get("name").and_then(|n| n.as_str())
            } else {
                s.pointer("/function/name").and_then(|n| n.as_str())
            };
            name.is_some_and(|n| SUBAGENT_TOOL_ALLOW.contains(&n))
        })
        .collect()
}

/// Stream a subagent completion WITH tools. Runs up to `SUBAGENT_MAX_ROUNDS`
/// streaming rounds: text deltas emit live as `chat:subagent-tokens`; tool
/// calls are announced as `<tool>` markers in the same stream (so the Agents
/// pane renders live activity rows), executed read-only via `execute_tool`,
/// and their results are fed back for the next round. Returns the full
/// accumulated output (text + markers) as the tool result for the MAIN agent.
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
    let caps = tools::ToolCaps::default();
    let tool_specs = subagent_tool_specs(is_anthropic);
    let has_tools = !tool_specs.is_empty();
    if has_tools {
        if is_anthropic {
            body["tools"] = Value::Array(tool_specs);
        } else {
            body["tools"] = Value::Array(tool_specs);
        }
    }

    let mut output = String::new();

    for round in 0..SUBAGENT_MAX_ROUNDS {
        let mut req = client
            .post(url)
            .header("content-type", "application/json")
            .json(body);
        if is_anthropic {
            req = req
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
        let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {}", crate::util::truncate_chars(&b, 500)));
        }

        let mut stream = resp.bytes_stream();
        let mut pending = String::new();
        // Round accumulators.
        let mut round_text = String::new();
        // OpenAI: index → (id, name, arguments-json-accumulated).
        let mut oai_calls: BTreeMap<i64, (String, String, String)> = BTreeMap::new();
        // Anthropic: block index → (id, name, partial-json-accumulated).
        let mut ant_calls: BTreeMap<i64, (String, String, String)> = BTreeMap::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("stream read error: {e}"))?;
            pending.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = pending.find('\n') {
                let line: String = pending.drain(..=nl).collect();
                let line = line.trim_end();
                let data = match line.strip_prefix("data: ") {
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
                        Some("content_block_delta") => {
                            if let Some(c) = v.pointer("/delta/text").and_then(|x| x.as_str()) {
                                if !c.is_empty() {
                                    round_text.push_str(c);
                                    output.push_str(c);
                                    emit(c);
                                }
                            }
                            if v.pointer("/delta/type").and_then(|x| x.as_str())
                                == Some("input_json_delta")
                            {
                                if let Some(idx) = v.get("index").and_then(|i| i.as_i64()) {
                                    let piece = v
                                        .pointer("/delta/partial_json")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("");
                                    ant_calls.entry(idx).or_insert_with(|| {
                                        (String::new(), String::new(), String::new())
                                    }).2.push_str(piece);
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
                    if let Some(c) = v.pointer("/choices/0/delta/content").and_then(|x| x.as_str())
                    {
                        if !c.is_empty() {
                            round_text.push_str(c);
                            output.push_str(c);
                            emit(c);
                        }
                    }
                    if let Some(tcs) =
                        v.pointer("/choices/0/delta/tool_calls").and_then(|x| x.as_array())
                    {
                        for tc in tcs {
                            let idx = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
                            let entry =
                                oai_calls.entry(idx).or_insert_with(|| {
                                    (String::new(), String::new(), String::new())
                                });
                            if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                                if !id.is_empty() {
                                    entry.0 = id.to_string();
                                }
                            }
                            if let Some(n) =
                                tc.pointer("/function/name").and_then(|x| x.as_str())
                            {
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

        // No tool calls → this round's text is the final answer.
        let has_calls = !oai_calls.is_empty() || !ant_calls.is_empty();
        if !has_calls {
            break;
        }
        if round + 1 >= SUBAGENT_MAX_ROUNDS {
            // Out of rounds — tell the model (and the pane) the loop ends here.
            let note = "\n\n_[Subagent reached its tool-round limit; returning findings so far.]_";
            output.push_str(note);
            emit(note);
            break;
        }

        if is_anthropic {
            // Echo the assistant turn: text blocks + tool_use blocks.
            let mut blocks: Vec<Value> = Vec::new();
            if !round_text.trim().is_empty() {
                blocks.push(json!({ "type": "text", "text": round_text }));
            }
            let mut results: Vec<Value> = Vec::new();
            for (_idx, (id, name, args_acc)) in ant_calls.iter() {
                let args: Value = if args_acc.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(args_acc).unwrap_or(json!({}))
                };
                blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": args }));
                let meta = crate::agent_sessions::tool_meta_generic(name, &args);
                emit(&format!("<tool>{meta}</tool>"));
                let outcome =
                    tools::execute_tool(client, &artifacts_dir, &caps, name, &args, Some(app))
                        .await;
                let result = crate::util::truncate_chars(&outcome.text, SUBAGENT_RESULT_CAP);
                emit(&format!(
                    "<tool>{}</tool>",
                    json!({"kind": "result", "title": "Output", "result": crate::chat::streaming::neutralize_markers(&result)})
                ));
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
                let args: Value = if args_acc.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(args_acc).unwrap_or(json!({}))
                };
                let meta = crate::agent_sessions::tool_meta_generic(name, &args);
                emit(&format!("<tool>{meta}</tool>"));
                let outcome =
                    tools::execute_tool(client, &artifacts_dir, &caps, name, &args, Some(app))
                        .await;
                let result = crate::util::truncate_chars(&outcome.text, SUBAGENT_RESULT_CAP);
                emit(&format!(
                    "<tool>{}</tool>",
                    json!({"kind": "result", "title": "Output", "result": crate::chat::streaming::neutralize_markers(&result)})
                ));
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
/// Attach-on-demand meta-tools (`attach_connector` / `attach_mcp_server`).
/// Validates the id against this turn's attachable catalog, connects the
/// source, persists the session row (attachments stick for the conversation
/// per the UX decision), and hands the live tool table to the turn's tool
/// loop via the manager's late-attach slot — the next round can call the
/// tools directly. Read-kind by design: the source is one the user already
/// connected in Settings, so no approval card gates the attach itself.
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
            caps.attached_connectors.iter().any(|c| c.connector_id == id)
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
        let _ = app.emit(
            "chat:status",
            crate::types::ChatStatusPayload {
                chat_session_id: sid.to_string(),
                reason: "connector_attached".to_string(),
                message: format!("Attached {display} ({n} tools)"),
            },
        );
        if let Some(slot) = mgr.late_attach_slot(sid) {
            slot.lock().mcp.extend(entries);
        }
        {
            let db_state = app.state::<crate::DbState>();
            let conn = db_state.0.lock();
            let _ = crate::db::add_chat_session_connector(&conn, sid, &format!("mcp:{id}"));
        }
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
        let _ = app.emit(
            "chat:status",
            crate::types::ChatStatusPayload {
                chat_session_id: sid.to_string(),
                reason: "connector_attached".to_string(),
                message: format!("Attached {display} ({n} tools)"),
            },
        );
        if let Some(slot) = mgr.late_attach_slot(sid) {
            slot.lock().connectors.push(att);
        }
        {
            let db_state = app.state::<crate::DbState>();
            let conn = db_state.0.lock();
            let _ = crate::db::add_chat_session_connector(&conn, sid, &id);
        }
        format!("Attached {display} ({n} tools): {listing}")
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
    tokio::spawn(async move {
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
    })
}

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
    // Plan-mode gate + plan tools, BEFORE every other family: while a session
    // is in plan mode every mutating tool is refused (reads stay allowed), and
    // the three plan tools dispatch here because they need PlanState and — for
    // present_plan — the shared approval oneshot. Plan mode can only flip
    // inside these handlers (one turn per session), so one read per call is
    // authoritative.
    let plan_mode = {
        let plan = app.state::<crate::chat::plan::PlanState>();
        if crate::chat::plan::is_plan_tool(name) {
            return crate::chat::plan::run_plan_tool(&plan, mgr, app, sid, name, args)
                .await
                .unwrap_or_default();
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

    // Local-docs search: needs both DB (corpora + chunks) and the embedding
    // sidecar (to vectorize the query), so it dispatches here rather than in
    // execute_tool. Gated at the schema level via ToolCaps.local_docs, but we
    // double-check the gate cheaply in case a model calls a removed tool.
    if name == tools::SEARCH_DOCS {
        return run_search_docs_tool(app, name, args).await;
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
            return crate::chat::plan::gate_denial(true, name).unwrap_or_default();
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
            return crate::chat::plan::gate_denial(true, name).unwrap_or_default();
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
        // An approval rule ("always allow tool + glob") auto-approves past the
        // per-action card. The hard scope-gate below still runs for mutating
        // tools, so a rule can never grant writes outside the enabled/dir
        // scope — it only suppresses the approval prompt.
        let decision =
            if permission::any_rule_allows(&caps.fs_rules, name, &target) {
                permission::PermissionDecision::AutoRun
            } else {
                permission::check_permission(sandbox, approval, name, &target, &caps.fs_roots)
            };
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

    let outcome = tools::execute_tool(client, artifacts_dir, caps, name, args, Some(app)).await;
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
            // mi5: fetch rows under the lock, serialize AFTER releasing it —
            // serde of the full notes vector under the DB mutex stalled every
            // other DB reader for the duration.
            GET_SOURCE_LEDGER => {
                let notes = match db::list_source_notes(&conn, sid) {
                    Ok(n) => n,
                    Err(e) => return Some(format!("get_source_ledger failed: {e}")),
                };
                drop(conn);
                return Some(serde_json::to_string(&notes).unwrap_or_else(|_| "[]".to_string()));
            }
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

/// Dispatch the local-docs `search_docs` tool. Embeds the query via the running
/// embedding sidecar, then brute-force cosine top-k against all enabled corpora,
/// returning the same short summary format as `search_content`. Image hits
/// include a path citation only (no inline pixels).
async fn run_search_docs_tool(app: &AppHandle, _name: &str, args: &Value) -> String {
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

    let base_url = match app.try_state::<crate::chat::local_models::LocalModelState>() {
        Some(state) => match state.0.embedding_status() {
            Some(active) => active.base_url,
            None => {
                return "search_docs unavailable — the local embedding sidecar is \
                        not running. Re-index a corpus from Settings → Knowledge \
                        to start it."
                    .to_string();
            }
        },
        None => {
            return "search_docs unavailable — the local embedding sidecar is not \
                    registered."
                .to_string();
        }
    };

    // Embed the query (sidecar can vectorize one or many; one query here).
    let vecs = match crate::chat::local_models::embed_texts(&base_url, &[query.to_string()]).await {
        Ok(v) => v,
        Err(e) => return format!("search_docs embedding failed: {e}"),
    };
    let query_vec = match vecs.into_iter().next() {
        Some(v) => v,
        None => {
            return "search_docs embedding failed: sidecar returned no vectors.".to_string();
        }
    };

    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let hits = match crate::db::search_chunks(&conn, &query_vec, top_k) {
        Ok(h) => h,
        Err(e) => return format!("search_docs search failed: {e}"),
    };

    if hits.is_empty() {
        return "No local documents matched your query.".to_string();
    }

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
            let content = if hit.content.len() > MAX_CHUNK {
                format!("{}…", &hit.content[..MAX_CHUNK])
            } else {
                hit.content.clone()
            };
            format!(
                "[{}] {}  ·  {}  ·  score={:.3}\n{}",
                i + 1,
                hit.path,
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
