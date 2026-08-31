//! Headless CLI chat commands (Phase 2 — see agent_sessions.rs). These back
//! chat sessions whose `agent` is a CLI harness; the built-in chat commands
//! (chat_cmds) keep serving `builtin`/`local` sessions.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::agent_sessions::AgentSessionState;
use crate::DbState;

/// Send one user turn to the CLI backing this chat session. Spawns the
/// headless process on first use (or on model change).
/// `harnessId` is the chat session's CLI ("claude_code" | "kimi_code" |
/// "opencode"), `model` its selected model id; `cwd` is the working
/// directory the CLI operates in (the selected project's path, when one
/// is selected). `projectId` feeds the conduit-browser MCP registration
/// (CONDUIT_PROJECT_ID) so browser auto-open is scoped to the project.
/// All harnesses are spawned with full permissions — no per-session
/// permission selector is surfaced or consulted.
///
/// Attachments: same composer payload the built-in chat takes. Display
/// markers + extracted document text are folded into the persisted message
/// (identical to `send_chat_message`, so bubbles render attachment cards);
/// image/doc bytes are additionally written under the artifacts dir and
/// referenced by absolute path in a CLI-facing appendix, since harnesses
/// take plain text on stdin — their own file tools open the originals.
///
/// Connectors: attach-on-demand parity with the built-in chat — only
/// connectors attached to this conversation (composer @-picker / keyword
/// mention) are registered into the spawn's MCP config as remote servers
/// with freshly-refreshed OAuth tokens. A fresh harness turn therefore
/// starts with no connector overhead at all.
#[tauri::command]
pub async fn send_agent_chat_message(
    app: AppHandle,
    state: State<'_, AgentSessionState>,
    db: State<'_, DbState>,
    chat_session_id: String,
    content: String,
    harness_id: String,
    model: Option<String>,
    cwd: Option<String>,
    project_id: Option<String>,
    attachments: Option<Vec<crate::types::ChatAttachmentInput>>,
) -> Result<(), String> {
    // Snapshot the session's attached connectors (refreshing OAuth tokens)
    // BEFORE the sync spawn path — the CLIs only read static MCP config at
    // startup, so this is the one place fresh tokens can reach them.
    let connectors =
        crate::connectors::harness_mcp_servers(&app, &chat_session_id).await;
    let (content, attach_prompt) = match &attachments {
        Some(list) if !list.is_empty() => {
            // Same display markers/extraction the built-in path persists
            // (images become "[Attached image: …]" notes; docs/text inline).
            let (display_extra, _images) = crate::chat::commands::process_attachments(list);
            let prompt =
                crate::agent_sessions::prepare_agent_attachments(&app, &chat_session_id, list);
            (format!("{content}{display_extra}"), prompt)
        }
        _ => (content, String::new()),
    };
    state.0.send(
        &app,
        &db,
        &chat_session_id,
        &content,
        &attach_prompt,
        &harness_id,
        model.as_deref().unwrap_or(""),
        cwd.as_deref(),
        project_id.as_deref(),
        &connectors,
    )
}

/// Cancel the in-flight turn (kills the CLI process; next send respawns).
///
/// Runs on a blocking worker rather than as a sync command: `cancel` blocks on
/// the global `sessions` mutex, which `send` holds for its whole (potentially
/// many-second) turn setup — a sync command would block the MAIN thread and
/// freeze the window for that entire window (audit B-8).
#[tauri::command]
pub async fn cancel_agent_chat_message(
    app: AppHandle,
    state: State<'_, AgentSessionState>,
    chat_session_id: String,
) -> Result<(), String> {
    let mgr = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || mgr.cancel(&app, &chat_session_id))
        .await
        .map_err(|e| format!("cancel task panicked: {e}"))?
}

/// The models/endpoint discovered in the CLI harness's own config files
/// (settings.json / config.toml / opencode.json) — see harness_config.rs.
#[tauri::command]
pub fn list_harness_models(harness_id: String) -> crate::harness_config::HarnessModelConfig {
    crate::harness_config::harness_model_config(&harness_id)
}

/// ACP agents (roadmap #20) for the composer's agent menu: the static
/// Zed/Devin registry plus user-defined entries from the `acp.agents`
/// app_settings blob, each with an install probe. Mirrors `list_harnesses`.
///
/// The probe spawns the agent binary with `--version` (up to 5s per entry),
/// so this is an async command with a 30s TTL cache — same rationale as
/// `list_harnesses`: opening the agent menu must never freeze the window.
#[tauri::command]
pub async fn list_acp_agents(db: State<'_, DbState>) -> Result<Vec<crate::types::AcpAgentStatus>, String> {
    if let Some(list) = acp_status_cache_get() {
        return Ok(list);
    }
    // Snapshot the registry rows synchronously (fast SQLite read), then run
    // the process probes off the main thread.
    let defs = {
        let conn = db.0.lock();
        crate::acp_agents::all_agents(&conn)
    };
    let probed = tauri::async_runtime::spawn_blocking(move || {
        defs.into_iter()
            .map(|a| {
                let installed = crate::acp_agents::is_installed(&a);
                crate::types::AcpAgentStatus {
                    id: a.id,
                    display_name: a.display_name,
                    installed,
                }
            })
            .collect::<Vec<crate::types::AcpAgentStatus>>()
    })
    .await
    .map_err(|e| format!("acp probe join failed: {e}"))?;
    acp_status_cache_store(probed.clone());
    Ok(probed)
}

/// Cached `list_acp_agents` probe results — see that command. TTL matches
/// `list_harnesses`; edits via save/delete of ACP agents are rare and the
/// settings panel re-probes explicitly.
static ACP_STATUS_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<Option<(std::time::Instant, Vec<crate::types::AcpAgentStatus>)>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));
const ACP_STATUS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

fn acp_status_cache_get() -> Option<Vec<crate::types::AcpAgentStatus>> {
    let guard = ACP_STATUS_CACHE.lock().ok()?;
    let (at, list) = guard.as_ref()?;
    if at.elapsed() < ACP_STATUS_TTL {
        Some(list.clone())
    } else {
        None
    }
}

fn acp_status_cache_store(list: Vec<crate::types::AcpAgentStatus>) {
    if let Ok(mut guard) = ACP_STATUS_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), list));
    }
}

/// Register a typed `Channel<ChatTokenPayload>` for a chat session. The
/// chat streaming code in `chat::dispatch::emit_token` and the headless CLI
/// chat path in `agent_sessions::emit_token` will route tokens through this
/// channel when one is registered; otherwise they fall back to
/// `app.emit("chat:token", ...)` (preserving the legacy event path for
/// tests and any frontend that hasn't migrated).
///
/// One subscriber per session. The frontend is expected to call this once
/// per chat-session open; the channel is dropped automatically when the
/// React effect unmounts.
#[tauri::command]
pub fn chat_token_subscribe(
    session_id: String,
    channel: tauri::ipc::Channel<crate::types::ChatTokenPayload>,
) -> Result<(), String> {
    crate::chat::stream_events::register(&session_id, channel);
    Ok(())
}
