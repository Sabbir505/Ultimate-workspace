//! Vault — the local markdown knowledge base (the "Obsidian-like" module).
//!
//! Architecture (see Random Stuff/obsidian-implementation-research.md):
//!   * The vault is a user-chosen folder of plain `.md` files (+ assets).
//!     FILES ARE THE SOURCE OF TRUTH; the SQLite index (`index.rs`) is a
//!     derived, deletable cache — deleting the vault tables is always safe
//!     (full rescan rebuilds them).
//!   * Nothing Relay-owned is written into the vault except content files
//!     the user (or their agent) creates. Deleted notes move to `<vault>/.trash/`.
//!   * One debounced `notify` watcher keeps the index live and emits
//!     `vault:changed` so the webview refreshes (same shape as git_watcher).
//!   * The webview NEVER writes vault files directly (plugin-fs caps stay
//!     read-only) — every mutation goes through these commands, which are
//!     also the exact functions the `vault_*` chat tools call, so the UI and
//!     the AI have ONE CRUD path (identical link-rewrite semantics).

pub mod index;
pub mod parse;

use std::path::{Path, PathBuf};
use std::sync::mpsc;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::DbState;

/// app_settings key holding the absolute vault root.
pub const SETTING_KEY: &str = "vault.root";

pub struct VaultState {
    /// The bound vault root (canonicalized), set on bind/boot/first use.
    pub root: Mutex<Option<PathBuf>>,
    /// The ACTIVE watcher paired with the root it watches. The pairing is
    /// the point: `root` is updated BEFORE the watcher is (re)installed, so
    /// a rebind decision must compare against the WATCHED root, not the
    /// current one — otherwise rebinding to a different vault would see
    /// "same root" and silently keep watching the OLD folder.
    pub watcher: Mutex<Option<(PathBuf, RecommendedWatcher)>>,
}

impl VaultState {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }
}

impl Default for VaultState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/// Join a vault-relative path (forward slashes) onto the root, rejecting
/// every traversal form: absolute paths, `..`, drive letters, empty/dot
/// segments, trailing slashes, control characters, and reserved dot-dirs at
/// the TOP level (`.obsidian` etc. are config territory, not content).
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("path must not be empty".into());
    }
    if rel.ends_with('/') {
        return Err(format!("path must not end with '/': {rel}"));
    }
    for seg in rel.split('/') {
        if seg.is_empty() {
            return Err(format!("path has an empty segment: {rel}"));
        }
        if seg == ".." || seg == "." {
            return Err(format!("path must not contain '{seg}': {rel}"));
        }
        if seg.contains(':') || seg.chars().any(|c| c.is_control()) {
            return Err(format!("path segment is invalid: {seg}"));
        }
    }
    if rel.starts_with('/') {
        return Err(format!("path must be vault-relative: {rel}"));
    }
    // Windows drive-letter form ("C:/…") is caught by the ':' rule above.
    let joined = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    // Belt-and-braces: bind the EXISTING parent inside the canonical root
    // (also catches symlinks). Not-yet-created parents (create flows) are
    // already bounded by the per-segment rules above.
    if let Some(parent) = joined.parent() {
        if let (Ok(canon_root), Ok(canon_parent)) = (root.canonicalize(), parent.canonicalize()) {
            if !canon_parent.starts_with(&canon_root) {
                return Err(format!("path escapes the vault: {rel}"));
            }
        }
    }
    Ok(joined)
}

/// Normalize a user-supplied vault-relative path to the canonical index form:
/// trimmed, backslashes → '/', no leading './'.
pub fn normalize_rel(rel: &str) -> String {
    let mut s = rel.trim().replace('\\', "/");
    while let Some(stripped) = s.strip_prefix("./") {
        s = stripped.to_string();
    }
    s.trim_end_matches('/').to_string()
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

/// The active vault root, lazily restored from the DB setting (so a restart
/// re-binds without a boot hook racing the frontend).
pub fn current_root(app: &AppHandle) -> Result<PathBuf, String> {
    {
        let state = app.state::<VaultState>();
        let cached = state.root.lock().clone();
        if let Some(r) = cached {
            return Ok(r);
        }
    }
    let db = app.state::<DbState>();
    let saved = {
        let conn = db.0.lock();
        db::get_setting(&conn, SETTING_KEY).ok().flatten()
    };
    drop(db);
    let Some(path) = saved else {
        return Err("No vault is bound. Open the Vault view and choose a folder first.".into());
    };
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!(
            "The bound vault folder no longer exists: {path}. Re-bind a folder in the Vault view."
        ));
    }
    let canon = root.canonicalize().unwrap_or(root);
    {
        let state = app.state::<VaultState>();
        *state.root.lock() = Some(canon.clone());
    }
    install_watcher(app);
    Ok(canon)
}

