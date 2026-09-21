//! Automation commands (see automations.rs + db/automations.rs): CRUD for
//! scheduled headless agent runs, plus a manual run-now. Runs are executed
//! through the same launch path the scheduler tick uses. Trigger engines
//! beyond cron (webhook/file/git) share this CRUD: input validation +
//! webhook-secret settling happen here and are reused by the chat tool layer
//! so both surfaces behave identically.

use tauri::{AppHandle, State};

use crate::automation_triggers;
use crate::automations;
use crate::db::{self, Automation, AutomationInput, AutomationRun};
use crate::DbState;

/// Agent ids an automation may use. CLI harnesses, cloud API providers, and
/// local GGUF are all valid — the execution path routes accordingly
/// (CLI harness → run_one_shot, API/local → chat send). Kimi harness is
/// excluded: it cannot combine prompt mode with auto-approve.
const ALLOWED_AGENTS: [&str; 10] = [
    // CLI harnesses
    "claude_code",
    "opencode",
    "pi",
    "omp",
    "commandcode",
    // Cloud API providers
    "anthropic",
    "openai",
    "openrouter",
    "anthropic_compatible",
    "openai_compatible",
    // local_gguf is also valid (supported at execution)
];

/// Validate + normalize one create/update input. Shared with the chat tool
/// layer (chat/tools/automations.rs) so the model's create_automation /
/// update_automation accept exactly the same agent set AND trigger types as
/// the Automations form — one list, no drift. The webhook secret is settled
/// here too: create (existing = None) generates one, update carries over the
/// stored row's secret — so both surfaces get one for free and a UI
/// round-trip (which redacts it) never rotates it.
pub(crate) fn validate_input(
    input: &mut AutomationInput,
    existing: Option<&Automation>,
) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("name is required".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("prompt is required".into());
    }
    if !is_allowed_automation_agent(&input.harness) {
        return Err(format!(
            "agent '{}' cannot run automations (supported: claude_code, opencode, \
             pi, omp, commandcode, cloud APIs, local GGUF)",
            input.harness,
        ));
    }
    if let Some(t) = input.trigger_type.as_deref() {
        input.trigger_type = Some(automation_triggers::TriggerSpec::normalize_type(Some(t)));
    }
    automation_triggers::settle_webhook_secret(input, existing);
    let trigger_type = input
        .trigger_type
        .as_deref()
        .unwrap_or(automation_triggers::TRIGGER_CRON);
    automation_triggers::validate_trigger(
        trigger_type,
        input.trigger_config.as_deref().unwrap_or("{}"),
        &input.schedule,
    )
}

/// Shared with the chat tool layer (chat/tools/automations.rs) so the model's
/// `create_automation` / `update_automation` accept exactly the same agent set
/// as the Automations form — one list, no drift.
pub(crate) fn is_allowed_automation_agent(harness: &str) -> bool {
    ALLOWED_AGENTS.contains(&harness) || harness == "local_gguf"
}

/// list/get IPC surfaces never carry the webhook secret — the UI reads it
/// via `automation_webhook_info` (see automation_triggers::strip_webhook_secret).
fn redacted(rows: Vec<Automation>) -> Vec<Automation> {
    rows.into_iter()
        .map(|mut a| {
            automation_triggers::strip_webhook_secret(&mut a);
            a
        })
        .collect()
}

