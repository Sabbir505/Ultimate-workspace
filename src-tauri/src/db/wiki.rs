//! Project wiki (§6.15) — persistence.
//!
//! One generated knowledge base per bound project root, stored as three
//! tables (created in init_schema, self-migrating):
//!   wiki_projects — one row per project + the git HEAD the wiki describes;
//!   wiki_pages    — generated markdown pages (overview/architecture/module
//!                   …) with their builder brief and evidence file set, so
//!                   the update pass can re-derive a single page;
//!   wiki_claims   — Grounded Claims: every material fact carries repo-
//!                   relative evidence (path + line range) and the blob SHA
//!                   the file had at generation time. The freshness engine
//!                   diffs changed paths against this table — staleness is
//!                   COMPUTED, never guessed (docs/research/
//!                   PROJECT_WIKI_RESEARCH.md §4.3).
//!
//! Search is FTS5 over page title/summary/body via the external-content
//! `wiki_pages_fts` table (same shape as doc_chunks_fts). No embeddings:
//! pages are short, curated, and keyword-dense — the RAG corpus remains the
//! place raw file content is searched.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

/// Bump when the page FORMAT changes (builder prompts, claim shape, body
/// conventions) in a way that makes old pages misleading. A lagging version
/// forces the next build to regenerate every page — the same trick
/// DOCS_CHUNK_SCHEMA_VERSION plays for RAG corpora.
pub const WIKI_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProject {
    pub id: String,
    pub path: String,
    pub head_sha: Option<String>,
    pub schema_version: i64,
    pub built_at: Option<i64>,
    pub last_update_at: Option<i64>,
    pub build_model: Option<String>,
}

fn map_project(row: &Row) -> rusqlite::Result<WikiProject> {
    Ok(WikiProject {
        id: row.get("id")?,
        path: row.get("path")?,
        head_sha: row.get("head_sha")?,
        schema_version: row.get("schema_version")?,
        built_at: row.get("built_at")?,
        last_update_at: row.get("last_update_at")?,
        build_model: row.get("build_model")?,
    })
}

const PROJECT_COLUMNS: &str =
    "id, path, head_sha, schema_version, built_at, last_update_at, build_model";

/// Page row without the body (list/index surfaces).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub kind: String,
    pub summary: String,
    /// "fresh" | "stale" | "rebuilding" | "failed"
    pub status: String,
    pub stale_reason: Option<String>,
    pub generated_at: i64,
    pub generated_by: Option<String>,
}

fn map_page(row: &Row) -> rusqlite::Result<WikiPage> {
    Ok(WikiPage {
        id: row.get("id")?,
        slug: row.get("slug")?,
        title: row.get("title")?,
        kind: row.get("kind")?,
        summary: row.get("summary")?,
        status: row.get("status")?,
        stale_reason: row.get("stale_reason")?,
        generated_at: row.get("generated_at")?,
        generated_by: row.get("generated_by")?,
    })
}

const PAGE_COLUMNS: &str = "id, slug, title, kind, summary, status, stale_reason, \
     generated_at, generated_by";

/// One grounded claim: a factual sentence on a page pinned to versioned
/// source evidence. `blob_sha` is the whole-file blob the evidence pointed
/// at when the page was written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiClaim {
    pub claim: String,
    pub evidence_path: String,
    pub line_start: Option<i64>,
    pub line_end: Option<i64>,
    pub blob_sha: Option<String>,
}

pub fn get_project_by_path(conn: &Connection, path: &str) -> DbResult<Option<WikiProject>> {
    conn.query_row(
        &format!("SELECT {PROJECT_COLUMNS} FROM wiki_projects WHERE path = ?1"),
        params![path],
        map_project,
    )
    .optional()
}

/// Every wiki (the freshness tick re-checks each one's HEAD).
pub fn list_projects(conn: &Connection) -> DbResult<Vec<WikiProject>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROJECT_COLUMNS} FROM wiki_projects ORDER BY path"
    ))?;
    let rows = stmt
        .query_map([], map_project)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Fetch-or-create the wiki row for a project root. `path` must already be
