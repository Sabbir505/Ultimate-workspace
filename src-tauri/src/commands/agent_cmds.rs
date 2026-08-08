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
#[tauri::command]
pub fn send_agent_chat_message(
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
    state.0.send(
        &app,
        &db,
        &chat_session_id,
        &content,
        &harness_id,
        model.as_deref().unwrap_or(""),
        cwd.as_deref(),
        project_id.as_deref(),
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
