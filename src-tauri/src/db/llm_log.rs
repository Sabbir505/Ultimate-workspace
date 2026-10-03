//! Request log for local-model traffic (`llm_log`).
//!
//! One row per HTTP exchange with a local runtime — the llama.cpp sidecars
//! Relay spawns, plus anything arriving through the loopback gateway (Ollama,
//! LM Studio, llama.cpp, from Relay itself or from another app).
//!
//! Two rules shape this table:
//!
//!   - **Verbatim bodies.** `request_body` / `response_body` hold the bytes as
//!     sent and received. They are the ground truth: telemetry extraction is a
//!     separate, best-effort layer (see `chat::llm_log::normalize`), so a
//!     renamed field in a future runtime costs us a re-parse, never a capture.
//!   - **No session FK.** `cost_events` hangs off `sessions(id)` and
//!     `chat_messages` off `chat_sessions(id)`; this table is deliberately
//!     session-independent, because gateway traffic has no chat session at all
//!     and a log row must outlive the chat that produced it.
//!
//! All query functions take `&Connection` so they are testable against
//! `Connection::open_in_memory()`.

use rusqlite::{params, Connection};

use super::{now_ts, DbResult};

/// Largest body we will keep verbatim. Embedding vectors and long documents
/// would otherwise dominate the row; anything longer is cut and `truncated`
/// is set so the UI can say so rather than silently show a partial payload.
pub const DEFAULT_MAX_BODY_KB: i64 = 256;

/// A row being written. Kept separate from the read types so the caller can
/// build it incrementally across a stream.
#[derive(Debug, Clone, Default)]
pub struct NewLogEntry {
    pub id: String,
    pub origin: String,
    pub target: String,
    pub method: String,
    pub path: String,
    pub model: Option<String>,
    pub upstream_status: Option<i64>,
    pub error: Option<String>,
    pub duration_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub tokens_per_second: Option<f64>,
    pub request_bytes: i64,
    pub response_bytes: i64,
    pub truncated: bool,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    /// The runtime's own timings object, stored unparsed so a normalizer bug
    /// (or a new runtime's extra fields) is always recoverable.
    pub timings_json: Option<String>,
}

/// Wire shape for the list view. Omitted the bodies deliberately — the table
/// can show 500 rows and the detail pane fetches one.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmLogSummary {
    /// Insert-order row id — the opaque pagination cursor for "load more".
    pub rowid: i64,
    pub id: String,
    pub created_at: i64,
    pub origin: String,
    pub target: String,
    pub method: String,
    pub path: String,
    pub model: Option<String>,
    pub upstream_status: Option<i64>,
    pub error: Option<String>,
    pub duration_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub tokens_per_second: Option<f64>,
    pub request_bytes: i64,
    pub response_bytes: i64,
    pub truncated: bool,
}

/// Wire shape for the detail view — the summary plus the captured bodies.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmLogDetail {
    #[serde(flatten)]
    pub summary: LlmLogSummary,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub timings_json: Option<String>,
}

/// Aggregate counters for the Logs header.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmLogStats {
    pub total: i64,
    pub error_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub avg_ttft_ms: Option<f64>,
    pub avg_tokens_per_second: Option<f64>,
    pub oldest_at: Option<i64>,
    pub newest_at: Option<i64>,
}

/// Row filters. Every field is optional; `None` means "no constraint".
#[derive(Debug, Clone, Default)]
pub struct LogFilter {
    pub origin: Option<String>,
    pub target: Option<String>,
    /// Case-insensitive substring over the request/response text.
    pub search: Option<String>,
    pub limit: Option<i64>,
    /// Keyset pagination: only rows strictly older than this id's created_at.
    /// `created_at` has second resolution and tool loops fire several rounds
    /// per second, so the cursor is the (created_at, rowid) pair — `rowid`
    /// alone would already be unique, but the pair keeps the cursor stable
    /// across restarts where insert order and wall clock can disagree.
    pub before_created_at: Option<i64>,
    pub before_rowid: Option<i64>,
}

/// Bounded by default — an unbounded query would hand the UI every request
/// ever recorded (same guard as `get_cost_events`).
const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

