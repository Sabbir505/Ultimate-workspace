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
/// segments, trailing slashes, control characters, and DOT-PREFIXED names
/// anywhere in the path (`.obsidian` etc. are config/trash territory, not
/// content — the scan, the tree and the watcher all skip them, so the CRUD
/// path must not reach them either).
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
        if seg.starts_with('.') {
            return Err(format!("dot-prefixed names are not vault content: {rel}"));
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
//
// Lock discipline (see lib.rs RULE): every core takes the `DbState` mutex
// handle, NOT a held guard, and locks only around its SQL phases — file IO
// happens with the lock released. The commands run these cores on the
// blocking thread pool.
// ---------------------------------------------------------------------------

/// Read a note's text (index metadata refreshed opportunistically — external
/// edits may race the watcher; a stale index is corrected here for free).
pub fn read_note_core(db: &Mutex<Connection>, root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    let content = std::fs::read_to_string(&abs)
        .map_err(|e| format!("cannot read \"{rel}\": {e}"))?;
    let _ = index::reindex_file_locked(db, root, &rel);
    Ok(content)
}

/// Binary embeds above this size are refused instead of base64-ing the
/// whole file into memory (the tool API reaches this path too).
const MAX_BINARY_BYTES: u64 = 25 * 1024 * 1024;

/// Read a binary asset (image embeds) as base64.
pub fn read_binary_core(root: &Path, rel: &str) -> Result<(String, String), String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    let meta = std::fs::metadata(&abs).map_err(|e| format!("cannot read \"{rel}\": {e}"))?;
    if meta.len() > MAX_BINARY_BYTES {
        return Err(format!(
            "\"{rel}\" is too large to embed (limit is {} MB).",
            MAX_BINARY_BYTES / (1024 * 1024)
        ));
    }
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
    db: &Mutex<Connection>,
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
    index::reindex_file_locked(db, root, &rel).map_err(|e| format!("index error: {e}"))?;
    Ok(rel)
}

/// Create/overwrite a note (the tool-facing write; missing parents are made).
pub fn write_note_core(
    db: &Mutex<Connection>,
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
    index::reindex_file_locked(db, root, &rel).map_err(|e| format!("index error: {e}"))?;
    Ok(rel)
}

/// Temp file + rename, so a crash mid-write never truncates a note. The temp
/// data is fsynced BEFORE the rename — without that, a power loss after the
/// rename can leave a zero-length/partial note on a journaled filesystem
/// (the metadata hits disk before the data). The temp name is dot-prefixed
/// and sequence-unique: invisible to the scan/tree/watcher (no spurious
/// `vault:changed` bursts) and collision-free under concurrent writes.
/// Crash leftovers (`.<name>.tmp-<nanos>-<seq>`) are swept by [`sweep_stale_tmp`].
fn atomic_write(abs: &Path, content: &str) -> Result<(), String> {
    use std::io::Write as _;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "path has no file name".to_string())?;
    let uniq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = abs.with_file_name(format!(
        ".{name}.tmp-{}-{uniq}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, abs)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write failed: {e}")
    })
}

