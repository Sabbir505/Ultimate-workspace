//! Research caches: web-search results, fetched page content, and the
//! per-session research query history. All SQLite, all keyed on canonical
//! URLs / normalized queries so cross-engine and cross-turn duplicates
//! collapse to one entry.
//!
//! TTL defaults: search results 12 h (SERPs go stale fast); page content
//! 7 days (articles barely change; re-research within a week is free).
//! Brave-sourced results must NOT be persisted under its API terms — the
//! caller tags the engine mix and `search_cache_put` refuses to store
//! Brave-only rows (see `cacheable_engines`).

use rusqlite::{params, Connection};

use super::{now_ts, DbResult};

pub const SEARCH_CACHE_TTL_SECS: i64 = 12 * 60 * 60;
pub const PAGE_CACHE_TTL_SECS: i64 = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/// Canonical cache key for a URL: lowercase scheme+host, drop the fragment,
/// strip common tracking params (`utm_*`, `fbclid`, `gclid`, …), sort the
/// remaining query params. Different engines returning the same article with
/// different tracking suffixes then share one cache entry.
pub fn canonical_url_key(raw: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(raw.trim()) else {
        return raw.trim().to_lowercase();
    };
    parsed.set_fragment(None);
    if let Some(host) = parsed.host_str() {
        let _ = url::Url::parse(&format!("{}://{}", parsed.scheme(), host.to_lowercase())).map(|_| {
            // set_host on the parsed url (cannot borrow &mut while host_str borrow lives)
        });
    }
    // Rebuild manually: url::Url::set_host needs a String anyway.
    let scheme = parsed.scheme().to_ascii_lowercase();
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    let path = parsed.path().to_string();
    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .filter(|(k, _)| !is_tracking_param(k))
        .collect();
    pairs.sort();
    pairs.dedup();
    let query = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let query_part = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    format!("{scheme}://{host}{port}{path}{query_part}")
}

fn is_tracking_param(k: &str) -> bool {
    let kl = k.to_ascii_lowercase();
    kl == "fbclid"
        || kl == "gclid"
        || kl == "msclkid"
        || kl == "dclid"
        || kl == "igshid"
        || kl.starts_with("utm_")
}

// ---------------------------------------------------------------------------
// Search cache
// ---------------------------------------------------------------------------

/// True when the engine mix may be persisted. Brave's API terms prohibit
/// storing results without a storage-rights plan; a mix that includes Brave
/// is still storable UNLESS Brave was the only successful engine (nothing to
/// store otherwise), matching "cache URLs/metadata only for Brave-sourced
/// results" guidance conservatively: refuse only when the payload's engines
/// are ALL brave.
pub fn cacheable_engines(status: &[(&str, bool)]) -> bool {
    let any_ok = status.iter().any(|(_, ok)| *ok);
    let all_brave = status.iter().all(|(name, _)| *name == "brave");
    any_ok && !all_brave
}

/// Store a search-result payload. `engines_tag` documents the engine mix for
/// debugging; rows are skipped entirely when the mix is not cacheable.
pub fn search_cache_put(
    conn: &Connection,
    query_key: &str,
    engines_tag: &str,
    payload: &str,
) -> DbResult<()> {
    if !cacheable_engines(&parse_engine_tag(engines_tag)) {
        return Ok(());
    }
    conn.execute(
        "INSERT OR REPLACE INTO search_cache (key, payload, engines, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![query_key, payload, engines_tag, now_ts()],
    )?;
    Ok(())
}

