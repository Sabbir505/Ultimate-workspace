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
