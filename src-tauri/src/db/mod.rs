//! SQLite persistence layer (PRD §6.3 + CONTRACT.md).
//!
//! The DB lives at `<app_data_dir>/relay.db`. All query functions take a
//! `&Connection` so they can be unit-tested against an in-memory database
//! (`:memory:`) — the app itself holds one shared connection behind a mutex.
//!
//! Why SQLite for this data and not JSON: sessions/cost events need querying
//! (search, filtering, cost rollups) per PRD §6.1.

mod artifacts;
pub(crate) mod automations;
mod chat;
mod checkpoints;
mod connector_credentials;
mod cost;
mod cost_v2;
pub(crate) mod subagents;
pub mod docs;
#[cfg(test)]
mod docs_eval;
pub mod improve;
mod memory;
mod projects;
mod research_cache;
pub mod llm_log;
pub(crate) mod session_fabric;
mod secrets;
mod settings;
mod skills;
mod source_ledger;
mod wiki;
mod workspaces;

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use uuid::Uuid;

pub type DbResult<T> = Result<T, rusqlite::Error>;

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- Shared FTS5 / LIKE query sanitization ----
//
// Five modules used to carry private copies of these helpers with drifting
// semantics and copy-pasted "same discipline as…" comments (audit M: FTS
// DRY). One home: a sanitizer bug fixed here now reaches every FTS surface.

/// Term shaping for [`fts_prefix_query`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FtsTerms {
    /// Alphanumeric-only terms, OR-joined — docs/wiki/memories keyword legs
    /// (bm25 ranks docs matching more terms higher; AND was too strict for
    /// the judge's comparison fetch).
    OrAlnum,
    /// Alphanumeric + underscore terms, space-joined (FTS5 implicit AND) —
    /// chat message content, where snake_case identifiers are meaningful.
    AndWord,
}

