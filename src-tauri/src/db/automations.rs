//! Automations (scheduled headless agent runs) — persistence.
//!
//! One row per automation: a stored prompt + harness/model/cwd + a 5-field
//! cron schedule. Runs are forced to `full_auto` permission (unattended turns
//! can't answer prompts) and are logged into the automation's own chat
//! session (`chat_session_id`) so transcripts/diffs/cost show up in the
//! normal chat UI. The scheduler lives in crate::automations; the headless
//! runner binary (bin/relay_automation.rs) reads these same rows.

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
    /// "user" (Automations view form) or "agent" (chat create_automation
    /// tool). Runs are full-auto by design; the UI badges agent-authored rows
    /// so the user can always see what the model scheduled.
    #[serde(default = "default_origin")]
    pub origin: String,
    /// Firing engine: "cron" (default) | "webhook" | "file" | "git" |
    /// "gmail". Everything except "cron" is evaluated by
    /// crate::automation_triggers; for those the `schedule` column may be
    /// empty.
    #[serde(default = "default_trigger_type")]
    pub trigger_type: String,
    /// JSON payload for the trigger engine (serde-shaped by
    /// automation_triggers::TriggerSpec): webhook = {} (plus the secret),
    /// file = {path, minIntervalSecs?}, git = {cwd, branch?},
    /// gmail = {label?}.
    #[serde(default)]
    pub trigger_config: String,
    /// Trigger engine dedupe state — last seen git SHA, the epoch of the
    /// last fs-triggered fire, or the last Gmail historyId (see
    /// crate::automation_triggers). NULL until the first evaluation.
    #[serde(default)]
    pub last_trigger_state: Option<String>,
    /// Timestamp of the most recent EVENT-triggered run
    /// (webhook/file/git/email). Event runs advance this instead of
    /// `last_run_at`, so they never push the cron schedule's next fire into
    /// the future.
    #[serde(default)]
    pub last_event_run_at: Option<i64>,
}

fn default_origin() -> String {
    "user".to_string()
}

fn default_trigger_type() -> String {
    "cron".to_string()
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
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub name: String,
    pub prompt: String,
    pub harness: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub schedule: String,
    pub enabled: Option<bool>,
    /// "user" (UI form — the default when absent) or "agent" (chat tool).
    #[serde(default)]
    pub origin: Option<String>,
    /// Firing engine ("cron" default | "webhook" | "file" | "git" |
    /// "gmail"). None keeps the stored value on update.
    #[serde(default)]
    pub trigger_type: Option<String>,
    /// JSON trigger payload. None keeps the stored value on update.
    #[serde(default)]
    pub trigger_config: Option<String>,
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
        origin: row.get("origin").unwrap_or_else(|_| default_origin()),
        trigger_type: row
            .get("trigger_type")
            .unwrap_or_else(|_| default_trigger_type()),
        trigger_config: row.get("trigger_config").unwrap_or_else(|_| "{}".into()),
        last_trigger_state: row.get("last_trigger_state").unwrap_or(None),
        last_event_run_at: row.get("last_event_run_at").unwrap_or(None),
    })
}

const COLUMNS: &str =
    "id, name, prompt, harness, model, cwd, schedule, enabled, last_run_at, last_status, chat_session_id, created_at, origin, trigger_type, trigger_config, last_trigger_state, last_event_run_at";

