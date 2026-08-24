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
    self, create_chat_session, finish_run, get_chat_session, list_automations, record_run,
    record_status, set_automation_chat_session, start_run, update_chat_session_agent,
    update_chat_session_title, Automation,
};

/// Automation ids with a run currently in flight (the overlap guard).
static RUNNING: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Hard time limit for one automation turn (2h). Generous enough for long
/// agent runs, tight enough that a hung CLI can't hold the overlap guards
/// past a couple of schedule slots — before this bound existed, one wedged
/// turn made the automation look "already running" to every later tick and
/// it silently stopped firing until the app restarted.
const MAX_RUN_SECS: u64 = 2 * 60 * 60;

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

/// Stamp `skipped` only on the TRANSITION: while the external
/// `conduit-automation` binary holds the lock file, the in-app scheduler
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
            automation.chat_session_id.clone().unwrap()
        } else {
            if automation.chat_session_id.is_some() {
                eprintln!(
                    "[automations] run-log chat session {:?} of {} is gone — recreating it",
                    automation.chat_session_id, automation.id
                );
            }
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
    // Route based on agent type:
    // - CLI harnesses (claude_code, opencode) → spawn CLI process
    // - API providers and local_gguf → chat HTTP API
    match automation.harness.as_str() {
        "claude_code" | "opencode" => {
            agent_sessions::run_one_shot(
                app,
                db,
                &prepared.chat_session_id,
                &automation.prompt,
                &automation.harness,
                &automation.model,
                if automation.cwd.is_empty() { None } else { Some(automation.cwd.as_str()) },
                Some(Duration::from_secs(MAX_RUN_SECS)),
            )
        }
        _ => {
            crate::chat::run_one_shot_chat(
                db,
                &prepared.chat_session_id,
                &automation.prompt,
                &automation.harness,
                &automation.model,
            )
        }
    }
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
        Err(e) => e.clone(),
    };
    let summary = summarize(&status);
    {
        let conn = db.lock();
        // record_run is what advances last_run_at. If that write fails and we
        // swallow it, the next 30 s tick still sees the automation as due and
        // fires it AGAIN — repeated duplicate paid-API/harness runs until a
        // write happens to succeed. Retry once (transient SQLITE_BUSY), then
        // log loudly so the failure is at least diagnosable.
        if let Err(e) = record_run(&conn, &automation.id, &status, Some(&prepared.chat_session_id)) {
            eprintln!(
                "[automations] record_run failed for {} ({}), retrying once: {e}",
                automation.id, automation.name
            );
            std::thread::sleep(Duration::from_millis(250));
            if let Err(e2) = record_run(&conn, &automation.id, &status, Some(&prepared.chat_session_id)) {
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
    if let Some(path) = &prepared.lock_path {
        let _ = std::fs::remove_file(path);
    }
    RUNNING.lock().remove(&automation.id);
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
//     set — the only channel that works while Conduit is fully closed;
//   - Gmail email   → failures only, send-to-self via the Gmail connector;
//     works headless too (tokens refresh through the DB, no AppHandle).

/// Which outcomes get an email: failures only. Success mail from a */15 cron
/// is spam; "skipped" never reaches finalize (prepare returns early).
fn should_email(status: &str) -> bool {
    status != "ok" && status != "skipped"
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
        .user_agent("conduit-desktop")
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
        .user_agent("conduit-desktop")
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
    let subject_raw = format!("Conduit automation failed: {automation_name}");
    let subject = format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(subject_raw.as_bytes()));
    let when = chrono::DateTime::from_timestamp(finished_at, 0)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S %Z").to_string())
        .unwrap_or_else(|| finished_at.to_string());
    let body = format!(
        "Automation: {automation_name}\nFinished: {when}\n\nError:\n{status}\n\nSummary:\n{summary}\n\n\
         Open Conduit → Automations → \"{automation_name}\" for the full transcript.\n"
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
        assert_eq!(String::from_utf8(decoded).unwrap(), "Conduit automation failed: nightly 🌙");
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
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
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
                },
            )
            .unwrap();
            // Simulate the run-log session having been deleted elsewhere.
            crate::db::set_automation_chat_session(&conn, &a.id, Some("ghost-session")).unwrap();
            crate::db::get_automation(&conn, &a.id).unwrap().unwrap()
        };

        let prepared =
            prepare_run_inner(&db, &automation, RunSource::Manual, 0).expect("run prepared");
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
}
