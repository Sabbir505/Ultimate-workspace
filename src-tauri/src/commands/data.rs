//! Settings, skills, quick actions, secrets, cost, export and file-peek
//! commands (CONTRACT.md last section).

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::db;
use crate::secrets;
use crate::types::{CostEvent, CostRollups, QuickAction, Skill, WorkspaceRecord};
use crate::{DbState, PtyState};

type CmdResult<T> = Result<T, String>;

/// `read_file_text` hard cap (CONTRACT.md: ~512KB).
const READ_FILE_CAP: u64 = 512 * 1024;

// ---- settings ----

#[tauri::command]
pub fn get_setting(key: String, db: State<DbState>) -> CmdResult<Option<String>> {
    let conn = db.0.lock();
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

/// Absolute path of the chat database. Defaults to `<app data dir>/conduit.db`,
/// overridable via `storage.dbDir` (Settings → Data) — the directory is read at
/// startup and on every `set_chat_db_dir` call.
#[tauri::command]
pub fn get_chat_db_path(app: AppHandle) -> CmdResult<String> {
    Ok(crate::db::chat_db_path(&app)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string())
}

/// Settings key for the user-configured chat database directory (Settings →
/// Data). Empty/unset = default `<app data dir>`.
pub const CHAT_DB_DIR_SETTING_KEY: &str = "storage.dbDir";

/// Move the chat database to a new directory (or back to the app data dir when
/// `None`). The DB is checkpointed, copied to the destination, and the live
/// connection is swapped in place — no restart required. The destination
/// directory is created if missing; an existing `conduit.db` there is
/// overwritten only after a backup-free move (the user picked this location).
///
/// ASYNC on purpose: the file copy + full reopen (which runs all migrations)
/// must NOT block the main thread — a synchronous command here froze the UI
/// hard enough to read as an app crash. All heavy work runs on the async
/// runtime's thread pool.
#[tauri::command]
pub async fn set_chat_db_dir(
    dir: Option<String>,
    app: AppHandle,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let current = crate::db::chat_db_path(&app).map_err(|e| e.to_string())?;
    // The setting value stored in the DB (empty string = default location).
    let setting_value = dir.as_deref().unwrap_or("").trim().to_string();
    let target_dir = match dir.as_deref() {
        Some(d) => {
            let d = d.trim();
            if d.is_empty() {
                // Empty string = reset to the app-data default.
                app.path()
                    .app_data_dir()
                    .map_err(|e| format!("no app data dir: {e}"))?
            } else {
                std::path::PathBuf::from(d)
            }
        }
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data dir: {e}"))?,
    };
    let target = target_dir.join("conduit.db");

    // Same location → nothing to do (still update the setting so a blank
    // override is cleared).
    if target == current {
        let conn = db.0.lock();
        let _ = db::set_setting(&conn, CHAT_DB_DIR_SETTING_KEY, &setting_value);
        return Ok(());
    }

    // The heavy sequence (checkpoint → copy → reopen → swap) runs off the
    // main thread so the UI stays live. The DbState Arc is cloned in; the
    // connection swap happens under the lock at the end.
    let db_arc = db.0.clone();
    let current2 = current.clone();
    let target2 = target.clone();
    let target_dir2 = target_dir.clone();
    let setting_value2 = setting_value.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // 1. Checkpoint the WAL so the main .db file holds every committed
        //    row — the copy must be a complete snapshot, not a WAL-less stub.
        {
            let conn = db_arc.lock();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| format!("checkpoint failed: {e}"))?;
        }

        // 2. Copy ALL of the SQLite files (main + WAL + SHM) so the moved DB
        //    is complete even if a write lands between checkpoint and copy.
        std::fs::create_dir_all(&target_dir2)
            .map_err(|e| format!("failed to create directory: {e}"))?;
        for suffix in ["", "-wal", "-shm"] {
            let src = std::path::PathBuf::from(format!("{}{}", current2.display(), suffix));
            if src.exists() {
                let dst = std::path::PathBuf::from(format!("{}{}", target2.display(), suffix));
                std::fs::copy(&src, &dst)
                    .map_err(|e| format!("failed to copy {suffix}: {e}"))?;
            }
        }

        // 3. Reopen the copy (runs migrations on it) and swap it into the
        //    shared connection. Consumers lock per-use, so replacing the
        //    Connection inside the Arc is safe — the next lock sees the new
        //    location. The setting is written on the NEW connection so the
        //    moved DB records its own location (the old file is stale after
        //    the swap).
        let new_conn = crate::db::open(&target2).map_err(|e| e.to_string())?;
        {
            let mut conn = db_arc.lock();
            let _ = db::set_setting(&conn, CHAT_DB_DIR_SETTING_KEY, &setting_value2);
            *conn = new_conn;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("database move task failed: {e}"))?
    .map_err(|e| e)?;

    // A relocated DB means the configured artifacts dir may be stale relative
    // to expectations, but that's independent — leave it. Sweep expired
    // artifacts against the (new) DB so retention runs on the moved file.
    crate::chat::commands::sweep_expired_artifacts(&db.0);

    Ok(())
}

