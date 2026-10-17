//! Bot runs — the headless execution path for bots (docs/architecture/BOTS.md).
//!
//! A "run" is ONE headless turn of a bot, always in a fresh session
//! (`bot_role = 'run'`, hidden from Chat History) so that:
//!   * the bot's persona and memory scope apply with no extra plumbing (both
//!     key off `bot_id`), and the user's own conversation is untouched;
//!   * the permission gate can recognise the run durably — `bot_role = 'run'`
//!     is the key `chat::bot_policy::queue_if_background_write` reads, so a
//!     write-class tool call is QUEUED for the owner instead of executed;
//!   * the activity strip and the pruner have a row to read
//!     (`db::bots::start_bot_run` / `finish_bot_run`).
//!
//! Three entry points:
//!   * a standing job (`automations.rs` → `begin_run` + `execute_run`),
//!   * "Run now" / `run_bot` (`start_run_async` — fire and forget),
//!   * `ask_bot` (`ask_bot` — blocking, returns the answer text).
//!
//! Threading: every path ultimately runs `execute_run` on a plain OS thread
//! with its own tokio runtime, exactly like `automations::launch_run`, because
//! the chat one-shot is blocking.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

/// Bots with a run in flight right now — what the rail's dot pulses on.
///
/// A COUNT per bot, not a set: the on-demand paths (`run_bot_now`/`run_bot`,
/// `ask_bot`) reserve exclusively, but two different scheduled jobs of the
/// same bot may legitimately overlap. With a plain set, the first job to
/// finish would clear the flag while the second is still running; the count
/// keeps the bot "busy" until the LAST run ends.
fn running() -> &'static Mutex<HashMap<String, usize>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_running(bot_id: &str) -> bool {
    running()
        .lock()
        .map(|m| m.get(bot_id).copied().unwrap_or(0) > 0)
        .unwrap_or(false)
}

