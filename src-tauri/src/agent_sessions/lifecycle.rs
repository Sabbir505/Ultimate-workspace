//! one-shot child registry + guards, reader-alive guard, and CLI session-id persistence — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;

pub(super) static ONE_SHOT_CHILDREN: Mutex<BTreeMap<u32, Arc<Mutex<Child>>>> = Mutex::new(BTreeMap::new());

pub(super) fn register_one_shot_child(child: &Arc<Mutex<Child>>) -> Option<u32> {
    let pid = child.lock().ok()?.id();
    ONE_SHOT_CHILDREN
        .lock()
        .ok()?
        .insert(pid, Arc::clone(child));
    Some(pid)
}

pub(super) fn unregister_one_shot_child(pid: u32) {
    if let Ok(mut map) = ONE_SHOT_CHILDREN.lock() {
        map.remove(&pid);
    }
}

/// M2 (Round 3): RAII counterpart to `register_one_shot_child`. `run_one_shot`
/// used to unregister at exactly ONE success point, so any early `?` (stdout
/// lock, missing stdout pipe) or unwind between registration and reap leaked
/// the map entry — the Arc pinned the child's OS handle for the app's
/// lifetime and the exit-handler kill map grew monotonically. Holding the
/// pid in this guard makes every exit path unregister.
pub(super) struct OneShotGuard(pub(super) Option<u32>);

impl Drop for OneShotGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            unregister_one_shot_child(pid);
        }
    }
}

/// Kill every registered one-shot child (app shutdown). Idempotent; children
/// that already exited are skipped — their pid may have been recycled, and
/// `try_wait` is the only safe way to know the handle is still ours.
pub fn kill_one_shot_children() {
    let drained: Vec<Arc<Mutex<Child>>> = match ONE_SHOT_CHILDREN.lock() {
        Ok(mut map) => std::mem::take(&mut *map).into_values().collect(),
        Err(_) => return,
    };
    for child in drained {
        if let Ok(mut guard) = child.lock() {
            let already_exited = matches!(guard.try_wait(), Ok(Some(_)) | Err(_));
            if !already_exited {
                kill_child_tree(&mut guard);
            }
        }
    }
}

/// Kill a spawned harness process AND its whole process tree. On Windows
/// every spawn is wrapped in `cmd.exe /C` (harness_adapters::resolve_for_spawn),
/// so the `Child` handle is the shell: `Child::kill()` terminates only
/// cmd.exe while the real CLI (the node.exe grandchild) survives, keeps the
/// stdout pipe open, and the turn visibly keeps running after cancel.
/// Kill the process tree. On Windows `taskkill /T /F` is the primary kill;
/// `child.kill()` + `child.wait()` is the fallback that always reaps the
/// direct handle. The stdio pipes are dropped here too (stdin/stdout/stderr
/// live on `Child`), which unblocks the reader thread so it can observe the
/// `cancelled` flag and exit without emitting a spurious `chat:done`.
pub(crate) fn kill_child_tree(child: &mut Child) {
    // A child that already exited needs no `taskkill`. Two reasons to check
    // first, exactly as `kill_one_shot_children` does: (1) the PID lookup for
    // an exited process fails, so taskkill writes `ERROR: The process "N" not
    // found.` to OUR inherited stderr — every harness teardown that followed a
    // natural exit (the common case: the CLI finished its turn, then the
    // session is dropped) used to print that into the app's console; (2) the
    // handle is what identifies our child, and only a live handle rules out a
    // recycled PID, so a tree kill on a stale pid is the one way this can hit
    // a process that is no longer ours.
    let already_exited = matches!(child.try_wait(), Ok(Some(_)) | Err(_));
    #[cfg(windows)]
    {
        if !already_exited {
            // Kill the entire process tree first so no grandchildren survive.
            let pid = child.id();
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", pid.to_string().as_str(), "/T", "/F"]);
            no_console_window(&mut cmd);
            // Best-effort — a failure here (access denied, tree gone between
            // the check and the call) still ends in the direct kill below.
            let _ = cmd.status();
        }
    }
    // Kill the direct child (belt) and wait for it to be reaped (suspenders).
    // On non-Windows this is the only kill; on Windows it cleans up if
    // taskkill failed or the child was already a zombie. `kill()` acts on the
    // handle (never a pid), so it is safe for an exited child.
    let _ = child.kill();
    let _ = child.wait();
    // Explicitly take stdin so the reader thread's BufReader::lines() loop
    // ends when the stdout pipe closes — without this a stale stdin
    // reference can keep the pipe alive on some platforms.
    drop(child.stdin.take());
}

