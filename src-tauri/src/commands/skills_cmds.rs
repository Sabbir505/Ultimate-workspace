//! Installed skills/loops commands — see installed_skills.rs for the design.

use crate::installed_skills::{self, AvailableSkill, InstalledSkill};
use std::path::PathBuf;

type CmdResult<T> = Result<T, String>;

/// The open projects' directories. An agent launched with a project as its cwd
/// writes a new skill into that project (`.claude/skills/<slug>/SKILL.md`), so
/// every skill command has to consider those roots — otherwise a skill the
/// agent just authored is invisible to the library, and unresolvable by slug
/// when the user opens it.
fn project_paths(db: &crate::DbState) -> Vec<PathBuf> {
    let conn = db.0.lock();
    crate::db::list_projects(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|p| PathBuf::from(p.path))
        .collect()
}

#[tauri::command]
pub async fn list_installed_skills(db: tauri::State<'_, crate::DbState>) -> CmdResult<Vec<InstalledSkill>> {
    let projects = project_paths(&db);
    // Directory scan over every skill root (home + plugin caches + open
    // projects) — keep it off the main thread so opening the Skills Library
    // never blocks the UI.
    tauri::async_runtime::spawn_blocking(move || {
        installed_skills::list_installed_with_projects("skills", &projects)
    })
    .await
    .map_err(|e| format!("skill scan join failed: {e}"))
}

#[tauri::command]
pub async fn list_installed_loops(db: tauri::State<'_, crate::DbState>) -> CmdResult<Vec<InstalledSkill>> {
    let projects = project_paths(&db);
    tauri::async_runtime::spawn_blocking(move || {
        installed_skills::list_installed_with_projects("loops", &projects)
    })
    .await
    .map_err(|e| format!("loop scan join failed: {e}"))
}

/// Every skill the chat `/` menu can offer: on-disk harness skills merged with
/// the built-in doc/pptx/pdf/diagram skills (on-disk wins on slug collision).
#[tauri::command]
pub fn list_chat_skills() -> CmdResult<Vec<AvailableSkill>> {
    Ok(installed_skills::list_all_skills())
}

#[tauri::command]
pub fn read_installed_skill(
    slug: String,
    kind: String,
    db: tauri::State<'_, crate::DbState>,
) -> CmdResult<Option<String>> {
    Ok(installed_skills::read_installed_with(
        &slug,
        &kind_key(&kind),
        &project_paths(&db),
    ))
}

#[tauri::command]
pub fn save_installed_skill(
    slug: String,
    kind: String,
    content: String,
    db: tauri::State<'_, crate::DbState>,
) -> CmdResult<()> {
    installed_skills::save_installed_with(&slug, &kind_key(&kind), &content, &project_paths(&db))
}

#[tauri::command]
pub fn create_installed_skill(name: String, kind: String, content: String) -> CmdResult<InstalledSkill> {
    installed_skills::create_installed(&name, &kind_key(&kind), &content)
}

#[tauri::command]
pub fn delete_installed_skill(
    slug: String,
    kind: String,
    db: tauri::State<'_, crate::DbState>,
) -> CmdResult<()> {
    installed_skills::delete_installed_with(&slug, &kind_key(&kind), &project_paths(&db))
}

/// Make every installed skill/loop global — copy any entry that currently
/// lives in only one harness dir into the other so its source becomes "both"
/// and any harness can invoke it. Returns the number of entries mirrored.
#[tauri::command]
pub fn make_installed_global(kind: String) -> CmdResult<usize> {
    installed_skills::make_installed_global(&kind_key(&kind))
}

/// Accepts both singular ("skill"/"loop") and plural forms from the frontend.
fn kind_key(kind: &str) -> String {
    match kind.trim_end_matches('s') {
        "loop" => "loops".to_string(),
        _ => "skills".to_string(),
    }
}