pub fn running_bots() -> Vec<String> {
    running().lock().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

/// Cancel flags for in-flight on-demand runs, keyed by run id — the "Stop"
/// button on a running run in the Bots rail. (Scheduled jobs stop through the
/// automations path instead.)
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Request a stop for one run. Returns true when a live run was found.
pub fn stop_run(run_id: &str) -> bool {
    let flag = cancels().lock().ok().and_then(|m| m.get(run_id).cloned());
    match flag {
        Some(f) => {
            f.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

fn increment(bot_id: &str) {
    if let Ok(mut m) = running().lock() {
        *m.entry(bot_id.to_string()).or_insert(0) += 1;
    }
}

fn decrement(bot_id: &str) {
    if let Ok(mut m) = running().lock() {
        if let Some(n) = m.get_mut(bot_id) {
            if *n <= 1 {
                m.remove(bot_id);
            } else {
                *n -= 1;
            }
        }
    }
}

/// A claim on a bot's "busy" flag; released (decremented) on drop — including
/// on a panic, so a provider-plumbing panic can never leave the rail pulsing
/// and every later run refused.
pub struct RunGuard {
    bot_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        decrement(&self.bot_id);
    }
}

/// Mark a bot busy unconditionally — a scheduled job, or the executor itself.
pub fn mark_running(bot_id: &str) -> RunGuard {
    increment(bot_id);
    RunGuard { bot_id: bot_id.to_string() }
}

/// Reserve a bot for a single on-demand run. Returns `None` when the bot
/// already has a run (or reservation) in flight. This is the atomic
/// check-and-set that makes "one run at a time per bot" actually true: the
/// old code checked `is_running` on the command thread but only marked the bot
/// busy later, on the spawned worker, so a double-click started two runs.
pub fn reserve_run(bot_id: &str) -> Option<RunGuard> {
    let mut m = running().lock().ok()?;
    if m.get(bot_id).copied().unwrap_or(0) > 0 {
        return None;
    }
    m.insert(bot_id.to_string(), 1);
    Some(RunGuard { bot_id: bot_id.to_string() })
}

/// Settles a `bot_runs` row as `interrupted` if `execute_run` unwinds before
/// its normal finalize. Disarmed (`None`) on the normal path.
struct RunRowGuard(Option<(AppHandle, String, String)>);

impl Drop for RunRowGuard {
    fn drop(&mut self) {
        let Some((app, run_id, bot_id)) = self.0.take() else {
            return;
        };
        let msg = "interrupted — the run ended unexpectedly";
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let _ = crate::db::bots::finish_bot_run(&conn, &run_id, "error", msg);
        let _ = crate::db::bots::post_run_summary(&conn, &bot_id, "Run", "error", msg);
        drop(conn);
        let _ = app.emit(
            "bots:changed",
            serde_json::json!({ "action": "run", "botId": bot_id }),
        );
    }
}

/// What a finished run produced.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// ok | error | stopped
    pub status: String,
    /// The run's final assistant text (may be empty on a hard error).
    pub text: String,
    /// Human-readable error, when there was one.
    pub error: Option<String>,
}

/// Open a run: the activity row plus the fresh run session. Refuses a bot that
/// is disabled (Revision 2 semantics: `enabled = false` stops standing jobs and
/// refuses `run_bot`/`ask_bot`, while the bot's THREAD stays usable so an
/// agent-created bot can be reviewed before approval).
pub fn begin_run(
    app: &AppHandle,
    bot_id: &str,
    job_id: Option<&str>,
    job_name: &str,
    source: &str,
) -> Result<(String, String), String> {
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let bot = crate::db::bots::get_bot(&conn, bot_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("bot not found: {bot_id}"))?;
    if !bot.enabled {
        return Err(format!(
            "\"{}\" is waiting for your approval — approve it in the Bots view first.",
            bot.name
        ));
    }
    let name = if job_name.trim().is_empty() {
        format!("Run · {}", bot.name)
    } else {
        job_name.trim().to_string()
    };
    crate::db::bots::start_bot_run(&conn, bot_id, job_id, &name, source).map_err(|e| e.to_string())
}

/// Execute a run and write down everything that happened. Blocking; call it
/// from a thread you own (or via `start_run_async`).
/// Marks the bot busy for the duration; the returned guard clears it however
/// the run ends — including a panic in the provider plumbing.
pub fn execute_run(
    app: &AppHandle,
    run_id: &str,
    session_id: &str,
    bot_id: &str,
    prompt: &str,
    cancel: Option<&AtomicBool>,
) -> RunOutcome {
    let _running = mark_running(bot_id);
    // Settle the activity row if this function UNWINDS before its normal
    // finalize (a panic in the provider plumbing). `mark_running`'s guard only
    // clears the in-memory flag; without this the `bot_runs` row stayed
    // `running` until the next boot sweep, showing a phantom run in the strip.
    let mut settle = RunRowGuard(Some((app.clone(), run_id.to_string(), bot_id.to_string())));
    let db = app.state::<crate::DbState>();
    // The bot's pinned engine wins over the session row (a standing job must
    // keep running where the bot says, even if the user re-pointed their chat).
    let (provider, model) = {
        let conn = db.0.lock();
        match crate::db::bots::model_for_session(&conn, session_id) {
            Ok(Some(pair)) => pair,
            _ => crate::db::get_chat_session(&conn, session_id)
                .ok()
                .flatten()
                .map(|s| (s.provider, s.model))
                .unwrap_or_default(),
        }
    };

    let result = crate::chat::run_bot_one_shot(app, session_id, prompt, &provider, &model, cancel);
    let (status, error) = match &result {
        Ok(()) => ("ok".to_string(), None),
        Err(e) if e == crate::automations::STOPPED_ERROR => ("stopped".to_string(), None),
        Err(e) => ("error".to_string(), Some(e.clone())),
    };

    // The run's own transcript is the source of truth for the summary line.
    let text = {
        let conn = db.0.lock();
        last_assistant_text(&conn, session_id)
    };
    let summary = if let Some(err) = &error {
        format!("{err}\n\n{}", text.trim())
    } else {
        text.trim().to_string()
    };

    {
        let conn = db.0.lock();
        let _ = crate::db::bots::finish_bot_run(&conn, run_id, &status, &summary);
        // The row is settled normally; disarm the panic guard.
        settle.0 = None;
        // One compact message into the bot's THREAD: the conversation stays a
        // conversation, the transcript stays in the run session.
        let job_name: String = conn
            .query_row(
                "SELECT job_name FROM bot_runs WHERE id = ?1",
                rusqlite::params![run_id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "Run".to_string());
        let _ = crate::db::bots::post_run_summary(&conn, bot_id, &job_name, &status, &summary);
        let _ = crate::db::bots::prune_runs(&conn, bot_id, crate::db::bots::BOT_RUN_KEEP);
    }
    let _ = app.emit(
        "bots:changed",
        serde_json::json!({ "action": "run", "botId": bot_id, "runId": run_id, "status": status }),
    );
    notify_run_finished(app, bot_id, session_id, &status, &summary);
    RunOutcome { status, text, error }
}

/// Fire-and-forget: used by the "Run now" button and the `run_bot` chat tool.
/// Returns the ids immediately so the UI can open the run while it works.
pub fn start_run_async(
    app: &AppHandle,
    bot_id: &str,
    prompt: Option<&str>,
    source: &str,
    job_name: &str,
) -> Result<(String, String, String), String> {
    let bot_id = bot_id.to_string();
    // One run at a time per bot for the on-demand paths (the "Run now" button
    // and the run_bot tool): a second click while a run is working would
    // otherwise queue a second turn onto the same bot with no way to tell them
    // apart in the activity strip. Scheduled jobs are serialized per JOB by the
    // automations scheduler's own overlap guard instead (and hold a
    // non-exclusive mark so the rail still pulses).
    //
    // RESERVE ATOMICALLY, before anything else: the old check-then-spawn raced
    // (the bot was only marked busy later, on the worker thread), so a
    // double-click started two runs.
    let reserve = reserve_run(&bot_id)
        .ok_or_else(|| "That bot is already working on a run — wait for it to finish.".to_string())?;
    let (run_id, session_id) = match begin_run(app, &bot_id, None, job_name, source) {
        Ok(v) => v,
        Err(e) => {
            drop(reserve); // release the reservation on a refused/!found bot
            return Err(e);
        }
    };
    let prompt = prompt.map(|p| p.to_string()).unwrap_or_else(|| {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::bots::get_bot(&conn, &bot_id)
            .ok()
            .flatten()
            .map(|b| {
                if b.description.trim().is_empty() {
                    "Run your job now and report back with a short summary.".to_string()
                } else {
                    format!("{}\n\nReport back with a short summary.", b.description.trim())
                }
            })
            .unwrap_or_else(|| "Run your job now.".to_string())
    });
    let app2 = app.clone();
    let run2 = run_id.clone();
    let sid2 = session_id.clone();
    let prompt2 = prompt.clone();
    // Register a cancel flag so the run can be stopped from the Bots rail.
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = cancels().lock() {
        m.insert(run_id.clone(), Arc::clone(&cancel));
    }
    std::thread::spawn(move || {
        // Hold the reservation for the whole run so the next "Run now" is
        // refused until this one finishes (and the flag outlives a panic).
        let _reserve = reserve;
        execute_run(&app2, &run2, &sid2, &bot_id, &prompt2, Some(cancel.as_ref()));
        if let Ok(mut m) = cancels().lock() {
            m.remove(&run2);
        }
    });
    Ok((run_id, session_id, prompt))
}

/// `ask_bot` — hand a question to a bot and return its answer. Blocking, so
/// callers on an async runtime must `spawn_blocking`: the answer comes from a
/// whole headless turn (the bot may read files, search, recall memory), which
/// is exactly what makes the delegation useful.
pub fn ask_bot(app: &AppHandle, bot_id: &str, question: &str) -> Result<String, String> {
    // Same atomic reservation as `start_run_async` (this path is synchronous,
    // but a concurrent "Run now" must not overlap it).
    let reserve = reserve_run(bot_id)
        .ok_or_else(|| "That bot is already working on a run — try again when it finishes.".to_string())?;
    let (run_id, session_id) = begin_run(app, bot_id, None, "Delegated question", "ask")?;
    let outcome = execute_run(app, &run_id, &session_id, bot_id, question, None);
    drop(reserve);
    match outcome.error {
        Some(e) => Err(e),
        None => Ok(outcome.text),
    }
}

/// The last assistant message of a session — the run summary should be what the
/// model actually said, not a re-phrased version of it.
pub(crate) fn last_assistant_text(conn: &rusqlite::Connection, session_id: &str) -> String {
    conn.query_row(
        "SELECT content FROM chat_messages WHERE chat_session_id = ?1 AND role = 'assistant'
         ORDER BY id DESC LIMIT 1",
        rusqlite::params![session_id],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_default()
}

/// Desktop notification + phone push, using the same two channels the
/// automations path uses. Never fatal.
///
/// The desktop side is an EVENT, `bot:run-finished` — the frontend funnels it
/// through `relayNotify` (the bell panel always records it; failures also get
/// an OS toast + chime), exactly like `automation:run-finished`. Without it a
/// finished manual/`ask_bot` run was silent on the desktop: it pushed to the
/// phone only when no phone was connected, and emitted nothing else.
pub fn notify_run_finished(
    app: &AppHandle,
    bot_id: &str,
    session_id: &str,
    status: &str,
    summary: &str,
) {
    let name = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::bots::get_bot(&conn, bot_id)
            .ok()
            .flatten()
            .map(|b| b.name)
            .unwrap_or_else(|| "A bot".to_string())
    };
    let line: String = summary.split('\n').next().unwrap_or("").chars().take(140).collect();
    let title = if status == "error" {
        format!("{name} hit an error")
    } else if status == "stopped" {
        format!("{name} stopped")
    } else {
        format!("{name} finished a run")
    };
    let _ = app.emit(
        "bot:run-finished",
        serde_json::json!({
            "botId": bot_id,
            "botName": name,
            "status": status,
            "summary": summary.chars().take(400).collect::<String>(),
            "sessionId": session_id,
        }),
    );
    crate::mobile::push::push_if_phones_disconnected(app, title, line);
}

/// The "Atlas wants your approval: …" notification (desktop toast + phone push),
/// emitted the moment a background write is queued.
pub fn notify_approval_queued(app: &AppHandle, bot_id: &str, summary: &str) {
    let name = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::bots::get_bot(&conn, bot_id)
            .ok()
            .flatten()
            .map(|b| b.name)
            .unwrap_or_else(|| "A bot".to_string())
    };
    let _ = app.emit(
        "bots:changed",
        serde_json::json!({ "action": "approval", "botId": bot_id }),
    );
    crate::mobile::push::push_if_phones_disconnected(
        app,
        format!("{name} wants your approval"),
        summary.to_string(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_run_is_exclusive_and_count_based() {
        let id = "test-reserve-bot-7f3a";
        let a = reserve_run(id).expect("first reserve wins");
        assert!(is_running(id));
        // A second on-demand run (double-click / Run-now racing the tool) is
        // refused while the reservation is held.
        assert!(reserve_run(id).is_none());
        // Scheduled jobs mark non-exclusively and may overlap.
        let j1 = mark_running(id);
        let j2 = mark_running(id);
        drop(j1);
        assert!(is_running(id), "one job finishing must not clear the flag while another runs");
        drop(j2);
        assert!(is_running(id), "the reservation still holds the bot");
        drop(a);
        assert!(!is_running(id), "released once every claim is gone");
        // After release, a new reservation is allowed again.
        assert!(reserve_run(id).is_some());
    }

    #[test]
    fn summary_line_is_the_first_line_clipped() {
        // Mirrors the clip in notify_run_finished without needing an AppHandle.
        let summary = format!("{}\n\nrest of it", "x".repeat(400));
        let line: String = summary.split('\n').next().unwrap_or("").chars().take(140).collect();
        assert_eq!(line.chars().count(), 140);
    }
}