#[tauri::command(async)]
pub fn list_automations(db: State<'_, DbState>) -> Result<Vec<Automation>, String> {
    let conn = db.0.lock();
    db::list_automations(&conn)
        .map(redacted)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_automation(
    app: AppHandle,
    db: State<'_, DbState>,
    mut input: AutomationInput,
) -> Result<Automation, String> {
    validate_input(&mut input, None)?;
    let created = {
        let conn = db.0.lock();
        db::create_automation(&conn, &input).map_err(|e| e.to_string())
    };
    // File triggers need their watcher installed; a removed/re-edited row
    // may also free a path. One sync after the write covers both.
    automation_triggers::sync_fs_watchers(&app, &db.0);
    created.map(|mut a| {
        automation_triggers::strip_webhook_secret(&mut a);
        a
    })
}

#[tauri::command(async)]
pub fn update_automation(
    app: AppHandle,
    db: State<'_, DbState>,
    automation_id: String,
    mut input: AutomationInput,
) -> Result<(), String> {
    // Load the stored row BEFORE validating: the webhook secret settle needs
    // it to carry the existing secret over a redacted update payload.
    let existing = {
        let conn = db.0.lock();
        db::get_automation(&conn, &automation_id).map_err(|e| e.to_string())?
    };
    validate_input(&mut input, existing.as_ref())?;
    let result = {
        let conn = db.0.lock();
        db::update_automation(&conn, &automation_id, &input).map_err(|e| e.to_string())
    };
    // File triggers need their watcher installed; a removed/re-edited row
    // may also free a path. One sync after the write covers both.
    automation_triggers::sync_fs_watchers(&app, &db.0);
    result
}

#[tauri::command(async)]
pub fn delete_automation(
    app: AppHandle,
    db: State<'_, DbState>,
    automation_id: String,
) -> Result<(), String> {
    let conn = db.0.lock();
    db::delete_automation(&conn, &automation_id)
        .map_err(|e| e.to_string())
        .map(|_| automation_triggers::sync_fs_watchers(&app, &db.0))
}

#[tauri::command(async)]
pub fn set_automation_enabled(
    app: AppHandle,
    db: State<'_, DbState>,
    automation_id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = db.0.lock();
    db::set_automation_enabled(&conn, &automation_id, enabled)
        .map_err(|e| e.to_string())
        .map(|_| automation_triggers::sync_fs_watchers(&app, &db.0))
}

/// Fire one run immediately, on the same launch path the scheduler uses
/// (overlap-guarded; the result lands in the automation's run-log chat).
#[tauri::command(async)]
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

/// Stop the automation's in-flight run: the CLI's process tree is killed, the
/// run row is finalized as "stopped" (not a failure), and the overlap guards
/// are released so the next scheduled slot fires normally.
///
/// Returns false when no run in flight belongs to THIS process — the run
/// already ended, or it was started by the `relay-automation` Task Scheduler
/// binary, which an in-app stop can't reach. The view reports that instead of
/// showing a stop that will never happen.
#[tauri::command(async)]
pub fn stop_automation_run(automation_id: String) -> Result<bool, String> {
    Ok(automations::stop_run(&automation_id))
}

/// Newest-first run history for one automation (UI "Past runs" pane).
#[tauri::command(async)]
pub fn list_automation_runs(
    db: State<'_, DbState>,
    automation_id: String,
    limit: Option<i64>,
    // mi23: keyset pagination — return runs with started_at < before_id (the
    // runs table is started_at-ordered DESC for display). Despite the
    // parameter name, the frontend sends the previous page's OLDEST
    // started_at TIMESTAMP as the cursor, not an id. None = latest page.
    before_id: Option<i64>,
) -> Result<Vec<AutomationRun>, String> {
    let conn = db.0.lock();
    db::list_runs_for(&conn, &automation_id, limit.unwrap_or(100), before_id)
        .map_err(|e| e.to_string())
}

/// How many runs an automation has on file (sidebar list badge).
#[tauri::command(async)]
pub fn count_automation_runs(
    db: State<'_, DbState>,
    automation_id: String,
) -> Result<i64, String> {
    let conn = db.0.lock();
    db::count_runs_for(&conn, &automation_id).map_err(|e| e.to_string())
}

/// Next fire for a row of ANY trigger type: cron rows carry the unix
/// timestamp (same due-math the scheduler uses, so the UI can't drift from
/// what will actually fire); webhook/file/git rows carry a degraded human
/// string instead — never the misleading "schedule error — will not fire"
/// an empty cron string would render.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationNextFire {
    /// Epoch seconds (local-time schedule) for cron rows; None for event
    /// triggers.
    pub at: Option<i64>,
    /// Human string for event triggers ("on webhook call" / "on file
    /// change" / "on git change"); empty for cron rows (the frontend
    /// formats `at` itself).
    pub label: String,
}

#[tauri::command]
pub fn automation_next_fire(
    schedule: String,
    trigger_type: Option<String>,
    trigger_config: Option<String>,
    after: Option<i64>,
) -> Result<AutomationNextFire, String> {
    let trigger_type = automation_triggers::TriggerSpec::normalize_type(trigger_type.as_deref());
    let after = after.unwrap_or_else(crate::db::now_ts);
    let (at, label) = automations::describe_next_fire(&trigger_type, &schedule, after);
    // Cron rows still validate the schedule up front (unchanged behavior:
    // bad input surfaces as an error, not a silent null). Event rows skip
    // cron validation entirely — their schedule may be empty.
    if trigger_type == automation_triggers::TRIGGER_CRON {
        automations::validate_schedule(&schedule)?;
    }
    Ok(AutomationNextFire { at, label })
}

/// The full local webhook trigger URL + secret for one automation. The
/// dedicated getter (list/get redact the secret) — the UI shows a copyable
/// URL; the listener must be running for a URL to exist.
#[tauri::command(async)]
pub fn automation_webhook_info(
    db: State<'_, DbState>,
    automation_id: String,
) -> Result<AutomationWebhookInfo, String> {
    let automation = {
        let conn = db.0.lock();
        db::get_automation(&conn, &automation_id)
            .map_err(|e| e.to_string())?
            .ok_or("automation not found")?
    };
    let url = crate::automation_webhook::trigger_url(&db.0, &automation)?;
    let secret = automation_triggers::secret_for(&automation).unwrap_or_default();
    Ok(AutomationWebhookInfo { url, secret })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWebhookInfo {
    pub url: String,
    pub secret: String,
}