/// canonicalized by the caller (commands canonicalize once, upstream).
pub fn ensure_project(conn: &Connection, path: &str) -> DbResult<WikiProject> {
    if let Some(existing) = get_project_by_path(conn, path)? {
        return Ok(existing);
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO wiki_projects (id, path) VALUES (?1, ?2)",
        params![id, path],
    )?;
    get_project_by_path(conn, path)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Stamp the state of a full build: HEAD the wiki now describes, the model
/// that built it, and the page-format schema version at build time.
pub fn stamp_build(
    conn: &Connection,
    project_id: &str,
    head_sha: Option<&str>,
    build_model: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE wiki_projects
         SET head_sha = ?2, schema_version = ?3, built_at = ?4,
             last_update_at = ?4, build_model = ?5
         WHERE id = ?1",
        params![
            project_id,
            head_sha,
            WIKI_SCHEMA_VERSION,
            now_ts(),
            build_model
        ],
    )?;
    Ok(())
}

/// Stamp an update pass: only the HEAD and the timestamp move.
pub fn stamp_update(conn: &Connection, project_id: &str, head_sha: Option<&str>) -> DbResult<()> {
    conn.execute(
        "UPDATE wiki_projects SET head_sha = ?2, last_update_at = ?3 WHERE id = ?1",
        params![project_id, head_sha, now_ts()],
    )?;
    Ok(())
}

pub fn list_pages(conn: &Connection, project_id: &str) -> DbResult<Vec<WikiPage>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PAGE_COLUMNS} FROM wiki_pages
         WHERE project_id = ?1
         ORDER BY CASE kind
             WHEN 'overview' THEN 0 WHEN 'architecture' THEN 1
             WHEN 'module' THEN 2 WHEN 'howto' THEN 3
             WHEN 'glossary' THEN 4 WHEN 'history' THEN 5
             ELSE 6 END, title",
    ))?;
    let rows = stmt
        .query_map(params![project_id], map_page)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A page with everything: body, builder brief, evidence file set, claims.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageFull {
    #[serde(flatten)]
    pub page: WikiPage,
    pub body: String,
    pub brief: String,
    pub files: Vec<String>,
    pub claims: Vec<WikiClaim>,
}

