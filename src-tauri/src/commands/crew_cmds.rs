//! Crew-agent commands: CRUD for declarative subagents (see
//! `chat/crew.rs` + `db/crew.rs`).
//!
//! Thin Tauri wrappers — validation and the refusals (builtin rows, agents
//! with runs in flight) live in `chat::crew` so the chat tool layer and this
//! IPC surface can never accept different shapes. Every error is a `String`
//! because the Crew editor shows it verbatim next to the field that caused it.

use tauri::State;

use crate::chat::crew::{self, CrewAgent, CrewAgentInput};
use crate::DbState;

/// Every definition, builtins first (the 7 seeded roles) then user rows by
/// name. The 7 builtin rows always exist — the seed is idempotent and runs on
/// every startup.
#[tauri::command(async)]
pub fn list_crew_agents(db: State<'_, DbState>) -> Result<Vec<CrewAgent>, String> {
    let conn = db.0.lock();
    Ok(crew::list(&conn))
}

#[tauri::command(async)]
pub fn get_crew_agent(
    db: State<'_, DbState>,
    agent_id: String,
) -> Result<Option<CrewAgent>, String> {
    let conn = db.0.lock();
    Ok(crew::get(&conn, &agent_id))
}

#[tauri::command(async)]
pub fn create_crew_agent(
    db: State<'_, DbState>,
    input: CrewAgentInput,
) -> Result<CrewAgent, String> {
    let conn = db.0.lock();
    crew::create(&conn, &input)
}

#[tauri::command(async)]
pub fn update_crew_agent(
    db: State<'_, DbState>,
    agent_id: String,
    input: CrewAgentInput,
) -> Result<CrewAgent, String> {
    let conn = db.0.lock();
    crew::update(&conn, &agent_id, &input)
}

/// Delete a definition. Refused for a builtin role and for an agent with runs
/// in flight; historical sessions survive (their `agent_def_id` is set to NULL
/// by the FK).
#[tauri::command(async)]
pub fn delete_crew_agent(db: State<'_, DbState>, agent_id: String) -> Result<(), String> {
    let conn = db.0.lock();
    crew::delete(&conn, &agent_id)
}

/// Spawn a crew run by hand (the Run button — Phase 2.5): a normal,
/// keep-chatting session carrying the definition's engine/model/policies,
/// linked by `agent_def_id`, optionally isolated in its own worktree. The
/// session id comes back so the UI can select it and watch the first turn
/// stream live (`wait` is for programmatic callers that want the turn to
/// settle first). Session Mesh does not need to be enabled — this goes
/// through `session_fabric::crew_spawn`, not the mesh tool surface.
#[tauri::command(async)]
pub async fn run_crew_agent(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    agent_id: String,
    task: String,
    project_id: Option<String>,
    wait: Option<bool>,
) -> Result<String, String> {
    // The DbState handle is moved into the spawn core via `app.state`, but
    // Tauri requires the parameter to be named — touch it so the signature
    // stays honest about the dependency.
    let _ = &db;
    crate::session_fabric::crew_spawn(
        &app,
        &agent_id,
        &task,
        project_id.as_deref(),
        wait.unwrap_or(false),
    )
    .await
}

/// Export definitions as shareable markdown docs (Claude-Code-compatible
/// frontmatter + relay extensions). Omitting `agent_ids` exports every USER
/// agent — the 7 builtin roles are deliberately left out of the default:
/// they already exist in every install (the idempotent seed), and their
/// reserved names make their docs unimportable by construction. Explicit ids
/// (a user deliberately exporting a builtin to share its edited prompt) are
/// honored verbatim.
#[tauri::command(async)]
pub fn export_crew_agents(
    db: State<'_, DbState>,
    agent_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let conn = db.0.lock();
    let rows = match &agent_ids {
        Some(ids) => ids
            .iter()
            .filter_map(|id| crew::get(&conn, id))
            .collect::<Vec<_>>(),
        None => crew::list(&conn).into_iter().filter(|a| !a.builtin).collect(),
    };
    if let Some(ids) = &agent_ids {
        for id in ids {
            if !rows.iter().any(|r| &r.id == id) {
                return Err(format!("crew agent \"{id}\" not found"));
            }
        }
    }
    Ok(rows
        .iter()
        .map(crew::to_markdown)
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Import ONE markdown doc as a new definition. Strict: an unknown tool,
/// unknown policy, or unparsable frontmatter is a hard error — a silently
/// weakened allowlist is the failure mode this refuses.
#[tauri::command(async)]
pub fn import_crew_agent(
    db: State<'_, DbState>,
    markdown: String,
) -> Result<CrewAgent, String> {
    let conn = db.0.lock();
    let input = crew::from_markdown(&markdown)?;
    crew::create(&conn, &input)
}

/// Run history, newest first (optionally one agent's runs).
#[tauri::command(async)]
pub fn list_crew_runs(
    db: State<'_, DbState>,
    agent_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<crate::db::CrewAgentRun>, String> {
    let conn = db.0.lock();
    crate::db::list_crew_runs(&conn, agent_id.as_deref(), limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}
