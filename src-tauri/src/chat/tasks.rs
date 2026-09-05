//! Background task manager for the chat's system tools.
//!
//! Powers the agentic "do it for me" tools that must NOT block the
//! conversation turn:
//!
//!   * `download_file` — stream a file from a URL to an absolute local path
//!     (e.g. `.safetensors` / `.bin` model weights straight from Hugging
//!     Face). Chunked streaming writes straight to disk (no whole-file
//!     memory buffering), with resume (`.part` file + `Range`), transient
//!     retries, speed tracking and per-chunk progress events.
//!   * `run_shell` — native shell execution on the host (unsandboxed by
//!     design — this is the "run CLI tools like huggingface-cli download"
//!     escape hatch). Runs as a background task with streaming output so a
//!     long-running command doesn't lock the chat.
//!
//! Every task gets a `task_id`; the model tracks it with
//! `get_task_status` / `download_progress` and aborts it with
//! `cancel_task`. Progress is ALSO pushed to the UI as `chat:task-progress`
//! events so the chat tab can render live progress cards without polling.
//!
//! Security posture: downloads accept any http(s) URL and any absolute
//! destination path — unrestricted filesystem access is the point (writing
//! to D:\models etc. without a virtual workspace boundary). The permission
//! gate in `permission::check_system_permission` decides whether the call
//! auto-runs or surfaces an approval card before the task is even created.
//! `run_shell` is native code execution, so it is ALWAYS gated on an
//! approval card, in every permission mode.
//!
//! # Terminal process lifecycle (authoritative rules)
//!
//! Every process the model starts through the shell tool belongs to exactly
//! one of four lifecycle classes. The limits below are the single source of
//! truth — the tool description, the `get_capabilities` report
//! ([`terminal_lifecycle_json`]) and the enforcement code all read from
//! these constants, so they cannot drift.
//!
//! | Class | How to start | Lifetime | Cleanup |
//! |---|---|---|---|
//! | **Foreground** (default) | `run_shell` | ≤ [`SHELL_FOREGROUND_TIMEOUT_SECS`] (120s); `timeout_secs` may shorten, never extend | None — process exits, output returns inline |
//! | **Temporary** | any mode + explicit `timeout_secs` (5–3600) | auto-killed exactly at the deadline, state → Failed with a timeout notice | Automatic — the engine kills it |
//! | **Background** | `run_shell` + `background: true` | returns a task id immediately; output streams via `get_task_status` | `cancel_task`, or app exit (`kill_on_drop`) |
//! | **Long-running** | background + NO `timeout_secs` | unbounded while the app runs (dev servers, watchers, long installs) | the model MUST `cancel_task` when done; app exit is the backstop |
//!
//! Hard rules the enforcement encodes:
//! 1. A foreground command can NEVER outlive [`SHELL_FOREGROUND_TIMEOUT_SECS`]
//!    — the ceiling protects the conversation turn, so an explicit
//!    `timeout_secs` is clamped to `[SHELL_TEMPORARY_MIN_SECS,
//!    SHELL_FOREGROUND_TIMEOUT_SECS]` in the foreground.
//! 2. Anything expected to run longer than the foreground ceiling MUST be
//!    started with `background: true`. Work that must self-terminate sets
//!    `timeout_secs` (clamped to `[SHELL_TEMPORARY_MIN_SECS,
//!    SHELL_TEMPORARY_MAX_SECS]` in the background) — that is the Temporary
//!    class.
//! 3. Background shells without a timeout are the Long-running class: no
//!    engine-side deadline, but the model owns the cleanup (`cancel_task`).
//! 4. Availability questions (connectors / MCP servers) never start a
//!    process at all — `get_capabilities` answers them in-process, and the
//!    shell dispatch refuses `mcp list`-style probes (see
//!    `dispatch::capability_probe_refusal`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::time::sleep;

use crate::types::ChatTaskProgressPayload;

/// How long a terminal task (completed/failed/cancelled) stays in the
/// registry before being swept, so `get_task_status` answers stay truthful
/// for a while but the map doesn't grow forever.
const TERMINAL_TASK_TTL: Duration = Duration::from_secs(60 * 60);
/// Max bytes of a shell task's captured output kept for the model.
const SHELL_OUTPUT_CAP: usize = 200_000;
/// Throttle for progress events (downloads) — ~7/s max.
const PROGRESS_EMIT_MIN: Duration = Duration::from_millis(150);
/// Throttle for shell output events.
const SHELL_EMIT_MIN: Duration = Duration::from_millis(250);
/// Transient download failures are retried this many times.
const DOWNLOAD_RETRIES: u32 = 2;
/// A transfer with no bytes for this long is declared stalled and retried
/// (resumed via Range). This replaces the old blanket request timeout, which
/// capped TOTAL transfer time and made every large model download fail.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);

// ---- Terminal lifecycle limits (see the module doc) ----

/// Foreground ceiling in seconds: a synchronous `run_shell` is killed at this
/// deadline so a never-exiting command can't wedge the turn (and a blocking
/// pool thread). An explicit foreground `timeout_secs` may shorten the run,
/// never extend it.
pub const SHELL_FOREGROUND_TIMEOUT_SECS: u64 = 120;
/// Minimum honorable `timeout_secs` — below this the command had no chance,
/// and a mistyped `0`/`1` would read as an engine bug instead of a limit.
pub const SHELL_TEMPORARY_MIN_SECS: u64 = 5;
/// Maximum background `timeout_secs` (1 hour). Beyond this a "temporary"
/// process is really a long-running one and must be `background: true`
/// without a timeout (Long-running class, cleaned up via `cancel_task`).
pub const SHELL_TEMPORARY_MAX_SECS: u64 = 3600;

