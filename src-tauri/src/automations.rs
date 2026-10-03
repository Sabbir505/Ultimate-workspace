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
//! A run is also hard-bounded by MAX_RUN_SECS: an unattended turn that hangs
//! used to hold the overlap guards forever, which read as a permanently
//! "running" automation that silently stopped triggering.
//!
//! Running while Relay itself is closed is the `relay-automation` binary's
//! job (bin/relay_automation.rs) — it reuses the same `launch_run` path,
//! so a Windows Task Scheduler entry is the only piece left to add.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;

use crate::agent_sessions;
use crate::db::{
    self, create_chat_session, finish_run, get_chat_session, list_automations, record_run,
    record_status, set_automation_chat_session, start_run, update_chat_session_agent,
    update_chat_session_model, update_chat_session_title, Automation,
};

/// Automation ids with a run currently in flight (the overlap guard).
static RUNNING: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Hard time limit for one automation turn (2h). Generous enough for long
/// agent runs, tight enough that a hung CLI can't hold the overlap guards
/// past a couple of schedule slots — before this bound existed, one wedged
/// turn made the automation look "already running" to every later tick and
/// it silently stopped firing until the app restarted.
const MAX_RUN_SECS: u64 = 2 * 60 * 60;
/// Age gate for the boot sweep of runs left `running` by an exited process
/// (audit H23). Matches MAX_RUN_SECS: a live run cannot be older than its
/// own ceiling, so anything past it belongs to a dead process (and a
// concurrently running second instance is untouched).
pub const STALE_RUNNING_SECS: i64 = MAX_RUN_SECS as i64;

/// Status recorded for a run the user stopped. Deliberately NOT a failure:
/// the Past Runs table badges it neutrally, the failure banner stays down,
/// and no failure notification (toast/mobile/webhook/email) fires.
pub const STOPPED_STATUS: &str = "stopped";

/// Error text a turn returns once its stop flag flipped, matched EXACTLY in
/// `finalize` — a harness whose own failure output happens to contain these
/// words must not be recorded as a user stop.
pub const STOPPED_ERROR: &str = "stopped by user";

/// Stop flags for runs in flight IN THIS PROCESS, keyed by automation id.
/// `stop_run` flips the flag; the run's own thread polls it, kills the CLI's
/// process tree, and finalizes the row as `STOPPED_STATUS`.
///
/// Runs owned by another process (the `relay-automation` Task Scheduler
/// binary) have no entry here — a stop can't reach across processes, so
/// `stop_run` reports "not ours" instead of pretending to have signalled.
/// Lock order is RUNNING then CANCEL, and the two are never held together.
static CANCEL: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Forget a run's stop flag. Called wherever a run leaves the RUNNING set —
/// after finalize and on every pre-spawn failure path.
fn release_cancel(automation_id: &str) {
    CANCEL.lock().remove(automation_id);
}

/// Ask the in-flight run of `automation_id` to stop. Returns `false` when no
/// run in this process holds the automation (already finished, or running
/// under Task Scheduler) — the caller can then say so rather than reporting a
/// stop that will never happen. Idempotent: a second press re-sets the flag.
pub fn stop_run(automation_id: &str) -> bool {
    let flag = CANCEL.lock().get(automation_id).map(Arc::clone);
    match flag {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Behavior rules appended to every automation prompt before a run. The turn
/// executes as ONE headless, full-auto shot — there is no user to answer a
/// clarifying question, and prompts that read as ambiguous used to make the
/// agent ask for input and stall instead of working.
const UNATTENDED_RUN_RULES: &str = "## Unattended run rules

- This run fires on a schedule: no user is present. Do NOT ask questions and do NOT wait for confirmation or clarification.
- Make reasonable assumptions, note them in your summary, and proceed with the task.
- If a step cannot be completed, record why and continue with the remaining work where possible.
- Finish with a short summary: what was done, what was produced, and any problems encountered.

";

/// `true` marker looked for so a prompt is only wrapped once (idempotent
/// across re-saves and pre-wrapped prompts).
const UNATTENDED_RULES_MARKER: &str = "## Unattended run rules";

fn ensure_unattended_rules(prompt: &str) -> String {
    if prompt.contains(UNATTENDED_RULES_MARKER) {
        prompt.to_string()
    } else {
        format!("{}\n{}", prompt.trim_end(), UNATTENDED_RUN_RULES)
    }
}

/// Start the background tick loop (called once from the app setup hook).
pub fn start(app: AppHandle, db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        // Fire the first tick immediately so catch-up runs don't wait 30s.
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            // The pass is BLOCKING work — it polls `git rev-parse` child
            // processes with `thread::sleep` (up to 5s per git automation on a
            // hung repo / network drive, exactly the case that bound
            // anticipates) and holds the DB lock across it. Running it
            // inline pegged a tokio worker every 30s, starving the same
            // runtime that serves every async `#[tauri::command]` and the
            // webhook listener's accept loop (audit H24). `github.rs` already
            // wraps its git subprocesses in spawn_blocking — same discipline.
            {
                let app_for_tick = app.clone();
                let db_for_tick = db.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    tick(Some(&app_for_tick), &db_for_tick);
                })
                .await;
            }
            // Gmail triggers ride the same 30s cadence but need async HTTP
            // (DB-backed token refresh + profile poll), so they evaluate
            // OUTSIDE the sync tick — per-automation tasks are spawned and
            // joined inside evaluate_gmail_triggers. Launches go through the
            // same launch_run overlap guard as every other source. (The git
            // evaluation stays inside the sync tick above.)
            let fired = crate::automation_triggers::evaluate_gmail_triggers(&db).await;
            for id in fired {
                let automation = {
                    let conn = db.lock();
                    db::get_automation(&conn, &id).ok().flatten()
                };
                let Some(automation) = automation else { continue };
                if let Err(e) = launch_run(Some(&app), &db, &automation, RunSource::Email) {
                    eprintln!("[automations] gmail-triggered launch failed for {}: {e}", automation.id);
                }
            }
        }
    });
}

