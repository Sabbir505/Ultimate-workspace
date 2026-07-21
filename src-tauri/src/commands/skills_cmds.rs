//! Installed skills/loops commands — see installed_skills.rs for the design.

use crate::installed_skills::{self, InstalledSkill};

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn list_installed_skills() -> CmdResult<Vec<InstalledSkill>> {
    Ok(installed_skills::list_installed("skills"))
}

#[tauri::command]
pub fn list_installed_loops() -> CmdResult<Vec<InstalledSkill>> {
    Ok(installed_skills::list_installed("loops"))
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

/// Accepts both singular ("skill"/"loop") and plural forms from the frontend.
fn kind_key(kind: &str) -> String {
    match kind.trim_end_matches('s') {
        "loop" => "loops".to_string(),
        _ => "skills".to_string(),
    }
}
