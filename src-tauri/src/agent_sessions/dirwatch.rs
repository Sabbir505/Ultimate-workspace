//! per-turn directory watching: snapshots, change previews, and path allow-listing — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
/// Working directory for agent spawns. With no project selected the CLI
/// would otherwise inherit the app's own cwd — under `tauri dev` that's the
/// repo root, so generated files land in the app folder and the CLI's
/// sandbox then refuses paths outside it. Fall back to the configured
/// artifacts dir (`storage.artifactsDir`) when set, else Documents/Relay
/// (the same default the built-in chat uses) instead.

pub(super) fn spawn_dir(
    cwd: Option<&str>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Option<std::path::PathBuf> {
    let dir = cwd.map(std::path::PathBuf::from).or_else(|| {
        let configured = {
            let conn = db.lock();
            crate::chat::dispatch::configured_artifacts_dir(&conn)
        };
        configured.or_else(|| {
            dirs::document_dir()
                .or_else(dirs::home_dir)
                .map(|base| crate::user_dirs::branded_dir(&base))
        })
    });
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
    }
    dir
}

/// Directories a harness turn's artifact diff must watch: the spawn dir
/// (files the CLI writes into its workspace) PLUS the artifacts dir
/// (files the relay-tools MCP writes — mcp_tools_bridge always resolves
/// `dispatch::artifacts_dir`, which differs from the spawn dir whenever a
/// project is selected or the user configured a custom `storage.artifactsDir`).
/// Watching only the spawn dir silently drops every MCP-generated docx/pptx/
/// pdf: no artifact row, no `chat:artifact` event, no canvas auto-open.
/// Deduped (canonicalized); spawn dir first.
pub(super) fn turn_watch_dirs(
    cwd: Option<&str>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = spawn_dir(cwd, db) {
        dirs.push(d);
    }
    // Mirror dispatch::artifacts_dir's default without needing an AppHandle:
    // configured dir, else <Documents>/Relay (falling back to home).
    let artifacts = {
        let conn = db.lock();
        crate::chat::dispatch::configured_artifacts_dir(&conn)
    }
    .or_else(|| {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .map(|base| crate::user_dirs::branded_dir(&base))
    });
    if let Some(a) = artifacts {
        let _ = std::fs::create_dir_all(&a);
        let canon = |p: &PathBuf| std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        let a_canon = canon(&a);
        if !dirs.iter().any(|d| canon(d) == a_canon) {
            dirs.push(a);
        }
    }
    dirs
}

/// A harness turn's spawn directory plus its pre-turn snapshot, moved into
/// the reader thread. `finish_turn` diffs the directory against the snapshot
/// to surface files the CLI created or modified as artifacts (the built-in
/// chat gets the same via tool outcomes in chat/dispatch.rs).
///
/// PERF (PERFORMANCE_AUDIT.md B6): a `notify` watcher records which paths
/// were touched DURING the turn, so `changed()` stats only those paths
/// instead of re-walking the whole tree (depth 4, up to 2000 stats) after
/// every turn. Falls back to the full walk when the watcher couldn't be
/// created (dir missing) or reported an error/overflow.
pub(super) struct DirWatch {
    pub(super) dir: PathBuf,
    pub(super) before: HashMap<String, (SystemTime, u64)>,
    /// Touched relative paths ('/'-normalized) since the last `changed()`.
    /// `None` = poisoned (watcher failed/overflowed) → full-walk fallback.
    touched: Arc<Mutex<Option<std::collections::HashSet<String>>>>,
    /// Kept alive for the watch's lifetime; dropping stops notifications.
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Depth/filter rules shared by `snapshot_dir` and the watcher callback so
/// both modes see the same file set.
pub(super) fn watch_path_allowed(rel: &str) -> bool {
    // Depth ≤ 4, no hidden dirs, no node_modules/target (same filter as
    // snapshot_dir's filter_entry).
    let mut depth = 0usize;
    for seg in rel.split('/') {
        depth += 1;
        if seg.starts_with('.') || seg == "node_modules" || seg == "target" {
            return false;
        }
    }
    // rel includes the file itself; snapshot_dir's max_depth(4) counts the
    // root as 0, so a file at walker depth 4 has 4 segments.
    depth <= 4
}

impl DirWatch {
    pub(super) fn new(dir: PathBuf) -> Self {
        use notify::{RecursiveMode, Watcher};
        let before = snapshot_dir(&dir);
        let touched: Arc<Mutex<Option<std::collections::HashSet<String>>>> =
            Arc::new(Mutex::new(Some(std::collections::HashSet::new())));
        let dir_for_cb = dir.clone();
        let touched_for_cb = Arc::clone(&touched);
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let mut guard = touched_for_cb.lock().unwrap();
            match res {
                Ok(event) => {
                    let Some(set) = guard.as_mut() else { return };
                    for path in &event.paths {
                        let rel = path
                            .strip_prefix(&dir_for_cb)
                            .unwrap_or_else(|_| path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        if watch_path_allowed(&rel) {
                            set.insert(rel);
                        }
                    }
                    // Pathological churn (or a flood of events): give up on
                    // incremental mode for this turn rather than ballooning.
                    if set.len() > 4000 {
                        *guard = None;
                    }
                }
                // Overflow / backend error: poison → finish_turn full-walks.
                Err(_) => *guard = None,
            }
        })
        .ok()
        .and_then(|mut w| {
            w.watch(&dir, RecursiveMode::Recursive).ok()?;
            Some(w)
        });
        if watcher.is_none() {
            // No watcher (dir doesn't exist yet, backend init failed):
            // poisoned from the start → every turn full-walks, exactly the
            // pre-B6 behavior.
            *touched.lock().unwrap() = None;
        }
        Self {
            dir,
            before,
            touched,
            _watcher: watcher,
        }
    }

