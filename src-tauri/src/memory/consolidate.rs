//! Consolidation / update phase (design §10): for each scored candidate,
//! fetch the most similar ACTIVE memories, ask the LLM judge for exactly one
//! operation (ADD / UPDATE / DELETE / NOOP — Mem0's operation set), and apply
//! it to the store with bi-temporal supersession (Zep's model). All DB
//! writes land here; the audit log captures every decision including NOOPs.

use crate::db;
use crate::memory::model::{kind, status, JudgeOp, MemoryCandidate, MemoryRecord};
use rusqlite::Connection;

pub const JUDGE_SYSTEM: &str = "You are the memory-consolidation judge for a personal \
assistant. Given a NEW candidate fact and EXISTING memories, decide the ONE correct operation \
and reply with ONLY a JSON object (no prose, no code fences):\n\
{\"operation\":\"ADD\"} — the candidate is genuinely new; nothing similar exists.\n\
{\"operation\":\"UPDATE\",\"target_id\":\"<id>\",\"merged_content\":\"<one sentence combining \
both, timeless tense>\"} — the candidate refines or extends an existing memory that is still \
TRUE (e.g. \"likes Rust\" + \"dislikes C++ macros\" -> one richer fact).\n\
{\"operation\":\"DELETE\",\"target_id\":\"<id>\"} — the candidate CONTRADICTS an existing \
memory, making it no longer true (e.g. user switched tools, changed preference, moved). The \
existing memory is invalidated (history is kept automatically).\n\
{\"operation\":\"NOOP\",\"rationale\":\"...\"} — redundant with an existing memory, or the \
candidate is ambiguous (a joke, hypothetical, quoting someone else, uncertain context).\n\
Rules: UPDATE preserves truth; any CHANGE of truth value is DELETE (supersession), never \
UPDATE. When two existing memories both look relevant pick the single closest target_id. \
If unsure, NOOP.";

/// Input bundle for one candidate's judge round.
pub struct JudgeInput<'a> {
    pub candidate: &'a MemoryCandidate,
    pub similar: &'a [(MemoryRecord, f32)],
}

/// Render the judge's user message (candidate + numbered existing memories).
pub fn judge_user_message(input: &JudgeInput<'_>) -> String {
    let mut s = String::from("EXISTING memories:\n");
    if input.similar.is_empty() {
        s.push_str("(none)\n");
    }
    for (i, (m, sim)) in input.similar.iter().enumerate() {
        s.push_str(&format!(
            "[{i}] id={id} kind={kind} ({sim:.2}): {content}\n",
            i = i,
            id = m.id,
            kind = m.kind,
            sim = sim,
            content = m.content,
        ));
    }
    s.push_str(&format!(
        "\nCANDIDATE fact: {}\nkind: {}\nsubject: {}\nuser quote: {}\n\nDecide the operation now.",
        input.candidate.content, input.candidate.kind, input.candidate.subject, input.candidate.quote,
    ));
    s
}

/// Parse the judge's reply. Anything unparseable degrades to NOOP (fail-safe:
/// a missed memory costs less than a wrong write).
pub fn parse_judge_op(raw: &str, valid_target_ids: &[String]) -> JudgeOp {
    let text = raw.trim();
    let body = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text)
        .trim();
    let body = body.strip_suffix("```").unwrap_or(body).trim();
    let start = match body.find('{') {
        Some(i) => &body[i..],
        None => return JudgeOp::Noop,
    };
    let end = match start.rfind('}') {
        Some(i) => &start[..=i],
        None => return JudgeOp::Noop,
    };
    let v: serde_json::Value = match serde_json::from_str(end) {
        Ok(v) => v,
        Err(_) => return JudgeOp::Noop,
    };
    let op = v["operation"].as_str().unwrap_or("NOOP").to_ascii_uppercase();
    let target = v["target_id"].as_str().map(String::from).unwrap_or_default();
    match op.as_str() {
        "ADD" => JudgeOp::Add,
        "UPDATE" => {
            let merged = v["merged_content"].as_str().unwrap_or("").trim().to_string();
            if valid_target_ids.contains(&target) && !merged.is_empty() && merged.len() <= 400 {
                JudgeOp::Update { target_id: target, merged_content: merged }
            } else {
                JudgeOp::Noop
            }
        }
        "DELETE" => {
            if valid_target_ids.contains(&target) {
                JudgeOp::Delete { target_id: target }
            } else {
                JudgeOp::Noop
            }
        }
        _ => JudgeOp::Noop,
    }
}

/// Outcome of applying one candidate — what the audit log records.
pub struct Applied {
    pub op: String,
    pub target_ids: Vec<String>,
    pub new_id: Option<String>,
}

