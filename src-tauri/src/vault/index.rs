//! Vault index — SQLite tables over the vault's markdown files.
//!
//! The FILES on disk are the source of truth; every table here is a derived,
//! deletable cache (rebuild = full rescan). One row-set per note plus an
//! FTS5 body index. The same connection/`DbState` conventions apply: never
//! hold the DB mutex across file IO (the caller reads the file first, then
//! opens a transaction).

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use super::parse::{
    self, FileMeta, ParsedNote,
};
use crate::db::DbResult;

/// Create the vault tables. Called from `db::init_schema` (and idempotently
/// from `full_scan`) — `IF NOT EXISTS` throughout, like the rest of the DDL.
pub fn ensure_schema(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        r#"
        -- One row per indexed vault file (notes AND linkable assets —
        -- images/pdf resolve as link targets even though they aren't parsed).
        CREATE TABLE IF NOT EXISTS vault_files (
          path TEXT PRIMARY KEY,          -- vault-relative, '/' separators, with ext
          basename TEXT NOT NULL,
          folder TEXT NOT NULL DEFAULT '',
          ext TEXT NOT NULL DEFAULT '',
          title TEXT,
          aliases TEXT NOT NULL DEFAULT '[]',
          frontmatter TEXT,
          word_count INTEGER NOT NULL DEFAULT 0,
          mtime INTEGER NOT NULL DEFAULT 0,
          size INTEGER NOT NULL DEFAULT 0,
          ctime INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_vault_files_basename ON vault_files(basename);

        -- Every link occurrence (wikilinks + internal md links). dest is the
        -- RESOLVED vault path, NULL when unresolved (first-class in the UI).
        CREATE TABLE IF NOT EXISTS vault_links (
          src TEXT NOT NULL,
          dest TEXT,
          raw TEXT NOT NULL,
          is_embed INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL DEFAULT 'link',   -- 'wiki' | 'md'
          line INTEGER NOT NULL DEFAULT 0,
          UNIQUE(src, raw, line, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_vault_links_dest ON vault_links(dest);
        CREATE INDEX IF NOT EXISTS idx_vault_links_src ON vault_links(src);

        CREATE TABLE IF NOT EXISTS vault_tags (
          tag TEXT NOT NULL,
          path TEXT NOT NULL,
          line INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'inline'   -- 'inline' | 'frontmatter'
        );
        CREATE INDEX IF NOT EXISTS idx_vault_tags_tag ON vault_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_vault_tags_path ON vault_tags(path);

        CREATE TABLE IF NOT EXISTS vault_headings (
          path TEXT NOT NULL,
          level INTEGER NOT NULL,
          text TEXT NOT NULL,
          line INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_vault_headings_path ON vault_headings(path);

        CREATE TABLE IF NOT EXISTS vault_blocks (
          path TEXT NOT NULL,
          block_id TEXT NOT NULL,
          line INTEGER NOT NULL DEFAULT 0,
          UNIQUE(path, block_id)
        );

        -- Plain FTS5 (not external-content): the indexer is the only writer
        -- and rebuilds rows in the same transaction as vault_files.
        -- Markers ⟨ ⟩ avoid any HTML injection when snippets are rendered.
        CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
          path UNINDEXED, name, body, tokenize='unicode61'
        );
        "#,
    )?;
    Ok(())
}

pub fn reset_index(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        "DELETE FROM vault_links; DELETE FROM vault_tags; DELETE FROM vault_headings;
         DELETE FROM vault_blocks; DELETE FROM vault_fts; DELETE FROM vault_files;",
    )?;
    Ok(())
}

/// Files the resolver works with (notes only — resolution targets for
/// wikilinks; assets resolve via their path spelling in `resolve_link`).
pub fn list_files(conn: &Connection) -> DbResult<Vec<FileMeta>> {
    let mut stmt = conn.prepare(
        "SELECT path, basename, folder, aliases FROM vault_files ORDER BY path",
    )?;
    let rows = stmt.query_map([], |r| {
        let aliases_raw: String = r.get(3)?;
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            aliases_raw,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (path, basename, folder, aliases_raw) = row?;
        let aliases: Vec<String> = serde_json::from_str(&aliases_raw).unwrap_or_default();
        out.push(FileMeta {
            path,
            basename,
            folder,
            aliases,
            is_note: true,
        });
    }
    Ok(out)
}

/// (Re)index one note. Reads the file FIRST (no DB lock held across IO),
/// then upserts everything in one transaction. Missing file = removal.
pub fn reindex_file(conn: &Connection, root: &Path, rel: &str) -> DbResult<bool> {
    let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let meta = match std::fs::metadata(&abs) {
        Ok(m) if m.is_file() => m,
        _ => {
            remove_from_index(conn, rel)?;
            return Ok(false);
        }
    };
    let content = match std::fs::read_to_string(&abs) {
        Ok(c) => c,
        Err(_) => {
            // Binary/undecodable: keep the file resolvable, unparsed.
            upsert_file_row(conn, rel, "", None, None, 0, &meta)?;
            return Ok(true);
        }
    };
    let parsed: ParsedNote = parse::parse_note(&content);
    let aliases = parsed
        .frontmatter
        .as_ref()
        .map(|f| f.get_list("aliases"))
        .unwrap_or_default();
    let fm_tags = parsed
        .frontmatter
        .as_ref()
        .map(|f| f.get_list("tags"))
        .unwrap_or_default();

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> DbResult<()> {
        upsert_file_row_parsed(conn, rel, &parsed, &aliases, &content.len(), &meta)?;
        // One resolver snapshot per reindex (not per link) — O(files), not
        // O(links × files). The just-upserted row is included, so self-links
        // and newly renamed files resolve consistently.
        let files = list_files(conn)?;
        conn.execute(
            "DELETE FROM vault_links WHERE src = ?1",
            rusqlite::params![rel],
        )?;
        for l in &parsed.links {
            let dest = parse::resolve_link(l.linkpath(), &files);
            conn.execute(
                "INSERT OR IGNORE INTO vault_links (src, dest, raw, is_embed, kind, line)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    rel,
                    dest,
                    l.linkpath(),
                    l.is_embed as i64,
                    if l.is_md { "md" } else { "wiki" },
                    l.line as i64
                ],
            )?;
        }
        conn.execute("DELETE FROM vault_tags WHERE path = ?1", rusqlite::params![rel])?;
        for t in &parsed.tags {
            conn.execute(
                "INSERT OR IGNORE INTO vault_tags (tag, path, line, source) VALUES (?1, ?2, ?3, 'inline')",
                rusqlite::params![t.tag, rel, t.line as i64],
            )?;
        }
        for t in &fm_tags {
            conn.execute(
                "INSERT OR IGNORE INTO vault_tags (tag, path, line, source) VALUES (?1, ?2, -1, 'frontmatter')",
                rusqlite::params![t, rel],
            )?;
        }
        conn.execute(
            "DELETE FROM vault_headings WHERE path = ?1",
            rusqlite::params![rel],
        )?;
        for h in &parsed.headings {
            conn.execute(
                "INSERT INTO vault_headings (path, level, text, line) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![rel, h.level as i64, h.text, h.line as i64],
            )?;
        }
        conn.execute(
            "DELETE FROM vault_blocks WHERE path = ?1",
            rusqlite::params![rel],
        )?;
        for b in &parsed.blocks {
            conn.execute(
                "INSERT OR IGNORE INTO vault_blocks (path, block_id, line) VALUES (?1, ?2, ?3)",
                rusqlite::params![rel, b.id, b.line as i64],
            )?;
        }
        conn.execute(
            "DELETE FROM vault_fts WHERE path = ?1",
            rusqlite::params![rel],
        )?;
        let name = rel.rsplit('/').next().unwrap_or(rel);
        conn.execute(
            "INSERT INTO vault_fts (path, name, body) VALUES (?1, ?2, ?3)",
            rusqlite::params![rel, name, content],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    // Forward references: links OTHER files wrote to this note before it
    // existed (or while it was renamed) stay dest=NULL until this file is
    // (re)indexed — resolve the pending ones now. Obsidian resolves
    // asynchronously; this is the same contract, synchronous and bounded.
    let names = pending_names_for(conn, rel);
    refresh_unresolved_for(conn, &names)?;
    Ok(true)
}

/// The raw spellings a pending link can use to reach  (stemmed path,
/// basename, aliases) — all lowercased for matching.
fn pending_names_for(conn: &Connection, rel: &str) -> Vec<String> {
    let (base, _folder) = split_rel(rel);
    let mut names = vec![base.to_lowercase()];
    let stem = rel.trim_end_matches(".md").to_lowercase();
    if !names.contains(&stem) {
        names.push(stem);
    }
    if let Ok(aliases_json) = conn.query_row(
        "SELECT aliases FROM vault_files WHERE path = ?1",
        rusqlite::params![rel],
        |r| r.get::<_, String>(0),
    ) {
        if let Ok(aliases) = serde_json::from_str::<Vec<String>>(&aliases_json) {
            for a in aliases {
                let a = a.to_lowercase();
                if !a.is_empty() && !names.contains(&a) {
                    names.push(a);
                }
            }
        }
    }
    names
}

/// Re-resolve dest=NULL links whose raw target matches one of 
/// (exact, or ending in  for folder-qualified spellings).
pub fn refresh_unresolved_for(conn: &Connection, names: &[String]) -> DbResult<usize> {
    let files = list_files(conn)?;
    let mut resolved = 0;
    for name in names {
        if name.is_empty() {
            continue;
        }
        let mut stmt = conn.prepare(
            "SELECT rowid, raw FROM vault_links WHERE dest IS NULL AND (lower(raw) = ?1 OR lower(raw) LIKE '%/' || ?1)",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map(rusqlite::params![name], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for (rowid, raw) in rows {
            if let Some(dest) = parse::resolve_link(&raw, &files) {
                conn.execute(
                    "UPDATE vault_links SET dest = ?1 WHERE rowid = ?2",
                    rusqlite::params![dest, rowid],
                )?;
                resolved += 1;
            }
        }
    }
    Ok(resolved)
}

/// Full pending-link sweep (scan time only — O(unresolved x files)).
pub fn refresh_all_unresolved(conn: &Connection) -> DbResult<usize> {
    let files = list_files(conn)?;
    let mut stmt = conn.prepare("SELECT rowid, raw FROM vault_links WHERE dest IS NULL")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    let mut resolved = 0;
    for (rowid, raw) in rows {
        if let Some(dest) = parse::resolve_link(&raw, &files) {
            conn.execute(
                "UPDATE vault_links SET dest = ?1 WHERE rowid = ?2",
                rusqlite::params![dest, rowid],
            )?;
            resolved += 1;
        }
    }
    Ok(resolved)
}

fn upsert_file_row(
    conn: &Connection,
    rel: &str,
    _body: &str,
    _aliases: Option<Vec<String>>,
    _fm: Option<&str>,
    _wc: u32,
    meta: &std::fs::Metadata,
) -> DbResult<()> {
    let (base, folder) = split_rel(rel);
    let mtime = mtime_of(meta);
    conn.execute(
        "INSERT INTO vault_files (path, basename, folder, ext, mtime, size, ctime)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
         ON CONFLICT(path) DO UPDATE SET basename=?2, folder=?3, ext=?4, mtime=?5, size=?6",
        rusqlite::params![rel, base, folder, ext_of(rel), mtime, meta.len() as i64],
    )?;
    Ok(())
}

fn upsert_file_row_parsed(
    conn: &Connection,
    rel: &str,
    parsed: &ParsedNote,
    aliases: &[String],
    size: &usize,
    meta: &std::fs::Metadata,
) -> DbResult<()> {
    let (base, folder) = split_rel(rel);
    let mtime = mtime_of(meta);
    let title = parsed.title.clone();
    let aliases_json = serde_json::to_string(aliases).unwrap_or_else(|_| "[]".into());
    let fm_raw = parsed.frontmatter_raw.clone();
    conn.execute(
        "INSERT INTO vault_files (path, basename, folder, ext, title, aliases, frontmatter, word_count, mtime, size, ctime)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9)
         ON CONFLICT(path) DO UPDATE SET basename=?2, folder=?3, ext=?4, title=?5, aliases=?6,
           frontmatter=?7, word_count=?8, mtime=?9, size=?10",
        rusqlite::params![
            rel,
            base,
            folder,
            ext_of(rel),
            title,
            aliases_json,
            fm_raw,
            parsed.word_count as i64,
            mtime,
            *size as i64
        ],
    )?;
    Ok(())
}

pub fn remove_from_index(conn: &Connection, rel: &str) -> DbResult<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let r = (|| -> DbResult<()> {
        // Inbound links to a deleted note become unresolved (graph keeps the
        // hollow node), exactly like Obsidian.
        conn.execute("UPDATE vault_links SET dest = NULL WHERE dest = ?1", rusqlite::params![rel])?;
        for sql in [
            "DELETE FROM vault_links WHERE src = ?1",
            "DELETE FROM vault_tags WHERE path = ?1",
            "DELETE FROM vault_headings WHERE path = ?1",
            "DELETE FROM vault_blocks WHERE path = ?1",
            "DELETE FROM vault_fts WHERE path = ?1",
            "DELETE FROM vault_files WHERE path = ?1",
        ] {
            conn.execute(sql, rusqlite::params![rel])?;
        }
        Ok(())
    })();
    match r {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// Full rescan: clear + walk + reindex every .md. Returns (notes, elapsed_ms).
pub fn full_scan(conn: &Connection, root: &Path) -> DbResult<(usize, u128)> {
    let started = std::time::Instant::now();
    let files = collect_note_paths(root);
    reset_index(conn)?;
    let mut n = 0;
    for rel in &files {
        reindex_file(conn, root, rel)?;
        n += 1;
    }
    // One global pass now that the whole file set is indexed: forward
    // references between notes scanned earlier in the walk resolve here.
    refresh_all_unresolved(conn)?;
    Ok((n, started.elapsed().as_millis()))
}

/// All .md paths under root (forward slashes), skipping dot directories.
pub fn collect_note_paths(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Keep the root itself, skip hidden/dot dirs (.obsidian, .git,
            // .trash, …) — the predicate must be TRUE to KEEP an entry.
            e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("md")) != Some(true)
        {
            continue;
        }
        if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"));
        }
    }
    out.sort();
    out
}

/// (basename WITHOUT extension, folder) — the vault_files.basename column
/// joins wikilink resolution, where names are extension-less.
fn split_rel(rel: &str) -> (String, String) {
    let (folder, full_base) = match rel.rsplit_once('/') {
        Some((f, b)) => (f.to_string(), b.to_string()),
        None => (String::new(), rel.to_string()),
    };
    let stem = match full_base.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => full_base,
    };
    (stem, folder)
}

fn ext_of(rel: &str) -> String {
    rel.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: Option<String>,
    pub basename: String,
    /// Body snippet with ⟨ ⟩ around matches.
    pub snippet: String,
}

/// Search params: plain text (FTS) + the Obsidian operator subset the
/// indexer can answer from its tables (`tag:` `path:` `file:` `-exclude`).
#[derive(Debug, Default)]
pub struct SearchParams {
    pub terms: Vec<String>,
    pub not: Vec<String>,
    pub tag: Option<String>,
    pub path: Option<String>,
    pub file: Option<String>,
}

fn search_token_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        // Alternatives, longest-first:
        //   1. -?op:"quoted value"   2. -?op:value
        //   3. -?"quoted phrase"     4. bare word
        regex::Regex::new(
            r#"(-)?(\w+):"([^"]*)"|(-)?(\w+):([^\s"]+)|(-)?"([^"]*)"|(-)?([^\s]+)"#,
        )
        .expect("search tokenizer regex")
    })
}

pub fn parse_search_query(q: &str) -> SearchParams {
    let mut p = SearchParams::default();
    let re = search_token_regex();
    for cap in re.captures_iter(q) {
        let (negate, op, value) = if let Some(o) = cap.get(2) {
            (cap.get(1).is_some(), Some(o.as_str()), cap.get(3).map(|m| m.as_str()))
        } else if let Some(o) = cap.get(5) {
            (cap.get(4).is_some(), Some(o.as_str()), cap.get(6).map(|m| m.as_str()))
        } else if cap.get(8).is_some() {
            (cap.get(7).is_some(), None, Some(cap.get(8).unwrap().as_str()))
        } else {
            (cap.get(9).is_some(), None, cap.get(10).map(|m| m.as_str()))
        };
        match (op, value) {
            (Some("tag"), Some(v)) if !negate => {
                p.tag = Some(v.trim_start_matches('#').to_string());
            }
            (Some("path"), Some(v)) if !negate => {
                p.path = Some(v.trim_matches('"').to_lowercase());
            }
            (Some("file"), Some(v)) if !negate => {
                p.file = Some(v.trim_matches('"').to_lowercase());
            }
            (Some(_), Some(v)) => {
                // Unknown operator: text term (kept whole, like Obsidian's
                // fallback for unrecognized `x:y`).
                let term = format!("{}:{v}", op.unwrap_or(""));
                if negate {
                    p.not.push(term.to_lowercase());
                } else {
                    p.terms.push(term);
                }
            }
            _ => {
                let Some(v) = value else { continue };
                if negate {
                    p.not.push(v.to_lowercase());
                } else {
                    p.terms.push(v.to_string());
                }
            }
        }
    }
    p
}

pub fn search(conn: &Connection, query: &str, limit: usize) -> DbResult<Vec<SearchHit>> {
    let params = parse_search_query(query);
    // FTS MATCH string: quoted terms AND'd (space-separated), NOT for exclusions.
    let mut match_q = String::new();
    for t in &params.terms {
        if !match_q.is_empty() {
            match_q.push(' ');
        }
        match_q.push_str(&format!("\"{}\"", t.replace('"', "\"\"")));
    }
    for t in &params.not {
        if match_q.is_empty() {
            // A lone exclusion filters nothing without positive terms —
            // match all rows (FTS5 empty query is invalid; use *).
            match_q.push('*');
        }
        match_q.push_str(&format!(" NOT \"{}\"", t.replace('"', "\"\"")));
    }

    let mut hits: Vec<(String, Option<String>, String, String, String)> = Vec::new(); // path,title,base,folder,snippet
    if match_q.is_empty() || match_q == "*" {
        let mut stmt = conn.prepare(
            "SELECT f.path, f.title, f.basename, f.folder, '' FROM vault_files f ORDER BY f.basename",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                String::new(),
            ))
        })?;
        for row in rows {
            hits.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT path, snippet(vault_fts, 2, '⟨', '⟩', '…', 24), '' , '', '' \
             FROM vault_fts WHERE vault_fts MATCH ?1 ORDER BY rank LIMIT 500",
        )?;
        let rows = stmt.query_map(rusqlite::params![match_q], |r| {
            Ok((
                r.get::<_, String>(0)?,
                None,
                String::new(),
                String::new(),
                r.get::<_, String>(1)?,
            ))
        })?;
        for row in rows {
            hits.push(row?);
        }
        // Fill title/basename/folder from vault_files.
        for h in hits.iter_mut() {
            if let Some((t, b, f)) = conn
                .query_row(
                    "SELECT title, basename, folder FROM vault_files WHERE path = ?1",
                    rusqlite::params![h.0],
                    |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
                )
                .optional()?
            {
                h.1 = t;
                h.2 = b;
                h.3 = f;
            }
        }
    }

    // Operator filters (post-FTS; the tables answer them exactly).
    let tag_rows: Vec<String> = if let Some(tag) = &params.tag {
        let mut stmt = conn.prepare("SELECT DISTINCT path FROM vault_tags WHERE tag = ?1")?;
        let rows = stmt.query_map(rusqlite::params![tag], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    } else {
        Vec::new()
    };
    let mut out = Vec::new();
    for (path, title, base, folder, snippet) in hits {
        if let Some(tag) = &params.tag {
            if !tag_rows.iter().any(|p| p == &path) {
                continue;
            }
            let _ = tag;
        }
        if let Some(p) = &params.path {
            if !path.to_lowercase().contains(p) && !folder.to_lowercase().contains(p) {
                continue;
            }
        }
        if let Some(f) = &params.file {
            if !base.to_lowercase().contains(f) && !path.to_lowercase().contains(f) {
                continue;
            }
        }
        out.push(SearchHit {
            path,
            title,
            basename: base,
            snippet,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Mention {
    pub src: String,
    pub line: i64,
    pub raw: String,
    pub is_embed: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteMeta {
    pub path: String,
    pub title: Option<String>,
    pub basename: String,
    pub backlinks: Vec<Mention>,
    pub unresolved_mentions: Vec<Mention>,
    pub outgoing: Vec<Mention>,
    pub tags: Vec<String>,
    pub headings: Vec<(i64, String, i64)>, // level, text, line
    pub aliases: Vec<String>,
    pub word_count: i64,
}

pub fn note_meta(conn: &Connection, path: &str) -> DbResult<NoteMeta> {
    let (title, basename, aliases_json, wc) = conn.query_row(
        "SELECT title, basename, aliases, word_count FROM vault_files WHERE path = ?1",
        rusqlite::params![path],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        },
    )
    .unwrap_or((None, path.to_string(), "[]".into(), 0));

    let mut backlinks = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT src, line, raw, is_embed FROM vault_links WHERE dest = ?1 ORDER BY src, line",
        )?;
        let rows = stmt.query_map(rusqlite::params![path], |r| {
            Ok(Mention {
                src: r.get(0)?,
                line: r.get(1)?,
                raw: r.get(2)?,
                is_embed: r.get::<_, i64>(3)? != 0,
            })
        })?;
        for row in rows {
            backlinks.push(row?);
        }
    }
    let mut unresolved_mentions = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT src, line, raw, is_embed FROM vault_links WHERE dest IS NULL AND src = ?1 ORDER BY line",
        )?;
        let rows = stmt.query_map(rusqlite::params![path], |r| {
            Ok(Mention {
                src: r.get(0)?,
                line: r.get(1)?,
                raw: r.get(2)?,
                is_embed: r.get::<_, i64>(3)? != 0,
            })
        })?;
        for row in rows {
            unresolved_mentions.push(row?);
        }
    }
    // Unresolved mentions FOR this note: links elsewhere that target its
    // basename but resolve to nothing (Obsidian's "unlinked mentions" are a
    // different thing — raw text occurrences; these are the graph-relevant
    // broken inbound links).
    let mut broken_inbound = Vec::new();
    {
        let basename = basename.to_lowercase();
        let mut stmt = conn.prepare(
            "SELECT src, line, raw, is_embed FROM vault_links WHERE dest IS NULL AND lower(raw) = ?1 ORDER BY src, line LIMIT 200",
        )?;
        let rows = stmt.query_map(rusqlite::params![basename], |r| {
            Ok(Mention {
                src: r.get(0)?,
                line: r.get(1)?,
                raw: r.get(2)?,
                is_embed: r.get::<_, i64>(3)? != 0,
            })
        })?;
        for row in rows {
            broken_inbound.push(row?);
        }
    }

    let mut outgoing = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(dest, raw), line, raw, is_embed FROM vault_links WHERE src = ?1 ORDER BY line",
        )?;
        let rows = stmt.query_map(rusqlite::params![path], |r| {
            Ok(Mention {
                src: r.get(0)?,
                line: r.get(1)?,
                raw: r.get(2)?,
                is_embed: r.get::<_, i64>(3)? != 0,
            })
        })?;
        for row in rows {
            outgoing.push(row?);
        }
    }
    let mut tags = Vec::new();
    {
        let mut stmt =
            conn.prepare("SELECT DISTINCT tag FROM vault_tags WHERE path = ?1 ORDER BY tag")?;
        let rows = stmt.query_map(rusqlite::params![path], |r| r.get::<_, String>(0))?;
        for row in rows {
            tags.push(row?);
        }
    }
    let mut headings = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT level, text, line FROM vault_headings WHERE path = ?1 ORDER BY line",
        )?;
        let rows =
            stmt.query_map(rusqlite::params![path], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })?;
        for row in rows {
            headings.push(row?);
        }
    }
    let aliases: Vec<String> = serde_json::from_str(&aliases_json).unwrap_or_default();
    Ok(NoteMeta {
        path: path.to_string(),
        title,
        basename,
        backlinks,
        unresolved_mentions: broken_inbound,
        outgoing,
        tags,
        headings,
        aliases,
        word_count: wc,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub unresolved: bool,
    pub degree: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphEdge {
    pub src: String,
    pub dst: String,
}

pub fn graph(
    conn: &Connection,
    include_unresolved: bool,
    include_attachments: bool,
) -> DbResult<(Vec<GraphNode>, Vec<GraphEdge>)> {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    if include_attachments {
        let mut stmt = conn.prepare(
            "SELECT path, COALESCE(title, basename), COALESCE(degree, 0) FROM (
               SELECT f.path, f.title, f.basename,
                 (SELECT COUNT(*) FROM vault_links l WHERE l.dest = f.path) AS degree
               FROM vault_files f
             ) ORDER BY path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphNode {
                id: r.get(0)?,
                label: r.get(1)?,
                unresolved: false,
                degree: r.get(2)?,
            })
        })?;
        for row in rows {
            nodes.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(
            "SELECT path, COALESCE(title, basename), COALESCE(degree, 0) FROM (
               SELECT f.path, f.title, f.basename,
                 (SELECT COUNT(*) FROM vault_links l WHERE l.dest = f.path) AS degree
               FROM vault_files f WHERE f.ext = 'md'
             ) ORDER BY path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphNode {
                id: r.get(0)?,
                label: r.get(1)?,
                unresolved: false,
                degree: r.get(2)?,
            })
        })?;
        for row in rows {
            nodes.push(row?);
        }
    }
    let mut stmt = conn.prepare(
        "SELECT src, dest FROM vault_links WHERE dest IS NOT NULL AND src <> dest",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(GraphEdge {
            src: r.get(0)?,
            dst: r.get(1)?,
        })
    })?;
    for row in rows {
        edges.push(row?);
    }
    if include_unresolved {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT raw FROM vault_links WHERE dest IS NULL AND raw <> ''",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            let raw = row?;
            nodes.push(GraphNode {
                id: format!("unresolved:{raw}"),
                label: raw.clone(),
                unresolved: true,
                degree: 0,
            });
        }
        let mut stmt = conn.prepare(
            "SELECT src, raw FROM vault_links WHERE dest IS NULL AND raw <> '' AND src <> raw",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GraphEdge {
                src: r.get(0)?,
                dst: format!("unresolved:{}", r.get::<_, String>(1)?),
            })
        })?;
        for row in rows {
            edges.push(row?);
        }
    }
    // Degrees recompute (edges added after the initial count).
    for e in &edges {
        for n in nodes.iter_mut() {
            if n.id == e.src || n.id == e.dst {
                n.degree += 1;
            }
        }
    }
    Ok((nodes, edges))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

