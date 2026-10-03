//! Vault index — SQLite tables over the vault's markdown files.
//!
//! The FILES on disk are the source of truth; every table here is a derived,
//! deletable cache (rebuild = full rescan). One row-set per note plus an
//! FTS5 body index. The same connection/`DbState` conventions apply: never
//! hold the DB mutex across file IO (the caller reads the file first, then
//! opens a transaction).

use std::path::Path;

use rusqlite::Connection;

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
    // Duplicate tag rows (same tag twice on one line, duplicated frontmatter
    // entries) are harmless to readers but would violate a unique constraint
    // — dedupe pre-existing rows first, then enforce uniqueness so
    // INSERT OR IGNORE in the indexer actually has something to ignore on.
    conn.execute_batch(
        "DELETE FROM vault_tags WHERE rowid NOT IN
           (SELECT MIN(rowid) FROM vault_tags GROUP BY tag, path, line, source);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_tags_unique
           ON vault_tags(tag, path, line, source);",
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

/// Everything read out of a note file before the (single-transaction) index
/// write. `parsed_ok` is false for binary/undecodable files, which stay
/// resolvable as unparsed rows.
struct NoteInput {
    parsed: ParsedNote,
    aliases: Vec<String>,
    fm_tags: Vec<String>,
    size: usize,
    /// Full text for the FTS row (empty for binary/undecodable files).
    body: String,
    meta: std::fs::Metadata,
    parsed_ok: bool,
}

/// Read + parse one note for indexing. `None` = the file is gone (the
/// caller drops its index rows). Read/decode problems degrade to an
/// unparsed row; this never fails. No DB access — safe to call without the
/// lock held (IO phase of the lock discipline).
fn read_for_index(root: &Path, rel: &str) -> Option<NoteInput> {
    let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let meta = match std::fs::metadata(&abs) {
        Ok(m) if m.is_file() => m,
        _ => return None,
    };
    Some(match std::fs::read_to_string(&abs) {
        Ok(content) => {
            let parsed = parse::parse_note(&content);
            NoteInput {
                aliases: parsed
                    .frontmatter
                    .as_ref()
                    .map(|f| f.get_list("aliases"))
                    .unwrap_or_default(),
                fm_tags: parsed
                    .frontmatter
                    .as_ref()
                    .map(|f| f.get_list("tags"))
                    .unwrap_or_default(),
                size: content.len(),
                body: content,
                meta,
                parsed_ok: true,
                parsed,
            }
        }
        Err(_) => NoteInput {
            parsed: ParsedNote::default(),
            aliases: Vec::new(),
            fm_tags: Vec::new(),
            size: 0,
            body: String::new(),
            meta,
            parsed_ok: false,
        },
    })
}

/// Write one note's rows in a single transaction. When `resolve` is false
/// (full-scan phase 1) links are stored unresolved — the whole-set pass at
/// the end of the scan resolves them against the COMPLETE file list, which
/// avoids an O(files) resolver snapshot per file and never mis-resolves an
/// ambiguous basename to whichever same-named file was indexed first.
fn index_note(
    conn: &Connection,
    rel: &str,
    input: &NoteInput,
    resolve: bool,
) -> DbResult<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> DbResult<()> {
        if input.parsed_ok {
            upsert_file_row_parsed(conn, rel, &input.parsed, &input.aliases, &input.size, &input.meta)?;
        } else {
            upsert_file_row(conn, rel, "", None, None, 0, &input.meta)?;
        }
        let files = if resolve { Some(list_files(conn)?) } else { None };
        conn.execute(
            "DELETE FROM vault_links WHERE src = ?1",
            rusqlite::params![rel],
        )?;
        for l in &input.parsed.links {
            let dest = files
                .as_deref()
                .and_then(|f| parse::resolve_link(l.linkpath(), f));
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
        for t in &input.parsed.tags {
            conn.execute(
                "INSERT OR IGNORE INTO vault_tags (tag, path, line, source) VALUES (?1, ?2, ?3, 'inline')",
                rusqlite::params![t.tag, rel, t.line as i64],
            )?;
        }
        for t in &input.fm_tags {
            conn.execute(
                "INSERT OR IGNORE INTO vault_tags (tag, path, line, source) VALUES (?1, ?2, -1, 'frontmatter')",
                rusqlite::params![t, rel],
            )?;
        }
        conn.execute(
            "DELETE FROM vault_headings WHERE path = ?1",
            rusqlite::params![rel],
        )?;
        for h in &input.parsed.headings {
            conn.execute(
                "INSERT INTO vault_headings (path, level, text, line) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![rel, h.level as i64, h.text, h.line as i64],
            )?;
        }
        conn.execute(
            "DELETE FROM vault_blocks WHERE path = ?1",
            rusqlite::params![rel],
        )?;
        for b in &input.parsed.blocks {
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
            rusqlite::params![rel, name, input.body],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            // A failed COMMIT must roll back: leaving the connection inside
            // an open transaction bricks every later statement on the
            // shared connection until restart.
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// (Re)index one note. Reads the file FIRST (no DB lock held across IO),
/// then upserts everything in one transaction. Missing file = removal.
/// The `&Connection` variant for callers that already hold the guard
/// (tests, single-connection contexts).
pub fn reindex_file(conn: &Connection, root: &Path, rel: &str) -> DbResult<bool> {
    match read_for_index(root, rel) {
        None => {
            remove_from_index(conn, rel)?;
            Ok(false)
        }
        Some(input) => {
            index_note(conn, rel, &input, true)?;
            let names = pending_names_for(conn, rel);
            refresh_unresolved_for(conn, &names)?;
            Ok(true)
        }
    }
}

/// Lock-disciplined variant over the shared connection mutex: file IO with
/// the lock released, each SQL phase under its own lock. This is what the
/// commands, the watcher and the chat tools use.
pub fn reindex_file_locked(db: &parking_lot::Mutex<Connection>, root: &Path, rel: &str) -> DbResult<bool> {
    let Some(input) = read_for_index(root, rel) else {
        let conn = db.lock();
        remove_from_index(&conn, rel)?;
        return Ok(false);
    };
    {
        let conn = db.lock();
        index_note(&conn, rel, &input, true)?;
    }
    let conn = db.lock();
    let names = pending_names_for(&conn, rel);
    refresh_unresolved_for(&conn, &names)?;
    Ok(true)
}

/// The raw spellings a pending link can use to reach this file (stemmed
/// path, basename, dotted spelling, aliases) — all lowercased for matching.
fn pending_names_for(conn: &Connection, rel: &str) -> Vec<String> {
    let (base, _folder) = split_rel(rel);
    let mut names = vec![base.to_lowercase()];
    let lower = rel.to_lowercase();
    let stem = lower.strip_suffix(".md").unwrap_or(&lower).to_string();
    if !names.contains(&stem) {
        names.push(stem.clone());
    }
    // Wikilinks may spell the target WITH its extension (`[[Note.md]]`),
    // stored raw as the dotted form — neither the stem nor the basename
    // matches that, so add it explicitly or those pending links stay
    // unresolved until a full rescan.
    let dotted = format!("{stem}.md");
    if !names.contains(&dotted) {
        names.push(dotted);
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

/// Escape SQL LIKE wildcards so an alias like `100%_done` matches literally
/// instead of as a pattern.
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Re-resolve dest=NULL links whose raw target matches one of `names`
/// (exact, or ending in `/<name>` for folder-qualified spellings).
pub fn refresh_unresolved_for(conn: &Connection, names: &[String]) -> DbResult<usize> {
    let files = list_files(conn)?;
    let mut resolved = 0;
    for name in names {
        if name.is_empty() {
            continue;
        }
        let mut stmt = conn.prepare(
            "SELECT rowid, raw FROM vault_links WHERE dest IS NULL AND (lower(raw) = ?1 OR lower(raw) LIKE '%/' || ?2 ESCAPE '\\')",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map(rusqlite::params![name, like_escape(name)], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
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
    // Resolve the ACTUAL stored spelling first: paths arrive from callers
    // that may case them differently (Windows paths are case-insensitive —
    // e.g. a case-only rename must drop the old-cased row, not orphan it).
    // Exact match wins when two case-variant files coexist (Linux).
    let actual: String = conn
        .query_row(
            "SELECT path FROM vault_files WHERE lower(path) = lower(?1) ORDER BY (path = ?1) DESC LIMIT 1",
            rusqlite::params![rel],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| rel.to_string());
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let r = (|| -> DbResult<()> {
        // Inbound links to a deleted note become unresolved (graph keeps the
        // hollow node), exactly like Obsidian.
        conn.execute("UPDATE vault_links SET dest = NULL WHERE dest = ?1", rusqlite::params![actual])?;
        for sql in [
            "DELETE FROM vault_links WHERE src = ?1",
            "DELETE FROM vault_tags WHERE path = ?1",
            "DELETE FROM vault_headings WHERE path = ?1",
            "DELETE FROM vault_blocks WHERE path = ?1",
            "DELETE FROM vault_fts WHERE path = ?1",
            "DELETE FROM vault_files WHERE path = ?1",
        ] {
            conn.execute(sql, rusqlite::params![actual])?;
        }
        Ok(())
    })();
    match r {
        Ok(()) => {
            // Same rule as index_note: a failed COMMIT leaves the shared
            // connection in an open transaction — roll it back.
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// Full rescan: clear + walk + reindex every .md. Returns (notes, elapsed_ms).
/// Takes the connection MUTEX (not a held guard): file IO runs unlocked and
/// each write phase takes the lock, so a long scan never freezes other DB
/// users (chat persistence etc.) for its whole duration.
pub fn full_scan(db: &parking_lot::Mutex<Connection>, root: &Path) -> DbResult<(usize, u128)> {
    let started = std::time::Instant::now();
    super::sweep_stale_tmp(root);
    let files = collect_note_paths(root);
    {
        let conn = db.lock();
        reset_index(&conn)?;
    }
    // Two phases: write every file's rows with links UNresolved (no per-file
    // resolver snapshot — O(files) once instead of O(files²) over the scan;
    // a name ambiguous in the full vault must not resolve to whichever
    // same-basename file happened to be indexed first), then one whole-set
    // resolution pass now that every file is in the index.
    let mut n = 0;
    for rel in &files {
        if let Some(input) = read_for_index(root, rel) {
            let conn = db.lock();
            index_note(&conn, rel, &input, false)?;
            n += 1;
        }
    }
    let conn = db.lock();
    refresh_all_unresolved(&conn)?;
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

/// Upper bound on rows any single `search` candidate query may materialize.
///
/// `search` post-filters its candidates (exclusions, tag, path, file), so it
/// needs an over-fetch — but an unbounded one turns a narrow query into a full
/// index read held under the global DB mutex.
const MAX_CANDIDATE_ROWS: usize = 2000;

pub fn search(conn: &Connection, query: &str, limit: usize) -> DbResult<Vec<SearchHit>> {
    let params = parse_search_query(query);
    // FTS MATCH string: positive terms only, quoted and AND'd. Exclusions
    // are applied afterwards as a set difference — with no positive terms a
    // lone `-word` must still return everything else, and there is no
    // match-all expression in FTS5 syntax to hang `NOT` off (a bare `*` is
    // a syntax error), so `NOT` in the MATCH string can't express it.
    let mut match_q = String::new();
    for t in &params.terms {
        if !match_q.is_empty() {
            match_q.push(' ');
        }
        match_q.push_str(&format!("\"{}\"", t.replace('"', "\"\"")));
    }
    // Paths of files whose body matches any excluded term (empty when none).
    // Each excluded term costs a full FTS scan, and the result is only ever
    // used as a membership set against `hits` — so cap the set rather than
    // letting N exclusions each materialize an unbounded path list.
    let mut excluded: Vec<String> = Vec::new();
    if !params.not.is_empty() {
        for t in &params.not {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT path FROM vault_fts WHERE vault_fts MATCH ?1 LIMIT ?2",
            )?;
            let rows = stmt.query_map(
                rusqlite::params![
                    format!("\"{}\"", t.replace('"', "\"\"")),
                    MAX_CANDIDATE_ROWS as i64
                ],
                |r| r.get::<_, String>(0),
            )?;
            for r in rows {
                excluded.push(r?);
            }
        }
    }

    // Post-filtering (exclusions, tag, path, file) happens after the rows are
    // collected, so the candidate set is an over-fetch — but it must stay a
    // BOUNDED over-fetch. The empty-MATCH branch below has no FTS clause, so
    // it is the one query in `search` that can otherwise read the entire
    // vault into memory (under the global DB mutex) to return a handful of
    // hits: reachable from the UI with a lone `-word`, `tag:work`, or `#`.
    let scan_cap = limit.saturating_mul(20).clamp(limit, MAX_CANDIDATE_ROWS);
    let mut hits: Vec<(String, Option<String>, String, String, String)> = Vec::new(); // path,title,base,folder,snippet
    if match_q.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT f.path, f.title, f.basename, f.folder, '' FROM vault_files f \
             ORDER BY f.basename LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![scan_cap as i64], |r| {
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
        // LEFT JOIN pulls title/basename/folder in the same query — no
        // per-hit lookup loop. A hit missing from vault_files keeps the
        // same shape the old fill pass left (NULL title, empty base/folder).
        let mut stmt = conn.prepare(
            "SELECT f.path, f.title, f.basename, f.folder, \
             snippet(vault_fts, 2, '⟨', '⟩', '…', 24) \
             FROM vault_fts LEFT JOIN vault_files f ON f.path = vault_fts.path \
             WHERE vault_fts MATCH ?1 ORDER BY rank LIMIT 500",
        )?;
        let rows = stmt.query_map(rusqlite::params![match_q], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            hits.push(row?);
        }
    }

    // Operator filters (post-FTS; the tables answer them exactly).
    let tag_rows: Vec<String> = if let Some(tag) = &params.tag {
        // NOCASE: tags are stored as typed (`#Life` keeps its case) but
        // Obsidian tag matching is case-insensitive.
        let mut stmt =
            conn.prepare("SELECT DISTINCT path FROM vault_tags WHERE tag = ?1 COLLATE NOCASE")?;
        let rows = stmt.query_map(rusqlite::params![tag], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    } else {
        Vec::new()
    };
    let mut out = Vec::new();
    for (path, title, base, folder, snippet) in hits {
        if !excluded.is_empty() && excluded.iter().any(|p| p == &path) {
            continue;
        }
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
    /// Filesystem timestamps (unix epoch ms), None when the OS doesn't provide them.
    pub created_ms: Option<u64>,
    pub modified_ms: Option<u64>,
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
        created_ms: None,
        modified_ms: None,
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
    // Degrees recompute (edges added after the initial count): one pass over
    // the edges into a count map, then applied to the nodes — no edges ×
    // nodes scan.
    let mut degrees: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for e in &edges {
        *degrees.entry(e.src.clone()).or_insert(0) += 1;
        *degrees.entry(e.dst.clone()).or_insert(0) += 1;
    }
    for n in nodes.iter_mut() {
        if let Some(d) = degrees.get(&n.id) {
            n.degree += d;
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
        let conn = parking_lot::Mutex::new(Connection::open_in_memory().unwrap());
        ensure_schema(&conn.lock()).unwrap();
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
            .lock()
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
    fn lone_exclusion_search_lists_everything_else() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("vault-excl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = write_vault(
            &dir,
            &[("A.md", "welcome here"), ("B.md", "other words"), ("C.md", "more words")],
        );
        for rel in ["A.md", "B.md", "C.md"] {
            reindex_file(&conn, &root, rel).unwrap();
        }
        // A bare `*` is invalid FTS5 — a lone `-term` must still work.
        let hits = search(&conn, "-welcome", 10).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["B.md", "C.md"]);
        // Mixed query keeps the AND NOT semantics.
        let hits = search(&conn, "words -other", 10).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["C.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tag_search_is_case_insensitive() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("vault-tagcase-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = write_vault(&dir, &[("A.md", "#Life and #life twice #life")]);
        reindex_file(&conn, &root, "A.md").unwrap();
        for q in ["tag:life", "tag:Life", "tag:LIFE"] {
            let hits = search(&conn, q, 10).unwrap();
            assert_eq!(hits.len(), 1, "query {q}");
        }
        // The duplicate `#life` on one line collapses via the unique index
        // (INSERT OR IGNORE); the differently-cased `#Life` is kept.
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_tags WHERE path='A.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wikilink_spelled_with_extension_resolves_without_rescan() {
        let conn = mem();
        let dir = std::env::temp_dir().join(format!("vault-dotted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = write_vault(&dir, &[("A.md", "see [[Projects/B.md]]")]);
        reindex_file(&conn, &root, "A.md").unwrap();
        let unresolved: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_links WHERE dest IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unresolved, 1);
        // B appears later; its (re)index must resolve A's dotted spelling.
        std::fs::create_dir_all(dir.join("Projects")).unwrap();
        std::fs::write(dir.join("Projects").join("B.md"), "# B").unwrap();
        reindex_file(&conn, &root, "Projects/B.md").unwrap();
        let unresolved: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_links WHERE dest IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unresolved, 0, "dotted raw resolves via pending-name refresh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_scan_resolves_ambiguous_basenames_against_the_full_set() {
        let conn = parking_lot::Mutex::new(Connection::open_in_memory().unwrap());
        ensure_schema(&conn.lock()).unwrap();
        let dir = std::env::temp_dir().join(format!("vault-ambig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = write_vault(
            &dir,
            &[
                ("Deep/Note.md", "deep note"),
                ("Zet.md", "links to [[Note]]"),
                ("Note.md", "root note"),
            ],
        );
        let (n, _) = full_scan(&conn, &root).unwrap();
        assert_eq!(n, 3);
        // Walk order indexes Deep/Note.md before Note.md — resolution happens
        // against the complete set, so the shortest path wins.
        let dest: Option<String> = conn
            .lock()
            .query_row(
                "SELECT dest FROM vault_links WHERE src='Zet.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dest.as_deref(), Some("Note.md"));
        let _ = std::fs::remove_dir_all(&dir);
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
