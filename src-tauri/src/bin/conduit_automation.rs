//! conduit-automation — headless automation runner.
//!
//!   conduit-automation run <automation-id>   execute one turn now (blocking)
//!   conduit-automation run-due               run every automation that's due
//!   conduit-automation list                  print automation ids + schedules
//!
//! This is the entry point an OS scheduler (Windows Task Scheduler, cron) can
//! invoke so automations fire while the Conduit GUI is closed. It links
//! conduit_lib and reuses the exact launch path the in-app scheduler uses
//! (automations::run_blocking): same overlap lock file, same run-log chat
//! session, same DB. No Tauri runtime is created — AppHandle is None, so
//! chat:* events become no-ops and everything lands in the DB directly.
//!
//! `run-due` is what the one-click "Run while closed" toggle registers with
//! Task Scheduler (see automation_task.rs): the task fires every minute and
//! this subcommand applies the app's own due-math (due_automations), so cron
//! semantics stay identical between app-open and app-closed runs.
//!
//! The DB lives at the same app-data location the GUI uses
//! (<data_dir>/dev.conduit.app/conduit.db).

use std::process::ExitCode;
use std::sync::Arc;

use parking_lot::Mutex;

use conduit_lib::{automations, db};

fn db_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("dev.conduit.app")
        .join("conduit.db")
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("run") => {
            let Some(id) = args.next() else {
                eprintln!("usage: conduit-automation run <automation-id>");
                return ExitCode::from(2);
            };
            run(&id)
        }
        Some("run-due") => run_due(),
        Some("list") => list(),
        _ => {
            eprintln!("usage: conduit-automation run <automation-id> | run-due | list");
            ExitCode::from(2)
        }
    }
}

fn open_db() -> Result<Arc<Mutex<rusqlite::Connection>>, String> {
    let path = db_path();
    let conn = db::open(&path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    Ok(Arc::new(Mutex::new(conn)))
}

fn run(id: &str) -> ExitCode {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let automation = {
        let conn = db.lock();
        db::get_automation(&conn, id)
    };
    let automation = match automation {
        Ok(Some(a)) => a,
        Ok(None) => {
            eprintln!("automation '{id}' not found");
            return ExitCode::from(2);
        }
        Err(e) => {
            eprintln!("failed to load automation: {e}");
            return ExitCode::FAILURE;
        }
    };
    match automations::run_blocking(None, &db, &automation) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("run failed: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Run every automation whose next fire time is due — the Task Scheduler
/// entry point. Due-ness (including missed-window catch-up) comes from the
/// same `due_automations` the in-app tick uses. Runs execute sequentially;
/// each is recorded as a "scheduled" run. One failing run doesn't stop the
/// rest.
fn run_due() -> ExitCode {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let due = {
        let conn = db.lock();
        automations::due_automations(&conn, db::now_ts())
    };
    let mut failed = false;
    for automation in due {
        if let Err(e) = automations::run_blocking_with_source(
            None,
            &db,
            &automation,
            automations::RunSource::Scheduled,
        ) {
            eprintln!("run-due: '{}' failed: {e}", automation.name);
            failed = true;
        }
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

fn list() -> ExitCode {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let conn = db.lock();
    match db::list_automations(&conn) {
        Ok(rows) => {
            for a in rows {
                println!(
                    "{}\t{}\t{}\t{}",
                    a.id,
                    if a.enabled { "on " } else { "off" },
                    a.schedule,
                    a.name
                );
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("failed to list automations: {e}");
            ExitCode::FAILURE
        }
    }
}