pub fn get_page_full(
    conn: &Connection,
    project_id: &str,
    slug: &str,
) -> DbResult<Option<WikiPageFull>> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {PAGE_COLUMNS}, body, brief, files_json
                 FROM wiki_pages WHERE project_id = ?1 AND slug = ?2"
            ),
            params![project_id, slug],
            |row| {
                Ok((
                    map_page(row)?,
                    row.get::<_, String>("body")?,
                    row.get::<_, String>("brief")?,
                    row.get::<_, String>("files_json")?,
                ))
            },
        )
        .optional()?;
    let Some((page, body, brief, files_json)) = row else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT claim, evidence_path, line_start, line_end, blob_sha
         FROM wiki_claims WHERE page_id = ?1 ORDER BY id",
    )?;
    let claims = stmt
        .query_map(params![page.id], |r| {
            Ok(WikiClaim {
                claim: r.get("claim")?,
                evidence_path: r.get("evidence_path")?,
                line_start: r.get("line_start")?,
                line_end: r.get("line_end")?,
                blob_sha: r.get("blob_sha")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(WikiPageFull {
        page,
        body,
        brief,
        files: serde_json::from_str(&files_json).unwrap_or_default(),
        claims,
    }))
}

/// All (page_slug, evidence_path) pairs for a project — the join target for
/// `git diff --name-status <old>..<new>` in the update pass. Claims AND each
/// page's stored file set, unioned: a page whose claims were all dropped by
/// validation (hallucinated paths, unreadable files) has no `wiki_claims`
/// rows at all, and joining on claims alone left it permanently unreachable
/// by the freshness engine — the update passed it as unaffected and advanced
/// the HEAD stamp past every commit that could have repaired it.
pub fn evidence_paths(conn: &Connection, project_id: &str) -> DbResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.slug, c.evidence_path
         FROM wiki_claims c JOIN wiki_pages p ON p.id = c.page_id
         WHERE p.project_id = ?1
         UNION
         SELECT DISTINCT p.slug, f.value
         FROM wiki_pages p, json_each(p.files_json) f
         WHERE p.project_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Slugs whose evidence we cannot check at all — no claims AND no file set.
/// These are refreshed whenever ANY commit lands, because "we have no
/// evidence linking this page to the repo" is not evidence that the page is
/// still correct.
pub fn pages_without_evidence(conn: &Connection, project_id: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT slug FROM wiki_pages
         WHERE project_id = ?1
           AND NOT EXISTS (
             SELECT 1 FROM wiki_claims c WHERE c.page_id = wiki_pages.id
           )
           AND (files_json IS NULL OR files_json = '' OR files_json = '[]')",
    )?;
    let rows = stmt
        .query_map(params![project_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Drop the build stamp. Called alongside `clear_pages` at the start of a
/// build: clearing the pages while leaving `head_sha` intact produced a wiki
/// that no update pass could repair (zero pages, but the freshness tick saw
/// "HEAD unchanged" and `run_update` returned up_to_date forever). A cleared
/// wiki must present as "never built" so the next tick rebuilds it.
pub fn clear_build_stamp(conn: &Connection, project_id: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE wiki_projects
         SET head_sha = NULL, schema_version = 0, built_at = NULL, last_update_at = NULL
         WHERE id = ?1",
        params![project_id],
    )?;
    Ok(())
}

/// Mark every page of a project as being rebuilt, so a build that dies
/// mid-way (model outage, cancel, crash) leaves an honest "rebuilding"
/// badge instead of a page list that silently lost pages.
pub fn mark_pages_rebuilding(conn: &Connection, project_id: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE wiki_pages SET status = 'rebuilding', stale_reason = NULL WHERE project_id = ?1",
        params![project_id],
    )?;
    Ok(())
}

/// The builder brief + file set of one page (the update pass re-derives a
/// stale page from these — same brief, current file contents).
pub fn page_brief(
    conn: &Connection,
    project_id: &str,
    slug: &str,
) -> DbResult<Option<(String, Vec<String>)>> {
    let row = conn
        .query_row(
            "SELECT brief, files_json FROM wiki_pages WHERE project_id = ?1 AND slug = ?2",
            params![project_id, slug],
            |r| {
                Ok((
                    r.get::<_, String>("brief")?,
                    r.get::<_, String>("files_json")?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(|(brief, files_json)| {
        (brief, serde_json::from_str(&files_json).unwrap_or_default())
    }))
}

/// Insert-or-replace one page and its claims in one transaction. The FTS
/// triggers keep the search index in sync through the DELETE+INSERT.
pub fn replace_page(
    conn: &Connection,
    project_id: &str,
    slug: &str,
    title: &str,
    kind: &str,
    summary: &str,
    body: &str,
    brief: &str,
    files: &[String],
    status: &str,
    generated_by: Option<&str>,
    claims: &[WikiClaim],
) -> DbResult<String> {
    let files_json = serde_json::to_string(files).unwrap_or_else(|_| "[]".to_string());
    let tx = conn.unchecked_transaction()?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM wiki_pages WHERE project_id = ?1 AND slug = ?2",
            params![project_id, slug],
            |r| r.get(0),
        )
        .optional()?;
    let page_id = match existing {
        Some(id) => {
            tx.execute(
                "DELETE FROM wiki_claims WHERE page_id = ?1",
                params![id],
            )?;
            tx.execute(
                &format!(
                    "UPDATE wiki_pages SET title = ?2, kind = ?3, summary = ?4, body = ?5,
                     brief = ?6, files_json = ?7, status = ?8, stale_reason = NULL,
                     generated_at = ?9, generated_by = ?10 WHERE id = ?1"
                ),
                params![
                    id,
                    title,
                    kind,
                    summary,
                    body,
                    brief,
                    files_json,
                    status,
                    now_ts(),
                    generated_by
                ],
            )?;
            id
        }
        None => {
            let id = new_id();
            tx.execute(
                &format!(
                    "INSERT INTO wiki_pages (id, project_id, slug, title, kind, summary, body,
                     brief, files_json, status, generated_at, generated_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
                ),
                params![
                    id,
                    project_id,
                    slug,
                    title,
                    kind,
                    summary,
                    body,
                    brief,
                    files_json,
                    status,
                    now_ts(),
                    generated_by
                ],
            )?;
            id
        }
    };
    for claim in claims {
        tx.execute(
            "INSERT INTO wiki_claims (page_id, claim, evidence_path, line_start, line_end, blob_sha)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                page_id,
                claim.claim,
                claim.evidence_path,
                claim.line_start,
                claim.line_end,
                claim.blob_sha
            ],
        )?;
    }
    tx.commit()?;
    Ok(page_id)
}

/// Mark pages stale (the update pass found changed evidence) or back to
/// fresh. `stale_reason` is cleared on any status but "stale".
pub fn set_page_status(
    conn: &Connection,
    project_id: &str,
    slug: &str,
    status: &str,
    stale_reason: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE wiki_pages SET status = ?3,
         stale_reason = CASE WHEN ?3 = 'stale' THEN ?4 ELSE NULL END
         WHERE project_id = ?1 AND slug = ?2",
        params![project_id, slug, status, stale_reason],
    )?;
    Ok(())
}

pub fn page_count(conn: &Connection, project_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM wiki_pages WHERE project_id = ?1",
        params![project_id],
        |r| r.get(0),
    )
}

/// Drop every page of a project (precedes a full rebuild). One transaction:
/// `wiki_claims.page_id` carries no foreign key, so a crash between the two
/// statements strands rows nothing ever collects.
pub fn clear_pages(conn: &Connection, project_id: &str) -> DbResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM wiki_claims WHERE page_id IN
         (SELECT id FROM wiki_pages WHERE project_id = ?1)",
        params![project_id],
    )?;
    tx.execute(
        "DELETE FROM wiki_pages WHERE project_id = ?1",
        params![project_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn remove_wiki(conn: &Connection, project_id: &str) -> DbResult<()> {
    // Same reason as `clear_pages`: the project row must not survive its own
    // pages. A half-applied delete left a `wiki_projects` row with a head_sha
    // and zero pages, which the freshness tick kept polling forever.
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM wiki_claims WHERE page_id IN
         (SELECT id FROM wiki_pages WHERE project_id = ?1)",
        params![project_id],
    )?;
    tx.execute(
        "DELETE FROM wiki_pages WHERE project_id = ?1",
        params![project_id],
    )?;
    tx.execute(
        "DELETE FROM wiki_projects WHERE id = ?1",
        params![project_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// Every wiki rooted at `root` or below it (the project-deletion cascade:
/// wiki projects key on PATH, not on `projects.id`, so removing a project
/// left an orphan wiki that kept the freshness sweep running `git rev-parse`
/// against a folder that no longer exists).
///
/// The containment test is done in Rust, not with SQL `LIKE`: stored paths
/// keep the platform separator (Windows paths are backslash-separated), and
/// a project folder containing `_` is a `LIKE` single-char wildcard that
/// would match a sibling it must never touch.
pub fn remove_wiki_by_path_prefix(conn: &Connection, root: &str) -> DbResult<usize> {
    let doomed = wiki_ids_under(conn, root)?;
    if doomed.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    delete_wiki_rows(&tx, &doomed)?;
    tx.commit()?;
    Ok(doomed.len())
}

/// The `wiki_projects` ids whose stored path is `root` or below it. Shared by
/// the standalone delete and the project-removal caller (which is already
/// inside a transaction).
pub(crate) fn wiki_ids_under(conn: &Connection, root: &str) -> DbResult<Vec<String>> {
    let root = root.trim_end_matches(['/', '\\']);
    let candidates: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, path FROM wiki_projects")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let under = |path: &str| -> bool {
        path == root
            || path
                .strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
    };
    Ok(candidates
        .into_iter()
        .filter(|(_, path)| under(path))
        .map(|(id, _)| id)
        .collect())
}

/// Delete claims/pages/project rows for `ids` using the caller's connection
/// OR transaction. Split out so a caller already inside a transaction (project
/// removal — `db/projects.rs`) can reuse these statements: `unchecked_transaction`
/// issues a plain `BEGIN`, so a nested one fails with "cannot start a
/// transaction within a transaction", erroring and rolling back the WHOLE
/// project delete — any project with a wiki was undeletable (audit H14).
pub(crate) fn delete_wiki_rows(conn: &Connection, ids: &[String]) -> DbResult<()> {
    for id in ids {
        conn.execute(
            "DELETE FROM wiki_claims WHERE page_id IN
             (SELECT id FROM wiki_pages WHERE project_id = ?1)",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM wiki_pages WHERE project_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM wiki_projects WHERE id = ?1", params![id])?;
    }
    Ok(())
}

/// Per-wiki rollup for the tool-panel's project list (one row per wiki,
/// pages aggregated — the panel groups pages UNDER projects, so it needs
/// counts, not page rows).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProjectSummary {
    pub path: String,
    pub page_count: i64,
    pub stale_count: i64,
    pub built_at: Option<i64>,
    pub build_model: Option<String>,
}

/// Every wiki with its page/freshness rollup, ordered by path.
pub fn list_project_summaries(conn: &Connection) -> DbResult<Vec<WikiProjectSummary>> {
    let mut stmt = conn.prepare(
        "SELECT p.path,
                COUNT(wp.id),
                COALESCE(SUM(CASE WHEN wp.status != 'fresh' THEN 1 ELSE 0 END), 0),
                p.built_at,
                p.build_model
         FROM wiki_projects p
         LEFT JOIN wiki_pages wp ON wp.project_id = p.id
         GROUP BY p.id, p.path, p.built_at, p.build_model
         ORDER BY p.path",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(WikiProjectSummary {
                path: r.get("path")?,
                page_count: r.get(1)?,
                stale_count: r.get(2)?,
                built_at: r.get(3)?,
                build_model: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// One FTS hit for `search_wiki`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchHit {
    pub slug: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub summary: String,
    pub snippet: String,
    pub rank: f64,
}

/// FTS5-safe quoting — shared implementation in db/mod.rs (audit M: FTS DRY;
/// the private copy here drifted risk-free only by luck). Returns None when
/// nothing searchable remains.
fn fts_match_query(query: &str) -> Option<String> {
    super::fts_prefix_query(query, super::FtsTerms::OrAlnum)
}

/// Keyword search over wiki pages, bm25-ranked (column weights: title 8,
/// summary 3, body 1). Returns empty (not an error) for unmatchable queries.
pub fn search_pages(
    conn: &Connection,
    project_id: &str,
    query: &str,
    top_k: usize,
) -> DbResult<Vec<WikiSearchHit>> {
    let Some(match_expr) = fts_match_query(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT p.slug, p.title, p.kind, p.status, p.summary,
                snippet(wiki_pages_fts, 2, '«', '»', ' … ', 24) AS snip,
                bm25(wiki_pages_fts, 8.0, 3.0, 1.0) AS rank
         FROM wiki_pages_fts f
         JOIN wiki_pages p ON p.rowid = f.rowid
         WHERE wiki_pages_fts MATCH ?1 AND p.project_id = ?2
         ORDER BY rank
         LIMIT ?3"
    ))?;
    let rows = stmt
        .query_map(params![match_expr, project_id, top_k as i64], |r| {
            Ok(WikiSearchHit {
                slug: r.get("slug")?,
                title: r.get("title")?,
                kind: r.get("kind")?,
                status: r.get("status")?,
                summary: r.get("summary")?,
                snippet: r.get("snip")?,
                rank: r.get("rank")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::mem;

    fn claim(path: &str, claim: &str) -> WikiClaim {
        WikiClaim {
            claim: claim.to_string(),
            evidence_path: path.to_string(),
            line_start: Some(1),
            line_end: Some(10),
            blob_sha: Some("deadbeef".to_string()),
        }
    }

    #[test]
    fn project_round_trip_and_ensure_is_idempotent() {
        let conn = mem();
        let a = ensure_project(&conn, "/repo/a").unwrap();
        let b = ensure_project(&conn, "/repo/a").unwrap();
        assert_eq!(a.id, b.id, "ensure_project must fetch-or-create, not duplicate");
        assert_eq!(a.schema_version, 0);
        stamp_build(&conn, &a.id, Some("abc123"), Some("gpt-x")).unwrap();
        let a = get_project_by_path(&conn, "/repo/a").unwrap().unwrap();
        assert_eq!(a.head_sha.as_deref(), Some("abc123"));
        assert_eq!(a.schema_version, WIKI_SCHEMA_VERSION);
        assert_eq!(a.build_model.as_deref(), Some("gpt-x"));
        stamp_update(&conn, &a.id, Some("def456")).unwrap();
        let a = get_project_by_path(&conn, "/repo/a").unwrap().unwrap();
        assert_eq!(a.head_sha.as_deref(), Some("def456"));
        assert!(a.last_update_at.unwrap_or(0) >= a.built_at.unwrap_or(0));
    }

    #[test]
    fn replace_page_upserts_and_swaps_claims() {
        let conn = mem();
        let p = ensure_project(&conn, "/repo").unwrap();
        let id = replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "The big picture",
            "# Overview\nBody v1", "brief v1", &["src/a.ts".into()], "fresh",
            Some("m1"), &[claim("src/a.ts", "A does X")],
        )
        .unwrap();
        // Same slug again: UPDATE, not a second row; claims fully replaced.
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "The big picture",
            "# Overview\nBody v2", "brief v2", &["src/b.ts".into()], "fresh",
            Some("m2"), &[claim("src/b.ts", "B does Y"), claim("src/c.ts", "C does Z")],
        )
        .unwrap();
        assert_eq!(page_count(&conn, &p.id).unwrap(), 1);
        let full = get_page_full(&conn, &p.id, "overview").unwrap().unwrap();
        assert_eq!(full.body, "# Overview\nBody v2");
        assert_eq!(full.brief, "brief v2");
        assert_eq!(full.files, vec!["src/b.ts".to_string()]);
        assert_eq!(full.claims.len(), 2, "old claims must be replaced, not appended");
        assert!(full.claims.iter().all(|c| c.evidence_path != "src/a.ts"));
        assert_eq!(full.page.id, id);
        assert_eq!(full.page.status, "fresh");
    }

    #[test]
    fn evidence_paths_cover_distinct_slugs() {
        let conn = mem();
        let p = ensure_project(&conn, "/repo").unwrap();
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "",
            "b", "br", &[], "fresh", None, &[claim("src/a.ts", "x")],
        )
        .unwrap();
        replace_page(
            &conn, &p.id, "mesh", "Mesh", "module", "",
            "b", "br", &[], "fresh", None,
            &[claim("src/a.ts", "x"), claim("src/mesh.rs", "y")],
        )
        .unwrap();
        let mut paths = evidence_paths(&conn, &p.id).unwrap();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                ("mesh".to_string(), "src/a.ts".to_string()),
                ("mesh".to_string(), "src/mesh.rs".to_string()),
                ("overview".to_string(), "src/a.ts".to_string()),
            ]
        );
    }

    #[test]
    fn status_update_only_carries_reason_when_stale() {
        let conn = mem();
        let p = ensure_project(&conn, "/repo").unwrap();
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "", "b", "br",
            &[], "fresh", None, &[],
        )
        .unwrap();
        set_page_status(&conn, &p.id, "overview", "stale", Some("src/a.ts changed"))
            .unwrap();
        let page = &list_pages(&conn, &p.id).unwrap()[0];
        assert_eq!(page.status, "stale");
        assert_eq!(page.stale_reason.as_deref(), Some("src/a.ts changed"));
        // Any other status clears the reason (a regenerated page isn't stale).
        set_page_status(&conn, &p.id, "overview", "fresh", Some("leftover")).unwrap();
        let page = &list_pages(&conn, &p.id).unwrap()[0];
        assert_eq!(page.status, "fresh");
        assert!(page.stale_reason.is_none());
    }

    #[test]
    fn clear_and_remove_leave_nothing_behind() {
        let conn = mem();
        let p = ensure_project(&conn, "/repo").unwrap();
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "", "b", "br",
            &[], "fresh", None, &[claim("src/a.ts", "x")],
        )
        .unwrap();
        clear_pages(&conn, &p.id).unwrap();
        assert_eq!(page_count(&conn, &p.id).unwrap(), 0);
        assert!(evidence_paths(&conn, &p.id).unwrap().is_empty());
        let n_claims: i64 = conn
            .query_row("SELECT COUNT(*) FROM wiki_claims", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_claims, 0, "clear_pages must not strand claims");
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "", "b", "br",
            &[], "fresh", None, &[claim("src/a.ts", "x")],
        )
        .unwrap();
        remove_wiki(&conn, &p.id).unwrap();
        assert!(get_project_by_path(&conn, "/repo").unwrap().is_none());
        let n_claims: i64 = conn
            .query_row("SELECT COUNT(*) FROM wiki_claims", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_claims, 0);
    }

    #[test]
    fn search_ranks_title_hits_first_and_quotes_safely() {
        let conn = mem();
        let p = ensure_project(&conn, "/repo").unwrap();
        replace_page(
            &conn, &p.id, "mesh", "Session Mesh", "module", "Peer-to-peer agent messaging",
            "The mesh connects sessions. Quoting survives \"quotes\" and OR NOT (parens).",
            "br", &[], "fresh", None, &[],
        )
        .unwrap();
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "The big picture",
            "The mesh is mentioned once here.", "br", &[], "fresh", None, &[],
        )
        .unwrap();
        let hits = search_pages(&conn, &p.id, "mesh", 5).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].slug, "mesh", "title-weighted bm25 puts the Mesh page first");
        assert!(hits[0].snippet.contains("mesh"));
        // FTS operator injection is inert: every term is double-quoted and
        // stripped to alphanumerics, so operators never parse as syntax.
        // A probe of body words may legitimately hit; the property is that
        // it can never ERROR, and a gibberish probe matches nothing.
        let _ = search_pages(&conn, &p.id, "\"AND OR NOT (\" --", 5).unwrap();
        let hits = search_pages(&conn, &p.id, "zzqq (()) -- ::", 5).unwrap();
        assert!(hits.is_empty());
        let hits = search_pages(&conn, &p.id, "   !!!   ", 5).unwrap();
        assert!(hits.is_empty());
        // Other projects' pages never leak.
        let q = ensure_project(&conn, "/other").unwrap();
        assert!(search_pages(&conn, &q.id, "mesh", 5).unwrap().is_empty());
    }

    #[test]
    fn old_fts_rowid_definition_is_migrated_in_place() {
        // Simulate a database that booted on the OLD DDL (content_rowid='id'
        // over a TEXT uuid column): every write died with SQLITE_TYPE_MISMATCH.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE wiki_pages (
               id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
               title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'module',
               summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'fresh', stale_reason TEXT,
               brief TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]',
               generated_at INTEGER NOT NULL DEFAULT 0, generated_by TEXT,
               UNIQUE (project_id, slug)
             );
             CREATE VIRTUAL TABLE wiki_pages_fts USING fts5(
               title, summary, body, content='wiki_pages',
               content_rowid='id', tokenize='unicode61'
             );
             CREATE TRIGGER wiki_pages_fts_ai AFTER INSERT ON wiki_pages BEGIN
               INSERT INTO wiki_pages_fts(rowid, title, summary, body)
                 VALUES (new.id, new.title, new.summary, new.body);
             END;",
        )
        .unwrap();
        // A page that landed while the table was transiently working (the
        // old trigger is dropped for the seed — real installs mostly had
        // ZERO pages because every insert died on this trigger).
        conn.execute_batch(
            "DROP TRIGGER wiki_pages_fts_ai;
             INSERT INTO wiki_pages (id, project_id, slug, title, kind, summary, body, status, generated_at)
               VALUES ('u1', 'p1', 'mesh', 'Mesh', 'module', 'peer messaging', 'the mesh routes', 'fresh', 0);",
        )
        .unwrap();
        // init_schema must detect the old definition, replace the virtual
        // table, and rebuild the index over existing rows.
        super::super::init_schema(&conn).unwrap();
        let ddl: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_pages_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            ddl.contains("content_rowid='rowid'"),
            "migrated DDL: {ddl}"
        );
        // Writes that previously died with "datatype mismatch" now work…
        conn.execute(
            "UPDATE wiki_pages SET body = 'the mesh routes v2' WHERE id = 'u1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wiki_pages (id, project_id, slug, title, kind, summary, body, status, generated_at)
             VALUES ('u2', 'p1', 'overview', 'Overview', 'overview', 'big', 'mentions mesh once', 'fresh', 0)",
            [],
        )
        .unwrap();
        // …and the rebuilt index finds pre-existing AND new rows.
        let hits = search_pages(&conn, "p1", "mesh", 5).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn brief_round_trips_for_the_update_pass() {
        let conn = mem();
        let p = ensure_project(&conn, "/repo").unwrap();
        assert!(page_brief(&conn, &p.id, "overview").unwrap().is_none());
        replace_page(
            &conn, &p.id, "overview", "Overview", "overview", "", "b", "the brief",
            &["a.rs".into(), "b.rs".into()], "fresh", None, &[],
        )
        .unwrap();
        let (brief, files) = page_brief(&conn, &p.id, "overview").unwrap().unwrap();
        assert_eq!(brief, "the brief");
        assert_eq!(files, vec!["a.rs".to_string(), "b.rs".to_string()]);
    }
}