/// Foreground timeout for a `run_shell` call: explicit `timeout_secs` may
/// only SHORTEN the ceiling (clamped to `[MIN, FOREGROUND]`); `None` → the
/// default ceiling.
pub fn foreground_shell_timeout(timeout_secs: Option<u64>) -> Duration {
    let secs = timeout_secs
        .unwrap_or(SHELL_FOREGROUND_TIMEOUT_SECS)
        .clamp(SHELL_TEMPORARY_MIN_SECS, SHELL_FOREGROUND_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Background timeout: `None` → Long-running class (no engine deadline);
/// `Some(secs)` → Temporary class, clamped to `[MIN, MAX]`.
pub fn background_shell_timeout(timeout_secs: Option<u64>) -> Option<Duration> {
    timeout_secs
        .map(|s| Duration::from_secs(s.clamp(SHELL_TEMPORARY_MIN_SECS, SHELL_TEMPORARY_MAX_SECS)))
}

/// The terminal lifecycle contract as JSON for the `get_capabilities`
/// report — generated from the same constants the enforcement uses, so the
/// model always reads the live limits rather than prompt text that may lag.
pub fn terminal_lifecycle_json() -> serde_json::Value {
    serde_json::json!({
        "foreground": {
            "how": "run_shell (default)",
            "ceiling_seconds": SHELL_FOREGROUND_TIMEOUT_SECS,
            "output": "combined stdout/stderr returned in the tool result",
            "timeout_secs": "optional; may only shorten the run",
        },
        "temporary": {
            "how": "any mode + timeout_secs (5-3600)",
            "behavior": "process is killed exactly at the deadline; state becomes failed with a timeout notice",
            "cleanup": "automatic",
        },
        "background": {
            "how": "run_shell with background=true",
            "behavior": "returns a task id immediately; output streams via get_task_status",
            "cleanup": "cancel_task kills it; also killed when the app exits",
        },
        "long_running": {
            "how": "background=true without timeout_secs (dev servers, watchers, long installs)",
            "lifetime": "unbounded while the app runs",
            "cleanup": "YOU MUST cancel_task when done — app exit is only the backstop",
        },
        "availability_probes": {
            "rule": "NEVER start a process to check connector/MCP availability",
            "instead": "call get_capabilities (in-process, no approval, instant)",
        },
    })
}

/// Machine-readable task state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// A point-in-time snapshot of a background task. Sent to the model via
/// `get_task_status` / `download_progress` and to the UI via
/// `chat:task-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub task_id: String,
    /// "download" | "shell"
    pub kind: String,
    pub state: TaskState,
    /// Human-facing detail: error for failed, destination for completed
    /// downloads, latest output tail for shells.
    pub message: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub speed_bps: u64,
    pub dest_path: Option<String>,
}

impl TaskSnapshot {
    /// Percentage of the total downloaded (0.0–100.0), or `None` when the
    /// total size is unknown (e.g. streaming without Content-Length).
    #[allow(dead_code)] // used by the frontend via serialized fields; kept for tests
    pub fn percent(&self) -> Option<f64> {
        self.total.map(|t| {
            if t == 0 {
                0.0
            } else {
                (self.downloaded as f64 / t as f64 * 100.0).min(100.0)
            }
        })
    }
}

struct TaskEntry {
    snapshot: Arc<Mutex<TaskSnapshot>>,
    /// Sender that aborts the running task (download loop / shell process).
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    /// Creation time, for the terminal-task sweep.
    created: Instant,
}

impl TaskEntry {
    /// Whether the task is still in flight. Terminal tasks are swept away
    /// after `TERMINAL_TASK_TTL`.
    fn is_running(&self) -> bool {
        matches!(self.snapshot.lock().state, TaskState::Running)
    }
}

/// Registry of background tasks, shared across chat sessions. Registered as
/// Tauri state (`TaskState` in lib.rs); the chat dispatcher resolves it via
/// `app.state`.
pub struct TaskManager {
    tasks: Mutex<HashMap<String, Arc<TaskEntry>>>,
    next_id: Mutex<u64>,
}

impl Default for TaskManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskManager {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    /// Allocate a unique task id and register a running task entry.
    fn register(&self, kind: &str) -> (String, Arc<TaskEntry>) {
        let id = {
            let mut n = self.next_id.lock();
            let id = format!("task-{}", *n);
            *n += 1;
            id
        };
        let snapshot = Arc::new(Mutex::new(TaskSnapshot {
            task_id: id.clone(),
            kind: kind.to_string(),
            state: TaskState::Running,
            message: String::new(),
            downloaded: 0,
            total: None,
            speed_bps: 0,
            dest_path: None,
        }));
        let entry = Arc::new(TaskEntry {
            snapshot,
            cancel: Mutex::new(None),
            created: Instant::now(),
        });
        {
            let mut tasks = self.tasks.lock();
            // Sweep stale terminal tasks so the map can't grow unbounded.
            let now = Instant::now();
            tasks.retain(|_, e| e.is_running() || now.duration_since(e.created) < TERMINAL_TASK_TTL);
            tasks.insert(id.clone(), Arc::clone(&entry));
        }
        (id, entry)
    }

    /// Update the snapshot under a short lock and emit a `chat:task-progress`
    /// event to the UI. Callers must NOT hold the snapshot lock across this
    /// call (it re-locks). `None` app (tests / headless) skips the emit.
    fn emit<R: tauri::Runtime>(app: Option<&AppHandle<R>>, sid: &str, entry: &TaskEntry) {
        let snap = entry.snapshot.lock().clone();
        if let Some(app) = app {
            let _ = app.emit(
                "chat:task-progress",
                ChatTaskProgressPayload {
                    chat_session_id: sid.to_string(),
                    task_id: snap.task_id,
                    kind: snap.kind.clone(),
                    state: snap.state,
                    message: snap.message.clone(),
                    downloaded: snap.downloaded,
                    total: snap.total,
                    speed_bps: snap.speed_bps,
                    dest_path: snap.dest_path.clone(),
                },
            );
        }
    }

    /// Mark the task terminal and emit the final event.
    fn finish<R: tauri::Runtime>(
        app: Option<&AppHandle<R>>,
        sid: &str,
        entry: &TaskEntry,
        state: TaskState,
        message: String,
    ) {
        {
            let mut snap = entry.snapshot.lock();
            snap.state = state;
            snap.message = message;
            snap.speed_bps = 0;
        }
        Self::emit(app, sid, entry);
    }

    /// Current snapshot JSON for the model, or an error text if unknown.
    pub fn status_json(&self, task_id: &str) -> String {
        let tasks = self.tasks.lock();
        match tasks.get(task_id) {
            Some(e) => serde_json::to_string(&*e.snapshot.lock())
                .unwrap_or_else(|_| "{\"error\":\"serialize failed\"}".to_string()),
            None => format!(
                "No task \"{task_id}\". Tasks are only kept for an hour after they finish."
            ),
        }
    }

    /// Abort a running task (download: keeps the .part for resume; shell:
    /// kills the process). Returns a message for the model.
    pub fn cancel(&self, task_id: &str) -> String {
        let tasks = self.tasks.lock();
        match tasks.get(task_id) {
            Some(entry) => {
                if let Some(tx) = entry.cancel.lock().take() {
                    let _ = tx.send(());
                    format!("Cancelling task {task_id}…")
                } else {
                    let state = entry.snapshot.lock().state;
                    match state {
                        TaskState::Running => {
                            format!("Task {task_id} is already being cancelled.")
                        }
                        _ => format!(
                            "Task {task_id} already finished ({}).",
                            serde_json::to_string(&state).unwrap_or_default()
                        ),
                    }
                }
            }
            None => format!("No task \"{task_id}\"."),
        }
    }

    /// Start a background download. Returns the task id. `app` may be `None`
    /// in tests/headless runs (progress events are skipped).
    pub fn start_download<R: tauri::Runtime>(
        &self,
        app: Option<&AppHandle<R>>,
        sid: &str,
        url: &str,
        dest: &str,
    ) -> String {
        let (id, entry) = self.register("download");
        let (tx, rx) = oneshot::channel();
        *entry.cancel.lock() = Some(tx);
        let app = app.cloned();
        let sid = sid.to_string();
        let url = url.to_string();
        let dest = dest.to_string();
        let entry_for_task = Arc::clone(&entry);
        tauri::async_runtime::spawn(async move {
            let result = download_task(app.as_ref(), &sid, &entry_for_task, rx, &url, &dest).await;
            if let Err(msg) = result {
                let state = entry_for_task.snapshot.lock().state;
                if state == TaskState::Running {
                    TaskManager::finish(app.as_ref(), &sid, &entry_for_task, TaskState::Failed, msg);
                }
            }
        });
        id
    }

    /// Start a native shell command in the background. Returns the task id.
    /// `timeout_secs` = `Some` marks it Temporary (auto-killed at the clamped
    /// deadline); `None` is the Long-running class — no engine deadline,
    /// cleaned up via `cancel_task`/app exit. `app` may be `None` in
    /// tests/headless runs (progress events skipped).
    pub fn start_shell<R: tauri::Runtime>(
        &self,
        app: Option<&AppHandle<R>>,
        sid: &str,
        command: &str,
        workdir: Option<&str>,
        timeout_secs: Option<u64>,
    ) -> String {
        let (id, entry) = self.register("shell");
        let (tx, rx) = oneshot::channel();
        *entry.cancel.lock() = Some(tx);
        let app = app.cloned();
        let sid = sid.to_string();
        let command = command.to_string();
        let workdir = workdir.map(|s| s.to_string());
        let timeout = background_shell_timeout(timeout_secs);
        let entry_for_task = Arc::clone(&entry);
        tauri::async_runtime::spawn(async move {
            shell_task(app.as_ref(), &sid, &entry_for_task, rx, &command, workdir, timeout).await;
        });
        id
    }
}

/// Synchronous shell execution: runs the command to completion and returns
/// its combined stdout+stderr as a string. Used by the built-in provider path
/// so the tool result (and therefore the captured output) flows into the turn
/// buffer and persists in the stored message. Bounded by `timeout` (see the
/// foreground lifecycle rules — a command that never exits is killed and the
/// partial output is returned with a timeout notice pointing at the
/// background class). Use [`TaskManager::start_shell`] for work that may
/// outlive the ceiling.
pub fn run_shell_to_completion(
    command: &str,
    workdir: Option<&str>,
    timeout: std::time::Duration,
) -> String {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/C").arg(command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(wd) = workdir {
        if std::path::Path::new(wd).is_dir() {
            cmd.current_dir(wd);
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("could not start shell: {e}"),
    };
    // Drain both pipes on threads BEFORE waiting: reading only after exit
    // deadlocks once output exceeds the OS pipe buffer (~64 KB), and a
    // deadline-based wait makes the old wait_with_output unusable anyway.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(p) = stdout_pipe.as_mut() {
            use std::io::Read;
            let _ = p.read_to_string(&mut buf);
        }
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(p) = stderr_pipe.as_mut() {
            use std::io::Read;
            let _ = p.read_to_string(&mut buf);
        }
        buf
    });
    // Bounded wait: poll try_wait until the child exits or the ceiling hits.
    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return format!("could not wait for shell: {e}"),
        }
    }
    let mut out = out_thread.join().unwrap_or_default();
    let err = err_thread.join().unwrap_or_default();
    if !err.is_empty() {
        out.push('\n');
        out.push_str(&err);
    }
    if timed_out {
        // Say WHY the output ends here and HOW to do it right next time, so
        // the model doesn't treat a killed command's partial output as
        // success and doesn't retry the same blocking form.
        out.push_str(&format!(
            "\n[run_shell timed out after {}s and was killed — the foreground \
             ceiling is {}s. For work that runs longer, re-run with \
             background=true and poll get_task_status; for work that must \
             self-terminate, pass timeout_secs.]",
            timeout.as_secs(),
            SHELL_FOREGROUND_TIMEOUT_SECS
        ));
    }
    // Tail-cap: keep last 60 lines / 8 KB.
    const MAX_LINES: usize = 60;
    const MAX_BYTES: usize = 8_000;
    let lines: Vec<&str> = out.lines().collect();
    let mut t = if lines.len() > MAX_LINES {
        let dropped = lines.len() - MAX_LINES;
        format!("… [{} earlier lines truncated]\n{}", dropped, lines[lines.len()-MAX_LINES..].join("\n"))
    } else {
        out
    };
    if t.len() > MAX_BYTES {
        // Char-safe tail cap: shell output is routinely non-ASCII (git author
        // names, localized tools) — a byte slice here panics mid-turn.
        t = format!("…\n{}", crate::util::tail_chars(&t, MAX_BYTES));
    }
    t
}