pub fn create_automation(conn: &Connection, input: &AutomationInput) -> DbResult<Automation> {
    let id = new_id();
    conn.execute(
        "INSERT INTO automations (id, name, prompt, harness, model, cwd, schedule, enabled, created_at, origin, trigger_type, trigger_config)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
            input.origin.as_deref().unwrap_or("user"),
            input.trigger_type.as_deref().filter(|t| !t.is_empty()).unwrap_or("cron"),
            input.trigger_config.as_deref().unwrap_or("{}"),
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
        "UPDATE automations SET name = ?2, prompt = ?3, harness = ?4, model = ?5, cwd = ?6, schedule = ?7,
           trigger_type = COALESCE(?8, trigger_type), trigger_config = COALESCE(?9, trigger_config)
         WHERE id = ?1",
        params![
            automation_id,
            input.name,
            input.prompt,
            input.harness,
            input.model.as_deref().unwrap_or(""),
            input.cwd.as_deref().unwrap_or(""),
            input.schedule,
            // None = "keep the stored trigger engine/payload" (the chat tool's
            // partial-update merge relies on this); Some overwrites.
            input.trigger_type,
            input.trigger_config,
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

pub fn set_automation_enabled(
    conn: &Connection,
    automation_id: &str,
    enabled: bool,
) -> DbResult<()> {
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
///
/// The timestamp split follows the run's SOURCE: a "scheduled" (cron) run
/// advances `last_run_at` — that's what makes the cron clock tick. An event
/// run (webhook / fs / git / email) advances `last_event_run_at` INSTEAD,
/// because next_fire computes from last_run_at: letting a webhook call move
/// the schedule would silently delay every later cron slot.
pub fn record_run(
    conn: &Connection,
    automation_id: &str,
    status: &str,
    chat_session_id: Option<&str>,
    source: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET
           last_status = ?3,
           chat_session_id = COALESCE(?4, chat_session_id),
           last_run_at = CASE WHEN ?5 = 'scheduled' THEN ?2 ELSE last_run_at END,
           last_event_run_at = CASE WHEN ?5 = 'scheduled' THEN last_event_run_at ELSE ?2 END
         WHERE id = ?1",
        params![automation_id, now_ts(), status, chat_session_id, source],
    )?;
    Ok(())
}

/// Store the trigger engine's dedupe state — the last seen git SHA for
/// `git` triggers, the last-fire epoch for `file` triggers (see
/// crate::automation_triggers). Compare-then-fire protocol: the engine
/// reads this, decides, and writes the new value back in the same pass.
pub fn set_automation_trigger_state(
    conn: &Connection,
    automation_id: &str,
    state: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET last_trigger_state = ?2 WHERE id = ?1",
        params![automation_id, state],
    )?;
    Ok(())
}

/// Rebind (or clear with `None`) the automation's run-log chat session.
/// Used when the stored session vanished (deleted by the user, swept as an
/// empty chat) and the runner creates a fresh one — writing immediately, not
/// waiting for finalize's record_run, keeps the pointer from dangling across
/// a crash mid-run.
pub fn set_automation_chat_session(
    conn: &Connection,
    automation_id: &str,
    chat_session_id: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE automations SET chat_session_id = ?2 WHERE id = ?1",
        params![automation_id, chat_session_id],
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
    // Self-improving artifacts (SELF_IMPROVING_ARTIFACTS.md §5, Q4 decision):
    // automation_runs stays the source of truth; each run is mirrored into
    // the improve registry so sweeps/evals see automation failures alongside
    // skills/loops/templates. Best-effort — never fail the real run.
    if let Ok(Some(improve_run_id)) = mirror_run_start(conn, automation_id, chat_session_id) {
        // NOT swallowed: if this link UPDATE fails the mirrored improve_runs
        // row stays open with no back-reference. `sweep_stale_automation_runs`
        // can still reach it via the `chat_session_id` fallback in its WHERE,
        // but only because of that fallback — the primary subquery needs this
        // very link. A silent failure here is what left permanently-open
        // improve_runs rows out of `improve::run_health`'s failure stats.
        if let Err(e) = conn.execute(
            "UPDATE automation_runs SET improve_run_id = ?2 WHERE id = ?1",
            params![id, improve_run_id],
        ) {
            eprintln!("[automations] could not link run {id} to improve run {improve_run_id}: {e}");
        }
    }
    Ok(id)
}

/// Mirror a starting automation run into the improve registry. Registers the
/// automation as an artifact on first sight and records a new version when
/// the prompt changed since the stored one (user edits are version history).
fn mirror_run_start(
    conn: &Connection,
    automation_id: &str,
    chat_session_id: Option<&str>,
) -> DbResult<Option<String>> {
    let (name, prompt): (String, String) = match conn.query_row(
        "SELECT name, prompt FROM automations WHERE id = ?1",
        params![automation_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let artifact =
        super::improve::ensure_artifact(conn, "automation", automation_id, &name, &prompt)?;
    let active = super::improve::channel_version(conn, &artifact.id, "active")?.unwrap_or(1);
    if let Some(active_body) = super::improve::version_body(conn, &artifact.id, active)? {
        if active_body != prompt {
            // Point `active` at the version record_version ACTUALLY created. It
            // numbers rows `MAX(version) + 1`, NOT `active + 1` — the two
            // diverge whenever `active` lags MAX (the improve engine records
            // candidate versions without moving `active`, and `set_channel` is
            // also the documented rollback primitive). The old form made
            // `active` point at the ENGINE's candidate body instead of the
            // user's prompt, attributing every later run's telemetry to the
            // wrong version and desyncing permanently (audit H15).
            //
            // One transaction, not two autocommitted statements: a crash or
            // SQLITE_BUSY between the INSERT and the channel UPSERT left
            // `active` on the old version while the new row existed — the next
            // run appended a byte-identical duplicate (numbering is
            // MAX+1, so UNIQUE(artifact_id, version) never fires) and stamped
            // itself with the stale channel_version.
            super::improve::record_version_and_activate(
                conn,
                &artifact.id,
                active,
                &prompt,
                None,
                "user",
                "active",
            )?;
        }
    }
    super::improve::start_run(conn, &artifact.id, chat_session_id).map(Some)
}

/// Finalize a run (set finished_at + status + summary). Returns silently if
/// the row was already finalized by another path (idempotent finalize).
/// Boot sweep: settle `automation_runs` rows left `running` by a process that
/// exited mid-run (audit H23).
///
/// The app's exit path kills only PTYs/MCP children, and the boot sweep
/// covered SUBAGENT runs only — so a routine app close during a run (runs last
/// up to `MAX_RUN_SECS` = 2h) permanently left the row (and its mirrored
/// `improve_runs` row) at `finished_at IS NULL, status='running'`: a phantom
/// in-progress run in Past Runs and skewed improve-registry failure stats. The
/// cross-process lock file already had PID-based stale detection (B-28); the DB
/// rows did not. Same age-gate as the subagent sweep so a concurrently running
/// second instance is never disturbed.
pub fn sweep_stale_automation_runs(conn: &Connection, max_age_secs: i64) {
    let now = now_ts();
    let cutoff = now - max_age_secs;
    let settled = conn
        .execute(
            "UPDATE automation_runs SET finished_at = ?1, status = 'interrupted', \
             summary = COALESCE(summary, 'interrupted — the app exited mid-run') \
             WHERE finished_at IS NULL AND started_at <= ?2",
            params![now, cutoff],
        )
        .map(|n| n as i64)
        .unwrap_or(0);
    // Close the mirrored improve runs too, so the registry's failure stats
    // match reality after an unclean exit.
    //
    // `outcome` is the column, NOT `status`: `improve_runs` (db/mod.rs) has
    // `outcome TEXT` and no `status` at all, so the old statement failed at
    // PREPARE time and `let _ =` discarded it — every mirrored row stayed open
    // forever and, since `improve::run_health` only counts `finished_at IS
    // NOT NULL`, silently dropped out of the failure-rate stats.
    //
    // Two ways to reach a mirrored row, OR'd:
    //  - the `improve_run_id` back-reference set by `start_run`;
    //  - the shared `chat_session_id`, for the case where that back-reference
    //    UPDATE failed and the row has no link at all (the first subquery needs
    //    the very link that is missing). The fallback additionally requires the
    //    artifact to be an automation and the session to hold NO still-running
    //    automation run, so it can never close another artifact's open run.
    if settled > 0 {
        match conn.execute(
            "UPDATE improve_runs SET finished_at = ?1, outcome = 'abandoned' \
             WHERE finished_at IS NULL AND ( \
                 id IN (SELECT improve_run_id FROM automation_runs \
                        WHERE improve_run_id IS NOT NULL AND finished_at = ?1) \
              OR (artifact_id IN (SELECT id FROM improve_artifacts WHERE kind = 'automation') \
                  AND chat_session_id IN (SELECT chat_session_id FROM automation_runs \
                                          WHERE chat_session_id IS NOT NULL AND finished_at = ?1) \
                  AND NOT EXISTS (SELECT 1 FROM automation_runs still_open \
                                   WHERE still_open.chat_session_id = improve_runs.chat_session_id \
                                     AND still_open.finished_at IS NULL)) )",
            params![now],
        ) {
            Ok(n) => eprintln!(
                "[automations] settled {settled} stale running row(s) left by a previous \
                 process (and {n} mirrored improve run(s))"
            ),
            // Not swallowed: a failure here is what left mirrored rows open
            // and invisible to `improve::run_health`.
            Err(e) => eprintln!(
                "[automations] settled {settled} stale running row(s), but closing the \
                 mirrored improve runs failed: {e}"
            ),
        }
    }
}

pub fn finish_run(conn: &Connection, run_id: &str, status: &str, summary: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE automation_runs
           SET finished_at = ?2, status = ?3, summary = ?4
           WHERE id = ?1 AND finished_at IS NULL",
        params![run_id, now_ts(), status, summary],
    )?;
    // Close the linked improve run with a mapped outcome: ok → applied,
    // skipped (overlap guard, no work happened) → abandoned, else failed.
    let improve_run_id: Option<String> = conn
        .query_row(
            "SELECT improve_run_id FROM automation_runs WHERE id = ?1",
            params![run_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(improve_run_id) = improve_run_id {
        let (outcome, error_code) = match status {
            "ok" => ("applied", None),
            "skipped" => ("abandoned", None),
            // A user stop is not an artifact failure — counting it as one
            // would make the improve registry's failure stats meaningless.
            "stopped" => ("abandoned", Some("stopped")),
            other => ("failed", Some(other)),
        };
        let _ = conn.execute(
            "UPDATE improve_runs
                SET finished_at = ?2, outcome = ?3, error_code = ?4
              WHERE id = ?1 AND finished_at IS NULL",
            params![improve_run_id, now_ts(), outcome, error_code],
        );
    }
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

    #[test]
    fn runs_mirror_into_improve_registry_and_close_with_outcome() {
        let conn = super::super::mem();
        let a = create_automation(&conn, &input("nightly")).unwrap();
        // Starting a run registers the automation as an improve artifact and
        // links the mirrored run.
        let run = start_run(&conn, &a.id, None, "scheduled").unwrap();
        let artifact_id: String = conn
            .query_row(
                "SELECT id FROM improve_artifacts WHERE kind = 'automation' AND ref_key = ?1",
                rusqlite::params![a.id],
                |r| r.get(0),
            )
            .unwrap();
        let improve_run_id: String = conn
            .query_row(
                "SELECT improve_run_id FROM automation_runs WHERE id = ?1",
                rusqlite::params![run],
                |r| r.get(0),
            )
            .unwrap();
        // A prompt edit before the next run records a user version and moves
        // the active pointer.
        update_automation(
            &conn,
            &a.id,
            &AutomationInput {
                name: "nightly".into(),
                prompt: "fix the tests quietly".into(),
                harness: "claude_code".into(),
                model: None,
                cwd: None,
                schedule: "0 3 * * *".into(),
                enabled: Some(true),
                origin: None,
                trigger_type: None,
                trigger_config: None,
            },
        )
        .unwrap();
        let run2 = start_run(&conn, &a.id, None, "scheduled").unwrap();
        let _ = run2;
        let active: i64 = conn
            .query_row(
                "SELECT c.version FROM improve_channels c WHERE c.artifact_id = ?1 AND c.channel = 'active'",
                rusqlite::params![artifact_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, 2, "prompt edit recorded as v2");
        // Failure outcome maps to failed on the improve run.
        finish_run(&conn, &run, "boom: pty gone", "boom").unwrap();
        let outcome: String = conn
            .query_row(
                "SELECT outcome FROM improve_runs WHERE id = ?1",
                rusqlite::params![improve_run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome, "failed");
        // Idempotent finish must not clobber the outcome.
        finish_run(&conn, &run, "ok", "").unwrap();
        let outcome2: String = conn
            .query_row(
                "SELECT outcome FROM improve_runs WHERE id = ?1",
                rusqlite::params![improve_run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome2, "failed");
    }

    /// A real on-disk DB in a temp dir (`db::open`, so busy_timeout and the
    /// post-schema migrations match production) rather than `mem()` — the sweep
    /// is what runs at BOOT against the user's actual file.
    fn temp_conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = crate::db::open(&dir.path().join("relay.db")).expect("open db");
        (dir, conn)
    }

    /// Backdate an automation run so `sweep_stale_automation_runs`'s age gate
    /// (started_at <= now - max_age) admits it.
    fn backdate_run(conn: &Connection, run_id: &str, secs: i64) {
        conn.execute(
            "UPDATE automation_runs SET started_at = started_at - ?2 WHERE id = ?1",
            params![run_id, secs],
        )
        .unwrap();
    }

    /// The sweep's `improve_runs` half used to name a `status` column that the
    /// table does not have (`improve_runs` has `outcome`), so the UPDATE failed
    /// at PREPARE time and `let _ =` hid it: mirrored rows stayed open forever
    /// and dropped out of `improve::run_health` (which counts only
    /// `finished_at IS NOT NULL`). Both halves must close.
    #[test]
    fn sweep_closes_the_mirrored_improve_run() {
        let (_dir, conn) = temp_conn();
        let a = create_automation(&conn, &input("nightly")).unwrap();
        let run = start_run(&conn, &a.id, Some("cs-1"), "scheduled").unwrap();
        let improve_run_id: String = conn
            .query_row(
                "SELECT improve_run_id FROM automation_runs WHERE id = ?1",
                params![run],
                |r| r.get(0),
            )
            .unwrap();
        backdate_run(&conn, &run, 7200);

        sweep_stale_automation_runs(&conn, 3600);

        let (status, improve_finished, outcome): (String, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT r.status, i.finished_at, i.outcome
                   FROM automation_runs r JOIN improve_runs i ON i.id = ?1
                  WHERE r.id = ?2",
                params![improve_run_id, run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "interrupted");
        assert!(
            improve_finished.is_some(),
            "the mirrored improve_runs row must be closed, not left open forever"
        );
        assert_eq!(outcome.as_deref(), Some("abandoned"));
    }

    /// The `improve_run_id` back-reference can be missing (its UPDATE failed,
    /// and `improve_runs.chat_session_id` carries no FK so deleting the
    /// session never closes the row). The sweep's `chat_session_id` fallback
    /// must still reach such a row — without it the primary subquery needs the
    /// very link that is missing.
    #[test]
    fn sweep_closes_an_unlinked_mirrored_run_via_the_session() {
        let (_dir, conn) = temp_conn();
        let a = create_automation(&conn, &input("nightly")).unwrap();
        let run = start_run(&conn, &a.id, Some("cs-orphan"), "scheduled").unwrap();
        let improve_run_id: String = conn
            .query_row(
                "SELECT improve_run_id FROM automation_runs WHERE id = ?1",
                params![run],
                |r| r.get(0),
            )
            .unwrap();
        // Simulate the swallowed link UPDATE failing.
        conn.execute(
            "UPDATE automation_runs SET improve_run_id = NULL WHERE id = ?1",
            params![run],
        )
        .unwrap();
        backdate_run(&conn, &run, 7200);

        sweep_stale_automation_runs(&conn, 3600);

        let (finished, outcome): (Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT finished_at, outcome FROM improve_runs WHERE id = ?1",
                params![improve_run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(
            finished.is_some(),
            "an unlinked mirrored run must still be swept by chat_session_id"
        );
        assert_eq!(outcome.as_deref(), Some("abandoned"));
    }

    /// The session fallback must not reach across into a session where an
    /// automation run is STILL running: its mirrored row stays open.
    #[test]
    fn sweep_leaves_a_mirrored_run_of_a_live_automation_alone() {
        let (_dir, conn) = temp_conn();
        let a = create_automation(&conn, &input("nightly")).unwrap();
        let stale = start_run(&conn, &a.id, Some("cs-shared"), "scheduled").unwrap();
        let live = start_run(&conn, &a.id, Some("cs-shared"), "scheduled").unwrap();
        let live_improve_run: String = conn
            .query_row(
                "SELECT improve_run_id FROM automation_runs WHERE id = ?1",
                params![live],
                |r| r.get(0),
            )
            .unwrap();
        // Drop only the back-reference on the LIVE row so the primary subquery
        // cannot find it — the fallback must refuse it on the open-run check.
        conn.execute(
            "UPDATE automation_runs SET improve_run_id = NULL WHERE id = ?1",
            params![live],
        )
        .unwrap();
        backdate_run(&conn, &stale, 7200);

        sweep_stale_automation_runs(&conn, 3600);

        let stale_improve_run: String = conn
            .query_row(
                "SELECT improve_run_id FROM automation_runs WHERE id = ?1",
                params![stale],
                |r| r.get(0),
            )
            .unwrap();
        let (live_finished, live_status, stale_finished): (Option<i64>, String, Option<i64>) = conn
            .query_row(
                "SELECT i.finished_at,
                        (SELECT r.status FROM automation_runs r WHERE r.id = ?2),
                        (SELECT j.finished_at FROM improve_runs j WHERE j.id = ?3)
                   FROM improve_runs i WHERE i.id = ?1",
                params![live_improve_run, live, stale_improve_run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(live_status, "running", "the fresh run must not be settled");
        assert!(
            live_finished.is_none(),
            "a mirrored run whose automation is still running must stay open"
        );
        assert!(
            stale_finished.is_some(),
            "the stale sibling is still swept"
        );
    }

    /// `mirror_run_start` writes the version row and moves `active` as ONE
    /// logical change; if only the first landed, `active` would keep pointing
    /// at the old body and the next run would append a duplicate.
    #[test]
    fn mirror_run_start_moves_active_onto_the_new_version() {
        let conn = super::super::mem();
        let a = create_automation(&conn, &input("nightly")).unwrap();
        start_run(&conn, &a.id, None, "scheduled").unwrap();
        let artifact_id: String = conn
            .query_row(
                "SELECT id FROM improve_artifacts WHERE kind = 'automation' AND ref_key = ?1",
                params![a.id],
                |r| r.get(0),
            )
            .unwrap();

        let mut edited = input("nightly");
        edited.prompt = "a brand new prompt".into();
        update_automation(&conn, &a.id, &edited).unwrap();
        start_run(&conn, &a.id, None, "scheduled").unwrap();

        let active = super::super::improve::channel_version(&conn, &artifact_id, "active")
            .unwrap()
            .unwrap();
        let active_body = super::super::improve::version_body(&conn, &artifact_id, active)
            .unwrap()
            .unwrap();
        assert_eq!(active, 2, "prompt edit recorded as v2");
        assert_eq!(
            active_body, "a brand new prompt",
            "`active` must point at the version the prompt edit created, not v1"
        );

        // An immediate re-run with an UNCHANGED prompt is idempotent: no
        // duplicate version row, no channel movement.
        start_run(&conn, &a.id, None, "scheduled").unwrap();
        assert_eq!(
            super::super::improve::list_versions(&conn, &artifact_id).unwrap().len(),
            2,
            "an unchanged prompt must not append a duplicate version"
        );
        assert_eq!(
            super::super::improve::channel_version(&conn, &artifact_id, "active")
                .unwrap()
                .unwrap(),
            2
        );
    }

    fn input(name: &str) -> AutomationInput {
        AutomationInput {
            name: name.into(),
            prompt: "fix the tests".into(),
            harness: "claude_code".into(),
            model: None,
            cwd: Some("D:/proj".into()),
            schedule: "2 9 * * 1-5".into(),
            enabled: None,
            origin: None,
            trigger_type: None,
            trigger_config: None,
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

        record_run(&conn, &a.id, "ok", Some("chat-1"), "scheduled").unwrap();
        let after = get_automation(&conn, &a.id).unwrap().unwrap();
        assert_eq!(after.last_status.as_deref(), Some("ok"));
        assert_eq!(after.chat_session_id.as_deref(), Some("chat-1"));
        assert!(after.last_run_at.is_some());

        // A later run without a session id keeps the bound one.
        record_run(&conn, &a.id, "skipped", None, "scheduled").unwrap();
        let after2 = get_automation(&conn, &a.id).unwrap().unwrap();
        assert_eq!(after2.chat_session_id.as_deref(), Some("chat-1"));

        delete_automation(&conn, &a.id).unwrap();
        assert!(list_automations(&conn).unwrap().is_empty());
    }
}
