//! Offline eval gate for hybrid local-docs retrieval (research doc Part B
//! (d); fixture pattern borrowed from memory/eval.rs). Test-only.
//!
//! A synthetic corpus with HAND-AUTHORED 3-dim embeddings and known gold
//! chunk paths gates the RRF hybrid search (`db::docs::search_chunks_hybrid`):
//!
//! 1. Keyword-shaped query — the vector leg (by fixture construction) ranks
//!    the gold doc outside the top-8; the FTS leg must rescue it, so hybrid
//!    recall@8 ≥ the vector-only leg's recall@8.
//! 2. Semantic-shaped query — no query token appears in any document, so the
//!    FTS leg is blind; the vector leg must carry it, so hybrid recall@8 ≥
//!    the FTS-only leg's recall@8.
//! 3. Mixed query — the gold doc is hit by BOTH legs; fusion must never lose
//!    it (and by RRF arithmetic it must rank first: 2/(60+1) beats any
//!    single-leg score ≤ 1/(60+1)).
//!
//! Deterministic: no network, no RNG, fixed embeddings.

use rusqlite::Connection;

use super::docs::{
    add_corpus, replace_file_chunks, search_chunks, search_chunks_hybrid,
};

/// One hand-authored chunk: content, 3-dim embedding, display heading.
struct Fixture {
    path: String,
    content: String,
    emb: [f32; 3],
    heading: String,
}

/// Build the synthetic corpus in a fresh in-memory DB (schema + FTS index +
/// migrations via `mem()`). Returns (conn, corpus_id).
fn fixture() -> (Connection, String) {
    let conn = super::mem();
    let corpus = add_corpus(&conn, "D:/eval-corpus", "eval").unwrap();

    // Gold docs.
    let mut fixtures = vec![
        // Keyword gold: exact query terms, embedding pointing AWAY from the
        // keyword query vector (the embedder "would" rank it low).
        Fixture {
            path: "harvest/kumquat.md".into(),
            content: "the kumquat harvest guide explains kumquat picking season".into(),
            emb: [0.1, 0.95, 0.1],
            heading: "Harvest".into(),
        },
        // Semantic gold: no shared tokens with the semantic query text.
        Fixture {
            path: "science/fermentation.md".into(),
            content: "fermenting vegetable brines with lactobacillus cultures".into(),
            emb: [0.05, 0.1, 0.98],
            heading: "Science > Fermentation".into(),
        },
        // Mixed gold: hit by BOTH legs of the mixed query.
        Fixture {
            path: "harvest/orchard.md".into(),
            content: "kumquat orchard irrigation log".into(),
            emb: [0.9, 0.1, 0.05],
            heading: "Harvest > Orchard".into(),
        },
        // Near-keyway junk (matched by the queries' FTS noise only).
        Fixture {
            path: "culture/venue.md".into(),
            content: "the village culture festival poster".into(),
            emb: [0.3, 0.8, 0.2],
            heading: String::new(),
        },
        Fixture {
            path: "food/michelin.md".into(),
            content: "michelin star restaurant science coverage".into(),
            emb: [0.4, 0.7, 0.1],
            heading: String::new(),
        },
    ];
    // Nine vector-near fillers: enough that the keyword gold lands OUTSIDE
    // the vector leg's top-8 (14 chunks total → a real recall@8 cut).
    for i in 0..9 {
        fixtures.push(Fixture {
            path: format!("filler/notes{i}.md"),
            content: "filler meeting notes about routine office planning".into(),
            emb: [0.88 + i as f32 * 0.012, 0.3, 0.05],
            heading: String::new(),
        });
    }
    for f in &fixtures {
        put(&conn, &corpus.id, f);
    }
    (conn, corpus.id)
}

fn put(conn: &Connection, corpus_id: &str, f: &Fixture) {
    replace_file_chunks(
        conn,
        corpus_id,
        &f.path,
        "text",
        &[(f.content.clone(), f.emb.to_vec(), f.heading.clone())],
    )
    .unwrap();
}

