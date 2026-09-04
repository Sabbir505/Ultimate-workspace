//! Pure scoring math (design §8 + §11.1). No I/O — everything here is
//! unit-testable without a DB or model.

use crate::memory::model::MemoryRecord;

/// Generative-Agents recency decay (0.995^hours), rescaled to days for a
/// coding assistant's interaction cadence (design §11.1).
pub fn recency_factor(last_accessed_at: Option<i64>, now: i64) -> f64 {
    match last_accessed_at {
        None => 1.0, // never accessed = fresh
        Some(t) => {
            let days = ((now - t).max(0)) as f64 / 86_400.0;
            0.995_f64.powf(days * 24.0)
        }
    }
}

/// Confidence decay: −0.05 per 30 days unaccessed, floor 0.35 (design §8.3).
pub fn confidence_after_decay(record_confidence: f64, last_accessed_at: Option<i64>, now: i64) -> f64 {
    match last_accessed_at {
        None => record_confidence,
        Some(t) => {
            let days = ((now - t).max(0)) as f64 / 86_400.0;
            (record_confidence - 0.05 * (days / 30.0)).max(0.35)
        }
    }
}

/// Write-time confidence from evidence shape (design §8.3):
/// base × directness × corroboration. Explicit user statements with a
/// verbatim quote score highest; inferred paraphrases start lower.
pub fn write_confidence(explicit: bool, quote_len_chars: usize, corroboration_count: i64) -> f64 {
    let base = if explicit { 0.85 } else { 0.55 };
    let directness = if quote_len_chars >= 12 { 1.0 } else { 0.8 };
    let corroboration = (0.75 + 0.25 * corroboration_count as f64).min(1.0);
    (base * directness * corroboration).min(1.0)
}

/// Min-max normalize a score list to [0,1]. Constant lists map to 0.5
/// (neutral — an unnormalized sum would let a flat component contribute
/// nothing while a spiky one dominates; with this, both behave).
pub fn minmax(values: &[f64]) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if (max - min).abs() < f64::EPSILON {
        return vec![0.5; values.len()];
    }
    values.iter().map(|v| (v - min) / (max - min)).collect()
}

/// One scored retrieval candidate.
#[derive(Debug, Clone)]
pub struct Scored {
    pub record: MemoryRecord,
    pub score: f64,
}

/// Hybrid retrieval score (design §11.1):
/// `1.0·relevance + 0.5·keyword + 0.3·recency + 0.5·utility`, each component
/// min-max normalized across the candidate set first. `vector_rel`/`kw_rel`
/// are raw similarities in [0,1] (`None` when that leg found nothing).
pub fn hybrid_scores(
    candidates: &[(MemoryRecord, Option<f32>, Option<f32>)],
    now: i64,
) -> Vec<Scored> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let vec_raw: Vec<f64> = candidates.iter().map(|(_, v, _)| v.map(|x| x as f64).unwrap_or(0.0)).collect();
    let kw_raw: Vec<f64> = candidates.iter().map(|(_, _, k)| k.map(|x| x as f64).unwrap_or(0.0)).collect();
    let rec_raw: Vec<f64> = candidates
        .iter()
        .map(|(m, _, _)| recency_factor(m.last_accessed_at, now))
        .collect();
    let util_raw: Vec<f64> = candidates
        .iter()
        .map(|(m, _, _)| (m.importance as f64 / 10.0) * m.confidence)
        .collect();

    let vec_n = minmax(&vec_raw);
    let kw_n = minmax(&kw_raw);
    let rec_n = minmax(&rec_raw);
    let util_n = minmax(&util_raw);

    candidates
        .iter()
        .zip(vec_n)
        .zip(kw_n)
        .zip(rec_n)
        .zip(util_n)
        .map(|(((((m, sv), sk), sr), su))| Scored {
            record: m.0.clone(),
            score: 1.0 * sv + 0.5 * sk + 0.3 * sr + 0.5 * su,
        })
        .collect()
}

/// Maximal-marginal-relevance re-ranking (design §11.1): λ=0.7 balances
/// score against diversity so five variants of one preference don't crowd
/// out distinct facts. `sim(a,b)` is cheap char-trigram Jaccard — no
/// embeddings needed at rank time.
pub fn mmr_rerank(mut scored: Vec<Scored>, k: usize) -> Vec<Scored> {
    const LAMBDA: f64 = 0.7;
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut chosen: Vec<Scored> = Vec::with_capacity(k);
    while chosen.len() < k && !scored.is_empty() {
        let mut best_idx = 0usize;
        let mut best_val = f64::NEG_INFINITY;
        for (i, cand) in scored.iter().enumerate() {
            let max_sim = chosen
                .iter()
                .map(|c| trigram_jaccard(&c.record.content, &cand.record.content))
                .fold(0.0_f64, f64::max);
            let val = LAMBDA * cand.score - (1.0 - LAMBDA) * max_sim;
            if val > best_val {
                best_val = val;
                best_idx = i;
            }
        }
        chosen.push(scored.remove(best_idx));
    }
    chosen
}