/// Remove crash leftovers from [`atomic_write`] (dot-prefixed `*.tmp-<n>`
/// files) anywhere in the vault. Runs at the start of every full scan; the
/// suffix after the last `-` must be all digits so a user's real dot-file
/// can never match.
pub fn sweep_stale_tmp(root: &Path) {
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let digits_suffix = name
            .rsplit('-')
            .next()
            .map(|seq| !seq.is_empty() && seq.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if name.starts_with('.') && name.contains(".tmp-") && digits_suffix {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Import (copy) an external file into the vault — the insert-image path.
/// `dest` is a vault-relative path (e.g. `assets/diagram.png`); on collision
/// a numeric suffix is appended instead of clobbering. Returns the final
/// vault-relative path.
pub fn import_file_core(root: &Path, src: &str, dest: &str) -> Result<String, String> {
    let src = std::path::Path::new(src);
    if !src.is_file() {
        return Err(format!("source file not found: {}", src.display()));
    }
    let dest = normalize_rel(dest);
    let mut dest_abs = safe_join(root, &dest)?;
    if dest_abs.exists() {
        // Never clobber: insert " - 1", " - 2", … before the extension.
        let stem = dest_abs.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = dest_abs.extension().map(|s| s.to_string_lossy().into_owned());
        let dir = dest_abs.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| root.to_path_buf());
        let mut n = 1;
        loop {
            let name = match &ext {
                Some(e) => format!("{stem} - {n}.{e}"),
                None => format!("{stem} - {n}"),
            };
            dest_abs = dir.join(name);
            if !dest_abs.exists() {
                break;
            }
            n += 1;
        }
    }
    ensure_parents(root, &dest_abs)?;
    std::fs::copy(src, &dest_abs).map_err(|e| format!("import failed: {e}"))?;
    Ok(dest_abs
        .strip_prefix(root)
        .unwrap_or(&dest_abs)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/"))
}

/// Write raw bytes to a vault file — the clipboard-image-paste path (a
/// pasted bitmap has no source path to copy from). Non-md only (notes go
/// through the text write); never clobbers: suffixed like import_file_core.
/// Returns the final vault-relative path.
pub fn write_binary_core(root: &Path, rel: &str, bytes: &[u8]) -> Result<String, String> {
    let rel = normalize_rel(rel);
    if rel.to_ascii_lowercase().ends_with(".md") {
        return Err("notes are text — write them with vault_write_note".to_string());
    }
    let mut abs = safe_join(root, &rel)?;
    if abs.exists() {
        let stem = abs
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = abs
            .extension()
            .map(|s| s.to_string_lossy().into_owned());
        let dir = abs
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| root.to_path_buf());
        let mut n = 1;
        loop {
            let name = match &ext {
                Some(e) => format!("{stem} - {n}.{e}"),
                None => format!("{stem} - {n}"),
            };
            abs = dir.join(name);
            if !abs.exists() {
                break;
            }
            n += 1;
        }
    }
    ensure_parents(root, &abs)?;
    std::fs::write(&abs, bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(abs
        .strip_prefix(root)
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/"))
}

/// Move a note (or any file) into `<vault>/.trash/` with a timestamp prefix.
pub fn delete_note_core(db: &Mutex<Connection>, root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    let abs = safe_join(root, &rel)?;
    if !abs.is_file() {
        return Err(format!("\"{rel}\" does not exist."));
    }
    // Move FIRST, then drop the index rows: the reverse order would leave
    // the index missing a note that still exists if the trash move failed.
    let dest = trash_dest(root, &rel)?;
    std::fs::rename(&abs, &dest).map_err(|e| format!("trash move failed: {e}"))?;
    {
        let conn = db.lock();
        index::remove_from_index(&conn, &rel).map_err(|e| format!("index error: {e}"))?;
    }
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

/// Move a NON-note file (asset) to a new vault-relative path — the drag-and-drop
/// path for pdfs/images/…. Notes must move through [`rename_note_core`]
/// instead (their inbound links get rewritten there); this is a plain fs move
/// plus parent creation. Returns the new normalized path.
pub fn move_file_core(root: &Path, from: &str, to: &str) -> Result<String, String> {
    let from = normalize_rel(from);
    let to = normalize_rel(to);
    if to.to_ascii_lowercase().ends_with(".md") {
        return Err(format!(
            "\"{to}\" is a note path — notes move via vault_rename_note so links follow."
        ));
    }
    if from.eq_ignore_ascii_case(&to) {
        return Ok(to);
    }
    let from_abs = safe_join(root, &from)?;
    let to_abs = safe_join(root, &to)?;
    if !from_abs.is_file() {
        return Err(format!("\"{from}\" does not exist."));
    }
    if to_abs.exists() {
        return Err(format!("\"{to}\" already exists."));
    }
    ensure_parents(root, &to_abs)?;
    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("move failed: {e}"))?;
    Ok(to)
}

/// Rename/move a note AND rewrite every inbound link vault-wide (Obsidian's
/// "Automatically update internal links"). Both sides are vault-relative
/// paths WITH the .md extension. Returns (new_path, files_rewritten).
pub fn rename_note_core(
    db: &Mutex<Connection>,
    root: &Path,
    from: &str,
    to: &str,
) -> Result<(String, usize), String> {
    let from = normalize_rel(from);
    let to = normalize_rel(to);
    if !to.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("note paths must end in .md: {to}"));
    }
    let from_abs = safe_join(root, &from)?;
    let to_abs = safe_join(root, &to)?;
    if !from_abs.is_file() {
        return Err(format!("\"{from}\" does not exist."));
    }
    // Case-only rename ("note.md" → "Note.md"): on a case-insensitive
    // filesystem the target "exists" (it IS the source) — allowed; the OS
    // rename just changes the casing and the index follows.
    let case_only = from.eq_ignore_ascii_case(&to);
    if !case_only && to_abs.exists() {
        return Err(format!("\"{to}\" already exists."));
    }

    // Phase 1 (DB lock): pre-rename resolver snapshot + new shortest
    // linktext computed against the post-rename file list.
    let files_pre = {
        let conn = db.lock();
        index::list_files(&conn).map_err(|e| format!("index error: {e}"))?
    };
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

    // Phase 2 (IO, no DB lock): rewrite inbound links in EVERY note (except
    // the mover), then move. EVERY failure path after the first rewrite —
    // a rewrite that fails, missing parents, the rename itself — restores
    // the originals: links pointing at a destination that never exists is
    // exactly the torn state this must not leave behind.
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
    let rollback = |applied: &[String], cause: String| -> String {
        let mut failures: Vec<String> = Vec::new();
        for rel in applied {
            let Some((_, _, original)) = rewritten.iter().find(|(r, _, _)| r == rel) else {
                continue;
            };
            let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Err(e) = atomic_write(&abs, original) {
                failures.push(format!("{rel}: {e}"));
            }
        }
        if failures.is_empty() {
            format!("{cause} (rewritten links restored)")
        } else {
            format!(
                "{cause}; ROLLBACK INCOMPLETE, {} file(s) left rewritten: {}",
                failures.len(),
                failures.join("; ")
            )
        }
    };
    let mut applied: Vec<String> = Vec::new();
    for (rel, content, _) in &rewritten {
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Err(e) = atomic_write(&abs, content) {
            return Err(rollback(&applied, format!("rename aborted: {e}")));
        }
        applied.push(rel.clone());
    }
    if let Err(e) = ensure_parents(root, &to_abs) {
        return Err(rollback(&applied, format!("rename aborted: {e}")));
    }
    if let Err(e) = std::fs::rename(&from_abs, &to_abs) {
        return Err(rollback(&applied, format!("rename failed: {e}")));
    }

    // Phase 3 (DB lock): drop the old row-set, index the moved file + every
    // rewritten one (their outgoing links changed).
    {
        let conn = db.lock();
        index::remove_from_index(&conn, &from).map_err(|e| format!("index error: {e}"))?;
    }
    index::reindex_file_locked(db, root, &to).map_err(|e| format!("index error: {e}"))?;
    for (rel, _, _) in &rewritten {
        index::reindex_file_locked(db, root, rel).map_err(|e| format!("index error: {e}"))?;
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

pub fn delete_folder_core(db: &Mutex<Connection>, root: &Path, rel: &str) -> Result<String, String> {
    let rel = normalize_rel(rel);
    if rel.is_empty() || !rel.contains('/') && rel.eq_ignore_ascii_case(".trash") {
        return Err("refusing to delete that folder".into());
    }
    let abs = safe_join(root, &rel)?;
    if !abs.is_dir() {
        return Err(format!("\"{rel}\" is not a folder."));
    }
    // Collect from disk (no DB), then move FIRST and drop the index rows
    // AFTER — the reverse order would leave the index missing notes that
    // still exist if the trash move failed (on Windows a directory rename
    // fails when ANY file inside is open in another program).
    let prefix = format!("{rel}/");
    let notes = index::collect_note_paths(&abs)
        .into_iter()
        .map(|p| format!("{prefix}{p}"))
        .collect::<Vec<_>>();
    let dest = trash_dest(root, &rel)?;
    std::fs::rename(&abs, &dest).map_err(|e| format!("trash move failed: {e}"))?;
    {
        let conn = db.lock();
        for n in &notes {
            index::remove_from_index(&conn, n).map_err(|e| format!("index error: {e}"))?;
        }
    }
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
        // full_scan takes the mutex itself and scopes it per phase — the
        // lock is NOT held across the whole scan.
        let result = index::full_scan(&db.0, &root);
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
    {
        // The vault may have been unbound or rebound while this debounced
        // batch sat queued — never write index rows for a root that is no
        // longer the watched vault.
        let state = app.state::<VaultState>();
        if state.root.lock().as_deref() != Some(root) {
            return;
        }
    }
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
    for rel in &rels {
        if rel.to_ascii_lowercase().ends_with(".md") {
            // File IO outside the lock, SQL inside (reindex_file_locked).
            let _ = index::reindex_file_locked(&db.0, root, rel);
        }
    }
    drop(db);
    let _ = app.emit("vault:changed", serde_json::json!({ "paths": rels }));
}

// ---------------------------------------------------------------------------
// Tauri commands (thin async wrappers over the cores above)
//
// Every command that touches the vault cores runs on the blocking thread
// pool: the cores do file IO and SQLite work, neither of which belongs on
// the async runtime that drives chat streaming. Each core scopes the DB
// mutex to its SQL phases internally.
// ---------------------------------------------------------------------------

/// Run `f` on the blocking pool with the real AppHandle.
async fn vault_blocking<T, F>(app: AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&app))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

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

fn stats_dto(conn: &Connection) -> std::result::Result<VaultStatsDto, rusqlite::Error> {
    index::stats(conn).map(|(notes, files, links, unresolved)| VaultStatsDto {
        notes,
        files,
        links,
        unresolved,
    })
}

#[tauri::command]
pub async fn vault_get_state(app: AppHandle) -> Result<VaultStateDto, String> {
    let root = current_root(&app).ok();
    let stats = match root {
        Some(_) => with_db(&app, |conn| stats_dto(conn).map_err(|e| e.to_string())).ok(),
        None => None,
    };
    Ok(VaultStateDto {
        root: root.map(|r| r.to_string_lossy().to_string()),
        stats,
    })
}

#[tauri::command]
pub async fn vault_bind(app: AppHandle, path: String) -> Result<String, String> {
    vault_blocking(app, move |app| bind_core(app, &path)).await
}

#[tauri::command]
pub async fn vault_unbind(app: AppHandle) -> Result<(), String> {
    vault_blocking(app, move |app| unbind_core(app)).await
}

#[tauri::command]
pub async fn vault_rescan(app: AppHandle) -> Result<(), String> {
    // Force a fresh root resolution so a rebind picks up the new folder.
    vault_blocking(app, move |app| {
        current_root(app)?;
        spawn_scan(app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn vault_tree(app: AppHandle) -> Result<Vec<TreeNode>, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        Ok(tree_core(&root))
    })
    .await
}

#[tauri::command]
pub async fn vault_read_note(app: AppHandle, path: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        read_note_core(&db, &root, &path)
    })
    .await
}

#[tauri::command]
pub async fn vault_read_binary(app: AppHandle, path: String) -> Result<(String, String), String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        read_binary_core(&root, &path)
    })
    .await
}