    /// Files created/modified since the last call; refreshes the baseline.
    /// Watcher-healthy: stats only the touched paths. Otherwise: full walk.
    pub(super) fn changed(&mut self) -> Vec<String> {
        let touched = {
            let mut guard = self.touched.lock().unwrap();
            let t = guard.take();
            // Rearm for the next turn when the watcher is still alive.
            *guard = if self._watcher.is_some() {
                Some(std::collections::HashSet::new())
            } else {
                None
            };
            t
        };
        match touched {
            Some(paths) if !paths.is_empty() => {
                let mut changed = Vec::new();
                for rel in paths {
                    let full = self.dir.join(&rel);
                    match std::fs::metadata(&full) {
                        Ok(md) if md.is_file() => {
                            let cur = (md.modified().unwrap_or(SystemTime::UNIX_EPOCH), md.len());
                            match self.before.get(&rel) {
                                Some(&prev) if prev == cur => {} // touched but unchanged
                                _ => {
                                    self.before.insert(rel.clone(), cur);
                                    changed.push(rel);
                                }
                            }
                        }
                        // Deleted or not a file: drop from the baseline.
                        _ => {
                            self.before.remove(&rel);
                        }
                    }
                }
                // Same previewable-extension filter the full-walk path
                // applies via changed_previewable_files.
                let mut filtered: Vec<String> = changed
                    .into_iter()
                    .filter(|rel| previewable_ext(rel))
                    .collect();
                filtered.sort();
                filtered
            }
            Some(_) => Vec::new(), // watcher healthy, nothing touched
            None => {
                let after = snapshot_dir(&self.dir);
                let changed = changed_previewable_files(&self.before, &after);
                self.before = after;
                changed
            }
        }
    }
}

/// Relative path → (mtime, len) for every file under `dir`: depth ≤ 4, hidden
/// dirs / .git / node_modules / target skipped, ~2000 entries max. Taken
/// before a harness turn and diffed after it (see changed_previewable_files).
pub(super) fn snapshot_dir(dir: &Path) -> HashMap<String, (SystemTime, u64)> {
    const MAX_ENTRIES: usize = 2000;
    let mut out = HashMap::new();
    let walker = walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 || !e.file_type().is_dir() {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        });
    for entry in walker.flatten() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(md) = entry.metadata() {
            let rel = entry
                .path()
                .strip_prefix(dir)
                .unwrap_or_else(|_| entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(
                rel,
                (md.modified().unwrap_or(SystemTime::UNIX_EPOCH), md.len()),
            );
        }
    }
    out
}

/// Files that are NEW or MODIFIED (mtime or length changed) between the two
/// snapshots AND whose extension the artifact preview supports — the same
/// classification read_artifact_preview uses (text/code, image, pdf, office).
pub(super) fn changed_previewable_files(
    before: &HashMap<String, (SystemTime, u64)>,
    after: &HashMap<String, (SystemTime, u64)>,
) -> Vec<String> {
    let mut out: Vec<String> = after
        .iter()
        .filter(|(rel, meta)| match before.get(rel.as_str()) {
            Some(prev) => prev != *meta,
            None => true,
        })
        .filter(|(rel, _)| previewable_ext(rel))
        .map(|(rel, _)| rel.clone())
        .collect();
    out.sort();
    out
}

/// Extension allow-list mirrored from read_artifact_preview's classification
/// (chat/commands.rs): text/code kinds, images, pdf, and Office documents.
/// Shared with the built-in chat's file tools (chat/tools/fs.rs), which have
/// no dir-watch and must decide per-write what surfaces as an artifact.
pub(crate) fn previewable_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "markdown"
            | "csv"
            | "json"
            | "html"
            | "htm"
            | "txt"
            | "log"
            | "text"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "sh"
            | "bash"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "sql"
            | "rb"
            | "php"
            | "css"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "bmp"
            | "pdf"
            | "docx"
            | "pptx"
            | "xlsx"
    )
}
