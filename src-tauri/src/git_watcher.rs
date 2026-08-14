//! Filesystem watcher for git-tracked project directories.
//!
//! Why this exists (PERFORMANCE_AUDIT.md C4 follow-on): the previous design
//! polled `git status` every 4-8 s for every project. Even with N+1 fix
//! that only made the *per-tick* cost cheap — the tick still fired N times
//! a minute, every minute, even when nothing changed. For a developer
//! with 5+ registered projects that's ~5 unnecessary git invocations per
//! second forever, plus DB lock contention on `verify_project_path`.
//!
//! This module replaces that with a true event-driven path:
//!  - One `notify::RecommendedWatcher` per registered project path (plus
//!    every worktree path).
//!  - The OS (ReadDirectoryChangesW / inotify / FSEvents) feeds events
//!    into a per-watcher debouncer.
//!  - 300 ms after the last event, the watcher emits a single
//!    `project:fs-changed` Tauri event with the project id.
//!  - The frontend subscribes once and updates git status / branch list /
//!    diff panel in response — no interval loops left.
//!
//! The debounce is essential: a single `git checkout` generates dozens of
//! FS events (rename many files, modify .git/HEAD, etc.). Without debounce
//! the listener would fire dozens of git invocations per git op. 300 ms is
//! a sweet spot — fast enough that the UI feels live, slow enough that one
//! `git status` per op covers the burst.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::DbState;

/// How long the watcher waits after the last FS event before emitting the
/// Tauri event. Tunable: too short → bursty git invocations, too long →
/// stale UI. 300 ms is a deliberate middle ground.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(300);
/// Idle heartbeat: if no events have arrived in this long, the watcher
/// still wakes up to confirm the watcher is alive (catches a missed
/// subscription, dropped filesystem handle on Windows, etc.). 60 s is
/// cheap because the inner work is just a `recv_timeout` — no git call.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
/// Ceiling on a single debounce burst: sustained FS activity (build loops,
/// chatty logs) would otherwise keep extending the quiet window forever and
/// starve the `project:fs-changed` emit. 2 s guarantees progress while still
/// collapsing the typical burst to one event.
const MAX_BURST: Duration = Duration::from_secs(2);

