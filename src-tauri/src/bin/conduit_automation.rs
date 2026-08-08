//! conduit-automation — headless automation runner.
//!
//!   conduit-automation run <automation-id>   execute one turn now (blocking)
//!   conduit-automation list                  print automation ids + schedules
//!
//! This is the entry point an OS scheduler (Windows Task Scheduler, cron) can
//! invoke so automations fire while the Conduit GUI is closed. It links
//! conduit_lib and reuses the exact launch path the in-app scheduler uses
//! (automations::run_blocking): same overlap lock file, same run-log chat
//! session, same DB. No Tauri runtime is created — AppHandle is None, so
//! chat:* events become no-ops and everything lands in the DB directly.
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
        Some("list") => list(),
        _ => {
            eprintln!("usage: conduit-automation run <automation-id> | list");
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
