//! Tauri commands for the project wiki. All of them take the project root;
//! the wiki keys on the canonicalized path. Follows the docs_index.rs
//! command conventions (`CmdResult<T> = Result<T, String>`, background job +
//! progress events for the build).

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::{canonical_root_str, WikiJobRegistry};
use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// What the Wiki surface needs in one call: project state, the page list,
/// and the settings the panel toggles.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStatus {
    pub project: Option<db::WikiProject>,
    pub pages: Vec<db::WikiPage>,
    pub auto_update: bool,
    pub layer_index: bool,
    /// Whether ANY wiki build model resolves right now (drives the empty
    /// state's "pick a model" hint instead of a doomed Build button).
    pub has_model: bool,
    /// A build/update job is in the registry RIGHT NOW. The frontend's
    /// progress store only knows about events it has HEARD — an app reload
    /// (or a slow harness build that started before the surface mounted)
    /// leaves it blank, and a second Build click then dies on the registry's
    /// "already running" guard. The status snapshot closes that gap.
    pub job_running: bool,
}

fn status_for(
    db: &DbState,
    registry: &std::sync::Arc<super::WikiJobRegistry>,
    path: &str,
) -> Result<WikiStatus, String> {
    let job_running = registry.active.lock().contains_key(path);
    let conn = db.0.lock();
    let project = db::wiki_get_project_by_path(&conn, path)
        .map_err(|e| e.to_string())?;
    let pages = match &project {
        Some(p) => db::wiki_list_pages(&conn, &p.id).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    let flag = |key: &str, default: bool| {
        db::get_setting(&conn, key)
            .ok()
            .flatten()
            .map(|v| v.trim() != "false")
            .unwrap_or(default)
    };
    let has_model = super::resolve_build_model(&conn).is_ok();
    Ok(WikiStatus {
        auto_update: flag(super::SETTING_AUTO_UPDATE, true),
        layer_index: flag(super::SETTING_LAYER_INDEX, true),
        has_model,
        job_running,
        project,
        pages,
    })
}

/// Rollups for every wiki — the tool-panel project list (pages grouped
/// UNDER projects needs counts, not page rows).
#[tauri::command(async)]
pub fn wiki_list_all(db: State<'_, DbState>) -> CmdResult<Vec<crate::db::WikiProjectSummary>> {
    let conn = db.0.lock();
    db::wiki_list_project_summaries(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn wiki_get(
    path: String,
    db: State<'_, DbState>,
    registry: State<'_, std::sync::Arc<super::WikiJobRegistry>>,
) -> CmdResult<WikiStatus> {
    let canonical = canonical_root_str(&path)?;
    status_for(&db, &registry, &canonical)
}

/// Kick off a full build in the background; progress arrives on
/// `wiki:build:progress`. Returns immediately — the UI reacts to events.
#[tauri::command(async)]
pub fn wiki_build_start(
    app: AppHandle,
    path: String,
    registry: State<'_, Arc<WikiJobRegistry>>,
) -> CmdResult<()> {
    let canonical = canonical_root_str(&path)?;
    // Fail fast on the two synchronous mistakes: no model, double build.
    {
        let db = app.state::<DbState>();
        let conn = db.0.lock();
        super::resolve_build_model(&conn)?;
    }
    if registry.active.lock().contains_key(&canonical) {
        return Err("a wiki build or update is already running for this project".to_string());
    }
    let root = PathBuf::from(canonical);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::run_build(&app, &root).await {
            if e != "cancelled" {
                crate::relay_eprintln!("[wiki] build failed: {e}");
            }
        }
    });
    Ok(())
}

/// Fire the cancel flag for the project's in-flight job (no-op when idle).
/// Returns whether a signal was actually delivered.
///
/// The registry entry is deliberately NOT removed here. `cancelled()` is
/// only polled between model calls, so a cancelled job keeps running until
/// its current (up to 10-minute) call returns — and removing the entry in
/// the meantime let a second build acquire the slot and interleave its page
/// writes with the dying build's, producing a page set mixed from two
/// generations with no error anywhere. `JobGuard` frees the entry the
/// moment the task actually ends.
#[tauri::command(async)]
pub fn wiki_cancel(path: String, registry: State<'_, std::sync::Arc<super::WikiJobRegistry>>) -> CmdResult<bool> {
    let canonical = canonical_root_str(&path)?;
    let active = registry.active.lock();
    if let Some(slot) = active.get(&canonical) {
        slot.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

/// Run the freshness pass inline (the "Update now" button). Usually fast:
/// the diff runs before any model call, so up-to-date wikis return at once.
#[tauri::command(async)]
pub async fn wiki_update(app: AppHandle, path: String) -> CmdResult<super::UpdateReport> {
    let canonical = canonical_root_str(&path)?;
    let root = PathBuf::from(canonical);
    super::run_update(&app, &root).await
}

#[tauri::command(async)]
pub fn wiki_read_page(
    path: String,
    slug: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<db::WikiPageFull>> {
    let canonical = canonical_root_str(&path)?;
    let conn = db.0.lock();
    let Some(project) = db::wiki_get_project_by_path(&conn, &canonical)
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    db::wiki_get_page_full(&conn, &project.id, &slug).map_err(|e| e.to_string())
}

/// Delete the whole wiki for a project (pages, claims, project row).
#[tauri::command(async)]
pub fn wiki_remove(path: String, db: State<'_, DbState>) -> CmdResult<bool> {
    let canonical = canonical_root_str(&path)?;
    let conn = db.0.lock();
    let Some(project) = db::wiki_get_project_by_path(&conn, &canonical)
        .map_err(|e| e.to_string())?
    else {
        return Ok(false);
    };
    db::wiki_remove_wiki(&conn, &project.id).map_err(|e| e.to_string())?;
    Ok(true)
}
