//! Persistent user memory for Relay (MEMORY_DESIGN_ARCHITECTURE.md).
//!
//! Module map:
//! - [`model`]   — the `MemoryRecord` shape, kinds, constants
//! - [`scoring`] — pure math: hybrid retrieval score, decay, min-max, MMR
//! - [`extract`] — candidate extraction prompt + parse + safety filters (§7)
//! - [`consolidate`] — the LLM judge: ADD / UPDATE / DELETE / NOOP (§10)
//! - [`reflect`] — reflection: threshold, prompts, apply (§8.4)
//! - [`retrieve`] — hybrid search over the store (§11.1)
//! - [`document`] — the ONE human-readable memory document + its rewrite pass
//! - [`render`]  — injection rendering: the stored document (the budgeted
//!   store, §11 as amended) plus the per-turn ON-DEMAND block (identity core
//!   + retrieved hits) the send path actually injects
//! - [`worker`]  — background extraction + reflection orchestration (§7.1)
//! - [`tools_impl`] — `memory_save` / `memory_recall` / `memory_forget` (§12)
//! - [`eval`]    — offline eval harness: budget, contradiction, retrieval,
//!   extraction fixture gates (§16; test-only)
//!
//! Design invariants: writes happen in the background, never the reply hot
//! path (P2); contradictions supersede rather than overwrite (P3); every
//! memory carries message-level provenance (P4); injected memory is rendered
//! as fenced data, never instructions (P9).

pub mod consolidate;
pub mod document;
pub mod extract;
pub mod model;
pub mod reflect;
pub mod render;
pub mod retrieve;
pub mod scoring;
pub mod tools_impl;
pub mod worker;

#[cfg(test)]
mod eval;

/// `app_settings` keys owned by this feature.
pub const SETTING_ENABLED: &str = "memory.enabled";
pub const SETTING_EXTRACT_MODEL: &str = "memory.extractModel";

pub fn memory_enabled(conn: &rusqlite::Connection) -> bool {
    // `get_setting` returns DbResult<Option<String>>; unset = enabled.
    match crate::db::get_setting(conn, SETTING_ENABLED) {
        Ok(Some(v)) => v.as_str() != "false",
        _ => true,
    }
}

/// Convenience for the send path, which holds the DB behind
/// `Arc<parking_lot::Mutex<Connection>>` — lock-and-check in one call.
pub fn memory_enabled_conn(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> bool {
    let conn = db.lock();
    memory_enabled(&conn)
}

/// Max records one turn's on-demand load may retrieve.
const ON_DEMAND_TOP_K: usize = 4;

/// Per-turn ON-DEMAND memory load (the caller holds the DB lock; FTS-only —
/// no embedding roundtrip on the send path, same low-latency trade the
/// `memory_recall` tool makes). Returns the budgeted block to inject, or
/// `None` when there is truly nothing to say:
/// - identity core: the top few high-importance identity facts, carried every
///   turn so "who is the user" never depends on keyword retrieval;
/// - retrieved hits: records matching the turn's query (empty/None query or
///   zero matches → core-only block);
/// - stored-document fallback: when NEITHER qualifies but a stored memory
///   document exists (user-saved or LLM-merged), the document itself is
///   injected, truncated to the same per-turn budget — its text has no
///   record, embedding, or importance, so without this it would be invisible
///   to retrieval;
/// - recall hint: records exist but nothing matched → a hint-only block (only
///   when the `memory_recall` tool is attached) so the model searches instead
///   of claiming ignorance.
/// Injected record ids get their access counters bumped here (the recency decay
/// reads them), replacing the old always-on injection site's bump pass.
pub fn on_demand_injection(
    conn: &rusqlite::Connection,
    query: Option<&str>,
    project_id: Option<&str>,
    now: i64,
    recall_hint: bool,
) -> Option<String> {
    let all = crate::db::active_memories_for_scope(conn, "default", project_id).unwrap_or_default();
    let mut core: Vec<crate::memory::model::MemoryRecord> = all
        .iter()
        .filter(|m| {
            m.kind == crate::memory::model::kind::IDENTITY
                && m.importance >= crate::memory::render::CORE_MIN_IMPORTANCE
        })
        .cloned()
        .collect();
    core.sort_by(|a, b| {
        b.importance
            .cmp(&a.importance)
            .then(b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal))
    });
    core.truncate(crate::memory::render::CORE_MAX_FACTS);

    let query = query.map(str::trim).filter(|q| !q.is_empty());
    let hits = match query {
        Some(q) => crate::memory::retrieve::search_memories(
            conn, "default", project_id, q, None, ON_DEMAND_TOP_K,
        )
        .unwrap_or_default(),
        None => Vec::new(),
    };
    if !core.is_empty() || !hits.is_empty() {
        let mut injected: Vec<String> = hits.iter().map(|h| h.record.id.clone()).collect();
        injected.extend(core.iter().map(|m| m.id.clone()));
        let _ = crate::db::bump_memory_access(conn, &injected);
        return crate::memory::render::render_on_demand_block(&core, &hits, now, recall_hint);
    }
    // Nothing qualified this turn — fall back to the stored document (a
    // hand-typed profile may be the ONLY memory there is), then to the
    // search hint, and only then to silence.
    if let Some(doc) = crate::memory::document::stored_document(conn) {
        if let Some(block) = crate::memory::render::render_document_fallback(&doc) {
            return Some(block);
        }
    }
    if !all.is_empty() && recall_hint {
        return crate::memory::render::render_on_demand_block(&[], &[], now, recall_hint);
    }
    None
}

