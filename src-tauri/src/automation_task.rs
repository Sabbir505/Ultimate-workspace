//! "Run while closed" — Windows Task Scheduler registration for automations.
//!
//! One global task (`ConduitAutomations`) fires `conduit-automation run-due`
//! every minute; the binary applies the app's own due-math
//! (automations::due_automations), so cron semantics are identical whether
//! Conduit is open or closed. A single registration covers every enabled
//! automation — edits/deletes never touch the task.
//!
//! Windows-only for now: `schtasks` is the system tool. Other platforms get a
//! friendly "unsupported" error from the commands (launchd/cron is the
//! follow-up). The registered state is the task itself (`schtasks /Query`),
//! not a setting row, so the UI can't drift from reality.

use std::path::PathBuf;
use std::process::Command;

/// Task Scheduler name for the global run-due entry.
const TASK_NAME: &str = "ConduitAutomations";

/// The cargo target triple for the host (compile-time cfg-derived — same
/// approach as browser_mcp_register::HOST_TRIPLE, avoiding env!("TARGET")).
const HOST_TRIPLE: &str = if cfg!(target_os = "windows") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    }
} else if cfg!(target_os = "macos") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    }
} else if cfg!(target_os = "linux") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
} else {
    "unknown-target"
};

/// Resolve the `conduit-automation` binary shipped alongside the main
/// executable. Mirrors browser_mcp_register::mcp_binary_path:
///   1. Dev layout: `<exe_dir>/conduit-automation[.exe]` (cargo build — both
///      bins land in the same target/{debug,release} dir)
///   2. Bundle layout: `<exe_dir>/binaries/conduit-automation-<triple>[.exe]`
///   3. NSIS root: `<exe_dir>/../binaries/...`
pub fn automation_binary_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    automation_binary_path_from(dir)
}

/// Testable core of `automation_binary_path` — checks the three layouts under
/// a given executable directory.
fn automation_binary_path_from(dir: &std::path::Path) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "conduit-automation.exe"
    } else {
        "conduit-automation"
    };

    // 1. Dev layout: sibling in the same target directory.
    let dev_path = dir.join(exe_name);
    if dev_path.exists() {
        return Some(dev_path);
    }

    // 2. Bundle layout: Tauri 2 externalBin.
    let bundled_name = format!(
        "conduit-automation-{}{}",
        HOST_TRIPLE,
        if cfg!(windows) { ".exe" } else { "" }
    );
    let bundled = dir.join("binaries").join(&bundled_name);
    if bundled.exists() {
        return Some(bundled);
    }

    // 3. NSIS root: main exe one level below the install root.
    if let Some(install_root) = dir.parent() {
        let bundled_root = install_root.join("binaries").join(&bundled_name);
        if bundled_root.exists() {
            return Some(bundled_root);
        }
    }

    None
}

/// The `/TR` argument for the scheduled task: quoted binary + run-due.
fn task_run_command(binary: &std::path::Path) -> String {
    format!("\"{}\" run-due", binary.display())
}

/// schtasks argument vector for creating (or overwriting) the global task.
/// `/SC MINUTE /MO 1` = every minute, the finest granularity Task Scheduler
/// offers — exact cron fidelity comes from run-due's own due-math. Runs as
/// the current user in logged-on sessions; no elevation.
fn create_args(binary: &std::path::Path) -> Vec<String> {
    vec![
        "/Create".into(),
        "/TN".into(),
        TASK_NAME.into(),
        "/TR".into(),
        task_run_command(binary),
        "/SC".into(),
        "MINUTE".into(),
        "/MO".into(),
        "1".into(),
        "/F".into(), // overwrite an existing task (e.g. binary moved)
    ]
}

fn delete_args() -> Vec<String> {
    vec!["/Delete".into(), "/TN".into(), TASK_NAME.into(), "/F".into()]
}

fn query_args() -> Vec<String> {
    vec!["/Query".into(), "/TN".into(), TASK_NAME.into()]
}

