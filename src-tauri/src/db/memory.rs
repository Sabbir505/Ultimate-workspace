//! Persistence for the persistent-user-memory store
//! (MEMORY_DESIGN_ARCHITECTURE.md §9). Schema lives in `mod.rs::init_schema`
//! (`memories`, `memories_fts`, `memory_evidence`, `memory_ops`,
//! `memory_cursor`). All functions take `&Connection` like every other
//! `db/` submodule so they run against `mem()` in tests.
//!
//! The supersession invariant (design §10.2): a contradiction never
//! overwrites content — [`supersede_memory`] only stamps
//! `valid_until/superseded_at/status/superseded_by` on the old row. Content
//! bytes of a superseded memory are immutable.

use crate::db::DbResult;
use crate::memory::model::MemoryRecord;
use rusqlite::{params, Connection, OptionalExtension};

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: r.get("id")?,
        kind: r.get("kind")?,
        profile: r.get("profile")?,
        project_id: r.get("project_id")?,
        subject: r.get("subject")?,
        content: r.get("content")?,
        keywords: serde_json::from_str(&r.get::<_, String>("keywords")?).unwrap_or_default(),
        importance: r.get("importance")?,
        confidence: r.get("confidence")?,
        status: r.get("status")?,
        superseded_by: r.get("superseded_by")?,
        valid_from: r.get("valid_from")?,
        valid_until: r.get("valid_until")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        superseded_at: r.get("superseded_at")?,
        last_accessed_at: r.get("last_accessed_at")?,
        access_count: r.get("access_count")?,
        origin: r.get("origin")?,
        reflected: r.get::<_, i64>("reflected")? != 0,
        embedding: r.get::<_, Option<Vec<u8>>>("embedding")?.map(|b| {
            crate::db::docs::blob_to_f32_slice(&b)
        }),
    })
}

const COLS: &str = "id, kind, profile, project_id, subject, content, keywords, importance, \
                    confidence, status, superseded_by, valid_from, valid_until, created_at, \
                    updated_at, superseded_at, last_accessed_at, access_count, origin, \
                    reflected, embedding";

pub fn insert_memory(conn: &Connection, rec: &MemoryRecord) -> DbResult<()> {
    conn.execute(
        "INSERT INTO memories (id, kind, profile, project_id, subject, content, keywords, \
            importance, confidence, status, superseded_by, valid_from, valid_until, \
            created_at, updated_at, superseded_at, last_accessed_at, access_count, origin, embedding)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![
            rec.id,
            rec.kind,
            rec.profile,
            rec.project_id,
            rec.subject,
            rec.content,
            serde_json::to_string(&rec.keywords).unwrap_or_else(|_| "[]".into()),
            rec.importance,
            rec.confidence,
            rec.status,
            rec.superseded_by,
            rec.valid_from,
            rec.valid_until,
            rec.created_at,
            rec.updated_at,
            rec.superseded_at,
            rec.last_accessed_at,
            rec.access_count,
            rec.origin,
            rec.embedding.as_ref().map(|v| crate::db::docs::f32_slice_to_blob(v)),
        ],
    )?;
    Ok(())
}

pub fn get_memory(conn: &Connection, id: &str) -> DbResult<Option<MemoryRecord>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM memories WHERE id = ?1"))?;
    stmt.query_row(params![id], map_row).optional()
}

