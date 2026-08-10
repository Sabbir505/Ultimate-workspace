//! Automations scheduler — fires stored cron schedules as headless one-shot
//! agent turns (see agent_sessions::run_one_shot).
//!
//! One tokio task ticks every 30s while the app runs; each due automation is
//! launched on its own std thread (the turn itself is blocking process I/O).
//! Runs force `full_auto` permission because unattended turns can't answer
//! prompts, and every turn is logged into the automation's own chat session
//! so transcripts show up in the normal chat UI.
//!
//! Two deliberate policies:
//! - **Overlap → skip.** If the previous run is still going the tick records
//!   "skipped" and moves on; automations never pile up processes.
//! - **Missed windows → one catch-up.** Due-ness is computed from the LAST
//!   run (or creation), so an automation that was due while the app was
//!   closed fires exactly once on the next tick — not once per missed slot.
//!
//! Running while Conduit itself is closed is the `conduit-automation` binary's
//! job (bin/conduit_automation.rs) — it reuses the same `launch_run` path,
//! so a Windows Task Scheduler entry is the only piece left to add.

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;

use crate::agent_sessions;
use crate::db::{
    self, create_chat_session, finish_run, list_automations, record_run, record_status,
    start_run, update_chat_session_agent, update_chat_session_title, Automation,
};

/// Automation ids with a run currently in flight (the overlap guard).
static RUNNING: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Start the background tick loop (called once from the app setup hook).
pub fn start(app: AppHandle, db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        // Fire the first tick immediately so catch-up runs don't wait 30s.
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            tick(Some(&app), &db);
        }
    });
}

/// One scheduler pass: launch every automation whose next fire time is due.
fn tick(app: Option<&AppHandle>, db: &Arc<Mutex<Connection>>) {
    let now = db::now_ts();
    let due: Vec<Automation> = {
        let running = RUNNING.lock();
        let conn = db.lock();
        list_automations(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.enabled)
            // A run already in flight can span many ticks; it isn't "due"
            // again until it finishes — attempting it would only stamp a
            // spurious "skipped" over the healthy run's status.
            .filter(|a| !running.contains(&a.id))
            .filter(|a| {
                let after = a.last_run_at.unwrap_or(a.created_at);
                next_fire(&a.schedule, after).is_some_and(|t| t <= now)
            })
            .collect()
    };
    for automation in due {
        let _ = launch_run(app, db, &automation, RunSource::Scheduled);
    }
}

/// Normalize the user-facing 5-field cron (minute-first) to the `cron`
/// crate's seconds-first format, then parse. Returns Err on bad input —
/// used both for command-side validation and due-time math.
fn parse_schedule(expr: &str) -> Result<cron::Schedule, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let normalized = match fields.len() {
        5 => format!("0 {expr}"),
        6 | 7 => expr.to_string(),
        _ => return Err(format!("invalid cron expression '{expr}' (expected 5 fields)")),
    };
    cron::Schedule::from_str(&normalized).map_err(|e| format!("invalid cron expression '{expr}': {e}"))
}

/// Validate a schedule string (command layer rejects bad input up front).
pub fn validate_schedule(expr: &str) -> Result<(), String> {
    parse_schedule(expr).map(|_| ())
}

/// The next fire time (unix ts) strictly after `after_ts`, in local time.
fn next_fire(expr: &str, after_ts: i64) -> Option<i64> {
    let sched = parse_schedule(expr).ok()?;
    let after = chrono::DateTime::from_timestamp(after_ts, 0)?.with_timezone(&chrono::Local);
    sched.after(&after).next().map(|dt| dt.timestamp())
}

/// Launch one run of an automation on a background thread. Shared by the
/// scheduler tick and the run-now command. Returns immediately; the outcome
/// is recorded on the row when the turn ends.
pub fn launch_run(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    source: RunSource,
) -> Result<(), String> {
    let Some(prepared) = prepare_run(db, automation, source)? else {
        return Ok(()); // overlap — already recorded as "skipped"
    };
    let app2 = app.cloned();
    let db2 = Arc::clone(db);
    let a = automation.clone();
    std::thread::spawn(move || {
        // catch_unwind so a panic in execute still releases the RUNNING
        // set entry and the on-disk lock file — otherwise the automation
        // would be permanently stuck in "running" state.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute(app2.as_ref(), &db2, &a, &prepared)
        }))
        .map_err(|p| {
            // Render the panic payload into a string status.
            let msg = if let Some(s) = p.downcast_ref::<&'static str>() {
                (*s).to_string()
            } else if let Some(s) = p.downcast_ref::<String>() {
                s.clone()
            } else {
                "automation panicked".to_string()
            };
            format!("panic: {msg}")
        })
        .and_then(|r| r);
        finalize(&db2, &a, &prepared, result);
    });
    Ok(())
}