fn with_db<T, E: std::fmt::Debug>(
    app: &AppHandle,
    f: impl FnOnce(&Connection) -> Result<T, E>,
) -> Result<T, String> {
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    f(&conn).map_err(|e| format!("vault db error: {e:?}"))
}

// ---------------------------------------------------------------------------
// File operations (the ONE CRUD path shared by the UI commands and the
// vault_* chat tools — same atomic writes, same link rewriting)
// ---------------------------------------------------------------------------

/// Read a note's text (index metadata refreshed opportunistically — external
/// edits may race the watcher; a stale index is corrected here for free).
pub fn read_note_core(conn: &Connection, root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    let content = std::fs::read_to_string(&abs)
        .map_err(|e| format!("cannot read \"{rel}\": {e}"))?;
    let _ = index::reindex_file(conn, root, &rel);
    Ok(content)
}

/// Read a binary asset (image embeds) as base64.
pub fn read_binary_core(root: &Path, rel: &str) -> Result<(String, String), String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    let bytes = std::fs::read(&abs).map_err(|e| format!("cannot read \"{rel}\": {e}"))?;
    let mime = match rel.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };
    use base64::Engine as _;
    Ok((mime.to_string(), base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Create parent folders of a rel path (vault-side, dot-dir safe).
fn ensure_parents(root: &Path, abs: &Path) -> Result<(), String> {
    let parent = abs
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    if !parent.starts_with(root) {
        return Err("path escapes the vault".into());
    }
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create folders: {e}"))
}

/// Create a note; refuses to clobber. Returns the normalized path.
pub fn create_note_core(
    conn: &Connection,
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<String, String> {
    let rel = normalize_rel(rel);
    if !rel.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("note paths must end in .md: {rel}"));
    }
    let abs = safe_join(root, &rel)?;
    if abs.exists() {
        return Err(format!("\"{rel}\" already exists — read it first or use a new name."));
    }
    ensure_parents(root, &abs)?;
    atomic_write(&abs, content)?;
    index::reindex_file(conn, root, &rel).map_err(|e| format!("index error: {e}"))?;
    Ok(rel)
}

/// Create/overwrite a note (the tool-facing write; missing parents are made).
pub fn write_note_core(
    conn: &Connection,
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<String, String> {
    let rel = normalize_rel(rel);
    if !rel.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("note paths must end in .md: {rel}"));
    }
    let abs = safe_join(root, &rel)?;
    ensure_parents(root, &abs)?;
    atomic_write(&abs, content)?;
    index::reindex_file(conn, root, &rel).map_err(|e| format!("index error: {e}"))?;
    Ok(rel)
}

/// Temp file + rename, so a crash mid-write never truncates a note.
fn atomic_write(abs: &Path, content: &str) -> Result<(), String> {
    let tmp = abs.with_extension(format!(
        "tmp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&tmp, abs).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename failed: {e}")
    })
}