/// Every memory in a profile, newest first. `include_inactive` pulls
/// superseded/retired/flagged rows too (the UI browser needs the full chain).
pub fn list_memories(
    conn: &Connection,
    profile: &str,
    include_inactive: bool,
) -> DbResult<Vec<MemoryRecord>> {
    let sql = format!(
        "SELECT {COLS} FROM memories WHERE profile = ?1 {} ORDER BY created_at DESC, id",
        if include_inactive { "" } else { "AND status = 'active'" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![profile], map_row)?;
    rows.collect()
}

/// Active memories visible for a scope: profile-global rows plus (when
/// `project_id` is given) that project's rows. Design §11.1's hard filters.
pub fn active_memories_for_scope(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
) -> DbResult<Vec<MemoryRecord>> {
    let sql = format!(
        "SELECT {COLS} FROM memories \
         WHERE profile = ?1 AND status = 'active' \
           AND (project_id IS NULL OR project_id = ?2) \
           AND confidence >= 0.35 ORDER BY importance DESC, updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![profile, project_id], map_row)?;
    rows.collect()
}

/// Text-only mutation (the consolidation judge's UPDATE merge). Content edits
/// re-render through the FTS triggers automatically.
pub fn update_memory_content(
    conn: &Connection,
    id: &str,
    content: &str,
    keywords: &[String],
    confidence: f64,
) -> DbResult<()> {
    conn.execute(
        "UPDATE memories SET content = ?2, keywords = ?3, confidence = ?4, updated_at = ?5 \
         WHERE id = ?1",
        params![
            id,
            content,
            serde_json::to_string(keywords).unwrap_or_else(|_| "[]".into()),
            confidence,
            crate::db::now_ts(),
        ],
    )?;
    Ok(())
}

/// Flag-only status change (retire / flag / re-activate). Never touches
/// content — see the module doc.
pub fn set_memory_status(conn: &Connection, id: &str, status: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE memories SET status = ?2, \
           superseded_at = CASE WHEN ?2 IN ('superseded','retired') THEN ?3 ELSE superseded_at END, \
           updated_at = ?3 \
         WHERE id = ?1",
        params![id, status, crate::db::now_ts()],
    )?;
    Ok(())
}

/// Bi-temporal invalidation: the old memory ends (`valid_until` = now,
/// `status = 'superseded'`) and points at its replacement. The candidate row
/// itself is inserted by the caller with `valid_from` = this same instant.
pub fn supersede_memory(
    conn: &Connection,
    old_id: &str,
    new_id: &str,
) -> DbResult<()> {
    let now = crate::db::now_ts();
    conn.execute(
        "UPDATE memories SET status = 'superseded', superseded_by = ?2, \
           valid_until = ?3, superseded_at = ?3, updated_at = ?3 \
         WHERE id = ?1",
        params![old_id, new_id, now],
    )?;
    Ok(())
}

/// Hard delete — the user's purge paths only (design §13.6). Evidence rows
/// cascade via the schema FK.
pub fn delete_memory(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn purge_memories_for_profile(conn: &Connection, profile: &str) -> DbResult<usize> {
    conn.execute("DELETE FROM memories WHERE profile = ?1", params![profile])
}

/// Brute-force cosine over ACTIVE memories in scope with a stored embedding —
/// the consolidation judge's comparison fetch (design §10.1 step 1). Embedding
/// is `Option` because writes proceed (FTS-only) when the sidecar is down.
pub fn similar_active_memories(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
    embedding: &[f32],
    limit: usize,
) -> DbResult<Vec<(MemoryRecord, f32)>> {
    let sql = format!(
        "SELECT {COLS} FROM memories \
         WHERE profile = ?1 AND status = 'active' \
           AND (project_id IS NULL OR project_id = ?2) AND embedding IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![profile, project_id], map_row)?;
    let qnorm = embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mut hits: Vec<(MemoryRecord, f32)> = Vec::new();
    if qnorm == 0.0 {
        return Ok(hits);
    }
    for row in rows {
        let rec = row?;
        let v = rec.embedding.as_deref().unwrap_or(&[]);
        if v.len() != embedding.len() || v.is_empty() {
            continue; // mixed dimensions (model swapped) — skip
        }
        let vnorm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if vnorm == 0.0 {
            continue;
        }
        let dot = embedding.iter().zip(v.iter()).map(|(a, b)| a * b).sum::<f32>();
        hits.push((rec, dot / (qnorm * vnorm)));
    }
    hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

/// FTS5 keyword leg of hybrid retrieval (bm25 rank; lower = better, so the
/// caller negates it into a 0..1 relevance via the scoring module). Scope
/// filter mirrors `active_memories_for_scope` — a project memory must never
/// leak into a global-scope query.
pub fn search_memories_fts(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
    query: &str,
    limit: usize,
) -> DbResult<Vec<MemoryRecord>> {
    // A bare user query isn't FTS5 syntax; wrap each token as a quoted
    // prefix term ORed together (bm25 ranks docs matching more terms
    // higher — AND semantics were too strict for the judge's comparison
    // fetch, which must find a contradictee that shares only one keyword).
    let safe: String = query
        .split_whitespace()
        .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(" OR ");
    if safe.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT m.* FROM memories m JOIN memories_fts f ON f.rowid = m.rowid \
         WHERE memories_fts MATCH ?1 AND m.profile = ?2 AND m.status = 'active' \
           AND (m.project_id IS NULL OR m.project_id = ?3) \
         ORDER BY bm25(memories_fts) LIMIT ?4"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![safe, profile, project_id, limit as i64], map_row)?;
    rows.collect()
}

// ---- evidence ----

pub fn add_memory_evidence(
    conn: &Connection,
    memory_id: &str,
    chat_session_id: &str,
    chat_message_id: i64,
    quote: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO memory_evidence \
           (memory_id, chat_session_id, chat_message_id, quote) \
         VALUES (?1, ?2, ?3, ?4)",
        params![memory_id, chat_session_id, chat_message_id, quote],
    )?;
    Ok(())
}

pub fn evidence_for_memory(
    conn: &Connection,
    memory_id: &str,
) -> DbResult<Vec<(String, i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT chat_session_id, chat_message_id, quote FROM memory_evidence \
         WHERE memory_id = ?1 ORDER BY chat_message_id",
    )?;
    let rows = stmt.query_map(params![memory_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })?;
    rows.collect()
}

pub fn evidence_count_for_memory(conn: &Connection, memory_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM memory_evidence WHERE memory_id = ?1",
        params![memory_id],
        |r| r.get(0),
    )
}

/// Safety net after transcript deletion (design §13.5): memories whose
/// evidence is all gone get `flagged` — they drop out of injection until the
/// user reviews them. User-created memories keep provenance in the user
/// themselves, so they are exempt.
pub fn flag_unbacked_memories(conn: &Connection) -> DbResult<usize> {
    conn.execute(
        "UPDATE memories SET status = 'flagged' \
         WHERE status = 'active' AND origin != 'user_created' \
           AND id NOT IN (SELECT DISTINCT memory_id FROM memory_evidence)",
        [],
    )
}

// ---- audit log ----

pub fn log_memory_op(
    conn: &Connection,
    actor: &str,
    session_id: Option<&str>,
    candidate: &str,
    operation: &str,
    target_ids: &[String],
    rationale: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO memory_ops (ts, actor, session_id, candidate, operation, target_ids, rationale) \
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            crate::db::now_ts(),
            actor,
            session_id,
            // Cap the stored candidate so a pathological transcript can't
            // balloon the audit table (the full text lives in chat_messages).
            crate::util::truncate_chars(candidate, 2000),
            operation,
            serde_json::to_string(target_ids).unwrap_or_else(|_| "[]".into()),
            rationale,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOpRow {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub session_id: Option<String>,
    pub candidate: String,
    pub operation: String,
    pub target_ids: Vec<String>,
    pub rationale: String,
}

pub fn list_memory_ops(conn: &Connection, limit: i64) -> DbResult<Vec<MemoryOpRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, ts, actor, session_id, candidate, operation, target_ids, rationale \
         FROM memory_ops ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(MemoryOpRow {
            id: r.get(0)?,
            ts: r.get(1)?,
            actor: r.get(2)?,
            session_id: r.get(3)?,
            candidate: r.get(4)?,
            operation: r.get(5)?,
            target_ids: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
            rationale: r.get(7)?,
        })
    })?;
    rows.collect()
}

