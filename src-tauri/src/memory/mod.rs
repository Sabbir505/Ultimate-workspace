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
//! - [`render`]  — the single budgeted injection block rendered from the
//!   document (§11, amended — replaces the old two-tier split)
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
}