/// Move a note (or any file) into `<vault>/.trash/` with a timestamp prefix.
pub fn delete_note_core(conn: &Connection, root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    if !abs.is_file() {
        return Err(format!("\"{rel}\" does not exist."));
    }
    // Move FIRST, then drop the index rows: the reverse order would leave
    // the index missing a note that still exists if the trash move failed.
    let dest = trash_dest(root, &rel)?;
    std::fs::rename(&abs, &dest).map_err(|e| format!("trash move failed: {e}"))?;
    index::remove_from_index(conn, &rel).map_err(|e| format!("index error: {e}"))?;
    Ok(dest
        .strip_prefix(root)
        .unwrap_or(&dest)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/"))
}

fn trash_dest(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let trash = root.join(".trash");
    std::fs::create_dir_all(&trash).map_err(|e| format!("cannot create .trash: {e}"))?;
    let mut dest = trash.join(format!("{stamp}-{name}"));
    let mut n = 1;
    while dest.exists() {
        dest = trash.join(format!("{stamp}-{n}-{name}"));
        n += 1;
    }
    Ok(dest)
}

/// Rename/move a note AND rewrite every inbound link vault-wide (Obsidian's
/// "Automatically update internal links"). Both sides are vault-relative
/// paths WITH the .md extension. Returns (new_path, files_rewritten).
pub fn rename_note_core(
    conn: &mut Connection,
    root: &Path,
    from: &str,
    to: &str,
) -> Result<(String, usize), String> {
    let from = normalize_rel(from);
    let to = normalize_rel(to);
    if !to.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("note paths must end in .md: {to}"));
    }
    if from.eq_ignore_ascii_case(&to) {
        return Ok((to, 0));
    }
    let from_abs = safe_join(root, &from)?;
    let to_abs = safe_join(root, &to)?;
    if !from_abs.is_file() {
        return Err(format!("\"{from}\" does not exist."));
    }
    if to_abs.exists() {
        return Err(format!("\"{to}\" already exists."));
    }

    // Pre-rename resolver snapshot: determines which files' links point at
    // the mover. Post-rename file list gives the new shortest linktext.
    let files_pre = index::list_files(conn).map_err(|e| format!("index error: {e}"))?;
    let mut files_post = files_pre
        .iter()
        .filter(|f| !f.path.eq_ignore_ascii_case(&from))
        .cloned()
        .collect::<Vec<_>>();
    let (to_base, to_folder) = to
        .rsplit_once('/')
        .map(|(f, b)| (b.to_string(), f.to_string()))
        .unwrap_or((to.clone(), String::new()));
    files_post.push(parse::FileMeta {
        path: to.clone(),
        basename: to_base,
        folder: to_folder,
        aliases: files_pre
            .iter()
            .find(|f| f.path.eq_ignore_ascii_case(&from))
            .map(|f| f.aliases.clone())
            .unwrap_or_default(),
        is_note: true,
    });
    let new_linktext = parse::shortest_linktext(&to, &files_post);

    // Rewrite inbound links in EVERY note (except the mover itself) BEFORE
    // the move, reading + writing files with no DB lock held across IO.
    // Originals are kept so a failed move can roll the rewrites back —
    // otherwise links would point at a destination that never existed.
    let mut rewritten: Vec<(String, String, String)> = Vec::new(); // (rel, new_content, original)
    for f in &files_pre {
        if f.path.eq_ignore_ascii_case(&from) {
            continue;
        }
        let abs = root.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let (new_content, n) =
            parse::rewrite_inbound_links(&content, &from, &new_linktext, &files_pre);
        if n > 0 && new_content != content {
            rewritten.push((f.path.clone(), new_content, content));
        }
    }
    for (rel, content, _) in &rewritten {
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        atomic_write(&abs, content)?;
    }

    // The move itself. On failure, restore every rewritten file so the
    // vault stays exactly as it was before the rename attempt.
    ensure_parents(root, &to_abs)?;
    if let Err(e) = std::fs::rename(&from_abs, &to_abs) {
        for (rel, _, original) in &rewritten {
            let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let _ = atomic_write(&abs, original);
        }
        return Err(format!("rename failed: {e}"));
    }

    // Index updates: drop the old row-set, index the moved file + every
    // rewritten one (their outgoing links changed).
    index::remove_from_index(conn, &from).map_err(|e| format!("index error: {e}"))?;
    index::reindex_file(conn, root, &to).map_err(|e| format!("index error: {e}"))?;
    for (rel, _, _) in &rewritten {
        index::reindex_file(conn, root, rel).map_err(|e| format!("index error: {e}"))?;
    }
    Ok((to, rewritten.len()))
}

pub fn create_folder_core(root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    if abs.exists() {
        return Err(format!("\"{rel}\" already exists."));
    }
    std::fs::create_dir_all(&abs).map_err(|e| format!("cannot create folder: {e}"))?;
    Ok(rel)
}