/// Character-trigram Jaccard similarity in [0,1]. Cheap, allocation-light,
/// and good enough for near-duplicate detection at retrieval time.
pub fn trigram_jaccard(a: &str, b: &str) -> f64 {
    fn tris(s: &str) -> std::collections::HashSet<String> {
        let lower: String = s.chars().map(|c| c.to_ascii_lowercase()).collect();
        let chars: Vec<char> = lower.chars().collect();
        if chars.len() < 3 {
            return std::collections::HashSet::from([lower]);
        }
        (0..=chars.len() - 3)
            .map(|i| chars[i..i + 3].iter().collect::<String>())
            .collect()
    }
    let (ta, tb) = (tris(a), tris(b));
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count() as f64;
    let union = ta.union(&tb).count() as f64;
    inter / union
}

/// Deterministic Tier-1/Tier-2 token budget enforcement: ~4 chars/token
/// (nomic-adjacent English average), dropping lowest-priority items first.
/// Items are `(priority, rendered_text)`; priority ties keep input order.
pub fn fit_budget(mut items: Vec<(f64, String)>, token_budget: usize) -> Vec<String> {
    items.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (_, text) in items {
        let cost = text.len().div_ceil(4);
        if used + cost > token_budget {
            continue;
        }
        used += cost;
        out.push(text);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, content: &str, importance: i64, conf: f64, last_acc: Option<i64>) -> MemoryRecord {
        let mut r = MemoryRecord::new_extracted(id, "preference", None, "user", content, importance, None);
        r.confidence = conf;
        r.last_accessed_at = last_acc;
        r
    }

    #[test]
    fn recency_decays_with_age() {
        let now = 1_000_000_000;
        assert_eq!(recency_factor(None, now), 1.0);
        // 3600s = 1 hour = 1/24 day → 0.995^(24 × 1/24) = 0.995^1.
        let fresh = recency_factor(Some(now - 3600), now);
        let old = recency_factor(Some(now - 30 * 86_400), now);
        assert!((fresh - 0.995_f64.powf(1.0)).abs() < 1e-6);
        assert!(old < fresh);
    }

    #[test]
    fn confidence_floors_at_035() {
        let now = 1_000_000_000;
        let c = confidence_after_decay(0.9, Some(now - 400 * 86_400), now);
        assert!((c - 0.35).abs() < 1e-9);
        assert_eq!(confidence_after_decay(0.9, None, now), 0.9);
    }

    #[test]
    fn write_confidence_explicit_beats_inferred() {
        assert!(write_confidence(true, 40, 1) > write_confidence(false, 5, 0));
        // Max explicit confidence: 0.85 base × 1.0 directness × 1.0 corroboration.
        let c = write_confidence(true, 40, 5);
        assert!(c <= 1.0 && (c - 0.85).abs() < 1e-9);
    }

    #[test]
    fn minmax_handles_constant_and_empty() {
        assert_eq!(minmax(&[]), Vec::<f64>::new());
        assert_eq!(minmax(&[2.0, 2.0]), vec![0.5, 0.5]);
        let n = minmax(&[1.0, 3.0]);
        assert!((n[0] - 0.0).abs() < 1e-9 && (n[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn hybrid_prefers_relevant_high_utility() {
        let now = 1_000_000_000;
        let cands = vec![
            (m("a", "likes pnpm", 6, 0.9, Some(now)), Some(0.9), Some(0.8)),
            (m("b", "dislikes c++", 6, 0.9, Some(now)), Some(0.1), None),
        ];
        let scored = hybrid_scores(&cands, now);
        assert!(scored[0].score > scored[1].score);
    }

    #[test]
    fn mmr_promotes_diverse_second_pick() {
        let now = 1_000_000_000;
        // Near-identical vector scores so similarity, not score, decides the
        // second slot: `a` wins first; the near-duplicate `b` must lose to
        // the distinct `c` despite `b`'s slightly higher relevance.
        let cands = vec![
            (m("a", "alpha beta gamma delta epsilon", 8, 0.9, None), Some(0.90), None),
            (m("b", "alpha beta gamma delta epsilon zeta", 8, 0.9, None), Some(0.86), None),
            (m("c", "omega sigma tau phi chi", 8, 0.9, None), Some(0.85), None),
        ];
        let top = mmr_rerank(hybrid_scores(&cands, now), 3);
        assert_eq!(top[0].record.id, "a");
        assert_eq!(top[1].record.id, "c");
    }

    #[test]
    fn budget_drops_lowest_priority() {
        let items = vec![
            (1.0, "high priority fact that is longish".to_string()),
            (0.2, "low".to_string()),
            (0.8, "medium".to_string()),
        ];
        let kept = fit_budget(items, 10); // ~40 chars total available
        assert_eq!(kept.len(), 2);
        assert!(kept[0].contains("high priority"));
    }
}