/// Emit a `chat:plan-step-progress` event for the frontend to match against
/// parsed PlanStep items. Separate from the TaskManager emit (which is for
/// download/shell progress) — this is a lightweight signal, no throttling.
pub fn emit_plan_step_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sid: &str,
    step_label: &str,
    status: &str,
    detail: Option<&str>,
    tool_call: Option<&str>,
) {
    let _ = app.emit(
        "chat:plan-step-progress",
        crate::types::PlanStepProgressPayload {
            chat_session_id: sid.to_string(),
            step_label: step_label.to_string(),
            status: status.to_string(),
            detail: detail.map(|s| s.to_string()),
            tool_call: tool_call.map(|s| s.to_string()),
        },
    );
}

/// Escape hatch for the SSRF guard in `download_task`: when
/// `RELAY_ALLOW_PRIVATE_DOWNLOADS` is set in the APP's environment, the
/// download task may reach loopback/private hosts. Two legitimate uses: LAN
/// model mirrors (a real deployment pattern for local models) and the unit
/// tests' loopback fixture server. Read from the app's OWN env at request
/// time — untrusted child processes (agent harnesses, shells) cannot set it.
fn private_downloads_allowed() -> bool {
    std::env::var_os("RELAY_ALLOW_PRIVATE_DOWNLOADS").is_some()
}