/// Aggregate paths + sizes for the Settings → Data panel: chat DB (with
/// storage.dbDir override info) and artifacts dir. ASYNC: the recursive
/// directory walk must not run on the main thread (a large artifacts folder
/// would freeze the UI).
#[tauri::command]
pub async fn get_data_paths(app: AppHandle, db: State<'_, DbState>) -> CmdResult<DataPaths> {
    let db_path = crate::db::chat_db_path(&app).map_err(|e| e.to_string())?;
    let db_size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    let artifacts = crate::chat::dispatch::artifacts_dir(&app);
    let artifacts2 = artifacts.clone();
    let artifacts_size = tauri::async_runtime::spawn_blocking(move || dir_size(&artifacts2))
        .await
        .unwrap_or(0);
    Ok(DataPaths {
        chat_db_path: db_path.to_string_lossy().to_string(),
        chat_db_size: db_size,
        artifacts_dir: artifacts.to_string_lossy().to_string(),
        artifacts_size,
    })
}

/// Recursive directory size (bytes). Only ever runs on a worker thread via
/// `get_data_paths` — a deep or large artifacts tree must not block the UI.
fn dir_size(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Ok(meta) = p.metadata() {
                if meta.is_dir() {
                    total += dir_size(&p);
                } else {
                    total += meta.len();
                }
            }
        }
    }
    total
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPaths {
    pub chat_db_path: String,
    pub chat_db_size: u64,
    pub artifacts_dir: String,
    pub artifacts_size: u64,
}

// ---- skills ----

