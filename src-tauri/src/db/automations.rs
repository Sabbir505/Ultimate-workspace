//! Automations (scheduled headless agent runs) — persistence.
//!
//! One row per automation: a stored prompt + harness/model/cwd + a 5-field
//! cron schedule. Runs are forced to `full_auto` permission (unattended turns
//! can't answer prompts) and are logged into the automation's own chat
//! session (`chat_session_id`) so transcripts/diffs/cost show up in the
//! normal chat UI. The scheduler lives in crate::automations; the headless
//! runner binary (bin/conduit_automation.rs) reads these same rows.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// "claude_code" | "opencode" (kimi is excluded: it cannot combine
    /// prompt mode with an auto-approve flag, so unattended runs would run
    /// with tools crippled).
    pub harness: String,
    /// Empty = the harness's configured default model.
    pub model: String,
    /// Working directory for the run (a project path, or empty for none).
    pub cwd: String,
    /// 5-field cron expression, local time (e.g. "2 9 * * 1-5").
    pub schedule: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    /// "ok" (launched) | "skipped" (previous run still going) | error text.
    pub last_status: Option<String>,
    /// Chat session used as the run log; created lazily on first run.
    pub chat_session_id: Option<String>,
    pub created_at: i64,
}

/// One past (or in-flight) run of an automation. Used by the Automations
/// view's "Past runs" list — separate from `Automation.last_run_at` /
/// `last_status` which only summarize the most recent attempt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    /// Start of the attempt, unix seconds.
    pub started_at: i64,
    /// End of the attempt, unix seconds. NULL while still running.
    pub finished_at: Option<i64>,
    /// "running" | "ok" | "skipped" | error text.
    pub status: String,
    /// One-line summary the runner captured (model output head, error head,
    /// or "still running" while in flight).
    pub summary: String,
    /// Chat session the run was logged into — opens with click.
    pub chat_session_id: Option<String>,
    /// Source of the run: "scheduled" (cron tick) or "manual" (run-now).
    pub source: String,
}

/// Fields the create/edit form sends. Everything except id/timestamps.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub name: String,
    pub prompt: String,
    pub harness: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub schedule: String,
    pub enabled: Option<bool>,
}

fn map_automation(row: &Row) -> rusqlite::Result<Automation> {
    Ok(Automation {
        id: row.get("id")?,
        name: row.get("name")?,
        prompt: row.get("prompt")?,
        harness: row.get("harness")?,
        model: row.get("model")?,
        cwd: row.get("cwd")?,
        schedule: row.get("schedule")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        last_run_at: row.get("last_run_at")?,
        last_status: row.get("last_status")?,
        chat_session_id: row.get("chat_session_id")?,
        created_at: row.get("created_at")?,
    })
}

const COLUMNS: &str =
    "id, name, prompt, harness, model, cwd, schedule, enabled, last_run_at, last_status, chat_session_id, created_at";

pub fn create_automation(conn: &Connection, input: &AutomationInput) -> DbResult<Automation> {
    let id = new_id();
    conn.execute(
        "INSERT INTO automations (id, name, prompt, harness, model, cwd, schedule, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            input.name,
            input.prompt,
            input.harness,
            input.model.as_deref().unwrap_or(""),
            input.cwd.as_deref().unwrap_or(""),
            input.schedule,
            input.enabled.unwrap_or(true) as i64,
            now_ts(),
        ],
    )?;
    get_automation(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn update_automation(
    conn: &Connection,
    automation_id: &str,
    input: &AutomationInput,
) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET name = ?2, prompt = ?3, harness = ?4, model = ?5, cwd = ?6, schedule = ?7
         WHERE id = ?1",
        params![
            automation_id,
            input.name,
            input.prompt,
            input.harness,
            input.model.as_deref().unwrap_or(""),
            input.cwd.as_deref().unwrap_or(""),
            input.schedule,
        ],
    )?;
    Ok(())
}

pub fn get_automation(conn: &Connection, automation_id: &str) -> DbResult<Option<Automation>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM automations WHERE id = ?1"),
        params![automation_id],
        map_automation,
    )
    .optional()
}

pub fn list_automations(conn: &Connection) -> DbResult<Vec<Automation>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM automations ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map([], map_automation)?;
    rows.collect()
}

pub fn set_automation_enabled(conn: &Connection, automation_id: &str, enabled: bool) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET enabled = ?2 WHERE id = ?1",
        params![automation_id, enabled as i64],
    )?;
    Ok(())
}

pub fn delete_automation(conn: &Connection, automation_id: &str) -> DbResult<()> {
    // The run-log chat session is kept on purpose: deleting the schedule
    // shouldn't erase the transcripts it produced.
    conn.execute(
        "DELETE FROM automations WHERE id = ?1",
        params![automation_id],
    )?;
    Ok(())
}

/// Stamp ONLY the status of a run attempt (e.g. "skipped"), leaving
/// `last_run_at` untouched — a skip must not consume the schedule, or a
/// blocked automation would silently wait a whole cycle instead of retrying
/// on the next tick.
pub fn record_status(conn: &Connection, automation_id: &str, status: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET last_status = ?2 WHERE id = ?1",
        params![automation_id, status],
    )?;
    Ok(())
}

