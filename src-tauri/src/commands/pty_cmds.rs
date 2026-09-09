//! Pty and harness commands (CONTRACT.md "PTY" + "Harnesses").

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::{AppHandle, State};

use crate::browser_mcp::bound_port;
use crate::browser_mcp_register;
use crate::db;
use crate::harness_adapters::{all_adapters, get_adapter, resolve_for_spawn, CommandSpec};
use crate::secrets;
use crate::types::{HarnessStatus, HarnessUpdateStatus};
use crate::{DbState, PtyState};

type CmdResult<T> = Result<T, String>;

/// Cached `list_harnesses` probe results — see `list_harnesses`. Install
/// status flips only through install_harness (which bumps this via its longer
/// TTL expiry) or manual npm installs, so 30s staleness is invisible.
static HARNESS_STATUS_CACHE: Lazy<Mutex<Option<(Instant, Vec<HarnessStatus>)>>> =
    Lazy::new(|| Mutex::new(None));
const HARNESS_STATUS_TTL: Duration = Duration::from_secs(30);

fn harness_status_cache_get() -> Option<Vec<HarnessStatus>> {
    let guard = HARNESS_STATUS_CACHE.lock().ok()?;
    let (at, list) = guard.as_ref()?;
    if at.elapsed() < HARNESS_STATUS_TTL {
        Some(list.clone())
    } else {
        None
    }
}

fn harness_status_cache_store(list: Vec<HarnessStatus>) {
    if let Ok(mut guard) = HARNESS_STATUS_CACHE.lock() {
        *guard = Some((Instant::now(), list));
    }
}