#[tauri::command]
pub async fn vault_create_note(app: AppHandle, path: String, content: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        create_note_core(&db, &root, &path, &content)
    })
    .await
}

#[tauri::command]
pub async fn vault_write_note(app: AppHandle, path: String, content: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        write_note_core(&db, &root, &path, &content)
    })
    .await
}

#[tauri::command]
pub async fn vault_delete_note(app: AppHandle, path: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        delete_note_core(&db, &root, &path)
    })
    .await
}

#[tauri::command]
pub async fn vault_move_file(app: AppHandle, from: String, to: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        move_file_core(&root, &from, &to)
    })
    .await
}

#[tauri::command]
pub async fn vault_import_file(app: AppHandle, src: String, dest: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        import_file_core(&root, &src, &dest)
    })
    .await
}

#[tauri::command]
pub async fn vault_write_binary(app: AppHandle, path: String, base64_data: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        use base64::Engine as _;
        let root = current_root(app)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_data)
            .map_err(|e| format!("invalid base64 payload: {e}"))?;
        if bytes.len() > MAX_BINARY_BYTES as usize {
            return Err(format!(
                "payload too large (limit is {} MB).",
                MAX_BINARY_BYTES / (1024 * 1024)
            ));
        }
        write_binary_core(&root, &path, &bytes)
    })
    .await
}

