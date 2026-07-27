//! SQLite persistence layer (PRD §6.3 + CONTRACT.md).
//!
//! The DB lives at `<app_data_dir>/conduit.db`. All query functions take a
//! `&Connection` so they can be unit-tested against an in-memory database
//! (`:memory:`) — the app itself holds one shared connection behind a mutex.
//!
//! Why SQLite for this data and not JSON: sessions/cost events need querying
//! (search, filtering, cost rollups) per PRD §6.1.

mod artifacts;
mod chat;
mod connector_credentials;
mod cost;
mod projects;
mod secrets;
mod settings;
mod skills;
mod source_ledger;
mod workspaces;

use rusqlite::Connection;
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

/// Open (or create) the on-disk database and ensure the schema exists.
pub fn open(path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
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
    init_schema(conn)?;
    migrate_chat_session_flags(conn)?;
    migrate_chat_session_permission_mode(conn)?;
    migrate_chat_session_watch_mode(conn)?;
    migrate_artifacts_message_id(conn)?;
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

/// Add the `permission_mode` column to `chat_sessions` on databases created
/// before the permission-mode selector existed. `ALTER TABLE … ADD COLUMN`
/// errors if the column is already present, so a duplicate-column error is a
/// no-op. Existing rows default to `'manual'` (the safe posture every new
/// chat starts in); the column is nullable so the migration also tolerates a
/// half-applied state.
fn migrate_chat_session_permission_mode(conn: &Connection) -> DbResult<()> {
    let sql = "ALTER TABLE chat_sessions ADD COLUMN permission_mode TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }
    // Backfill any NULL/empty rows to the explicit default.
    conn.execute(
        "UPDATE chat_sessions SET permission_mode = 'manual' WHERE permission_mode IS NULL OR permission_mode = ''",
        [],
    )?;
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
          estimated_cost_usd REAL
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
          permission_mode TEXT NOT NULL DEFAULT 'manual',
          watch_mode TEXT
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id, id);
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
pub use settings::{get_setting, set_setting};

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
    get_cost_events, get_cost_rollups, insert_cost_event,
};

// chat
pub use chat::{
    add_chat_message, create_chat_session, delete_chat_session, get_chat_session,
    list_chat_messages, list_chat_sessions, list_chat_session_connectors,
    set_chat_session_connectors, set_chat_session_starred, set_chat_session_unread,
    touch_chat_session, update_chat_session_model, update_chat_session_permission_mode,
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

// ---- test helpers ----

/// Creates an in-memory `Connection`, configures foreign_keys, and runs
/// `init_schema`, so submodule tests can always start from a clean DB.
#[cfg(test)]
pub(crate) fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    init_schema(&conn).unwrap();
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
}