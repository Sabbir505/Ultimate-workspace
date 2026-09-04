//! IPC commands for the persistent-memory UI (MEMORY_DESIGN_ARCHITECTURE.md
//! §12.2–12.3): the Settings → Memory browser (list/edit/delete/purge/export)
//! and the feature toggle. Args are camelCase on the JS side (Tauri maps
//! snake_case ↔ camelCase automatically).

use crate::db::{self};
use crate::memory::model::{origin, status, MemoryRecord};
use crate::DbState;
use tauri::State;
use uuid::Uuid;

type CmdResult<T> = Result<T, String>;

fn new_id() -> String {
    format!("mem_{}", Uuid::new_v4())
}

/// The full memory list for the browser UI. `includeInactive` pulls the
/// superseded/retired/flagged chain too (the UI filters client-side).
#[tauri::command]
pub async fn memory_list(
    include_inactive: Option<bool>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<MemoryRecord>> {
    let conn = db.0.lock();
    db::list_memories(&conn, "default", include_inactive.unwrap_or(true)).map_err(|e| e.to_string())
}

/// User edit from the browser: replaces content (and optionally importance).
/// A user edit is ground truth — `origin` becomes `user_created` and
/// confidence pins to 1.0 (design §8.3).
#[tauri::command]
pub async fn memory_update(
    memory_id: String,
    content: String,
    importance: Option<i64>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("content must not be empty".into());
    }
    let conn = db.0.lock();
    db::update_memory_content(&conn, &memory_id, &content, &[], 1.0).map_err(|e| e.to_string())?;
    if let Some(imp) = importance {
        conn.execute(
            "UPDATE memories SET importance = ?2, origin = ?3 WHERE id = ?1",
            rusqlite::params![memory_id, imp.clamp(1, 9), origin::USER_CREATED],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE memories SET origin = ?2 WHERE id = ?1",
            rusqlite::params![memory_id, origin::USER_CREATED],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = db::log_memory_op(&conn, "user", None, &content, "EDIT", &[memory_id], "");
    Ok(())
}

/// Soft-delete from the browser (retire — history preserved). Same operation
/// the agent's `memory_forget` tool uses.
#[tauri::command]
pub async fn memory_delete(memory_id: String, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_memory_status(&conn, &memory_id, status::RETIRED).map_err(|e| e.to_string())?;
    let _ = db::log_memory_op(&conn, "user", None, "", "FORGET", &[memory_id], "retired from UI");
    Ok(())
}

/// Hard purge — the one destructive path (design P3 yields to user erasure).
/// `project_only` scopes the purge to a project; `all` wipes the profile.
/// Only the fact of the purge is logged, not the content (§13.6).
#[tauri::command]
pub async fn memory_purge(
    profile: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<usize> {
    let profile = profile.unwrap_or_else(|| "default".into());
    let conn = db.0.lock();
    let n = db::purge_memories_for_profile(&conn, &profile).map_err(|e| e.to_string())?;
    let _ = db::log_memory_op(&conn, "user", None, "", "PURGE", &[], &format!("{n} memories purged"));
    Ok(n)
}

/// Evidence quotes for one memory (provenance viewer).
#[tauri::command]
pub async fn memory_evidence(
    memory_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Vec<(String, i64, String)>> {
    let conn = db.0.lock();
    db::evidence_for_memory(&conn, &memory_id).map_err(|e| e.to_string())
}

/// Export the whole store as JSON (portability / user data rights, §13).
#[tauri::command]
pub async fn memory_export(db: State<'_, DbState>) -> CmdResult<String> {
    let conn = db.0.lock();
    let mems = db::list_memories(&conn, "default", true).map_err(|e| e.to_string())?;
    let ops = db::list_memory_ops(&conn, 500).map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&serde_json::json!({
        "exported_at": db::now_ts(),
        "memories": mems,
        "recent_ops": ops,
    }))
    .map_err(|e| e.to_string())
}

/// Feature status for the settings toggle.
#[tauri::command]
pub async fn memory_status(db: State<'_, DbState>) -> CmdResult<serde_json::Value> {
    let conn = db.0.lock();
    Ok(serde_json::json!({
        "enabled": crate::memory::memory_enabled(&conn),
        "active_count": db::count_active_memories(&conn, "default").unwrap_or(0),
    }))
}

#[tauri::command]
pub async fn memory_set_enabled(enabled: bool, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, crate::memory::SETTING_ENABLED, if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

/// Create a memory by hand from the UI (user-created facts skip the judge —
/// the user IS the ground truth; confidence 1.0).
#[tauri::command]
pub async fn memory_create(
    content: String,
    kind: Option<String>,
    importance: Option<i64>,
    db: State<'_, DbState>,
) -> CmdResult<MemoryRecord> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("content must not be empty".into());
    }
    let kind = kind.unwrap_or_else(|| "fact".into());
    if !crate::memory::model::kind::is_valid(&kind) {
        return Err(format!("invalid kind: {kind}"));
    }
    let mut rec = MemoryRecord::new_extracted(
        &new_id(),
        &kind,
        None,
        "user",
        &content,
        importance.unwrap_or(6).clamp(1, 9),
        None,
    );
    rec.origin = origin::USER_CREATED.to_string();
    rec.confidence = 1.0;
    {
        let conn = db.0.lock();
        db::insert_memory(&conn, &rec).map_err(|e| e.to_string())?;
        let _ = db::log_memory_op(&conn, "user", None, &content, "CREATE", &[rec.id.clone()], "");
    }
    Ok(rec)
}