/// Stream a download to `dest` with resume + retry. Writes chunks straight
/// to a `.part` file (no whole-file buffering) and renames on completion;
/// the `.part` is kept on cancel/failure so the next attempt resumes.
async fn download_task<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    entry: &TaskEntry,
    mut cancel_rx: oneshot::Receiver<()>,
    url: &str,
    dest: &str,
) -> Result<(), String> {
    let dest_path = PathBuf::from(dest);
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("download_file requires an http(s) URL, got \"{url}\""));
    }
    if !dest_path.is_absolute() {
        return Err(format!(
            "download_file requires an absolute destination path, got \"{dest}\""
        ));
    }
    // SSRF guard: refuse hosts that resolve to loopback / link-local / private
    // / multicast / reserved ranges. Mirrors `fetch_url`'s guard so the model
    // can't use download_file to read cloud metadata or probe internal hosts.
    // Bypassed only by the explicit app-env opt-out (LAN mirrors, tests).
    if !private_downloads_allowed() {
        if let Ok(parsed) = url::Url::parse(url) {
            if let Some(host) = parsed.host_str() {
                if crate::chat::tools::host_blocked(host) {
                    return Err(format!(
                        "download_file refused: `{host}` resolves to a loopback, \
                         link-local, private, or otherwise blocked address range \
                         (SSRF guard)."
                    ));
                }
            }
        }
    }
    let parent = dest_path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("could not create destination directory {parent:?}: {e}"))?;
    let partial_path = dest_path.with_extension(
        dest_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}.part"))
            .unwrap_or_else(|| "part".to_string()),
    );
    let client = reqwest::Client::builder()
        .user_agent(concat!("Relay/", env!("CARGO_PKG_VERSION"), " (desktop; +https://conduit.app)"))
        // NO blanket .timeout() here: reqwest's request timeout covers the
        // whole body stream, so any download slower than size/timeout can
        // never finish (multi-GB model weights). Bound connection setup only,
        // and detect stalls per-chunk in the read loop below.
        .connect_timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default();

    // If the destination already exists, consider it done.
    if tokio::fs::metadata(&dest_path).await.is_ok() {
        {
            let mut snap = entry.snapshot.lock();
            snap.downloaded = 0;
            snap.total = None;
            snap.dest_path = Some(dest.to_string());
        }
        TaskManager::finish(
            app,
            sid,
            entry,
            TaskState::Completed,
            format!("Already present at {dest} — nothing to download."),
        );
        return Ok(());
    }

    // Resume: start from the .part file's current size.
    let mut resume_from = tokio::fs::metadata(&partial_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let mut last_error = String::new();

    for attempt in 0..=DOWNLOAD_RETRIES {
        if attempt > 0 {
            sleep(Duration::from_millis(400 * (1 << attempt))).await;
            // Cancelled while backing off? Bail.
            if cancel_rx.try_recv().is_ok() {
                let _ = cancel_rx; // consume the channel
                {
                    let mut snap = entry.snapshot.lock();
                    snap.state = TaskState::Cancelled;
                    snap.speed_bps = 0;
                    snap.message = format!(
                        "Cancelled at {} — the .part file was kept for resume.",
                        human_bytes(resume_from)
                    );
                }
                TaskManager::emit(app, sid, entry);
                return Ok(());
            }
        }
        let mut req = client.get(url);
        if resume_from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("request failed: {e}");
                continue;
            }
        };
        // DNS-rebinding guard: re-verify the resolved peer IP after the
        // TCP connection has been opened.
        if !private_downloads_allowed() {
            if let Some(peer) = resp.remote_addr() {
                if crate::chat::tools::is_blocked_ip(&peer.ip()) {
                    return Err(format!(
                        "download_file refused: peer {} is in a blocked address range \
                         (DNS-rebinding guard).",
                        peer.ip()
                    ));
                }
            }
        }
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "HTTP {status} — this file is likely gated; open it on huggingface.co to accept \
                 the license, or set a Hugging Face access token in Settings → Local Models."
            ));
        }
        if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            last_error = format!("HTTP {status}");
            continue;
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }

        let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0;
        let start = if resuming { resume_from } else { 0 };
        let mut file = if resuming {
            let mut opts = tokio::fs::OpenOptions::new();
            opts.append(true).open(&partial_path).await
        } else {
            tokio::fs::File::create(&partial_path).await
        }
        .map_err(|e| format!("could not open .part file: {e}"))?;

        // Cumulative total (resumed downloads add the existing prefix).
        let total = if resuming {
            resp.content_length().map(|c| c + start)
        } else {
            resp.content_length()
        };
        {
            let mut snap = entry.snapshot.lock();
            snap.downloaded = start;
            snap.total = total;
            snap.dest_path = Some(dest.to_string());
            snap.message = if resuming {
                format!("Resuming from {} bytes…", human_bytes(start))
            } else {
                "Downloading…".to_string()
            };
        }
        TaskManager::emit(app, sid, entry);

        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = start;
        let mut speed: u64;
        let mut last_emit = Instant::now() - PROGRESS_EMIT_MIN;
        let mut last_downloaded = start;
        let mut stream_failed: Option<String> = None;

        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    // User cancelled: keep the .part for a future resume,
                    // mark the task cancelled, and stop.
                    drop(file);
                    {
                        let mut snap = entry.snapshot.lock();
                        snap.state = TaskState::Cancelled;
                        snap.speed_bps = 0;
                        snap.message = format!(
                            "Cancelled at {} — the .part file was kept for resume.",
                            human_bytes(downloaded)
                        );
                    }
                    TaskManager::emit(app, sid, entry);
                    return Ok(());
                }
                next = tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, stream.next()) => {
                    match next {
                        Err(_elapsed) => {
                            // No bytes for DOWNLOAD_STALL_TIMEOUT — the peer
                            // is hung. Treat like a stream error: keep the
                            // .part and resume on the next attempt.
                            stream_failed = Some(format!(
                                "stalled (no data for {}s)",
                                DOWNLOAD_STALL_TIMEOUT.as_secs()
                            ));
                            break;
                        }
                        Ok(Some(Ok(chunk))) => {
                            if chunk.is_empty() { continue; }
                            if let Err(e) = file.write_all(&chunk).await {
                                return Err(format!("write error: {e}"));
                            }
                            downloaded = downloaded.saturating_add(chunk.len() as u64);
                            if last_emit.elapsed() >= PROGRESS_EMIT_MIN {
                                let dt = last_emit.elapsed().as_secs_f64().max(0.001);
                                speed = ((downloaded - last_downloaded) as f64 / dt) as u64;
                                last_downloaded = downloaded;
                                last_emit = Instant::now();
                                {
                                    let mut snap = entry.snapshot.lock();
                                    snap.downloaded = downloaded;
                                    snap.speed_bps = speed;
                                    snap.total = total;
                                }
                                TaskManager::emit(app, sid, entry);
                            }
                        }
                        Ok(Some(Err(e))) => {
                            stream_failed = Some(format!("stream error: {e}"));
                            break;
                        }
                        Ok(None) => break,
                    }
                }
            }
        }

        // A mid-stream failure keeps the .part and retries from where it
        // stopped (Range resume); a clean EOF finishes the download.
        if let Some(msg) = stream_failed {
            last_error = msg;
            resume_from = downloaded;
            continue;
        }

        file.flush().await.map_err(|e| format!("flush: {e}"))?;
        drop(file);
        tokio::fs::rename(&partial_path, &dest_path)
            .await
            .map_err(|e| format!("rename to final path failed: {e}"))?;
        {
            let mut snap = entry.snapshot.lock();
            snap.downloaded = total.unwrap_or(downloaded);
            snap.total = total;
            snap.speed_bps = 0;
            snap.dest_path = Some(dest.to_string());
        }
        // Surface the download in the Artifacts gallery when the extension
        // is previewable (docs, images, data files) — the built-in chat has
        // no dir-watch, so this is the only chance to record it. Model
        // weights / archives and other non-previewable downloads stay out.
        record_download_artifact(app, sid, &dest_path);
        TaskManager::finish(
            app,
            sid,
            entry,
            TaskState::Completed,
            format!("Downloaded to {dest} ({})", human_bytes(total.unwrap_or(downloaded))),
        );
        return Ok(());
    }
    Err(format!(
        "download failed after {} attempts: {last_error}",
        DOWNLOAD_RETRIES + 1
    ))
}