/// Fetch a fresh-enough cached search payload. Expired rows are deleted.
pub fn search_cache_get(
    conn: &Connection,
    query_key: &str,
    max_age_secs: i64,
) -> DbResult<Option<String>> {
    let cutoff = now_ts() - max_age_secs;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT payload, created_at FROM search_cache WHERE key = ?1",
            params![query_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    match row {
        Some((payload, created_at)) if created_at >= cutoff => Ok(Some(payload)),
        Some((_, created_at)) => {
            conn.execute(
                "DELETE FROM search_cache WHERE key = ?1",
                params![query_key],
            )?;
            let _ = created_at;
            Ok(None)
        }
        None => Ok(None),
    }
}

fn parse_engine_tag(tag: &str) -> Vec<(&str, bool)> {
    // Tag format: "duckduckgo:ok,mojeek:fail,wikipedia:ok"
    tag.split(',')
        .filter_map(|part| {
            let mut it = part.splitn(2, ':');
            let name = it.next()?.trim();
            let ok = it.next().is_some_and(|v| v.trim() == "ok");
            Some((name, ok))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Page cache
// ---------------------------------------------------------------------------

/// Store extracted page content for a canonical URL.
pub fn page_cache_put(conn: &Connection, canonical: &str, content: &str) -> DbResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO page_cache (url_key, content, content_hash, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![canonical, content, content_hash(content), now_ts()],
    )?;
    Ok(())
}

/// Fetch fresh-enough cached page content. Expired rows are deleted.
pub fn page_cache_get(
    conn: &Connection,
    canonical: &str,
    max_age_secs: i64,
) -> DbResult<Option<String>> {
    let cutoff = now_ts() - max_age_secs;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT content, created_at FROM page_cache WHERE url_key = ?1",
            params![canonical],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    match row {
        Some((content, created_at)) if created_at >= cutoff => Ok(Some(content)),
        Some((_, created_at)) => {
            conn.execute("DELETE FROM page_cache WHERE url_key = ?1", params![canonical])?;
            let _ = created_at;
            Ok(None)
        }
        None => Ok(None),
    }
}

/// SHA-256 of the content, hex — lets callers detect silent page changes.
pub fn content_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    let bytes = h.finalize();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Citation-integrity reports
// ---------------------------------------------------------------------------

/// Store the lint verdict for one research report. `detail` is the serialized
/// full report (JSON) — the summary columns exist so the trend queries
/// ("citation precision over time per model") don't have to parse JSON.
#[allow(clippy::too_many_arguments)]
pub fn save_citation_report(
    conn: &Connection,
    chat_session_id: &str,
    message_id: Option<i64>,
    total_citations: i64,
    orphan_count: i64,
    unused_count: i64,
    uncited_sentences: i64,
    weak_count: i64,
    detail: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO citation_reports \
           (chat_session_id, message_id, total_citations, orphan_count, unused_count, \
            uncited_sentences, weak_count, detail, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            chat_session_id,
            message_id,
            total_citations,
            orphan_count,
            unused_count,
            uncited_sentences,
            weak_count,
            detail,
            now_ts()
        ],
    )?;
    Ok(())
}

/// Most recent citation-integrity verdict for a session, as the stored JSON
/// detail. The "Fix citations" repair action feeds it back to the model so
/// the repair pass names the exact claims to re-cite or drop.
pub fn latest_citation_detail(conn: &Connection, chat_session_id: &str) -> DbResult<Option<String>> {
    conn.query_row(
        "SELECT detail FROM citation_reports WHERE chat_session_id = ?1 \
          ORDER BY created_at DESC, id DESC LIMIT 1",
        params![chat_session_id],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// One point of the citation-quality trend: the lint counts of a single
/// research report.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CitationQualityPoint {
    pub chat_session_id: String,
    pub created_at: i64,
    pub total_citations: i64,
    pub orphan_count: i64,
    pub unused_count: i64,
    pub weak_count: i64,
}

/// The most recent `limit` lint results in chronological order — the
/// regression signal for research-prompt/model changes. Flag ratios climbing
/// after a prompt edit is the "your change made research worse" alarm; there
/// is no leaderboard, only drift against your own baseline.
pub fn citation_quality_trend(
    conn: &Connection,
    limit: i64,
) -> DbResult<Vec<CitationQualityPoint>> {
    let mut stmt = conn.prepare(
        "SELECT chat_session_id, created_at, total_citations, orphan_count, unused_count, weak_count \
         FROM citation_reports ORDER BY created_at DESC, id DESC LIMIT ?1",
    )?;
    let mut rows: Vec<CitationQualityPoint> = stmt
        .query_map(params![limit], |r| {
            Ok(CitationQualityPoint {
                chat_session_id: r.get(0)?,
                created_at: r.get(1)?,
                total_citations: r.get(2)?,
                orphan_count: r.get(3)?,
                unused_count: r.get(4)?,
                weak_count: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    rows.reverse();
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Research query history
// ---------------------------------------------------------------------------

/// Record one executed search for a session. Used to (a) enforce the "each
/// query unique" research rule — the dispatcher prepends a nudge when the
/// model repeats itself — and (b) leave an audit trail of what a research
/// task actually searched.
pub fn record_search(
    conn: &Connection,
    chat_session_id: &str,
    query: &str,
    engines_tag: &str,
    result_count: i64,
) -> DbResult<bool> {
    let normalized = normalize_query(query);
    let now = now_ts();
    let already: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM research_queries \
              WHERE chat_session_id = ?1 AND normalized_query = ?2)",
            params![chat_session_id, normalized],
            |r| r.get(0),
        )
        .unwrap_or(false);
    conn.execute(
        "INSERT INTO research_queries \
           (chat_session_id, query, normalized_query, engines, result_count, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![chat_session_id, query, normalized, engines_tag, result_count, now],
    )?;
    Ok(already)
}

/// Drop the query history for a session — part of `reset_source_ledger`'s
/// "fresh research task starts clean" contract.
pub fn clear_searches(conn: &Connection, chat_session_id: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM research_queries WHERE chat_session_id = ?1",
        params![chat_session_id],
    )?;
    Ok(())
}

/// Case-folded, whitespace-collapsed query for repeat detection.
fn normalize_query(q: &str) -> String {
    q.split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::super::chat::create_chat_session;
    use super::super::mem;
    use super::*;

    #[test]
    fn canonical_url_strips_tracking_and_sorts_params() {
        let a = canonical_url_key("https://Example.com/a/b?utm_source=x&q=2&fbclid=zz&q=2");
        let b = canonical_url_key("https://example.com/a/b?q=2");
        assert_eq!(a, b);
        // Fragments never affect identity.
        assert_eq!(
            canonical_url_key("https://example.com/page#section"),
            canonical_url_key("https://example.com/page")
        );
    }

    #[test]
    fn search_cache_round_trip_with_ttl() {
        let conn = mem();
        search_cache_put(&conn, "k1", "duckduckgo:ok,wikipedia:ok", "results text").unwrap();
        let hit = search_cache_get(&conn, "k1", SEARCH_CACHE_TTL_SECS).unwrap();
        assert_eq!(hit.as_deref(), Some("results text"));
        // Expired → None and the row is gone.
        conn.execute(
            "UPDATE search_cache SET created_at = created_at - 999999",
            [],
        )
        .unwrap();
        assert!(search_cache_get(&conn, "k1", SEARCH_CACHE_TTL_SECS)
            .unwrap()
            .is_none());
    }

    #[test]
    fn brave_only_payloads_are_not_cached() {
        assert!(!cacheable_engines(&[("brave", true)]));
        assert!(cacheable_engines(&[("brave", true), ("duckduckgo", true)]));
        assert!(cacheable_engines(&[("duckduckgo", true)]));
        // All engines failed → nothing worth caching.
        assert!(!cacheable_engines(&[("brave", false), ("ddg", false)]));

        let conn = mem();
        search_cache_put(&conn, "k", "brave:ok", "brave results").unwrap();
        assert!(search_cache_get(&conn, "k", SEARCH_CACHE_TTL_SECS)
            .unwrap()
            .is_none());
        search_cache_put(&conn, "k", "duckduckgo:ok", "ddg results").unwrap();
        assert_eq!(
            search_cache_get(&conn, "k", SEARCH_CACHE_TTL_SECS).unwrap(),
            Some("ddg results".to_string())
        );
    }

    #[test]
    fn page_cache_round_trip() {
        let conn = mem();
        page_cache_put(&conn, "https://example.com/a", "# Hello\n\nBody").unwrap();
        let hit = page_cache_get(&conn, "https://example.com/a", PAGE_CACHE_TTL_SECS).unwrap();
        assert!(hit.unwrap().starts_with("# Hello"));
        // Expired → None.
        conn.execute(
            "UPDATE page_cache SET created_at = created_at - 999999999",
            [],
        )
        .unwrap();
        assert!(page_cache_get(&conn, "https://example.com/a", PAGE_CACHE_TTL_SECS)
            .unwrap()
            .is_none());
    }

    #[test]
    fn content_hash_is_stable_sha256_hex() {
        let h1 = content_hash("same");
        let h2 = content_hash("same");
        let h3 = content_hash("other");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn record_search_flags_repeats_and_clear_works() {
        let conn = mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-5", None).unwrap();
        assert!(!record_search(&conn, &cs.id, "rust async runtime", "duckduckgo:ok", 8).unwrap());
        // Same query, different case/spacing → repeat detected.
        assert!(
            record_search(&conn, &cs.id, "  Rust   ASYNC   Runtime ", "mojeek:ok", 6)
                .unwrap()
        );
        // Distinct query → not a repeat.
        assert!(!record_search(&conn, &cs.id, "tokio vs async-std", "wikipedia:ok", 3).unwrap());
        clear_searches(&conn, &cs.id).unwrap();
        assert!(!record_search(&conn, &cs.id, "rust async runtime", "duckduckgo:ok", 8).unwrap());
    }

    #[test]
    fn queries_are_scoped_per_session() {
        let conn = mem();
        let a = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        let b = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        record_search(&conn, &a.id, "shared query", "duckduckgo:ok", 1).unwrap();
        // Session B never searched this — not a repeat.
        assert!(!record_search(&conn, &b.id, "shared query", "duckduckgo:ok", 1).unwrap());
    }

    #[test]
    fn latest_citation_detail_and_trend_are_chronological() {
        let conn = mem();
        let cs = create_chat_session(&conn, "anthropic", "claude-sonnet-5", None).unwrap();
        // No reports yet → None / empty.
        assert!(latest_citation_detail(&conn, &cs.id).unwrap().is_none());
        assert!(citation_quality_trend(&conn, 10).unwrap().is_empty());
        for i in 0..3i64 {
            save_citation_report(&conn, &cs.id, Some(i), 10 + i, i, 0, 0, 0, &format!("{{\"run\":{i}}}"))
                .unwrap();
            // Distinct created_at rows (now_ts has second resolution).
            conn.execute(
                "UPDATE citation_reports SET created_at = created_at + ?1 WHERE id = (SELECT MAX(id) FROM citation_reports)",
                [i],
            )
            .unwrap();
        }
        let latest = latest_citation_detail(&conn, &cs.id).unwrap().unwrap();
        assert!(latest.contains("\"run\":2"));
        let trend = citation_quality_trend(&conn, 2).unwrap();
        assert_eq!(trend.len(), 2, "limit applies");
        assert_eq!(trend[0].total_citations, 11, "oldest of the latest-two first");
        assert_eq!(trend[1].total_citations, 12);
        // Scoped per session.
        let other = create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        assert!(latest_citation_detail(&conn, &other.id).unwrap().is_none());
    }
}
