//! Automation commands (see automations.rs + db/automations.rs): CRUD for
//! scheduled headless agent runs, plus a manual run-now. Runs are executed
//! through the same launch path the scheduler tick uses.

use tauri::{AppHandle, State};

use crate::automations;
use crate::db::{self, Automation, AutomationInput, AutomationRun};
use crate::DbState;

/// Harnesses an automation may use. Kimi is excluded on purpose: it cannot
/// combine prompt mode with an auto-approve flag, so unattended runs would
/// execute with tools crippled (verified against `kimi --help`).
const ALLOWED_HARNESSES: [&str; 2] = ["claude_code", "opencode"];

fn validate(input: &AutomationInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("name is required".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("prompt is required".into());
    }
    if !ALLOWED_HARNESSES.contains(&input.harness.as_str()) {
        return Err(format!(
            "harness '{}' cannot run automations (supported: {})",
            input.harness,
            ALLOWED_HARNESSES.join(", ")
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
) -> Result<Vec<AutomationRun>, String> {
    let conn = db.0.lock();
    db::list_runs_for(&conn, &automation_id, limit.unwrap_or(100)).map_err(|e| e.to_string())
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