pub fn delete_folder_core(conn: &Connection, root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    if rel.is_empty() || !rel.contains('/') && rel.eq_ignore_ascii_case(".trash") {
        return Err("refusing to delete that folder".into());
    }
    let abs = safe_join(root, &rel)?;
    if !abs.is_dir() {
        return Err(format!("\"{rel}\" is not a folder."));
    }
    // Drop every indexed note under the folder from the index.
    let prefix = format!("{rel}/");
    let notes = index::collect_note_paths(&abs)
        .into_iter()
        .map(|p| format!("{prefix}{p}"))
        .collect::<Vec<_>>();
    for n in &notes {
        index::remove_from_index(conn, n).map_err(|e| format!("index error: {e}"))?;
    }
    let dest = trash_dest(root, &rel)?;
    std::fs::rename(&abs, &dest).map_err(|e| format!("trash move failed: {e}"))?;
    Ok(dest
        .strip_prefix(root)
        .unwrap_or(&dest)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/"))
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// Vault-relative path ('/' separators). Folders have no extension.
    pub path: String,
    /// "folder" | "note" (.md) | "file" (other linkable assets)
    pub kind: String,
    pub children: Vec<TreeNode>,
}

pub fn tree_core(root: &Path) -> Vec<TreeNode> {
    fn build(dir: &Path, rel_prefix: &str) -> Vec<TreeNode> {
        let Ok(read) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut folders: Vec<TreeNode> = Vec::new();
        let mut files: Vec<TreeNode> = Vec::new();
        for entry in read.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // .obsidian, .trash, .git, …
            }
            let path = entry.path();
            let rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{rel_prefix}/{name}")
            };
            if path.is_dir() {
                let children = build(&path, &rel);
                folders.push(TreeNode {
                    name,
                    path: rel,
                    kind: "folder".into(),
                    children,
                });
            } else {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .unwrap_or_default();
                files.push(TreeNode {
                    name,
                    path: rel,
                    kind: if ext == "md" { "note".into() } else { "file".into() },
                    children: Vec::new(),
                });
            }
        }
        folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        folders.extend(files);
        folders
    }
    build(root, "")
}

// ---------------------------------------------------------------------------
// Bind / unbind / scan / watcher
// ---------------------------------------------------------------------------

/// Bind a folder as the vault: persist the setting, install the watcher,
/// and run a full scan in the background (progress events on the way).
pub fn bind_core(app: &AppHandle, path: &str) -> Result<String, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    let canon = root.canonicalize().unwrap_or(root);
    with_db(app, |conn| db::set_setting(conn, SETTING_KEY, &canon.to_string_lossy()))?;
    {
        let state = app.state::<VaultState>();
        *state.root.lock() = Some(canon.clone());
    }
    install_watcher(app);
    spawn_scan(app);
    Ok(canon.to_string_lossy().to_string())
}

pub fn unbind_core(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<VaultState>();
        *state.watcher.lock() = None; // drops the watcher → thread exits
        *state.root.lock() = None;
    }
    with_db(app, |conn| db::delete_setting(conn, SETTING_KEY))?;
    with_db(app, |conn| index::reset_index(conn))?;
    Ok(())
}

/// Full background rescan with progress events.
pub fn spawn_scan(app: &AppHandle) {
    let Some(root) = current_root(app).ok() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<crate::DbState>();
        let result = {
            let mut conn = db.0.lock();
            index::full_scan(&conn, &root)
        };
        match result {
            Ok((n, ms)) => {
                let _ = app.emit(
                    "vault:scanned",
                    serde_json::json!({ "notes": n, "ms": ms }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "vault:scan-error",
                    serde_json::json!({ "error": e.to_string() }),
                );
            }
        }
    });
}