/// Assign a freshly-spawned harness child to a Windows Job Object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — the kernel-level backstop for
/// `kill_all`'s exit sweep. The sweep only runs when OUR exit path runs; if
/// relay.exe dies any other way (crash, taskkill on relay itself, power
/// loss, a wedged shutdown), the `cmd.exe /C`-wrapped CLI trees survived as
/// orphans. With the job assigned, the OS closes our job handle at process
/// death — and closing the last job handle IS the kill, for the whole tree.
///
/// Returns the raw job handle so tests can close it and observe the kill;
/// the spawn path deliberately never closes it (see `spawn_harness_child`).
/// `None` = assignment failed: usually the child already exited (lost the
/// race between spawn and assign — ERROR_ACCESS_DENIED) or it inherited an
/// unbreakable job of its own. Both are non-fatal; the normal exit sweep
/// still covers them.
#[cfg(windows)]
pub(super) fn assign_kill_on_close_job(
    child: &Child,
) -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return None;
        }
        if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
            CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

#[cfg(not(windows))]
pub(super) fn assign_kill_on_close_job(_child: &Child) -> Option<()> {
    None
}

/// Spawn a harness CLI process AND fold it into the crash-proof job-object
/// net (Windows). Every `entry.child` spawn goes through this so no CLI
/// tree can outlive relay.exe by any death path. The job handle is
/// intentionally left open for the child's lifetime — closing it early
/// would kill the turn; the OS reaps it (and the tree with it) whenever
/// relay.exe exits, cleanly or not.
pub(super) fn spawn_harness_child(cmd: &mut Command) -> std::io::Result<Child> {
    let child = cmd.spawn()?;
    let _job = assign_kill_on_close_job(&child);
    Ok(child)
}

/// Shared stderr-drain pump (L15): reads a spawned CLI's stderr to EOF on its
/// own thread and hands the collected text to the caller through the channel.
/// Consumers keep the text in the receiver and only `recv_timeout` it on the
/// error paths — the pipe closes at process exit, so a recv there never waits
/// long. One helper instead of four copy-pasted spawn sites (claude /
/// opencode server / per-turn CLIs / one-shot).
pub(super) fn drain_stderr(stderr: std::process::ChildStderr) -> std::sync::mpsc::Receiver<String> {
    let (etx, erx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let mut stderr = stderr;
        use std::io::Read as _;
        let _ = stderr.read_to_string(&mut buf);
        let _ = etx.send(buf);
    });
    erx
}

/// RAII guard for a reader thread's liveness (B-4/B-5): drops
/// `reader_alive` to `false` on EVERY exit path from the reader — EOF, an
/// early `return` (mid-handshake failures), or a panic unwinding through
/// the thread body. `send_claude_turn`/`send_acp_turn` respawn when the
/// flag is down; scattering `.store(false)` at each return site would miss
/// the panic path and permanently wedge the chat.
pub(super) struct ReaderAliveGuard(pub(super) Arc<AtomicBool>);

impl Drop for ReaderAliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Crash-flush for the live turn's partial reply (shared by the harness
/// readers).
///
/// A reader accumulates the assistant text in a thread-local `String` and
/// `finish_turn` persists it only at EOF — so an app crash (or a killed
/// process tree) mid-turn lost every streamed token while the user message
/// (persisted up front) survived. Reopening the chat then showed a bare user
/// bubble above nothing. The flush writes the accumulated text into a partial
/// assistant row every few seconds instead; the graceful end of the turn
/// discards the row right before `finish_turn`'s real insert, and a crash
/// leaves the last flushed snapshot in the transcript — seconds stale at
/// worst instead of gone.
pub(super) struct PartialFlush {
    /// The partial row's id once created (None until the first flush).
    message_id: Option<i64>,
    /// Content length at the last flush — the cheap change detector.
    flushed_len: usize,
    /// Last flush timestamp (db `now_ts()` seconds).
    last_ts: i64,
}

impl PartialFlush {
    pub(super) fn new() -> Self {
        Self {
            message_id: None,
            flushed_len: 0,
            last_ts: 0,
        }
    }

    pub(super) fn maybe_flush(&mut self, db: &DbState, sid: &str, full: &str) {
        let now = crate::db::now_ts();
        if full.len() == self.flushed_len || now - self.last_ts < 3 {
            return;
        }
        self.last_ts = now;
        self.flushed_len = full.len();
        if full.trim().is_empty() {
            return;
        }
        let conn = db.0.lock();
        match self.message_id {
            None => {
                let record = crate::db::add_chat_message(
                    &conn,
                    crate::db::NewChatMessage::assistant(sid, full),
                );
                if let Ok(record) = record {
                    self.message_id = Some(record.id);
                }
            }
            Some(id) => {
                let _ = crate::db::update_chat_message_content(&conn, id, full);
            }
        }
    }

    /// Remove the partial row — the graceful end of the turn hands persistence
    /// over to `finish_turn`'s real insert (a cancel discards the reply
    /// entirely), and a duplicate would double-render the turn. Must also run
    /// on every turn boundary of a reader that outlives turns (claude), so a
    /// stale id never points at a previous turn's row.
    pub(super) fn discard(&mut self, db: &DbState) {
        if let Some(id) = self.message_id.take() {
            let conn = db.0.lock();
            let _ = crate::db::delete_chat_message(&conn, id);
        }
    }
}

/// E-5: a reader may only clear `turn_in_flight` while its process is still
/// the session's CURRENT generation. A respawned process runs with a new
/// generation, so an old reader's late EOF must leave the flag (it belongs
/// to a turn already streaming on the new process) alone.
pub(super) fn should_clear_in_flight(current_generation: u64, reader_generation: u64) -> bool {
    current_generation == reader_generation
}