/// How a run was triggered. Stored on the run row so the UI can show the
/// source ("scheduled" vs "manual") in the Past Runs list.
#[derive(Debug, Clone, Copy)]
pub enum RunSource {
    Scheduled,
    Manual,
}

impl RunSource {
    fn as_str(self) -> &'static str {
        match self {
            RunSource::Scheduled => "scheduled",
            RunSource::Manual => "manual",
        }
    }
}

/// Blocking variant for the headless `conduit-automation` binary: the process
/// must not exit before the turn ends. Same guards and recording as launch_run.
pub fn run_blocking(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
) -> Result<(), String> {
    let Some(prepared) = prepare_run(db, automation, RunSource::Manual)? else {
        return Ok(());
    };
    let result = execute(app, db, automation, &prepared);
    let outcome = match &result {
        Ok(()) => Ok(()),
        Err(e) => Err(e.clone()),
    };
    finalize(db, automation, &prepared, result);
    outcome
}

/// Everything a run needs that must happen BEFORE the process is spawned:
/// both overlap guards and the run-log chat-session binding.
struct PreparedRun {
    chat_session_id: String,
    /// Cross-process lock file (covers app-scheduler vs Task Scheduler
    /// double-fire); deleted in `finalize`. None for in-memory DBs (tests).
    lock_path: Option<std::path::PathBuf>,
    /// Row id in automation_runs — finalized with status/summary on completion.
    run_id: String,
}

fn prepare_run(db: &Arc<Mutex<Connection>>, automation: &Automation, source: RunSource) -> Result<Option<PreparedRun>, String> {
    prepare_run_inner(db, automation, source, 0)
}

/// Release both overlap guards after a post-guard prepare failure. Without
/// this the automation id stays in RUNNING forever (and the lock file on
/// disk), so every future scheduler tick and manual run is swallowed as
/// "already running" until the app restarts — a transient DB error
/// permanently kills the automation.
fn release_guards(automation_id: &str, lock_path: &Option<std::path::PathBuf>) {
    RUNNING.lock().remove(automation_id);
    if let Some(p) = lock_path {
        let _ = std::fs::remove_file(p);
    }
}

/// Inner recursion with a depth limit to prevent unbounded recursion
/// if a misbehaving process repeatedly recreates the lock file.
fn prepare_run_inner(db: &Arc<Mutex<Connection>>, automation: &Automation, source: RunSource, depth: u32) -> Result<Option<PreparedRun>, String> {
    const MAX_PREPARE_DEPTH: u32 = 3;
    // Guard 1: this process (scheduler tick vs run-now button).
    {
        let mut running = RUNNING.lock();
        if !running.insert(automation.id.clone()) {
            drop(running);
            let conn = db.lock();
            let _ = record_status(&conn, &automation.id, "skipped");
            return Ok(None);
        }
    }
    // Guard 2: across processes (app vs conduit-automation binary). The lock
    // file lives next to the DB; create_new fails atomically if another
    // process holds it. A stale lock from a crash blocks one run, then the
    // next prepare succeeds after the stale file is removed — we unlink a
    // lock older than 6h as a self-heal.
    let mut lock_path = None;
    {
        let conn = db.lock();
        if let Some(path) = lock_file_path(&conn, &automation.id) {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => lock_path = Some(path),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(6 * 3600));
                    drop(conn);
                    RUNNING.lock().remove(&automation.id);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        // Recurse with depth limit to guard against a
                        // misbehaving process that recreates the lock file
                        // immediately after deletion.
                        if depth + 1 >= MAX_PREPARE_DEPTH {
                            let conn = db.lock();
                            let _ = record_status(&conn, &automation.id, "skipped");
                            return Ok(None);
                        }
                        return prepare_run_inner(db, automation, source, depth + 1);
                    }
                    let conn = db.lock();
                    let _ = record_status(&conn, &automation.id, "skipped");
                    return Ok(None);
                }
                Err(_) => {} // filesystem hiccup — run without the file guard
            }
        }
    }

    // Bind (once) the chat session that doubles as this automation's run log.
    let chat_session_id = {
        let conn = db.lock();
        match &automation.chat_session_id {
            Some(id) => id.clone(),
            None => {
                let cs = match create_chat_session(&conn, &automation.harness, &automation.model, None) {
                    Ok(cs) => cs,
                    Err(e) => {
                        let msg = e.to_string();
                        drop(conn);
                        release_guards(&automation.id, &lock_path);
                        return Err(msg);
                    }
                };
                let agent = format!("harness:{}", automation.harness);
                let _ = update_chat_session_agent(&conn, &cs.id, Some(&agent));
                let _ = update_chat_session_title(&conn, &cs.id, &format!("⚙ {}", automation.name));
                cs.id
            }
        }
    };
    // Record the run for the UI's "Past runs" list (automation_runs).
    let run_id = {
        let conn = db.lock();
        match start_run(&conn, &automation.id, Some(&chat_session_id), source.as_str()) {
            Ok(id) => id,
            Err(e) => {
                let msg = e.to_string();
                drop(conn);
                release_guards(&automation.id, &lock_path);
                return Err(msg);
            }
        }
    };
    Ok(Some(PreparedRun { chat_session_id, lock_path, run_id }))
}