/// Build an FTS5 MATCH expression from a bare user query: terms stripped to
/// their safe charset, double-quoted (quoted strings are never parsed as
/// operators) with a trailing `*` prefix marker — "stream" also hits
/// "streaming". Returns None when nothing searchable remains (the caller
/// skips the FTS leg).
pub(crate) fn fts_prefix_query(query: &str, terms: FtsTerms) -> Option<String> {
    let keep = |c: char| {
        if matches!(terms, FtsTerms::AndWord) {
            c.is_alphanumeric() || c == '_'
        } else {
            c.is_alphanumeric()
        }
    };
    let joiner = match terms {
        FtsTerms::OrAlnum => " OR ",
        FtsTerms::AndWord => " ",
    };
    let safe: String = query
        .split_whitespace()
        .map(|t| t.chars().filter(|c| keep(*c)).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(joiner);
    if safe.is_empty() {
        None
    } else {
        Some(safe)
    }
}

/// Escape LIKE wildcards (`\`, `%`, `_`) for a pattern used with
/// `ESCAPE '\'` — a raw `%`/`_` in user input acted as a wildcard and swept
/// every row into the result. Wrap with `format!("%{escaped}%")` (contains)
/// or `format!("{escaped}%")` (prefix) at the call site.
pub(crate) fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Open (or create) the on-disk database and ensure the schema exists.
pub fn open(path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// Absolute path of the chat database. Defaults to `<app data dir>/relay.db` —
/// overridable via the `storage.dbDir` setting (Settings → Data), which must
/// be read from the CURRENT database before a move.
pub fn chat_db_path(app: &tauri::AppHandle) -> std::io::Result<std::path::PathBuf> {
    Ok(resolve_db_path(&crate::user_dirs::app_data_dir(app)))
}

/// The DB file to use inside `dir`: `relay.db` for fresh setups, the
/// pre-rebrand `conduit.db` when that is the only one present (existing
/// installs keep their history without a move). Must be used by EVERY
/// resolver (GUI + headless automation binary) so both never disagree.
pub fn db_file_in(dir: &std::path::Path) -> std::path::PathBuf {
    let new = dir.join("relay.db");
    if new.exists() || !dir.join("conduit.db").exists() {
        new
    } else {
        dir.join("conduit.db")
    }
}

/// Pure core of [`chat_db_path`]: resolve the DB path given the DEFAULT app
/// data dir. Public so the headless automation binary (which has no
/// AppHandle) resolves the SAME database as the GUI — it used to hardcode
/// the default location and silently read a stale/empty DB whenever
/// `storage.dbDir` was set (B-27).
pub fn resolve_db_path(default_dir: &std::path::Path) -> std::path::PathBuf {
    let default = db_file_in(default_dir);
    // The setting lives IN the DB, so resolve it by peeking at the default
    // location's DB (which always exists — it's created at first launch).
    if let Ok(conn) = Connection::open(&default) {
        if let Ok(Some(dir)) = settings::get_setting(&conn, "storage.dbDir") {
            let dir = dir.trim();
            if !dir.is_empty() {
                return db_file_in(&std::path::PathBuf::from(dir));
            }
        }
    }
    default
}

/// One-time cleanup for rows written before the \\?\ prefix fix: early
/// versions stored canonicalized `\\?\D:\...` project paths, which cmd.exe
/// cannot use as a working directory. Rewriting in place keeps the row ids
/// (and their sessions) intact. No-op on POSIX.
///
/// `doc_corpora` joined late (2026-09-30): Knowledge corpora kept storing
/// the verbatim prefix, which the Knowledge panel showed verbatim
/// (`\\?\D:\projects\...`) — the visible symptom of "added a corpus, RAG
/// does nothing" (the rows read as foreign; indexing itself tolerated both
/// shapes). The `NOT LIKE '\\?\UNC\%'` guard keeps network-share paths out:
/// `SUBSTR` would mangle `\\?\UNC\s` into `UNC\s`.
#[cfg(windows)]
fn migrate_unc_paths(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        r"
        UPDATE projects SET path = SUBSTR(path, 5) WHERE path LIKE '\\?\%';
        UPDATE sessions SET worktree_path = SUBSTR(worktree_path, 5)
          WHERE worktree_path LIKE '\\?\%';
        UPDATE doc_corpora SET path = SUBSTR(path, 5)
          WHERE path LIKE '\\?\%' AND path NOT LIKE '\\?\UNC\%';
        ",
    )?;
    Ok(())
}

/// One-time backfill for databases created before the FTS index existed.
/// The FTS table is external-content, so a plain scan of it reads the CONTENT
/// table and can't reveal whether the index is populated — compare row counts
/// against the `docsize` shadow table (one row per indexed document) instead.
/// On mismatch, `rebuild` re-reads chat_messages; when in sync this is a no-op.
/// Memory reflection flag (MEMORY_DESIGN_ARCHITECTURE.md §8.4): databases
/// created in the first memory iteration predate the `reflected` column.
fn migrate_memory_reflected(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE memories ADD COLUMN reflected INTEGER NOT NULL DEFAULT 0";
    if let Err(e) = conn.execute(sql, []) {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Databases created during the self-improving-artifacts P0/P1 iterations
/// predate the per-artifact autonomy tier (P2 — §9.2).
fn migrate_improve_autonomy(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE improve_artifacts ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'manual'";
    if let Err(e) = conn.execute(sql, []) {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Q4 decision: automation_runs stays the source of truth; the improve
/// registry link column mirrors each run into the self-improvement loop.
fn migrate_automation_runs_improve_link(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE automation_runs ADD COLUMN improve_run_id TEXT REFERENCES improve_runs(id) ON DELETE SET NULL";
    if let Err(e) = conn.execute(sql, []) {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// P3 flaky-case quarantine: a case whose outcome flips across identical
/// eval runs is parked (excluded from gating + pack health) instead of
/// being allowed to veto candidates. Manual un-quarantine via the panel.
fn migrate_improve_case_quarantine(conn: &Connection) -> DbResult<()> {
    for sql in [
        "ALTER TABLE improve_eval_cases ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE improve_eval_cases ADD COLUMN quarantine_reason TEXT NOT NULL DEFAULT ''",
    ] {
        if let Err(e) = conn.execute(sql, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// P3 cost attribution: the throwaway chat sessions the engine creates for
/// proposer/judge/case turns are recorded on the eval run, so their token +
/// cost spend attributes back to the artifact (join → chat_messages).
fn migrate_improve_eval_runs_session(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE improve_eval_runs ADD COLUMN chat_session_id TEXT";
    if let Err(e) = conn.execute(sql, []) {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Tag who authored each automation ("user" form vs "agent" chat tool) —
/// the Automations view badges agent-authored rows (see
/// fix/execution-gates: runs are full-auto by design, so authorship must be
/// visible).
fn migrate_automations_origin(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE automations ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'";
    if let Err(e) = conn.execute(sql, []) {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Trigger engine per automation row ("cron" | "webhook" | "file" | "git" |
/// "gmail") plus its JSON config and dedupe/last-fire state. Existing rows
/// keep firing on cron unchanged (default 'cron'); see automation_triggers.rs.
/// `last_event_run_at` is the event-source analogue of `last_run_at` — event
/// runs advance it INSTEAD of `last_run_at` so they never delay the cron
/// clock (next_fire computes from last_run_at).
fn migrate_automations_triggers(conn: &Connection) -> DbResult<()> {
    for sql in [
        "ALTER TABLE automations ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'cron'",
        "ALTER TABLE automations ADD COLUMN trigger_config TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE automations ADD COLUMN last_trigger_state TEXT",
        "ALTER TABLE automations ADD COLUMN last_event_run_at INTEGER",
    ] {
        if let Err(e) = conn.execute(sql, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

fn migrate_chat_fts(conn: &Connection) -> DbResult<()> {
    // LOW: the docsize COUNT probe is O(chat_messages) on every startup.
    // The FTS triggers keep the index in sync after the one-time backfill,
    // so once a rebuild/check has observably COMPLETED, a persisted marker
    // (B-30 pattern) skips the probe entirely. A drifted/restored DB can be
    // re-checked by clearing the `db.migration.chat_fts.synced` marker.
    ensure_settings_table(conn);
    let checked = settings::get_setting(conn, "db.migration.chat_fts.synced")
        .ok()
        .flatten()
        .as_deref()
        == Some("1");
    if checked {
        return Ok(());
    }
    let in_sync = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM chat_messages)
                   = (SELECT COUNT(*) FROM chat_messages_fts_docsize)",
            [],
            |r| r.get::<_, bool>(0),
        )
        .ok();
    if in_sync != Some(true) {
        conn.execute_batch("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild');")?;
    }
    settings::set_setting(conn, "db.migration.chat_fts.synced", "1")?;
    Ok(())
}

/// One-time backfill of `doc_chunks_fts` (hybrid doc search's keyword leg),
/// for databases whose doc_chunks rows predate the index. Same external-content
/// detection + marker pattern as `migrate_chat_fts` above: the FTS table is
/// external-content, so compare row counts against the `docsize` shadow table
/// and `rebuild` (re-reading doc_chunks) on mismatch. Clear the
/// `db.migration.doc_chunks_fts.synced` marker to re-check a drifted DB.
fn migrate_doc_chunks_fts(conn: &Connection) -> DbResult<()> {
    ensure_settings_table(conn);
    let checked = settings::get_setting(conn, "db.migration.doc_chunks_fts.synced")
        .ok()
        .flatten()
        .as_deref()
        == Some("1");
    if checked {
        return Ok(());
    }
    let in_sync = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM doc_chunks)
                   = (SELECT COUNT(*) FROM doc_chunks_fts_docsize)",
            [],
            |r| r.get::<_, bool>(0),
        )
        .ok();
    if in_sync != Some(true) {
        conn.execute_batch("INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('rebuild');")?;
    }
    settings::set_setting(conn, "db.migration.doc_chunks_fts.synced", "1")?;
    Ok(())
}

/// Add the `heading` column to `doc_chunks` (hybrid-RAG contextual
/// enrichment): the markdown heading trail at the chunk's start, written by
/// the indexer. `''` for chunks before any heading and for non-markdown
/// files. Since chunk-schema v2 the trail (plus the rel path) is also part
/// of the embedder input; the column keeps serving display.
fn migrate_doc_chunks_heading(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE doc_chunks ADD COLUMN heading TEXT NOT NULL DEFAULT ''";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `chunk_version` column to `doc_corpora` (corpus schema versioning).
/// 0 = pre-versioning (or never indexed); the indexer stamps
/// DOCS_CHUNK_SCHEMA_VERSION (db/docs.rs) after a successful pass and
/// re-chunks every file while the stored value lags — that is how enrichment
/// metadata and the FTS backfill reach old corpora despite the mtime/size
/// diff seeing no file changes.
fn migrate_doc_corpora_chunk_version(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE doc_corpora ADD COLUMN chunk_version INTEGER NOT NULL DEFAULT 0";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Provenance of a session's `harness_session_id` — how the id was obtained.
/// A disk probe is a heuristic (see `harness_adapters::session_claims`): when
/// two panes share a cwd the id may be a best-effort pick, and the UI should
/// say so rather than present a guessed id as a confirmed one. Rows predating
/// this column were all captured the same way, so they default to
/// `disk_probe`, the coarser of the two sources.
fn migrate_sessions_harness_id_source(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE sessions ADD COLUMN harness_session_id_source TEXT NOT NULL DEFAULT 'disk_probe'";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn migrate_unc_paths(_conn: &Connection) -> DbResult<()> {
    Ok(())
}

pub fn configure(conn: &Connection) -> DbResult<()> {
    // WAL + NORMAL sync: durable enough that a crash loses at most the last
    // few seconds of metadata (PRD §8 data durability) without fsync-per-write.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // 5-second busy timeout so concurrent readers (cost dashboard, settings)
    // don't immediately fail when a write transaction is active.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    // The registry shipped as `crew_agents`/`crew_runs` and is `subagents`/
    // `subagent_runs` now. This MUST run before init_schema: init_schema's
    // `CREATE TABLE IF NOT EXISTS subagents` would otherwise create a fresh
    // empty table beside a legacy `crew_agents`, and the rename below would
    // die on the name collision (a real dead-on-start crash, 2026-09-30).
    // SQLite rewrites REFERENCES clauses in other tables on rename, so
    // chat_sessions.agent_def_id keeps pointing at the same rows.
    migrate_crew_tables_rename(conn)?;
    init_schema(conn)?;
    migrate_chat_session_flags(conn)?;
    migrate_chat_session_watch_mode(conn)?;
    migrate_chat_session_auto(conn)?;
    migrate_chat_session_agent(conn)?;
    migrate_chat_session_project_id(conn)?;
    migrate_chat_session_permission_mode(conn)?;
    migrate_chat_session_policies(conn)?;
    migrate_chat_session_worktree(conn)?;
    migrate_chat_session_effort(conn)?;
    migrate_chat_session_cwd_override(conn)?;
    migrate_artifacts_message_id(conn)?;
    migrate_chat_messages_superseded(conn)?;
    migrate_cost_v2(conn)?;
    migrate_source_notes_metadata(conn)?;
    migrate_chat_messages_v2(conn)?;
    migrate_chat_messages_started_completed(conn)?;
    migrate_chat_messages_perf(conn)?;
    migrate_improve_autonomy(conn)?;
    migrate_automation_runs_improve_link(conn)?;
    migrate_improve_case_quarantine(conn)?;
    migrate_improve_eval_runs_session(conn)?;
    migrate_automations_origin(conn)?;
    migrate_automations_triggers(conn)?;
    migrate_chat_fts(conn)?;
    migrate_doc_chunks_fts(conn)?;
    llm_log::ensure_schema(conn)?;
    migrate_memory_reflected(conn)?;
    migrate_chat_message_kind(conn)?;
    migrate_chat_session_origin(conn)?;
    migrate_doc_chunks_heading(conn)?;
    migrate_doc_corpora_chunk_version(conn)?;
    // Provenance of a session's harness id (output scrape vs on-disk probe) —
    // the UI flags a low-confidence id instead of presenting it as fact.
    migrate_sessions_harness_id_source(conn)?;
    // Declarative subagents: the 7 builtin roles must exist in the registry
    // before any spawn surface resolves a name against it.
    migrate_subagents_seed(conn)?;
    // Who authored each definition (NULL = user, "agent" = a model made it
    // through the subagent chat tool) — display-only, badge in the Subagent panel.
    migrate_subagents_origin(conn)?;
    // The `.md` a definition was imported from (CLI harness native stores) —
    // what makes that import an upsert instead of a copy.
    migrate_subagents_source_path(conn)?;
    // And subagent-run sessions point at their definition through a real column —
    // NOT the `origin` vocabulary (spawned_by: drives the depth walk there).
    migrate_chat_session_agent_def(conn)?;
    // Research caches grow without bound otherwise: drop rows past their TTL
    // on every open (research_cache.rs also purges on insert).
    research_cache::purge_expired(conn)?;
    migrate_unc_paths(conn)
}

/// The registry tables shipped as `crew_agents`/`crew_runs`; the feature is
/// "subagents" now. Renames both on databases that predate the rename (fresh
/// DBs create the new names directly in `init_schema`, so this no-ops). The
/// old-named indexes die here; `init_schema` recreates them under the new
/// names.
fn migrate_crew_tables_rename(conn: &Connection) -> DbResult<()> {
    let table_exists = |name: &str| -> DbResult<bool> {
        Ok(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
                |r| r.get::<_, i64>(0),
            )? > 0,
        )
    };
    let row_count = |name: &str| -> DbResult<i64> {
        Ok(conn.query_row(&format!("SELECT COUNT(*) FROM {name}"), [], |r| {
            r.get::<_, i64>(0)
        })?)
    };
    // A crashed first boot after the rename could leave BOTH tables on disk:
    // init_schema created the fresh empty `subagents` before the old code
    // reached the rename. The fresh table is empty by construction (the
    // builtin seed runs after this migration), so drop it and rename the
    // legacy table into place — the legacy table carries the user's rows AND
    // the FK references from chat_sessions, which the rename rewrites.
    if table_exists("crew_agents")? {
        if table_exists("subagents")? {
            if row_count("subagents")? == 0 {
                conn.execute("DROP TABLE subagents", [])?;
            }
        }
        if !table_exists("subagents")? {
            conn.execute("ALTER TABLE crew_agents RENAME TO subagents", [])?;
            conn.execute("DROP INDEX IF EXISTS idx_crew_agents_builtin", [])?;
        }
    }
    if table_exists("crew_runs")? {
        if table_exists("subagent_runs")? {
            if row_count("subagent_runs")? == 0 {
                conn.execute("DROP TABLE subagent_runs", [])?;
            }
        }
        if !table_exists("subagent_runs")? {
            conn.execute("ALTER TABLE crew_runs RENAME TO subagent_runs", [])?;
            conn.execute("DROP INDEX IF EXISTS idx_crew_runs_agent", [])?;
        }
    }
    Ok(())
}

/// Authorship marker for subagent definitions (NULL = user, "agent" = a model
/// created it via the subagent chat tool) — display-only, badged in the panel.
fn migrate_subagents_origin(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE subagents ADD COLUMN origin TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// The `.md` a definition was imported from, when it came from a CLI harness's
/// own store (`~/.claude/agents/doc-writer.md` and friends). NULL for every
/// hand-made and builtin row.
///
/// This is what turns the native-store import from a copy into a LINK: the
/// upsert keys on this path, so editing the `.md` updates the row in place
/// instead of producing a second `-2` agent. Deliberately NOT part of
/// `SubagentInput` — the editor round-trips `SubagentInput`, and
/// `db::update_subagent` simply doesn't name this column, so saving a linked
/// agent from the panel keeps the link without the form knowing it exists.
///
/// NOCASE on the index: the app runs on Windows and macOS, where `Doc.md` and
/// `doc.md` are the same file, and a case-sensitive unique index would let the
/// same file claim two rows.
fn migrate_subagents_source_path(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE subagents ADD COLUMN source_path TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_subagents_source_path \
         ON subagents(source_path) WHERE source_path IS NOT NULL",
        [],
    )?;
    Ok(())
}

/// Subagent-run sessions point at their definition through a real column, not the
/// `origin` vocabulary: `spawned_by:` there is load-bearing (the mesh depth
/// walk parses it), so `agent_def_id` carries the identity instead. Nullable
/// FK with ON DELETE SET NULL (mirrors `project_id`): deleting a definition
/// never deletes the sessions that ran it.
fn migrate_chat_session_agent_def(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN agent_def_id TEXT REFERENCES subagents(id) ON DELETE SET NULL";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `origin` column to `chat_sessions` (Session Mesh): NULL for
/// human-created chats, `spawned_by:<chat_id>` for a session an agent spawned,
/// `automation:<id>` for automation run-logs. Drives the spawn-tree depth
/// guard and the sidebar origin tag.
fn migrate_chat_session_origin(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN origin TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `kind` column to `chat_messages` and backfill legacy command-only
/// rows. `kind = 'artifact_command'` marks the timeline rows the /create
/// artifact flow persists as proposal-card anchors: real display events whose
/// work runs OUT-OF-BAND (through the artifact generator, not an LLM chat
/// turn). `list_active_chat_messages` — the rows every context builder feeds
/// to the model — must exclude them, or the model keeps seeing an
/// unfulfilled "create X" instruction and re-executes it on the next send.
/// Rows created before the column existed are backfilled by their
/// `/create ` content prefix (the artifact flow is the only writer of
/// command-only rows). B-30: the backfill is gated on a persisted marker —
/// it used to re-run on EVERY startup, re-stamping any later real user
/// message that merely starts with "/create " (hiding it from the model's
/// context) instead of only the pre-migration legacy rows.
fn migrate_chat_message_kind(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_messages ADD COLUMN kind TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    ensure_settings_table(conn);
    let backfill_done = settings::get_setting(conn, "db.migration.chat_message_kind.backfilled")
        .ok()
        .flatten()
        .is_some();
    if !backfill_done {
        conn.execute(
            "UPDATE chat_messages SET kind = 'artifact_command'
              WHERE kind IS NULL AND role = 'user' AND content LIKE '/create %'",
            [],
        )?;
        settings::set_setting(conn, "db.migration.chat_message_kind.backfilled", "1")?;
    }
    Ok(())
}

/// Add the `starred` / `unread` columns to `chat_sessions` on databases created
/// before those columns existed. `ALTER TABLE … ADD COLUMN` errors if the
/// column is already present, so a duplicate-column error is treated as a no-op.
fn migrate_chat_session_flags(conn: &Connection) -> DbResult<()> {
    for col in ["starred", "unread"] {
        let sql = format!("ALTER TABLE chat_sessions ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0");
        if let Err(e) = conn.execute(&sql, []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Add the `watch_mode` column to `chat_sessions` on databases created before
/// the watch-mode pacing feature existed. `ALTER TABLE … ADD COLUMN` errors if
/// the column is already present, so a duplicate-column error is a no-op. NULL
/// means "inherit global setting"; per-session values are `"on"` | `"off"`.
fn migrate_chat_session_watch_mode(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN watch_mode TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `auto_model` column to `chat_sessions` (auto model routing). 1 =
/// the session routes each turn through the auto resolver (the row's
/// provider/model hold the LAST resolution — used for display, context
/// metering, and next-turn stickiness — and are re-resolved per send).
fn migrate_chat_session_auto(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN auto_model INTEGER NOT NULL DEFAULT 0";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `permission_mode` column to `chat_sessions` on databases created
/// before the per-session approval-posture feature returned. Nullable on
/// purpose: NULL (and empty/unknown values) read as `"manual"` in
/// `map_chat_session`, which is also the value new rows are inserted with.
fn migrate_chat_session_permission_mode(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN permission_mode TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `sandbox_policy` and `approval_policy` columns to `chat_sessions`,
/// backfilling them from the legacy `permission_mode` column. The legacy
/// column is preserved (not dropped) for rollback safety.
fn migrate_chat_session_policies(conn: &Connection) -> DbResult<()> {
    for col in ["sandbox_policy", "approval_policy"] {
        let sql = format!("ALTER TABLE chat_sessions ADD COLUMN {col} TEXT");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    // Backfill from legacy permission_mode using the preset mapping table.
    // Rows where the new columns are NULL (i.e. just added) get the derived
    // preset; rows that already have values (re-run of migration) are left
    // alone.
    conn.execute_batch(
        "UPDATE chat_sessions SET sandbox_policy = CASE permission_mode
                WHEN 'read_only' THEN 'read_only'
                ELSE 'workspace_write'
             END,
             approval_policy = CASE permission_mode
                WHEN 'auto_edit' THEN 'auto_edit'
                WHEN 'full_auto' THEN 'full_access'
                WHEN 'read_only' THEN 'on_request'
                ELSE 'on_request'
             END
         WHERE sandbox_policy IS NULL OR approval_policy IS NULL",
    )?;
    Ok(())
}

/// before the worktree-per-session feature (roadmap P0 §3.1.1). NULL = the
/// chat works in its bound project's working tree; a path = the chat's
/// isolated git worktree (branch `relay/<id>`, a sibling of the project).
/// The column is maintained by `ensure_chat_session_worktree` /
/// `set_chat_session_worktree`; see the legacy `sessions.worktree_path`
/// (PTY harness sessions) for the older sibling of this concept.
fn migrate_chat_session_worktree(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN worktree_path TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `cwd_override` column to `chat_sessions` (the composer's "Choose
/// working folder…" pick). Nullable: NULL = resolve the working dir from the
/// bound project (or the artifacts fallback). Persisting it is what makes the
/// picked folder survive an app restart — the in-memory map alone evaporated
/// and every post-restart send silently lost the folder.
fn migrate_chat_session_cwd_override(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN cwd_override TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `effort_level` column to `chat_sessions` (per-session harness
/// reasoning-effort tier). Nullable on purpose: NULL reads as "Default" in
/// `map_chat_session` — no effort flag is passed at spawn and the CLI's own
/// configured effort stands.
fn migrate_chat_session_effort(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN effort_level TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `agent` column to `chat_sessions` on databases created before the
/// composer's agent-then-model selector existed. `ALTER TABLE … ADD COLUMN`
/// errors if the column is already present, so a duplicate-column error is a
/// no-op. NULL means "no agent picked yet" (the model chip stays locked).
///
/// The provider-derived backfill (`local_gguf` → `"local"`, else `"builtin"`)
/// runs ONLY when the ALTER actually added the column — i.e. for rows that
/// predate the feature, so they keep working instead of suddenly locking
/// their Send button. It must NOT run on every startup: chats created after
/// the migration are inserted with NULL on purpose, and re-backfilling would
/// clobber that intentional "unselected" state (M14).
/// B-30: marker-backed migrations persist "backfill done" in `app_settings`.
/// `init_schema` normally creates that table before migrations run; this
/// no-op guard keeps isolated/test schemas working too.
fn ensure_settings_table(conn: &Connection) {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    );
}

fn migrate_chat_session_agent(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN agent TEXT";
    let column_added = match conn.execute(sql, []) {
        Ok(_) => true,
        Err(e) => {
            if e.to_string().contains("duplicate column name") {
                false
            } else {
                return Err(e);
            }
        }
    };
    // B-30: the backfill used to fire only when the ALTER actually added the
    // column — a crash between the ALTER (autocommitted) and this UPDATE
    // permanently skipped the backfill (the column exists on every later
    // start, so `column_added` stays false). Gate on a persisted marker
    // instead: the backfill runs until it has observably COMPLETED once.
    ensure_settings_table(conn);
    let backfill_done = settings::get_setting(conn, "db.migration.agent.backfilled")
        .ok()
        .flatten()
        .is_some();
    if column_added || !backfill_done {
        conn.execute(
            "UPDATE chat_sessions SET agent = CASE WHEN provider = 'local_gguf' THEN 'local' ELSE 'builtin' END WHERE agent IS NULL",
            [],
        )?;
        settings::set_setting(conn, "db.migration.agent.backfilled", "1")?;
    }
    Ok(())
}

/// Add the `project_id` column to `chat_sessions` on databases created before
/// chats could be nested under a project in the sidebar. NULL means the chat
/// is unbound and shows in the flat "Chat History" list; a project id nests it
/// under that project's expandable row. `ALTER TABLE … ADD COLUMN` errors if
/// the column already exists, so a duplicate-column error is a no-op. The FK
/// is `ON DELETE SET NULL` as a safety net; project removal also explicitly
/// deletes the project's chats (see `remove_project`).
fn migrate_chat_session_project_id(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `chat_message_id` column to `artifacts` on databases created before
/// it existed, so reopened chats can re-attach artifacts to their message.
/// A duplicate-column error is treated as a no-op.
fn migrate_artifacts_message_id(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE artifacts ADD COLUMN chat_message_id INTEGER";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// Add the `superseded_by` column to `chat_messages` on databases created
/// before the local-model context-compaction feature existed. When a compaction
/// summarizes older turns, those rows get `superseded_by = <summary_row_id>` so
/// the send path (which feeds the model) can filter them out while the full
/// `list_chat_messages` (used by the UI timeline) still returns them. A
/// duplicate-column error is treated as a no-op so existing DBs upgrade in place.
fn migrate_chat_messages_superseded(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_messages ADD COLUMN superseded_by INTEGER";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    Ok(())
}

/// `app_settings` marker written once the 7 builtin subagent roles exist.
/// Bump to `subagent.seed.v2` if `BUILTIN_ROLES` ever changes shape — a fresh
/// marker re-runs the (INSERT OR IGNORE, so still idempotent) seed.
pub const SUBAGENT_SEED_MARKER: &str = "subagent.seed.v1";
/// Seed the 7 builtin subagent roles (`explore`/`edit`/`analyze`/`research`/
/// `write`/`test`/`refactor`) as `builtin=1` rows so the registry and the
/// `Task` role enum can never disagree.
///
/// Two layers of idempotency, deliberately: the inserts are `INSERT OR
/// IGNORE` (keyed on the stable `builtin-<role>` ids, so a re-run after a
/// cleared marker is a no-op and never duplicates or clobbers a user's edits
/// to a builtin row), and the whole pass is skipped once the
/// `subagent.seed.v1` marker is set. The marker is the B-30 one-shot-backfill
/// pattern (`migrate_chat_session_agent` / `migrate_chat_fts`): it exists so
/// startup doesn't pay 7 inserts forever, and `INSERT OR IGNORE` remains the
/// correctness guarantee. Clear the marker to re-seed a drifted DB.
pub(crate) fn migrate_subagents_seed(conn: &Connection) -> DbResult<()> {
    ensure_settings_table(conn);
    let done = settings::get_setting(conn, SUBAGENT_SEED_MARKER)
        .ok()
        .flatten()
        .as_deref()
        == Some("1");
    if done {
        return Ok(());
    }
    subagents::seed_builtin_subagents(conn)?;
    settings::set_setting(conn, SUBAGENT_SEED_MARKER, "1")?;
    Ok(())
}

/// Source-note metadata columns: publisher name and publish date. Temporal
/// conflicts (stale-vs-fresh sources) are a first-class research error class;
/// without a capture date in the ledger the synthesis prompt can only guess
/// which source is newer. Same duplicate-column-tolerant pattern as
/// `migrate_cost_v2`.
fn migrate_source_notes_metadata(conn: &Connection) -> DbResult<()> {
    for col in ["publisher TEXT", "published_at TEXT"] {
        let sql = format!("ALTER TABLE chat_source_notes ADD COLUMN {col}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Cost events v2: cache/reasoning/source/model_key/reported/pricing columns,
/// backfill where possible, and drop the old `estimated_cost_usd`. Each
/// `ALTER TABLE … ADD COLUMN` is a no-op when the column already exists
/// (handles re-runs). The `DROP COLUMN` is gated on the column existing so
/// older SQLite builds (< 3.35) skip it without erroring out.
pub fn migrate_cost_v2(conn: &Connection) -> DbResult<()> {
    for (col, def) in [
        ("provider", "TEXT"),
        ("model_key", "TEXT"),
        ("cache_creation_input_tokens", "INTEGER"),
        ("cache_read_input_tokens", "INTEGER"),
        ("reasoning_output_tokens", "INTEGER"),
        ("reported_cost_usd", "REAL"),
        ("pricing_estimated_usd", "REAL"),
    ] {
        let sql = format!("ALTER TABLE cost_events ADD COLUMN {col} {def}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    // `source` gets the NOT NULL DEFAULT, so the add-column is idempotent;
    // we track whether this run actually ADDED it so the one-time backfills
    // below only fire on the migration's first run (re-running them on every
    // startup would re-label fresh pty rows as 'on_disk' and stamp default
    // model_keys onto mixed-model sessions — spec §5.4 says those stay NULL).
    let sql_source = "ALTER TABLE cost_events ADD COLUMN source TEXT NOT NULL DEFAULT 'pty'";
    let source_added = match conn.execute(sql_source, []) {
        Ok(_) => true,
        Err(e) => {
            if e.to_string().contains("duplicate column name") {
                false
            } else {
                return Err(e);
            }
        }
    };

    // Backfill (one-time, only when `source` was just added): rows whose
    // session was ever on-disk-synced get source='on_disk'; remaining rows
    // keep the 'pty' default. Guarded by the sessions table having a
    // last_synced_at column (older DBs / pre-migration test schemas may not).
    let has_last_synced: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'last_synced_at')",
            [], |r| r.get(0),
        )
        .unwrap_or(false);
    // B-30: gate the one-time backfills on a persisted marker rather than on
    // `source_added` — a crash between the ALTER and the UPDATEs used to
    // skip them forever (the column exists from then on, so source_added
    // never became true again).
    ensure_settings_table(conn);
    let cost_backfill_done = settings::get_setting(conn, "db.migration.cost_v2.backfilled")
        .ok()
        .flatten()
        .is_some();
    if (source_added || !cost_backfill_done) && has_last_synced {
        conn.execute(
            "UPDATE cost_events
                SET source = 'on_disk'
              WHERE source = 'pty'
                AND session_id IN (SELECT id FROM sessions WHERE last_synced_at IS NOT NULL)",
            [],
        )?;
        conn.execute(
            "UPDATE cost_events
                SET model_key = CASE s.harness
                    WHEN 'claude_code' THEN 'claude-sonnet-4-5'
                    WHEN 'kimi_code'   THEN 'kimi-k3'
                    ELSE model_key
                END
               FROM sessions s
              WHERE cost_events.session_id = s.id
                AND cost_events.model_key IS NULL
                AND s.harness IN ('claude_code', 'kimi_code')",
            [],
        )?;
        settings::set_setting(conn, "db.migration.cost_v2.backfilled", "1")?;
    }

    // DROP COLUMN: gated on the column existing. Older SQLite (< 3.35) may
    // not support DROP COLUMN; fail soft by skipping in that case.
    let has_old_col: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cost_events') WHERE name = 'estimated_cost_usd')",
            [], |r| r.get(0),
        )
        .unwrap_or(false);
    if has_old_col {
        if let Err(e) = conn.execute("ALTER TABLE cost_events DROP COLUMN estimated_cost_usd", []) {
            crate::relay_eprintln!("[relay] cost_v2: DROP COLUMN failed ({e}); column will be unused");
        }
    }
    Ok(())
}

/// Chat messages v2: cache/reasoning/provider/model_key/pricing_estimated_usd.
/// Same duplicate-column-tolerant pattern as `migrate_cost_v2`.
pub fn migrate_chat_messages_v2(conn: &Connection) -> DbResult<()> {
    for (col, def) in [
        ("cache_creation_input_tokens", "INTEGER"),
        ("cache_read_input_tokens", "INTEGER"),
        ("reasoning_output_tokens", "INTEGER"),
        ("provider", "TEXT"),
        ("model_key", "TEXT"),
        ("pricing_estimated_usd", "REAL"),
    ] {
        let sql = format!("ALTER TABLE chat_messages ADD COLUMN {col} {def}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Add the `started_at` / `completed_at` turn-window columns (assistant rows
/// only) so the UI can show "Worked for Xs". Same duplicate-column-tolerant
/// pattern as `migrate_chat_messages_v2`.
pub fn migrate_chat_messages_started_completed(conn: &Connection) -> DbResult<()> {
    for (col, def) in [("started_at", "INTEGER"), ("completed_at", "INTEGER")] {
        let sql = format!("ALTER TABLE chat_messages ADD COLUMN {col} {def}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Perf metrics per assistant turn — LLM/tool time (ms), TTFT (ms), and
/// generation speed (tokens/second). Populated by the streaming paths in
/// `chat/mod.rs` and `agent_sessions.rs`; legacy rows stay NULL. Mirrors
/// the fields added to `ChatDonePayload`/`ChatMessageRecord`.
pub fn migrate_chat_messages_perf(conn: &Connection) -> DbResult<()> {
    for (col, def) in [
        ("llm_time_ms", "INTEGER"),
        ("tool_time_ms", "INTEGER"),
        ("ttft_ms", "INTEGER"),
        ("tokens_per_second", "REAL"),
    ] {
        let sql = format!("ALTER TABLE chat_messages ADD COLUMN {col} {def}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Schema = PRD §6.3 verbatim + the `quick_actions` table from CONTRACT.md.
/// Raw string: schema comments may contain double quotes (they'd otherwise
/// terminate a plain `"` literal — that actually happened with the doc_chunks
/// heading-trail comment below).
pub fn init_schema(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          is_git_repo BOOLEAN NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          harness TEXT NOT NULL,
          harness_session_id TEXT,
          harness_session_id_source TEXT NOT NULL DEFAULT 'disk_probe',
          title TEXT,
          worktree_path TEXT,
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle'
        );

        CREATE TABLE IF NOT EXISTS cost_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          timestamp INTEGER NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          provider TEXT,
          model_key TEXT,
          source TEXT NOT NULL DEFAULT 'pty',
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          reported_cost_usd REAL,
          pricing_estimated_usd REAL
        );

        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slash_command TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'global',
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_secrets (
          project_id TEXT NOT NULL REFERENCES projects(id),
          key TEXT NOT NULL,
          value_encrypted BLOB NOT NULL,
          PRIMARY KEY (project_id, key)
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quick_actions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          label TEXT NOT NULL,
          command TEXT NOT NULL,
          keybinding TEXT,
          run_on_worktree BOOLEAN NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_active_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cost_events_session ON cost_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_cost_events_ts ON cost_events(timestamp);

        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          title TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          starred INTEGER NOT NULL DEFAULT 0,
          unread INTEGER NOT NULL DEFAULT 0,
          watch_mode TEXT,
          agent TEXT,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          permission_mode TEXT,
          worktree_path TEXT,
          cwd_override TEXT,
          sandbox_policy TEXT,
          approval_policy TEXT,
          auto_model INTEGER NOT NULL DEFAULT 0,
          effort_level TEXT,
          origin TEXT
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL,
          created_at INTEGER NOT NULL,
          superseded_by INTEGER,
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          provider TEXT,
          model_key TEXT,
          pricing_estimated_usd REAL,
          started_at INTEGER,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id, id);        -- mi26: get_cost_rollups_v2 range-scans chat_messages by created_at
        -- every poll — previously a full-table scan + join per rollup call.
        CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_active ON chat_sessions(last_active_at DESC);

        -- ── Session Mesh (SESSION_MESH_DESIGN_ARCHITECTURE.md §4-§6) ──────
        -- Cross-session awareness/messaging/spawning. `session_summaries` is
        -- the distillation layer: one ≤2-sentence abstract per chat, written
        -- by a background one-shot (never blocking a turn), refreshed when
        -- the session's last_active_at outruns it. `session_mail` is the
        -- point-to-point agent mailbox — every agent-to-agent exchange is a
        -- row, so the mesh's audit trail is plain data the user can inspect.
        CREATE TABLE IF NOT EXISTS session_summaries (
          chat_session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
          summary TEXT NOT NULL,
          topics TEXT NOT NULL DEFAULT '',
          model TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_mail (
          id TEXT PRIMARY KEY,
          from_session TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          to_session TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,               -- 'question' | 'notify'
          body TEXT NOT NULL,
          status TEXT NOT NULL,             -- queued|delivered|answered|expired|rejected
          answer TEXT,
          depth INTEGER NOT NULL DEFAULT 0, -- forwarded-question chain depth
          created_at INTEGER NOT NULL,
          delivered_at INTEGER,
          answered_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_session_mail_to ON session_mail(to_session, status);
        CREATE INDEX IF NOT EXISTS idx_session_mail_from ON session_mail(from_session, created_at DESC);

        -- ── Self-improving artifacts (SELF_IMPROVING_ARTIFACTS.md §4/§5) ──
        -- `improve_artifacts` (not `artifacts` — that name is taken by the
        -- chat-attachment table) is the versioning + telemetry registry for
        -- behavioral artifacts: skills, loops, prompt templates, automations.
        CREATE TABLE IF NOT EXISTS improve_artifacts (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,                 -- 'skill'|'loop'|'prompt_template'|'automation'
          ref_key TEXT NOT NULL,              -- skill slug / template id / automation id
          name TEXT NOT NULL,
          autonomy TEXT NOT NULL DEFAULT 'manual', -- §9.2: 'manual'|'auto'|'canary'
          created_at INTEGER NOT NULL,
          UNIQUE(kind, ref_key)
        );

        -- Append-only version history. Full resolved body per version so
        -- history survives edits/deletes of the live copy.
        CREATE TABLE IF NOT EXISTS improve_versions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          body TEXT NOT NULL,
          meta_json TEXT,
          origin TEXT NOT NULL DEFAULT 'user', -- 'user'|'auto_proposal'|'import'
          parent_version INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE(artifact_id, version)
        );

        -- Movable pointers: rollback = re-point 'active'.
        CREATE TABLE IF NOT EXISTS improve_channels (
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,              -- 'active'|'candidate'|'shadow'
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (artifact_id, channel)
        );

        -- Execution telemetry per artifact version (mirror of automation_runs;
        -- P0: skill invocations, goal-loop sessions, prompt-template fills).
        CREATE TABLE IF NOT EXISTS improve_runs (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          chat_session_id TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          outcome TEXT,                       -- 'applied'|'failed'|'abandoned'|'corrected'; NULL while open
          error_code TEXT,
          metrics_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_improve_runs_artifact
          ON improve_runs(artifact_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_improve_runs_session
          ON improve_runs(chat_session_id, finished_at);

        -- Explicit 👍/👎 feedback attributed to an artifact run when known.
        CREATE TABLE IF NOT EXISTS improve_feedback (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES improve_runs(id) ON DELETE SET NULL,
          chat_session_id TEXT,
          verdict TEXT NOT NULL,              -- 'up'|'down'
          reason TEXT,
          created_at INTEGER NOT NULL
        );

        -- Goal-loop runtime persistence (frontend state machine calls in on
        -- every transition so loop outcomes survive the session).
        CREATE TABLE IF NOT EXISTS loop_sessions (
          id TEXT PRIMARY KEY,
          chat_session_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          iteration INTEGER NOT NULL DEFAULT 0,
          max_iterations INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'running', -- 'running'|'complete'|'blocked'|'stopped'|'maxed'
          run_id TEXT REFERENCES improve_runs(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_loop_sessions_chat ON loop_sessions(chat_session_id, created_at DESC);

        -- P1: improvement proposals (§6) + eval packs (§7/§8).
        CREATE TABLE IF NOT EXISTS improve_proposals (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          base_version INTEGER NOT NULL,
          candidate_version INTEGER NOT NULL,
          change_summary TEXT NOT NULL,
          root_causes_json TEXT,
          expected_effect TEXT,
          risk_notes TEXT,
          status TEXT NOT NULL DEFAULT 'open', -- open|evaluating|passed|failed_eval|applied|rejected|stale
          eval_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_improve_proposals_artifact ON improve_proposals(artifact_id, status);

        -- Eval pack: golden inputs + expectations. `harvested` cases come from
        -- real corrected/failed runs; they are the memory of past failures.
        CREATE TABLE IF NOT EXISTS improve_eval_cases (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          input_text TEXT NOT NULL,
          expect_json TEXT NOT NULL,          -- JSON: mustContain/mustNotContain/regex arrays + judge flag
          source TEXT NOT NULL DEFAULT 'manual',
          enabled INTEGER NOT NULL DEFAULT 1,
          quarantined INTEGER NOT NULL DEFAULT 0,   -- P3: flaky case parked out of gating
          quarantine_reason TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_improve_eval_cases_artifact ON improve_eval_cases(artifact_id, enabled);

        CREATE TABLE IF NOT EXISTS improve_eval_runs (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          proposal_id TEXT REFERENCES improve_proposals(id) ON DELETE SET NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          verdict TEXT,                       -- 'passed'|'failed'
          report_json TEXT,
          chat_session_id TEXT                -- P3: engine throwaway sessions (cost attribution)
        );

        CREATE TABLE IF NOT EXISTS improve_eval_results (
          id TEXT PRIMARY KEY,
          eval_run_id TEXT NOT NULL REFERENCES improve_eval_runs(id) ON DELETE CASCADE,
          eval_case_id TEXT NOT NULL,
          champion_ok INTEGER,
          candidate_ok INTEGER,
          champion_score REAL,
          candidate_score REAL,
          detail TEXT
        );

        -- P2: canary (shadow) windows + audit trail.
        -- The shadow channel points at a candidate version that the injection
        -- path serves for qualifying runs until the window resolves.
        CREATE TABLE IF NOT EXISTS improve_canaries (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          proposal_id TEXT NOT NULL REFERENCES improve_proposals(id) ON DELETE CASCADE,
          base_version INTEGER NOT NULL,
          shadow_version INTEGER NOT NULL,
          min_runs INTEGER NOT NULL DEFAULT 10,
          max_age_secs INTEGER NOT NULL DEFAULT 172800,
          started_at INTEGER NOT NULL,
          resolved_at INTEGER,
          verdict TEXT                     -- 'promoted'|'rolled_back'; NULL while open
        );

        -- Audit log (§9.3): every engine transition is replayable from here.
        CREATE TABLE IF NOT EXISTS improve_events (
          id TEXT PRIMARY KEY,
          artifact_id TEXT REFERENCES improve_artifacts(id) ON DELETE CASCADE,
          proposal_id TEXT,
          event TEXT NOT NULL,             -- swept|evaluated|applied|rejected|promoted|rolled_back|tier_changed
          detail_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_improve_events_artifact ON improve_events(artifact_id, created_at DESC);

        -- Full-text search over chat messages (command palette Chats
        -- section). External-content table: chat_messages stays the source of
        -- truth and the triggers below keep the index in sync on
        -- insert/delete/content-update. Existing rows are backfilled once by
        -- migrate_chat_fts().
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
          content,
          content='chat_messages',
          content_rowid='id',
          tokenize='unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
          INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
          INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
            VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE OF content ON chat_messages BEGIN
          INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
            VALUES('delete', old.id, old.content);
          INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

        -- ── Persistent user memory (MEMORY_DESIGN_ARCHITECTURE.md §9) ──────
        -- Flat scored fact store (no graph): one row per durable fact about
        -- the user / a project. Bi-temporal columns (valid_from/valid_until =
        -- world time; created_at/superseded_at = store time) so a
        -- contradiction SUPERSEDES a memory instead of overwriting it — the
        -- old row survives for audit (superseded_by chain), matching
        -- db/chat_messages supersession precedent.
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          profile TEXT NOT NULL DEFAULT 'default',
          project_id TEXT,
          subject TEXT NOT NULL DEFAULT 'user',
          content TEXT NOT NULL,
          keywords TEXT NOT NULL DEFAULT '[]',
          importance INTEGER NOT NULL DEFAULT 5,
          confidence REAL NOT NULL DEFAULT 0.8,
          status TEXT NOT NULL DEFAULT 'active',
          superseded_by TEXT,
          valid_from INTEGER NOT NULL,
          valid_until INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          superseded_at INTEGER,
          last_accessed_at INTEGER,
          access_count INTEGER NOT NULL DEFAULT 0,
          origin TEXT NOT NULL DEFAULT 'extracted',
          reflected INTEGER NOT NULL DEFAULT 0,
          embedding BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_memories_active
          ON memories(profile, status, importance);
        CREATE INDEX IF NOT EXISTS idx_memories_project
          ON memories(project_id, status);

        -- Full-text index over memory content/keywords (hybrid retrieval's
        -- keyword leg). External-content, trigger-synced, same pattern as
        -- chat_messages_fts above.
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, keywords,
          content='memories',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, keywords)
            VALUES (new.rowid, new.content, new.keywords);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
            VALUES('delete', old.rowid, old.content, old.keywords);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content, keywords ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
            VALUES('delete', old.rowid, old.content, old.keywords);
          INSERT INTO memories_fts(rowid, content, keywords)
            VALUES (new.rowid, new.content, new.keywords);
        END;

        -- Provenance: ≥1 evidence row per memory (P4 — a memory without a
        -- source message cannot exist). Rows point into chat_messages so the
        -- UI can jump to the exact quote that produced the fact.
        CREATE TABLE IF NOT EXISTS memory_evidence (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          chat_session_id TEXT NOT NULL,
          chat_message_id INTEGER NOT NULL,
          quote TEXT NOT NULL,
          PRIMARY KEY (memory_id, chat_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_evidence_msg
          ON memory_evidence(chat_message_id);

        -- Append-only audit of every write decision (judge output included,
        -- NOOPs logged too). The undo/inspection log behind the memory UI —
        -- nothing about the store's evolution is hidden from the user.
        CREATE TABLE IF NOT EXISTS memory_ops (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          actor TEXT NOT NULL,
          session_id TEXT,
          candidate TEXT NOT NULL,
          operation TEXT NOT NULL,
          target_ids TEXT NOT NULL DEFAULT '[]',
          rationale TEXT NOT NULL DEFAULT ''
        );

        -- Bounded version history of the memory document (every LLM merge and
        -- user save). Powers the panel's History + Restore UI: a bad merge is
        -- one click from undone. Old versions prune to the newest 20.
        CREATE TABLE IF NOT EXISTS memory_document_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        -- Idempotency cursor: highest chat_messages.id already fed through
        -- extraction for a session (re-running never re-extracts a turn).
        CREATE TABLE IF NOT EXISTS memory_cursor (
          chat_session_id TEXT PRIMARY KEY,
          last_message_id INTEGER NOT NULL DEFAULT 0,
          last_run_at INTEGER NOT NULL DEFAULT 0
        );

        -- Per-turn git working-tree snapshots (refs/relay/checkpoints/…).
        -- message_id is the assistant message the checkpoint follows; NULL =
        -- turn-start baseline / pre-restore safety snapshot. `files` is a
        -- JSON [{path,status}] array vs the session's previous checkpoint.
        -- Rows cascade away with the session; the delete-session command
        -- prunes the git refs first via checkpoint_ref_paths().
        CREATE TABLE IF NOT EXISTS chat_checkpoints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          message_id INTEGER,
          ref TEXT NOT NULL DEFAULT '',
          tree_sha TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          files TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_checkpoints_session ON chat_checkpoints(chat_session_id, id);

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          chat_session_id TEXT,
          chat_message_id INTEGER,
          filename TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        -- insert_artifact's dedupe upsert (UPDATE ... WHERE path = ?1) and
        -- list_artifacts' newest-per-path anti-join are per-path lookups over
        -- the gallery table — without this index both scan per row.
        CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(path);

        -- Scheduled headless agent runs (see db/automations.rs +
        -- crate::automations). chat_session_id is the run log, bound lazily.
        -- origin: user (Automations view form) or agent (chat
        -- create_automation tool) — the UI badges agent-authored rows so the
        -- user can see what the model scheduled.
        -- trigger_type picks the firing engine ('cron' | 'webhook' | 'file'
        -- | 'git'); trigger_config is its JSON payload; last_trigger_state
        -- holds the engine's dedupe state (last git SHA / last fs-fire
        -- epoch); last_event_run_at is the event-source twin of last_run_at
        -- (event runs must not delay the cron clock).
        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          harness TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '',
          schedule TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          last_status TEXT,
          chat_session_id TEXT,
          created_at INTEGER NOT NULL,
          origin TEXT NOT NULL DEFAULT 'user',
          trigger_type TEXT NOT NULL DEFAULT 'cron',
          trigger_config TEXT NOT NULL DEFAULT '{}',
          last_trigger_state TEXT,
          last_event_run_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          summary TEXT NOT NULL DEFAULT '',
          chat_session_id TEXT,
          source TEXT NOT NULL DEFAULT 'scheduled',
          improve_run_id TEXT REFERENCES improve_runs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_auto
          ON automation_runs(automation_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_running
          ON automation_runs(status) WHERE finished_at IS NULL;

        -- Declarative subagents ("subagents") — the persisted registry every spawn
        -- surface resolves against (see db/subagent.rs + chat/subagent.rs). The 7
        -- builtin roles are seeded rows (builtin=1, id `builtin-<role>`) so
        -- the `Task` role enum and the registry can never disagree; they carry
        -- the role instruction only, which dispatch.rs still composes with the
        -- cwd line + read-only boilerplate. `name` is the Task enum value and
        -- is UNIQUE COLLATE NOCASE so "Doc Writer" and "doc writer" cannot
        -- both exist. `tools` is a JSON array of tool names; NULL = inherit
        -- the engine default. The 7 role names are reserved — see
        -- chat::subagent::validate_name.
        CREATE TABLE IF NOT EXISTS subagents (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
          description     TEXT NOT NULL DEFAULT '',
          prompt_md       TEXT NOT NULL DEFAULT '',
          tools           TEXT,
          engine          TEXT,
          model           TEXT,
          effort          TEXT,
          sandbox_policy  TEXT NOT NULL DEFAULT 'read_only',
          approval_policy TEXT NOT NULL DEFAULT 'on_request',
          worktree_policy TEXT NOT NULL DEFAULT 'inherit',
          max_rounds      INTEGER NOT NULL DEFAULT 100,
          max_concurrent  INTEGER NOT NULL DEFAULT 2,
          builtin         INTEGER NOT NULL DEFAULT 0,
          -- The native `.md` this row was imported from, when it came from a
          -- CLI harness's own store; NULL otherwise. Uniquely indexed
          -- (NOCASE, see migrate_subagents_source_path) so one file maps to
          -- one row and a re-import updates in place.
          source_path     TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        -- Builtins first (the stable set the Task enum advertises), then user
        -- rows by name.
        CREATE INDEX IF NOT EXISTS idx_subagents_builtin
          ON subagents(builtin, name);

        -- One row per subagent RUN (a spawned session's lifecycle), not per turn.
        -- No FKs on purpose: history outlives a deleted agent or chat —
        -- dangling ids render as "deleted agent" in the runs list.
        CREATE TABLE IF NOT EXISTS subagent_runs (
          id           TEXT PRIMARY KEY,
          agent_id     TEXT,
          session_id   TEXT,
          trigger      TEXT NOT NULL,
          task         TEXT NOT NULL,
          engine       TEXT NOT NULL,
          model        TEXT NOT NULL,
          worktree     TEXT,
          started_at   INTEGER NOT NULL,
          finished_at  INTEGER,
          status       TEXT NOT NULL DEFAULT 'running',
          summary      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_agent
          ON subagent_runs(agent_id, started_at DESC);

        CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_artifacts_expires ON artifacts(expires_at);

        CREATE TABLE IF NOT EXISTS chat_source_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          fact TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          unavailable TEXT,
          publisher TEXT,
          published_at TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_source_notes_session ON chat_source_notes(chat_session_id, id);

        -- Prevent exact-duplicate source notes (same session + url + fact).
        CREATE UNIQUE INDEX IF NOT EXISTS uq_source_notes_dedup ON chat_source_notes(chat_session_id, url, fact);

        -- Cached web-search result payloads, keyed on the normalized query
        -- (see research_cache::search_cache_put). Brave-sourced payloads are
        -- never stored (API terms prohibit result storage without a
        -- storage-rights plan).
        CREATE TABLE IF NOT EXISTS search_cache (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          engines TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        -- Cached extracted page content keyed on the canonical URL, so
        -- re-reads of the same source within the TTL never re-hit the wire.
        CREATE TABLE IF NOT EXISTS page_cache (
          url_key TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        -- TTL purges (research_cache::purge_expired, on open + insert) range
        -- over these; without them each purge is a full-table scan.
        CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache(created_at);
        CREATE INDEX IF NOT EXISTS idx_page_cache_created ON page_cache(created_at);

        -- Per-session log of executed web searches. Powers the each-query-unique
        -- rule (the dispatcher nudges on exact repeats) and leaves an audit
        -- trail of what a research task actually searched.
        CREATE TABLE IF NOT EXISTS research_queries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          query TEXT NOT NULL,
          normalized_query TEXT NOT NULL,
          engines TEXT NOT NULL,
          result_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_research_queries_session
          ON research_queries(chat_session_id, normalized_query);

        -- Output of the citation-integrity lint run over each research
        -- report (orphan citations, unused sources, weak attribution).
        CREATE TABLE IF NOT EXISTS citation_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          message_id INTEGER,
          total_citations INTEGER NOT NULL,
          orphan_count INTEGER NOT NULL,
          unused_count INTEGER NOT NULL,
          uncited_sentences INTEGER NOT NULL,
          weak_count INTEGER NOT NULL,
          detail TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_citation_reports_session
          ON citation_reports(chat_session_id, created_at DESC);

        -- App-scoped connector OAuth credentials. Secret token values live in
        -- the OS keychain (secrets.rs); this row only holds non-sensitive
        -- metadata needed to list connected connectors cheaply.
        CREATE TABLE IF NOT EXISTS connector_credentials (
          connector_id TEXT PRIMARY KEY,
          expires_at INTEGER,
          granted_scopes TEXT,
          account_display TEXT,
          connected_at INTEGER NOT NULL
        );

        -- Per-conversation opt-in: which connected connectors are active for a
        -- given chat session. A connected connector is NOT globally available —
        -- it must be attached to the session here.
        CREATE TABLE IF NOT EXISTS chat_session_connectors (
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          connector_id TEXT NOT NULL,
          PRIMARY KEY (chat_session_id, connector_id)
        );

        CREATE INDEX IF NOT EXISTS idx_session_connectors ON chat_session_connectors(chat_session_id);

        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);

        -- Local document corpora (local RAG). Chunks carry their embedding as
        -- a little-endian f32 BLOB; search is brute-force cosine in Rust.
        -- chunk_version stamps the chunk-shape (chunker + enrichment) schema
        -- the corpus was last indexed with; when it lags behind
        -- DOCS_CHUNK_SCHEMA_VERSION (db/docs.rs) the next index pass re-chunks
        -- EVERY file, because mtime/size diffs can't see chunk-shape changes.
        CREATE TABLE IF NOT EXISTS doc_corpora (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          last_indexed_at INTEGER,
          file_count INTEGER NOT NULL DEFAULT 0,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          chunk_version INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS doc_files (
          corpus_id TEXT NOT NULL,
          path TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          PRIMARY KEY (corpus_id, path)
        );

        -- heading holds the markdown heading trail at the chunk's start
        -- ("Guide > Setup", '' when none/non-markdown). Since chunk-schema
        -- v2 the trail + path are part of the text the EMBEDDING was
        -- computed from (contextual enrichment); content stays raw for the
        -- FTS index below and for display.
        CREATE TABLE IF NOT EXISTS doc_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          corpus_id TEXT NOT NULL,
          path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'text',
          content TEXT NOT NULL,
          heading TEXT NOT NULL DEFAULT '',
          embedding BLOB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_doc_chunks_corpus ON doc_chunks(corpus_id, path);

        -- Full-text leg of hybrid doc search. External-content table over
        -- doc_chunks.content — doc_chunks stays the source of truth and the
        -- triggers below keep the index in sync, mirroring
        -- chat_messages_fts above. Existing rows are backfilled once by
        -- migrate_doc_chunks_fts().
        CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
          content,
          content='doc_chunks',
          content_rowid='id',
          tokenize='unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_ai AFTER INSERT ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_ad AFTER DELETE ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
            VALUES('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_au AFTER UPDATE OF content ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content)
            VALUES('delete', old.id, old.content);
          INSERT INTO doc_chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;

        -- Per-chat attached corpora (§3.1.7): when a user explicitly pins a
        -- corpus to a chat, its chunks are included in the auto-retrieval
        -- alongside the global (auto-matched) hits, so the model ALWAYS has
        -- those documents in context for this chat regardless of query.
        CREATE TABLE IF NOT EXISTS chat_documents (
          chat_session_id TEXT NOT NULL,
          corpus_id TEXT NOT NULL,
          attached_at INTEGER NOT NULL,
          PRIMARY KEY (chat_session_id, corpus_id)
        );

        -- Project wiki (§6.15): one generated knowledge base per bound
        -- project. schema_version stamps the page-format (builder prompts +
        -- claim shape) the wiki was last built with; when it lags behind
        -- WIKI_SCHEMA_VERSION (db/wiki.rs) the next build re-generates
        -- EVERY page — mtime-style diffs can't see prompt-format changes.
        CREATE TABLE IF NOT EXISTS wiki_projects (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          head_sha TEXT,
          schema_version INTEGER NOT NULL DEFAULT 0,
          built_at INTEGER,
          last_update_at INTEGER,
          build_model TEXT
        );

        -- Pages carry their builder brief + evidence file set (files_json)
        -- so the update pass can re-derive a single stale page instead of
        -- rebuilding the whole wiki.
        CREATE TABLE IF NOT EXISTS wiki_pages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'module',
          summary TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'fresh',
          stale_reason TEXT,
          brief TEXT NOT NULL DEFAULT '',
          files_json TEXT NOT NULL DEFAULT '[]',
          generated_at INTEGER NOT NULL DEFAULT 0,
          generated_by TEXT,
          UNIQUE (project_id, slug)
        );

        CREATE INDEX IF NOT EXISTS idx_wiki_pages_project ON wiki_pages(project_id);

        -- Grounded Claims (the OpenWiki `.claims/` sidecar, relational):
        -- every material fact carries repo-relative evidence (path + line
        -- range) and the blob SHA the file had at generation time. The
        -- freshness engine joins `git diff --name-status` output against
        -- evidence_path — staleness is computed, never guessed.
        CREATE TABLE IF NOT EXISTS wiki_claims (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id TEXT NOT NULL,
          claim TEXT NOT NULL,
          evidence_path TEXT NOT NULL,
          line_start INTEGER,
          line_end INTEGER,
          blob_sha TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_wiki_claims_page ON wiki_claims(page_id);
        CREATE INDEX IF NOT EXISTS idx_wiki_claims_path ON wiki_claims(evidence_path);

        -- Keyword leg for the search_wiki tool. External-content table over
        -- wiki_pages (title/summary/body) — wiki_pages stays the source of
        -- truth and the triggers keep the index in sync, mirroring
        -- doc_chunks_fts. No embedding leg: pages are short, curated and
        -- keyword-dense; raw file content stays in the RAG corpora.
        -- content_rowid is the IMPLICIT integer rowid, not wiki_pages.id:
        -- page ids are TEXT UUIDs (house style) and an external-content FTS5
        -- index requires an integer rowid — a TEXT rowid fails every write
        -- with SQLITE_TYPE_MISMATCH ("datatype mismatch").
        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
          title, summary, body,
          content='wiki_pages',
          content_rowid='rowid',
          tokenize='unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_ai AFTER INSERT ON wiki_pages BEGIN
          INSERT INTO wiki_pages_fts(rowid, title, summary, body)
            VALUES (new.rowid, new.title, new.summary, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_ad AFTER DELETE ON wiki_pages BEGIN
          INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, summary, body)
            VALUES('delete', old.rowid, old.title, old.summary, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_au AFTER UPDATE OF title, summary, body ON wiki_pages BEGIN
          INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, summary, body)
            VALUES('delete', old.rowid, old.title, old.summary, old.body);
          INSERT INTO wiki_pages_fts(rowid, title, summary, body)
            VALUES (new.rowid, new.title, new.summary, new.body);
        END;
        "#,
    )?;
    // Vault (local markdown knowledge base) — derived index over the bound
    // folder's markdown files (see vault/index.rs). A deletable cache.
    crate::vault::index::ensure_schema(conn)?;
    migrate_wiki_pages_fts(conn)?;
    Ok(())
}

/// The wiki FTS table shipped briefly with `content_rowid='id'` — but
/// wiki_pages.id is a TEXT UUID, and an external-content FTS5 index needs an
/// INTEGER rowid, so every INSERT/UPDATE/DELETE died with SQLITE_TYPE_
/// MISMATCH ("datatype mismatch") and, via the freshness tick, looped the
/// build forever. CREATE VIRTUAL TABLE IF NOT EXISTS never upgrades an
/// existing table, so installs that booted on the old DDL keep it: detect
/// the old definition from sqlite_master and rebuild the index in place.
///
/// Two ways a wiki ends up with pages that can never be found again are both
/// covered, because the DDL-text guard alone catches neither once it has
/// fired:
///
///   1. The rebuild used to run as three separate batches, so a crash
///      between "drop the table" and "VALUES('rebuild')" left the FTS table
///      present but unindexed. The next boot hit `CREATE VIRTUAL TABLE IF
///      NOT EXISTS`, the guard below saw the CURRENT DDL, and never rebuilt
///      — permanently. It is now ONE transaction (SQLite DDL is
///      transactional, so a crash rolls back whole).
///   2. An index that has drifted from its content table is detected by
///      FTS5's own `integrity-check` and repaired, so a DB that reached that
///      state by any other route heals itself.
///
/// The repair check is deliberately not a `count(*)` against the content
/// table: on an external-content FTS5 table that reads the CONTENT table and
/// reports a healthy number even when the index is empty — the exact state
/// that must be detected.
fn migrate_wiki_pages_fts(conn: &Connection) -> DbResult<()> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_pages_fts'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let needs_rebuild = if sql.is_empty() {
        // No FTS table at all — init_schema's CREATE runs first, so this is
        // only reachable on an unusual boot order. Rebuild is the safe answer.
        true
    } else if sql.contains("content_rowid='rowid'") {
        wiki_fts_index_drifted(conn)?
    } else {
        true
    };
    if !needs_rebuild {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS wiki_pages_fts_ai;
         DROP TRIGGER IF EXISTS wiki_pages_fts_ad;
         DROP TRIGGER IF EXISTS wiki_pages_fts_au;
         DROP TABLE IF EXISTS wiki_pages_fts;",
    )?;
    tx.execute_batch(
        "CREATE VIRTUAL TABLE wiki_pages_fts USING fts5(
           title, summary, body,
           content='wiki_pages',
           content_rowid='rowid',
           tokenize='unicode61'
         );
         CREATE TRIGGER wiki_pages_fts_ai AFTER INSERT ON wiki_pages BEGIN
           INSERT INTO wiki_pages_fts(rowid, title, summary, body)
             VALUES (new.rowid, new.title, new.summary, new.body);
         END;
         CREATE TRIGGER wiki_pages_fts_ad AFTER DELETE ON wiki_pages BEGIN
           INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, summary, body)
             VALUES('delete', old.rowid, old.title, old.summary, old.body);
         END;
         CREATE TRIGGER wiki_pages_fts_au AFTER UPDATE OF title, summary, body ON wiki_pages BEGIN
           INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, summary, body)
             VALUES('delete', old.rowid, old.title, old.summary, old.body);
           INSERT INTO wiki_pages_fts(rowid, title, summary, body)
             VALUES (new.rowid, new.title, new.summary, new.body);
         END;",
    )?;
    // Reindex every existing page (external-content rebuild reads the
    // content table — no data moves, only the index is rebuilt).
    tx.execute_batch("INSERT INTO wiki_pages_fts(wiki_pages_fts) VALUES('rebuild');")?;
    tx.commit()?;
    Ok(())
}

/// True when the wiki FTS index holds nothing while its content table has
/// indexable text — the "table present, index empty" state that makes a wiki
/// permanently unsearchable.
///
/// The obvious checks are both useless here, and were both verified against
/// SQLite rather than assumed:
///   * `count(*) FROM wiki_pages_fts` reads the CONTENT table on an
///     external-content index, so it reports a healthy 1 for an index that
///     matches nothing.
///   * FTS5's own `integrity-check` also passes on an empty index — it
///     verifies internal index consistency, and with an external content
///     table there is nothing to compare against.
///
/// `fts5vocab` is the one view that reflects the real index: its term count
/// goes to zero exactly when the index is emptied. It is created in `temp`
/// so no schema residue is left behind. Any failure is read as drift — a
/// rebuild is always safe, a silently unsearchable wiki is not.
fn wiki_fts_index_drifted(conn: &Connection) -> DbResult<bool> {
    let has_content: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM wiki_pages
                       WHERE body <> '' OR title <> '' OR summary <> '')",
        [],
        |r| r.get(0),
    )?;
    if has_content == 0 {
        return Ok(false);
    }
    let probe = conn.execute_batch(
        "CREATE VIRTUAL TABLE temp.fts_drift_vocab USING fts5vocab(wiki_pages_fts, 'row');",
    );
    if probe.is_err() {
        return Ok(true);
    }
    let terms: i64 = conn
        .query_row("SELECT count(*) FROM temp.fts_drift_vocab", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    let _ = conn.execute_batch("DROP TABLE IF EXISTS temp.fts_drift_vocab;");
    Ok(terms == 0)
}

// ---- re-exports (so all existing callers using `crate::db::<fn>` still compile) ----

// projects
pub use projects::{
    add_project, get_project, list_projects, remove_project, rename_project, set_git_repo,
};

// sessions
pub use projects::{
    create_session, delete_session, get_session_with_project, list_sessions,
    set_session_harness_id, touch_session, update_session_title,
};

// settings
pub use settings::{delete_setting, get_setting, set_setting};

// project wiki (§6.15)
pub use wiki::{
    clear_build_stamp as wiki_clear_build_stamp, clear_pages as wiki_clear_pages,
    ensure_project as wiki_ensure_project, evidence_paths as wiki_evidence_paths,
    get_page_full as wiki_get_page_full,
    get_project_by_path as wiki_get_project_by_path, list_pages as wiki_list_pages,
    list_project_summaries as wiki_list_project_summaries,
    list_projects as wiki_list_projects, mark_pages_rebuilding as wiki_mark_pages_rebuilding,
    page_brief as wiki_page_brief, page_count as wiki_page_count,
    pages_without_evidence as wiki_pages_without_evidence, remove_wiki as wiki_remove_wiki,
    remove_wiki_by_path_prefix as wiki_remove_wiki_by_path_prefix,
    replace_page as wiki_replace_page, search_pages as wiki_search_pages,
    set_page_status as wiki_set_page_status, stamp_build as wiki_stamp_build,
    stamp_update as wiki_stamp_update, WikiClaim, WikiPage, WikiPageFull, WikiProject,
    WikiProjectSummary, WikiSearchHit, WIKI_SCHEMA_VERSION,
};

// skills
pub use skills::{create_skill, delete_skill, list_skills, update_skill};

// quick_actions
pub use skills::{
    create_quick_action, delete_quick_action, list_quick_actions, update_quick_action,
};

// secrets
pub use secrets::{delete_secret_row, get_secret_blob, list_secret_keys, upsert_secret_row};

// cost
pub use cost::{get_cost_events, insert_cost_event};
pub use cost_v2::{
    get_cost_rollups_v2, read_rate_overrides, record_observed_pricing,
};

// chat
pub use chat::{
    add_chat_message, add_chat_session_connector, add_command_chat_message,
    add_user_chat_message, chat_worktree_paths,
    create_chat_session, delete_chat_message, delete_chat_messages_after, delete_chat_session,
    delete_chat_sessions_for_project, delete_empty_chat_sessions, fork_chat_session,
    get_chat_session,
    latest_local_session_working_root, list_active_chat_messages, list_chat_messages,
    list_chat_messages_page, list_chat_session_connectors, list_chat_sessions,
    list_messages_superseded_by, mark_branch_superseded, mark_superseded,
    permission_label_from_policies, remove_chat_session_connector, search_chat_messages,
    set_chat_session_agent_def, set_chat_session_auto, set_chat_session_connectors,
    set_chat_session_cwd_override,
    set_chat_session_plan, set_chat_session_project, set_chat_session_starred,
    set_chat_session_unread, set_chat_session_worktree, touch_chat_session,
    un_mark_branch_superseded, update_chat_message_content, update_chat_session_agent, update_chat_session_effort,
    update_chat_session_model, update_chat_session_permission_mode, update_chat_session_policies,
    update_chat_session_provider, update_chat_session_title, update_chat_session_watch_mode,
    NewChatMessage,
};

// artifacts
pub use artifacts::{
    artifact_claimed_by_other_since, attach_artifacts_to_message, delete_artifact,
    delete_expired_artifacts, delete_temp_like_artifacts, insert_artifact, list_artifacts,
    list_artifacts_for_chat, list_artifacts_for_message,
};

// source ledger (research mode)
pub use source_ledger::{add_source_note, clear_source_notes, list_source_notes};

// research caches + query history (research mode)
pub use research_cache::{
    cacheable_engines, canonical_url_key, citation_quality_trend, clear_searches, content_hash,
    latest_citation_detail, page_cache_get, page_cache_put, purge_expired, record_search,
    save_citation_report, search_cache_get, search_cache_put, CitationQualityPoint,
    PAGE_CACHE_TTL_SECS, SEARCH_CACHE_TTL_SECS,
};

pub use docs::{
    add_corpus, any_searchable_corpus, attach_corpus_to_chat, attached_corpus_ids,
    blob_to_f32_slice, count_chunks, delete_chunks_for_file, delete_indexed_files_not_in,
    detach_corpus_from_chat, f32_slice_to_blob, finish_index, get_corpus, get_corpus_by_path,
    list_corpora, list_indexed_files, remove_corpus, replace_file_chunks, search_chunks,
    search_chunks_hybrid, search_chunks_in_corpus, set_corpus_enabled,
    stamp_corpus_chunk_version, corpus_chunk_version, upsert_indexed_file, ChunkHit, DocCorpus,
    DOCS_CHUNK_SCHEMA_VERSION,
};

// chat checkpoints (per-turn git working-tree snapshots)
pub use checkpoints::{
    checkpoint_ref_paths, checkpoint_session_ids, checkpoints_older_than,
    chat_session_repo_path, count_chat_checkpoints, delete_checkpoint, get_checkpoint,
    insert_checkpoint, latest_checkpoint, list_chat_checkpoints, oldest_turn_checkpoints,
    set_checkpoint_ref,
};

// connector credentials (app-scoped OAuth tokens; values in keychain)
pub use connector_credentials::{
    delete_connector_credential_row, get_connector_credential_row, list_connector_credential_rows,
    upsert_connector_credential_row, ConnectorCredentialRow,
};

// workspaces (pane layout save/restore)
pub use workspaces::{
    create_workspace, delete_workspace, get_workspace, list_workspaces, update_workspace,
};

// automations (scheduled headless agent runs)
pub use automations::{
    count_runs_for, create_automation, delete_automation, finish_run, get_automation,
    list_automations, list_runs_for, record_run, record_status, set_automation_chat_session,
    set_automation_enabled, set_automation_trigger_state, start_run, update_automation,
    Automation, AutomationInput, AutomationRun,
};

// subagent (declarative subagents — the persisted agent registry)
pub use subagents::{
    create_subagent, delete_subagent, find_subagent_by_name, find_subagent_by_source_path,
    finish_subagent_run, list_subagents_by_source, set_subagent_origin,
    set_subagent_source_path, set_subagent_run_worktree, sweep_stale_subagent_runs,
    get_subagent, list_subagents, list_subagent_runs, record_subagent_run,
    seed_builtin_subagents, update_subagent, Subagent, SubagentInput, SubagentRun,
};

// persistent user memory (MEMORY_DESIGN_ARCHITECTURE.md §9)
pub use memory::{
    active_memories_for_scope, add_memory_evidence, bump_memory_access, count_active_memories,
    delete_memory, evidence_count_for_memory, evidence_for_memory, flag_unbacked_memories,
    get_cursor, get_memory, insert_document_version, insert_memory, list_document_versions,
    list_memories, list_memory_ops, log_memory_op, mark_reflected, memories_missing_embedding,
    purge_memories_for_profile, search_memories_fts, set_memory_embedding, set_memory_status,
    similar_active_memories, supersede_memory, unreflected_sample, unreflected_stats,
    update_memory_content, upsert_cursor, MemoryDocVersionRow, MemoryOpRow,
};

// ---- test helpers ----

/// Creates an in-memory `Connection`, configures foreign_keys, and runs
/// `init_schema`, so submodule tests can always start from a clean DB.
#[cfg(test)]
pub(crate) fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    init_schema(&conn).unwrap();
    // Run the post-schema migrations so the in-memory test DB matches the
    // production schema shape — in particular `migrate_chat_messages_perf`
    // adds the llm_time_ms / tool_time_ms / ttft_ms / tokens_per_second columns
    // that `add_chat_message` (and the perf-metrics UI) expect, and that the
    // streaming/code paths in chat/mod.rs and agent_sessions.rs persist into.
    // Without this, tests calling `add_chat_message` (whose signature now
    // carries the perf fields) hit "table chat_messages has no column named
    // llm_time_ms" — see db::chat::* and db::cost_v2::* tests.
    migrate_chat_session_flags(&conn).unwrap();
    migrate_chat_session_watch_mode(&conn).unwrap();
    migrate_chat_session_agent(&conn).unwrap();
    migrate_chat_session_project_id(&conn).unwrap();
    migrate_chat_session_permission_mode(&conn).unwrap();
    migrate_chat_session_worktree(&conn).unwrap();
    migrate_chat_session_cwd_override(&conn).unwrap();
    migrate_artifacts_message_id(&conn).unwrap();
    migrate_chat_messages_superseded(&conn).unwrap();
    migrate_cost_v2(&conn).unwrap();
    migrate_source_notes_metadata(&conn).unwrap();
    migrate_chat_messages_v2(&conn).unwrap();
    migrate_chat_messages_started_completed(&conn).unwrap();
    migrate_chat_messages_perf(&conn).unwrap();
    migrate_chat_message_kind(&conn).unwrap();
    migrate_chat_session_origin(&conn).unwrap();
    migrate_doc_chunks_heading(&conn).unwrap();
    migrate_doc_corpora_chunk_version(&conn).unwrap();
    migrate_doc_chunks_fts(&conn).unwrap();
    migrate_unc_paths(&conn).unwrap();
    // The 7 builtin subagent roles are part of the production schema shape, so
    // tests that resolve a name against the registry see them too.
    migrate_subagents_seed(&conn).unwrap();
    migrate_subagents_origin(&conn).unwrap();
    // Same for the subagent-run link column: tests that subagent-spawn (or assert the
    // FK's ON DELETE SET NULL) need it present.
    migrate_chat_session_agent_def(&conn).unwrap();
    llm_log::ensure_schema(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Knowledge corpora kept storing `std::fs::canonicalize`'s verbatim
    /// `\\?\D:\…` prefix long after projects/sessions were normalized —
    /// the Knowledge panel showed the raw prefix and the rows read as
    /// foreign. The migration must rewrite them (once, idempotently) while
    /// leaving already-plain paths and network-share forms alone.
    #[test]
    #[cfg(windows)]
    fn migrate_unc_paths_rewrites_verbatim_corpus_paths() {
        let conn = mem();
        let verbatim = super::docs::add_corpus(
            &conn,
            r"\\?\D:\projects\Ultimate-workspace",
            "Ultimate-workspace",
        )
        .unwrap();
        let plain = super::docs::add_corpus(&conn, r"D:\projects\trading", "trading").unwrap();
        let unc = super::docs::add_corpus(&conn, r"\\?\UNC\server\share", "nas").unwrap();

        // Re-run: the migration is idempotent (runs on every configure).
        super::migrate_unc_paths(&conn).unwrap();

        let read = |id: &str| -> String {
            conn.query_row("SELECT path FROM doc_corpora WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(read(&verbatim.id), r"D:\projects\Ultimate-workspace");
        assert_eq!(read(&plain.id), r"D:\projects\trading");
        // SUBSTR would mangle a share path into `UNC\server\share` — it must
        // stay verbatim (walkdir accepts the form; only display keeps it).
        assert_eq!(read(&unc.id), r"\\?\UNC\server\share");
    }

    /// Subagent-run sessions link to their definition through `agent_def_id` with
    /// ON DELETE SET NULL: deleting the definition must keep the sessions (a
    /// subagent run's transcript is the user's data) and only clear the pointer.
    /// A database from BEFORE the subagent rename (crew_agents/crew_runs with
    /// rows) must survive a full `configure()` — this is the exact crash
    /// reported dead-on-start: init_schema created a fresh empty `subagents`
    /// beside the legacy table, and the rename died on the name collision.
    #[test]
    fn configure_renames_a_legacy_crew_database_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        // The pre-rename registry shape (pre-origin-migration columns; the
        // origin ALTER inside configure must tolerate the column existing).
        conn.execute(
            "CREATE TABLE crew_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,              description TEXT NOT NULL DEFAULT '', prompt_md TEXT NOT NULL DEFAULT '',              tools TEXT, engine TEXT, model TEXT, effort TEXT,              sandbox_policy TEXT NOT NULL DEFAULT 'read_only',              approval_policy TEXT NOT NULL DEFAULT 'on_request',              worktree_policy TEXT NOT NULL DEFAULT 'inherit',              max_rounds INTEGER NOT NULL DEFAULT 100,              max_concurrent INTEGER NOT NULL DEFAULT 2,              builtin INTEGER NOT NULL DEFAULT 0,              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE crew_runs (id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT,              trigger TEXT NOT NULL, task TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL DEFAULT '',              model TEXT NOT NULL DEFAULT '', worktree TEXT, started_at INTEGER NOT NULL DEFAULT 0,              finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running', summary TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO crew_agents (id, name, prompt_md, created_at, updated_at)              VALUES ('a-1', 'doc-writer', 'You write docs.', 1, 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO crew_runs (id, agent_id, trigger, task, started_at)              VALUES ('r-1', 'a-1', 'manual', 'test task', 0)",
            [],
        )
        .unwrap();

        configure(&conn).unwrap();

        // The user's row rode the rename; the fresh builtins are seeded
        // alongside it; the run history is queryable under the new name.
        let mine: String = conn
            .query_row("SELECT prompt_md FROM subagents WHERE id = 'a-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(mine, "You write docs.");
        let builtins: i64 = conn
            .query_row("SELECT COUNT(*) FROM subagents WHERE builtin = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(builtins >= 7);
        let runs: i64 = conn
            .query_row("SELECT COUNT(*) FROM subagent_runs WHERE agent_id = 'a-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(runs, 1);
        // No legacy tables left, and FKs are consistent.
        let legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'                  AND name IN ('crew_agents', 'crew_runs')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0);
        // Zero rows from foreign_key_check = no violations (query_row would
        // error on the empty set, so count instead).
        let fk_violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(fk_violations, 0);
    }

    /// The crashed first boot left BOTH tables on disk: init_schema's fresh
    /// empty `subagents` beside the legacy `crew_agents`. configure() must
    /// recover — drop the empty fresh table, rename the legacy one in.
    #[test]
    fn configure_recovers_from_a_half_renamed_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE crew_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL,              description TEXT NOT NULL DEFAULT '', prompt_md TEXT NOT NULL DEFAULT '',              tools TEXT, engine TEXT, model TEXT, effort TEXT,              sandbox_policy TEXT NOT NULL DEFAULT 'read_only',              approval_policy TEXT NOT NULL DEFAULT 'on_request',              worktree_policy TEXT NOT NULL DEFAULT 'inherit',              max_rounds INTEGER NOT NULL DEFAULT 100,              max_concurrent INTEGER NOT NULL DEFAULT 2,              builtin INTEGER NOT NULL DEFAULT 0,              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO crew_agents (id, name, prompt_md, created_at, updated_at)              VALUES ('a-1', 'doc-writer', 'You write docs.', 1, 2)",
            [],
        )
        .unwrap();
        // What the crashed boot left behind: the new tables, created empty
        // by init_schema with the FULL new DDL (that's why the recovery can
        // drop them outright — they hold nothing and miss no migration).
        conn.execute(
            "CREATE TABLE subagents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,              description TEXT NOT NULL DEFAULT '', prompt_md TEXT NOT NULL DEFAULT '',              tools TEXT, engine TEXT, model TEXT, effort TEXT,              sandbox_policy TEXT NOT NULL DEFAULT 'read_only',              approval_policy TEXT NOT NULL DEFAULT 'on_request',              worktree_policy TEXT NOT NULL DEFAULT 'inherit',              max_rounds INTEGER NOT NULL DEFAULT 100,              max_concurrent INTEGER NOT NULL DEFAULT 2,              builtin INTEGER NOT NULL DEFAULT 0,              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            [],
        )
        .unwrap();

        configure(&conn).unwrap();

        let name: String = conn
            .query_row("SELECT name FROM subagents WHERE id = 'a-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name, "doc-writer");
        let legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'crew_agents'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0);
    }

    #[test]
    fn agent_def_id_round_trips_and_survives_agent_deletion() {
        let conn = mem();
        let agent = crate::chat::subagents::create(
            &conn,
            &crate::chat::subagents::SubagentInput {
                name: "test-runner".into(),
                description: "test fixture".into(),
                prompt_md: String::new(),
                tools: None,
                engine: Some("builtin".into()),
                model: Some("openai::gpt-test".into()),
                effort: None,
                sandbox_policy: "read_only".into(),
                approval_policy: "on_request".into(),
                worktree_policy: "never".into(),
                max_rounds: 100,
                max_concurrent: 2,
            },
        )
        .unwrap();
        let sess = create_chat_session(&conn, "openai", "m", None).unwrap();
        set_chat_session_agent_def(&conn, &sess.id, Some(&agent.id)).unwrap();
        let row = get_chat_session(&conn, &sess.id).unwrap().unwrap();
        assert_eq!(row.agent_def_id.as_deref(), Some(agent.id.as_str()));
        // Delete the definition: the session survives, the pointer clears.
        crate::chat::subagents::delete(&conn, &agent.id).unwrap();
        let after = get_chat_session(&conn, &sess.id).unwrap().unwrap();
        assert_eq!(after.agent_def_id, None);
    }

    #[test]
    fn db_file_prefers_new_name_and_falls_back_to_legacy() {
        let tmp = std::env::temp_dir().join(format!("relay-db-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Fresh dir → new name.
        assert_eq!(db_file_in(&tmp), tmp.join("relay.db"));
        // Only the pre-rebrand file exists → keep using it (no data moved
        // behind the user's back).
        std::fs::write(tmp.join("conduit.db"), b"x").unwrap();
        assert_eq!(db_file_in(&tmp), tmp.join("conduit.db"));
        // Both exist → new name wins.
        std::fs::write(tmp.join("relay.db"), b"x").unwrap();
        assert_eq!(db_file_in(&tmp), tmp.join("relay.db"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn schema_creates_idempotently() {
        let conn = mem();
        init_schema(&conn).unwrap(); // second run must not error
    }

    #[test]
    fn agent_migration_backfills_only_when_column_is_new() {
        // M14 regression: the provider backfill used to run on EVERY startup,
        // clobbering intentionally-NULL (unselected) chats back to 'builtin'.
        let conn = Connection::open_in_memory().unwrap();
        // Minimal pre-migration schema: provider exists, agent does not.
        conn.execute_batch(
            "CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, provider TEXT);
             INSERT INTO chat_sessions (id, provider) VALUES (1, 'anthropic'), (2, 'local_gguf');",
        )
        .unwrap();

        // First run: the ALTER adds the column → pre-existing rows backfill.
        migrate_chat_session_agent(&conn).unwrap();
        let a1: String = conn
            .query_row("SELECT agent FROM chat_sessions WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let a2: String = conn
            .query_row("SELECT agent FROM chat_sessions WHERE id = 2", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(a1, "builtin");
        assert_eq!(a2, "local");

        // A chat created after the migration starts intentionally NULL…
        conn.execute(
            "INSERT INTO chat_sessions (id, provider, agent) VALUES (3, 'anthropic', NULL)",
            [],
        )
        .unwrap();
        // …and the every-startup re-run must leave that NULL (and the
        // backfilled values) alone.
        migrate_chat_session_agent(&conn).unwrap();
        let a3: Option<String> = conn
            .query_row("SELECT agent FROM chat_sessions WHERE id = 3", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(a3, None, "re-run clobbered an intentional NULL agent");
        let a1: String = conn
            .query_row("SELECT agent FROM chat_sessions WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(a1, "builtin");
    }
}
