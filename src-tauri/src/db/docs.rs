//! Local document corpora (local RAG) — persistence.
//!
//! A corpus is a user-added folder of text/image files whose contents are
//! chunked and embedded by a local llama-server embedding sidecar
//! (nomic-embed-text). Chunks store their vector as a little-endian f32 BLOB
//! and search is brute-force cosine in Rust — at folder scale (tens of
//! thousands of chunks × 768 dims) that's single-digit milliseconds, so no
//! ANN index or sqlite-vec extension is warranted.
//!
//! Three tables (created in init_schema, self-migrating):
//!   doc_corpora — one row per added folder + cached counts;
//!   doc_files   — mtime/size per indexed file, the incremental-reindex diff;
//!   doc_chunks  — chunk text ("image" kind holds the OCR/caption surrogate)
//!                 plus its embedding BLOB.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::{new_id, now_ts, DbResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocCorpus {
    pub id: String,
    pub name: String,
    pub path: String,
    pub enabled: bool,
    pub created_at: i64,
    pub last_indexed_at: Option<i64>,
    pub file_count: i64,
    pub chunk_count: i64,
}

fn map_corpus(row: &Row) -> rusqlite::Result<DocCorpus> {
    Ok(DocCorpus {
        id: row.get("id")?,
        name: row.get("name")?,
        path: row.get("path")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        last_indexed_at: row.get("last_indexed_at")?,
        file_count: row.get("file_count")?,
        chunk_count: row.get("chunk_count")?,
    })
}

const CORPUS_COLUMNS: &str =
    "id, name, path, enabled, created_at, last_indexed_at, file_count, chunk_count";

pub fn add_corpus(conn: &Connection, path: &str, name: &str) -> DbResult<DocCorpus> {
    let id = new_id();
    conn.execute(
        "INSERT INTO doc_corpora (id, name, path, enabled, created_at)
         VALUES (?1, ?2, ?3, 1, ?4)",
        params![id, name, path, now_ts()],
    )?;
    get_corpus(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_corpus(conn: &Connection, corpus_id: &str) -> DbResult<Option<DocCorpus>> {
    conn.query_row(
        &format!("SELECT {CORPUS_COLUMNS} FROM doc_corpora WHERE id = ?1"),
        params![corpus_id],
        map_corpus,
    )
    .optional()
}

pub fn get_corpus_by_path(conn: &Connection, path: &str) -> DbResult<Option<DocCorpus>> {
    conn.query_row(
        &format!("SELECT {CORPUS_COLUMNS} FROM doc_corpora WHERE path = ?1"),
        params![path],
        map_corpus,
    )
    .optional()
}

pub fn list_corpora(conn: &Connection) -> DbResult<Vec<DocCorpus>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CORPUS_COLUMNS} FROM doc_corpora ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map([], map_corpus)?;
    rows.collect()
}

pub fn set_corpus_enabled(conn: &Connection, corpus_id: &str, enabled: bool) -> DbResult<()> {
    conn.execute(
        "UPDATE doc_corpora SET enabled = ?2 WHERE id = ?1",
        params![corpus_id, enabled as i64],
    )?;
    Ok(())
}

/// Remove a corpus and everything it indexed.
pub fn remove_corpus(conn: &Connection, corpus_id: &str) -> DbResult<()> {
    // The three deletes are one logical removal: bare, a failure midway (say
    // chunks gone, corpus row alive) left a half-removed corpus whose stale
    // doc_files rows a re-index would trust. One unchecked_transaction with
    // `?` propagation, matching `delete_chat_session` (db/chat.rs).
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM doc_chunks WHERE corpus_id = ?1",
        params![corpus_id],
    )?;
    tx.execute(
        "DELETE FROM doc_files WHERE corpus_id = ?1",
        params![corpus_id],
    )?;
    tx.execute("DELETE FROM doc_corpora WHERE id = ?1", params![corpus_id])?;
    tx.commit()?;
    Ok(())
}

/// Stamp the corpus totals after an index pass.
pub fn finish_index(
    conn: &Connection,
    corpus_id: &str,
    file_count: i64,
    chunk_count: i64,
) -> DbResult<()> {
    conn.execute(
        "UPDATE doc_corpora SET last_indexed_at = ?2, file_count = ?3, chunk_count = ?4
         WHERE id = ?1",
        params![corpus_id, now_ts(), file_count, chunk_count],
    )?;
    Ok(())
}

