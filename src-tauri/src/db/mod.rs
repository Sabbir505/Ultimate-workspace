//! SQLite persistence layer (PRD §6.3 + CONTRACT.md).
//!
//! The DB lives at `<app_data_dir>/conduit.db`. All query functions take a
//! `&Connection` so they can be unit-tested against an in-memory database
//! (`:memory:`) — the app itself holds one shared connection behind a mutex.
//!
//! Why SQLite for this data and not JSON: sessions/cost events need querying
//! (search, filtering, cost rollups) per PRD §6.1.

mod artifacts;
mod automations;
mod chat;
mod connector_credentials;
mod cost;
mod cost_v2;
mod projects;
mod secrets;
mod settings;
mod skills;
mod source_ledger;
mod workspaces;

use rusqlite::Connection;
use std::path::Path;
use tauri::Manager;
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

/// Open (or create) the on-disk database and ensure the schema exists.
pub fn open(path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// Absolute path of the chat database. Defaults to `<app data dir>/conduit.db` —
/// overridable via the `storage.dbDir` setting (Settings → Data), which must
/// be read from the CURRENT database before a move. Returns an `io::Error`
/// when the app data dir cannot be resolved.
pub fn chat_db_path(app: &tauri::AppHandle) -> std::io::Result<std::path::PathBuf> {
    let default_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string()))?;
    let default = default_dir.join("conduit.db");
    // The setting lives IN the DB, so resolve it by peeking at the default
    // location's DB (which always exists — it's created at first launch).
    if let Ok(conn) = Connection::open(&default) {
        if let Ok(Some(dir)) = settings::get_setting(&conn, "storage.dbDir") {
            let dir = dir.trim();
            if !dir.is_empty() {
                return Ok(std::path::PathBuf::from(dir).join("conduit.db"));
            }
        }
    }
    Ok(default)
}

/// One-time cleanup for rows written before the \\?\ prefix fix: early
/// versions stored canonicalized `\\?\D:\...` project paths, which cmd.exe
/// cannot use as a working directory. Rewriting in place keeps the row ids
/// (and their sessions) intact. No-op on POSIX.
#[cfg(windows)]
fn migrate_unc_paths(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        r"
        UPDATE projects SET path = SUBSTR(path, 5) WHERE path LIKE '\\?\%';
        UPDATE sessions SET worktree_path = SUBSTR(worktree_path, 5)
          WHERE worktree_path LIKE '\\?\%';
        ",
    )?;
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
    init_schema(conn)?;
    migrate_chat_session_flags(conn)?;
    migrate_chat_session_watch_mode(conn)?;
    migrate_chat_session_agent(conn)?;
    migrate_chat_session_project_id(conn)?;
    migrate_artifacts_message_id(conn)?;
    migrate_chat_messages_superseded(conn)?;
    migrate_cost_v2(conn)?;
    migrate_chat_messages_v2(conn)?;
    migrate_chat_messages_started_completed(conn)?;
    migrate_chat_messages_perf(conn)?;
    migrate_unc_paths(conn)
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
    if column_added {
        conn.execute(
            "UPDATE chat_sessions SET agent = CASE WHEN provider = 'local_gguf' THEN 'local' ELSE 'builtin' END WHERE agent IS NULL",
            [],
        )?;
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
    if source_added && has_last_synced {
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
            eprintln!("[conduit] cost_v2: DROP COLUMN failed ({e}); column will be unused");
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
pub fn init_schema(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        "
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
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
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

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id, id);
        -- mi26: get_cost_rollups_v2 range-scans chat_messages by created_at
        -- every poll — previously a full-table scan + join per rollup call.
        CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_active ON chat_sessions(last_active_at DESC);

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

        -- Scheduled headless agent runs (see db/automations.rs +
        -- crate::automations). chat_session_id is the run log, bound lazily.
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
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL DEFAULT 'running',
          summary TEXT NOT NULL DEFAULT '',
          chat_session_id TEXT,
          source TEXT NOT NULL DEFAULT 'scheduled'
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_auto
          ON automation_runs(automation_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_running
          ON automation_runs(status) WHERE finished_at IS NULL;

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
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_source_notes_session ON chat_source_notes(chat_session_id, id);

        -- Prevent exact-duplicate source notes (same session + url + fact).
        CREATE UNIQUE INDEX IF NOT EXISTS uq_source_notes_dedup ON chat_source_notes(chat_session_id, url, fact);

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
        ",
    )
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

// skills
pub use skills::{
    create_skill, delete_skill, list_skills, update_skill,
};

// quick_actions
pub use skills::{
    create_quick_action, delete_quick_action, list_quick_actions, update_quick_action,
};

// secrets
pub use secrets::{
    delete_secret_row, get_secret_blob, list_secret_keys, upsert_secret_row,
};

// cost
pub use cost::{
    get_cost_events, insert_cost_event,
};
pub use cost_v2::{get_cost_rollups_v2, read_rate_overrides};

// chat
pub use chat::{
    add_chat_message, create_chat_session, delete_chat_message, delete_chat_session,
    delete_chat_sessions_for_project, delete_empty_chat_sessions,
    get_chat_session, list_active_chat_messages, list_chat_messages, list_chat_messages_page,
    list_chat_sessions,
    list_chat_session_connectors, mark_superseded, set_chat_session_connectors,
    set_chat_session_project, set_chat_session_starred, set_chat_session_unread,
    touch_chat_session, update_chat_session_agent, update_chat_session_model,
    update_chat_session_provider, update_chat_session_title, update_chat_session_watch_mode,
};

// artifacts
pub use artifacts::{
    attach_artifacts_to_message, delete_artifact, delete_expired_artifacts, insert_artifact,
    list_artifacts, list_artifacts_for_chat,
};

// source ledger (research mode)
pub use source_ledger::{add_source_note, clear_source_notes, list_source_notes};

// connector credentials (app-scoped OAuth tokens; values in keychain)
pub use connector_credentials::{
    delete_connector_credential_row, get_connector_credential_row,
    list_connector_credential_rows, upsert_connector_credential_row, ConnectorCredentialRow,
};

// workspaces (pane layout save/restore)
pub use workspaces::{
    create_workspace, delete_workspace, get_workspace, list_workspaces, update_workspace,
};

// automations (scheduled headless agent runs)
pub use automations::{
    count_runs_for, create_automation, delete_automation, finish_run, get_automation,
    list_automations, list_runs_for, record_run, record_status, set_automation_enabled,
    start_run, update_automation, Automation, AutomationInput, AutomationRun,
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
    migrate_artifacts_message_id(&conn).unwrap();
    migrate_chat_messages_superseded(&conn).unwrap();
    migrate_cost_v2(&conn).unwrap();
    migrate_chat_messages_v2(&conn).unwrap();
    migrate_chat_messages_started_completed(&conn).unwrap();
    migrate_chat_messages_perf(&conn).unwrap();
    migrate_unc_paths(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

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
            .query_row("SELECT agent FROM chat_sessions WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        let a2: String = conn
            .query_row("SELECT agent FROM chat_sessions WHERE id = 2", [], |r| r.get(0))
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
            .query_row("SELECT agent FROM chat_sessions WHERE id = 3", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a3, None, "re-run clobbered an intentional NULL agent");
        let a1: String = conn
            .query_row("SELECT agent FROM chat_sessions WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a1, "builtin");
    }
}