/// One scheduler pass: launch every automation whose next fire time is due.
fn tick(app: Option<&AppHandle>, db: &Arc<Mutex<Connection>>) {
    let now = db::now_ts();
    // mi2: don't hold RUNNING across the DB query (and vice versa). Snapshot
    // the in-flight set first, release it, then take the DB lock alone. A run
    // finishing between the two snapshots could make a freshly-idle automation
    // look busy for one tick — harmless (it fires next tick).
    let running_now: std::collections::HashSet<String> =
        RUNNING.lock().iter().cloned().collect();
    let due = {
        let conn = db.lock();
        due_automations(&conn, now)
            .into_iter()
            // A run already in flight can span many ticks; it isn't "due"
            // again until it finishes — attempting it would only stamp a
            // spurious "skipped" over the healthy run's status.
            .filter(|a| !running_now.contains(&a.id))
            .collect::<Vec<_>>()
    };
    for automation in due {
        if let Err(e) = launch_run(app, db, &automation, RunSource::Scheduled) {
            eprintln!("[automations] scheduled launch failed for {}: {e}", automation.id);
        }
    }
    // Event triggers that need no resident process: a git HEAD-SHA comparison
    // is pure DB + `git rev-parse`, so it rides the same 30s tick. (Webhook
    // and file triggers have their own listeners/watchers; gmail needs async
    // HTTP and is evaluated in start's loop, right after this tick — see
    // automation_webhook.rs / automation_triggers.rs.) Fires respect the same
    // RUNNING overlap guard via launch_run.
    let fired_ids = crate::automation_triggers::evaluate_git_triggers(db);
    for id in fired_ids {
        let automation = {
            let conn = db.lock();
            db::get_automation(&conn, &id).ok().flatten()
        };
        let Some(automation) = automation else { continue };
        if let Err(e) = launch_run(app, db, &automation, RunSource::GitChange) {
            eprintln!("[automations] git-triggered launch failed for {}: {e}", automation.id);
        }
    }
}

/// Every enabled automation whose next fire time (computed from the last run,
/// or creation) is at or before `now`. Shared by the in-app scheduler tick
/// and the headless binary's `run-due` subcommand so both agree on due-ness
/// (missed windows fire exactly once on the next pass, not per missed slot).
pub fn due_automations(conn: &Connection, now: i64) -> Vec<Automation> {
    list_automations(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.enabled)
        // Only rows whose firing engine IS the cron tick participate in
        // cron due-ness. Event rows (webhook/file/git) have their own
        // engines; their `schedule` may be empty, and an empty string would
        // otherwise fail cron parsing on every tick forever.
        .filter(|a| a.trigger_type == "cron")
        .filter(|a| {
            let after = a.last_run_at.unwrap_or(a.created_at);
            next_fire(&a.schedule, after).is_some_and(|t| t <= now)
        })
        .collect()
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

/// The next fire for a row of ANY trigger type, as the IPC layer reports it:
/// cron rows return `(Some(unix_ts), "")`; event rows return a degraded human
/// string and no timestamp — never the misleading "schedule error — will not
/// fire" an unparsable (often empty) cron string would otherwise produce.
pub fn describe_next_fire(trigger_type: &str, schedule: &str, after_ts: i64) -> (Option<i64>, String) {
    match trigger_type {
        "webhook" => (None, "on webhook call".into()),
        "file" => (None, "on file change".into()),
        "git" => (None, "on git change".into()),
        "gmail" => (None, "on new email".into()),
        // cron (and anything unknown — treated as cron, matching the default
        // column value): the timestamp speaks for itself; the frontend formats
        // it, so the label stays empty.
        _ => (next_fire(schedule, after_ts), String::new()),
    }
}

/// The next fire time (unix ts) strictly after `after_ts`, in local time.
pub fn next_fire(expr: &str, after_ts: i64) -> Option<i64> {
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
    // Tell the (open) frontend the run is starting so it can mark the
    // run-log chat as streaming: without this the chat store drops every
    // chat:token the run emits (straggler guard — only sessions whose turn
    // the frontend itself began accept tokens). App-open runs only; the
    // headless binary has no listeners.
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit(
            "automation:run-started",
            serde_json::json!({
                "automationId": automation.id,
                "chatSessionId": prepared.chat_session_id,
            }),
        );
    }
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
        finalize(app2.as_ref(), &db2, &a, &prepared, result);
    });
    Ok(())
}

/// How a run was triggered. Stored on the run row so the UI can show the
/// source ("scheduled"/"manual"/"webhook"/"fs"/"git"/"email") in the Past
/// Runs list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunSource {
    /// Cron tick (in-app 30s loop or the run-due sidecar).
    Scheduled,
    /// Run-now button / chat run_automation_now.
    Manual,
    /// Inbound webhook trigger (automation_webhook.rs; app-open only).
    Webhook,
    /// File-watch trigger (automation_triggers.rs fs registry).
    FsWatch,
    /// Git HEAD-change trigger (30s tick or the run-due sidecar).
    GitChange,
    /// New-email trigger (Gmail historyId poll, automation_triggers.rs;
    /// app-open only).
    Email,
}

impl RunSource {
    fn as_str(self) -> &'static str {
        match self {
            RunSource::Scheduled => "scheduled",
            RunSource::Manual => "manual",
            RunSource::Webhook => "webhook",
            RunSource::FsWatch => "fs",
            RunSource::GitChange => "git",
            RunSource::Email => "email",
        }
    }

    /// True only for the cron engine: `db::record_run` advances
    /// `last_run_at` (the cron clock) for these and `last_event_run_at` for
    /// every event source, so a webhook/fs/git/email run never delays the
    /// schedule.
    pub fn is_scheduled(self) -> bool {
        matches!(self, RunSource::Scheduled)
    }
}

/// Whether an automation has a run in flight IN THIS PROCESS — used by the
/// webhook listener to answer 409 instead of launching a run that would only
/// be recorded as "skipped". (Runs owned by the Task Scheduler sidecar are
/// invisible here, same as for `stop_run`.)
pub fn is_running(automation_id: &str) -> bool {
    RUNNING.lock().contains(automation_id)
}

/// Blocking variant for the headless `relay-automation` binary: the process
/// must not exit before the turn ends. Same guards and recording as launch_run.
pub fn run_blocking(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
) -> Result<(), String> {
    run_blocking_with_source(app, db, automation, RunSource::Manual)
}

/// `run_blocking` with an explicit source — the binary's `run` subcommand is
/// manual, its `run-due` subcommand is scheduled (the Task Scheduler fires it).
pub fn run_blocking_with_source(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    source: RunSource,
) -> Result<(), String> {
    let Some(prepared) = prepare_run(db, automation, source)? else {
        return Ok(());
    };
    let result = execute(app, db, automation, &prepared);
    let outcome = match &result {
        Ok(()) => Ok(()),
        Err(e) => Err(e.clone()),
    };
    finalize(app, db, automation, &prepared, result);
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
    /// Set by `stop_run` from the Automations view. Shared with the RUNNING
    /// guard's lifetime: both are released together in `release_guards`.
    cancel: Arc<AtomicBool>,
    /// How this run was triggered — finalize routes the timestamp advance
    /// (last_run_at vs last_event_run_at) and the automation_runs.source
    /// label from it.
    source: RunSource,
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
    release_cancel(automation_id);
    if let Some(p) = lock_path {
        let _ = std::fs::remove_file(p);
    }
}

