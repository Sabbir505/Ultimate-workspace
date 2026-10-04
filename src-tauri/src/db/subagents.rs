//! Subagents (declarative subagents) — persistence.
//!
//! One row per agent definition: a name, a markdown prompt body, a tool
//! allowlist, permission/engine/policy fields and a spawn budget. The 7
//! builtin roles are seeded rows (`builtin=1`) that hold the role instruction
//! text; everything else about how a run behaves is resolved by
//! `chat::subagent` (allowlist resolution, validation, the running set), so this
//! module stays a plain row store like `db/automations.rs`.
//!
//! A table rather than a settings blob: spawn surfaces validate against it by
//! id, a session row points at its agent through a string FK, and run history
//! will need it. `skills` is the structural precedent.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

/// Default policy values — mirrors the `subagents` DDL defaults so a
/// partial form (or an old client) lands on the same row the DDL would give.
const DEFAULT_SANDBOX_POLICY: &str = "read_only";
const DEFAULT_APPROVAL_POLICY: &str = "on_request";
const DEFAULT_WORKTREE_POLICY: &str = "inherit";
const DEFAULT_MAX_ROUNDS: i64 = 100;
const DEFAULT_MAX_CONCURRENT: i64 = 2;

/// A persisted agent definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    /// Also the `Task` `subagent_type` enum value. Unique COLLATE NOCASE.
    pub name: String,
    /// One line, used for auto-delegation hints in the tool schema.
    pub description: String,
    /// System-prompt body (markdown). Builtin roles carry the role
    /// instruction only; the runtime still composes it with the cwd line and
    /// the shared read-only boilerplate.
    pub prompt_md: String,
    /// JSON array of tool names; `None` = inherit the engine default.
    pub tools: Option<String>,
    /// `builtin` | `local` | `harness:<id>` | `acp:<id>`; `None` = inherit
    /// `chat.subagentModel` / the parent model.
    pub engine: Option<String>,
    /// `"model"` | `"provider::model"` | `"engine::model"`.
    pub model: Option<String>,
    /// Maps to the provider's reasoning-effort level.
    pub effort: Option<String>,
    /// `read_only` | `workspace_write` — also the allowlist ceiling's
    /// mutating half (see `chat::subagent::builtin_ceiling`).
    pub sandbox_policy: String,
    /// `on_request` | `auto_edit` | `full_access`.
    pub approval_policy: String,
    /// `inherit` | `always` | `never`.
    pub worktree_policy: String,
    /// Clamped to 1..=`chat::subagent::MAX_ROUNDS`.
    pub max_rounds: i64,
    /// Per-agent live-run budget.
    pub max_concurrent: i64,
    /// Seeded role — cannot be deleted and its name is reserved.
    pub builtin: bool,
    /// Who authored the row: NULL = the user (Subagent panel), 'agent' = a model
    /// created it through the subagent chat tool. Display-only — the Subagent panel
    /// badges it so the user can always see what their agents made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// The native `.md` this row was imported from, when it came from a CLI
    /// harness's own store (`~/.claude/agents/doc-writer.md`). NULL for
    /// builtin, hand-made and `.md`-imported rows.
    ///
    /// The link is what makes the native-store import an upsert rather than a
    /// copy: the sync resolves a file to its row by this path, so editing the
    /// file updates the definition in place instead of producing a second
    /// `-2` agent. The editor never writes it — `update_subagent` doesn't name
    /// the column, so saving a linked agent from the panel keeps the link
    /// without the form having to know it exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What the create/edit form sends: every field but `id`, `builtin` and the
/// timestamps. All fields are defaulted so the UI can post a partial form;
/// the defaults are the DDL's, not zero values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub prompt_md: String,
    /// JSON array string. `None` (or JSON `null`) clears the allowlist back
    /// to the engine default.
    #[serde(default)]
    pub tools: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default = "default_sandbox_policy")]
    pub sandbox_policy: String,
    #[serde(default = "default_approval_policy")]
    pub approval_policy: String,
    #[serde(default = "default_worktree_policy")]
    pub worktree_policy: String,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: i64,
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: i64,
}

fn default_sandbox_policy() -> String {
    DEFAULT_SANDBOX_POLICY.to_string()
}

