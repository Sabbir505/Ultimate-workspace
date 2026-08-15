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
        SubagentDonePayload, SubagentSpawnPayload, SubagentTokenPayload,
    };
    use futures_util::StreamExt;

    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("").trim();
    let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim();
    let role = args.get("subagent_type").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
    if prompt.is_empty() {
        return "Error: Task requires a non-empty \"prompt\".".to_string();
    }

    // Resolve the session's provider + model + key + base_url.
    let (provider_str, model_str) = {
        let db_state = app.state::<crate::DbState>();
        let conn = db_state.0.lock();
        match db::get_chat_session(&conn, sid) {
            Ok(Some(cs)) => (cs.provider, cs.model),
            _ => return "Error: chat session not found.".to_string(),
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

    // Generate a subagent id and emit the spawn event.
    let sub_id = format!("sub-{}", crate::db::now_ts());
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
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 4096,
            "stream": true,
            "system": "You are a focused subagent. Complete the task concisely.",
            "messages": [{"role": "user", "content": prompt}],
        });
        stream_subagent_sse(
            &client, &url, &api_key, &body, app, sid, &sub_id, true,
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
        let body = serde_json::json!({
            "model": model,
            "stream": true,
            "stream_options": {"include_usage": true},
            "messages": [
                {"role": "system", "content": "You are a focused subagent. Complete the task concisely."},
                {"role": "user", "content": prompt},
            ],
        });
        stream_subagent_sse(
            &client, &url, &api_key, &body, app, sid, &sub_id, false,
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

/// Stream an SSE completion call, emitting each content delta as
/// `chat:subagent-tokens`. Handles both OpenAI-style (`choices/0/delta/content`)
/// and Anthropic-style (`content_block_delta/text`) SSE formats.
async fn stream_subagent_sse(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    app: &AppHandle,
    sid: &str,
    sub_id: &str,
    is_anthropic: bool,
) -> Result<String, String> {
    use crate::types::SubagentTokenPayload;
    use futures_util::StreamExt;

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
    let mut output = String::new();

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
            // OpenAI-style: choices/0/delta/content
            if let Some(c) = v.pointer("/choices/0/delta/content").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    output.push_str(c);
                    let _ = app.emit(
                        "chat:subagent-tokens",
                        SubagentTokenPayload {
                            chat_session_id: sid.to_string(),
                            subagent_id: sub_id.to_string(),
                            chunk: c.to_string(),
                        },
                    );
                }
            }
            // Anthropic-style: content_block_delta/delta/text
            if let Some(c) = v.pointer("/delta/text").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    output.push_str(c);
                    let _ = app.emit(
                        "chat:subagent-tokens",
                        SubagentTokenPayload {
                            chat_session_id: sid.to_string(),
                            subagent_id: sub_id.to_string(),
                            chunk: c.to_string(),
                        },
                    );
                }
            }
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
                permission::check_permission(mode, name, &target, &caps.fs_roots)
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