#[cfg(test)]
mod pipeline_tests {
    //! End-to-end store pipeline (everything except the live LLM calls):
    //! session 1 writes through the judge; session 2 retrieves and the
    //! single memory document renders for injection.
    use crate::memory::consolidate::{apply_judge_op, parse_judge_op, JudgeInput};
    use crate::memory::document;
    use crate::memory::model::{MemoryCandidate, MemoryRecord};
    use crate::memory::render::{render_memory_document, DOCUMENT_TOKEN_BUDGET};
    use crate::memory::retrieve::search_memories;
    use crate::memory::worker::fetch_similar;
    use parking_lot::Mutex;
    use std::sync::Arc;

    fn cand(content: &str, kind: &str, importance: i64) -> MemoryCandidate {
        MemoryCandidate {
            content: content.into(),
            kind: kind.into(),
            subject: "user".into(),
            quote: "verbatim user words here".into(),
            message_ids: vec![5],
            importance,
        }
    }

    #[test]
    fn write_then_read_across_sessions() {
        let store = Arc::new(Mutex::new(crate::db::mem()));

        // ── Session 1: two judged writes (an ADD and a contradiction DELETE).
        let c1 = cand("User prefers concise answers without restating the question", "preference", 7);
        let similar = {
            let conn = store.lock();
            fetch_similar(&conn, "default", None, &c1, None)
        };
        let input = JudgeInput { candidate: &c1, similar: &similar };
        let applied = {
            let conn = store.lock();
            apply_judge_op(&conn, &input, &parse_judge_op("{\"operation\":\"ADD\"}", &[]),
                           Some("s1"), None, None, 1_000, crate::memory::model::origin::EXTRACTED).unwrap()
        };
        assert_eq!(applied.op, "ADD");

        let c2 = cand("User switched from tabs to spaces for indentation", "preference", 6);
        // Seed the memory the candidate will contradict, then re-fetch.
        {
            let conn = store.lock();
            let old = MemoryRecord::new_extracted("mem_old", "preference", None, "user",
                                                  "User prefers tabs for indentation", 6, None);
            crate::db::insert_memory(&conn, &old).unwrap();
        }
        let similar = {
            let conn = store.lock();
            fetch_similar(&conn, "default", None, &c2, None)
        };
        let input = JudgeInput { candidate: &c2, similar: &similar };
        let targets: Vec<String> = similar.iter().map(|(m, _)| m.id.clone()).collect();
        assert!(targets.contains(&"mem_old".to_string()), "FTS fallback must find the contradictee");
        let applied2 = {
            let conn = store.lock();
            apply_judge_op(&conn, &input,
                           &parse_judge_op(&format!("{{\"operation\":\"DELETE\",\"target_id\":\"{}\"}}", targets[0]), &targets),
                           Some("s1"), None, None, 2_000, crate::memory::model::origin::EXTRACTED).unwrap()
        };
        assert_eq!(applied2.op, "DELETE");

        // ── Session 2 (a different chat): retrieve + inject.
        let conn = store.lock();
        let hits = search_memories(&conn, "default", None, "indentation preferences", None, 8)
            .unwrap();
        assert!(!hits.is_empty());
        // The superseded "tabs" memory must NOT be injected; "spaces" must be.
        assert!(hits.iter().all(|h| h.record.id != "mem_old"));
        assert!(hits.iter().any(|h| h.record.content.contains("spaces")));

        let all = crate::db::active_memories_for_scope(&conn, "default", None).unwrap();
        // No stored document yet → deterministic fallback render is what the
        // model sees, and it stays within the single injection budget.
        let block = render_memory_document(None, &all, crate::db::now_ts()).unwrap();
        assert!(block.contains("About this user"));
        assert!(block.contains("concise answers"));
        assert!(block.len() <= DOCUMENT_TOKEN_BUDGET * 4 + 400);
        // Superseded fact absent from the injected document.
        assert!(!block.to_lowercase().contains("prefers tabs"));

        // A stored (LLM-merged) document replaces the fallback wholesale.
        document::set_document(&conn, Some("# Profile\n\nUser likes short replies."), "merge")
            .unwrap();
        let stored = document::stored_document(&conn);
        let block = render_memory_document(stored.as_deref(), &all, crate::db::now_ts()).unwrap();
        assert!(block.contains("User likes short replies."));
        assert!(!block.contains("concise answers"));
    }