/// Per-process state stored in Tauri's `State<WatcherState>`. We use
/// `parking_lot::Mutex` (not std) because the watcher's own background
/// thread takes it briefly, and parking_lot is already the project
/// convention.
pub struct WatcherState {
    /// Active watchers keyed by the absolute path they watch. Re-installing
    /// the same path is a no-op (the existing watcher keeps running).
    pub watchers: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// Install a watcher for `path` (a project root OR a worktree path) if
/// one isn't already active. Idempotent: re-calling with the same path
/// is a no-op. Returns Ok even on install failure — a missed watcher is
/// not fatal (the 8 s heartbeat in `refreshGitStatus` still keeps the
/// UI eventually-correct, just less responsive).
pub fn install(app: &AppHandle, db_state: &DbState, path: &Path) {
    // Canonicalize so the same physical path installed under two different
    // syntactic forms doesn't double-install.
    let canon = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return, // path doesn't exist — nothing to watch.
    };
    let state = app.state::<WatcherState>();
    let mut watchers = state.watchers.lock();
    if watchers.contains_key(&canon) {
        return;
    }
    // Channel from the notify callback (kernel → us) to the debouncer thread.
    // The capacity is small — we never queue a backlog, just signal-and-drain.
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            // Only signal on the event kinds that can change git state:
            // create / modify / remove. Access events (opens) and Other
            // events (metadata-only) are noise for our purposes.
            if let Ok(ev) = res {
                if matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    // We only care that *something* changed; the path itself
                    // is re-resolved when we re-run git status. A burst of N
                    // events in 1 ms collapses to one tick.
                    let _ = tx.send(());
                }
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!(
                "[git_watcher] failed to create watcher for {}: {e}",
                canon.display()
            );
            return;
        }
    };
    if let Err(e) = watcher.watch(&canon, RecursiveMode::Recursive) {
        eprintln!("[git_watcher] failed to watch {}: {e}", canon.display());
        return;
    }
    // Spawn the per-watcher debouncer. The thread is the only owner of
    // the receiver, so we move `rx` in.
    let app_for_thread = app.clone();
    let canon_for_thread = canon.clone();
    // Per-watcher last-event timestamp (used for the heartbeat path below).
    // Mutex-protected because the heartbeat reads it.
    let last_event = std::sync::Arc::new(Mutex::new(Instant::now()));
    let last_event_for_thread = last_event.clone();
    thread::Builder::new()
        .name(format!("git-watcher-{}", canon.display()))
        .spawn(move || {
            // Drain the channel in `recv_timeout` loops. The recv_timeout
            // doubles as the heartbeat — if no events for 60s, the loop
            // still wakes (cheap) and re-emits so the frontend knows
            // the subscription is alive.
            loop {
                match rx.recv_timeout(HEARTBEAT_INTERVAL) {
                    Ok(()) => {
                        // First event in a burst — record the timestamp.
                        *last_event_for_thread.lock() = Instant::now();
                        // Drain any pending events that arrived during the
                        // burst. The inner recv_timeout of `DEBOUNCE_WINDOW`
                        // is the actual debounce: we keep draining until
                        // DEBOUNCE_WINDOW of quiet, then emit once. A
                        // MAX_BURST ceiling bounds the drain: sustained
                        // activity (a build loop, a chatty log inside the
                        // project) would otherwise keep resetting the quiet
                        // window and starve the emit indefinitely.
                        let burst_deadline = Instant::now() + MAX_BURST;
                        while Instant::now() < burst_deadline
                            && rx.recv_timeout(DEBOUNCE_WINDOW).is_ok()
                        {
                            *last_event_for_thread.lock() = Instant::now();
                        }
                        emit_fs_changed(&app_for_thread, &canon_for_thread);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Heartbeat — if it's been a long time since the
                        // last event, emit anyway so the frontend's
                        // heartbeat path can verify the watcher is alive.
                        // We emit `project:fs-heartbeat` (separate event
                        // name) so consumers can choose to ignore it.
                        let _ = app_for_thread.emit(
                            "project:fs-heartbeat",
                            &canon_for_thread.to_string_lossy().to_string(),
                        );
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        // Watcher was dropped — exit the thread.
                        break;
                    }
                }
            }
        })
        .ok();
    // Keep the watcher alive in the state map. The watcher's kernel handle
    // is released when the `Watcher` is dropped — which is when the entry
    // is removed from this map.
    watchers.insert(canon, watcher);
}

/// Drop a watcher (e.g. on project remove). No-op if the path isn't watched.
pub fn uninstall(state: &WatcherState, path: &Path) {
    // Try BOTH key forms: install keys the map by the CANONICALIZED path
    // (verbatim `\\?\C:\…` on Windows). When the watched directory itself
    // was deleted, canonicalize fails and falls back to the raw path —
    // which then doesn't match the map key, and the watcher (kernel handle
    // + debounce thread + heartbeat emitter) would leak forever. Removing
    // under both forms covers that case; the second remove is a cheap no-op.
    let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut watchers = state.watchers.lock();
    watchers.remove(&canon);
    if canon != path {
        watchers.remove(path);
    }
}

/// Install watchers for every registered project + every worktree path.
/// Called on app boot and after project add/remove.
pub fn install_all_known(app: &AppHandle, db_state: &DbState) {
    let (project_paths, worktree_paths): (Vec<PathBuf>, Vec<PathBuf>) = {
        let conn = db_state.0.lock();
        let projects = db::list_projects(&conn).unwrap_or_default();
        let sessions = db::list_sessions(&conn, None).unwrap_or_default();
        let ppaths: Vec<PathBuf> = projects.into_iter().map(|p| PathBuf::from(p.path)).collect();
        let wpaths: Vec<PathBuf> = sessions
            .into_iter()
            .filter_map(|s| s.worktree_path)
            .map(PathBuf::from)
            .collect();
        (ppaths, wpaths)
    };
    for p in project_paths {
        install(app, db_state, &p);
    }
    for p in worktree_paths {
        install(app, db_state, &p);
    }
}

fn emit_fs_changed(app: &AppHandle, canon: &Path) {
    // Send the canonical path; the frontend maps it back to a project id
    // via the projects store. Sending the path (not the project id) is
    // intentional: a worktree path is NOT the same as the project root,
    // but the frontend's listener doesn't need to distinguish — any
    // matching project id gets re-queried. Worktrees have their own
    // status derived from their own working directory, so the path-based
    // emit lets the worktree's diff get refreshed too.
    let _ = app.emit("project:fs-changed", canon.to_string_lossy().to_string());
}