/// Stamp a run attempt (launch time + outcome) and, on the first run, bind
/// the freshly created chat session as the automation's run log.
pub fn record_run(
    conn: &Connection,
    automation_id: &str,
    status: &str,
    chat_session_id: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET last_run_at = ?2, last_status = ?3,
           chat_session_id = COALESCE(?4, chat_session_id)
         WHERE id = ?1",
        params![automation_id, now_ts(), status, chat_session_id],
    )?;
    Ok(())
}

fn map_run(row: &Row) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        id: row.get("id")?,
        automation_id: row.get("automation_id")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        status: row.get("status")?,
        summary: row.get("summary")?,
        chat_session_id: row.get("chat_session_id")?,
        source: row.get("source")?,
    })
}

const RUN_COLUMNS: &str =
    "id, automation_id, started_at, finished_at, status, summary, chat_session_id, source";

/// Begin a run record. Returns the row's id so the runner can finish it
/// later. `source` is "scheduled" for cron-fired runs, "manual" for run-now.
pub fn start_run(
    conn: &Connection,
    automation_id: &str,
    chat_session_id: Option<&str>,
    source: &str,
) -> DbResult<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO automation_runs
           (id, automation_id, started_at, status, summary, chat_session_id, source)
         VALUES (?1, ?2, ?3, 'running', 'In progress…', ?4, ?5)",
        params![id, automation_id, now_ts(), chat_session_id, source],
    )?;
    Ok(id)
}

/// Finalize a run (set finished_at + status + summary). Returns silently if
/// the row was already finalized by another path (idempotent finalize).
pub fn finish_run(
    conn: &Connection,
    run_id: &str,
    status: &str,
    summary: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE automation_runs
           SET finished_at = ?2, status = ?3, summary = ?4
           WHERE id = ?1 AND finished_at IS NULL",
        params![run_id, now_ts(), status, summary],
    )?;
    Ok(())
}

/// Newest runs first, capped so a long-running automation doesn't paginate
/// forever. 100 is enough for the UI's "Past runs" pane.
pub fn list_runs_for(
    conn: &Connection,
    automation_id: &str,
    limit: i64,
    // Keyset pagination (mi23): only runs started before this run's
    // started_at. The runs table is started_at-ordered DESC for display, so
    // `before_started_at` gives a stable cursor without OFFSET scans.
    before_started_at: Option<i64>,
) -> DbResult<Vec<AutomationRun>> {
    let sql = match before_started_at {
        Some(_) => format!(
            "SELECT {RUN_COLUMNS} FROM automation_runs
               WHERE automation_id = ?1 AND started_at < ?3
               ORDER BY started_at DESC
               LIMIT ?2"
        ),
        None => format!(
            "SELECT {RUN_COLUMNS} FROM automation_runs
               WHERE automation_id = ?1
               ORDER BY started_at DESC
               LIMIT ?2"
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = if let Some(b) = before_started_at {
        stmt.query_map(params![automation_id, limit, b], map_run)?
    } else {
        stmt.query_map(params![automation_id, limit], map_run)?
    };
    rows.collect()
}

/// Count of runs for an automation (for the sidebar list "X runs" badge).
pub fn count_runs_for(conn: &Connection, automation_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM automation_runs WHERE automation_id = ?1",
        params![automation_id],
        |r| r.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> AutomationInput {
        AutomationInput {
            name: name.into(),
            prompt: "fix the tests".into(),
            harness: "claude_code".into(),
            model: None,
            cwd: Some("D:/proj".into()),
            schedule: "2 9 * * 1-5".into(),
            enabled: None,
        }
    }

    #[test]
    fn create_list_update_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();

        let a = create_automation(&conn, &input("nightly")).unwrap();
        assert!(a.enabled);
        assert_eq!(a.schedule, "2 9 * * 1-5");
        assert_eq!(list_automations(&conn).unwrap().len(), 1);

        let mut edited = input("nightly-2");
        edited.schedule = "*/30 * * * *".into();
        edited.model = Some("opus".into());
        update_automation(&conn, &a.id, &edited).unwrap();
        let reloaded = get_automation(&conn, &a.id).unwrap().unwrap();
        assert_eq!(reloaded.name, "nightly-2");
        assert_eq!(reloaded.schedule, "*/30 * * * *");
        assert_eq!(reloaded.model, "opus");

        set_automation_enabled(&conn, &a.id, false).unwrap();
        assert!(!get_automation(&conn, &a.id).unwrap().unwrap().enabled);

        record_run(&conn, &a.id, "ok", Some("chat-1")).unwrap();
        let after = get_automation(&conn, &a.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("ok"));
        assert_eq!(after.chat_session_id.as_deref(), Some("chat-1"));
        assert!(after.last_run_at.is_some());

        // A later run without a session id keeps the bound one.
        record_run(&conn, &a.id, "skipped", None).unwrap();
        let after2 = get_automation(&conn, &a.id).unwrap().unwrap();
        assert_eq!(after2.chat_session_id.as_deref(), Some("chat-1"));

        delete_automation(&conn, &a.id).unwrap();
        assert!(list_automations(&conn).unwrap().is_empty());
    }
}
