//! Headless CLI chat commands (Phase 2 — see agent_sessions.rs). These back
//! chat sessions whose `agent` is a CLI harness; the built-in chat commands
//! (chat_cmds) keep serving `builtin`/`local` sessions.

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
/// Connectors: every connector connected in Settings → Connectors (plus
/// public ones) is registered into the spawn's MCP config as a remote
/// server with a freshly-refreshed OAuth token, so harness sessions see
/// the same connector tools the built-in chat does.
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
) -> Result<(), String> {
    // Snapshot connected connectors (refreshing OAuth tokens) BEFORE the
    // sync spawn path — the CLIs only read static MCP config at startup, so
    // this is the one place fresh tokens can reach them.
    let connectors = crate::connectors::harness_mcp_servers(&app).await;
    state.0.send(
        &app,
        &db,
        &chat_session_id,
        &content,
        &harness_id,
        model.as_deref().unwrap_or(""),
        cwd.as_deref(),
        project_id.as_deref(),
        &connectors,
    )
}

/// Cancel the in-flight turn (kills the CLI process; next send respawns).
#[tauri::command]
pub fn cancel_agent_chat_message(
    app: AppHandle,
    state: State<'_, AgentSessionState>,
    chat_session_id: String,
) -> Result<(), String> {
    state.0.cancel(&app, &chat_session_id)
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
#[tauri::command]
pub fn list_acp_agents(db: State<DbState>) -> Result<Vec<crate::types::AcpAgentStatus>, String> {
    let conn = db.0.lock();
    Ok(crate::acp_agents::all_agents(&conn)
        .into_iter()
        .map(|a| {
            let installed = crate::acp_agents::is_installed(&a);
            crate::types::AcpAgentStatus {
                id: a.id,
                display_name: a.display_name,
                installed,
            }
        })
        .collect())
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