#[tauri::command]
pub fn list_skills(project_id: Option<String>, db: State<DbState>) -> CmdResult<Vec<Skill>> {
    let conn = db.0.lock();
    db::list_skills(&conn, project_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_skill(
    name: String,
    slash_command: String,
    content: String,
    scope: String,
    db: State<DbState>,
) -> CmdResult<Skill> {
    let conn = db.0.lock();
    db::create_skill(&conn, &name, &slash_command, &content, &scope).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_skill(
    id: String,
    name: String,
    slash_command: String,
    content: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_skill(&conn, &id, &name, &slash_command, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_skill(id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_skill(&conn, &id).map_err(|e| e.to_string())
}

// ---- quick actions ----

#[tauri::command]
pub fn list_quick_actions(project_id: String, db: State<DbState>) -> CmdResult<Vec<QuickAction>> {
    let conn = db.0.lock();
    db::list_quick_actions(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_quick_action(
    project_id: String,
    label: String,
    command: String,
    keybinding: Option<String>,
    run_on_worktree: Option<bool>,
    db: State<DbState>,
) -> CmdResult<QuickAction> {
    let conn = db.0.lock();
    db::create_quick_action(
        &conn,
        &project_id,
        &label,
        &command,
        keybinding.as_deref(),
        run_on_worktree.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_quick_action(
    id: String,
    label: String,
    command: String,
    keybinding: Option<String>,
    run_on_worktree: Option<bool>,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_quick_action(
        &conn,
        &id,
        &label,
        &command,
        keybinding.as_deref(),
        run_on_worktree.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_quick_action(id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_quick_action(&conn, &id).map_err(|e| e.to_string())
}

// ---- secrets (values live in the OS keychain — see secrets.rs) ----

#[tauri::command]
pub fn set_secret(
    project_id: String,
    key: String,
    value: String,
    db: State<DbState>,
) -> CmdResult<()> {
    if key.trim().is_empty() {
        return Err("secret key must not be empty".to_string());
    }
    let conn = db.0.lock();
    secrets::set_secret(&conn, &project_id, &key, &value)
}

#[tauri::command]
pub fn delete_secret(project_id: String, key: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    secrets::delete_secret(&conn, &project_id, &key)
}

#[tauri::command]
pub fn list_secret_keys(project_id: String, db: State<DbState>) -> CmdResult<Vec<String>> {
    let conn = db.0.lock();
    secrets::list_secret_keys(&conn, &project_id)
}

// ---- cost ----

#[tauri::command]
pub fn get_cost_events(
    session_id: Option<String>,
    limit: Option<i64>,
    before_ts: Option<i64>,
    db: State<DbState>,
) -> CmdResult<Vec<CostEvent>> {
    let conn = db.0.lock();
    db::get_cost_events(&conn, session_id.as_deref(), limit, before_ts).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_cost_rollups(range_days: Option<u32>, db: State<DbState>) -> CmdResult<CostRollups> {
    let days = match range_days.unwrap_or(30) {
        7 | 30 | 90 => range_days.unwrap_or(30),
        _ => 30,
    };
    let conn = db.0.lock();
    db::get_cost_rollups_v2(&conn, days).map_err(|e| e.to_string())
}

// ---- export & file peek ----

/// Formats the pane's ANSI-stripped rolling transcript as markdown. The
/// transcript is code-fenced verbatim: reliably segmenting user turns from
/// agent output in raw scrollback is not feasible without parsing each
/// harness's TUI redraws, so per CONTRACT.md this is intentionally best
/// effort — the fence preserves content without inventing structure.
#[tauri::command]
pub fn export_session_markdown(pane_id: String, pty: State<PtyState>) -> CmdResult<String> {
    let transcript = pty
        .0
        .transcript(&pane_id)
        .ok_or_else(|| format!("no transcript for pane {pane_id}"))?;
    let mut md = String::from("# Conduit Session Transcript\n\n");
    md.push_str("```text\n");
    md.push_str(transcript.trim_end());
    md.push_str("\n```\n");
    Ok(md)
}

/// Read-only file peek (PRD §7.9): hard cap ~512KB, refuses binary-ish
/// content (NUL byte) rather than spewing garbage into the webview.
///
/// SECURITY: the path must resolve to a location inside a registered project
/// root (or the app data dir). This prevents a compromised renderer from
/// reading arbitrary files like ~/.ssh/id_rsa or other apps' credentials.
#[tauri::command]
pub fn read_file_text(path: String, app: AppHandle, db: State<DbState>) -> CmdResult<String> {
    let p = Path::new(&path);
    // Resolve to canonical form to dodge symlinks that escape the project root.
    let canon = p
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    if !is_path_allowed(&canon, &app, &db) {
        return Err("path is outside allowed project roots".to_string());
    }
    let meta = fs::metadata(&canon).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    if meta.len() > READ_FILE_CAP {
        return Err(format!(
            "file too large for peek viewer ({} bytes > {} byte cap)",
            meta.len(),
            READ_FILE_CAP
        ));
    }
    let bytes = fs::read(&canon).map_err(|e| format!("cannot read file: {e}"))?;
    if bytes.contains(&0) {
        return Err("refusing to read binary file".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Check that `path` is under at least one registered project root, or
/// under the Tauri app data directory (for Conduit-internal files like
/// artifact exports). Case-insensitive on Windows.
fn is_path_allowed(path: &Path, app: &AppHandle, db: &DbState) -> bool {
    // Allow anything under the app data dir (Conduit's own artifacts/config).
    if let Ok(data_dir) = app.path().app_data_dir() {
        if let Ok(data_canon) = data_dir.canonicalize() {
            if crate::util::path_starts_with_ci(path, &data_canon) {
                return true;
            }
        }
    }
    // Allow anything under a registered project root.
    let conn = db.0.lock();
    if let Ok(projs) = db::list_projects(&conn) {
        for proj in &projs {
            let proj_path = Path::new(&proj.path);
            if let Ok(proj_canon) = proj_path.canonicalize() {
                if crate::util::path_starts_with_ci(path, &proj_canon) {
                    return true;
                }
            }
        }
    }
    // Allow anything under a session worktree. Worktrees are SIBLINGS of the
    // project root (`<parent>/<name>-<branch>`), so they legitimately sit
    // outside every project prefix — allowlist the exact recorded paths
    // instead of loosening the prefix check (which would also pass any
    // same-prefix sibling like `<name>-evil`).
    if let Ok(sessions) = db::list_sessions(&conn, None) {
        for sess in &sessions {
            if let Some(wt) = &sess.worktree_path {
                if let Ok(wt_canon) = Path::new(wt).canonicalize() {
                    if crate::util::path_starts_with_ci(path, &wt_canon) {
                        return true;
                    }
                }
            }
        }
    }
    // Allow anything under the configured artifacts dir (Settings →
    // Storage & Data, `storage.artifactsDir`) when set.
    if let Some(configured) = crate::chat::dispatch::configured_artifacts_dir(&conn) {
        let _ = fs::create_dir_all(&configured);
        if let Ok(conf_canon) = configured.canonicalize() {
            if crate::util::path_starts_with_ci(path, &conf_canon) {
                return true;
            }
        }
    }
    drop(conn);
    // Allow anything under the user's Documents/Conduit dir (artifact exports).
    if let Some(docs_dir) = dirs::document_dir() {
        let conduit_docs = docs_dir.join("Conduit");
        if let Ok(docs_canon) = conduit_docs.canonicalize() {
            if crate::util::path_starts_with_ci(path, &docs_canon) {
                return true;
            }
        }
    }
    false
}

// ---- workspaces (pane layout save/restore) ----

#[tauri::command]
pub fn list_workspaces(project_id: String, db: State<DbState>) -> CmdResult<Vec<WorkspaceRecord>> {
    let conn = db.0.lock();
    db::list_workspaces(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_workspace(
    project_id: String,
    name: String,
    data: String,
    db: State<DbState>,
) -> CmdResult<WorkspaceRecord> {
    let conn = db.0.lock();
    // Upsert by (project_id, name): if a workspace with this name exists,
    // update it; otherwise create a new one.
    let existing = db::list_workspaces(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.name.eq_ignore_ascii_case(&name));

    if let Some(ws) = existing {
        db::update_workspace(&conn, &ws.id, &name, &data).map_err(|e| e.to_string())?;
        // Re-read so return value is accurate.
        db::get_workspace(&conn, &ws.id).map_err(|e| e.to_string())
    } else {
        let id = db::new_id();
        db::create_workspace(&conn, &id, &project_id, &name, &data)
            .map_err(|e| e.to_string())?;
        db::get_workspace(&conn, &id).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn delete_workspace(id: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_workspace(&conn, &id).map_err(|e| e.to_string())
}

/// Pop a chat session out into its own OS window (roadmap #17). The new
/// window loads the same app with `?popout=chat&session=<id>` so App.tsx
/// renders a standalone ChatView (no sidebar, no tool panel).
#[tauri::command]
pub fn pop_out_chat(app: AppHandle, session_id: String) -> CmdResult<()> {
    use tauri::webview::WebviewWindowBuilder;
    let label = format!("chat-{}", session_id.chars().take(16).collect::<String>());
    // If the window already exists, just focus it.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = format!("index.html?popout=chat&session={session_id}");
    WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title("Conduit — Chat")
        .inner_size(720.0, 820.0)
        .min_inner_size(420.0, 480.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("could not open pop-out window: {e}"))?;
    Ok(())
}
