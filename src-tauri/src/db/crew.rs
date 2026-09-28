//! Crew agents (declarative subagents) — persistence.
//!
//! One row per agent definition: a name, a markdown prompt body, a tool
//! allowlist, permission/engine/policy fields and a spawn budget. The 7
//! builtin roles are seeded rows (`builtin=1`) that hold the role instruction
//! text; everything else about how a run behaves is resolved by
//! `chat::crew` (allowlist resolution, validation, the running set), so this
//! module stays a plain row store like `db/automations.rs`.
//!
//! A table rather than a settings blob: spawn surfaces validate against it by
//! id, a session row points at its agent through a string FK, and run history
//! will need it. `skills` is the structural precedent.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

/// Default policy values — mirrors the `crew_agents` DDL defaults so a
/// partial form (or an old client) lands on the same row the DDL would give.
const DEFAULT_SANDBOX_POLICY: &str = "read_only";
const DEFAULT_APPROVAL_POLICY: &str = "on_request";
const DEFAULT_WORKTREE_POLICY: &str = "inherit";
const DEFAULT_MAX_ROUNDS: i64 = 100;
const DEFAULT_MAX_CONCURRENT: i64 = 2;

/// A persisted agent definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewAgent {
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
    /// mutating half (see `chat::crew::builtin_ceiling`).
    pub sandbox_policy: String,
    /// `on_request` | `auto_edit` | `full_access`.
    pub approval_policy: String,
    /// `inherit` | `always` | `never`.
    pub worktree_policy: String,
    /// Clamped to 1..=`chat::crew::MAX_ROUNDS`.
    pub max_rounds: i64,
    /// Per-agent live-run budget.
    pub max_concurrent: i64,
    /// Seeded role — cannot be deleted and its name is reserved.
    pub builtin: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What the create/edit form sends: every field but `id`, `builtin` and the
/// timestamps. All fields are defaulted so the UI can post a partial form;
/// the defaults are the DDL's, not zero values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewAgentInput {
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
fn map_crew_agent(row: &Row) -> rusqlite::Result<CrewAgent> {
    let created_at: i64 = row.get("created_at")?;
    Ok(CrewAgent {
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
        created_at,
        updated_at: row.get("updated_at").unwrap_or(created_at),
    })
}

const COLUMNS: &str = "id, name, description, prompt_md, tools, engine, model, effort, \
     sandbox_policy, approval_policy, worktree_policy, max_rounds, max_concurrent, builtin, \
     created_at, updated_at";

/// Builtins first (the stable set the `Task` enum advertises), then user rows
/// by name.
pub fn list_crew_agents(conn: &Connection) -> DbResult<Vec<CrewAgent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM crew_agents ORDER BY builtin DESC, name COLLATE NOCASE ASC"
    ))?;
    let rows = stmt.query_map([], map_crew_agent)?;
    rows.collect()
}

pub fn get_crew_agent(conn: &Connection, id: &str) -> DbResult<Option<CrewAgent>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM crew_agents WHERE id = ?1"),
        params![id],
        map_crew_agent,
    )
    .optional()
}

/// Look one agent up by name, case-insensitively (the same rule the
/// `COLLATE NOCASE` unique index enforces), for the name-collision check.
pub fn find_crew_agent_by_name(conn: &Connection, name: &str) -> DbResult<Option<CrewAgent>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM crew_agents WHERE name = ?1 COLLATE NOCASE"),
        params![name],
        map_crew_agent,
    )
    .optional()
}