/// Create the table and its indexes. Idempotent, so it doubles as the
/// migration registered in both `init` and the `mem` test helper.
pub fn ensure_schema(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS llm_log (
          id               TEXT PRIMARY KEY,
          created_at       INTEGER NOT NULL,
          origin           TEXT NOT NULL,        -- 'relay' | 'external'
          target           TEXT NOT NULL,        -- 'llamacpp'|'ollama'|'lmstudio'|<provider id>
          method           TEXT NOT NULL,
          path             TEXT NOT NULL,
          model            TEXT,
          upstream_status  INTEGER,
          error            TEXT,
          duration_ms      INTEGER,
          ttft_ms          INTEGER,
          input_tokens     INTEGER,
          output_tokens    INTEGER,
          tokens_per_second REAL,
          request_bytes    INTEGER NOT NULL DEFAULT 0,
          response_bytes   INTEGER NOT NULL DEFAULT 0,
          truncated        INTEGER NOT NULL DEFAULT 0,
          request_body     TEXT,
          response_body    TEXT,
          timings_json     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_llm_log_created ON llm_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_llm_log_target  ON llm_log(target, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_llm_log_origin  ON llm_log(origin, created_at DESC);
        "#,
    )
}

/// Truncate a body to `max_kb`, returning the (possibly cut) string and
/// whether anything was dropped. Cut on a char boundary so a multi-byte
/// character never produces invalid UTF-8 in the log.
fn cap_body(body: &str, max_kb: i64) -> (String, bool) {
    let max = (max_kb.max(1) as usize) * 1024;
    if body.len() <= max {
        return (body.to_string(), false);
    }
    let mut cut = max;
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    (body[..cut].to_string(), true)
}

pub fn insert(conn: &Connection, e: &NewLogEntry, max_body_kb: i64) -> DbResult<()> {
    let (req, req_trunc) = match &e.request_body {
        Some(b) => { let (s, t) = cap_body(b, max_body_kb); (Some(s), t) }
        None => (None, false),
    };
    let (res, res_trunc) = match &e.response_body {
        Some(b) => { let (s, t) = cap_body(b, max_body_kb); (Some(s), t) }
        None => (None, false),
    };
    conn.execute(
        "INSERT INTO llm_log (
            id, created_at, origin, target, method, path, model,
            upstream_status, error, duration_ms, ttft_ms,
            input_tokens, output_tokens, tokens_per_second,
            request_bytes, response_bytes, truncated,
            request_body, response_body, timings_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![
            e.id,
            now_ts(),
            e.origin,
            e.target,
            e.method,
            e.path,
            e.model,
            e.upstream_status,
            e.error,
            e.duration_ms,
            e.ttft_ms,
            e.input_tokens,
            e.output_tokens,
            e.tokens_per_second,
            e.request_bytes,
            e.response_bytes,
            (e.truncated || req_trunc || res_trunc) as i64,
            req,
            res,
            e.timings_json,
        ],
    )?;
    Ok(())
}

fn map_summary(row: &rusqlite::Row) -> rusqlite::Result<LlmLogSummary> {
    Ok(LlmLogSummary {
        rowid: row.get("rowid")?,
        id: row.get("id")?,
        created_at: row.get("created_at")?,
        origin: row.get("origin")?,
        target: row.get("target")?,
        method: row.get("method")?,
        path: row.get("path")?,
        model: row.get("model")?,
        upstream_status: row.get("upstream_status")?,
        error: row.get("error")?,
        duration_ms: row.get("duration_ms")?,
        ttft_ms: row.get("ttft_ms")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        tokens_per_second: row.get("tokens_per_second")?,
        request_bytes: row.get("request_bytes")?,
        response_bytes: row.get("response_bytes")?,
        truncated: row.get::<_, i64>("truncated")? != 0,
    })
}

const SUMMARY_COLS: &str = "rowid, id, created_at, origin, target, method, path, model, \
    upstream_status, error, duration_ms, ttft_ms, input_tokens, output_tokens, \
    tokens_per_second, request_bytes, response_bytes, truncated";

/// Newest first. `search` scans the captured bodies — it is a debugging aid,
/// so a full scan of the filtered window is the honest cost.
pub fn list(conn: &Connection, f: &LogFilter) -> DbResult<Vec<LlmLogSummary>> {
    let mut sql = format!("SELECT {SUMMARY_COLS} FROM llm_log WHERE 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(o) = &f.origin {
        sql.push_str(" AND origin = ?");
        args.push(Box::new(o.clone()));
    }
    if let Some(t) = &f.target {
        sql.push_str(" AND target = ?");
        args.push(Box::new(t.clone()));
    }
    if let Some(before) = f.before_created_at {
        match f.before_rowid {
            // Same-second rows exist (created_at is whole seconds; tool loops
            // fire several rounds per second), so the cursor is the pair.
            Some(brow) => {
                sql.push_str(" AND (created_at < ? OR (created_at = ? AND rowid < ?))");
                args.push(Box::new(before));
                args.push(Box::new(before));
                args.push(Box::new(brow));
            }
            None => {
                sql.push_str(" AND created_at < ?");
                args.push(Box::new(before));
            }
        }
    }
    if let Some(s) = &f.search {
        let s = s.trim();
        if !s.is_empty() {
            // Escape LIKE wildcards (audit M: llm_log search): a raw `%`/`_`
            // in the box acted as a wildcard and matched everything. Same
            // discipline as db/chat.rs / db/session_fabric.rs.
            let escaped = s
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            sql.push_str(
                " AND (IFNULL(request_body,'') LIKE ? ESCAPE '\\' OR IFNULL(response_body,'') LIKE ? ESCAPE '\\')",
            );
            args.push(Box::new(format!("%{escaped}%")));
            args.push(Box::new(format!("%{escaped}%")));
        }
    }
    sql.push_str(" ORDER BY created_at DESC, rowid DESC LIMIT ?");
    args.push(Box::new(f.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)));

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), map_summary)?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn get(conn: &Connection, id: &str) -> DbResult<Option<LlmLogDetail>> {
    let sql = format!(
        "SELECT {SUMMARY_COLS}, request_body, response_body, timings_json FROM llm_log WHERE id = ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    Ok(Some(LlmLogDetail {
        summary: map_summary(row)?,
        request_body: row.get("request_body")?,
        response_body: row.get("response_body")?,
        timings_json: row.get("timings_json")?,
    }))
}