#[cfg(target_os = "windows")]
fn run_schtasks(args: &[String]) -> Result<String, String> {
    // CREATE_NO_WINDOW: the registration runs from the GUI's command handler —
    // a console flash on every toggle would be jarring.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let out = Command::new("schtasks")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run schtasks: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "schtasks {} failed: {}",
            args.first().map(|s| s.as_str()).unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Whether the global run-due task is registered. Non-Windows: always false.
#[tauri::command]
pub fn get_run_while_closed() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // Exit code 0 = the task exists. Any error (not found, scheduler
        // service down) reads as "not registered" — the UI toggle stays off
        // and the user can just flip it on to self-heal.
        Ok(run_schtasks(&query_args()).is_ok())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

/// Register or unregister the global run-due task.
#[tauri::command]
pub fn set_run_while_closed(enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("Run while closed isn't supported on this platform yet (Windows Task Scheduler only)".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        if !enabled {
            // Deleting a task that doesn't exist is fine — treat as off.
            let _ = run_schtasks(&delete_args());
            return Ok(());
        }
        let binary = automation_binary_path().ok_or_else(|| {
            "conduit-automation binary not found next to the app — reinstall or run a full build".to_string()
        })?;
        run_schtasks(&create_args(&binary))?;
        Ok(())
    }
}

/// POST a sample payload to the configured webhook so the user can verify
/// the URL from the UI's Test button.
#[tauri::command]
pub async fn test_automation_webhook(db: tauri::State<'_, crate::DbState>) -> Result<(), String> {
    let url = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, "automations.webhookUrl").ok().flatten()
    };
    let url = url
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| "No webhook URL configured".to_string())?;
    crate::automations::post_json(
        &url,
        &serde_json::json!({
            "event": "automation.webhook_test",
            "name": "Test notification",
            "status": "ok",
            "summary": "If you can see this, the webhook works.",
            "finishedAt": crate::db::now_ts(),
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_args_shape() {
        let args = create_args(std::path::Path::new("C:\\app\\conduit-automation.exe"));
        assert_eq!(args[0], "/Create");
        assert!(args.windows(2).any(|w| w == ["/TN", TASK_NAME]));
        assert!(args.windows(2).any(|w| w == ["/SC", "MINUTE"]));
        assert!(args.windows(2).any(|w| w == ["/MO", "1"]));
        let tr = args
            .windows(2)
            .find(|w| w[0] == "/TR")
            .map(|w| w[1].clone())
            .expect("/TR present");
        // The binary path is quoted (spaces in install dirs) and the
        // subcommand follows the closing quote.
        assert_eq!(tr, "\"C:\\app\\conduit-automation.exe\" run-due");
        assert!(args.iter().any(|a| a == "/F"));
    }

    #[test]
    fn delete_and_query_args_reference_the_global_task() {
        assert_eq!(delete_args(), vec!["/Delete", "/TN", TASK_NAME, "/F"]);
        assert_eq!(query_args(), vec!["/Query", "/TN", TASK_NAME]);
    }

    #[test]
    fn binary_path_prefers_dev_layout_then_bundle() {
        let tmp = std::env::temp_dir().join(format!("conduit-task-test-{}", std::process::id()));
        let exe_name = if cfg!(windows) { "conduit-automation.exe" } else { "conduit-automation" };
        std::fs::create_dir_all(&tmp).unwrap();

        // Nothing there → None.
        assert!(automation_binary_path_from(&tmp).is_none());

        // Dev layout wins.
        let dev = tmp.join(exe_name);
        std::fs::write(&dev, b"x").unwrap();
        assert_eq!(automation_binary_path_from(&tmp), Some(dev.clone()));
        std::fs::remove_file(&dev).unwrap();

        // Bundle layout: binaries/conduit-automation-<triple>.
        let bundled_name = format!(
            "conduit-automation-{}{}",
            HOST_TRIPLE,
            if cfg!(windows) { ".exe" } else { "" }
        );
        std::fs::create_dir_all(tmp.join("binaries")).unwrap();
        let bundled = tmp.join("binaries").join(&bundled_name);
        std::fs::write(&bundled, b"x").unwrap();
        assert_eq!(automation_binary_path_from(&tmp), Some(bundled));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