/// Record a completed download in the Artifacts gallery (30-day retention)
/// and push the `chat:artifact` event — what the harness turn's dir-watch
/// does for files its CLIs write, applied to the one file this tool
/// produces. Previewable extensions only: model weights / archives aren't
/// gallery material. Best-effort — a DB or emit failure must not fail the
/// (already successful) download. `None` app (tests / headless) skips.
fn record_download_artifact<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    dest: &Path,
) {
    use tauri::Manager;
    let Some(app) = app else { return };
    if !crate::agent_sessions::previewable_ext(&dest.to_string_lossy()) {
        return;
    }
    let Some(filename) = dest.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return;
    };
    let db = app.state::<crate::DbState>();
    let kind = dest
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let path = dest.to_string_lossy().to_string();
    let conn = db.0.lock();
    let _ = crate::db::insert_artifact(&conn, Some(sid), &filename, &path, &kind);
    let _ = app.emit(
        "chat:artifact",
        crate::types::ChatArtifactPayload {
            chat_session_id: sid.to_string(),
            path,
            filename,
        },
    );
}

/// Run a native shell command, streaming output lines as progress events.
/// No sandbox. `timeout` = `Some` marks the task Temporary — the child is
/// killed at the deadline and the task finishes Failed with a timeout notice;
/// `None` is the Long-running class (no wall-clock limit — cancel_task or app
/// exit ends it).
async fn shell_task<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    entry: &TaskEntry,
    mut cancel_rx: oneshot::Receiver<()>,
    command: &str,
    workdir: Option<String>,
    timeout: Option<Duration>,
) {
    // Strip any NUL bytes — they terminate C strings early and could otherwise
    // smuggle extra bytes past the shell interface (defense-in-depth; the model
    // should not emit NULs, but we never trust tool input blindly).
    let command = command.replace('\0', "");
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(&command);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&command);
        c
    };
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(wd) = workdir {
        if Path::new(&wd).is_dir() {
            cmd.current_dir(&wd);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            TaskManager::finish(
                app,
                sid,
                entry,
                TaskState::Failed,
                format!("could not start shell: {e}"),
            );
            return;
        }
    };

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    // mi6: VecDeque — the 40-line cap previously did Vec::remove(0) (O(n)
    // memmove) per line past the cap.
    let mut output: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut last_emit = Instant::now() - SHELL_EMIT_MIN;

    let mut consume_line =
        |line: String,
         last_emit: &mut Instant,
         app: Option<&AppHandle<R>>,
         sid: &str,
         entry: &TaskEntry| {
            if output.len() >= 40 {
                output.pop_front();
            }
            output.push_back(line);
            if last_emit.elapsed() >= SHELL_EMIT_MIN {
                {
                    let mut snap = entry.snapshot.lock();
                    let joined = output.iter().cloned().collect::<Vec<_>>().join("\n");
                    snap.message = joined.chars().take(SHELL_OUTPUT_CAP).collect();
                }
                TaskManager::emit(app, sid, entry);
                *last_emit = Instant::now();
            }
        };

    let mut stdout_open = true;
    let mut stderr_open = true;
    // Temporary-class deadline: resolves once at expiry, or never for the
    // Long-running class (`None` → pending forever).
    let deadline_fut = async {
        match timeout {
            Some(t) => sleep(t).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(deadline_fut);
    loop {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                {
                    let mut snap = entry.snapshot.lock();
                    snap.state = TaskState::Cancelled;
                    snap.speed_bps = 0;
                    snap.message = "Cancelled — process killed.".to_string();
                }
                TaskManager::emit(app, sid, entry);
                return;
            }
            _ = &mut deadline_fut => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let secs = timeout.map(|t| t.as_secs()).unwrap_or(0);
                let tail = {
                    let snap = entry.snapshot.lock();
                    snap.message.clone()
                };
                TaskManager::finish(
                    app,
                    sid,
                    entry,
                    TaskState::Failed,
                    format!(
                        "Timed out after {secs}s and was killed (temporary process: \
                         timeout_secs elapsed). Re-run with a longer timeout_secs, \
                         or with background=true (no timeout) if it is meant to be \
                         long-running.\n\n{tail}"
                    ),
                );
                return;
            }
            next = stdout_lines.next_line(), if stdout_open => {
                match next {
                    Ok(Some(line)) => consume_line(line, &mut last_emit, app, sid, entry),
                    _ => stdout_open = false,
                }
            }
            next = stderr_lines.next_line(), if stderr_open => {
                match next {
                    Ok(Some(line)) => consume_line(line, &mut last_emit, app, sid, entry),
                    _ => stderr_open = false,
                }
            }
            status = child.wait() => {
                let code = status.map(|s| s.code()).unwrap_or(None);
                let msg = {
                    let mut snap = entry.snapshot.lock();
                    let joined = output.iter().cloned().collect::<Vec<_>>().join("\n");
                    snap.message = joined.chars().take(SHELL_OUTPUT_CAP).collect();
                    match code {
                        Some(0) => format!("Command finished (exit 0).\n\n{}", snap.message),
                        Some(c) => format!("Command finished with exit code {c}.\n\n{}", snap.message),
                        None => format!("Command was terminated.\n\n{}", snap.message),
                    }
                };
                TaskManager::finish(app, sid, entry, TaskState::Completed, msg);
                return;
            }
        }
    }
}

