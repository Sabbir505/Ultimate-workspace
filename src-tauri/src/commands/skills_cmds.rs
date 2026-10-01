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
        // A project on an unmounted volume (ejected USB, offline share) costs
        // a filesystem timeout on every scan, and adding project roots made
        // the scan run on every skill command. `is_dir()` is a cheap stat on
        // a local path and drops the unreachable roots before `read_dir`
        // touches them. UNC paths are a remote round-trip by nature; those
        // stay, bounded by the `spawn_blocking` hops below rather than
        // stalling the UI thread.
        .filter(|p| !p.path.is_empty() && PathBuf::from(&p.path).is_dir())
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
///
/// `async` = run the body on a worker thread. A plain `fn` command runs inline
/// on the IPC/UI thread (see the rule in lib.rs), and this one walks the home
/// harness dirs — on the hot path, since the composer's `/` menu calls it every
/// time the picker opens.
#[tauri::command(async)]
pub fn list_chat_skills() -> CmdResult<Vec<AvailableSkill>> {
    Ok(installed_skills::list_all_skills())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn save_installed_skill(
    slug: String,
    kind: String,
    content: String,
    db: tauri::State<'_, crate::DbState>,
) -> CmdResult<()> {
    installed_skills::save_installed_with(&slug, &kind_key(&kind), &content, &project_paths(&db))
}

#[tauri::command(async)]
pub fn create_installed_skill(name: String, kind: String, content: String) -> CmdResult<InstalledSkill> {
    installed_skills::create_installed(&name, &kind_key(&kind), &content)
}

/// Install a skill from a user-pasted http(s) URL (§4.3.4 marketplace v1):
/// a raw SKILL.md, a GitHub blob/tree URL, or a .zip holding one skill.
/// USER-initiated (the Skills Library) — the fetch target is the user's own
/// paste, so no agent-SSRF guard applies. Network work runs on this async
/// command's worker thread.
#[tauri::command(async)]
pub async fn install_skill_from_url(url: String, kind: String) -> CmdResult<installed_skills::SkillInstallResult> {
    installed_skills::install_from_url(&url, &kind).await
}

#[tauri::command(async)]
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
#[tauri::command(async)]
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