/// Schema version of the chunk SHAPES (chunker behavior + enrichment
/// metadata) a corpus was last indexed with. Bump when chunking or chunk
/// metadata changes so every corpus is re-chunked once: the mtime/size diff
/// can never see these changes on its own. v1 = heading-trail enrichment +
/// the doc_chunks_fts keyword index. v2 = contextual chunk enrichment: the
/// embedder input became `path · heading + content`
/// (`chat::docs::enriched_embed_text`) instead of bare content.
pub const DOCS_CHUNK_SCHEMA_VERSION: i64 = 2;

/// The corpus's stored chunk-schema version (0 = pre-versioning / never
/// indexed).
pub fn corpus_chunk_version(conn: &Connection, corpus_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT chunk_version FROM doc_corpora WHERE id = ?1",
        params![corpus_id],
        |r| r.get(0),
    )
}

/// Record that a full index pass completed at the current chunk-schema
/// version. Only called after a successful pass — a cancelled/errored run
/// leaves the old version, so the next run re-chunks everything again.
pub fn stamp_corpus_chunk_version(conn: &Connection, corpus_id: &str, version: i64) -> DbResult<()> {
    conn.execute(
        "UPDATE doc_corpora SET chunk_version = ?2 WHERE id = ?1",
        params![corpus_id, version],
    )?;
    Ok(())
}

/// True when at least one enabled corpus has searchable chunks — drives the
/// `search_docs` tool's ToolCaps gate.
pub fn any_searchable_corpus(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM doc_corpora WHERE enabled != 0 AND chunk_count > 0)",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .unwrap_or(false)
}

// ---- doc_files: incremental reindex diff state ----

/// (mtime, size) per indexed file.
pub fn list_indexed_files(conn: &Connection, corpus_id: &str) -> DbResult<Vec<(String, i64, i64)>> {
    let mut stmt = conn.prepare("SELECT path, mtime, size FROM doc_files WHERE corpus_id = ?1")?;
    let rows = stmt.query_map(params![corpus_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })?;
    rows.collect()
}

pub fn upsert_indexed_file(
    conn: &Connection,
    corpus_id: &str,
    path: &str,
    mtime: i64,
    size: i64,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO doc_files (corpus_id, path, mtime, size) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(corpus_id, path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size",
        params![corpus_id, path, mtime, size],
    )?;
    Ok(())
}

pub fn delete_indexed_files_not_in(
    conn: &Connection,
    corpus_id: &str,
    keep_paths: &[String],
) -> DbResult<()> {
    // Chunk rows for vanished files must go too, or they'd keep matching
    // searches forever.
    if keep_paths.is_empty() {
        conn.execute(
            "DELETE FROM doc_chunks WHERE corpus_id = ?1",
            params![corpus_id],
        )?;
        conn.execute(
            "DELETE FROM doc_files WHERE corpus_id = ?1",
            params![corpus_id],
        )?;
        return Ok(());
    }
    // Per-row delete against the keep-set — the PK index makes this fast even
    // for large corpora, and it sidesteps SQLite's 999-variable IN-list limit.
    let keep: std::collections::HashSet<&str> = keep_paths.iter().map(|s| s.as_str()).collect();
    let existing = list_indexed_files(conn, corpus_id)?;
    let mut gone: Vec<String> = Vec::new();
    for (path, _, _) in existing {
        if !keep.contains(path.as_str()) {
            conn.execute(
                "DELETE FROM doc_files WHERE corpus_id = ?1 AND path = ?2",
                params![corpus_id, path],
            )?;
            gone.push(path);
        }
    }
    for path in gone {
        delete_chunks_for_file(conn, corpus_id, &path)?;
    }
    Ok(())
}

// ---- doc_chunks ----