/// One `notify` watcher over the vault root. Debounced exactly like
/// git_watcher.rs (300 ms quiet / 2 s burst ceiling); the burst's changed
/// paths are reindexed in Rust (the index stays current even with the view
/// closed) and announced to the webview as `vault:changed`.
pub fn install_watcher(app: &AppHandle) {
    let Some(root) = current_root(app).ok() else {
        return;
    };
    let state = app.state::<VaultState>();
    {
        // Rebinding the SAME root is a no-op; a DIFFERENT root drops the old
        // watcher (kernel handle + debounce thread) before the new install.
        let existing = state.watcher.lock().take();
        if let Some((watched, w)) = existing {
            if watched == root {
                *state.watcher.lock() = Some((watched, w));
                return;
            }
            // else: `w` drops here → old watcher + thread exit.
        }
    }
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    let _ = tx.send(ev.paths);
                }
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[vault] watcher create failed: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!("[vault] watch failed for {}: {e}", root.display());
        return;
    }
    let app = app.clone();
    let root_for_thread = root.clone();
    std::thread::Builder::new()
        .name("vault-watcher".into())
        .spawn(move || {
            loop {
                match rx.recv() {
                    Ok(first) => {
                        // Debounce: drain the quiet window, ceiling 2 s.
                        let mut paths: Vec<PathBuf> = first;
                        let burst_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                        while std::time::Instant::now() < burst_deadline {
                            match rx.recv_timeout(std::time::Duration::from_millis(300)) {
                                Ok(more) => paths.extend(more),
                                Err(mpsc::RecvTimeoutError::Timeout) => break,
                                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                            }
                        }
                        reindex_changed(&app, &root_for_thread, &paths);
                    }
                    Err(_) => return, // channel disconnected: watcher dropped
                }
            }
        })
        .ok();
    // Keep the kernel handle alive.
    *state.watcher.lock() = Some((root, watcher));
}

/// Reindex the changed paths (md files only) and emit `vault:changed`.
fn reindex_changed(app: &AppHandle, root: &Path, paths: &[PathBuf]) {
    let mut rels: Vec<String> = Vec::new();
    for p in paths {
        let Ok(rel) = p.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        if rel.starts_with(".trash/") || rel.split('/').any(|seg| seg.starts_with('.')) {
            continue;
        }
        if !rels.contains(&rel) {
            rels.push(rel);
        }
    }
    if rels.is_empty() {
        return;
    }
    let db = app.state::<crate::DbState>();
    {
        let conn = db.0.lock();
        for rel in &rels {
            if rel.to_ascii_lowercase().ends_with(".md") {
                let _ = index::reindex_file(&conn, root, rel);
            }
        }
    }
    drop(db);
    let _ = app.emit("vault:changed", serde_json::json!({ "paths": rels }));
}

// ---------------------------------------------------------------------------
// Tauri commands (thin async wrappers over the cores above)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct VaultStateDto {
    root: Option<String>,
    stats: Option<VaultStatsDto>,
}

#[derive(Serialize)]
pub struct VaultStatsDto {
    pub notes: i64,
    pub files: i64,
    pub links: i64,
    pub unresolved: i64,
}

#[tauri::command]
pub async fn vault_get_state(app: AppHandle) -> Result<VaultStateDto, String> {
    let root = current_root(&app).ok();
    let stats = root.as_ref().and_then(|_| {
        with_db(&app, |conn| {
            index::stats(conn).map(|(notes, files, links, unresolved)| VaultStatsDto {
                notes,
                files,
                links,
                unresolved,
            })
        })
        .ok()
    });
    Ok(VaultStateDto {
        root: root.map(|r| r.to_string_lossy().to_string()),
        stats,
    })
}

#[tauri::command]
pub async fn vault_bind(app: AppHandle, path: String) -> Result<String, String> {
    bind_core(&app, &path)
}

#[tauri::command]
pub async fn vault_unbind(app: AppHandle) -> Result<(), String> {
    unbind_core(&app)
}

#[tauri::command]
pub async fn vault_rescan(app: AppHandle) -> Result<(), String> {
    // Force a fresh root resolution so a rebind picks up the new folder.
    current_root(&app)?;
    spawn_scan(&app);
    Ok(())
}

#[tauri::command]
pub async fn vault_tree(app: AppHandle) -> Result<Vec<TreeNode>, String> {
    let root = current_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || Ok(tree_core(&root)))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn vault_read_note(app: AppHandle, path: String) -> Result<String, String> {
    let root = current_root(&app)?;
    with_db(&app, |conn| read_note_core(conn, &root, &path))
}

#[tauri::command]
pub async fn vault_read_binary(app: AppHandle, path: String) -> Result<(String, String), String> {
    let root = current_root(&app)?;
    read_binary_core(&root, &path)
}

