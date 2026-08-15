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
    conn.execute("DELETE FROM doc_chunks WHERE corpus_id = ?1", params![corpus_id])?;
    conn.execute("DELETE FROM doc_files WHERE corpus_id = ?1", params![corpus_id])?;
    conn.execute("DELETE FROM doc_corpora WHERE id = ?1", params![corpus_id])?;
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
    let mut stmt = conn.prepare(
        "SELECT path, mtime, size FROM doc_files WHERE corpus_id = ?1",
    )?;
    let rows = stmt.query_map(params![corpus_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
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
        conn.execute("DELETE FROM doc_chunks WHERE corpus_id = ?1", params![corpus_id])?;
        conn.execute("DELETE FROM doc_files WHERE corpus_id = ?1", params![corpus_id])?;
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
pub fn replace_file_chunks(
    conn: &Connection,
    corpus_id: &str,
    path: &str,
    kind: &str,
    chunks: &[(String, Vec<f32>)],
) -> DbResult<()> {
    delete_chunks_for_file(conn, corpus_id, path)?;
    for (i, (content, embedding)) in chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO doc_chunks (corpus_id, path, chunk_index, kind, content, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![corpus_id, path, i as i64, kind, content, f32_slice_to_blob(embedding)],
        )?;
    }
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
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// One search hit: the chunk plus its cosine similarity.
#[derive(Debug, Clone)]
pub struct ChunkHit {
    pub corpus_id: String,
    pub path: String,
    pub kind: String,
    pub content: String,
    pub score: f32,
}

/// Brute-force cosine top-k over all enabled corpora. Loads every chunk blob
/// for those corpora — fine at folder scale; revisit with an ANN index if a
/// user ever indexes hundreds of thousands of chunks.
pub fn search_chunks(
    conn: &Connection,
    query: &[f32],
    top_k: usize,
) -> DbResult<Vec<ChunkHit>> {
    let mut stmt = conn.prepare(
        "SELECT c.corpus_id, c.path, c.kind, c.content, c.embedding
           FROM doc_chunks c
           JOIN doc_corpora co ON co.id = c.corpus_id
          WHERE co.enabled != 0",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Vec<u8>>(4)?,
        ))
    })?;

    let qnorm = query.iter().map(|x| x * x).sum::<f32>().sqrt();
    if qnorm == 0.0 {
        return Ok(Vec::new());
    }
    let mut hits: Vec<ChunkHit> = Vec::new();
    for row in rows {
        let (corpus_id, path, kind, content, blob) = row?;
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
        hits.push(ChunkHit { corpus_id, path, kind, content, score });
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(top_k);
    Ok(hits)
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
        // Truncated blobs don't panic — chunks_exact drops the tail.
        assert_eq!(blob_to_f32_slice(&blob[..15]).len(), 3);
    }

    #[test]
    fn search_orders_by_cosine_and_skips_dimension_mismatch() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        let near = vec![1.0f32, 0.1, 0.0];
        let far = vec![0.0f32, 0.0, 1.0];
        let wrong_dims = vec![1.0f32; 8];
        replace_file_chunks(&conn, &c.id, "a.md", "text", &[("near".into(), near)]).unwrap();
        replace_file_chunks(&conn, &c.id, "b.md", "text", &[("far".into(), far)]).unwrap();
        replace_file_chunks(&conn, &c.id, "c.md", "text", &[("wrong".into(), wrong_dims)]).unwrap();

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
        assert!(search_chunks(&conn, &[1.0, 0.0, 0.0], 5).unwrap().is_empty());
    }

    #[test]
    fn reindex_diff_deletes_vanished_files() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        upsert_indexed_file(&conn, &c.id, "keep.md", 1, 10).unwrap();
        upsert_indexed_file(&conn, &c.id, "gone.md", 1, 10).unwrap();
        replace_file_chunks(&conn, &c.id, "gone.md", "text", &[("x".into(), vec![1.0])]).unwrap();

        delete_indexed_files_not_in(&conn, &c.id, &["keep.md".to_string()]).unwrap();
        let files = list_indexed_files(&conn, &c.id).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "keep.md");
        assert_eq!(count_chunks(&conn, &c.id).unwrap(), 0, "gone file's chunks deleted");

        // Empty keep-list wipes the corpus cleanly.
        upsert_indexed_file(&conn, &c.id, "keep.md", 2, 11).unwrap();
        delete_indexed_files_not_in(&conn, &c.id, &[]).unwrap();
        assert!(list_indexed_files(&conn, &c.id).unwrap().is_empty());
    }

    #[test]
    fn replace_file_chunks_replaces_atomically() {
        let conn = mem();
        let c = add_corpus(&conn, "D:/docs", "docs").unwrap();
        replace_file_chunks(&conn, &c.id, "a.md", "text", &[("v1".into(), vec![1.0])]).unwrap();
        replace_file_chunks(&conn, &c.id, "a.md", "text", &[("v2a".into(), vec![1.0]), ("v2b".into(), vec![0.0])]).unwrap();
        assert_eq!(count_chunks(&conn, &c.id).unwrap(), 2);
    }
}