fn default_approval_policy() -> String {
    DEFAULT_APPROVAL_POLICY.to_string()
}

fn default_worktree_policy() -> String {
    DEFAULT_WORKTREE_POLICY.to_string()
}

fn default_max_rounds() -> i64 {
    DEFAULT_MAX_ROUNDS
}

fn default_max_concurrent() -> i64 {
    DEFAULT_MAX_CONCURRENT
}

/// Tolerant row mapping: the defaulted/nullable columns fall back to the DDL
/// default when a row predates a column, so adding a column in a later
/// migration cannot break reads of older rows.
fn map_subagent(row: &Row) -> rusqlite::Result<Subagent> {
    let created_at: i64 = row.get("created_at")?;
    Ok(Subagent {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description").unwrap_or_else(|_| String::new()),
        prompt_md: row.get("prompt_md").unwrap_or_else(|_| String::new()),
        tools: row.get::<_, Option<String>>("tools").unwrap_or(None),
        engine: row.get::<_, Option<String>>("engine").unwrap_or(None),
        model: row.get::<_, Option<String>>("model").unwrap_or(None),
        effort: row.get::<_, Option<String>>("effort").unwrap_or(None),
        sandbox_policy: row
            .get("sandbox_policy")
            .unwrap_or_else(|_| DEFAULT_SANDBOX_POLICY.to_string()),
        approval_policy: row
            .get("approval_policy")
            .unwrap_or_else(|_| DEFAULT_APPROVAL_POLICY.to_string()),
        worktree_policy: row
            .get("worktree_policy")
            .unwrap_or_else(|_| DEFAULT_WORKTREE_POLICY.to_string()),
        max_rounds: row.get("max_rounds").unwrap_or(DEFAULT_MAX_ROUNDS),
        max_concurrent: row.get("max_concurrent").unwrap_or(DEFAULT_MAX_CONCURRENT),
        builtin: row.get::<_, i64>("builtin").unwrap_or(0) != 0,
        origin: row.get::<_, Option<String>>("origin").unwrap_or(None),
        source_path: row
            .get::<_, Option<String>>("source_path")
            .unwrap_or(None)
            .filter(|s| !s.is_empty()),
        created_at,
        updated_at: row.get("updated_at").unwrap_or(created_at),
    })
}

const COLUMNS: &str = "id, name, description, prompt_md, tools, engine, model, effort, \
     sandbox_policy, approval_policy, worktree_policy, max_rounds, max_concurrent, builtin, \
     origin, source_path, created_at, updated_at";

/// Mark who authored a definition: NULL = the user (Subagent panel), "agent" = a
/// model created it through the subagent chat tool. Display-only — the Subagent panel
/// badges it so the user can always see what their agents made.
pub fn set_subagent_origin(
    conn: &Connection,
    agent_id: &str,
    origin: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE subagents SET origin = ?2 WHERE id = ?1",
        rusqlite::params![agent_id, origin],
    )?;
    Ok(())
}

/// Point a row at the native `.md` it was imported from — the upsert key for
/// the CLI-harness store sync. Setting the same path on a different row is
/// refused by the unique index, which is the point: one file, one row.
pub fn set_subagent_source_path(
    conn: &Connection,
    agent_id: &str,
    source_path: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE subagents SET source_path = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![agent_id, source_path, now_ts()],
    )?;
    Ok(())
}

/// The row a native `.md` is already linked to, if any. NOCASE to match the
/// unique index: on Windows and macOS `Doc.md` and `doc.md` are one file, and
/// a case-sensitive match here would let the sync create a duplicate row for a
/// file it already owns.
pub fn find_subagent_by_source_path(
    conn: &Connection,
    source_path: &str,
) -> DbResult<Option<Subagent>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM subagents WHERE source_path = ?1 COLLATE NOCASE"),
        params![source_path],
        map_subagent,
    )
    .optional()
}

/// Every row that is linked to a native store, with the path that links it.
/// The sync's starting set: the files it finds minus these are the ones that
/// need importing.
pub fn list_subagents_by_source(conn: &Connection) -> DbResult<Vec<Subagent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM subagents WHERE source_path IS NOT NULL"
    ))?;
    let rows = stmt.query_map([], map_subagent)?;
    rows.collect()
}