pub fn clear(conn: &Connection) -> DbResult<usize> {
    Ok(conn.execute("DELETE FROM llm_log", [])?)
}

/// Delete rows older than `retention_days`, then trim to `max_rows`. Returns
/// how many rows went away.
///
/// Ordered oldest-first with a subquery on `rowid` rather than a plain OFFSET
/// walk: at 5,000 rows the offset approach re-scans on every call.
pub fn prune(conn: &Connection, retention_days: i64, max_rows: i64) -> DbResult<usize> {
    let mut removed = 0usize;
    if retention_days > 0 {
        // `created_at` is unix SECONDS (now_ts()); the multiplier must match,
        // or the cutoff lands ~1000× too far back and nothing ever ages out.
        let cutoff = now_ts() - retention_days * 86_400;
        removed += conn.execute("DELETE FROM llm_log WHERE created_at < ?1", params![cutoff])?;
    }
    if max_rows > 0 {
        removed += conn.execute(
            "DELETE FROM llm_log WHERE rowid NOT IN (
                 SELECT rowid FROM llm_log ORDER BY created_at DESC, rowid DESC LIMIT ?1
             )",
            params![max_rows],
        )?;
    }
    Ok(removed)
}

/// Distinct `target` values actually present in the log — feeds the runtime
/// filter dropdown, so a custom gateway target appears once it has traffic.
pub fn distinct_targets(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT target FROM llm_log ORDER BY target")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn stats(conn: &Connection) -> DbResult<LlmLogStats> {
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(IFNULL(input_tokens,0)), 0),
                COALESCE(SUM(IFNULL(output_tokens,0)), 0),
                AVG(ttft_ms),
                AVG(tokens_per_second),
                MIN(created_at),
                MAX(created_at)
         FROM llm_log",
        [],
        |r| {
            Ok(LlmLogStats {
                total: r.get(0)?,
                error_count: r.get(1)?,
                input_tokens: r.get(2)?,
                output_tokens: r.get(3)?,
                avg_ttft_ms: r.get(4)?,
                avg_tokens_per_second: r.get(5)?,
                oldest_at: r.get(6)?,
                newest_at: r.get(7)?,
            })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::mem;

    fn entry(id: &str) -> NewLogEntry {
        NewLogEntry {
            id: id.into(),
            origin: "relay".into(),
            target: "llamacpp".into(),
            method: "POST".into(),
            path: "/v1/chat/completions".into(),
            request_bytes: 10,
            response_bytes: 20,
            ..Default::default()
        }
    }

    #[test]
    fn round_trips_a_row_with_bodies() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        let mut e = entry("a");
        e.request_body = Some("{\"model\":\"m\"}".into());
        e.response_body = Some("{\"ok\":true}".into());
        e.input_tokens = Some(11);
        e.timings_json = Some("{\"prompt_n\":11}".into());
        insert(&conn, &e, DEFAULT_MAX_BODY_KB).unwrap();

        let list = list(&conn, &LogFilter::default()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].input_tokens, Some(11));
        assert!(!list[0].truncated);

        let d = get(&conn, "a").unwrap().expect("detail");
        assert_eq!(d.request_body.as_deref(), Some("{\"model\":\"m\"}"));
        assert_eq!(d.timings_json.as_deref(), Some("{\"prompt_n\":11}"));
        assert!(get(&conn, "nope").unwrap().is_none());
    }

    #[test]
    fn filters_by_origin_target_and_body_text() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        let mut a = entry("a");
        a.origin = "relay".into();
        let mut b = entry("b");
        b.origin = "external".into();
        b.target = "ollama".into();
        b.response_body = Some("llama3.2 answer".into());
        insert(&conn, &a, DEFAULT_MAX_BODY_KB).unwrap();
        insert(&conn, &b, DEFAULT_MAX_BODY_KB).unwrap();

        let by_origin = list(&conn, &LogFilter { origin: Some("external".into()), ..Default::default() }).unwrap();
        assert_eq!(by_origin.len(), 1);
        assert_eq!(by_origin[0].id, "b");

        let by_target = list(&conn, &LogFilter { target: Some("ollama".into()), ..Default::default() }).unwrap();
        assert_eq!(by_target.len(), 1);

        let by_text = list(&conn, &LogFilter { search: Some("llama3.2".into()), ..Default::default() }).unwrap();
        assert_eq!(by_text.len(), 1);
        assert_eq!(by_text[0].id, "b");
    }

    #[test]
    fn oversized_bodies_are_capped_and_flagged() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        let mut e = entry("big");
        // 4 KiB cap against a body well over it.
        e.response_body = Some("x".repeat(9000));
        insert(&conn, &e, 4).unwrap();

        let d = get(&conn, "big").unwrap().unwrap();
        assert!(d.summary.truncated, "truncated flag must survive the cap");
        assert_eq!(d.response_body.unwrap().len(), 4096);
    }

    #[test]
    fn capping_a_body_never_splits_a_multibyte_char() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        let mut e = entry("u");
        // 3-byte chars against a 1 KiB cap: 1024 is not a char boundary here.
        e.response_body = Some("あ".repeat(2000));
        insert(&conn, &e, 1).unwrap();
        let body = get(&conn, "u").unwrap().unwrap().response_body.unwrap();
        assert!(body.len() <= 1024);
        assert!(std::str::from_utf8(body.as_bytes()).is_ok(), "log body must stay valid UTF-8");
    }

    #[test]
    fn prune_drops_by_age_and_row_cap() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        insert(&conn, &entry("old"), DEFAULT_MAX_BODY_KB).unwrap();
        insert(&conn, &entry("edge"), DEFAULT_MAX_BODY_KB).unwrap();
        for i in 0..5 {
            insert(&conn, &entry(&format!("n{i}")), DEFAULT_MAX_BODY_KB).unwrap();
        }
        assert_eq!(list(&conn, &LogFilter::default()).unwrap().len(), 7);

        // Realistic backdates against the SECOND-resolution clock: 8 days is
        // past a 7-day retention, 6 days is inside it. (An earlier version of
        // this test backdated to 0, which passed even when the cutoff was
        // computed in the wrong unit — 7 days as milliseconds — because 0 is
        // below any cutoff.)
        conn.execute(
            "UPDATE llm_log SET created_at = ?1 WHERE id = 'old'",
            params![now_ts() - 8 * 86_400],
        )
        .unwrap();
        conn.execute(
            "UPDATE llm_log SET created_at = ?1 WHERE id = 'edge'",
            params![now_ts() - 6 * 86_400],
        )
        .unwrap();

        // Age only (no row cap): the 8-day row goes, the 6-day row stays.
        assert_eq!(prune(&conn, 7, 0).unwrap(), 1, "age pruning must use seconds");
        let left = list(&conn, &LogFilter { limit: Some(50), ..Default::default() }).unwrap();
        assert!(left.iter().all(|r| r.id != "old"), "the 8-day-old row must be gone");
        assert!(left.iter().any(|r| r.id == "edge"), "the 6-day-old row is inside retention");

        // Row cap on top: keep exactly 3.
        prune(&conn, 7, 3).unwrap();
        let left = list(&conn, &LogFilter { limit: Some(50), ..Default::default() }).unwrap();
        assert_eq!(left.len(), 3, "row cap should keep exactly 3");
    }

    #[test]
    fn keyset_pagination_skips_only_rows_before_the_cursor() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        // Same created_at (seconds resolution) for several rows: the rowid
        // half of the cursor is what tells them apart.
        for i in 0..5 {
            insert(&conn, &entry(&format!("n{i}")), DEFAULT_MAX_BODY_KB).unwrap();
        }
        conn.execute("UPDATE llm_log SET created_at = 1000", []).unwrap();

        let page1 = list(&conn, &LogFilter { limit: Some(2), ..Default::default() }).unwrap();
        assert_eq!(page1.len(), 2);
        // Newest first → n4, n3.
        assert_eq!(page1[0].id, "n4");
        assert_eq!(page1[1].id, "n3");

        let cursor = &page1[1];
        let page2 = list(
            &conn,
            &LogFilter {
                limit: Some(2),
                before_created_at: Some(cursor.created_at),
                before_rowid: Some(cursor.rowid),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page2.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec!["n2", "n1"]);

        let page3 = list(
            &conn,
            &LogFilter {
                limit: Some(2),
                before_created_at: Some(page2[1].created_at),
                before_rowid: Some(page2[1].rowid),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page3.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec!["n0"]);
    }

    #[test]
    fn stats_aggregate_counts_errors_and_nulls() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        let mut a = entry("a");
        a.input_tokens = Some(10);
        a.output_tokens = Some(5);
        a.ttft_ms = Some(100);
        a.tokens_per_second = Some(50.0);
        let mut b = entry("b");
        b.error = Some("upstream 500".into());
        b.input_tokens = Some(20);
        b.ttft_ms = Some(300);
        b.tokens_per_second = Some(30.0);
        insert(&conn, &a, DEFAULT_MAX_BODY_KB).unwrap();
        insert(&conn, &b, DEFAULT_MAX_BODY_KB).unwrap();

        let s = stats(&conn).unwrap();
        assert_eq!(s.total, 2);
        assert_eq!(s.error_count, 1);
        assert_eq!(s.input_tokens, 30);
        assert_eq!(s.output_tokens, 5);
        assert_eq!(s.avg_ttft_ms, Some(200.0));
        assert_eq!(s.avg_tokens_per_second, Some(40.0));
        assert!(s.oldest_at.is_some() && s.newest_at.is_some());
    }

    #[test]
    fn clear_empties_the_table() {
        let conn = mem();
        ensure_schema(&conn).unwrap();
        insert(&conn, &entry("a"), DEFAULT_MAX_BODY_KB).unwrap();
        assert_eq!(clear(&conn).unwrap(), 1);
        assert!(list(&conn, &LogFilter::default()).unwrap().is_empty());
    }
}