pub fn all_tags(conn: &Connection) -> DbResult<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(DISTINCT path) AS c FROM vault_tags GROUP BY tag ORDER BY c DESC, tag",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount {
            tag: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn stats(conn: &Connection) -> DbResult<(i64, i64, i64, i64)> {
    let notes: i64 = conn.query_row("SELECT COUNT(*) FROM vault_files WHERE ext='md'", [], |r| r.get(0))?;
    let files: i64 = conn.query_row("SELECT COUNT(*) FROM vault_files", [], |r| r.get(0))?;
    let links: i64 = conn.query_row("SELECT COUNT(*) FROM vault_links WHERE dest IS NOT NULL", [], |r| r.get(0))?;
    let unresolved: i64 = conn.query_row("SELECT COUNT(DISTINCT raw) FROM vault_links WHERE dest IS NULL", [], |r| r.get(0))?;
    Ok((notes, files, links, unresolved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn write_vault(dir: &Path, files: &[(&str, &str)]) -> std::path::PathBuf {
        for (rel, content) in files {
            let p = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
        dir.to_path_buf()
    }

    #[test]
    fn reindex_and_query_roundtrip() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("vault-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Daily")).unwrap();
        let root = write_vault(
            &dir,
            &[
                ("Home.md", "# Home\nWelcome to [[Projects/Ideas]] and [[Ideas]].\n#life #meta"),
                ("Projects/Ideas.md", "---\naliases: [Brainstorms]\n---\n# Ideas\nback to [[Home]] and [[Missing Note]]\n^seed"),
            ],
        );
        assert!(reindex_file(&conn, &root, "Home.md").unwrap());
        assert!(reindex_file(&conn, &root, "Projects/Ideas.md").unwrap());

        // Files table
        let files = list_files(&conn).unwrap();
        assert_eq!(files.len(), 2);
        let home = files.iter().find(|f| f.path == "Home.md").unwrap();
        assert_eq!(home.basename, "Home");

        // Links resolved + unresolved
        let unresolved: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_links WHERE dest IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unresolved, 1, "Missing Note is the only unresolved link");

        // Backlinks of Ideas file include both spellings of Home.md
        let meta = note_meta(&conn, "Projects/Ideas.md").unwrap();
        assert_eq!(meta.backlinks.len(), 2);
        assert!(meta.tags.contains(&"life".to_string()) == false);
        let home_meta = note_meta(&conn, "Home.md").unwrap();
        assert!(home_meta.tags.contains(&"life".to_string()));
        assert!(home_meta.tags.contains(&"meta".to_string()));
        assert_eq!(home_meta.outgoing.len(), 2);

        // Ideas resolves via alias too
        let f = list_files(&conn).unwrap();
        assert_eq!(
            parse::resolve_link("Brainstorms", &f).as_deref(),
            Some("Projects/Ideas.md")
        );

        // Block id indexed
        let blocks: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_blocks WHERE path='Projects/Ideas.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blocks, 1);

        // FTS search
        let hits = search(&conn, "welcome", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Home.md");
        assert!(hits[0].snippet.contains('⟨'), "snippet marks the hit: {}", hits[0].snippet);

        // Operator search
        let hits = search(&conn, "tag:life", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Home.md");
        let hits = search(&conn, "path:Projects ideas", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Projects/Ideas.md");
        let hits = search(&conn, "welcome -nothing", 10).unwrap();
        assert_eq!(hits.len(), 1);

        // Graph
        let (nodes, edges) = graph(&conn, false, true).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(edges.len(), 3); // Home→Ideas x2, Ideas→Home
        let (nodes, _) = graph(&conn, true, true).unwrap();
        assert_eq!(nodes.len(), 3, "unresolved node included");

        // All tags
        let tags = all_tags(&conn).unwrap();
        assert!(tags.iter().any(|t| t.tag == "life"));

        // Removal
        remove_from_index(&conn, "Home.md").unwrap();
        let files = list_files(&conn).unwrap();
        assert_eq!(files.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_scan_and_rebuild() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("vault-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        let root = write_vault(
            &dir,
            &[
                ("A.md", "[[B]]"),
                ("sub/B.md", "[[A]]"),
                (".obsidian/Hidden.md", "[[A]]"),
            ],
        );
        let (n, _) = full_scan(&conn, &root).unwrap();
        assert_eq!(n, 2, "dot dirs skipped");
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_links WHERE dest IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(links, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_query_parsing() {
        let p = parse_search_query("hello \"two words\" tag:#work path:\"My Folder\" file:2026 -skipme");
        assert_eq!(p.terms, vec!["hello", "two words"]);
        assert_eq!(p.tag.as_deref(), Some("work"));
        assert_eq!(p.path.as_deref(), Some("my folder"));
        assert_eq!(p.file.as_deref(), Some("2026"));
        assert_eq!(p.not, vec!["skipme"]);
    }

    #[test]
    fn collect_paths_uses_forward_slashes() {
        let dir = std::env::temp_dir().join(format!("vault-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = write_vault(&dir, &[("a/b/C.md", "x")]);
        let paths = collect_note_paths(&root);
        assert_eq!(paths, vec!["a/b/C.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