/// Replace all chunks of one file (called with the freshly embedded set).
/// Each tuple is `(content, embedding, heading)`: content is the RAW chunk
/// text (FTS leg + display); the embedding is computed from the enriched
/// text (`chat::docs::enriched_embed_text` — path · heading + content);
/// heading is the markdown heading trail for display.
pub fn replace_file_chunks(
    conn: &Connection,
    corpus_id: &str,
    path: &str,
    kind: &str,
    chunks: &[(String, Vec<f32>, String)],
) -> DbResult<()> {
    // B-29: the delete-then-insert sweep must be atomic. A crash midway used
    // to leave partial chunks behind while doc_files.mtime recorded a fresh
    // state — the incremental indexer then considered the file current and
    // never re-embedded it: silently missing from search forever.
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM doc_chunks WHERE corpus_id = ?1 AND path = ?2",
        params![corpus_id, path],
    )?;
    for (i, (content, embedding, heading)) in chunks.iter().enumerate() {
        tx.execute(
            "INSERT INTO doc_chunks (corpus_id, path, chunk_index, kind, content, heading, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                corpus_id,
                path,
                i as i64,
                kind,
                content,
                heading,
                f32_slice_to_blob(embedding)
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_chunks_for_file(conn: &Connection, corpus_id: &str, path: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM doc_chunks WHERE corpus_id = ?1 AND path = ?2",
        params![corpus_id, path],
    )?;
    Ok(())
}

pub fn count_chunks(conn: &Connection, corpus_id: &str) -> DbResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM doc_chunks WHERE corpus_id = ?1",
        params![corpus_id],
        |r| r.get(0),
    )?)
}

// ---- vector math ----

pub fn f32_slice_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

pub fn blob_to_f32_slice(blob: &[u8]) -> Vec<f32> {
    blob.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

/// One search hit: the chunk plus its score. For the cosine-only searches
/// `score` is the cosine similarity; for [`search_chunks_hybrid`] it is the
/// Reciprocal Rank Fusion score (Σ 1/(60 + rank) over both legs) — same
/// "bigger is better" ordering either way.
#[derive(Debug, Clone)]
pub struct ChunkHit {
    pub corpus_id: String,
    pub path: String,
    pub kind: String,
    pub content: String,
    /// Markdown heading trail at the chunk's start ('' when none). Since
    /// chunk-schema v2 the trail + path are also part of the text the
    /// stored embedding was computed from (contextual enrichment); the
    /// content field itself stays raw.
    pub heading: String,
    pub score: f32,
}

/// Shared cosine top-k scan. `corpus_id: None` searches every ENABLED corpus
/// (the `search_chunks` contract); `Some(id)` scopes to one corpus regardless
/// of its enabled flag (the `search_chunks_in_corpus` contract — pinned docs
/// must come back regardless of the rest). Returns chunk rowids alongside the
/// hits so the RRF fusion in [`search_chunks_hybrid`] can key them.
fn cosine_top_k(
    conn: &Connection,
    query: &[f32],
    corpus_id: Option<&str>,
    top_k: usize,
) -> DbResult<Vec<(i64, ChunkHit)>> {
    let sql = match corpus_id {
        Some(_) => {
            "SELECT c.id, c.corpus_id, c.path, c.kind, c.content, c.heading, c.embedding
               FROM doc_chunks c
              WHERE c.corpus_id = ?1"
        }
        None => {
            "SELECT c.id, c.corpus_id, c.path, c.kind, c.content, c.heading, c.embedding
               FROM doc_chunks c
               JOIN doc_corpora co ON co.id = c.corpus_id
              WHERE co.enabled != 0"
        }
    };
    let mut stmt = conn.prepare(sql)?;
    // Parameter count differs by branch: the scoped query takes the corpus
    // id, the global one takes nothing.
    fn map_row(
        r: &rusqlite::Row,
    ) -> rusqlite::Result<(i64, String, String, String, String, String, Vec<u8>)> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
        ))
    }
    let rows = match corpus_id {
        Some(id) => stmt.query_map([id], map_row)?,
        None => stmt.query_map([], map_row)?,
    };

    let qnorm = query.iter().map(|x| x * x).sum::<f32>().sqrt();
    if qnorm == 0.0 {
        return Ok(Vec::new());
    }
    let mut hits: Vec<(i64, ChunkHit)> = Vec::new();
    for row in rows {
        let (id, corpus_id, path, kind, content, heading, blob) = row?;
        let v = blob_to_f32_slice(&blob);
        if v.len() != query.len() {
            continue; // mixed-dimension corpora (model swapped) — skip
        }
        let vnorm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if vnorm == 0.0 {
            continue;
        }
        let dot = query.iter().zip(v.iter()).map(|(a, b)| a * b).sum::<f32>();
        let score = dot / (qnorm * vnorm);
        hits.push((
            id,
            ChunkHit {
                corpus_id,
                path,
                kind,
                content,
                heading,
                score,
            },
        ));
    }
    hits.sort_by(|a, b| {
        b.1.score
            .partial_cmp(&a.1.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(top_k);
    Ok(hits)
}

/// Brute-force cosine top-k over all enabled corpora. Loads every chunk blob
/// for those corpora — fine at folder scale; revisit with an ANN index if a
/// user ever indexes hundreds of thousands of chunks.
pub fn search_chunks(conn: &Connection, query: &[f32], top_k: usize) -> DbResult<Vec<ChunkHit>> {
    Ok(cosine_top_k(conn, query, None, top_k)?
        .into_iter()
        .map(|(_, h)| h)
        .collect())
}

/// Cosine top-k within a SINGLE corpus (used for per-chat pinned docs — those
/// must come back regardless of what the rest of the corpora match).
pub fn search_chunks_in_corpus(
    conn: &Connection,
    query: &[f32],
    corpus_id: &str,
    top_k: usize,
) -> DbResult<Vec<ChunkHit>> {
    Ok(cosine_top_k(conn, query, Some(corpus_id), top_k)?
        .into_iter()
        .map(|(_, h)| h)
        .collect())
}

// ---- hybrid (FTS + vector) search ----

/// Build a safe FTS5 MATCH expression from free-form user input. FTS5 has its
/// own query language (AND/OR/NOT, phrases, column filters), so each term is
/// stripped to alphanumerics, double-quoted (quoted strings are never parsed
/// as operators) and ORed together as prefix terms — "stream" also hits
/// "streaming", and bm25 ranks docs matching more terms higher. Returns None
/// when nothing searchable remains (the caller skips the FTS leg). Same
/// escaping discipline as the memories keyword leg (db/memory.rs).
fn fts_match_query(query: &str) -> Option<String> {
    let safe: String = query
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(" OR ");
    if safe.is_empty() {
        None
    } else {
        Some(safe)
    }
}

/// The FTS (keyword) leg: top `limit` chunk rowids + hits ordered by bm25
/// (ascending rank = best first). `corpus_id: None` spans every enabled
/// corpus; `Some(id)` scopes to one (mirroring `cosine_top_k`).
fn fts_leg(
    conn: &Connection,
    match_expr: &str,
    corpus_id: Option<&str>,
    limit: usize,
) -> DbResult<Vec<(i64, ChunkHit)>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.corpus_id, c.path, c.kind, c.content, c.heading
           FROM doc_chunks_fts f
           JOIN doc_chunks c ON c.id = f.rowid
           JOIN doc_corpora co ON co.id = c.corpus_id
          WHERE doc_chunks_fts MATCH ?1 AND co.enabled != 0
            AND (?2 IS NULL OR c.corpus_id = ?2)
          ORDER BY bm25(doc_chunks_fts)
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![match_expr, corpus_id, limit as i64], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, corpus_id, path, kind, content, heading) = row?;
        out.push((
            id,
            ChunkHit {
                corpus_id,
                path,
                kind,
                content,
                heading,
                score: 0.0,
            },
        ));
    }
    Ok(out)
}