/// Insert a user-created definition. `input` must already be validated and
/// normalized by `chat::crew::validate_input` — this layer does no policy
/// checks, exactly like `db/automations.rs`.
pub fn create_crew_agent(conn: &Connection, input: &CrewAgentInput) -> DbResult<CrewAgent> {
    let id = new_id();
    let ts = now_ts();
    conn.execute(
        "INSERT INTO crew_agents
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
    get_crew_agent(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Overwrite a definition's editable fields. `builtin`, `id` and
/// `created_at` are never touched. Returns the reloaded row so the caller
/// answers with what was actually persisted.
pub fn update_crew_agent(
    conn: &Connection,
    id: &str,
    input: &CrewAgentInput,
) -> DbResult<Option<CrewAgent>> {
    conn.execute(
        "UPDATE crew_agents SET
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
    get_crew_agent(conn, id)
}

pub fn delete_crew_agent(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM crew_agents WHERE id = ?1", params![id])?;
    Ok(())
}

/// Insert one row verbatim. Used ONLY by the builtin seed, which owns its own
/// stable ids — `create_crew_agent` mints a uuid. Every column not named here
/// is left at its F.1 DDL default.
fn insert_row(conn: &Connection, id: &str, name: &str, prompt_md: &str) -> DbResult<()> {
    let ts = now_ts();
    conn.execute(
        "INSERT OR IGNORE INTO crew_agents
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
/// non-destructive: re-running after a cleared `crew.seed.v1` marker refreshes
/// nothing a user (or a later edit) changed, and never duplicates. The
/// instructions come from `chat::crew::BUILTIN_ROLES` — the same table
/// `dispatch.rs` reads at runtime, so the seed and the runtime can never
/// disagree.
pub fn seed_builtin_crew_agents(conn: &Connection) -> DbResult<()> {
    for role in crate::chat::crew::BUILTIN_ROLES {
        insert_row(
            conn,
            &format!("builtin-{}", role.name),
            role.name,
            role.instruction,
        )?;
    }
    Ok(())
}

// ---- crew run history (Phase 5) ----

/// One crew RUN (a spawned session's lifecycle). Dangling ids are legal on
/// purpose — history outlives a deleted agent or chat, and the UI renders
/// those as "deleted agent"/"deleted chat" instead of hiding the rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewAgentRun {
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
    /// `running` | `finished` | `error`.
    pub status: String,
    pub summary: Option<String>,
}

fn map_crew_run(row: &rusqlite::Row) -> rusqlite::Result<CrewAgentRun> {
    Ok(CrewAgentRun {
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
pub fn record_crew_run(conn: &Connection, run: &CrewAgentRun) -> DbResult<()> {
    conn.execute(
        "INSERT INTO crew_runs (id, agent_id, session_id, trigger, task, engine, model, \
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
pub fn finish_crew_run(
    conn: &Connection,
    run_id: &str,
    status: &str,
    summary: Option<&str>,
) {
    let _ = conn.execute(
        "UPDATE crew_runs SET finished_at = ?2, status = ?3, \
         summary = COALESCE(?4, summary) WHERE id = ?1",
        rusqlite::params![run_id, crate::db::now_ts(), status, summary],
    );
}

/// Newest-first run history, optionally filtered to one agent.
pub fn list_crew_runs(
    conn: &Connection,
    agent_id: Option<&str>,
    limit: i64,
) -> DbResult<Vec<CrewAgentRun>> {
    let limit = limit.clamp(1, 200);
    let sql = |filtered: bool| {
        if filtered {
            (
                "SELECT id, agent_id, session_id, trigger, task, engine, model, worktree, \
                 started_at, finished_at, status, summary \
                 FROM crew_runs WHERE agent_id = ?1 ORDER BY started_at DESC LIMIT ?2",
                2,
            )
        } else {
            (
                "SELECT id, agent_id, session_id, trigger, task, engine, model, worktree, \
                 started_at, finished_at, status, summary \
                 FROM crew_runs ORDER BY started_at DESC LIMIT ?1",
                1,
            )
        }
    };
    let mut out = Vec::new();
    if let Some(agent) = agent_id {
        let mut stmt = conn.prepare(sql(true).0)?;
        let rows = stmt.query_map(rusqlite::params![agent, limit], map_crew_run)?;
        for r in rows {
            out.push(r?);
        }
    } else {
        let mut stmt = conn.prepare(sql(false).0)?;
        let rows = stmt.query_map(rusqlite::params![limit], map_crew_run)?;
        for r in rows {
            out.push(r?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::crew::BUILTIN_ROLES;

    fn input(name: &str) -> CrewAgentInput {
        CrewAgentInput {
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
    fn seed_is_idempotent_via_marker_and_insert_or_ignore() {
        let conn = super::super::mem();
        // mem() already ran the marker-guarded seed once.
        assert_eq!(count_builtins(&conn), 7);

        // Re-running through the marker is a no-op.
        super::super::migrate_crew_agents_seed(&conn).unwrap();
        assert_eq!(count_builtins(&conn), 7);

        // Clearing the marker forces the pass again: INSERT OR IGNORE keeps it
        // at exactly 7 (no duplicates, no clobber).
        conn.execute("DELETE FROM app_settings WHERE key = 'crew.seed.v1'", [])
            .unwrap();
        super::super::migrate_crew_agents_seed(&conn).unwrap();
        assert_eq!(count_builtins(&conn), 7);

        // A user's edit to a builtin row survives a forced re-seed.
        conn.execute(
            "UPDATE crew_agents SET description = 'mine' WHERE id = 'builtin-explore'",
            [],
        )
        .unwrap();
        seed_builtin_crew_agents(&conn).unwrap();
        let row = get_crew_agent(&conn, "builtin-explore").unwrap().unwrap();
        assert_eq!(row.description, "mine");
        assert_eq!(count_builtins(&conn), 7);
    }

    #[test]
    fn seeded_rows_carry_the_f1_defaults() {
        let conn = super::super::mem();
        let rows = list_crew_agents(&conn).unwrap();
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
            "SELECT COUNT(*) FROM crew_agents WHERE builtin = 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn crud_roundtrips_including_tools_json_and_none_preservation() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();

        let mut inp = input("Doc Writer");
        inp.tools = Some(r#"["read_file","write_file"]"#.into());
        let created = create_crew_agent(&conn, &inp).unwrap();
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
        let updated = update_crew_agent(&conn, &created.id, &edit)
            .unwrap()
            .unwrap();
        assert_eq!(updated.tools.as_deref(), Some(r#"["read_file"]"#));
        assert_eq!(updated.prompt_md, "you write docs");
        assert_eq!(updated.sandbox_policy, "workspace_write");
        assert_eq!(updated.max_rounds, 40);
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.created_at, created.created_at, "immutable");

        edit.tools = None;
        let cleared = update_crew_agent(&conn, &created.id, &edit)
            .unwrap()
            .unwrap();
        assert!(cleared.tools.is_none(), "None must survive as SQL NULL");

        assert_eq!(list_crew_agents(&conn).unwrap().len(), 1);
        assert_eq!(
            find_crew_agent_by_name(&conn, "DOC WRITER")
                .unwrap()
                .unwrap()
                .id,
            created.id,
            "name lookup is case-insensitive"
        );

        delete_crew_agent(&conn, &created.id).unwrap();
        assert!(list_crew_agents(&conn).unwrap().is_empty());
        assert!(get_crew_agent(&conn, &created.id).unwrap().is_none());
        // Updating a gone row reloads to None instead of inventing one.
        assert!(update_crew_agent(&conn, &created.id, &edit)
            .unwrap()
            .is_none());
    }

    #[test]
    fn unique_name_is_case_insensitive_at_the_db_layer() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        create_crew_agent(&conn, &input("Doc Writer")).unwrap();
        // The COLLATE NOCASE unique index is the backstop behind
        // chat::crew::validate_input's explicit check.
        assert!(create_crew_agent(&conn, &input("doc writer")).is_err());
    }
}
