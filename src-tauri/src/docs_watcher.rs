//! Filesystem watcher for Knowledge (local RAG) corpus folders.
//!
//! Closes §5.25's first half: corpus indexing used to be manual — a user
//! editing files in a watched folder had to press Index again to pick up the
//! changes. This module installs one `notify::RecommendedWatcher` per
//! distinct enabled-corpus root (the same shape as `git_watcher`) and, after
//! a debounce window, re-runs the incremental index pass for every enabled
//! corpus rooted at the changed path.
//!
//! Why it is safe to fire freely:
//! - The index pass is INCREMENTAL (mtime/size diff — only changed files are
//!   re-chunked and re-embedded), so a burst of edits costs one cheap walk.
//! - `docs_index::spawn_index_job` refuses a second concurrent run per corpus
//!   (the IndexRegistry slot), and this module treats that error as "already
//!   running — skip", so a burst can never stack jobs.
//! - A missing embedding model surfaces as an error string which is logged
//!   and dropped — the watcher never turns a config gap into a UI error.
//!
//! Debounce tuning: indexing is far heavier than `git status`, so the quiet
//! window (2 s) and burst ceiling (15 s) are deliberately longer than the
//! git watcher's 300 ms / 2 s.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::db::docs as docs_db;
use crate::docs_index::{spawn_index_job, IndexRegistry};
use crate::chat::local_models::{LocalModelRegistry, LocalModelState};

/// Quiet window before an index re-run fires (see module doc).
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(2000);
/// Ceiling on a single burst — sustained activity still makes progress.
const MAX_BURST: Duration = Duration::from_secs(15);
/// Idle heartbeat (no work, just liveness — matches git_watcher).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

pub struct DocsWatcherState {
    /// Watchers keyed by the canonicalized corpus root path.
    pub watchers: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

impl DocsWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for DocsWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// Install a watcher for a corpus root if one isn't already active.
/// Idempotent per canonical path. `app`/`db`/`local`/`registry` are cloned
/// into the debounce thread, which resolves enabled corpora at fire time —
/// so enable/disable toggles need no watcher churn.
pub fn install(
    app: &AppHandle,
    state_canonical: &DocsWatcherState,
    db: Arc<Mutex<Connection>>,
    local: Arc<LocalModelRegistry>,
    registry: Arc<IndexRegistry>,
    path: &Path,
) {
    let canon = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return, // folder gone — nothing to watch
    };
    let mut watchers = state_canonical.watchers.lock();
    if watchers.contains_key(&canon) {
        return;
    }
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    let _ = tx.send(());
                }
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            crate::relay_eprintln!("[docs_watcher] watcher create failed for {}: {e}", canon.display());
            return;
        }
    };
    if let Err(e) = watcher.watch(&canon, RecursiveMode::Recursive) {
        crate::relay_eprintln!("[docs_watcher] watch install failed for {}: {e}", canon.display());
        return;
    }
    let app_for_thread = app.clone();
    let canon_for_thread = canon.clone();
    thread::Builder::new()
        .name(format!("docs-watcher-{}", canon.display()))
        .spawn(move || loop {
            match rx.recv_timeout(HEARTBEAT_INTERVAL) {
                Ok(()) => {
                    let burst_deadline = Instant::now() + MAX_BURST;
                    while Instant::now() < burst_deadline
                        && rx.recv_timeout(DEBOUNCE_WINDOW).is_ok()
                    {}
                    reindex_corpora_at(&app_for_thread, &db, &local, &registry, &canon_for_thread);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {} // heartbeat: nothing to do
            }
        })
        .ok();
    watchers.insert(canon, watcher);
}

/// Drop the watcher for a corpus root (corpus removed). No-op when absent;
/// also removes the raw (uncanonicalized) key form, matching git_watcher.
pub fn uninstall(state: &DocsWatcherState, path: &Path) {
    let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut watchers = state.watchers.lock();
    watchers.remove(&canon);
    if canon != path {
        watchers.remove(path);
    }
}