/// Reciprocal Rank Fusion constant. k=60 is the standard value from the RRF
/// paper (Cormack et al., 2009) and dampens the contribution of deep ranks.
const RRF_K: f32 = 60.0;

/// Hybrid corpus search: an FTS5 keyword leg (bm25-ranked) fused with the
/// brute-force cosine vector leg by Reciprocal Rank Fusion —
/// `score = Σ 1/(60 + rank)` over each leg a chunk appears in, best first.
/// `query_embedding: None` (sidecar down / embed failed) degrades cleanly to
/// keyword-only, where each hit's fused score is just its FTS RRF term.
/// `corpus_id: None` searches all enabled corpora; `Some(id)` scopes to one.
///
/// Enrichment (`heading`) rides along for display; `score` on the returned
/// hits is the fused RRF score.
pub fn search_chunks_hybrid(
    conn: &Connection,
    query: &str,
    query_embedding: Option<&[f32]>,
    corpus_id: Option<&str>,
    limit_each: usize,
    top_k: usize,
) -> DbResult<Vec<ChunkHit>> {
    // (hit, fused score) keyed by chunk rowid — the fusion key across legs.
    let mut fused: std::collections::HashMap<i64, (ChunkHit, f32)> = std::collections::HashMap::new();

    if let Some(expr) = fts_match_query(query) {
        for (rank, (id, hit)) in fts_leg(conn, &expr, corpus_id, limit_each)?.into_iter().enumerate() {
            fused.entry(id).or_insert((hit, 0.0)).1 += 1.0 / (RRF_K + rank as f32 + 1.0);
        }
    }
    if let Some(qv) = query_embedding {
        for (rank, (id, hit)) in cosine_top_k(conn, qv, corpus_id, limit_each)?
            .into_iter()
            .enumerate()
        {
            fused.entry(id).or_insert((hit, 0.0)).1 += 1.0 / (RRF_K + rank as f32 + 1.0);
        }
    }

    let mut ranked: Vec<(ChunkHit, f32)> = fused.into_values().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // RERANKER STAGE: implemented in chat/dispatch.rs::run_search_docs_tool —
    // it needs the async HTTP client + the reranker sidecar, which stay out
    // of db/ (this module is pure storage). It consumes this fused top-50.
    ranked.truncate(top_k);
    // The fused RRF score is the hit's exposed score (the leg-local values —
    // 0 for FTS rows, cosine for vector rows — are internal).
    Ok(ranked
        .into_iter()
        .map(|(mut hit, score)| {
            hit.score = score;
            hit
        })
        .collect())
}