// ---- cursor (extraction idempotency) ----

pub fn get_cursor(conn: &Connection, chat_session_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT last_message_id FROM memory_cursor WHERE chat_session_id = ?1",
        params![chat_session_id],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.unwrap_or(0))
}

pub fn upsert_cursor(conn: &Connection, chat_session_id: &str, last_message_id: i64) -> DbResult<()> {
    conn.execute(
        "INSERT INTO memory_cursor (chat_session_id, last_message_id, last_run_at) \
           VALUES (?1, ?2, ?3) \
         ON CONFLICT(chat_session_id) DO UPDATE SET \
           last_message_id = MAX(last_message_id, excluded.last_message_id), \
           last_run_at = excluded.last_run_at",
        params![chat_session_id, last_message_id, crate::db::now_ts()],
    )?;
    Ok(())
}

// ---- misc ----

pub fn bump_memory_access(conn: &Connection, ids: &[String]) -> DbResult<()> {
    let now = crate::db::now_ts();
    for id in ids {
        conn.execute(
            "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?2 \
             WHERE id = ?1",
            params![id, now],
        )?;
    }
    Ok(())
}

pub fn count_active_memories(conn: &Connection, profile: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM memories WHERE profile = ?1 AND status = 'active'",
        params![profile],
        |r| r.get(0),
    )
}