fn harness_update_cache_store(list: Vec<HarnessUpdateStatus>) {
    if let Ok(mut guard) = HARNESS_UPDATE_CACHE.lock() {
        *guard = Some((Instant::now(), list));
    }
}

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

    // Relay-owned bundle: instructions (environment preamble + skill
    // catalog + browser workflow, appended to the CLI's own prompt), settings,
    // and BOTH MCP servers (browser + tools) — the same bundle the headless
    // chat paths use. Interactive panes run with on_request approval: the user
    // is watching the TUI and answers Claude Code's native prompts; only the
    // relay MCP tools + git are pre-allowed. OpenCode gets no full-auto
    // permission block for the same reason (its TUI prompts stay in charge).
    // Bundle failure degrades to the legacy browser-only MCP config below.
    let cwd_opt = Some(cwd.as_str());
    let artifacts_dir = crate::agent_sessions::artifacts_dir_for_bundle(&app, cwd_opt);
    // Connectors deliberately arrive EMPTY here (headless-chat only): they
    // need a chat session to attach to plus async OAuth refresh at
    // bundle-write time, and an interactive pane is a raw TUI with neither.
    // Gallery MCP servers and relay-tools/browser still ride the bundle.
    // To use a connector against a harness, run it as a harness chat.
    let bundle = crate::agent_sessions::resolve_harness_bundle(
        &app,
        Some(&project.id),
        cwd_opt,
        artifacts_dir.clone(),
        &[],
        Some("workspace_write"),
        Some("on_request"),
    );
    let mut extra_env: Vec<(String, String)> = vec![];
    match session.harness.as_str() {
        "claude_code" => {
            if let Some(b) = &bundle {
                spec.args
                    .extend(crate::harness_bundle::claude_bundle_args(b, &artifacts_dir));
            } else if let Some(cfg_path) = resolve_mcp_config(&app, &project.id) {
                append_config_flag(&mut spec, "--mcp-config", &cfg_path);
            }
        }
        "kimi_code" => {
            // --agent-file only on a fresh session (kimi rejects it with
            // --session); kimi_bundle_args applies that via the resume flag.
            let resume = session.harness_session_id.is_some();
            if let Some(b) = &bundle {
                spec.args
                    .extend(crate::harness_bundle::kimi_bundle_args(b, &artifacts_dir, resume));
            } else if let Some(cfg_path) = resolve_mcp_config(&app, &project.id) {
                append_config_flag(&mut spec, "--mcp-config-file", &cfg_path);
            }
        }
        "opencode" => {
            // No instructions delivery mechanism exists for OpenCode (no
            // config key; AGENTS.md is user-controlled) — the bundle still
            // brings relay-tools + browser MCP without full-auto perms.
            // Legacy path only applies when the bundle failed to write.
            let cfg = bundle
                .as_ref()
                .map(|b| b.opencode_config.clone())
                .filter(|p| p.exists())
                .or_else(|| resolve_opencode_config(&app, &project.id));
            if let Some(cfg_path) = cfg {
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
    let data_dir = crate::user_dirs::app_data_dir(app);
    browser_mcp_register::write_mcp_config(&data_dir, project_id, bound_port())
}

/// Same as resolve_mcp_config, but OpenCode-format: opencode reads MCP servers
/// from an opencode.json "mcp" section, pointed at via the OPENCODE_CONFIG env
/// var on the spawn (it has no --mcp-config CLI flag).
fn resolve_opencode_config(app: &AppHandle, project_id: &str) -> Option<PathBuf> {
    let data_dir = crate::user_dirs::app_data_dir(app);
    browser_mcp_register::write_opencode_config(&data_dir, project_id, bound_port())
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
/// Tauri's Webview, so we fall back to the relay app process's own RSS — a
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
pub async fn list_harnesses(force: Option<bool>) -> CmdResult<Vec<HarnessStatus>> {
    // Each install probe spawns the CLI with `--version` and polls for up to
    // 5s per binary. This command used to be sync, so every agent-menu open
    // froze the whole window while ~6 node CLIs cold-started. Two fixes:
    //   1. async command → probes run off the main thread,
    //   2. 30s TTL cache → repeated opens cost nothing (install status only
    //      changes via install_harness / manual npm, well over TTL apart).
    // `force` bypasses the cache for the Settings "Re-check" button: its whole
    // purpose is picking up OUT-OF-BAND installs/uninstalls, which the 30s
    // window would otherwise hide. A forced probe still refreshes the cache,
    // so background callers (boot, agent picker) keep their cheap path.
    let force = force.unwrap_or(false);
    if !force {
        if let Some(list) = harness_status_cache_get() {
            return Ok(list);
        }
    }
    let probed = tauri::async_runtime::spawn_blocking(|| {
        all_adapters()
            .into_iter()
            .map(|a| HarnessStatus {
                id: a.id().to_string(),
                display_name: a.display_name().to_string(),
                installed: a.is_installed(),
            })
            .collect::<Vec<HarnessStatus>>()
    })
    .await
    .map_err(|e| format!("harness probe join failed: {e}"))?;
    harness_status_cache_store(probed.clone());
    Ok(probed)
}

/// Cached `check_harness_updates` results. The check hits the npm registry
/// (one HTTP GET per installed harness) plus a `--version` spawn per binary,
/// so — unlike the 30s install-status cache — this keeps results for a full
/// hour. `force` (Settings "Re-check", post-install refresh) bypasses it.
static HARNESS_UPDATE_CACHE: Lazy<Mutex<Option<(Instant, Vec<HarnessUpdateStatus>)>>> =
    Lazy::new(|| Mutex::new(None));
const HARNESS_UPDATE_TTL: Duration = Duration::from_secs(3600);

/// Compare dotted numeric versions: true when `latest` is strictly newer than
/// `installed`. Hand-rolled rather than a semver crate because the inputs are
/// dist-tag versions ("2.4.1"); pre-release suffixes ("1.0.0-rc.1") compare
/// equal to the base version, which is fine for stable-channel CLIs.
fn version_is_newer(latest: &str, installed: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split(|c: char| c == '.' || c == '-' || c == '+')
            .map_while(|p| p.parse::<u64>().ok())
            .collect()
    }
    let (l, r) = (parts(latest), parts(installed));
    if l.is_empty() || r.is_empty() {
        return false;
    }
    for i in 0..l.len().max(r.len()) {
        let a = l.get(i).copied().unwrap_or(0);
        let b = r.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

/// Latest published version of an npm package (`latest` dist-tag). One HTTP
/// GET against registry.npmjs.org; None when offline or the package vanished.
async fn npm_latest_version(package: &str) -> Option<String> {
    static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default()
    });
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let json: serde_json::Value = CLIENT.get(&url).send().await.ok()?.json().await.ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// For every installed harness with a known npm package: installed version
/// (the CLI's own `--version` output) vs the registry's latest. Drives the
/// Settings "Update" button (shown only when newer) and the boot-time
/// notification. Cached for an hour; `force` re-probes immediately.
#[tauri::command]
pub async fn check_harness_updates(force: Option<bool>) -> CmdResult<Vec<HarnessUpdateStatus>> {
    let force = force.unwrap_or(false);
    if !force {
        if let Ok(guard) = HARNESS_UPDATE_CACHE.lock() {
            if let Some((at, list)) = guard.as_ref() {
                if at.elapsed() < HARNESS_UPDATE_TTL {
                    return Ok(list.clone());
                }
            }
        }
    }
    let checks = tauri::async_runtime::spawn_blocking(|| {
        all_adapters()
            .into_iter()
            .filter_map(|a| {
                let package = harness_npm_package(a.id())?;
                let installed = crate::harness_adapters::installed_cli_version(a.binary());
                Some((a.id().to_string(), package, installed))
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("harness update probe join failed: {e}"))?;

    let mut results = Vec::new();
    for (id, package, installed_version) in checks {
        // Not installed (or --version failed) → nothing to update; skip the
        // registry call entirely so offline machines pay no network cost.
        let Some(installed_version) = installed_version else {
            results.push(HarnessUpdateStatus {
                id,
                installed_version: None,
                latest_version: None,
                update_available: false,
            });
            continue;
        };
        let latest_version = npm_latest_version(package).await;
        let update_available = latest_version
            .as_deref()
            .map(|latest| version_is_newer(latest, &installed_version))
            .unwrap_or(false);
        results.push(HarnessUpdateStatus {
            id,
            installed_version: Some(installed_version),
            latest_version,
            update_available,
        });
    }
    harness_update_cache_store(results.clone());
    Ok(results)
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

/// The npm package that installs each harness CLI (one-click Install in the
/// Harnesses settings panel). Verified upstream names:
/// claude → @anthropic-ai/claude-code, kimi → @moonshot-ai/kimi-code,
/// opencode → opencode-ai, pi → @earendil-works/pi-coding-agent,
/// omp → @oh-my-pi/pi-coding-agent, commandcode → command-code.
fn harness_npm_package(harness_id: &str) -> Option<&'static str> {
    match harness_id {
        "claude_code" => Some("@anthropic-ai/claude-code"),
        "kimi_code" => Some("@moonshot-ai/kimi-code"),
        "opencode" => Some("opencode-ai"),
        "pi" => Some("@earendil-works/pi-coding-agent"),
        "omp" => Some("@oh-my-pi/pi-coding-agent"),
        "commandcode" => Some("command-code"),
        _ => None,
    }
}

/// Runtime prerequisites a harness's npm distribution needs beyond Node/npm.
/// omp's npm package is a Bun program — its bin shim `exec`s `bun`, so on a
/// Bun-less device the install "succeeds" while every probe (and every launch)
/// fails. Surfacing that up front beats a mystery "not installed" row.
fn harness_runtime_prerequisite(harness_id: &str) -> Option<(&'static str, &'static str)> {
    match harness_id {
        "omp" => Some((
            "bun",
            "omp's npm distribution requires the Bun runtime — install Bun first \
             (npm install -g bun, or https://bun.sh), then install omp",
        )),
        _ => None,
    }
}

/// npm's global install prefix (`npm config get prefix`). npm-managed
/// binaries live directly inside it on Windows (`…\Roaming\npm\claude.cmd`)
/// and in `<prefix>/bin` on Unix. Blocking and slow-ish (spawns npm) — keep
/// off the main thread.
fn npm_global_prefix() -> Option<std::path::PathBuf> {
    use std::process::{Command, Stdio};
    let spec = resolve_for_spawn(&CommandSpec::new("npm", &["config", "get", "prefix"]));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then(|| std::path::PathBuf::from(s))
}

/// True when `resolved` is a file inside npm's global bin area — i.e. an
/// `npm install -g` of the package would replace this exact binary. A copy
/// anywhere else (winget, vendor installer, ~/.kimi-code/bin) SHADOWS the
/// shim on PATH and must be updated by its own tool instead.
fn binary_is_npm_managed(resolved: &std::path::Path) -> bool {
    let Some(prefix) = npm_global_prefix() else {
        return false;
    };
    #[cfg(windows)]
    let bin_dir = prefix;
    #[cfg(not(windows))]
    let bin_dir = prefix.join("bin");
    // Component-wise so "C:\foo\bar" can't match base "C:\foo\b"; ASCII-case
    // folding only on Windows where path casing is not significant.
    let pcs: Vec<_> = resolved
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let bcs: Vec<_> = bin_dir
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    pcs.len() > bcs.len()
        && pcs.iter().zip(bcs.iter()).all(|(p, b)| {
            #[cfg(windows)]
            {
                p.eq_ignore_ascii_case(b)
            }
            #[cfg(not(windows))]
            {
                p == b
            }
        })
}

/// One-click harness install / update. npm-managed copies go through
/// `npm install -g <package>` (which always resolves the latest dist-tag);
/// a native copy that shadows the npm shim on PATH is updated with the
/// CLI's own updater instead. Long-running (either can take a minute+) so
/// this is async with a 5-minute ceiling; the frontend re-probes afterwards.
#[tauri::command]
pub async fn install_harness(harness_id: String) -> CmdResult<String> {
    let adapter = get_adapter(&harness_id)
        .ok_or_else(|| format!("unknown harness: {harness_id}"))?;
    let display_name = adapter.display_name();
    // WHO gets updated: `npm install -g` rewrites the shim inside npm's
    // prefix, but PATH may resolve a native copy (winget / vendor installer)
    // that shadows it — updating the shim then silently fixes the wrong copy
    // and the row's version never moves (the "Update button never clears"
    // bug). Resolve the actual binary and route native copies to the CLI's
    // own updater.
    enum UpdateTarget {
        Npm,
        Native(CommandSpec),
        NativeUnsupported,
    }
    let resolver_adapter = adapter.clone();
    let target = tauri::async_runtime::spawn_blocking(move || {
        let Some(resolved) = crate::harness_adapters::resolve_binary_on_path(resolver_adapter.binary())
        else {
            // Not installed (or nothing resolvable) → npm install must work.
            return UpdateTarget::Npm;
        };
        if binary_is_npm_managed(&resolved) {
            return UpdateTarget::Npm;
        }
        match resolver_adapter.native_update_command(&resolved) {
            Some(native_spec) => UpdateTarget::Native(native_spec),
            None => UpdateTarget::NativeUnsupported,
        }
    })
    .await
    .unwrap_or(UpdateTarget::Npm);

    let (spec, label, success_line) = match target {
        UpdateTarget::NativeUnsupported => {
            return Err(format!(
                "{display_name} is installed natively (not via npm) and has no in-app \
                 updater — update it with its own tool (winget / vendor installer), \
                 then press Re-check",
            ));
        }
        UpdateTarget::Native(native) => {
            let label = format!("{} update (native updater)", native.program);
            (
                resolve_for_spawn(&native),
                label,
                format!(
                    "Updated {display_name} via its native updater — {harness_id} is ready to use",
                ),
            )
        }
        UpdateTarget::Npm => {
            if let Some((binary, hint)) = harness_runtime_prerequisite(&harness_id) {
                let present =
                    tauri::async_runtime::spawn_blocking(move || crate::harness_adapters::binary_on_path(binary))
                        .await
                        .unwrap_or(false);
                if !present {
                    return Err(hint.to_string());
                }
            }
            let package = harness_npm_package(&harness_id)
                .ok_or_else(|| format!("unknown harness: {harness_id}"))?;
            let label = format!("npm install -g {package}");
            let success_line = format!("Installed {package} — {harness_id} is ready to use");
            (
                resolve_for_spawn(&CommandSpec::new("npm", &["install", "-g", package])),
                label,
                success_line,
            )
        }
    };
    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Suppress the console-window flash a GUI app gets when shelling out on
    // Windows (same pattern as codeexec/pygen; tokio exposes the inherent
    // creation_flags method).
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| format!("{label} timed out after 5 minutes"))?
        .map_err(|e| format!("failed to run {} (is Node.js installed?): {e}", spec.program))?;
    if output.status.success() {
        // The install flipped the probe result — drop the cached statuses so
        // the frontend's immediate re-probe sees "installed" instead of a
        // stale entry from the 30s TTL window. Same for the update cache: the
        // freshly installed version IS the registry latest, so the row must
        // flip from "Update" back to "Run login" on the next check.
        if let Ok(mut guard) = HARNESS_STATUS_CACHE.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = HARNESS_UPDATE_CACHE.lock() {
            *guard = None;
        }
        // Verify the CLI actually RUNS now before reporting success. A freshly
        // written npm shim can fail its first `--version` (Defender scanning
        // the new node_modules, cold node start > the probe's 5s cap) — the
        // row then stayed on "Install" until a manual Re-check. Poll briefly;
        // missing binaries fail spawn instantly so this loop is fast when the
        // install genuinely didn't produce a runnable CLI.
        let verify_id = harness_id.clone();
        let verified = tauri::async_runtime::spawn_blocking(move || {
            let Some(adapter) = get_adapter(&verify_id) else { return false };
            for attempt in 0..6 {
                if adapter.is_installed() {
                    return true;
                }
                if attempt < 5 {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        if verified {
            Ok(success_line)
        } else {
            let binary = get_adapter(&harness_id)
                .map(|a| a.binary().to_string())
                .unwrap_or_else(|| harness_id.clone());
            Ok(format!(
                "Ran {label}, but `{binary} --version` still fails — it may need a PATH \
                 refresh (restart Relay) or a runtime this device is missing",
            ))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "{label} failed:\n{}",
            if tail.trim().is_empty() { "unknown error" } else { tail.trim() },
        ))
    }
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

#[cfg(test)]
mod tests {
    use super::version_is_newer;

    #[test]
    fn newer_when_latest_is_ahead() {
        assert!(version_is_newer("2.1.263", "2.1.220"));
        assert!(version_is_newer("1.0", "0.99.9"));
        assert!(version_is_newer("2.0", "1.9.9"));
    }

    #[test]
    fn not_newer_when_equal_or_behind() {
        assert!(!version_is_newer("2.1.263", "2.1.263"));
        assert!(!version_is_newer("2.1.220", "2.1.263"));
        assert!(!version_is_newer("18.1.14", "18.1.14"));
    }

    #[test]
    fn tolerates_v_prefix_and_short_forms() {
        assert!(version_is_newer("v2.0", "1.9.9"));
        // "1.10" vs "1.9" compares numerically, not lexically.
        assert!(version_is_newer("1.10", "1.9"));
        assert!(!version_is_newer("1.9", "1.10"));
    }

    #[test]
    fn garbage_or_missing_versions_never_report_update() {
        assert!(!version_is_newer("", "1.0"));
        assert!(!version_is_newer("1.0", ""));
        assert!(!version_is_newer("abc", "1.0"));
    }
}