/// Install watchers for every ENABLED corpus. Called on boot.
pub fn install_all_enabled(app: &AppHandle, db: &crate::DbState) {
    let (corpora, local, registry) = {
        let conn = db.0.lock();
        (
            docs_db::list_corpora(&conn).unwrap_or_default(),
            app.state::<LocalModelState>().0.clone(),
            app.state::<std::sync::Arc<IndexRegistry>>().clone(),
        )
    };
    let state = app.state::<DocsWatcherState>();
    let inner = &*state;
    for corpus in corpora.into_iter().filter(|c| c.enabled) {
        install(
            app,
            inner,
            Arc::clone(&db.0),
            Arc::clone(&local),
            Arc::clone(&registry),
            Path::new(&corpus.path),
        );
    }
}

/// Debounce fired: re-index every enabled corpus rooted at `canon`.
fn reindex_corpora_at(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    local: &Arc<LocalModelRegistry>,
    registry: &Arc<IndexRegistry>,
    canon: &Path,
) {
    let corpora: Vec<docs_db::DocCorpus> = {
        let conn = db.lock();
        match docs_db::list_corpora(&conn) {
            Ok(all) => all
                .into_iter()
                .filter(|c| {
                    c.enabled
                        && Path::new(&c.path)
                            .canonicalize()
                            .map(|p| p == canon)
                            .unwrap_or(false)
                })
                .collect(),
            Err(e) => {
                crate::relay_eprintln!("[docs_watcher] corpus lookup failed: {e}");
                return;
            }
        }
    };
    // A watcher-fired re-index must never COLD-START the embedding sidecar:
    // `spawn_index_job` → `run_index` → `start_embedding` is the only path
    // that launches it, and an unattended file change spinning up a
    // multi-GB GPU model (which then stays resident) reads as "llama.cpp is
    // running while I'm not doing anything". The manual Index button keeps
    // its auto-start (deliberate user intent); the watcher only rides along
    // when the sidecar is already up, and otherwise logs and waits.
    if local.embedding_status().is_none() {
        crate::relay_eprintln!(
            "[docs_watcher] embedding sidecar is down — skipping re-index of {} (press Index to run it manually)",
            canon.display()
        );
        return;
    }
    for corpus in corpora {
        match spawn_index_job(
            app.clone(),
            Arc::clone(db),
            Arc::clone(local),
            Arc::clone(registry),
            corpus.id.clone(),
        ) {
            Ok(()) => {
                crate::relay_eprintln!(
                    "[docs_watcher] re-indexing corpus {} after fs change in {}",
                    corpus.id,
                    canon.display()
                );
            }
            Err(e) => {
                // "already in progress" is the normal burst case; a missing
                // embedding model is a config gap. Neither is worth noise.
                crate::relay_eprintln!("[docs_watcher] skip corpus {}: {e}", corpus.id);
            }
        }
    }
}

/// Sanity: the enabled-at-fire-time filter must never index a disabled
/// corpus even when a stale watcher is still installed for its path.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::docs as docs_db;

    #[test]
    fn disabled_corpora_are_filtered_at_fire_time() {
        let conn = crate::db::mem();
        let enabled = docs_db::add_corpus(&conn, "C:/docs/alpha", "alpha").unwrap();
        let disabled = docs_db::add_corpus(&conn, "C:/docs/beta", "beta").unwrap();
        docs_db::set_corpus_enabled(&conn, &disabled.id, false).unwrap();

        let all = docs_db::list_corpora(&conn).unwrap();
        let picked: Vec<&String> = all
            .iter()
            .filter(|c| {
                c.enabled && {
                    // simulate the canonicalize+compare arm for the alpha path
                    Path::new(&c.path).file_name() == Path::new(&enabled.path).file_name()
                }
            })
            .map(|c| &c.id)
            .collect();
        assert_eq!(picked.len(), 1, "only the enabled corpus matches");
        assert_eq!(picked[0], &enabled.id);
        assert_ne!(picked[0], &disabled.id);
    }
}
