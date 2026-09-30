//! Filesystem watcher for CLI harnesses' NATIVE subagent stores
//! (`~/.claude/agents/*.md` and friends).
//!
//! Why this exists: the native stores are markdown files that a HARNESS writes
//! and a human edits — Claude Code authors its own agents there, and a prompt
//! edited in a terminal never passes through the app. The registry only knew
//! about them through a collapsed card the user had to open, so an agent a
//! harness created was invisible to Relay until someone went looking, and an
//! edit to an already-imported `.md` never reached its row. The registry is
//! the thing every spawn surface resolves against, so "the file changed and
//! Relay doesn't know" is a correctness bug, not a freshness nicety.
//!
//! Two halves:
//!  - [`install_store_watchers`] reuses `git_watcher::install` (one OS watcher
//!    per directory, debounced, emitting `project:fs-changed`) on each
//!    user-level native store that exists. Project-level stores
//!    (`<root>/.claude/agents`) are already inside the recursive per-project
//!    watcher, so they need nothing here.
//!  - [`listen`] consumes `project:fs-changed` and re-syncs LINKED rows when
//!    the changed path is actually inside a native store. It deliberately does
//!    NOT import new files: the user already chose to import the ones they
//!    linked, and following those needs no further consent, but silently
//!    promoting a newly-dropped file into a spawnable agent would.
//!
//! The path filter is the load-bearing part. `project:fs-changed` fires on every
//! git operation in every project; re-syncing on those would re-read N files per
//! keystroke-triggered build, so an event whose path isn't under a native store
//! is dropped in a single `starts_with` check.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Listener, Manager};

/// Git's watcher already debounces at 300 ms; this is the extra quiet window
/// before the re-sync, because a "write a file" from an editor is several events
/// (create, write, rename-over) and re-parsing on each one wastes reads and can
/// catch a half-written file.
const RESYNC_DEBOUNCE: Duration = Duration::from_millis(500);

/// True when `changed` is a path inside one of the native stores we watch.
///
/// Compared on the watched directory itself, not per-harness: the sync re-parses
/// only the LINKED rows it actually has, and a linked row's path is by
/// construction inside one of these. The check is case-insensitive because the
/// `project:fs-changed` payload is a canonicalized path and Windows drive
/// letters and directory casing do not survive that round-trip predictably.
fn is_native_store_path(changed: &str, dirs: &[PathBuf]) -> bool {
    let changed = Path::new(changed).to_string_lossy().to_lowercase();
    dirs.iter().any(|dir| changed.starts_with(&dir.to_string_lossy().to_lowercase()))
}

/// Install a watcher for every user-level native store that currently exists.
///
/// Idempotent and cheap — `git_watcher::install` is a canonicalize plus a map
/// lookup — so it is safe to call on every listing, not just at boot. That is
/// what makes a store created AFTER startup (`mkdir ~/.kimi-code/agents` while
/// the app is running) get watched without a restart.
pub fn install_store_watchers(app: &AppHandle) {
    let db_state = app.state::<crate::DbState>();
    for dir in crate::harness_config::existing_native_store_dirs() {
        crate::git_watcher::install(app, &db_state, &dir);
    }
}

/// Start reacting to native-store changes. Call once, after the app is built
/// (the event bus is not available during `setup` in a usable form for
/// `listen`).
pub fn listen(app: &AppHandle) {
    let inner = app.clone();
    app.listen("project:fs-changed", move |event| {
        let changed = event.payload();
        install_store_watchers(&inner);
        let dirs = crate::harness_config::existing_native_store_dirs();
        if dirs.is_empty() {
            return;
        }
        // A user-level store is matched against the live directory list; a
        // PROJECT-level store (`<root>/.claude/agents`) sits inside the
        // recursive per-project watcher and so is never in that list, but its
        // shape is fixed by the layout. Either match is enough; neither needs
        // a registry read.
        if !is_native_store_path(changed, &dirs) && !is_project_store_path(changed) {
            return;
        }
        spawn_resync(&inner);
    });
}

/// True when the changed file lives in a PROJECT-level native store:
/// `<root>/.claude/agents`, `<root>/.opencode/agent`, `<root>/.kimi-code/agents`,
/// `<root>/.omp/agents`, `<root>/.commandcode/agents`. Matched structurally off
/// the file's own parent chain, so it holds for any project without reading the
/// project registry.
fn is_project_store_path(changed: &str) -> bool {
    let Some(dir) = Path::new(changed).parent() else {
        return false;
    };
    let store_name_ok = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| matches!(n, "agents" | "agent"));
    let owner_ok = dir
        .parent()
        .and_then(|o| o.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| {
            matches!(
                n,
                ".claude" | ".opencode" | ".kimi-code" | ".omp" | ".commandcode"
            )
        });
    store_name_ok && owner_ok
}

/// Run the re-sync off the event thread, after the debounce.
///
/// The debounce lives here rather than being borrowed from the git watcher
/// because the two watch for different things: git cares about a repo's state
/// settling, we care about a single file being fully written.
fn spawn_resync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESYNC_DEBOUNCE).await;
        crate::commands::subagent_cmds::resync_linked_native(&app);
    });
}