/// Apply a judge operation to the store. `session_id`/evidence come from the
/// candidate's cited message ids (P4 — every written memory carries
/// provenance). `now` is injected for tests.
///
/// NOTE: the caller must already hold the `DbState` lock (all fns here take
/// `&Connection`).
pub fn apply_judge_op(
    conn: &Connection,
    input: &JudgeInput<'_>,
    op: &JudgeOp,
    session_id: Option<&str>,
    project_id: Option<&str>,
    embedding: Option<Vec<f32>>,
    now: i64,
) -> db::DbResult<Applied> {
    let cand = input.candidate;
    match op {
        JudgeOp::Noop => {
            // Even a NOOP corroborates any existing memory it matched (its
            // quote is one more sighting of the same fact).
            if let Some((first, _)) = input.similar.first() {
                for mid in &cand.message_ids {
                    db::add_memory_evidence(conn, &first.id, session_id.unwrap_or(""), *mid, &cand.quote)?;
                }
            }
            Ok(Applied { op: "NOOP".into(), target_ids: vec![], new_id: None })
        }
        JudgeOp::Update { target_id, merged_content } => {
            let existing = db::get_memory(conn, target_id)?;
            let prev_conf = existing.as_ref().map(|m| m.confidence).unwrap_or(0.8);
            let conf = (prev_conf + 0.05).min(1.0);
            db::update_memory_content(conn, target_id, merged_content, &cand_keywords(cand), conf)?;
            for mid in &cand.message_ids {
                db::add_memory_evidence(conn, target_id, session_id.unwrap_or(""), *mid, &cand.quote)?;
            }
            Ok(Applied {
                op: "UPDATE".into(),
                target_ids: vec![target_id.clone()],
                new_id: None,
            })
        }
        JudgeOp::Delete { target_id } => {
            // Supersede, never destroy: insert the candidate as the successor
            // first, then end the old fact's validity pointing at it (§10.2).
            let new_id = format!("mem_{}", uuid::Uuid::new_v4());
            let mut rec = MemoryRecord::new_extracted(
                &new_id,
                &cand.kind,
                project_id,
                &cand.subject,
                &cand.content,
                cand.importance,
                embedding,
            );
            rec.valid_from = now;
            db::insert_memory(conn, &rec)?;
            db::supersede_memory(conn, target_id, &new_id)?;
            for mid in &cand.message_ids {
                db::add_memory_evidence(conn, &new_id, session_id.unwrap_or(""), *mid, &cand.quote)?;
            }
            Ok(Applied {
                op: "DELETE".into(),
                target_ids: vec![target_id.clone()],
                new_id: Some(new_id),
            })
        }
        JudgeOp::Add => {
            // Same-subject mutual exclusion for exclusive kinds (§10.2): if a
            // highly similar active memory exists that the judge didn't pick,
            // treat ADD as a supersession against the closest one.
            let exclusive = kind::exclusive(&cand.kind);
            let conflicting = exclusive.then(|| {
                input
                    .similar
                    .iter()
                    .find(|(m, _)| m.kind == cand.kind && m.status == status::ACTIVE)
            }).flatten();
            let new_id = format!("mem_{}", uuid::Uuid::new_v4());
            let mut rec = MemoryRecord::new_extracted(
                &new_id,
                &cand.kind,
                project_id,
                &cand.subject,
                &cand.content,
                cand.importance,
                embedding.clone(),
            );
            rec.keywords = cand_keywords(cand);
            rec.valid_from = now;
            // Confidence from evidence shape (§8.3).
            rec.confidence = crate::memory::scoring::write_confidence(
                !cand.quote.trim().is_empty(),
                cand.quote.trim().chars().count(),
                cand.message_ids.len() as i64,
            );
            if let Some((old, _)) = conflicting {
                // Preserve the stronger confidence across a same-kind swap.
                rec.confidence = rec.confidence.max(old.confidence * 0.9);
            }
            db::insert_memory(conn, &rec)?;
            let mut targets: Vec<String> = Vec::new();
            if let Some((old, _)) = conflicting {
                db::supersede_memory(conn, &old.id, &new_id)?;
                targets.push(old.id.clone());
            }
            for mid in &cand.message_ids {
                db::add_memory_evidence(conn, &new_id, session_id.unwrap_or(""), *mid, &cand.quote)?;
            }
            targets.insert(0, new_id.clone());
            Ok(Applied { op: "ADD".into(), target_ids: targets, new_id: Some(new_id) })
        }
    }
}