/// Stamp `skipped` only on the TRANSITION: while the external
/// `relay-automation` binary holds the lock file, the in-app scheduler
/// rejects this automation on every 30 s tick — re-writing last_status each
/// tick made the UI's status column flap for the whole external run.
fn stamp_skipped_once(db: &Arc<Mutex<Connection>>, automation: &Automation) {
    if automation.last_status.as_deref() == Some("skipped") {
        return; // already showing skipped — no write, no notify churn
    }
    let conn = db.lock();
    if let Err(e) = record_status(&conn, &automation.id, "skipped") {
        eprintln!("[automations] record_status(skipped) failed for {}: {e}", automation.id);
    }
}

/// B-28: is `pid` a live process? Windows-only — other platforms fall back
/// to the age-based staleness heuristic.
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        let _ = CloseHandle(handle);
        // STILL_ACTIVE can also be returned for a dead process whose exit
        // code happens to be 259 — vanishingly unlikely and only errs on the
        // cautious side (we keep waiting for the age heuristic).
        ok && code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    // B-28 closed: `kill(pid, 0)` performs a real liveness check on Unix —
    // signal 0 is delivered to nothing, it only validates the process
    // exists. EPERM means the process exists but is owned by another user
    // (pid recycling across a user switch) — counted as alive, which only
    // errs on the cautious side (we then wait for the age heuristic).
    // Safety: signal 0 kills nothing; the syscall is pure probing.
    let r = unsafe { libc::kill(pid as i32, 0) };
    if r == 0 {
        return true;
    }
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    errno == libc::EPERM
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
    // Publish the stop flag for this run. Registered outside the RUNNING
    // block (the two locks are never held together, so a stop can't queue
    // behind a scheduler tick's snapshot).
    let cancel = Arc::new(AtomicBool::new(false));
    CANCEL.lock().insert(automation.id.clone(), Arc::clone(&cancel));
    // Guard 2: across processes (app vs relay-automation binary). The lock
    // file lives next to the DB and records the owning PID; create_new fails
    // atomically if another process holds it. Staleness (B-28): a lock whose
    // PID is dead is stale IMMEDIATELY — the old age-only check (6h) left a
    // crashed run blocking every tick for up to 6 hours. A lock without a
    // parsable PID (pre-PID file, or a foreign writer) falls back to the 6h
    // age heuristic. A LIVE pid is never stale: run_one_shot is bounded at
    // 2h, so a long legitimate run must keep excluding other processes.
    let mut lock_path = None;
    {
        let conn = db.lock();
        if let Some(path) = lock_file_path(&conn, &automation.id) {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => {
                    // Record the owner so a crashed run's lock is recognizable
                    // as stale (B-28).
                    let _ = std::fs::write(&path, std::process::id().to_string());
                    lock_path = Some(path);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let recorded_pid = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|t| t.trim().parse::<u32>().ok());
                    let age_stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(6 * 3600));
                    let stale = match recorded_pid {
                        Some(pid) => !pid_alive(pid) || age_stale,
                        None => age_stale,
                    };
                    drop(conn);
                    release_guards(&automation.id, &None);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        // Recurse with depth limit to guard against a
                        // misbehaving process that recreates the lock file
                        // immediately after deletion.
                        if depth + 1 >= MAX_PREPARE_DEPTH {
                            stamp_skipped_once(db, automation);
                            return Ok(None);
                        }
                        return prepare_run_inner(db, automation, source, depth + 1);
                    }
                    stamp_skipped_once(db, automation);
                    return Ok(None);
                }
                Err(_) => {} // filesystem hiccup — run without the file guard
            }
        }
    }

    // Bind (once) the chat session that doubles as this automation's run log.
    // The stored pointer is re-validated on every run: if the session row is
    // gone (user deleted the run-log chat, or the empty-session sweeper took
    // it before its first message), reusing the dead id would fail the turn
    // with "FOREIGN KEY constraint failed" on chat_messages — recreate a
    // fresh session and rebind it immediately instead.
    let chat_session_id = {
        let conn = db.lock();
        let stored_alive = match &automation.chat_session_id {
            Some(id) => match get_chat_session(&conn, id) {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(e) => {
                    let msg = e.to_string();
                    drop(conn);
                    release_guards(&automation.id, &lock_path);
                    return Err(msg);
                }
            },
            None => false,
        };
        if stored_alive {
            let cs_id = automation.chat_session_id.clone().unwrap();
            // The stored session was created at FIRST run with the harness and
            // model current then — later edits to the automation never reached
            // it, so the run log kept showing (and any manual follow-up kept
            // spawning with) the stale model. Re-sync both on every launch.
            // An `agent:` harness re-syncs through the subagent vocabulary (see
            // `subagent_session_vocab`) so the row stays engine-addressable.
            let vocab = subagent_session_vocab(&conn, automation);
            let (agent, model) = match &vocab {
                Some((a, _, m, _)) => (a.clone(), m.clone()),
                None => (
                    format!("harness:{}", automation.harness),
                    automation.model.clone(),
                ),
            };
            let _ = update_chat_session_model(&conn, &cs_id, &model);
            let _ = update_chat_session_agent(&conn, &cs_id, Some(&agent));
            if let Some((_, _, _, def_id)) = &vocab {
                let _ = crate::db::set_chat_session_agent_def(&conn, &cs_id, Some(def_id));
            }
            cs_id
        } else {
            if automation.chat_session_id.is_some() {
                eprintln!(
                    "[automations] run-log chat session {:?} of {} is gone — recreating it",
                    automation.chat_session_id, automation.id
                );
            }
            let vocab = subagent_session_vocab(&conn, automation);
            let (provider, model) = match &vocab {
                Some((_, p, m, _)) => (p.clone(), m.clone()),
                None => (automation.harness.clone(), automation.model.clone()),
            };
            let cs = match create_chat_session(&conn, &provider, &model, None) {
                Ok(cs) => cs,
                Err(e) => {
                    let msg = e.to_string();
                    drop(conn);
                    release_guards(&automation.id, &lock_path);
                    return Err(msg);
                }
            };
            let agent = vocab
                .as_ref()
                .map(|(a, _, _, _)| a.clone())
                .unwrap_or_else(|| format!("harness:{}", automation.harness));
            let _ = update_chat_session_agent(&conn, &cs.id, Some(&agent));
            let _ = update_chat_session_title(&conn, &cs.id, &format!("⚙ {}", automation.name));
            if let Some((_, _, _, def_id)) = &vocab {
                let _ = crate::db::set_chat_session_agent_def(&conn, &cs.id, Some(def_id));
            }
            // Rebind NOW rather than at finalize: a crash between here and
            // finalize must not leave the row pointing at the dead session.
            let _ = set_automation_chat_session(&conn, &automation.id, Some(&cs.id));
            cs.id
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
    Ok(Some(PreparedRun { chat_session_id, lock_path, run_id, cancel, source }))
}

/// `<db file>.automation-<id>.lock` — next to relay.db so every process
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

/// Session-column vocabulary for an `agent:<id>` automation's run-log row.
///
/// `automation.harness` holds the `agent:` reference, but the run-log
/// session's `agent`/`provider`/`model` columns must hold ENGINE vocabulary
/// — every `chat_sessions` consumer (approval/model lookups, provider
/// labeling, the manual-follow-up path) resolves against `builtin |
/// harness:<cli> | acp:<id>` and a real provider, and the raw
/// `harness:agent:<id>` / provider `agent:<id>` this replaces fell dead in
/// each of them. Mirrors what `session_fabric` writes for a subagent child
/// (engine as agent, resolved provider for builtin engines, `agent_def_id`
/// link). Returns `(agent, provider, model, def_id)`.
///
/// `None` when the harness is not an `agent:` value — the plain paths keep
/// their own vocabulary — or when the definition cannot be resolved (the
/// run itself errors on that immediately after).
fn subagent_session_vocab(
    conn: &Connection,
    automation: &Automation,
) -> Option<(String, String, String, String)> {
    let rest = automation.harness.strip_prefix("agent:")?;
    let def = crate::chat::subagents::resolve_by_id_or_name(conn, rest)?;
    let engine = def.engine.clone().unwrap_or_else(|| "builtin".to_string());
    // Same precedence as the execute arm: the automation's own model wins
    // when set, otherwise the definition's.
    let model = if automation.model.is_empty() {
        def.model.clone().unwrap_or_default()
    } else {
        automation.model.clone()
    };
    if engine.starts_with("harness:") || engine.starts_with("acp:") {
        Some((engine.clone(), engine, model, def.id))
    } else {
        let (provider, model) =
            crate::chat::subagents::resolve_builtin_provider_model(conn, Some(&model)).ok()?;
        Some((engine, provider, model, def.id))
    }
}

/// The turn itself: one blocking headless shot at full-auto permission
/// (unattended turns can't answer prompts).
///
/// Hard-bounded by MAX_RUN_SECS: an unattended CLI turn that hangs (stalled
/// network, hidden interactive prompt) used to hold the overlap guards
/// forever — every later tick read as "already running" and the automation
/// silently stopped triggering until the app restarted. The kill unblocks the
/// run thread, `finalize` records the timeout as the run's status, and the
/// schedule resumes on its next slot.
fn execute(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    prepared: &PreparedRun,
) -> Result<(), String> {
    // A stop pressed while the run was still being prepared (run-log session
    // bind, run-row insert) must not go on to spawn a process only to kill it
    // a moment later.
    if prepared.cancel.load(Ordering::SeqCst) {
        return Err(STOPPED_ERROR.to_string());
    }
    // Route based on agent type:
    // - CLI harnesses (claude_code, opencode, pi-lineage) → spawn CLI process
    // - API providers and local_gguf → chat HTTP API
    // - `agent:<id>` → the subagent definition's engine and model, then the SAME
    //   two arms. The definition's prompt body rides the automation prompt as
    //   a directive block (same composition as manual and mesh subagent runs), so
    //   the run-log transcript shows exactly what the agent was told. The
    //   automation's own `model` wins over the definition's when set.
    //   (Worktree policy is NOT honored here yet — the manual and mesh paths
    //   provision via the session worktree seam; automations need a
    //   sidecar-safe variant. See the research doc Part E q5.)
    let prompt = ensure_unattended_rules(&automation.prompt);
    // The subagent slot held for an `agent:` run: (agent id, engine vocabulary
    // for the history row). Released after the one-shot returns.
    let mut subagent_slot: Option<(String, String)> = None;
    let (harness, provider, model, prompt) = if let Some(rest) =
        automation.harness.strip_prefix("agent:")
    {
        let (def_engine, def_provider, def_model, composed, slot_info) = {
            let conn = db.lock();
            let def = crate::chat::subagents::resolve_by_id_or_name(&conn, rest).ok_or_else(|| {
                format!("subagent \"{rest}\" not found — it may have been deleted")
            })?;
            // The automation's own model wins when set; otherwise the
            // definition's. Builtin engines resolve provider/model through
            // the shared helper — an engine label is NOT a provider, and
            // `run_one_shot_chat`'s parameter is the PROVIDER (the live test
            // caught both bugs at once: engine-as-provider and the unparsed
            // `provider::model` riding through).
            let model = if automation.model.is_empty() {
                def.model.clone().unwrap_or_default()
            } else {
                automation.model.clone()
            };
            let engine = def.engine.clone().unwrap_or_else(|| "builtin".into());
            let composed = crate::chat::subagents::compose_first_message(&def, &prompt);
            // (agent id, name, max_concurrent, engine vocabulary for the row)
            let slot_info = (
                def.id.clone(),
                def.name.clone(),
                def.max_concurrent,
                engine.clone(),
            );
            if let Some(cli) = engine.strip_prefix("harness:") {
                // The engine rides as `harness:<id>` (the session vocabulary)
                // but `run_one_shot` takes the BARE id — the live test caught
                // `harness:commandcode` falling through to the chat arm.
                (cli.to_string(), engine, model, composed, slot_info)
            } else if engine.starts_with("acp:") {
                return Err(format!(
                    "subagent \"{}\" runs on an ACP engine, which has no unattended \
                     one-shot path — bind the automation to a CLI-harness or builtin \
                     agent instead",
                    def.name
                ));
            } else {
                let (provider, model) =
                    crate::chat::subagents::resolve_builtin_provider_model(&conn, Some(&model))?;
                // The chat-HTTP arm dispatches on "not a CLI harness" but
                // dials with the PROVIDER — "builtin" would fail the key
                // lookup (the live test caught exactly that).
                (engine, provider, model, composed, slot_info)
            }
        };
        // Hold the agent's concurrency slot for the one-shot's lifetime —
        // the same budget the Run button and mesh `agent:` spawns respect.
        // Acquired after every fallible resolution above (an early error
        // never strands a slot), released after the dispatch returns.
        crate::chat::subagents::try_acquire_running(
            &slot_info.0,
            &slot_info.1,
            slot_info.2.max(1),
            crate::chat::subagents::MAX_ACTIVE_SUBAGENT,
        )?;
        subagent_slot = Some((slot_info.0.clone(), slot_info.3.clone()));
        (def_engine, def_provider, def_model, composed)
    } else {
        let h = automation.harness.clone();
        (h.clone(), h, automation.model.clone(), prompt)
    };
    // Run-history row for the automation trigger: the run-log session
    // doubles as the row's session — its transcript IS the run. Written only
    // once the slot is held (the run is committed); settled with the
    // one-shot's real outcome right after it returns.
    let subagent_run_id = subagent_slot.as_ref().and_then(|(agent_id, engine)| {
        let conn = db.lock();
        crate::session_fabric::record_subagent_run_start(
            &conn,
            agent_id,
            &prepared.chat_session_id,
            "automation",
            &automation.prompt,
            engine,
            &model,
            None,
        )
    });
    let result = match harness.as_str() {
        "claude_code" | "opencode" | "pi" | "omp" | "commandcode" => {
            agent_sessions::run_one_shot(
                app,
                db,
                &prepared.chat_session_id,
                &prompt,
                &harness,
                &model,
                if automation.cwd.is_empty() { None } else { Some(automation.cwd.as_str()) },
                Some(Duration::from_secs(MAX_RUN_SECS)),
                Some(&prepared.cancel),
            )
        }
        _ => {
            crate::chat::run_one_shot_chat(
                db,
                &prepared.chat_session_id,
                &prompt,
                &provider,
                &model,
                Some(&prepared.cancel),
            )
        }
    };
    if let Some(run_id) = &subagent_run_id {
        let (status, summary) = match &result {
            Ok(()) => ("ok", None),
            Err(e) => ("error", Some(crate::util::truncate_chars(e, 240))),
        };
        let conn = db.lock();
        crate::db::finish_subagent_run(&conn, run_id, status, summary.as_deref());
    }
    if let Some((agent_id, _)) = &subagent_slot {
        crate::chat::subagents::bump_running(agent_id, -1);
    }
    result
}

/// Record the outcome and release both overlap guards.
fn finalize(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    prepared: &PreparedRun,
    result: Result<(), String>,
) {
    let status = match &result {
        Ok(()) => "ok".to_string(),
        // A stop is its own outcome, not an error. Only the exact sentinel is
        // translated — a run that happened to fail while the user was also
        // pressing Stop keeps its real error.
        Err(e) if e == STOPPED_ERROR => STOPPED_STATUS.to_string(),
        Err(e) => e.clone(),
    };
    let summary = summarize(&status);
    {
        let conn = db.lock();
        // record_run is what advances the cron clock (last_run_at) for
        // scheduled runs — or last_event_run_at for webhook/fs/git runs, so
        // event triggers never delay the schedule. If that write fails and we
        // swallow it, the next 30 s tick still sees a cron automation as due
        // and fires it AGAIN — repeated duplicate paid-API/harness runs until
        // a write happens to succeed. Retry once (transient SQLITE_BUSY),
        // then log loudly so the failure is at least diagnosable.
        if let Err(e) = record_run(&conn, &automation.id, &status, Some(&prepared.chat_session_id), prepared.source.as_str()) {
            eprintln!(
                "[automations] record_run failed for {} ({}), retrying once: {e}",
                automation.id, automation.name
            );
            std::thread::sleep(Duration::from_millis(250));
            if let Err(e2) = record_run(&conn, &automation.id, &status, Some(&prepared.chat_session_id), prepared.source.as_str()) {
                eprintln!(
                    "[automations] record_run retry ALSO failed for {} — the scheduler may re-fire this automation: {e2}",
                    automation.id
                );
            }
        }
        if let Err(e) = finish_run(&conn, &prepared.run_id, &status, &summary) {
            eprintln!(
                "[automations] finish_run failed for run {} of {}: {e}",
                prepared.run_id, automation.id
            );
        }
    }
    release_guards(&automation.id, &prepared.lock_path);
    notify_run_finished(app, db, automation, prepared, &status, &summary);
}

// ---------------------------------------------------------------------------
// Run-finished notifications
// ---------------------------------------------------------------------------
//
// Four channels, all best-effort (a notification failure must NEVER affect
// run recording or the overlap-guard release above):
//   - in-app event  → the desktop frontend turns failures into OS toasts and
//     refreshes the Automations view (app must be open);
//   - mobile push   → relay broadcast to paired phones (app must be open);
//   - webhook POST  → every completed run, when `automations.webhookUrl` is
//     set — the only channel that works while Relay is fully closed;
//   - Gmail email   → failures only, send-to-self via the Gmail connector;
//     works headless too (tokens refresh through the DB, no AppHandle).

/// Which outcomes get an email: failures only. Success mail from a */15 cron
/// is spam; "skipped" never reaches finalize (prepare returns early), and a
/// user stop is expected — mailing it would be noise the user caused.
fn should_email(status: &str) -> bool {
    status != "ok" && status != "skipped" && status != STOPPED_STATUS
}

/// The JSON body POSTed to the configured webhook for every completed run.
fn webhook_payload(automation: &Automation, status: &str, summary: &str, finished_at: i64) -> serde_json::Value {
    serde_json::json!({
        "event": "automation.run_finished",
        "automationId": automation.id,
        "name": automation.name,
        "status": status,
        "summary": summary,
        "finishedAt": finished_at,
    })
}

/// Run an async notification future regardless of runtime context: in-app we
/// spawn on Tauri's global runtime; the headless binary has no reactor, so a
/// throwaway current-thread runtime drives it on a side thread. Either way
/// `finalize` returns immediately.
fn spawn_notify(app_present: bool, fut: impl std::future::Future<Output = ()> + Send + 'static) {
    if app_present {
        tauri::async_runtime::spawn(fut);
    } else {
        std::thread::spawn(move || {
            match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt.block_on(fut),
                Err(e) => eprintln!("[automations] notify runtime build failed: {e}"),
            }
        });
    }
}