/// `<db file>.automation-<id>.lock` — next to conduit.db so every process
/// that opens the same DB agrees on the location. None for in-memory DBs.
fn lock_file_path(conn: &Connection, automation_id: &str) -> Option<std::path::PathBuf> {
    let db_file: String = conn
        .query_row("PRAGMA database_list", [], |r| r.get(2))
        .ok()?;
    if db_file.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(format!(
        "{db_file}.automation-{automation_id}.lock"
    )))
}

/// The turn itself: one blocking headless shot at full-auto permission
/// (unattended turns can't answer prompts).
fn execute(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    prepared: &PreparedRun,
) -> Result<(), String> {
    agent_sessions::run_one_shot(
        app,
        db,
        &prepared.chat_session_id,
        &automation.prompt,
        &automation.harness,
        &automation.model,
        if automation.cwd.is_empty() { None } else { Some(automation.cwd.as_str()) },
    )
}

/// Record the outcome and release both overlap guards.
fn finalize(
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    prepared: &PreparedRun,
    result: Result<(), String>,
) {
    let status = match &result {
        Ok(()) => "ok".to_string(),
        Err(e) => e.clone(),
    };
    let summary = summarize(&status);
    {
        let conn = db.lock();
        let _ = record_run(&conn, &automation.id, &status, Some(&prepared.chat_session_id));
        let _ = finish_run(&conn, &prepared.run_id, &status, &summary);
    }
    if let Some(path) = &prepared.lock_path {
        let _ = std::fs::remove_file(path);
    }
    RUNNING.lock().remove(&automation.id);
}

/// Render the final status into a one-line summary for the run row. Keep it
/// short — the UI shows it inline in the Past Runs list.
fn summarize(status: &str) -> String {
    if status == "ok" {
        return "Completed".into();
    }
    if status == "skipped" {
        return "Skipped (previous run still in flight)".into();
    }
    // Take CHARS, not bytes: `&status[..120]` panics when byte 120 lands on
    // a multibyte boundary, and status is arbitrary error text (provider
    // messages are full of non-ASCII). A panic here propagates out of
    // finalize() and skips the RUNNING/lock cleanup — the automation then
    // looks "running" forever and never fires again.
    if status.chars().count() > 120 {
        format!("{}…", status.chars().take(120).collect::<String>())
    } else {
        status.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_field_cron_is_accepted_and_due_math_works() {
        validate_schedule("2 9 * * 1-5").unwrap();
        validate_schedule("*/15 * * * *").unwrap();
        assert!(validate_schedule("not a schedule").is_err());
        assert!(validate_schedule("* * *").is_err());

        // Next fire exists and lands in the future relative to `after`.
        let after = db::now_ts();
        let next = next_fire("*/15 * * * *", after).unwrap();
        assert!(next > after);
        assert!(next <= after + 15 * 60 + 1);
    }

    #[test]
    fn seconds_first_expressions_still_parse() {
        // Power users may paste the cron crate's native 6/7-field form.
        validate_schedule("0 2 9 * * 1-5").unwrap();
    }

    #[test]
    fn summarize_truncates_on_char_boundary_not_byte() {
        // Regression: `&status[..120]` panicked when byte 120 fell mid-
        // codepoint — and the panic skipped RUNNING/lock cleanup, wedging
        // the automation as "running" forever.
        // 119 ASCII bytes + one 3-byte char: byte 120 is inside the 'é'.
        let mut s = "x".repeat(119);
        s.push('é');
        s.push_str(&"y".repeat(50));
        let out = summarize(&s);
        assert_eq!(out.chars().count(), 121, "120 chars + ellipsis, got {out:?}");
        assert!(out.ends_with('…'));
        // Short strings pass through untouched; multibyte-heavy ones too.
        assert_eq!(summarize("boom"), "boom");
        assert_eq!(summarize("ok"), "Completed");
        let emoji_heavy = "🔥".repeat(200);
        assert_eq!(summarize(&emoji_heavy).chars().count(), 121);
    }
}