// ---- document versions (the memory document's History + Restore UI) ----

/// One stored snapshot of the memory document.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocVersionRow {
    pub id: i64,
    /// Who wrote it: "merge" (LLM) or "user" (panel save).
    pub source: String,
    pub text: String,
    pub created_at: i64,
}

const DOC_VERSION_CAP: i64 = 20;

/// Append a document snapshot and prune to the newest [`DOC_VERSION_CAP`].
pub fn insert_document_version(conn: &Connection, source: &str, text: &str) -> DbResult<()> {
    conn.execute(
        "INSERT INTO memory_document_versions (source, text, created_at) VALUES (?1, ?2, ?3)",
        params![source, text, crate::db::now_ts()],
    )?;
    conn.execute(
        "DELETE FROM memory_document_versions WHERE id NOT IN \
         (SELECT id FROM memory_document_versions ORDER BY id DESC LIMIT ?1)",
        params![DOC_VERSION_CAP],
    )?;
    Ok(())
}

pub fn list_document_versions(
    conn: &Connection,
    limit: i64,
) -> DbResult<Vec<MemoryDocVersionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, source, text, created_at FROM memory_document_versions \
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(MemoryDocVersionRow {
                id: r.get(0)?,
                source: r.get(1)?,
                text: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---- embedding backfill (records written while the sidecar was down) ----

/// Active memories with no vector yet — the backfill queue. Project-agnostic:
/// a missing vector is a store-wide gap, not a scope filter.
pub fn memories_missing_embedding(
    conn: &Connection,
    profile: &str,
    limit: i64,
) -> DbResult<Vec<MemoryRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM memories \
         WHERE profile = ?1 AND status = 'active' AND embedding IS NULL LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![profile, limit], map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Store a freshly computed vector for one memory.
pub fn set_memory_embedding(conn: &Connection, id: &str, embedding: &[f32]) -> DbResult<()> {
    conn.execute(
        "UPDATE memories SET embedding = ?2 WHERE id = ?1",
        params![id, crate::db::docs::f32_slice_to_blob(embedding)],
    )?;
    Ok(())
}

// ---- reflection (MEMORY_DESIGN_ARCHITECTURE.md §8.4) ----

/// Aggregate trigger state over UNREFLECTED, non-reflection active memories
/// in scope: `(count, importance_sum)`. Generative-Agents' threshold-150
/// trigger, rescaled from game-hours to stored facts.
pub fn unreflected_stats(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
) -> DbResult<(i64, f64)> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(importance), 0) FROM memories \
         WHERE profile = ?1 AND status = 'active' AND reflected = 0 \
           AND origin != 'reflection' AND (project_id IS NULL OR project_id = ?2)",
        params![profile, project_id],
        |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as f64)),
    )
}