#[test]
fn eval_hybrid_docs_recall_at_8() {
    let (conn, corpus_id) = fixture();
    let corpus_id = corpus_id.as_str();
    const TOP_K: usize = 8;
    const LEG_LIMIT: usize = 50;

    // ── 1. Keyword-shaped query: FTS-strong, vector-blind by construction ──
    let kw_q = "kumquat harvest";
    let kw_vec = [1.0f32, 0.1, 0.0];
    let gold_kw = "harvest/kumquat.md";
    // Fixture sanity: the vector leg alone must MISS the gold (it ranks 11th
    // of 12), otherwise this case proves nothing about the fusion.
    let vector_only = search_chunks(&conn, &kw_vec, TOP_K).unwrap();
    assert!(
        !vector_only.iter().any(|h| h.path == gold_kw),
        "fixture broken: keyword gold must fall outside the vector-only top-{TOP_K}"
    );
    // FTS-only leg (no embedding — the sidecar-down path) finds it.
    let fts_only =
        search_chunks_hybrid(&conn, kw_q, None, None, LEG_LIMIT, TOP_K).unwrap();
    assert!(fts_only.iter().any(|h| h.path == gold_kw));
    // Hybrid ≥ each single leg on the strong leg's case.
    let hybrid =
        search_chunks_hybrid(&conn, kw_q, Some(&kw_vec), None, LEG_LIMIT, TOP_K).unwrap();
    let recall = |hits: &[super::docs::ChunkHit], gold: &str| -> f64 {
        if hits.iter().any(|h| h.path == gold) { 1.0 } else { 0.0 }
    };
    let hybrid_r = recall(&hybrid, gold_kw);
    assert_eq!(hybrid_r, 1.0, "hybrid lost the keyword gold at @{TOP_K}");
    assert!(hybrid_r >= recall(&vector_only, gold_kw));
    assert!(hybrid_r >= recall(&fts_only, gold_kw));
    // And fusion lifts it above every vector-near filler.
    let kw_rank = hybrid.iter().position(|h| h.path == gold_kw).unwrap();
    assert!(
        hybrid[..kw_rank].iter().all(|h| h.path.starts_with("harvest/")),
        "fillers outrank the keyword gold: {:?}",
        hybrid.iter().map(|h| h.path.as_str()).collect::<Vec<_>>()
    );

    // ── 2. Semantic-shaped query: vector-strong, FTS-blind by construction ──
    let sem_q = "probiotic pickle science";
    let sem_vec = [0.02f32, 0.05, 1.0];
    let gold_sem = "science/fermentation.md";
    // Fixture sanity: no token of sem_q may appear in the gold's text, or the
    // FTS leg would get credit for the vector leg's work.
    assert!(!["probiotic", "pickle", "science"]
        .iter()
        .any(|t| gold_sem_content().contains(t)));
    let fts_only =
        search_chunks_hybrid(&conn, sem_q, None, None, LEG_LIMIT, TOP_K).unwrap();
    assert!(
        !fts_only.iter().any(|h| h.path == gold_sem),
        "fixture broken: semantic gold matched the keyword leg"
    );
    let vector_only = search_chunks(&conn, &sem_vec, TOP_K).unwrap();
    let hybrid =
        search_chunks_hybrid(&conn, sem_q, Some(&sem_vec), None, LEG_LIMIT, TOP_K).unwrap();
    let hybrid_r = recall(&hybrid, gold_sem);
    assert_eq!(hybrid_r, 1.0, "hybrid lost the semantic gold at @{TOP_K}");
    assert!(hybrid_r >= recall(&fts_only, gold_sem));
    assert!(hybrid_r >= recall(&vector_only, gold_sem));

    // ── 3. Mixed query: both legs hit the gold — fusion must never lose it ──
    let mix_q = "orchard kumquat irrigation";
    let mix_vec = [0.95f32, 0.12, 0.03];
    let gold_both = "harvest/orchard.md";
    let fts_leg_only =
        search_chunks_hybrid(&conn, mix_q, None, None, LEG_LIMIT, TOP_K).unwrap();
    let vec_leg_only = search_chunks(&conn, &mix_vec, TOP_K).unwrap();
    assert!(fts_leg_only.iter().any(|h| h.path == gold_both));
    assert!(vec_leg_only.iter().any(|h| h.path == gold_both));
    let hybrid =
        search_chunks_hybrid(&conn, mix_q, Some(&mix_vec), None, LEG_LIMIT, TOP_K).unwrap();
    assert!(
        hybrid.iter().any(|h| h.path == gold_both),
        "hybrid lost the both-legs gold doc on the mixed case"
    );
    // RRF arithmetic: 2/(60+1) beats any single-leg score ≤ 1/(60+1), so the
    // both-legs doc must rank FIRST.
    assert_eq!(
        hybrid[0].path, gold_both,
        "both-legs doc must outrank single-leg hits"
    );
    assert!(hybrid[0].heading == "Harvest > Orchard", "enrichment rides along");

    // Corpus scoping still works through the hybrid entry point.
    let scoped =
        search_chunks_hybrid(&conn, mix_q, Some(&mix_vec), Some(corpus_id), LEG_LIMIT, 3)
            .unwrap();
    assert!(scoped.iter().any(|h| h.path == gold_both));
    assert!(scoped.iter().all(|h| h.corpus_id == corpus_id));
}

/// The gold semantic doc's indexed content (kept in sync with the fixture).
fn gold_sem_content() -> &'static str {
    "fermenting vegetable brines with lactobacillus cultures"
}
