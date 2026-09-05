//! relay-automation — headless automation runner.
//!
//!   relay-automation run <automation-id>   execute one turn now (blocking)
//!   relay-automation run-due               run every automation that's due
//!   relay-automation list                  print automation ids + schedules
//!
//! This is the entry point an OS scheduler (Windows Task Scheduler, cron) can
//! invoke so automations fire while the Relay GUI is closed. It links
//! relay_lib and reuses the exact launch path the in-app scheduler uses
//! (automations::run_blocking): same overlap lock file, same run-log chat
//! session, same DB. No Tauri runtime is created — AppHandle is None, so
//! chat:* events become no-ops and everything lands in the DB directly.
//!
//! `run-due` is what the one-click "Run while closed" toggle registers with
//! Task Scheduler (see automation_task.rs): the task fires every minute and
//! this subcommand applies the app's own due-math (due_automations), so cron
//! semantics stay identical between app-open and app-closed runs.
//!
//! The DB is resolved exactly like the GUI resolves it: default
//! (<data_dir>/dev.relay.app/relay.db, migrating the pre-rebrand
//! dev.conduit.app dir) unless the GUI's `storage.dbDir` setting relocates
//! it (B-27).
//!
//! Windows builds use the GUI subsystem (`windows_subsystem = "windows"`) so
//! Task Scheduler ticks never allocate a console window (the old
//! powershell-wrapper dance flashed a terminal every minute). When a human
//! runs it from a real terminal we reattach to that parent console below, so
//! `list`/error output still works interactively.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::process::ExitCode;
use std::sync::Arc;

use parking_lot::Mutex;

use relay_lib::{automations, db, user_dirs};

/// Reattach to the launching terminal after starting as a GUI-subsystem
/// process. No-op when there's no parent console (Task Scheduler / wscript),
/// which is exactly the silent-background case we want.
#[cfg(windows)]
fn attach_parent_console() {
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const OPEN_EXISTING: u32 = 3;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
        fn SetStdHandle(n_std_handle: u32, h_handle: isize) -> i32;
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: isize,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: isize,
        ) -> isize;
    }

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return; // no parent console — scheduled run, stay invisible
        }
        // Reopen the console device and point stdout/stderr at it before any
        // print (Rust's std caches handles on first use). stdin isn't needed.
        let name: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
        let conout = CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            0,
            OPEN_EXISTING,
            0,
            0,
        );
        if conout != -1 {
            SetStdHandle(STD_OUTPUT_HANDLE, conout);
            SetStdHandle(STD_ERROR_HANDLE, conout);
        }
    }
}

fn db_path() -> std::path::PathBuf {
    // B-27: honor the GUI's `storage.dbDir` override — hardcoding the default
    // location made `run-due` read a different (stale/empty) database than
    // the app whenever Settings → Data had relocated it.
    db::resolve_db_path(&user_dirs::app_data_dir_default())
}

fn main() -> ExitCode {
    #[cfg(windows)]
    attach_parent_console();

    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("run") => {
            let Some(id) = args.next() else {
                eprintln!("usage: relay-automation run <automation-id>");
                return ExitCode::from(2);
            };
            run(&id)
        }
        Some("run-due") => run_due(),
        Some("list") => list(),
        _ => {
            eprintln!("usage: relay-automation run <automation-id> | run-due | list");
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