#[tauri::command]
pub async fn vault_rename_note(app: AppHandle, from: String, to: String) -> Result<(String, usize), String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        rename_note_core(&db, &root, &from, &to)
    })
    .await
}

#[tauri::command]
pub async fn vault_create_folder(app: AppHandle, path: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        create_folder_core(&root, &path)
    })
    .await
}

#[tauri::command]
pub async fn vault_delete_folder(app: AppHandle, path: String) -> Result<String, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        delete_folder_core(&db, &root, &path)
    })
    .await
}

#[tauri::command]
pub async fn vault_search(app: AppHandle, query: String, limit: Option<usize>) -> Result<Vec<index::SearchHit>, String> {
    vault_blocking(app, move |app| {
        current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        let conn = db.lock();
        index::search(&conn, &query, limit.unwrap_or(30).clamp(1, 100)).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn vault_note_meta(app: AppHandle, path: String) -> Result<index::NoteMeta, String> {
    vault_blocking(app, move |app| {
        let root = current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        let conn = db.lock();
        let rel = normalize_rel(&path);
        let mut meta = index::note_meta(&conn, &rel).map_err(|e| e.to_string())?;
        // Best-effort filesystem timestamps (unix epoch ms). `created()` is
        // Windows-only in practice; on error/unsupported both stay None.
        if let Ok(md) = std::fs::metadata(root.join(&rel)) {
            let to_unix_ms =
                |t: std::time::SystemTime| t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64);
            meta.modified_ms = md.modified().ok().and_then(to_unix_ms);
            meta.created_ms = md.created().ok().and_then(to_unix_ms);
        }
        Ok(meta)
    })
    .await
}

#[tauri::command]
pub async fn vault_graph(app: AppHandle, include_unresolved: Option<bool>, include_attachments: Option<bool>) -> Result<(Vec<index::GraphNode>, Vec<index::GraphEdge>), String> {
    vault_blocking(app, move |app| {
        current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        let conn = db.lock();
        index::graph(
            &conn,
            include_unresolved.unwrap_or(true),
            include_attachments.unwrap_or(false),
        )
        .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn vault_all_tags(app: AppHandle) -> Result<Vec<index::TagCount>, String> {
    vault_blocking(app, move |app| {
        current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        let conn = db.lock();
        index::all_tags(&conn).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn vault_stats(app: AppHandle) -> Result<VaultStatsDto, String> {
    vault_blocking(app, move |app| {
        current_root(app)?;
        let db = app.state::<DbState>().inner().0.clone();
        let conn = db.lock();
        stats_dto(&conn).map_err(|e| e.to_string())
    })
    .await
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
    fn safe_join_rejects_dot_names_anywhere() {
        // Config/trash territory must be unreachable through the one CRUD
        // path the AI tools share with the UI (the doc always promised this).
        let root = PathBuf::from("/tmp/vault");
        assert!(safe_join(&root, ".obsidian/workspace.json").is_err());
        assert!(safe_join(&root, ".trash/x.md").is_err());
        assert!(safe_join(&root, ".hidden").is_err());
        assert!(safe_join(&root, "sub/.hidden.md").is_err());
        assert!(safe_join(&root, "sub/.git/config").is_err());
    }

    #[test]
    fn move_file_moves_assets_and_refuses_notes() {
        let dir = std::env::temp_dir().join(format!("vault-movefile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("doc.pdf"), "pdf").unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("note.md"), "# n").unwrap();

        // Asset into a fresh folder: parents are made, path normalizes.
        let to = move_file_core(&dir, "doc.pdf", "nested/deep/doc.pdf").unwrap();
        assert_eq!(to, "nested/deep/doc.pdf");
        assert!(dir.join("nested/deep/doc.pdf").is_file());
        assert!(!dir.join("doc.pdf").exists());

        // Notes are refused: link rewrite lives in rename_note_core.
        assert!(move_file_core(&dir, "note.md", "nested/note.md").is_err());

        // Existing target and missing source are errors.
        assert!(move_file_core(&dir, "missing.pdf", "nested/x.pdf").is_err());
        std::fs::write(dir.join("dup.pdf"), "x").unwrap();
        assert!(move_file_core(&dir, "dup.pdf", "nested/deep/doc.pdf").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_file_copies_in_and_never_clobbers() {
        let dir = std::env::temp_dir().join(format!("vault-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join(format!("vault-import-src-{}.png", std::process::id()));
        std::fs::write(&outside, "png").unwrap();

        let rel = import_file_core(&dir, outside.to_str().unwrap(), "assets/pic.png").unwrap();
        assert_eq!(rel, "assets/pic.png");
        assert!(dir.join("assets/pic.png").is_file());

        // Same file again: suffixed, original untouched.
        let rel2 = import_file_core(&dir, outside.to_str().unwrap(), "assets/pic.png").unwrap();
        assert_eq!(rel2, "assets/pic - 1.png");

        // Missing source is an error.
        assert!(import_file_core(&dir, "Z:/nope.png", "assets/x.png").is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn write_binary_never_clobbers_and_refuses_notes() {
        let dir = std::env::temp_dir().join(format!("vault-writebin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let rel = write_binary_core(&dir, "assets/paste.png", b"one").unwrap();
        assert_eq!(rel, "assets/paste.png");
        // Same target again: suffixed, original preserved.
        let rel2 = write_binary_core(&dir, "assets/paste.png", b"two").unwrap();
        assert_eq!(rel2, "assets/paste - 1.png");
        assert_eq!(std::fs::read(dir.join("assets/paste.png")).unwrap(), b"one");

        // Notes are refused — they belong to the text write path.
        assert!(write_binary_core(&dir, "note.md", b"x").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_case_only_updates_disk_and_index() {
        let dir = std::env::temp_dir().join(format!("vault-caseonly-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.md"), "# cased").unwrap();
        let conn = parking_lot::Mutex::new(rusqlite::Connection::open_in_memory().unwrap());
        index::ensure_schema(&conn.lock()).unwrap();
        index::reindex_file(&conn.lock(), &dir, "note.md").unwrap();
        let (to, _) = rename_note_core(&conn, &dir, "note.md", "Note.md").unwrap();
        assert_eq!(to, "Note.md");
        let files = index::list_files(&conn.lock()).unwrap();
        assert_eq!(files.len(), 1, "old-cased row replaced, not duplicated");
        assert_eq!(files[0].path, "Note.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_failure_restores_rewritten_links() {
        let dir = std::env::temp_dir().join(format!("vault-rollback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.clone();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("B.md"), "the mover").unwrap();
        std::fs::write(root.join("A.md"), "links [[B]] here").unwrap();
        // "Blocker" is a FILE: ensure_parents of "Blocker/C.md" must fail
        // after the link rewrite phase — and the rewrite must be undone.
        std::fs::write(root.join("Blocker"), "not a folder").unwrap();
        let conn = parking_lot::Mutex::new(rusqlite::Connection::open_in_memory().unwrap());
        index::ensure_schema(&conn.lock()).unwrap();
        index::reindex_file(&conn.lock(), &root, "B.md").unwrap();
        index::reindex_file(&conn.lock(), &root, "A.md").unwrap();

        let err = rename_note_core(&conn, &root, "B.md", "Blocker/C.md").unwrap_err();
        assert!(err.contains("rename aborted"), "{err}");
        // The mover never moved, and A.md's link points where it did before.
        assert!(root.join("B.md").is_file());
        assert_eq!(std::fs::read_to_string(root.join("A.md")).unwrap(), "links [[B]] here");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_leaves_no_visible_tmp_and_sweep_removes_leftovers() {
        let dir = std::env::temp_dir().join(format!("vault-tmp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("Note.md");
        atomic_write(&target, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(leftovers, vec!["Note.md"], "no temp litter after a clean write");
        // A crashed write's leftover (dot-prefixed .tmp-<digits>) is swept…
        let junk = dir.join(".Note.md.tmp-1727000000123-7");
        std::fs::write(&junk, "partial").unwrap();
        // …but a real dot-file outside the pattern is NOT.
        let real = dir.join(".tmp-notes");
        std::fs::write(&real, "user data").unwrap();
        sweep_stale_tmp(&dir);
        assert!(!junk.exists());
        assert!(real.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_rel_cleans_forms() {
        assert_eq!(normalize_rel(" a\\b\\c.md "), "a/b/c.md");
        assert_eq!(normalize_rel("./x/y.md"), "x/y.md");
        assert_eq!(normalize_rel("dir/"), "dir");
    }
}