/// DB key for the per-chat, per-harness CLI session id (kimi `--session`,
/// opencode `-s`, claude `--resume`). Harness-qualified so switching harness
/// on the same chat never resumes the wrong CLI's conversation.
pub(super) fn cli_session_key(harness: &str, sid: &str) -> String {
    format!("agent.cli_session_id.{harness}.{sid}")
}

/// Persist the captured CLI session id (if any) so conversation context
/// survives cancels and app restarts. Called by reader threads at end of
/// turn / process exit.
pub(super) fn persist_cli_session_id(
    db: &DbState,
    harness: &str,
    sid: &str,
    cell: &Arc<Mutex<Option<String>>>,
) {
    let id = cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = id {
        let conn = db.0.lock();
        let _ = crate::db::set_setting(&conn, &cli_session_key(harness, sid), &id);
    }
}

/// Working-folder change between sends: the CLI harnesses index their own
/// conversations under the spawn dir (claude/kimi store transcripts per
/// project folder), so an id captured under the PREVIOUS folder can't be
/// resumed from the new one — the spawn dies with "no session found to
/// resume" and burns a turn before the readers' zero-activity recovery
/// drops the id. Drop it up front (in-memory + persisted) so the turn takes
/// the context-primer path instead: a fresh CLI session inside the new
/// folder with the DB history replayed.
///
/// Compares only against a previous send in THIS process lifetime (`prev`
/// is the last send's workspace snapshot): after an app restart the stored
/// id was created under the same folder the send is about to use, so resume
/// still works and must not be dropped. Returns whether it dropped.
pub(super) fn drop_stale_cli_id_on_cwd_change(
    db: &DbState,
    harness: &str,
    sid: &str,
    cell: &Arc<Mutex<Option<String>>>,
    prev: Option<&SendCtx>,
    cwd: Option<&str>,
) -> bool {
    let Some(prev) = prev else {
        return false;
    };
    if prev.cwd.as_deref() == cwd {
        return false;
    }
    if let Ok(mut g) = cell.lock() {
        *g = None;
    }
    let conn = db.0.lock();
    let _ = crate::db::delete_setting(&conn, &cli_session_key(harness, sid));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The drain pump must deliver everything the child wrote to stderr once
    /// the pipe closes at process exit (the contract every harness spawn
    /// relies on for its error-path `recv_timeout` diagnosis tail).
    #[test]
    fn drain_stderr_collects_child_stderr_to_eof() {
        let mut cmd = Command::new(if cfg!(windows) { "cmd.exe" } else { "sh" });
        cmd.arg(if cfg!(windows) { "/C" } else { "-c" })
            .arg("echo boom 1>&2")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        no_console_window(&mut cmd);
        let mut child = cmd.spawn().expect("spawn probe process");
        let stderr = child.stderr.take().expect("stderr piped");
        let erx = drain_stderr(stderr);
        let _ = child.wait();
        let tail = erx
            .recv_timeout(Duration::from_secs(5))
            .expect("stderr tail delivered");
        assert!(tail.contains("boom"), "stderr tail: {tail}");
    }

    /// THE crash-proof contract: closing the job handle kills the assigned
    /// tree. relay.exe dying closes every handle it holds — so a job-assigned
    /// harness CLI can never outlive the app, even on a crash or taskkill
    /// where the exit-time `kill_all` sweep never runs. Probe with a ~8s
    /// sleeper and assert it dies well before its natural exit once the
    /// handle closes.
    #[test]
    #[cfg(windows)]
    fn closing_the_job_handle_kills_the_assigned_tree() {
        use std::time::Instant;

        use windows_sys::Win32::Foundation::CloseHandle;

        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "ping -n 8 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_console_window(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sleeper");

        let job = assign_kill_on_close_job(&child).expect("job assignment on a live child");
        // Still running while the handle is open (nothing else kills it).
        assert!(matches!(child.try_wait(), Ok(None)), "sleeper died early");

        // The spawn path never closes this handle — the TEST does, simulating
        // relay.exe's death. The kernel then kills the whole job.
        unsafe { CloseHandle(job) };

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break, // killed by the job-close, ~instantly
                Ok(None) => {
                    assert!(Instant::now() < deadline, "sleeper outlived the closed job");
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
    }

    /// Idempotence / dead-child tolerance: assigning an already-exited child
    /// must return None (ACCESS_DENIED on the dead handle) without panicking
    /// or leaking a half-configured job into the caller's control.
    #[test]
    #[cfg(windows)]
    fn assign_job_on_exited_child_is_none() {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "exit 0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        no_console_window(&mut cmd);
        let mut child = cmd.spawn().expect("spawn exiter");
        let _ = child.wait(); // fully reaped — no longer assignable
        // Either None (expected) or a race-tolerant Some on a recycled
        // assignment is acceptable; the contract is just "must not panic".
        let _ = assign_kill_on_close_job(&child);
    }
}