fn notify_run_finished(
    app: Option<&AppHandle>,
    db: &Arc<Mutex<Connection>>,
    automation: &Automation,
    prepared: &PreparedRun,
    status: &str,
    summary: &str,
) {
    let finished_at = db::now_ts();

    // 1 + 2. In-app channels: the frontend toast/refresh event and the mobile
    // relay broadcast. Both no-op headless.
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit("automation:run-finished", serde_json::json!({
            "automationId": automation.id,
            "name": automation.name,
            "status": status,
            "summary": summary,
            "chatSessionId": prepared.chat_session_id,
            "finishedAt": finished_at,
        }));
        crate::mobile::relay::broadcast_automation_run_finished(
            app, &automation.id, &automation.name, status, summary,
        );
    }

    // 3. Webhook — every completed run, when configured.
    let webhook_url = {
        let conn = db.lock();
        db::get_setting(&conn, "automations.webhookUrl").ok().flatten()
    };
    if let Some(url) = webhook_url.filter(|u| !u.trim().is_empty()) {
        let payload = webhook_payload(automation, status, summary, finished_at);
        spawn_notify(app.is_some(), async move {
            if let Err(e) = post_json(&url, &payload).await {
                eprintln!("[automations] webhook POST failed: {e}");
            }
        });
    }

    // 4. Email on failure via the Gmail connector (opt-out via
    // `automations.emailOnFailure` = "false"; silently skipped when Gmail
    // isn't connected).
    if should_email(status) {
        let email_on = {
            let conn = db.lock();
            db::get_setting(&conn, "automations.emailOnFailure").ok().flatten()
        };
        if email_on.as_deref() != Some("false") {
            let db2 = Arc::clone(db);
            let name = automation.name.clone();
            let status = status.to_string();
            let summary = summary.to_string();
            spawn_notify(app.is_some(), async move {
                if let Err(e) = send_failure_email(&db2, &name, &status, &summary, finished_at).await {
                    // "not connected" is the normal case for users without the
                    // Gmail connector — don't spam stderr for it.
                    if e != "connector not connected" {
                        eprintln!("[automations] failure email failed: {e}");
                    }
                }
            });
        }
    }
}

