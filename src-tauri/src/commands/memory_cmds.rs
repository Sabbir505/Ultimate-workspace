//! IPC commands for the persistent-memory UI (MEMORY_DESIGN_ARCHITECTURE.md
//! §12.2–12.3): the Settings → Memory browser (list/edit/delete/purge/export),
//! the feature toggle, and the single memory document (view/save). Args are
//! camelCase on the JS side (Tauri maps snake_case ↔ camelCase automatically).

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
    apply_memory_user_edit(&conn, &memory_id, &content, importance)?;
    invalidate_document(&conn);
    Ok(())
}

/// The two dependent writes of a user edit (content, then origin/importance)
/// as ONE transaction (E6): the second UPDATE failing used to leave a
/// half-applied edit — new content with the old origin/importance. Mirrors
/// `delete_chat_message`'s unchecked_transaction pattern (B-29/B-31).
fn apply_memory_user_edit(
    conn: &rusqlite::Connection,
    memory_id: &str,
    content: &str,
    importance: Option<i64>,
) -> CmdResult<()> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    db::update_memory_content(&tx, memory_id, content, &[], 1.0).map_err(|e| e.to_string())?;
    if let Some(imp) = importance {
        tx.execute(
            "UPDATE memories SET importance = ?2, origin = ?3 WHERE id = ?1",
            rusqlite::params![memory_id, imp.clamp(1, 9), origin::USER_CREATED],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE memories SET origin = ?2 WHERE id = ?1",
            rusqlite::params![memory_id, origin::USER_CREATED],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = db::log_memory_op(&tx, "user", None, content, "EDIT", &[memory_id.to_string()], "");
    tx.commit().map_err(|e| e.to_string())
}

/// Soft-delete from the browser (retire — history preserved). Same operation
/// the agent's `memory_forget` tool uses.
#[tauri::command]
pub async fn memory_delete(memory_id: String, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_memory_status(&conn, &memory_id, status::RETIRED).map_err(|e| e.to_string())?;
    let _ = db::log_memory_op(&conn, "user", None, "", "FORGET", &[memory_id], "retired from UI");
    invalidate_document(&conn);
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
    invalidate_document(&conn);
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
    let document = crate::memory::document::stored_document(&conn);
    serde_json::to_string_pretty(&serde_json::json!({
        "exported_at": db::now_ts(),
        "document": document,
        "memories": mems,
        "recent_ops": ops,
    }))
    .map_err(|e| e.to_string())
}

/// Feature status for the settings toggle. `document` is the EFFECTIVE memory
/// document: the stored (LLM-merged or user-edited) text, or a deterministic
/// render from the records when none is stored — the STORE the send path
/// loads from on demand (identity core + query-matched records per turn, see
/// `memory::on_demand_injection`), so the UI can show and edit one
/// human-readable field.
#[tauri::command]
pub async fn memory_status(db: State<'_, DbState>) -> CmdResult<serde_json::Value> {
    let conn = db.0.lock();
    let mems = db::active_memories_for_scope(&conn, "default", None).unwrap_or_default();
    let stored = crate::memory::document::stored_document(&conn);
    let effective = crate::memory::render::render_memory_document(
        stored.as_deref(),
        &mems,
        crate::db::now_ts(),
    );
    let stored_at = db::get_setting(&conn, crate::memory::document::SETTING_DOCUMENT_AT)
        .unwrap_or(None)
        .and_then(|s| s.parse::<i64>().ok());
    let extract_model = db::get_setting(&conn, crate::memory::SETTING_EXTRACT_MODEL)
        .unwrap_or(None)
        .unwrap_or_default();
    Ok(serde_json::json!({
        "enabled": crate::memory::memory_enabled(&conn),
        "activeCount": db::count_active_memories(&conn, "default").unwrap_or(0),
        "document": effective,
        "documentStored": stored.is_some(),
        "documentUpdatedAt": stored_at,
        "documentBudget": crate::memory::render::DOCUMENT_TOKEN_BUDGET,
        "extractModel": extract_model,
    }))
}

/// Set the cheap model the memory pipeline (extraction, judge, document
/// merge) uses. Empty clears the override — fall back to the chat's model.
#[tauri::command]
pub async fn memory_set_extract_model(model: String, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    let model = model.trim().to_string();
    db::set_setting(&conn, crate::memory::SETTING_EXTRACT_MODEL, &model)
        .map_err(|e| e.to_string())
}

/// Bounded version history of the memory document (newest first) — the
/// restore source for a bad LLM merge.
#[tauri::command]
pub async fn memory_document_history(
    limit: Option<i64>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<db::MemoryDocVersionRow>> {
    let conn = db.0.lock();
    db::list_document_versions(&conn, limit.unwrap_or(20).clamp(1, 50))
        .map_err(|e| e.to_string())
}

/// Replace the memory document by hand from the UI. The text IS what gets
/// injected (budget-enforced here in code — the user's edit is ground truth);
/// the raw entries keep their audit-log role. Empty text resets to the
/// auto-generated document.
#[tauri::command]
pub async fn memory_set_document(text: String, db: State<'_, DbState>) -> CmdResult<()> {
    let text = text.trim().to_string();
    let conn = db.0.lock();
    if text.is_empty() {
        crate::memory::document::set_document(&conn, None, "user").map_err(|e| e.to_string())?;
        let _ = db::log_memory_op(&conn, "user", None, "", "DOC_RESET", &[], "reset from UI");
        return Ok(());
    }
    let (doc, trimmed) = crate::memory::render::enforce_budget(text);
    if trimmed {
        return Err(format!(
            "over budget: the document exceeds the {}-token injection limit (~{} characters); shorten it and save again",
            crate::memory::render::DOCUMENT_TOKEN_BUDGET,
            crate::memory::render::DOCUMENT_TOKEN_BUDGET * 4,
        ));
    }
    crate::memory::document::set_document(&conn, Some(&doc), "user").map_err(|e| e.to_string())?;
    let _ = db::log_memory_op(&conn, "user", None, &doc, "DOC_EDIT", &[], "edited from UI");
    Ok(())
}

/// Recent write-decision audit log (judge ops, merges, user edits) — the
/// "nothing hidden" surface behind the memory panel.
#[tauri::command]
pub async fn memory_recent_ops(
    limit: Option<i64>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<db::MemoryOpRow>> {
    let conn = db.0.lock();
    db::list_memory_ops(&conn, limit.unwrap_or(30).clamp(1, 200))
        .map_err(|e| e.to_string())
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
        invalidate_document(&conn);
    }
    Ok(rec)
}

/// After a raw-store mutation, drop the stored document so the effective
/// document (a deterministic render from the records) includes the change
/// immediately; the next extraction batch re-runs the LLM merge on top.
fn invalidate_document(conn: &rusqlite::Connection) {
    if crate::memory::document::stored_document(conn).is_some() {
        let _ = crate::memory::document::set_document(conn, None, "");
        let _ = db::log_memory_op(conn, "user", None, "", "DOC_INVALIDATE", &[],
                                  "record store changed — document regenerated from records");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_memory(conn: &rusqlite::Connection, content: &str, importance: i64) -> MemoryRecord {
        let rec = MemoryRecord::new_extracted(
            &new_id(),
            "fact",
            None,
            "user",
            content,
            importance,
            None,
        );
        db::insert_memory(conn, &rec).unwrap();
        rec
    }

    #[test]
    fn memory_user_edit_is_transactional() {
        // E6: the content update and the origin/importance update are one
        // logical edit. A forced failure in the SECOND update must roll the
        // FIRST back — the old two-bare-UPDATEs form left new content with
        // stale origin/importance.
        let conn = crate::db::mem();
        let rec = seed_memory(&conn, "deploys happen on Tuesdays", 5);

        // Any importance change aborts (trigger) → the whole edit fails.
        conn.execute(
            "CREATE TRIGGER e6_force_fail BEFORE UPDATE ON memories
             WHEN NEW.importance <> OLD.importance
             BEGIN SELECT RAISE(ABORT, 'forced e6 failure'); END",
            [],
        )
        .unwrap();

        let err = apply_memory_user_edit(&conn, &rec.id, "edited content", Some(7));
        assert!(err.is_err(), "forced importance failure must propagate");

        // Rolled back: content is the ORIGINAL, origin/importance untouched.
        let after = db::list_memories(&conn, "default", true).unwrap();
        let row = after.iter().find(|m| m.id == rec.id).unwrap();
        assert_eq!(row.content, "deploys happen on Tuesdays");
        assert_eq!(row.importance, 5);
        assert_ne!(row.origin, origin::USER_CREATED);

        // Without the failing path the same edit applies cleanly.
        conn.execute("DROP TRIGGER e6_force_fail", []).unwrap();
        apply_memory_user_edit(&conn, &rec.id, "edited content", Some(8)).unwrap();
        let after = db::list_memories(&conn, "default", true).unwrap();
        let row = after.iter().find(|m| m.id == rec.id).unwrap();
        assert_eq!(row.content, "edited content");
        assert_eq!(row.importance, 8);
        assert_eq!(row.origin, origin::USER_CREATED);
    }
}