/// Pin a corpus to a chat session so its documents are always in the
/// auto-retrieval context for that chat (§3.1.7).
pub fn attach_corpus_to_chat(
    conn: &Connection,
    chat_session_id: &str,
    corpus_id: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO chat_documents (chat_session_id, corpus_id, attached_at)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![chat_session_id, corpus_id, crate::db::now_ts()],
    )?;
    Ok(())
}

/// Remove a corpus from a chat's pinned set. No-op when absent.
pub fn detach_corpus_from_chat(
    conn: &Connection,
    chat_session_id: &str,
    corpus_id: &str,
) -> DbResult<()> {
    conn.execute(
        "DELETE FROM chat_documents WHERE chat_session_id = ?1 AND corpus_id = ?2",
        rusqlite::params![chat_session_id, corpus_id],
    )?;
    Ok(())
}

/// List the corpus ids pinned to a chat session (empty = no pinned docs).
pub fn attached_corpus_ids(conn: &Connection, chat_session_id: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT corpus_id FROM chat_documents WHERE chat_session_id = ?1 ORDER BY attached_at",
    )?;
    let rows = stmt.query_map([chat_session_id], |r| r.get::<_, String>(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        crate::db::mem()
    }

    #[test]
    fn corpus_crud_and_counts() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        assert!(c.enabled);
        assert_eq!(list_corpora(&conn).unwrap().len(), 1);
        assert!(get_corpus_by_path(&conn, "D:/docs").unwrap().is_some());
        assert!(!any_searchable_corpus(&conn)); // no chunks yet

        finish_index(&conn, &c.id, 3, 12).unwrap();
        let after = get_corpus(&conn, &c.id).unwrap().unwrap();
        assert_eq!(after.file_count, 3);
        assert_eq!(after.chunk_count, 12);
        assert!(after.last_indexed_at.is_some());
        assert!(any_searchable_corpus(&conn));

        set_corpus_enabled(&conn, &c.id, false).unwrap();
        assert!(!any_searchable_corpus(&conn));

        remove_corpus(&conn, &c.id).unwrap();
        assert!(list_corpora(&conn).unwrap().is_empty());
    }

    #[test]
    fn blob_roundtrip() {
        let v = vec![0.5f32, -1.25, f32::MIN_POSITIVE, 768.0];
        let blob = f32_slice_to_blob(&v);
        assert_eq!(blob.len(), 16);
        let back = blob_to_f32_slice(&blob);
        assert_eq!(back, v);
        // Truncated blobs don't panic — a trailing partial chunk is dropped.
        assert_eq!(blob_to_f32_slice(&blob[..15]).len(), 3);
    }

    #[test]
    fn search_orders_by_cosine_and_skips_dimension_mismatch() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        let near = vec![1.0f32, 0.1, 0.0];
        let far = vec![0.0f32, 0.0, 1.0];
        let wrong_dims = vec![1.0f32; 8];
        replace_file_chunks(&conn, &c.id, "a.md", "text", &[("near".into(), near, String::new())])
            .unwrap();
        replace_file_chunks(&conn, &c.id, "b.md", "text", &[("far".into(), far, String::new())])
            .unwrap();
        replace_file_chunks(
            &conn,
            &c.id,
            "c.md",
            "text",
            &[("wrong".into(), wrong_dims, String::new())],
        )
        .unwrap();

        let hits = search_chunks(&conn, &[1.0, 0.0, 0.0], 5).unwrap();
        assert_eq!(hits.len(), 2, "dimension-mismatched chunk skipped");
        assert_eq!(hits[0].path, "a.md");
        assert!(hits[0].score > hits[1].score);
        assert!(hits[0].score > 0.99);

        // top_k truncation
        let one = search_chunks(&conn, &[1.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(one.len(), 1);

        // Disabled corpora drop out of search entirely.
        set_corpus_enabled(&conn, &c.id, false).unwrap();
        assert!(search_chunks(&conn, &[1.0, 0.0, 0.0], 5)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reindex_diff_deletes_vanished_files() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        upsert_indexed_file(&conn, &c.id, "keep.md", 1, 10).unwrap();
        upsert_indexed_file(&conn, &c.id, "gone.md", 1, 10).unwrap();
        replace_file_chunks(
            &conn,
            &c.id,
            "gone.md",
            "text",
            &[("x".into(), vec![1.0], String::new())],
        )
        .unwrap();

        delete_indexed_files_not_in(&conn, &c.id, &["keep.md".to_string()]).unwrap();
        let files = list_indexed_files(&conn, &c.id).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "keep.md");
        assert_eq!(
            count_chunks(&conn, &c.id).unwrap(),
            0,
            "gone file's chunks deleted"
        );

        // Empty keep-list wipes the corpus cleanly.
        upsert_indexed_file(&conn, &c.id, "keep.md", 2, 11).unwrap();
        delete_indexed_files_not_in(&conn, &c.id, &[]).unwrap();
        assert!(list_indexed_files(&conn, &c.id).unwrap().is_empty());
    }

    #[test]
    fn replace_file_chunks_replaces_atomically() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        replace_file_chunks(
            &conn,
            &c.id,
            "a.md",
            "text",
            &[("v1".into(), vec![1.0], String::new())],
        )
        .unwrap();
        replace_file_chunks(
            &conn,
            &c.id,
            "a.md",
            "text",
            &[
                ("v2a".into(), vec![1.0], String::new()),
                ("v2b".into(), vec![0.0], String::new()),
            ],
        )
        .unwrap();
        assert_eq!(count_chunks(&conn, &c.id).unwrap(), 2);
    }

    #[test]
    fn chat_documents_attach_and_detach() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/notes", "notes").unwrap();

        // Initially no pinned docs.
        assert!(attached_corpus_ids(&conn, "s1").unwrap().is_empty());

        attach_corpus_to_chat(&conn, "s1", &c.id).unwrap();
        assert_eq!(
            attached_corpus_ids(&conn, "s1").unwrap(),
            vec![c.id.clone()]
        );

        // Idempotent re-attach.
        attach_corpus_to_chat(&conn, "s1", &c.id).unwrap();
        assert_eq!(attached_corpus_ids(&conn, "s1").unwrap().len(), 1);

        // Different session stays clean.
        assert!(attached_corpus_ids(&conn, "s2").unwrap().is_empty());

        // Detach.
        detach_corpus_from_chat(&conn, "s1", &c.id).unwrap();
        assert!(attached_corpus_ids(&conn, "s1").unwrap().is_empty());

        // Detach again is a no-op.
        detach_corpus_from_chat(&conn, "s1", &c.id).unwrap();
        assert!(attached_corpus_ids(&conn, "s1").unwrap().is_empty());
    }

    #[test]
    fn search_chunks_in_corpus_scopes_to_one_corpus() {
        let conn = mem();
        let a = add_corpus(&conn, "D:/corp-a", "a").unwrap();
        let b = add_corpus(&conn, "D:/corp-b", "b").unwrap();
        let query_vec = vec![1.0f32, 0.0, 0.0];

        replace_file_chunks(
            &conn,
            &a.id,
            "a1.md",
            "text",
            &[("in a".into(), query_vec.clone(), String::new())],
        )
        .unwrap();
        replace_file_chunks(
            &conn,
            &b.id,
            "b1.md",
            "text",
            &[("in b".into(), query_vec.clone(), String::new())],
        )
        .unwrap();

        // Scoped search returns only that corpus.
        let hits_a = search_chunks_in_corpus(&conn, &query_vec, &a.id, 5).unwrap();
        assert_eq!(hits_a.len(), 1);
        assert_eq!(hits_a[0].path, "a1.md");

        let hits_b = search_chunks_in_corpus(&conn, &query_vec, &b.id, 5).unwrap();
        assert_eq!(hits_b.len(), 1);
        assert_eq!(hits_b[0].path, "b1.md");
    }

    // ---- hybrid (RRF) search ----

    /// One-chunk file helper with a hand-authored embedding (memory/eval.rs
    /// fixture style) plus the display heading.
    fn put(
        conn: &Connection,
        corpus_id: &str,
        path: &str,
        content: &str,
        emb: &[f32],
        heading: &str,
    ) {
        replace_file_chunks(
            conn,
            corpus_id,
            path,
            "text",
            &[(content.to_string(), emb.to_vec(), heading.to_string())],
        )
        .unwrap();
    }

    #[test]
    fn corpus_chunk_version_stamps_and_reads() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        assert_eq!(corpus_chunk_version(&conn, &c.id).unwrap(), 0);
        stamp_corpus_chunk_version(&conn, &c.id, DOCS_CHUNK_SCHEMA_VERSION).unwrap();
        assert_eq!(
            corpus_chunk_version(&conn, &c.id).unwrap(),
            DOCS_CHUNK_SCHEMA_VERSION
        );
    }

    /// (a) A keyword query must surface the keyword doc even when the
    /// (hand-authored) embedder ranks it low: the FTS leg hands it rank 1 and
    /// RRF lifts it over every vector-near distractor.
    #[test]
    fn hybrid_keyword_query_finds_doc_the_embedder_ranks_low() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/corp", "corp").unwrap();
        put(&conn, &c.id, "manual/flux.md", "flux capacitor calibration guide", &[0.1, 0.95, 0.1], "Manual");
        put(&conn, &c.id, "notes/aero.md", "aerodynamics of wings and lift", &[0.93, 0.12, 0.02], "");
        put(&conn, &c.id, "notes/birds.md", "migratory birds fly south in autumn", &[0.95, 0.05, 0.1], "");
        put(&conn, &c.id, "notes/aviation.md", "aviation pioneers and early flight", &[0.9, 0.2, 0.05], "");

        let qvec = [1.0f32, 0.1, 0.0];
        // The embedder alone ranks the gold doc LAST (cosine ≈ 0.2).
        let vector_only = search_chunks(&conn, &qvec, 2).unwrap();
        assert!(
            vector_only.iter().all(|h| h.path != "manual/flux.md"),
            "fixture broken: embedder should rank the keyword doc out of the top 2"
        );

        let hits = search_chunks_hybrid(&conn, "flux capacitor", Some(&qvec), None, 10, 5).unwrap();
        assert_eq!(hits[0].path, "manual/flux.md", "RRF must lift the FTS winner");
        assert!(hits[0].score > 0.0);

        // Sidecar down (no embedding): the FTS leg alone still answers.
        let fts_only = search_chunks_hybrid(&conn, "flux capacitor", None, None, 10, 5).unwrap();
        assert_eq!(fts_only.len(), 1);
        assert_eq!(fts_only[0].path, "manual/flux.md");
    }

    /// (b) A semantic query sharing NO tokens with any document — the FTS leg
    /// finds nothing — still reaches its gold doc through the vector leg.
    #[test]
    fn hybrid_semantic_query_works_via_vector_leg() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/corp", "corp").unwrap();
        put(
            &conn,
            &c.id,
            "ml/training.md",
            "neural network training with gradient descent",
            &[0.05, 0.1, 0.98],
            "",
        );
        put(&conn, &c.id, "home/washer.md", "the washing machine repair guide", &[0.2, 0.9, 0.1], "");

        let qvec = [0.05f32, 0.05, 1.0];
        // Pure cosine still finds it (the leg was never broken).
        let vector_only = search_chunks(&conn, &qvec, 1).unwrap();
        assert_eq!(vector_only[0].path, "ml/training.md");

        // Hybrid: "deep model optimization" matches no document text, so the
        // FTS leg contributes nothing and the vector leg decides.
        let hits =
            search_chunks_hybrid(&conn, "deep model optimization", Some(&qvec), None, 10, 5)
                .unwrap();
        assert_eq!(hits[0].path, "ml/training.md");

        // Keyword-only search for the same query correctly finds nothing —
        // the vector leg is what makes the difference here.
        let fts_only =
            search_chunks_hybrid(&conn, "deep model optimization", None, None, 10, 5).unwrap();
        assert!(fts_only.is_empty());
    }

    /// (c) A chunk hit by BOTH legs outranks chunks hit by only one.
    #[test]
    fn hybrid_fusion_ranks_both_legs_doc_first() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/corp", "corp").unwrap();
        put(
            &conn,
            &c.id,
            "manual/bank.md",
            "capacitor bank capacitor inspection",
            &[0.92, 0.12, 0.05],
            "Manual > Maintenance",
        );
        put(&conn, &c.id, "manual/flux.md", "flux capacitor calibration", &[0.0, 0.0, 0.0], "");
        put(&conn, &c.id, "notes/birds.md", "bird migration patterns", &[0.96, 0.08, 0.02], "");

        let qvec = [1.0f32, 0.05, 0.0];
        let hits = search_chunks_hybrid(&conn, "capacitor bank", Some(&qvec), None, 10, 5).unwrap();
        assert_eq!(hits[0].path, "manual/bank.md", "both-legs doc must fuse to rank 1");
        // Heading enrichment rides along (and beats the zero-vector doc that
        // only the FTS leg can see — the vector leg skips zero norms).
        assert_eq!(hits[0].heading, "Manual > Maintenance");
        let kw_only = hits.iter().find(|h| h.path == "manual/flux.md");
        assert!(kw_only.is_some(), "FTS-only chunk stays in the fused list");
    }

    /// (d) Empty and FTS-syntax-shaped queries never error: the safe MATCH
    /// builder reduces them to nothing (leg skipped) or quoted literal terms.
    #[test]
    fn hybrid_survives_empty_and_odd_match_queries() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/corp", "corp").unwrap();
        put(&conn, &c.id, "a.md", "calm pond notes", &[0.9, 0.1, 0.0], "");
        let qvec = [1.0f32, 0.0, 0.0];

        // FTS-syntax garbage reduces to nothing searchable (no alphanumeric
        // tokens): the leg is skipped, never a syntax error.
        for q in ["", "   ", "!!! ***", "\"unbalanced", "NEAR( -]*"] {
            let hits = search_chunks_hybrid(&conn, q, None, None, 10, 5).unwrap();
            assert!(hits.is_empty(), "query {q:?} should have no FTS matches");
            // With an embedding the vector leg carries the query instead.
            let hits = search_chunks_hybrid(&conn, q, Some(&qvec), None, 10, 5).unwrap();
            assert_eq!(hits.len(), 1, "query {q:?}: vector leg must still answer");
            assert_eq!(hits[0].path, "a.md");
        }

        // Operator-looking words become quoted LITERAL prefix terms — no
        // syntax error, and they match like any word ("not"* hits "notes").
        let hits = search_chunks_hybrid(&conn, "( ) AND OR NOT", None, None, 10, 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");

        // Non-ASCII tokens are safe too: alphanumeric, just unmatched here.
        let hits = search_chunks_hybrid(&conn, "日本語", None, None, 10, 5).unwrap();
        assert!(hits.is_empty());
    }

    /// The FTS leg respects the enabled flag + corpus scope, and the
    /// external-content triggers keep it in sync with chunk deletes.
    #[test]
    fn hybrid_fts_leg_scopes_and_stays_synced() {
        let conn = mem();
        let a = add_corpus(&conn, "D:/a", "a").unwrap();
        let b = add_corpus(&conn, "D:/b", "b").unwrap();
        put(&conn, &a.id, "a.md", "zeppelin diagrams", &[1.0, 0.0, 0.0], "");
        put(&conn, &b.id, "b.md", "zeppelin history", &[0.0, 1.0, 0.0], "");

        // Corpus-scoped keyword search.
        let scoped = search_chunks_hybrid(&conn, "zeppelin", None, Some(&a.id), 10, 5).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].corpus_id, a.id);

        // Disabled corpora drop out of the global keyword leg.
        set_corpus_enabled(&conn, &b.id, false).unwrap();
        let global = search_chunks_hybrid(&conn, "zeppelin", None, None, 10, 5).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].corpus_id, a.id);
        set_corpus_enabled(&conn, &b.id, true).unwrap();

        // Deleting a file's chunks removes it from the FTS index too.
        delete_chunks_for_file(&conn, &b.id, "b.md").unwrap();
        let global = search_chunks_hybrid(&conn, "zeppelin", None, None, 10, 5).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].corpus_id, a.id);
    }
}