/// POST a JSON body with a short timeout. Shared by the webhook and test-hook.
pub(crate) async fn post_json(url: &str, payload: &serde_json::Value) -> Result<(), String> {
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("relay-desktop")
        .build()
        .map_err(|e| e.to_string())?
        .post(url)
        .json(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("webhook HTTP {}", resp.status()));
    }
    Ok(())
}

/// Send-to-self failure email through the Gmail connector. Works headless:
/// the token refresh path only needs the DB (see
/// `connectors::oauth::ensure_valid_access_token_with_db`).
async fn send_failure_email(
    db: &Arc<Mutex<Connection>>,
    automation_name: &str,
    status: &str,
    summary: &str,
    finished_at: i64,
) -> Result<(), String> {
    let token = crate::connectors::oauth::ensure_valid_access_token_with_db(db, "gmail").await?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("relay-desktop")
        .build()
        .map_err(|e| e.to_string())?;

    // Recipient: the account's own address, cached after the first lookup.
    let cached = {
        let conn = db.lock();
        db::get_setting(&conn, "automations.gmailAddress")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    };
    let to = match cached {
        Some(t) => t,
        None => {
            let resp = http
                .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| format!("gmail profile: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("gmail profile HTTP {}", resp.status()));
            }
            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let addr = body
                .get("emailAddress")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "gmail profile missing emailAddress".to_string())?
                .to_string();
            let conn = db.lock();
            let _ = db::set_setting(&conn, "automations.gmailAddress", &addr);
            addr
        }
    };

    let raw = build_failure_email(&to, automation_name, status, summary, finished_at);
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes());
    let resp = http
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(&token)
        .json(&serde_json::json!({ "raw": encoded }))
        .send()
        .await
        .map_err(|e| format!("gmail send: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gmail send HTTP {}", resp.status()));
    }
    Ok(())
}

