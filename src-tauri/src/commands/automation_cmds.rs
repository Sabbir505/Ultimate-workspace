//! Automation commands (see automations.rs + db/automations.rs): CRUD for
//! scheduled headless agent runs, plus a manual run-now. Runs are executed
//! through the same launch path the scheduler tick uses.

use tauri::{AppHandle, State};

use crate::automations;
use crate::db::{self, Automation, AutomationInput, AutomationRun};
use crate::DbState;

/// Agent ids an automation may use. CLI harnesses, cloud API providers, and
/// local GGUF are all valid — the execution path routes accordingly
/// (CLI harness → run_one_shot, API/local → chat send). Kimi harness is
/// excluded: it cannot combine prompt mode with auto-approve.
const ALLOWED_AGENTS: [&str; 7] = [
    // CLI harnesses
    "claude_code",
    "opencode",
    // Cloud API providers
    "anthropic",
    "openai",
    "openrouter",
    "anthropic_compatible",
    "openai_compatible",
    // local_gguf is also valid (supported at execution)
];

fn validate(input: &AutomationInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("name is required".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("prompt is required".into());
    }
    // local_gguf is also valid — checked separately to keep the const small
    if !ALLOWED_AGENTS.contains(&input.harness.as_str()) && input.harness != "local_gguf" {
        return Err(format!(
            "agent '{}' cannot run automations (supported: CLI agents, cloud APIs, local GGUF)",
            input.harness,
        ));
    }
    automations::validate_schedule(&input.schedule)
}

#[tauri::command]
pub fn list_automations(db: State<'_, DbState>) -> Result<Vec<Automation>, String> {
    let conn = db.0.lock();
    db::list_automations(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_automation(db: State<'_, DbState>, input: AutomationInput) -> Result<Automation, String> {
    validate(&input)?;
    let conn = db.0.lock();
    db::create_automation(&conn, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_automation(
    db: State<'_, DbState>,
    automation_id: String,
    input: AutomationInput,
) -> Result<(), String> {
    validate(&input)?;
    let conn = db.0.lock();
    db::update_automation(&conn, &automation_id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_automation(db: State<'_, DbState>, automation_id: String) -> Result<(), String> {
    let conn = db.0.lock();
    db::delete_automation(&conn, &automation_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_automation_enabled(
    db: State<'_, DbState>,
    automation_id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = db.0.lock();
    db::set_automation_enabled(&conn, &automation_id, enabled).map_err(|e| e.to_string())
}

/// Fire one run immediately, on the same launch path the scheduler uses
/// (overlap-guarded; the result lands in the automation's run-log chat).
#[tauri::command]
pub fn run_automation_now(
    app: AppHandle,
    db: State<'_, DbState>,
    automation_id: String,
) -> Result<(), String> {
    let automation = {
        let conn = db.0.lock();
        db::get_automation(&conn, &automation_id)
            .map_err(|e| e.to_string())?
            .ok_or("automation not found")?
    };
    automations::launch_run(Some(&app), &db.0, &automation, automations::RunSource::Manual)
}

/// Newest-first run history for one automation (UI "Past runs" pane).
#[tauri::command]
pub fn list_automation_runs(
    db: State<'_, DbState>,
    automation_id: String,
    limit: Option<i64>,
    // mi23: keyset pagination — return runs with id < before_id (runs are
    // id-ordered, newest last). None = latest page.
    before_id: Option<i64>,
) -> Result<Vec<AutomationRun>, String> {
    let conn = db.0.lock();
    db::list_runs_for(&conn, &automation_id, limit.unwrap_or(100), before_id)
        .map_err(|e| e.to_string())
}

/// How many runs an automation has on file (sidebar list badge).
#[tauri::command]
pub fn count_automation_runs(
    db: State<'_, DbState>,
    automation_id: String,
) -> Result<i64, String> {
    let conn = db.0.lock();
    db::count_runs_for(&conn, &automation_id).map_err(|e| e.to_string())
}

/// Next fire time (unix seconds, local time) for a cron schedule — strictly
/// after `after` (default: now). Powers the UI's "Next run" display; the
/// same math the scheduler uses for due-ness, so the UI can't drift from
/// what will actually fire.
#[tauri::command]
pub fn automation_next_fire(schedule: String, after: Option<i64>) -> Result<Option<i64>, String> {
    automations::validate_schedule(&schedule)?;
    let after = after.unwrap_or_else(crate::db::now_ts);
    Ok(automations::next_fire(&schedule, after))
}