/// Builtins first (the stable set the `Task` enum advertises), then user rows
/// by name.
pub fn list_subagents(conn: &Connection) -> DbResult<Vec<Subagent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM subagents ORDER BY builtin DESC, name COLLATE NOCASE ASC"
    ))?;
    let rows = stmt.query_map([], map_subagent)?;
    rows.collect()
}

pub fn get_subagent(conn: &Connection, id: &str) -> DbResult<Option<Subagent>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM subagents WHERE id = ?1"),
        params![id],
        map_subagent,
    )
    .optional()
}

/// Look one agent up by name, case-insensitively (the same rule the
/// `COLLATE NOCASE` unique index enforces), for the name-collision check.
pub fn find_subagent_by_name(conn: &Connection, name: &str) -> DbResult<Option<Subagent>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM subagents WHERE name = ?1 COLLATE NOCASE"),
        params![name],
        map_subagent,
    )
    .optional()
}

/// Insert a user-created definition. `input` must already be validated and
/// normalized by `chat::subagent::validate_input` — this layer does no policy
/// checks, exactly like `db/automations.rs`.
pub fn create_subagent(conn: &Connection, input: &SubagentInput) -> DbResult<Subagent> {
    let id = new_id();
    let ts = now_ts();
    conn.execute(
        "INSERT INTO subagents
           (id, name, description, prompt_md, tools, engine, model, effort,
            sandbox_policy, approval_policy, worktree_policy,
            max_rounds, max_concurrent, builtin, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?14)",
        params![
            id,
            input.name,
            input.description,
            input.prompt_md,
            input.tools,
            input.engine,
            input.model,
            input.effort,
            input.sandbox_policy,
            input.approval_policy,
            input.worktree_policy,
            input.max_rounds,
            input.max_concurrent,
            ts,
        ],
    )?;
    get_subagent(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Overwrite a definition's editable fields. `builtin`, `id` and
/// `created_at` are never touched. Returns the reloaded row so the caller
/// answers with what was actually persisted.
pub fn update_subagent(
    conn: &Connection,
    id: &str,
    input: &SubagentInput,
) -> DbResult<Option<Subagent>> {
    conn.execute(
        "UPDATE subagents SET
           name = ?2, description = ?3, prompt_md = ?4, tools = ?5, engine = ?6,
           model = ?7, effort = ?8, sandbox_policy = ?9, approval_policy = ?10,
           worktree_policy = ?11, max_rounds = ?12, max_concurrent = ?13, updated_at = ?14
         WHERE id = ?1",
        params![
            id,
            input.name,
            input.description,
            input.prompt_md,
            input.tools,
            input.engine,
            input.model,
            input.effort,
            input.sandbox_policy,
            input.approval_policy,
            input.worktree_policy,
            input.max_rounds,
            input.max_concurrent,
            now_ts(),
        ],
    )?;
    get_subagent(conn, id)
}

pub fn delete_subagent(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM subagents WHERE id = ?1", params![id])?;
    Ok(())
}

/// Insert one row verbatim. Used ONLY by the builtin seed, which owns its own
/// stable ids — `create_subagent` mints a uuid. Every column not named here
/// is left at its F.1 DDL default.
fn insert_row(conn: &Connection, id: &str, name: &str, prompt_md: &str) -> DbResult<()> {
    let ts = now_ts();
    conn.execute(
        "INSERT OR IGNORE INTO subagents
           (id, name, description, prompt_md, tools, engine, model, effort,
            sandbox_policy, approval_policy, worktree_policy,
            max_rounds, max_concurrent, builtin, created_at, updated_at)
         VALUES (?1, ?2, '', ?3, NULL, NULL, NULL, NULL, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
        params![
            id,
            name,
            prompt_md,
            DEFAULT_SANDBOX_POLICY,
            DEFAULT_APPROVAL_POLICY,
            DEFAULT_WORKTREE_POLICY,
            DEFAULT_MAX_ROUNDS,
            DEFAULT_MAX_CONCURRENT,
            ts,
        ],
    )?;
    Ok(())
}

/// Seed the 7 builtin roles as `builtin=1` rows with stable `builtin-<role>`
/// ids and the role instruction text as the prompt body. Every other column
/// is left at the F.1 DDL default: empty description (the role NAME is the
/// label), read-only sandbox, on-request approval, inherited worktree, 100
/// rounds, 2 concurrent, and no tool allowlist (`tools = NULL` = the engine's
/// read-only default — the same set today's `Task` subagents get).
///
/// `INSERT OR IGNORE` keyed on the id makes this idempotent AND
/// non-destructive: re-running after a cleared `subagent.seed.v1` marker refreshes
/// nothing a user (or a later edit) changed, and never duplicates. The
/// instructions come from `chat::subagent::BUILTIN_ROLES` — the same table
/// `dispatch.rs` reads at runtime, so the seed and the runtime can never
/// disagree.
pub fn seed_builtin_subagents(conn: &Connection) -> DbResult<()> {
    for role in crate::chat::subagents::BUILTIN_ROLES {
        insert_row(
            conn,
            &format!("builtin-{}", role.name),
            role.name,
            role.instruction,
        )?;
    }
    Ok(())
}

// ---- subagent run history (Phase 5) ----

/// One subagent RUN (a spawned session's lifecycle). Dangling ids are legal on
/// purpose — history outlives a deleted agent or chat, and the UI renders
/// those as "deleted agent"/"deleted chat" instead of hiding the rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
    pub id: String,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    /// `manual` | `task` | `mesh` | `automation`.
    pub trigger: String,
    pub task: String,
    pub engine: String,
    pub model: String,
    pub worktree: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// `running` | `ok` | `error` | `cancelled` — the same vocabulary the
    /// automations runs table and the frontend's status chips use.
    pub status: String,
    pub summary: Option<String>,
}

fn map_subagent_run(row: &rusqlite::Row) -> rusqlite::Result<SubagentRun> {
    Ok(SubagentRun {
        id: row.get("id")?,
        agent_id: row.get("agent_id")?,
        session_id: row.get("session_id")?,
        trigger: row.get("trigger")?,
        task: row.get("task")?,
        engine: row.get("engine")?,
        model: row.get("model")?,
        worktree: row.get("worktree")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        status: row.get("status")?,
        summary: row.get("summary")?,
    })
}

/// Persist a new run row at spawn time (status `running`).
pub fn record_subagent_run(conn: &Connection, run: &SubagentRun) -> DbResult<()> {
    conn.execute(
        "INSERT INTO subagent_runs (id, agent_id, session_id, trigger, task, engine, model, \
         worktree, started_at, finished_at, status, summary) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            run.id,
            run.agent_id,
            run.session_id,
            run.trigger,
            run.task,
            run.engine,
            run.model,
            run.worktree,
            run.started_at,
            run.finished_at,
            run.status,
            run.summary,
        ],
    )?;
    Ok(())
}

/// Settle a run row when its first turn ends (or fails). Best-effort by
/// design — losing a history row's end timestamp must never fail a run.
///
/// The `status = 'running'` guard makes the FIRST settle final: the release
/// watcher and the fail-fast path can both fire (with no ordering
/// guarantee), and an unconditional UPDATE would let the watcher's late
/// "ok" overwrite an "error" that was already recorded.
pub fn finish_subagent_run(
    conn: &Connection,
    run_id: &str,
    status: &str,
    summary: Option<&str>,
) {
    let _ = conn.execute(
        "UPDATE subagent_runs SET finished_at = ?2, status = ?3, \
         summary = COALESCE(?4, summary) WHERE id = ?1 AND status = 'running'",
        rusqlite::params![run_id, crate::db::now_ts(), status, summary],
    );
}

/// Fill a run row's worktree column once provisioning has settled. The row
/// is written at spawn time, BEFORE the worktree exists (or before the
/// provisioning fell back to the project root), so this is the only writer
/// that ever sees a path. Best-effort, like every history write.
pub fn set_subagent_run_worktree(conn: &Connection, run_id: &str, worktree: Option<&str>) {
    let _ = conn.execute(
        "UPDATE subagent_runs SET worktree = ?2 WHERE id = ?1",
        rusqlite::params![run_id, worktree],
    );
}

/// Settle `running` rows a dead process left behind. The live-run registry
/// and the release watchers are per-process, so after a crash (or a kill
/// mid-run) rows stay `running` forever — at BOOT this sweep settles any
/// row older than the watchers' own release ceiling, an age no legitimately
/// live run can still be at (the watcher gives up by then). Rows younger
/// than the ceiling are left alone: a second concurrently-running instance
/// of the app may own them.
pub fn sweep_stale_subagent_runs(conn: &Connection, max_age_secs: i64) {
    let cutoff = crate::db::now_ts() - max_age_secs;
    let settled = conn
        .execute(
            "UPDATE subagent_runs SET finished_at = ?1, status = 'error', \
             summary = COALESCE(summary, 'interrupted — the app exited mid-run') \
             WHERE status = 'running' AND started_at <= ?2",
            rusqlite::params![crate::db::now_ts(), cutoff],
        )
        .map(|n| n as i64)
        .unwrap_or(0);
    if settled > 0 {
        crate::relay_eprintln!("[subagent] settled {settled} stale running row(s) left by a previous process");
    }
}

/// Newest-first run history, optionally filtered to one agent.
pub fn list_subagent_runs(
    conn: &Connection,
    agent_id: Option<&str>,
    limit: i64,
) -> DbResult<Vec<SubagentRun>> {
    let limit = limit.clamp(1, 200);
    let sql = |filtered: bool| {
        if filtered {
            (
                "SELECT id, agent_id, session_id, trigger, task, engine, model, worktree, \
                 started_at, finished_at, status, summary \
                 FROM subagent_runs WHERE agent_id = ?1 ORDER BY started_at DESC LIMIT ?2",
                2,
            )
        } else {
            (
                "SELECT id, agent_id, session_id, trigger, task, engine, model, worktree, \
                 started_at, finished_at, status, summary \
                 FROM subagent_runs ORDER BY started_at DESC LIMIT ?1",
                1,
            )
        }
    };
    let mut out = Vec::new();
    if let Some(agent) = agent_id {
        let mut stmt = conn.prepare(sql(true).0)?;
        let rows = stmt.query_map(rusqlite::params![agent, limit], map_subagent_run)?;
        for r in rows {
            out.push(r?);
        }
    } else {
        let mut stmt = conn.prepare(sql(false).0)?;
        let rows = stmt.query_map(rusqlite::params![limit], map_subagent_run)?;
        for r in rows {
            out.push(r?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::subagents::BUILTIN_ROLES;

    fn input(name: &str) -> SubagentInput {
        SubagentInput {
            name: name.into(),
            description: "d".into(),
            prompt_md: "p".into(),
            tools: None,
            engine: None,
            model: None,
            effort: None,
            sandbox_policy: DEFAULT_SANDBOX_POLICY.into(),
            approval_policy: DEFAULT_APPROVAL_POLICY.into(),
            worktree_policy: DEFAULT_WORKTREE_POLICY.into(),
            max_rounds: DEFAULT_MAX_ROUNDS,
            max_concurrent: DEFAULT_MAX_CONCURRENT,
        }
    }

    /// The 7 role names must be exactly the `Task` schema's `subagent_type`
    /// enum values (`specs.rs::task_parameters`) — the registry and the tool
    /// schema are two views of one set.
    #[test]
    fn seed_matches_task_role_enum() {
        const TASK_ROLES: [&str; 7] = [
            "explore", "edit", "analyze", "research", "write", "test", "refactor",
        ];
        let seeded: Vec<&str> = BUILTIN_ROLES.iter().map(|r| r.name).collect();
        assert_eq!(seeded, TASK_ROLES.to_vec());
    }

    #[test]
    fn finish_subagent_run_first_settle_wins_and_worktree_backfills() {
        // Regression (two defects, one row): (1) the idle watcher and the
        // fail-fast path can both settle a run with no ordering guarantee,
        // and an unconditional UPDATE let the watcher's late "ok" overwrite
        // an "error" that was already recorded — the first settle must be
        // final. (2) The worktree column is written at spawn (before
        // provisioning exists) and must be backfillable afterwards.
        let conn = super::super::mem();
        let run = SubagentRun {
            id: "run-1".into(),
            agent_id: Some("subagent-a".into()),
            session_id: Some("s1".into()),
            trigger: "manual".into(),
            task: "t".into(),
            engine: "builtin".into(),
            model: "m".into(),
            worktree: None,
            started_at: 1,
            finished_at: None,
            status: "running".into(),
            summary: None,
        };
        record_subagent_run(&conn, &run).unwrap();
        // The fail-fast path settles an error first…
        finish_subagent_run(&conn, "run-1", "error", Some("first turn failed"));
        // …the late idle watcher then settles "ok" — must be a no-op.
        finish_subagent_run(&conn, "run-1", "ok", None);
        let row = list_subagent_runs(&conn, None, 10).unwrap().remove(0);
        assert_eq!(row.status, "error");
        assert_eq!(row.summary.as_deref(), Some("first turn failed"));
        assert!(row.finished_at.is_some(), "the first settle stamped the end time");
        // Provisioning finished after the row was written → backfill.
        set_subagent_run_worktree(&conn, "run-1", Some("D:/repo/.worktrees/relay-run-1"));
        let row = list_subagent_runs(&conn, None, 10).unwrap().remove(0);
        assert_eq!(
            row.worktree.as_deref(),
            Some("D:/repo/.worktrees/relay-run-1")
        );
    }

    #[test]
    fn boot_sweep_settles_only_old_running_rows() {
        // The live-run registry is per-process, so a `running` row that
        // survives a restart is a crash leftover — but only rows older than
        // the watchers' release ceiling: a younger one may belong to a
        // concurrently running second instance of the app.
        let conn = super::super::mem();
        let mk = |id: &str, started: i64, status: &str| SubagentRun {
            id: id.into(),
            agent_id: Some("subagent-a".into()),
            session_id: None,
            trigger: "manual".into(),
            task: "t".into(),
            engine: "builtin".into(),
            model: "m".into(),
            worktree: None,
            started_at: started,
            finished_at: None,
            status: status.into(),
            summary: None,
        };
        let now = crate::db::now_ts();
        // A stale `running` row (older than the 2h ceiling), a fresh
        // `running` row, and an already-settled row.
        record_subagent_run(&conn, &mk("stale", now - 3 * 3600, "running")).unwrap();
        record_subagent_run(&conn, &mk("fresh", now, "running")).unwrap();
        record_subagent_run(
            &conn,
            &mk("done", now - 3 * 3600, "ok"),
        )
        .unwrap();

        super::sweep_stale_subagent_runs(&conn, 2 * 3600);

        let by_id = |id: &str| {
            list_subagent_runs(&conn, None, 50)
                .unwrap()
                .into_iter()
                .find(|r| r.id == id)
                .unwrap()
        };
        let stale = by_id("stale");
        assert_eq!(stale.status, "error", "a crash leftover settles as an error");
        assert!(stale.finished_at.is_some());
        assert!(stale.summary.unwrap().contains("interrupted"));
        // The fresh row (possibly a second instance's live run) and the
        // already-settled row are untouched.
        assert_eq!(by_id("fresh").status, "running");
        assert_eq!(by_id("done").status, "ok");
    }

    #[test]
    fn seed_is_idempotent_via_marker_and_insert_or_ignore() {
        let conn = super::super::mem();
        // mem() already ran the marker-guarded seed once.
        assert_eq!(count_builtins(&conn), 7);

        // Re-running through the marker is a no-op.
        super::super::migrate_subagents_seed(&conn).unwrap();
        assert_eq!(count_builtins(&conn), 7);

        // Clearing the marker forces the pass again: INSERT OR IGNORE keeps it
        // at exactly 7 (no duplicates, no clobber).
        conn.execute("DELETE FROM app_settings WHERE key = 'subagent.seed.v1'", [])
            .unwrap();
        super::super::migrate_subagents_seed(&conn).unwrap();
        assert_eq!(count_builtins(&conn), 7);

        // A user's edit to a builtin row survives a forced re-seed.
        conn.execute(
            "UPDATE subagents SET description = 'mine' WHERE id = 'builtin-explore'",
            [],
        )
        .unwrap();
        seed_builtin_subagents(&conn).unwrap();
        let row = get_subagent(&conn, "builtin-explore").unwrap().unwrap();
        assert_eq!(row.description, "mine");
        assert_eq!(count_builtins(&conn), 7);
    }

    #[test]
    fn seeded_rows_carry_the_f1_defaults() {
        let conn = super::super::mem();
        let rows = list_subagents(&conn).unwrap();
        assert_eq!(rows.len(), 7, "only the builtins exist on a fresh DB");
        for row in &rows {
            let role = BUILTIN_ROLES
                .iter()
                .find(|r| r.name == row.name)
                .unwrap_or_else(|| panic!("unknown role row {}", row.name));
            assert!(row.builtin);
            assert_eq!(row.id, format!("builtin-{}", role.name));
            assert_eq!(row.description, "", "F.1 default");
            assert_eq!(row.prompt_md, role.instruction);
            assert!(row.tools.is_none(), "NULL tools = engine default");
            assert!(row.engine.is_none() && row.model.is_none() && row.effort.is_none());
            assert_eq!(row.sandbox_policy, "read_only");
            assert_eq!(row.approval_policy, "on_request");
            assert_eq!(row.worktree_policy, "inherit");
            assert_eq!(row.max_rounds, 100);
            assert_eq!(row.max_concurrent, 2);
            assert!(row.created_at > 0 && row.updated_at > 0);
        }
    }

    fn count_builtins(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM subagents WHERE builtin = 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn crud_roundtrips_including_tools_json_and_none_preservation() {
        // mem() over bare init_schema: the mapper now reads the origin column
        // (migration-added), and the tolerant SELECT must not silently break
        // on a fixture that predates it.
        let conn = crate::db::mem();

        let mut inp = input("Doc Writer");
        inp.tools = Some(r#"["read_file","write_file"]"#.into());
        let created = create_subagent(&conn, &inp).unwrap();
        assert!(!created.builtin);
        assert_eq!(
            created.tools.as_deref(),
            Some(r#"["read_file","write_file"]"#)
        );
        // Columns the input left NULL stay NULL through a read-back.
        assert!(created.engine.is_none() && created.model.is_none() && created.effort.is_none());

        // Update swaps the allowlist; an explicit NULL clears it back to the
        // engine default rather than writing an empty array.
        let mut edit = input("Doc Writer");
        edit.tools = Some(r#"["read_file"]"#.into());
        edit.prompt_md = "you write docs".into();
        edit.sandbox_policy = "workspace_write".into();
        edit.max_rounds = 40;
        let updated = update_subagent(&conn, &created.id, &edit)
            .unwrap()
            .unwrap();
        assert_eq!(updated.tools.as_deref(), Some(r#"["read_file"]"#));
        assert_eq!(updated.prompt_md, "you write docs");
        assert_eq!(updated.sandbox_policy, "workspace_write");
        assert_eq!(updated.max_rounds, 40);
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.created_at, created.created_at, "immutable");

        edit.tools = None;
        let cleared = update_subagent(&conn, &created.id, &edit)
            .unwrap()
            .unwrap();
        assert!(cleared.tools.is_none(), "None must survive as SQL NULL");

        // The mem() fixture seeds the 7 builtins; exactly one user row exists.
        assert_eq!(
            list_subagents(&conn).unwrap().iter().filter(|r| !r.builtin).count(),
            1
        );
        assert_eq!(
            find_subagent_by_name(&conn, "DOC WRITER")
                .unwrap()
                .unwrap()
                .id,
            created.id,
            "name lookup is case-insensitive"
        );

        delete_subagent(&conn, &created.id).unwrap();
        // The mem() fixture's 7 builtins remain; the user row is gone.
        assert_eq!(
            list_subagents(&conn)
                .unwrap()
                .iter()
                .filter(|r| !r.builtin)
                .count(),
            0
        );
        assert!(get_subagent(&conn, &created.id).unwrap().is_none());
        // Updating a gone row reloads to None instead of inventing one.
        assert!(update_subagent(&conn, &created.id, &edit)
            .unwrap()
            .is_none());
    }

    #[test]
    fn unique_name_is_case_insensitive_at_the_db_layer() {
        let conn = crate::db::mem();
        create_subagent(&conn, &input("Doc Writer")).unwrap();
        // The COLLATE NOCASE unique index is the backstop behind
        // chat::subagent::validate_input's explicit check.
        assert!(create_subagent(&conn, &input("doc writer")).is_err());
    }
}
