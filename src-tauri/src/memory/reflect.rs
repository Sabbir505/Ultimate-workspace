//! Reflection (MEMORY_DESIGN_ARCHITECTURE.md §8.4) — the write-side
//! compaction that keeps the store small and abstract as raw memories
//! accumulate. Generative-Agents' mechanism, rescaled: when the summed
//! importance of unreflected active memories crosses a threshold, the
//! highest-importance sample is synthesized into a few cited insights
//! (kind=fact, origin=reflection) that compete in retrieval like any other
//! memory; the sources are then marked `reflected` (retirement stays a
//! separate, user-visible decision).
//!
//! The LLM calls live in `worker.rs`; everything here is deterministic and
//! unit-tested: trigger math, prompt building, tolerant parsing, and the
//! store effect of applying insights.

use crate::db;
use crate::memory::model::{origin, status, MemoryRecord};
use rusqlite::Connection;

/// Trigger: Generative-Agents' threshold of 150 summed importance points,
/// plus a count backstop so a stream of low-importance facts eventually
/// reflects too.
pub const IMPORTANCE_THRESHOLD: f64 = 150.0;
pub const COUNT_THRESHOLD: i64 = 25;
/// Sample width fed to the synthesizer (their 100-most-recent, rescaled).
pub const SAMPLE_SIZE: usize = 20;
/// Cap on insights per pass (they asked for 5; 3 keeps the store leaner).
pub const MAX_INSIGHTS: usize = 3;

/// Everything the synthesis step needs, gathered under the DB lock.
pub struct ReflectionInput {
    pub sample: Vec<MemoryRecord>,
}

/// Check the trigger and gather the sample, or `None` when reflection isn't
/// due. Call while holding the DB lock.
pub fn reflection_due(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
) -> db::DbResult<Option<ReflectionInput>> {
    let (count, importance_sum) = db::unreflected_stats(conn, profile, project_id)?;
    if (importance_sum < IMPORTANCE_THRESHOLD) && (count < COUNT_THRESHOLD) {
        return Ok(None);
    }
    Ok(Some(ReflectionInput {
        sample: db::unreflected_sample(conn, profile, project_id, SAMPLE_SIZE)?,
    }))
}

pub const QUESTIONS_SYSTEM: &str = "You maintain long-term memory for a personal coding \
assistant. Given a set of remembered facts about the user, identify the 3 MOST SALIENT \
high-level questions worth synthesizing an answer to (themes like workflow, tooling \
choices, project direction, communication style). Return ONLY a JSON array of 3 question \
strings, no prose.";

pub const INSIGHTS_SYSTEM: &str = "You maintain long-term memory for a personal coding \
assistant. Synthesize the remembered facts (and any retrieved context) into UP TO 3 \
high-level INSIGHTS — durable statements about the user or their projects that go beyond \
any single fact. Each insight must be ONE self-contained sentence in third person, \
timeless tense, grounded in the given facts. Return ONLY JSON, no prose: \
{\"insights\":[{\"content\":\"...\",\"cites\":[\"<memory id>\",...]}]} \
Every insight MUST cite the ids of the facts it draws from.";

/// Render the questions prompt (step 1).
pub fn questions_user_message(input: &ReflectionInput) -> String {
    let mut s = String::from("Remembered facts (id · importance · content):\n");
    for m in &input.sample {
        s.push_str(&format!("[{}] ({}) {}\n", m.id, m.importance, m.content));
    }
    s.push_str("\nReturn the 3 most salient synthesis questions as a JSON array.");
    s
}

/// Render the insights prompt (step 2): questions as lenses over the facts,
/// plus extra keyword-matched context the caller retrieved per question.
pub fn insights_user_message(
    input: &ReflectionInput,
    questions: &[String],
    extra_context: &[(String, Vec<String>)],
) -> String {
    let mut s = String::from("Questions to synthesize:\n");
    for q in questions {
        s.push_str(&format!("- {q}\n"));
    }
    s.push_str("\nRemembered facts (id · content):\n");
    for m in &input.sample {
        s.push_str(&format!("[{}] {}\n", m.id, m.content));
    }
    if !extra_context.is_empty() {
        s.push_str("\nRelated memories retrieved per question:\n");
        for (q, hits) in extra_context {
            if hits.is_empty() {
                continue;
            }
            s.push_str(&format!("For \"{q}\":\n"));
            for h in hits {
                s.push_str(&format!("  - {h}\n"));
            }
        }
    }
    s.push_str("\nReturn up to 3 cited insights as JSON now.");
    s
}