/// The reflection sample: highest-importance unreflected actives in scope
/// (the LLM synthesizes insights over these).
pub fn unreflected_sample(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
    limit: usize,
) -> DbResult<Vec<MemoryRecord>> {
    let sql = format!(
        "SELECT {COLS} FROM memories \
         WHERE profile = ?1 AND status = 'active' AND reflected = 0 \
           AND origin != 'reflection' AND (project_id IS NULL OR project_id = ?2) \
         ORDER BY importance DESC, confidence DESC, updated_at DESC LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![profile, project_id, limit as i64], map_row)?;
    rows.collect()
}

/// Mark memories as folded into (or considered by) a reflection pass.
pub fn mark_reflected(conn: &Connection, ids: &[String]) -> DbResult<()> {
    for id in ids {
        conn.execute(
            "UPDATE memories SET reflected = 1 WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::MemoryRecord;

    fn rec(id: &str, content: &str, importance: i64, embedding: Option<Vec<f32>>) -> MemoryRecord {
        MemoryRecord::new_extracted(
            id,
            "preference",
            None,
            "user",
            content,
            importance,
            embedding,
        )
    }

    #[test]
    fn insert_get_and_supersede_roundtrip() {
        let conn = crate::db::mem();
        let a = rec("m1", "User prefers tabs", 6, None);
        insert_memory(&conn, &a).unwrap();
        let got = get_memory(&conn, "m1").unwrap().unwrap();
        assert_eq!(got.content, "User prefers tabs");
        assert_eq!(got.status, "active");
        assert!(got.embedding.is_none());

        // Supersession never touches content bytes (design §10.2 invariant).
        supersede_memory(&conn, "m1", "m2").unwrap();
        let old = get_memory(&conn, "m1").unwrap().unwrap();
        assert_eq!(old.status, "superseded");
        assert_eq!(old.superseded_by.as_deref(), Some("m2"));
        assert_eq!(old.content, "User prefers tabs");
        assert!(old.valid_until.is_some());

        // Scope filter: only active rows come back.
        let scope = active_memories_for_scope(&conn, "default", None).unwrap();
        assert!(scope.is_empty());
    }

    #[test]
    fn fts_and_similar_search() {
        let conn = crate::db::mem();
        insert_memory(&conn, &rec("m1", "User uses pnpm workspaces not npm", 6, None)).unwrap();
        insert_memory(&conn, &rec("m2", "Project targets Tauri v2 on Windows", 7, Some(vec![
            1.0, 0.0, 0.0,
        ]))).unwrap();
        insert_memory(&conn, &rec("m3", "User dislikes code comments", 8, Some(vec![
            0.0, 1.0, 0.0,
        ]))).unwrap();

        let fts = search_memories_fts(&conn, "default", None, "pnpm workspaces", 5).unwrap();
        assert_eq!(fts.len(), 1);
        assert_eq!(fts[0].id, "m1");

        let sim = similar_active_memories(&conn, "default", None, &[0.9, 0.1, 0.0], 2).unwrap();
        assert_eq!(sim[0].0.id, "m2");
        assert!((sim[0].1 - 1.0).abs() < 0.2);
    }

    #[test]
    fn evidence_and_ops_audit() {
        let conn = crate::db::mem();
        insert_memory(&conn, &rec("m1", "fact", 5, None)).unwrap();
        add_memory_evidence(&conn, "m1", "s1", 11, "always use pnpm").unwrap();
        add_memory_evidence(&conn, "m1", "s1", 11, "always use pnpm").unwrap(); // dedup
        assert_eq!(evidence_count_for_memory(&conn, "m1").unwrap(), 1);

        log_memory_op(&conn, "judge", Some("s1"), "{\"content\":\"fact\"}", "ADD", &["m1".into()], "novel").unwrap();
        let ops = list_memory_ops(&conn, 10).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].target_ids, vec!["m1".to_string()]);
    }

    #[test]
    fn cursor_monotonic() {
        let conn = crate::db::mem();
        assert_eq!(get_cursor(&conn, "s1").unwrap(), 0);
        upsert_cursor(&conn, "s1", 10).unwrap();
        upsert_cursor(&conn, "s1", 5).unwrap(); // regressions ignored
        assert_eq!(get_cursor(&conn, "s1").unwrap(), 10);
    }

    #[test]
    fn flag_unbacked_after_evidence_loss() {
        let conn = crate::db::mem();
        // Extracted memory with evidence + a user-created memory with none.
        insert_memory(&conn, &rec("m1", "extracted fact", 5, None)).unwrap();
        add_memory_evidence(&conn, "m1", "s1", 11, "quote").unwrap();
        let mut user_mem = rec("m2", "user typed this", 5, None);
        user_mem.origin = crate::memory::model::origin::USER_CREATED.to_string();
        insert_memory(&conn, &user_mem).unwrap();

        // No-op while evidence exists.
        flag_unbacked_memories(&conn).unwrap();
        assert_eq!(get_memory(&conn, "m1").unwrap().unwrap().status, "active");

        // Transcript deleted → evidence gone → extracted memory flagged,
        // user-created memory untouched.
        conn.execute("DELETE FROM memory_evidence", []).unwrap();
        flag_unbacked_memories(&conn).unwrap();
        assert_eq!(get_memory(&conn, "m1").unwrap().unwrap().status, "flagged");
        assert_eq!(get_memory(&conn, "m2").unwrap().unwrap().status, "active");
    }
}