#[tauri::command]
pub async fn vault_create_note(app: AppHandle, path: String, content: String) -> Result<String, String> {
    let root = current_root(&app)?;
    with_db(&app, |conn| create_note_core(conn, &root, &path, &content))
}

#[tauri::command]
pub async fn vault_write_note(app: AppHandle, path: String, content: String) -> Result<String, String> {
    let root = current_root(&app)?;
    with_db(&app, |conn| write_note_core(conn, &root, &path, &content))
}

#[tauri::command]
pub async fn vault_delete_note(app: AppHandle, path: String) -> Result<String, String> {
    let root = current_root(&app)?;
    with_db(&app, |conn| delete_note_core(conn, &root, &path))
}

#[tauri::command]
pub async fn vault_rename_note(app: AppHandle, from: String, to: String) -> Result<(String, usize), String> {
    let root = current_root(&app)?;
    // Clone the connection Arc (State<> can't move into the blocking task).
    let db: std::sync::Arc<parking_lot::Mutex<Connection>> =
        app.state::<DbState>().inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.lock();
        rename_note_core(&mut conn, &root, &from, &to)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn vault_create_folder(app: AppHandle, path: String) -> Result<String, String> {
    let root = current_root(&app)?;
    create_folder_core(&root, &path)
}

#[tauri::command]
pub async fn vault_delete_folder(app: AppHandle, path: String) -> Result<String, String> {
    let root = current_root(&app)?;
    with_db(&app, |conn| delete_folder_core(conn, &root, &path))
}

#[tauri::command]
pub async fn vault_search(app: AppHandle, query: String, limit: Option<usize>) -> Result<Vec<index::SearchHit>, String> {
    let root = current_root(&app)?;
    let _ = root;
    with_db(&app, |conn| index::search(conn, &query, limit.unwrap_or(30).clamp(1, 100)))
}

#[tauri::command]
pub async fn vault_note_meta(app: AppHandle, path: String) -> Result<index::NoteMeta, String> {
    current_root(&app)?;
    with_db(&app, |conn| index::note_meta(conn, &normalize_rel(&path)))
}

#[tauri::command]
pub async fn vault_graph(app: AppHandle, include_unresolved: Option<bool>, include_attachments: Option<bool>) -> Result<(Vec<index::GraphNode>, Vec<index::GraphEdge>), String> {
    current_root(&app)?;
    with_db(&app, |conn| {
        index::graph(
            conn,
            include_unresolved.unwrap_or(true),
            include_attachments.unwrap_or(false),
        )
    })
}

#[tauri::command]
pub async fn vault_all_tags(app: AppHandle) -> Result<Vec<index::TagCount>, String> {
    current_root(&app)?;
    with_db(&app, |conn| index::all_tags(conn))
}

#[tauri::command]
pub async fn vault_stats(app: AppHandle) -> Result<VaultStatsDto, String> {
    current_root(&app)?;
    with_db(&app, |conn| {
        index::stats(conn).map(|(notes, files, links, unresolved)| VaultStatsDto {
            notes,
            files,
            links,
            unresolved,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_traversal_and_accepts_normal() {
        let root = PathBuf::from("/tmp/vault");
        assert!(safe_join(&root, "a/b.md").is_ok());
        assert!(safe_join(&root, "a b/c-d.md").is_ok());
        assert!(safe_join(&root, "a/../b.md").is_err());
        assert!(safe_join(&root, "../escape.md").is_err());
        assert!(safe_join(&root, "/abs.md").is_err());
        assert!(safe_join(&root, "C:/win.md").is_err());
        assert!(safe_join(&root, "a//b.md").is_err());
        assert!(safe_join(&root, "").is_err());
        assert!(safe_join(&root, "dir/").is_err());
        assert_eq!(
            safe_join(&root, "a\\b.md").unwrap(),
            root.join("a").join("b.md")
        );
    }

    #[test]
    fn normalize_rel_cleans_forms() {
        assert_eq!(normalize_rel(" a\\b\\c.md "), "a/b/c.md");
        assert_eq!(normalize_rel("./x/y.md"), "x/y.md");
        assert_eq!(normalize_rel("dir/"), "dir");
    }
}