/// Compact human byte formatting ("1.2 GB") for task messages.
fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_formats() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(2048), "2.0 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(human_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    #[test]
    fn percent_calculation() {
        let mut s = TaskSnapshot {
            task_id: "t".into(),
            kind: "download".into(),
            state: TaskState::Running,
            message: String::new(),
            downloaded: 50,
            total: Some(200),
            speed_bps: 1000,
            dest_path: None,
        };
        assert_eq!(s.percent(), Some(25.0));
        s.total = Some(0);
        assert_eq!(s.percent(), Some(0.0));
        s.total = None;
        assert_eq!(s.percent(), None);
    }

    #[test]
    fn register_allocates_unique_ids() {
        let tm = TaskManager::new();
        let (id1, e1) = tm.register("download");
        let (id2, _) = tm.register("shell");
        assert_ne!(id1, id2);
        assert_eq!(e1.snapshot.lock().kind, "download");
        assert_eq!(e1.snapshot.lock().state, TaskState::Running);
    }

    #[test]
    fn status_unknown_task_reports_missing() {
        let tm = TaskManager::new();
        assert!(tm.status_json("task-999").contains("No task"));
    }

    // ---- integration: local HTTP server + mock app ----

    /// Tiny HTTP server serving `body` with optional Range support, on a
    /// loopback port. Returns the base URL. `chunk_delay` throttles the
    /// stream (64KiB chunks) so tests can keep a download in flight.
    async fn serve(body: &'static [u8], support_range: bool, chunk_delay: Duration) -> String {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tauri::async_runtime::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let body = body.to_vec();
                let support_range = support_range;
                let chunk_delay = chunk_delay;
                tauri::async_runtime::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let req = String::from_utf8_lossy(&buf);
                    let range = req
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .and_then(|l| l.split('=').nth(1))
                        .and_then(|v| v.trim().strip_suffix('-'))
                        .and_then(|v| v.parse::<usize>().ok());
                    let start = if support_range { range.unwrap_or(0) } else { 0 };
                    let chunk = &body[start.min(body.len())..];
                    let status = if start > 0 && support_range {
                        "206 Partial Content"
                    } else {
                        "200 OK"
                    };
                    let extra = if start > 0 && support_range {
                        format!("Content-Range: bytes {}-{}/{}\r\n", start, body.len() - 1, body.len())
                    } else {
                        String::new()
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{extra}\r\n",
                        chunk.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let mut sent = 0usize;
                    while sent < chunk.len() {
                        let end = (sent + 64 * 1024).min(chunk.len());
                        let _ = sock.write_all(&chunk[sent..end]).await;
                        sent = end;
                        if !chunk_delay.is_zero() {
                            tokio::time::sleep(chunk_delay).await;
                        }
                    }
                });
            }
        });
        format!("http://127.0.0.1:{port}/file.bin")
    }

    #[test]
    fn download_streams_to_disk_with_progress() {
        // The fixture serves on 127.0.0.1, which the SSRF guard refuses —
        // opt out for tests (process-global, idempotent).
        std::env::set_var("RELAY_ALLOW_PRIVATE_DOWNLOADS", "1");
        let body: &'static [u8] = &[0u8; 1024 * 1024 * 2];
        let url = tauri::async_runtime::block_on(serve(body, true, Duration::ZERO));
        
        let tm = TaskManager::new();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.safetensors");
        let id = tm.start_download(None::<&tauri::AppHandle>, "sid1", &url, dest.to_str().unwrap());
        // Poll until terminal (2 MB over loopback is near-instant).
        let mut final_state = String::new();
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let snap = tm.status_json(&id);
            if snap.contains("completed") || snap.contains("failed") {
                final_state = snap;
                break;
            }
        }
        assert!(
            final_state.contains("completed"),
            "expected completion, got: {final_state}"
        );
        let meta = std::fs::metadata(&dest).expect("dest file must exist");
        assert_eq!(meta.len(), 1024 * 1024 * 2);
        assert!(!dest.with_extension("safetensors.part").exists(), ".part must be renamed away");
    }

    #[test]
    fn download_resumes_from_existing_part() {
        std::env::set_var("RELAY_ALLOW_PRIVATE_DOWNLOADS", "1");
        let body: &'static [u8] = &[7u8; 1024 * 1024];
        let url = tauri::async_runtime::block_on(serve(body, true, Duration::ZERO));
        
        let tm = TaskManager::new();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("big.bin");
        // Pre-seed the .part with the first 512KB.
        let part = dest.with_extension("bin.part");
        std::fs::write(&part, &[7u8; 512 * 1024]).unwrap();
        let id = tm.start_download(None::<&tauri::AppHandle>, "sid1", &url, dest.to_str().unwrap());
        let mut final_state = String::new();
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let snap = tm.status_json(&id);
            if snap.contains("completed") || snap.contains("failed") {
                final_state = snap;
                break;
            }
        }
        assert!(
            final_state.contains("completed"),
            "resume should complete, got: {final_state}"
        );
        let meta = std::fs::metadata(&dest).expect("dest file must exist");
        assert_eq!(meta.len(), 1024 * 1024, "resumed file must be full size");
    }

    #[test]
    fn cancel_keeps_part_file_for_resume() {
        std::env::set_var("RELAY_ALLOW_PRIVATE_DOWNLOADS", "1");
        // 64KiB chunks at 5ms each ≈ 5s of streaming — guaranteed still
        // in flight when the test cancels.
        let body: &'static [u8] = &[0u8; 1024 * 1024 * 64];
        let url = tauri::async_runtime::block_on(serve(body, true, Duration::from_millis(5)));
        
        let tm = TaskManager::new();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("slow.bin");
        let id = tm.start_download(None::<&tauri::AppHandle>, "sid1", &url, dest.to_str().unwrap());
        // Give it a moment to start, then cancel.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let cancel_msg = tm.cancel(&id);
        assert!(cancel_msg.contains("Cancelling"), "got: {cancel_msg}");
        let mut final_state = String::new();
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let snap = tm.status_json(&id);
            if snap.contains("cancelled") || snap.contains("failed") {
                final_state = snap;
                break;
            }
        }
        assert!(
            final_state.contains("cancelled"),
            "expected cancelled, got: {final_state}"
        );
        // The .part survives for resume; the final file never lands.
        assert!(!dest.exists(), "dest must NOT exist after cancel");
    }

    #[test]
    fn shell_captures_output_and_exit_code() {

        let tm = TaskManager::new();
        let cmd = if cfg!(windows) { "echo relay-shell-test" } else { "echo relay-shell-test" };
        let id = tm.start_shell(None::<&tauri::AppHandle>, "sid1", cmd, None, None);
        let mut final_state = String::new();
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let snap = tm.status_json(&id);
            if snap.contains("completed") || snap.contains("failed") || snap.contains("cancelled") {
                final_state = snap;
                break;
            }
        }
        assert!(final_state.contains("completed"), "got: {final_state}");
        assert!(final_state.contains("relay-shell-test"), "output must be captured: {final_state}");
        assert!(final_state.contains("exit 0"), "exit code must be reported: {final_state}");
    }

    #[test]
    fn foreground_timeout_clamps_only_downward() {
        // Default → the ceiling; explicit values shorten; anything above the
        // ceiling or below the floor is clamped (the foreground may never run
        // longer than SHELL_FOREGROUND_TIMEOUT_SECS, even on request).
        assert_eq!(
            foreground_shell_timeout(None),
            Duration::from_secs(SHELL_FOREGROUND_TIMEOUT_SECS)
        );
        assert_eq!(foreground_shell_timeout(Some(10)), Duration::from_secs(10));
        assert_eq!(
            foreground_shell_timeout(Some(5_000)),
            Duration::from_secs(SHELL_FOREGROUND_TIMEOUT_SECS)
        );
        assert_eq!(foreground_shell_timeout(Some(0)), Duration::from_secs(SHELL_TEMPORARY_MIN_SECS));
    }

    #[test]
    fn background_timeout_maps_none_to_long_running() {
        // None = Long-running class (no engine deadline).
        assert_eq!(background_shell_timeout(None), None);
        assert_eq!(
            background_shell_timeout(Some(30)),
            Some(Duration::from_secs(30))
        );
        // Clamped into the Temporary window (5s..1h).
        assert_eq!(
            background_shell_timeout(Some(86_400)),
            Some(Duration::from_secs(SHELL_TEMPORARY_MAX_SECS))
        );
        assert_eq!(
            background_shell_timeout(Some(0)),
            Some(Duration::from_secs(SHELL_TEMPORARY_MIN_SECS))
        );
    }

    #[test]
    fn background_shell_times_out_and_reports_temporary_class() {
        // A `sleep 30` / `ping -n 30` under a 1s Temporary deadline must be
        // killed by the engine (not left running) and finish Failed with the
        // timeout notice.
        let tm = TaskManager::new();
        let cmd = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };
        let id = tm.start_shell(None::<&tauri::AppHandle>, "sid1", cmd, None, Some(1));
        let mut final_state = String::new();
        for _ in 0..200 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let snap = tm.status_json(&id);
            if snap.contains("completed") || snap.contains("failed") || snap.contains("cancelled") {
                final_state = snap;
                break;
            }
        }
        assert!(final_state.contains("failed"), "expected timeout failure, got: {final_state}");
        assert!(final_state.contains("Timed out"), "must say WHY it died: {final_state}");
    }

    #[test]
    fn foreground_run_times_out_within_ceiling() {
        // Direct runner: a never-ending command under a 1s timeout returns
        // (with the timeout notice) instead of blocking for 30s.
        let cmd = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };
        let out = run_shell_to_completion(cmd, None, Duration::from_secs(1));
        assert!(out.contains("timed out"), "must carry the timeout notice: {out}");
    }
}

