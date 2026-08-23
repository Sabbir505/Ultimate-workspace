//! Installed skills/loops commands — see installed_skills.rs for the design.

use crate::installed_skills::{self, AvailableSkill, InstalledSkill};

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn list_installed_skills() -> CmdResult<Vec<InstalledSkill>> {
    // Directory scan over every skill root (home + plugin caches) — keep it
    // off the main thread so opening the Skills Library never blocks the UI.
    tauri::async_runtime::spawn_blocking(|| installed_skills::list_installed("skills"))
        .await
        .map_err(|e| format!("skill scan join failed: {e}"))
}

#[tauri::command]
pub async fn list_installed_loops() -> CmdResult<Vec<InstalledSkill>> {
    tauri::async_runtime::spawn_blocking(|| installed_skills::list_installed("loops"))
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
pub fn read_installed_skill(slug: String, kind: String) -> CmdResult<Option<String>> {
    Ok(installed_skills::read_installed(&slug, &kind_key(&kind)))
}

#[tauri::command]
pub fn save_installed_skill(slug: String, kind: String, content: String) -> CmdResult<()> {
    installed_skills::save_installed(&slug, &kind_key(&kind), &content)
}

#[tauri::command]
pub fn create_installed_skill(name: String, kind: String, content: String) -> CmdResult<InstalledSkill> {
    installed_skills::create_installed(&name, &kind_key(&kind), &content)
}

#[tauri::command]
pub fn delete_installed_skill(slug: String, kind: String) -> CmdResult<()> {
    installed_skills::delete_installed(&slug, &kind_key(&kind))
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
