//! Pty and harness commands (CONTRACT.md "PTY" + "Harnesses").

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::browser::BROWSER_MCP_PORT;
use crate::browser_mcp_register;
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
    app: AppHandle,
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
    let mut spec = match &session.harness_session_id {
        Some(hid) => adapter.spawn_resume_command(hid),
        None => adapter.spawn_new_command(),
    };

    // Register the conduit-browser-mcp server for agent sessions so the
    // harness can drive the in-app browser pane. Writes a Conduit-owned
    // config (never the project cwd) and surfaces it per harness: claude
    // `--mcp-config`, kimi `--mcp-config-file`, opencode via the
    // OPENCODE_CONFIG env var (no CLI flag) (Task #6).
    let mut extra_env: Vec<(String, String)> = vec![];
    match session.harness.as_str() {
        "claude_code" => {
            if let Some(cfg_path) = resolve_mcp_config(&app, &project.id) {
                append_config_flag(&mut spec, "--mcp-config", &cfg_path);
            }
        }
        "kimi_code" => {
            if let Some(cfg_path) = resolve_mcp_config(&app, &project.id) {
                append_config_flag(&mut spec, "--mcp-config-file", &cfg_path);
            }
        }
        "opencode" => {
            if let Some(cfg_path) = resolve_opencode_config(&app, &project.id) {
                extra_env.push((
                    "OPENCODE_CONFIG".to_string(),
                    cfg_path.to_string_lossy().replace('\\', "/"),
                ));
            }
        }
        _ => {}
    }

    pty.0.spawn(&pane_id, Some(session_id.clone()), Some(adapter), Path::new(&cwd), &spec, extra_env)?;
    // Resume case: the harness id is already known — bind it now so the
    // on-disk usage sync starts immediately (no probe window needed).
    if let Some(hid) = &session.harness_session_id {
        pty.0.set_harness_session_id(&pane_id, hid);
    }
    let conn = db.0.lock();
    db::touch_session(&conn, &session_id).map_err(|e| e.to_string())
}

/// Resolve (writing if needed) the per-project `.mcp.json` for the browser MCP
/// server. Returns the path to pass to `--mcp-config`, or None if the binary
/// isn't present (dev build without the binary) or the write failed — both
/// degrade silently to "no browser tools this session" rather than blocking.
fn resolve_mcp_config(app: &AppHandle, project_id: &str) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    browser_mcp_register::write_mcp_config(&data_dir, project_id, BROWSER_MCP_PORT)
}

/// Same as resolve_mcp_config, but OpenCode-format: opencode reads MCP servers
/// from an opencode.json "mcp" section, pointed at via the OPENCODE_CONFIG env
/// var on the spawn (it has no --mcp-config CLI flag).
fn resolve_opencode_config(app: &AppHandle, project_id: &str) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    browser_mcp_register::write_opencode_config(&data_dir, project_id, BROWSER_MCP_PORT)
}

/// Append `<flag> <path>` to a CommandSpec (e.g. `--mcp-config` for claude,
/// `--mcp-config-file` for kimi). Idempotent: if the flag is already present
/// (shouldn't happen, but defensive), skip.
fn append_config_flag(spec: &mut CommandSpec, flag: &str, cfg_path: &Path) {
    if spec.args.iter().any(|a| a == flag) {
        return;
    }
    let path_str = cfg_path.to_string_lossy().replace('\\', "/");
    spec.args.push(flag.to_string());
    spec.args.push(path_str);
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
///
/// SECURITY: the `command` is a string the frontend passed in from a
/// quick-action or harness login. The shell will interpret it (pipes,
/// redirects, expansions, …) so this is intentionally a shell — a
/// well-structured CommandSpec with argv would silently swallow shell
/// features. Callers are responsible for not letting untrusted model
/// output flow into this argument; the frontend wires it from user-curated
/// quick actions and explicit input only.
///
/// Hardening: a `command` containing NUL bytes is always a bug (shells
/// terminate strings on NUL). The frontend also rejects NULs in user
/// input, but defending again here guarantees a corrupted DB row (e.g. a
/// quick-action with embedded NUL) cannot smuggle extra bytes past
/// the shell interface.
fn shell_spec(command: &str) -> CommandSpec {
    let cleaned = command.replace('\0', "");
    #[cfg(windows)]
    {
        CommandSpec::new("cmd.exe", &["/C", &cleaned])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
        CommandSpec {
            program: shell,
            args: vec!["-lc".to_string(), cleaned.to_string()],
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

/// Dev-mode memory counter: return the resident memory (bytes) of a pane's
/// child process. For a terminal pane this is the PTY child's RSS via sysinfo
/// (looked up by PID). For a browser pane there is no per-pane PID exposed by
/// Tauri's Webview, so we fall back to the conduit app process's own RSS — a
/// rough proxy that at least surfaces "the browser is eating memory" growth.
/// Returns 0 when the pane/PID is gone or memory can't be read (e.g. the
/// process already exited). Intended for a dev-only header chip; not a
/// production metric.
#[tauri::command]
pub fn pane_memory(pane_id: String, pty: State<PtyState>) -> CmdResult<u64> {
    use sysinfo::{get_current_pid, ProcessesToUpdate, ProcessRefreshKind, Pid, System};

    let pid = match pty.0.pane_pid(&pane_id) {
        Some(pid) => Pid::from_u32(pid),
        // Browser pane (no PTY child): fall back to the app process's own RSS.
        None => match get_current_pid() {
            Ok(pid) => pid,
            Err(_) => return Ok(0),
        },
    };

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::new().with_memory(),
    );
    match sys.process(pid) {
        Some(proc_) => Ok(proc_.memory() as u64),
        None => Ok(0),
    }
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

/// Register a typed `Channel<Vec<u8>>` for raw PTY output on this pane. The
/// reader thread coalesces output into 16ms/64KB frames and sends each
/// frame as raw bytes through the channel — no JSON serialization, no
/// UTF-8 lossy conversion. Replaces the legacy `app.emit("pty:output",
/// PtyOutputEvent { data: String })` path.
///
/// The frontend calls this once per pane-open; the channel is held for the
/// pane's lifetime. When the consumer drops (pane closes, navigation), the
/// reader thread falls back to `app.emit("pty:output", ...)` automatically
/// because `Pane.output_channel` is `Option<Channel>`. No-op when the pane
/// is unknown (the pane may have been killed before the React effect
/// mounted).
#[tauri::command]
pub fn pty_subscribe(
    pane_id: String,
    channel: tauri::ipc::Channel<Vec<u8>>,
    pty: State<PtyState>,
) -> CmdResult<()> {
    pty.0.attach_output_channel(&pane_id, channel);
    Ok(())
}
