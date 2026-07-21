//! Pty and harness commands (CONTRACT.md "PTY" + "Harnesses").

use std::path::Path;

use tauri::State;

use crate::db;
use crate::harness_adapters::{all_adapters, get_adapter, CommandSpec};
use crate::secrets;
use crate::types::HarnessStatus;
use crate::{DbState, PtyState};

type CmdResult<T> = Result<T, String>;

/// Spawns the harness bound to an existing session record: the resume command
/// when a harness session id is already known, otherwise a fresh interactive
/// session. cwd = worktreePath ?? project.path (CONTRACT.md).
#[tauri::command]
pub fn spawn_agent_session(
    pane_id: String,
    session_id: String,
    db: State<DbState>,
    pty: State<PtyState>,
) -> CmdResult<()> {
    let (session, project) = {
        let conn = db.0.lock();
        db::get_session_with_project(&conn, &session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "session not found".to_string())?
    };
    let adapter = get_adapter(&session.harness)
        .ok_or_else(|| format!("unknown harness: {}", session.harness))?;
    let cwd = session.worktree_path.clone().unwrap_or(project.path);
    if !Path::new(&cwd).is_dir() {
        return Err(format!("working directory does not exist: {cwd}"));
    }
    let spec = match &session.harness_session_id {
        Some(hid) => adapter.spawn_resume_command(hid),
        None => adapter.spawn_new_command(),
    };
    pty.0.spawn(&pane_id, Some(session_id.clone()), Some(adapter), Path::new(&cwd), &spec, vec![])?;
    // Resume case: the harness id is already known — bind it now so the
    // on-disk usage sync starts immediately (no probe window needed).
    if let Some(hid) = &session.harness_session_id {
        pty.0.set_harness_session_id(&pane_id, hid);
    }
    let conn = db.0.lock();
    db::touch_session(&conn, &session_id).map_err(|e| e.to_string())
}

/// Spawns a login shell running `command` — used for quick actions and
/// harness login flows. Project secrets are injected as env vars ONLY when
/// `inject_secrets_project_id` is passed (PRD §7.16: explicit opt-in).
#[tauri::command]
pub fn spawn_shell(
    pane_id: String,
    cwd: String,
    command: String,
    inject_secrets_project_id: Option<String>,
    db: State<DbState>,
    pty: State<PtyState>,
) -> CmdResult<()> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("working directory does not exist: {cwd}"));
    }
    let extra_env = match inject_secrets_project_id {
        Some(pid) => {
            let conn = db.0.lock();
            secrets::secrets_for_injection(&conn, &pid)?
        }
        None => Vec::new(),
    };
    let spec = shell_spec(&command);
    pty.0.spawn(&pane_id, None, None, Path::new(&cwd), &spec, extra_env)
}

/// Runs a command string through a shell: `cmd.exe /C` on Windows, a POSIX
/// login shell (`$SHELL -lc`, fallback `sh -lc`) elsewhere — login mode so
/// the user's PATH/profile tweaks (nvm, homebrew, …) apply to quick actions.
fn shell_spec(command: &str) -> CommandSpec {
    #[cfg(windows)]
    {
        CommandSpec::new("cmd.exe", &["/C", command])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
        CommandSpec {
            program: shell,
            args: vec!["-lc".to_string(), command.to_string()],
        }
    }
}

#[tauri::command]
pub fn write_pty(pane_id: String, data: String, pty: State<PtyState>) -> CmdResult<()> {
    pty.0.write(&pane_id, &data)
}

#[tauri::command]
pub fn resize_pty(pane_id: String, cols: u16, rows: u16, pty: State<PtyState>) -> CmdResult<()> {
    pty.0.resize(&pane_id, cols, rows)
}

/// Explicit close — the ONLY user action (besides app quit) allowed to kill a
/// pane's process. Unfocused panes keep running (PRD §6.5).
#[tauri::command]
pub fn kill_pty(pane_id: String, pty: State<PtyState>) -> CmdResult<()> {
    pty.0.kill_pane(&pane_id);
    Ok(())
}

#[tauri::command]
pub fn list_harnesses() -> CmdResult<Vec<HarnessStatus>> {
    Ok(all_adapters()
        .into_iter()
        .map(|a| HarnessStatus {
            id: a.id().to_string(),
            display_name: a.display_name().to_string(),
            installed: a.is_installed(),
        })
        .collect())
}

/// Spawns the harness's login flow in the given pane (PRD §9 onboarding).
#[tauri::command]
pub fn run_harness_login(
    pane_id: String,
    harness_id: String,
    cwd: String,
    pty: State<PtyState>,
) -> CmdResult<()> {
    let adapter =
        get_adapter(&harness_id).ok_or_else(|| format!("unknown harness: {harness_id}"))?;
    if !Path::new(&cwd).is_dir() {
        return Err(format!("working directory does not exist: {cwd}"));
    }
    let spec = adapter.login_command();
    pty.0.spawn(&pane_id, None, Some(adapter), Path::new(&cwd), &spec, vec![])
}