    /// The send path's per-turn load: query-matched facts ride along, a
    /// non-matching turn carries only the identity core, an unrelated query
    /// injects nothing from the fact pool, and access counters are bumped.
    #[test]
    fn on_demand_injection_matches_query_and_bumps_access() {
        let conn = crate::db::mem();

        // Empty store → no block at all.
        assert!(crate::memory::on_demand_injection(&conn, Some("pnpm"), None, crate::db::now_ts(), true).is_none());

        let mut pref = crate::memory::model::MemoryRecord::new_extracted(
            "mem_pref", "preference", None, "user", "Builds with pnpm workspaces", 6, None,
        );
        pref.created_at = 1;
        crate::db::insert_memory(&conn, &pref).unwrap();
        let mut episode = crate::memory::model::MemoryRecord::new_extracted(
            "mem_ep", "episode", None, "user", "Debugged a flaky websocket test on Tuesday", 5, None,
        );
        episode.created_at = 1;
        crate::db::insert_memory(&conn, &episode).unwrap();

        // Matching query: the preference is loaded, the unrelated episode is not.
        let block = crate::memory::on_demand_injection(&conn, Some("pnpm workspaces setup"), None, crate::db::now_ts(), true).unwrap();
        assert!(block.contains("Builds with pnpm workspaces"), "{block}");
        assert!(!block.contains("websocket"));

        // A non-matching query: no fact pool leak, recall hint present.
        let block = crate::memory::on_demand_injection(&conn, Some("quantum chromodynamics"), None, crate::db::now_ts(), true);
        assert!(block.is_none() || !block.unwrap_or_default().contains("pnpm"), "non-matching turn must not load unrelated facts");

        // Access counters moved for whatever was injected.
        let touched = crate::db::get_memory(&conn, "mem_pref").unwrap().unwrap();
        assert!(touched.access_count > 0 || touched.last_accessed_at.is_some());
    }

    /// The two previously-silent turns now have fallbacks: a hand-typed
    /// stored document with NO records at all still reaches the model, and a
    /// record store with no core facts and no query matches ships the recall
    /// hint instead of letting the model claim ignorance.
    #[test]
    fn silent_turns_fall_back_to_document_then_hint() {
        // A saved document and an EMPTY record store: the document is the
        // only memory there is, and it must be injected.
        let conn = crate::db::mem();
        document::set_document(
            &conn,
            Some("User's name is Sabbir Hossain. They are building a Tauri app called Relay."),
            "user",
        )
        .unwrap();
        let block = crate::memory::on_demand_injection(
            &conn,
            Some("what do you know about me"),
            None,
            crate::db::now_ts(),
            true,
        )
        .unwrap();
        assert!(block.contains("Sabbir Hossain"), "{block}");

        // Records exist but none are core-worthy (importance 6 preference)
        // and the query matches none of them: the hint-only block ships when
        // tools are attached — never the unrelated facts themselves.
        let conn = crate::db::mem();
        crate::db::insert_memory(
            &conn,
            &crate::memory::model::MemoryRecord::new_extracted(
                "mem_pref", "preference", None, "user", "Builds with pnpm workspaces", 6, None,
            ),
        )
        .unwrap();
        let block = crate::memory::on_demand_injection(
            &conn,
            Some("quantum chromodynamics"),
            None,
            crate::db::now_ts(),
            true,
        )
        .unwrap();
        assert!(block.contains("memory_recall"), "{block}");
        assert!(!block.contains("pnpm"), "{block}");
        // No tools attached → the hint block is omitted byte-neutral.
        assert!(crate::memory::on_demand_injection(
            &conn,
            Some("quantum chromodynamics"),
            None,
            crate::db::now_ts(),
            false,
        )
        .is_none());
    }
}