/// Tolerant parse of the questions step.
pub fn parse_questions(raw: &str) -> Vec<String> {
    let text = raw.trim();
    let body = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text)
        .trim();
    let start = match body.find('[') {
        Some(i) => &body[i..],
        None => return Vec::new(),
    };
    let end = match start.rfind(']') {
        Some(i) => &start[..=i],
        None => return Vec::new(),
    };
    serde_json::from_str::<Vec<String>>(end)
        .unwrap_or_default()
        .into_iter()
        .filter(|q| !q.trim().is_empty())
        .take(3)
        .collect()
}

/// One parsed insight: content + the memory ids it cites.
#[derive(Debug, Clone, PartialEq)]
pub struct Insight {
    pub content: String,
    pub cites: Vec<String>,
}

/// Tolerant parse of the insights step. Invalid entries (empty content, no
/// cites, unknown ids) are dropped by the caller's valid-id filter.
pub fn parse_insights(raw: &str) -> Vec<Insight> {
    let text = raw.trim();
    let body = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text)
        .trim();
    let start = match body.find('{') {
        Some(i) => &body[i..],
        None => return Vec::new(),
    };
    let end = match start.rfind('}') {
        Some(i) => &start[..=i],
        None => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(end) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for item in v["insights"].as_array().unwrap_or(&vec![]).iter() {
        let content = item["content"].as_str().unwrap_or("").trim().to_string();
        let cites: Vec<String> = item["cites"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| c.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if content.is_empty() || content.chars().count() > 400 || cites.is_empty() {
            continue;
        }
        out.push(Insight { content, cites });
        if out.len() >= MAX_INSIGHTS {
            break;
        }
    }
    out
}

/// Store the insights as first-class memories and mark the sample reflected.
/// Insight confidence = mean of cited sources' confidence (bounded below by
/// 0.5 — synthesis of many sightings is at least moderately trustworthy);
/// importance = max cited importance, clamped to the rubric ceiling.
/// Call while holding the DB lock.
pub fn apply_reflection(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
    sample: &[MemoryRecord],
    insights: &[Insight],
    session_id: Option<&str>,
    now: i64,
) -> db::DbResult<usize> {
    let valid_ids: Vec<&str> = sample.iter().map(|m| m.id.as_str()).collect();
    let mut applied = 0usize;
    let mut all_touched: Vec<String> = sample.iter().map(|m| m.id.clone()).collect();
    for ins in insights {
        let cites: Vec<&str> = ins
            .cites
            .iter()
            .map(|c| c.as_str())
            .filter(|c| valid_ids.contains(c))
            .collect();
        if cites.is_empty() {
            continue;
        }
        let sources: Vec<&MemoryRecord> = sample
            .iter()
            .filter(|m| cites.contains(&m.id.as_str()))
            .collect();
        let importance = sources
            .iter()
            .map(|m| m.importance)
            .max()
            .unwrap_or(5)
            .clamp(1, 9);
        let confidence = (sources.iter().map(|m| m.confidence).sum::<f64>()
            / sources.len() as f64)
            .max(0.5);
        let new_id = format!("mem_{}", uuid::Uuid::new_v4());
        let mut rec = MemoryRecord::new_extracted(
            &new_id,
            crate::memory::model::kind::FACT,
            project_id,
            "user",
            &ins.content,
            importance,
            None,
        );
        rec.profile = profile.to_string();
        rec.origin = origin::REFLECTION.to_string();
        rec.confidence = confidence;
        rec.valid_from = now;
        db::insert_memory(conn, &rec)?;
        // Evidence pointers back to the sources (P4 — provenance survives
        // synthesis, so the UI can drill from insight to quotes).
        for src in &sources {
            let ev = db::evidence_for_memory(conn, &src.id)?;
            for (sid, mid, quote) in ev {
                db::add_memory_evidence(conn, &new_id, &sid, mid, &quote)?;
            }
        }
        db::log_memory_op(
            conn,
            "reflection",
            session_id,
            &ins.content,
            "REFLECT",
            &cites.iter().map(|c| c.to_string()).collect::<Vec<_>>(),
            "",
        )?;
        all_touched.extend(cites.iter().map(|c| c.to_string()));
        applied += 1;
    }
    // Mark the whole sample reflected — facts considered and not cited are
    // still "seen", so the trigger doesn't re-fire on the same pool forever.
    db::mark_reflected(conn, &all_touched)?;
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, content: &str, importance: i64, conf: f64) -> MemoryRecord {
        let mut r = MemoryRecord::new_extracted(id, "preference", None, "user", content, importance, None);
        r.confidence = conf;
        r
    }

    #[test]
    fn trigger_fires_on_importance_sum_and_count() {
        let conn = crate::db::mem();
        // One importance-5 fact: under both thresholds.
        crate::db::insert_memory(&conn, &m("a", "small fact", 5, 0.9)).unwrap();
        assert!(reflection_due(&conn, "default", None).unwrap().is_none());

        // 30 × importance 5 = 150 → fires on the sum.
        for i in 0..30 {
            crate::db::insert_memory(&conn, &m(&format!("m{i}"), &format!("fact number {i}"), 5, 0.8))
                .unwrap();
        }
        let due = reflection_due(&conn, "default", None).unwrap().unwrap();
        assert_eq!(due.sample.len(), 20); // capped at SAMPLE_SIZE

        // Count backstop: 25 low-importance facts also fire.
        let conn2 = crate::db::mem();
        for i in 0..25 {
            crate::db::insert_memory(&conn2, &m(&format!("m{i}"), &format!("tiny fact {i}"), 1, 0.8))
                .unwrap();
        }
        assert!(reflection_due(&conn2, "default", None).unwrap().is_some());
    }

    #[test]
    fn parses_questions_and_insights_tolerantly() {
        let qs = parse_questions("```json\n[\"What tools does the user prefer?\",\"What is the project direction?\",\"How should answers be formatted?\"]\n```");
        assert_eq!(qs.len(), 3);
        assert!(parse_questions("no json").is_empty());

        let raw = r#"Here you go: {"insights":[
            {"content":"User builds Rust tooling on Windows","cites":["m1","m2"]},
            {"content":"uncited opinion","cites":[]},
            {"content":"","cites":["m1"]}
        ]}"#;
        let ins = parse_insights(raw);
        assert_eq!(ins.len(), 1);
        assert_eq!(ins[0].cites, vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn apply_inserts_insight_with_provenance_and_marks_sample() {
        let conn = crate::db::mem();
        let s1 = m("m1", "User uses pnpm", 6, 0.9);
        let s2 = m("m2", "User dislikes npm scripts", 7, 0.7);
        crate::db::insert_memory(&conn, &s1).unwrap();
        crate::db::insert_memory(&conn, &s2).unwrap();
        crate::db::add_memory_evidence(&conn, "m1", "s1", 3, "I always use pnpm").unwrap();

        let insights = vec![Insight {
            content: "User's package management is centered on pnpm, not npm".into(),
            cites: vec!["m1".into(), "m2".into()],
        }];
        let n = apply_reflection(&conn, "default", None, &[s1.clone(), s2.clone()], &insights, Some("s9"), 5_000)
            .unwrap();
        assert_eq!(n, 1);

        let all = crate::db::list_memories(&conn, "default", false).unwrap();
        let insight_row = all.iter().find(|r| r.origin == "reflection").unwrap();
        assert_eq!(insight_row.importance, 7); // max of cited
        assert!((insight_row.confidence - 0.8).abs() < 1e-9); // mean of 0.9/0.7
        assert_eq!(insight_row.status, "active");
        // Provenance copied from sources.
        assert!(crate::db::evidence_count_for_memory(&conn, &insight_row.id).unwrap() >= 1);
        // Whole sample marked reflected (cited + uncited alike).
        assert!(crate::db::get_memory(&conn, "m1").unwrap().unwrap().reflected);
        assert!(crate::db::get_memory(&conn, "m2").unwrap().unwrap().reflected);
        // Reflection memories don't count back into the trigger.
        let (count, _) = crate::db::unreflected_stats(&conn, "default", None).unwrap();
        assert_eq!(count, 0);

        // Sources stay ACTIVE — retirement is a separate user-visible decision.
        assert_eq!(s1.status, "active");
        assert_eq!(
            crate::db::get_memory(&conn, "m1").unwrap().unwrap().status,
            status::ACTIVE
        );
        let _ = origin::REFLECTION; // referenced above via rec.origin
    }
}