/// The RFC-822 message for a failure email. Subject is RFC 2047 base64-
/// encoded so non-ASCII automation names survive strict relays.
fn build_failure_email(to: &str, automation_name: &str, status: &str, summary: &str, finished_at: i64) -> String {
    use base64::Engine as _;
    let subject_raw = format!("Relay automation failed: {automation_name}");
    let subject = format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(subject_raw.as_bytes()));
    let when = chrono::DateTime::from_timestamp(finished_at, 0)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S %Z").to_string())
        .unwrap_or_else(|| finished_at.to_string());
    let body = format!(
        "Automation: {automation_name}\nFinished: {when}\n\nError:\n{status}\n\nSummary:\n{summary}\n\n\
         Open Relay → Automations → \"{automation_name}\" for the full transcript.\n"
    );
    format!(
        "To: {to}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{body}"
    )
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
    if status == STOPPED_STATUS {
        return "Stopped".into();
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
    fn unattended_rules_are_appended_once() {
        let wrapped = ensure_unattended_rules("Do the thing.");
        assert!(wrapped.starts_with("Do the thing."));
        assert!(wrapped.contains(UNATTENDED_RULES_MARKER));
        // Idempotent: an already-wrapped prompt is not wrapped again.
        assert_eq!(ensure_unattended_rules(&wrapped), wrapped);
    }

    #[cfg(windows)]
    #[test]
    fn pid_alive_rejects_dead_pid() {
        // A PID of 4 billion is vanishingly unlikely to exist; the API must
        // report it dead (B-28 stale-lock path).
        assert!(!pid_alive(4_000_000_000));
        // The current process is obviously alive.
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn stopped_status_is_a_neutral_outcome() {
        assert_eq!(summarize(STOPPED_STATUS), "Stopped");
        // No failure email for a stop the user pressed themselves.
        assert!(!should_email(STOPPED_STATUS));
    }

    #[test]
    fn stop_run_without_a_live_run_is_false() {
        // Nothing registered this id in this process — the stop must report
        // that instead of pretending a signal was delivered.
        assert!(!stop_run("no-such-automation-stop-test"));
    }

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

        // Strictly-after semantics: querying again from the previous answer
        // always advances to the following slot (powers the UI "Next run").
        let next2 = next_fire("*/15 * * * *", next).unwrap();
        assert!(next2 > next);
        // Daily-at-time picks the next occurrence, even a day out.
        let daily = next_fire("45 9 * * *", after).unwrap();
        assert!(daily > after && daily <= after + 24 * 3600 + 60);
    }

    #[test]
    fn seconds_first_expressions_still_parse() {
        // Power users may paste the cron crate's native 6/7-field form.
        validate_schedule("0 2 9 * * 1-5").unwrap();
    }

    #[test]
    fn next_fire_degrades_to_human_strings_for_event_triggers() {
        let now = db::now_ts();
        // Event rows: no timestamp, a human string — never a cron parse error.
        let (at, label) = describe_next_fire("webhook", "", now);
        assert_eq!(at, None);
        assert_eq!(label, "on webhook call");
        let (at, label) = describe_next_fire("file", "", now);
        assert_eq!(at, None);
        assert_eq!(label, "on file change");
        let (at, label) = describe_next_fire("git", "", now);
        assert_eq!(at, None);
        assert_eq!(label, "on git change");
        let (at, label) = describe_next_fire("gmail", "", now);
        assert_eq!(at, None);
        assert_eq!(label, "on new email");
        // The empty cron string must NOT read as "unparsable" anywhere —
        // the labels above replace the old "schedule error — will not fire".
        assert!(next_fire("", now).is_none());

        // Cron rows (the default, and anything unknown): timestamp, no label.
        let (at, label) = describe_next_fire("cron", "*/15 * * * *", now);
        assert!(at.is_some_and(|t| t > now));
        assert_eq!(label, "");
        let (at2, label) = describe_next_fire("weird-legacy-value", "*/15 * * * *", now);
        assert_eq!(at2.is_some(), true);
        assert_eq!(label, "");
        // Invalid cron still yields None (the IPC layer surfaces the error).
        assert_eq!(describe_next_fire("cron", "not a schedule", now).0, None);
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

    #[test]
    fn email_policy_is_failures_only() {
        assert!(!should_email("ok"));
        assert!(!should_email("skipped"));
        assert!(should_email("provider exploded"));
        assert!(should_email("panic: boom"));
    }

    #[test]
    fn webhook_payload_shape() {
        let a = Automation {
            id: "a1".into(),
            name: "nightly".into(),
            prompt: "p".into(),
            harness: "claude_code".into(),
            model: String::new(),
            cwd: String::new(),
            schedule: "0 9 * * *".into(),
            enabled: true,
            last_run_at: None,
            last_status: None,
            chat_session_id: None,
            created_at: 0,
            origin: "user".to_string(),
            trigger_type: "cron".to_string(),
            trigger_config: "{}".to_string(),
            last_trigger_state: None,
            last_event_run_at: None,
        };
        let p = webhook_payload(&a, "ok", "Completed", 1234);
        assert_eq!(p["event"], "automation.run_finished");
        assert_eq!(p["automationId"], "a1");
        assert_eq!(p["name"], "nightly");
        assert_eq!(p["status"], "ok");
        assert_eq!(p["summary"], "Completed");
        assert_eq!(p["finishedAt"], 1234);
    }

    #[test]
    fn failure_email_is_rfc822_and_encodes_subject() {
        let msg = build_failure_email(
            "me@example.com",
            "nightly 🌙",
            "provider exploded",
            "provider exploded",
            1_700_000_000,
        );
        assert!(msg.starts_with("To: me@example.com\r\n"));
        // Subject is RFC 2047 base64 — decodes back to the raw UTF-8 subject.
        let subject_line = msg.lines().nth(1).unwrap();
        assert!(subject_line.starts_with("Subject: =?UTF-8?B?"));
        use base64::Engine as _;
        let b64 = subject_line
            .trim_start_matches("Subject: =?UTF-8?B?")
            .trim_end_matches("?=");
        let decoded = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "Relay automation failed: nightly 🌙");
        // CRLF header/body separator + plain-text content type + error text.
        assert!(msg.contains("\r\n\r\n"));
        assert!(msg.contains("Content-Type: text/plain; charset=\"UTF-8\""));
        assert!(msg.contains("provider exploded"));
        assert!(msg.contains("Automation: nightly 🌙"));
    }

    #[test]
    fn prepare_recreates_a_deleted_run_log_session() {
        // Regression: when automations.chat_session_id pointed at a chat row
        // that had been deleted, the run died on INSERT into chat_messages
        // with "FOREIGN KEY constraint failed". Prepare must detect the
        // dangling id, create a fresh session, and rebind it.
        let conn = crate::db::mem();
        let db = Arc::new(Mutex::new(conn));

        let automation = {
            let conn = db.lock();
            let a = crate::db::create_automation(
                &conn,
                &crate::db::AutomationInput {
                    name: "nightly".into(),
                    prompt: "p".into(),
                    harness: "claude_code".into(),
                    model: None,
                    cwd: None,
                    schedule: "* * * * *".into(),
                    enabled: Some(true),
                    origin: None,
                    trigger_type: None,
                    trigger_config: None,
                },
            )
            .unwrap();
            // Simulate the run-log session having been deleted elsewhere.
            crate::db::set_automation_chat_session(&conn, &a.id, Some("ghost-session")).unwrap();
            crate::db::get_automation(&conn, &a.id).unwrap().unwrap()
        };

        let prepared =
            prepare_run_inner(&db, &automation, RunSource::Manual, 0)
            .expect("run prepared")
            .expect("prepared run");
        assert_ne!(prepared.chat_session_id, "ghost-session", "dangling id must be replaced");
        {
            let conn = db.lock();
            assert!(
                crate::db::get_chat_session(&conn, &prepared.chat_session_id)
                    .unwrap()
                    .is_some(),
                "replacement session must exist"
            );
            let reloaded = crate::db::get_automation(&conn, &automation.id).unwrap().unwrap();
            assert_eq!(
                reloaded.chat_session_id.as_deref(),
                Some(prepared.chat_session_id.as_str()),
                "row must be rebound immediately, not at finalize"
            );
        }
        release_guards(&automation.id, &None);
    }

    #[test]
    fn agent_automation_run_log_uses_engine_vocabulary() {
        // Regression: for an `agent:<id>` harness, prepare used to write the
        // agent column as `harness:agent:<id>` and the provider column as
        // `agent:<id>` — strings no chat_sessions consumer resolves (approval
        // lookups, provider labeling, manual follow-ups all dead-end). The
        // row must carry the definition's ENGINE vocabulary + agent_def_id,
        // exactly like a session_fabric subagent child.
        let conn = crate::db::mem();
        let def = crate::chat::subagents::create(
            &conn,
            &crate::chat::subagents::SubagentInput {
                name: "nightly-writer".into(),
                description: "d".into(),
                prompt_md: "p".into(),
                tools: None,
                engine: Some("builtin".into()),
                model: Some("openrouter::x/test-model".into()),
                effort: None,
                sandbox_policy: "read_only".into(),
                approval_policy: "on_request".into(),
                worktree_policy: "inherit".into(),
                max_rounds: 10,
                max_concurrent: 2,
            },
        )
        .expect("subagent created");
        let db = Arc::new(Mutex::new(conn));
        let automation = {
            let conn = db.lock();
            let a = crate::db::create_automation(
                &conn,
                &crate::db::AutomationInput {
                    name: "nightly".into(),
                    prompt: "p".into(),
                    harness: format!("agent:{}", def.id),
                    model: None,
                    cwd: None,
                    schedule: "* * * * *".into(),
                    enabled: Some(true),
                    origin: None,
                    trigger_type: None,
                    trigger_config: None,
                },
            )
            .unwrap();
            crate::db::get_automation(&conn, &a.id).unwrap().unwrap()
        };

        let prepared =
            prepare_run_inner(&db, &automation, RunSource::Manual, 0)
            .expect("run prepared")
            .expect("prepared run");
        {
            let conn = db.lock();
            let cs = crate::db::get_chat_session(&conn, &prepared.chat_session_id)
                .unwrap()
                .expect("run-log session exists");
            assert_eq!(
                cs.agent.as_deref(),
                Some("builtin"),
                "the agent column carries the ENGINE, not the agent: reference"
            );
            assert_eq!(cs.provider, "openrouter", "a real provider, not agent:<id>");
            assert_eq!(cs.model, "x/test-model");
            assert_eq!(
                cs.agent_def_id.as_deref(),
                Some(def.id.as_str()),
                "the run-log row links back to the definition"
            );
        }
        release_guards(&automation.id, &None);
    }

    #[test]
    fn due_automations_matches_tick_semantics() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let mk = |name: &str, schedule: &str, enabled: bool| {
            crate::db::create_automation(
                &conn,
                &crate::db::AutomationInput {
                    name: name.into(),
                    prompt: "p".into(),
                    harness: "claude_code".into(),
                    model: None,
                    cwd: None,
                    schedule: schedule.into(),
                    enabled: Some(enabled),
                    origin: None,
                    trigger_type: None,
                    trigger_config: None,
                },
            )
            .unwrap()
        };
        // Every-minute automation created "now" is due immediately (next
        // fire after creation lands in the past within the same minute).
        let due_one = mk("every-minute", "* * * * *", true);
        // Daily at 9am may or may not be due right now — but a DISABLED
        // every-minute automation must never be due.
        mk("disabled", "* * * * *", false);
        let due = due_automations(&conn, db::now_ts() + 120);
        let ids: Vec<&str> = due.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&due_one.id.as_str()), "enabled + past-due fires");
        assert_eq!(due.len(), 1, "disabled rows never fire");
    }

    #[test]
    fn event_rows_are_never_cron_due() {
        // A git-triggered row with an EMPTY schedule must not fail cron
        // parsing on every tick (or fire) — it has its own engine.
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let a = crate::db::create_automation(
            &conn,
            &crate::db::AutomationInput {
                name: "git-fired".into(),
                prompt: "p".into(),
                harness: "claude_code".into(),
                model: None,
                cwd: None,
                schedule: String::new(),
                enabled: Some(true),
                origin: None,
                trigger_type: Some("git".into()),
                trigger_config: Some("{\"cwd\":\"D:/repo\"}".into()),
            },
        )
        .unwrap();
        let due = due_automations(&conn, db::now_ts() + 999_999);
        assert!(!due.iter().any(|x| x.id == a.id), "event rows never fire via cron");
        // Same for a gmail row: its engine is the async poll in start's loop.
        let g = crate::db::create_automation(
            &conn,
            &crate::db::AutomationInput {
                name: "gmail-fired".into(),
                prompt: "p".into(),
                harness: "claude_code".into(),
                model: None,
                cwd: None,
                schedule: String::new(),
                enabled: Some(true),
                origin: None,
                trigger_type: Some("gmail".into()),
                trigger_config: Some("{}".into()),
            },
        )
        .unwrap();
        assert!(!due_automations(&conn, db::now_ts() + 999_999).iter().any(|x| x.id == g.id));
        // A leftover cron schedule on an event row must not fire cron-side
        // either — the trigger_type owns the firing decision.
        crate::db::update_automation(
            &conn,
            &a.id,
            &crate::db::AutomationInput {
                name: "git-fired".into(),
                prompt: "p".into(),
                harness: "claude_code".into(),
                model: None,
                cwd: None,
                schedule: "* * * * *".into(),
                enabled: Some(true),
                origin: None,
                trigger_type: None,
                trigger_config: None,
            },
        )
        .unwrap();
        assert!(due_automations(&conn, db::now_ts() + 999_999).is_empty());
    }

    #[test]
    fn email_source_is_event_classed() {
        // The wire string db::record_run switches on — "email" must stay
        // event-classed (anything but "scheduled" advances
        // last_event_run_at, never the cron clock).
        assert_eq!(RunSource::Email.as_str(), "email");
        assert!(!RunSource::Email.is_scheduled());
    }

    #[test]
    fn record_run_splits_cron_clock_from_event_clock() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let mk = |name: &str| {
            crate::db::create_automation(
                &conn,
                &crate::db::AutomationInput {
                    name: name.into(),
                    prompt: "p".into(),
                    harness: "claude_code".into(),
                    model: None,
                    cwd: None,
                    schedule: "* * * * *".into(),
                    enabled: Some(true),
                    origin: None,
                    trigger_type: None,
                    trigger_config: None,
                },
            )
            .unwrap()
        };
        let cron_row = mk("cron-row");
        let event_row = mk("event-row");

        // A scheduled run advances last_run_at ONLY.
        crate::db::record_run(&conn, &cron_row.id, "ok", None, "scheduled").unwrap();
        let after_cron = crate::db::get_automation(&conn, &cron_row.id).unwrap().unwrap();
        assert!(after_cron.last_run_at.is_some(), "cron run advances the cron clock");
        assert_eq!(after_cron.last_event_run_at, None);

        // An event run (webhook/fs/git/email — the exact strings RunSource
        // writes) advances last_event_run_at INSTEAD: next_fire computes from
        // last_run_at, so an event run must never delay the schedule.
        for source in ["webhook", "fs", "git", "email", "manual"] {
            crate::db::record_run(&conn, &event_row.id, "ok", None, source).unwrap();
        }
        let after_event = crate::db::get_automation(&conn, &event_row.id).unwrap().unwrap();
        assert_eq!(
            after_event.last_run_at, None,
            "event runs never advance last_run_at"
        );
        assert!(after_event.last_event_run_at.is_some(), "event runs advance last_event_run_at");
        // The cron automation's clock is untouched by the event row's runs.
        let after_cron2 = crate::db::get_automation(&conn, &cron_row.id).unwrap().unwrap();
        assert_eq!(after_cron2.last_event_run_at, None);
    }
}
