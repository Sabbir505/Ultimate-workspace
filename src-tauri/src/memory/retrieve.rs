//! Hybrid retrieval (design §11.1): hard filters → vector leg (brute cosine)
//! ∪ keyword leg (FTS5) → fused hybrid score → MMR diversity → top-k.
//! DB-only; the caller embeds the query (needs the sidecar) and passes it in.

use crate::db;
use crate::memory::model::{MemoryRecord, MIN_CONFIDENCE};
use crate::memory::scoring::{hybrid_scores, mmr_rerank, Scored};
use rusqlite::Connection;

/// Search the ACTIVE store for a scope. `query_embedding` is `None` when the
/// embedding sidecar is down — retrieval then runs keyword-only (graceful
/// degradation, design §9.2). Returns up to `k` records ranked best-first.
pub fn search_memories(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
    query: &str,
    query_embedding: Option<&[f32]>,
    k: usize,
) -> db::DbResult<Vec<Scored>> {
    // 1. Candidate union: vector top-sim ∪ FTS hits (both legs apply the
    //    scope + active + confidence hard filters in SQL). `seen` maps
    //    memory-id → index so a hit from both legs merges its signals.
    let mut cands: Vec<(MemoryRecord, Option<f32>, Option<f32>)> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let push = |rec: MemoryRecord, v: Option<f32>, kw: Option<f32>,
                    cands: &mut Vec<(MemoryRecord, Option<f32>, Option<f32>)>,
                    seen: &mut std::collections::HashMap<String, usize>| {
        if let Some(&i) = seen.get(&rec.id) {
            if v.is_some() { cands[i].1 = v; }
            if kw.is_some() { cands[i].2 = kw; }
            return;
        }
        seen.insert(rec.id.clone(), cands.len());
        cands.push((rec, v, kw));
    };

    if let Some(qv) = query_embedding {
        // Vector leg: load all scoped actives and cosine in Rust (same as
        // docs search — thousands of rows, no ANN warranted).
        let all = db::active_memories_for_scope(conn, profile, project_id)?;
        let qnorm = qv.iter().map(|x| x * x).sum::<f32>().sqrt();
        if qnorm > 0.0 {
            for mut m in all {
                let v = match &m.embedding {
                    Some(e) if e.len() == qv.len() => e,
                    _ => continue,
                };
                let vnorm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if vnorm == 0.0 {
                    continue;
                }
                let dot = qv.iter().zip(v.iter()).map(|(a, b)| a * b).sum::<f32>();
                let sim = dot / (qnorm * vnorm);
                if sim >= 0.2 {
                    m.embedding = None; // don't haul blobs through scoring
                    push(m, Some(sim), None, &mut cands, &mut seen);
                }
            }
        }
    }

    // Keyword leg (FTS5 bm25 → take rank order, map to pseudo-relevance).
    for (i, m) in db::search_memories_fts(conn, profile, project_id, query, 10)?
        .into_iter()
        .enumerate()
    {
        let pseudo = 1.0 - (i as f32 * 0.1); // bm25 rank order → 1.0, 0.9, …
        let mut m = m;
        m.embedding = None;
        push(m, None, Some(pseudo), &mut cands, &mut seen);
    }

    // 2. Effective confidence: stored (epistemic) confidence adjusted for
    //    staleness (§8.3 — read-time decay avoids a compounding background
    //    job), then the hard floor filter.
    let now = crate::db::now_ts();
    let cands: Vec<_> = cands
        .into_iter()
        .map(|(mut m, v, kw)| {
            m.confidence = crate::memory::scoring::confidence_after_decay(
                m.confidence,
                m.last_accessed_at,
                now,
            );
            (m, v, kw)
        })
        .filter(|(m, _, _)| m.confidence >= MIN_CONFIDENCE)
        .collect();
    // 3. Fused score + 4. diversity.
    let mut scored = hybrid_scores(&cands, now);
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(mmr_rerank(scored, k))
}

/// Convenience wrapper: `Option<Scored>` rows → records, and bump access
/// counters (recency decay reads these).
pub fn search_and_touch(
    conn: &Connection,
    profile: &str,
    project_id: Option<&str>,
    query: &str,
    query_embedding: Option<&[f32]>,
    k: usize,
) -> db::DbResult<Vec<MemoryRecord>> {
    let hits = search_memories(conn, profile, project_id, query, query_embedding, k)?;
    let ids: Vec<String> = hits.iter().map(|s| s.record.id.clone()).collect();
    if !ids.is_empty() {
        db::bump_memory_access(conn, &ids)?;
    }
    Ok(hits.into_iter().map(|s| s.record).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::model::MemoryRecord;

    #[test]
    fn keyword_leg_finds_exact_terms() {
        let conn = crate::db::mem();
        let mut m = MemoryRecord::new_extracted("m1", "preference", None, "user", "Builds with pnpm workspaces", 6, None);
        m.embedding = Some(vec![0.1, 0.2, 0.3]);
        crate::db::insert_memory(&conn, &m).unwrap();
        let mut m2 = MemoryRecord::new_extracted("m2", "fact", None, "user", "Uses Tauri v2 on Windows", 6, None);
        m2.embedding = Some(vec![0.3, 0.2, 0.1]);
        crate::db::insert_memory(&conn, &m2).unwrap();

        // No embedding (sidecar down): keyword-only degradation still works.
        let hits = search_memories(&conn, "default", None, "pnpm workspaces", None, 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].record.id, "m1");

        // Vector leg alone (no keyword overlap).
        let hits = search_memories(&conn, "default", None, "build tooling", Some(&[0.1, 0.2, 0.3]), 5).unwrap();
        assert_eq!(hits[0].record.id, "m1");

        // Project scoping excludes project rows from global queries.
        let mut proj = MemoryRecord::new_extracted("p1", "project", Some("proj1"), "project", "Auth migration to OIDC", 7, None);
        proj.embedding = Some(vec![0.5, 0.5, 0.5]);
        crate::db::insert_memory(&conn, &proj).unwrap();
        let hits = search_memories(&conn, "default", None, "auth", Some(&[0.5, 0.5, 0.5]), 5).unwrap();
        assert!(hits.iter().all(|h| h.record.id != "p1"));
        let hits = search_memories(&conn, "default", Some("proj1"), "auth migration", Some(&[0.5, 0.5, 0.5]), 5).unwrap();
        assert!(hits.iter().any(|h| h.record.id == "p1"));
    }

    #[test]
    fn low_confidence_filtered_out() {
        let conn = crate::db::mem();
        let mut m = MemoryRecord::new_extracted("m1", "fact", None, "user", "User might like vim keybindings", 4, None);
        m.confidence = 0.2; // below the 0.35 floor
        crate::db::insert_memory(&conn, &m).unwrap();
        let hits = search_memories(&conn, "default", None, "vim keybindings", None, 5).unwrap();
        assert!(hits.is_empty());
    }
}