fn cand_keywords(cand: &MemoryCandidate) -> Vec<String> {
    cand.content
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 3)
        .map(|t| t.to_ascii_lowercase())
        .take(8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_ops() {
        let targets = vec!["mem_x".to_string()];
        assert_eq!(parse_judge_op("{\"operation\":\"ADD\"}", &targets), JudgeOp::Add);
        assert_eq!(
            parse_judge_op(
                "{\"operation\":\"UPDATE\",\"target_id\":\"mem_x\",\"merged_content\":\"User now prefers spaces\"}",
                &targets
            ),
            JudgeOp::Update { target_id: "mem_x".into(), merged_content: "User now prefers spaces".into() }
        );
        assert_eq!(parse_judge_op("{\"operation\":\"DELETE\",\"target_id\":\"mem_x\"}", &targets), JudgeOp::Delete { target_id: "mem_x".into() });
        assert_eq!(parse_judge_op("{\"operation\":\"NOOP\"}", &targets), JudgeOp::Noop);
    }

    #[test]
    fn unparseable_or_unsafe_targets_noop() {
        assert_eq!(parse_judge_op("I think ADD is right", &[]), JudgeOp::Noop);
        // Target not in the fetched set — a hallucinated id must not write.
        assert_eq!(parse_judge_op("{\"operation\":\"DELETE\",\"target_id\":\"hallucinated\"}", &["mem_x".into()]), JudgeOp::Noop);
        // UPDATE without merged content degrades to NOOP.
        assert_eq!(parse_judge_op("{\"operation\":\"UPDATE\",\"target_id\":\"mem_x\"}", &["mem_x".into()]), JudgeOp::Noop);
        // Fenced JSON parses.
        assert_eq!(parse_judge_op("```json\n{\"operation\":\"ADD\"}\n```", &[]), JudgeOp::Add);
    }

    #[test]
    fn add_supersedes_existing_exclusive_kind() {
        let conn = crate::db::mem();
        let old = MemoryRecord::new_extracted("old1", kind::PREFERENCE, None, "user", "User prefers tabs", 6, None);
        db::insert_memory(&conn, &old).unwrap();

        let cand = MemoryCandidate {
            content: "User now prefers spaces for indentation".into(),
            kind: kind::PREFERENCE.into(),
            subject: "user".into(),
            quote: "switch to spaces please".into(),
            message_ids: vec![3],
            importance: 7,
        };
        let similar = vec![(old.clone(), 0.91f32)];
        let input = JudgeInput { candidate: &cand, similar: &similar };
        let applied = apply_judge_op(&conn, &input, &JudgeOp::Add, Some("s1"), None, None, 1_000).unwrap();

        assert_eq!(applied.op, "ADD");
        let new_id = applied.new_id.unwrap();
        let old_row = db::get_memory(&conn, "old1").unwrap().unwrap();
        assert_eq!(old_row.status, "superseded");
        assert_eq!(old_row.superseded_by.as_deref(), Some(new_id.as_str()));
        let new_row = db::get_memory(&conn, &new_id).unwrap().unwrap();
        assert_eq!(new_row.valid_from, 1_000);
        assert!(new_row.confidence > 0.6);
        assert_eq!(db::evidence_count_for_memory(&conn, &new_id).unwrap(), 1);
    }

    #[test]
    fn delete_supersedes_and_keeps_history() {
        let conn = crate::db::mem();
        let old = MemoryRecord::new_extracted("old1", kind::FACT, None, "user", "User uses npm", 5, None);
        db::insert_memory(&conn, &old).unwrap();
        let cand = MemoryCandidate {
            content: "User migrated from npm to pnpm".into(),
            kind: kind::FACT.into(),
            subject: "user".into(),
            quote: "I switched to pnpm".into(),
            message_ids: vec![9],
            importance: 6,
        };
        let similar = vec![(old.clone(), 0.88f32)];
        let input = JudgeInput { candidate: &cand, similar: &similar };
        let applied = apply_judge_op(&conn, &input, &JudgeOp::Delete { target_id: "old1".into() }, Some("s1"), None, None, 2_000).unwrap();
        assert_eq!(applied.op, "DELETE");
        let old_row = db::get_memory(&conn, "old1").unwrap().unwrap();
        assert_eq!(old_row.status, "superseded");
        // Content bytes preserved (P3).
        assert_eq!(old_row.content, "User uses npm");
    }

    #[test]
    fn update_merges_and_corroborates() {
        let conn = crate::db::mem();
        let old = MemoryRecord::new_extracted("old1", kind::FACT, None, "user", "User likes Rust", 6, None);
        db::insert_memory(&conn, &old).unwrap();
        let cand = MemoryCandidate {
            content: "User dislikes C++ macros at work".into(),
            kind: kind::FACT.into(),
            subject: "user".into(),
            quote: "and I hate macros".into(),
            message_ids: vec![4],
            importance: 5,
        };
        let similar = vec![(old.clone(), 0.7f32)];
        let input = JudgeInput { candidate: &cand, similar: &similar };
        let applied = apply_judge_op(
            &conn,
            &input,
            &JudgeOp::Update { target_id: "old1".into(), merged_content: "User likes Rust and dislikes C++ macros at work".into() },
            Some("s1"),
            None,
            None,
            3_000,
        )
        .unwrap();
        assert_eq!(applied.op, "UPDATE");
        let row = db::get_memory(&conn, "old1").unwrap().unwrap();
        assert!(row.content.contains("Rust"));
        assert!(row.confidence > old.confidence);
        assert_eq!(row.status, "active");
    }
}
