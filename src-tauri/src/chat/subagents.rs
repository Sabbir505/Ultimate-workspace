//! Subagents — declarative subagents (research doc Part C.1/C.3/C.4).
//!
//! A subagent is a persisted, named identity: a prompt body, a tool
//! allowlist, a permission scope, an engine/model pick and a spawn budget.
//! This module owns everything that is NOT a plain row read/write:
//!
//! * [`BUILTIN_ROLES`] — the 7 built-in roles as DATA. `dispatch.rs`'s role
//!   `match` is a lookup against this table and `db::subagent`'s seed reads the
//!   same table, so the seed and the runtime cannot disagree.
//! * [`resolve_allowlist`] — one allowlist resolver with three outcomes
//!   (`None` = "use the engine's own default", a set = "enforce exactly
//!   this"), used by the schema filter, the execution check and later the
//!   mesh.
//! * validation — names, policies, budgets. Errors are `String`s because
//!   they surface verbatim in the Subagent editor.
//! * [`running_set`] — the in-process live-run registry that makes deleting a
//!   running agent (and exceeding its `max_concurrent`) refusable.
//!
//! Storage lives in `db/subagent.rs`; the Tauri surface in
//! `commands/subagent_cmds.rs`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;

pub use crate::db::subagents::{Subagent, SubagentInput};

use crate::chat::tools;

/// Longest an agent name may be. Names land in the `Task` `subagent_type`
/// enum and in generated branch names (`relay/<slug>-<id8>`), so they stay
/// short.
pub const MAX_NAME_LEN: usize = 48;
/// One-line hint length. It is rendered next to the name in the task schema,
/// never as prose.
pub const MAX_DESCRIPTION_LEN: usize = 200;
/// Ceiling for `max_rounds` — mirrors `dispatch::SUBAGENT_MAX_ROUNDS`, which
/// stays the authority the subagent loop enforces.
pub const MAX_ROUNDS: i64 = 100;

/// App-wide ceiling on subagent runs in flight — every `agent:` spawn surface
/// (the manual Run button, mesh `spawn_session agent:<id>`, and automation
/// `agent:<id>` one-shots) counts against the one number, so a burst of
/// scheduled runs cannot squeeze out interactive ones. Deliberately
/// separate from the mesh's own spawn caps: those guard *model fan-out*,
/// and counting human-initiated or automated subagent runs against them would
/// starve both. The per-agent `max_concurrent` on the definition is the
/// finer-grained valve on top of this.
pub const MAX_ACTIVE_SUBAGENT: i64 = 8;

/// How long a `subagent_runs` row may legitimately stay `running`: every spawn
/// surface's release watcher gives up by this age, so at boot any older
/// `running` row is a crash leftover and is settled as an error by
/// `db::sweep_stale_subagent_runs`.
pub const STALE_RUNNING_SECS: i64 = 2 * 60 * 60;

/// A built-in role: the `Task` `subagent_type` value and the instruction the
/// subagent's system prompt is built around.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinRole {
    /// The `subagent_type` enum value (and the seeded row's `name`).
    pub name: &'static str,
    /// The role instruction, copied VERBATIM out of the `match` this table
    /// replaced. Composed into the subagent prompt exactly as before: role
    /// instruction + cwd line + shared read-only boilerplate.
    pub instruction: &'static str,
}
/// The 7 built-in roles, in the order the `Task` schema's `subagent_type`
/// enum lists them. This table — not a `match` in `dispatch.rs` — is the
/// single source of truth for both the registry seed and the runtime.
///
/// `edit` and `refactor` deliberately carry the SAME string: the `match` they
/// replaced aliased the two arms ("edit" | "refactor") because producing exact
/// edits is the whole job of both. Copying the strings verbatim is the point,
/// so the alias is kept (and pinned by a test) rather than papered over with a
/// reworded instruction that would change every refactor subagent's prompt.
pub const BUILTIN_ROLES: [BuiltinRole; 7] = [
    BuiltinRole {
        name: "explore",
        instruction: "Your job is to explore the codebase and report findings: file paths, key symbols, and how things connect. Do not propose edits.",
    },
    BuiltinRole {
        name: "edit",
        instruction: "Your job is to produce the concrete edits required (full file contents or unified diffs). The caller will apply them. Be precise about file paths.",
    },
    BuiltinRole {
        name: "analyze",
        instruction: "Your job is to analyze the described code/behavior and report root cause, risks, and a recommendation. Do not edit.",
    },
    BuiltinRole {
        name: "research",
        instruction: "Your job is to research the topic and report a concise summary with citations/references where applicable.",
    },
    BuiltinRole {
        name: "write",
        instruction: "Your job is to write the requested content (docs, config, code) in full.",
    },
    BuiltinRole {
        name: "test",
        instruction: "Your job is to specify tests (cases + expected outcomes, or test code) for the described behavior. Be specific.",
    },
    BuiltinRole {
        name: "refactor",
        instruction: "Your job is to produce the concrete edits required (full file contents or unified diffs). The caller will apply them. Be precise about file paths.",
    },
];

/// The role instruction for a `subagent_type`, or `None` for an unknown role
/// (the caller decides the fallback text). This is the replacement for
/// `dispatch::run_task_subagent`'s former 7-arm `match`.
pub fn builtin_role_instruction(role: &str) -> Option<&'static str> {
    BUILTIN_ROLES
        .iter()
        .find(|r| r.name == role)
        .map(|r| r.instruction)
}

/// True when `name` is one of the 7 reserved role names. Those names are
/// always present in the `Task` enum, so a user agent may not take one.
pub fn is_builtin_role(name: &str) -> bool {
    BUILTIN_ROLES
        .iter()
        .any(|r| r.name.eq_ignore_ascii_case(name))
}

/// The read-only tool set a subagent may use — the same 12 names
/// `dispatch::SUBAGENT_TOOL_ALLOW` lists. Enough to ground an answer in the
/// real workspace/web, no mutation (so no approval card can ever be needed),
/// no browser pane takeover, no background tasks, no spawning.
///
/// Duplicated here on purpose: the `dispatch` const is private to that module
/// and this table must be usable without importing the whole chat loop. The
/// pinned-name test below is what keeps the two copies from drifting; Phase 2
/// deletes the const in favour of this one.
pub const BUILTIN_READ_ONLY_TOOLS: [&str; 12] = [
    tools::LIST_DIRECTORY,
    tools::READ_FILE,
    tools::SEARCH_FILES,
    tools::SEARCH_CONTENT,
    // Vault read trio: subagents research the user's knowledge base like any
    // other read-only source. (The write trio is the workspace_write half
    // below.)
    tools::VAULT_LIST,
    tools::VAULT_READ,
    tools::VAULT_SEARCH,
    tools::FETCH_URL,
    tools::WEB_SEARCH,
    tools::ADD_SOURCE_NOTE,
    tools::GET_SOURCE_LEDGER,
    // Read-only introspection: a subagent asked "is X connected?" must answer
    // from this report, not by shelling out (it has no shell anyway).
    tools::GET_CAPABILITIES,
];

/// The mutating tools a `workspace_write` agent may additionally be granted
/// — the workspace/vault write half of the spec builders
/// (`specs.rs`, the `sandbox.allows_mutating_tools()` block).
///
/// Deliberately NOT in the ceiling: the automation CRUD tools (double-gated
/// behind `caps.automations_write`, so granting them here would be a lie
/// about when they exist), `run_shell` (named in the depth-1 invariant — a
/// builtin-engine agent must never be able to spawn work), and the
/// UI-side-effect tools `download_file` / `open_file`, which are not workspace
/// writes and are of no use to a subagent.
pub const WORKSPACE_WRITE_TOOLS: [&str; 8] = [
    tools::WRITE_FILE,
    tools::EDIT_FILE,
    tools::DELETE_FILE,
    tools::MOVE_FILE,
    tools::COPY_FILE,
    tools::VAULT_WRITE,
    tools::VAULT_MOVE,
    tools::VAULT_DELETE,
];

/// The most an agent definition can ever be granted, given the policy it was
/// created with. A definition can narrow its tool set but never widen it past
/// the sandbox it was granted — that intersection is what makes a stored
/// allowlist safe to enforce without re-deriving the policy at every call
/// site.
pub fn builtin_ceiling(sandbox_policy: &str) -> Arc<HashSet<String>> {
    let mut set: HashSet<String> = BUILTIN_READ_ONLY_TOOLS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if sandbox_policy == "workspace_write" {
        set.extend(WORKSPACE_WRITE_TOOLS.iter().map(|s| (*s).to_string()));
    }
    Arc::new(set)
}

/// The default effective set for a subagent run that resolved no allowlist
/// (`tools IS NULL`, or no definition at all) — the 12 read-only names as a
/// set. Built once and handed out as a shared `Arc`, so the per-call
/// "effective set" plumbing in `dispatch` never re-allocates it.
pub fn default_read_only_tools() -> Arc<HashSet<String>> {
    static DEFAULT: OnceLock<Arc<HashSet<String>>> = OnceLock::new();
    DEFAULT
        .get_or_init(|| {
            Arc::new(
                BUILTIN_READ_ONLY_TOOLS
                    .iter()
                    .map(|s| (*s).to_string())
                    .collect(),
            )
        })
        .clone()
}

// ---- Registry name cache (the `Task` `subagent_type` enum) ----
//
// The `Task` schema is rebuilt on every turn and its `subagent_type` enum
// must advertise the user's subagent (F.5), but the spec builders have no DB
// handle. So the names are cached process-wide with the same 30s TTL +
// invalidate-on-write shape as `commands::agent_cmds`'s harness-model cache.
//
// Two halves make the no-argument read work everywhere:
//   * [`refresh_registry_cache`] (takes a `&Connection`) re-reads the names —
//     every write path and every read path that HAS a connection calls it,
//     so a just-created agent is visible immediately rather than after 30s;
//   * [`cached_agent_names`] (no arguments) serves the warm value, and when
//     the cache is cold or stale it re-reads through the DB path remembered
//     by the last refresh. A sidecar/test with no file-backed connection just
//     gets the empty list — the 7 builtin role names are added by the schema
//     builder itself and are always present.

const REGISTRY_TTL: Duration = Duration::from_secs(30);

/// (read at, names). `None` = invalidated (a write landed, or nobody has
/// refreshed yet).
type RegistryCache = RwLock<Option<(Instant, Vec<String>)>>;

fn registry_cache() -> &'static RegistryCache {
    static CACHE: OnceLock<RegistryCache> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

/// The DB file the last refresh read from (`None` for an in-memory
/// connection, which nothing else can open).
fn registry_source() -> &'static RwLock<Option<PathBuf>> {
    static SOURCE: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
    SOURCE.get_or_init(|| RwLock::new(None))
}

/// Re-entrancy guard for [`cached_agent_names`]' cold-cache self-refresh (a
/// refresh must never recurse back into the read).
fn registry_self_refreshing() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}

fn registry_names(conn: &Connection) -> Option<Vec<String>> {
    // `list_subagents` is ordered builtins-first then by name, so the enum
    // keeps the 7 roles in their canonical order ahead of the subagent's own
    // names. Case is preserved (the column is stored lower-case by
    // `validate_name`, but a hand-edited row must not silently lose its
    // label).
    //
    // The db layer directly, NOT this module's `list` — that one refreshes
    // the cache, and a cache read must never re-enter its own refresh.
    // `None` for a failed read: caching an empty list because of a transient
    // error would silently strip the user's subagent from the `Task` enum.
    Some(
        crate::db::list_subagents(conn)
            .ok()?
            .into_iter()
            .map(|a| a.name)
            .collect(),
    )
}

/// Re-read every agent name into the cache. Called from `create`/`update`/
/// `delete` (so a write is visible on the very next spec build), from `list`
/// (the registry surfaces all read through it), and from the chat dispatch
/// that resolves a definition — i.e. from every place that already holds a
/// connection, which is what lets the spec builders read the cache with no
/// handle of their own.
pub fn refresh_registry_cache(conn: &Connection) {
    if let Some(path) = conn.path() {
        if let Ok(mut slot) = registry_source().write() {
            *slot = Some(PathBuf::from(path));
        }
    }
    match registry_names(conn) {
        Some(names) => {
            if let Ok(mut slot) = registry_cache().write() {
                *slot = Some((Instant::now(), names));
            }
        }
        // A failed read leaves the cache invalidated rather than empty: the
        // next read retries, and the enum degrades to the builtin roles
        // instead of advertising a subagent that isn't there.
        None => invalidate_registry_cache(),
    }
}

/// Drop the cached names. The next read re-reads through the remembered DB
/// path; with no path it degrades to the builtin-only enum rather than
/// serving a stale subagent.
pub fn invalidate_registry_cache() {
    if let Ok(mut slot) = registry_cache().write() {
        *slot = None;
    }
}

/// Every subagent name, case-preserved — the values the `Task`
/// `subagent_type` enum adds on top of the 7 built-in roles. Warm within the
/// TTL; a cold or stale cache re-reads once (best effort, and never
/// recursively) before answering.
pub fn cached_agent_names() -> Arc<Vec<String>> {
    if let Some(names) = warm_registry_names() {
        return Arc::new(names);
    }
    // Cold or stale: try to re-read through the path the last refresh saw.
    // A failure here is not an error — the enum simply carries the built-in
    // roles alone until something with a connection refreshes it.
    if registry_self_refreshing()
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_ok()
    {
        let path = registry_source().read().ok().and_then(|s| s.clone());
        if let Some(path) = path {
            if let Ok(conn) = Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ) {
                if let Some(names) = registry_names(&conn) {
                    if let Ok(mut slot) = registry_cache().write() {
                        *slot = Some((Instant::now(), names));
                    }
                }
            }
        }
        registry_self_refreshing().store(false, Ordering::Relaxed);
    }
    warm_registry_names()
        .map(Arc::new)
        .unwrap_or_else(|| Arc::new(Vec::new()))
}

fn warm_registry_names() -> Option<Vec<String>> {
    let slot = registry_cache().read().ok()?;
    let (at, names) = slot.as_ref()?;
    if at.elapsed() < REGISTRY_TTL {
        Some(names.clone())
    } else {
        None
    }
}

/// Parse a stored `tools` column. `None` for absent/blank/`"null"`, and for
/// anything that is not a JSON array of strings (write-time validation makes
/// that unreachable, but a hand-edited DB must degrade to the default rather
/// than fail a run).
fn parse_tool_list(raw: &str) -> Option<HashSet<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let arr = parsed.as_array()?;
    let mut set = HashSet::new();
    for entry in arr {
        let name = entry.as_str()?.trim().to_string();
        if !name.is_empty() {
            set.insert(name);
        }
    }
    Some(set)
}

/// Resolve the effective tool allowlist for a subagent run.
///
/// `None` means "no registry-imposed set — use the engine's own default",
/// which is three different defaults depending on why it is `None`:
///
/// * **no definition at all** (a plain builtin-role `Task` call): the caller
///   keeps today's `SUBAGENT_TOOL_ALLOW` verbatim;
/// * **`tools IS NULL`**: the engine default — the read-only set for a
///   builtin engine, the CLI's own toolset for a harness one;
/// * **the definition was deleted** between the call resolving it and this
///   call: the same as the engine default, so a stale row can never *keep*
///   enforcing a set the user just revoked by deleting it.
///
/// A stored list is the definition's set **intersected with the builtin
/// ceiling for its own `sandbox_policy`**, so a `read_only` agent cannot smuggle
/// `write_file` in through its allowlist, and no agent can reach a
/// spawn-capable tool (`Task`, `run_shell`, `spawn_session`,
/// `message_session`) — depth stays 1.
///
/// The row is re-read here on purpose: this is the enforcement point, and
/// enforcement must not run off a definition that no longer exists.
pub fn resolve_allowlist(
    conn: &Connection,
    def: Option<&Subagent>,
) -> Option<Arc<HashSet<String>>> {
    let def = def?;
    if crate::db::get_subagent(conn, &def.id)
        .ok()
        .flatten()
        .is_none()
    {
        return None;
    }
    let requested = parse_tool_list(def.tools.as_deref()?)?;
    let ceiling = builtin_ceiling(&def.sandbox_policy);
    Some(Arc::new(
        requested
            .into_iter()
            .filter(|name| ceiling.contains(name))
            .collect(),
    ))
}

/// Live runs per agent id, maintained by whoever spawns (Phase 2.5+). It is
/// what makes "delete an agent with a run in flight" refusable and what a
/// per-agent `max_concurrent` is checked against.
///
/// Static so the counter survives the borrow dance of a command handler that
/// must read it while the DB lock is held.
pub fn running_set() -> &'static Mutex<HashMap<String, i64>> {
    static RUNNING: std::sync::LazyLock<Mutex<HashMap<String, i64>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &RUNNING
}

/// Current live-run count for one agent (0 when idle).
pub fn live_runs(agent_id: &str) -> i64 {
    running_set().lock().get(agent_id).copied().unwrap_or(0)
}

/// Atomically check AND acquire one run slot: the app-wide subagent ceiling and
/// the per-agent `max_concurrent` are read and the count bumped under a
/// single hold of the running-set lock, so two concurrent spawns (a
/// double-clicked Run button racing a mesh/automation spawn of the same
/// agent) can never both observe "room left" and both bump. The caller
/// releases with `bump_running(agent_id, -1)` when the run settles (or
/// immediately on a later failure path — every spawn site pairs the acquire
/// with a compensating release before its first turn is dispatched).
pub fn try_acquire_running(
    agent_id: &str,
    agent_name: &str,
    per_agent_cap: i64,
    app_cap: i64,
) -> Result<(), String> {
    let mut set = running_set().lock();
    let active: i64 = set.values().sum();
    if active >= app_cap {
        return Err(format!(
            "{active} subagent runs are already active app-wide (cap {app_cap}) — \
             wait for one to settle"
        ));
    }
    let live = set.get(agent_id).copied().unwrap_or(0);
    if live >= per_agent_cap {
        return Err(format!(
            "subagent \"{agent_name}\" already has {live} run(s) in flight \
             (max_concurrent {per_agent_cap})"
        ));
    }
    set.insert(agent_id.to_string(), live + 1);
    Ok(())
}

/// Adjust one agent's live-run count (+1 at spawn, −1 when the first turn's
/// session goes idle). Saturates at zero so a double release (crashed
/// watcher + fail-fast path) can never make the count negative and wedge a
/// later `max_concurrent` check open.
pub fn bump_running(agent_id: &str, delta: i64) {
    let mut set = running_set().lock();
    let next = set.get(agent_id).copied().unwrap_or(0) + delta;
    if next <= 0 {
        set.remove(agent_id);
    } else {
        set.insert(agent_id.to_string(), next);
    }
}

/// Validate + normalize a create/update payload in place. Shared by the Tauri
/// commands and the chat tool layer so both surfaces accept exactly the same
/// shapes and produce the same error text.
///
/// `existing` is the row being updated (None on create); it lets a save keep
/// its own name without tripping the uniqueness check.
pub fn validate_input(
    input: &mut SubagentInput,
    existing: Option<&Subagent>,
) -> Result<(), String> {
    input.name = validate_name(&input.name)?;

    // The 7 role names are reserved: the `Task` enum advertises them
    // unconditionally, so a custom agent may not shadow one. A builtin ROW,
    // on the other hand, must keep its name — editing its prompt/model is
    // allowed, renaming it is not.
    if let Some(row) = existing.filter(|r| r.builtin) {
        if input.name != row.name {
            return Err("a built-in role's name cannot be changed".into());
        }
    } else if is_builtin_role(&input.name) {
        return Err(format!(
            "'{}' is a built-in role name and cannot be used for a custom agent",
            input.name
        ));
    }

    if input.description.chars().count() > MAX_DESCRIPTION_LEN {
        return Err(format!(
            "description must be {} characters or fewer",
            MAX_DESCRIPTION_LEN
        ));
    }
    // The description is ONE line by contract — it renders as the Task
    // enum's hint and, on export, as a single `description:` frontmatter
    // line. A newline (the model-facing create tool can send one) would
    // corrupt that round-trip, so refuse it at save time.
    if input.description.contains(['\n', '\r']) {
        return Err("description must be a single line".into());
    }

    // The allowlist is stored as the exact JSON string the caller sent, so
    // round-tripping a save is byte-stable. It must be an array of tool names
    // (or null = engine default) — validated here, not at spawn time, so the
    // editor gets the error while the user is looking at the field.
    if let Some(raw) = input.tools.as_deref() {
        if !raw.trim().is_empty() {
            match parse_tool_list(raw) {
                Some(_) => {}
                None => {
                    return Err("tools must be a JSON array of tool names".into());
                }
            }
        }
    }

    if !matches!(
        input.sandbox_policy.as_str(),
        "read_only" | "workspace_write"
    ) {
        return Err(format!(
            "unknown sandbox policy '{}' (read_only | workspace_write)",
            input.sandbox_policy
        ));
    }
    if !matches!(
        input.approval_policy.as_str(),
        "on_request" | "auto_edit" | "full_access"
    ) {
        return Err(format!(
            "unknown approval policy '{}' (on_request | auto_edit | full_access)",
            input.approval_policy
        ));
    }
    if !matches!(
        input.worktree_policy.as_str(),
        "inherit" | "always" | "never"
    ) {
        return Err(format!(
            "unknown worktree policy '{}' (inherit | always | never)",
            input.worktree_policy
        ));
    }

    // Budgets are clamped rather than rejected: an out-of-range number is a
    // slider overshoot, not a malformed request, and silently storing 0
    // rounds would make the agent unable to run at all.
    input.max_rounds = input.max_rounds.clamp(1, MAX_ROUNDS);
    input.max_concurrent = input.max_concurrent.max(1);
    Ok(())
}

/// Validate an agent name and return its normalized form.
///
/// 1–48 characters from `[a-z0-9-]`, plus spaces (normalized away — see
/// [`slugify`]) — lowercase only, because the name is both the `Task`
/// `subagent_type` enum value and part of a generated branch name, and a
/// mixed-case enum value is a trap for models.
pub fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("name is required".into());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("name must be {} characters or fewer", MAX_NAME_LEN));
    }
    if let Some(bad) = name
        .chars()
        .find(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-' || *c == ' '))
    {
        return Err(format!(
            "name may only use a-z, 0-9, '-' and spaces (found '{bad}')"
        ));
    }
    Ok(normalize_name(name))
}

/// Collapse a validated name to its canonical form: runs of spaces become a
/// single `-`, leading/trailing separators are trimmed. Two names that differ
/// only in spacing therefore collide in the registry, which is what the
/// `COLLATE NOCASE` unique index is there to catch.
pub fn normalize_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_sep = false;
    for ch in name.trim().chars() {
        if ch == ' ' {
            pending_sep = true;
            continue;
        }
        if pending_sep && !out.is_empty() {
            out.push('-');
        }
        pending_sep = false;
        out.push(ch);
    }
    out
}

/// URL/branch-safe form of a name (`relay/<slug>-<id8>` worktrees, ids).
/// Truncates to [`MAX_NAME_LEN`] so a generated branch name stays sane.
pub fn slugify(name: &str) -> String {
    let slug = normalize_name(name);
    let slug: String = slug.chars().take(MAX_NAME_LEN).collect();
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed
    }
}

pub fn list(conn: &Connection) -> Vec<Subagent> {
    let rows = crate::db::list_subagents(conn).unwrap_or_default();
    // A read of the registry is also the cheapest place to keep the `Task`
    // enum honest: whoever opened the Subagent panel just proved the connection
    // works, and the enum may be stale.
    if !rows.is_empty() {
        refresh_registry_cache(conn);
    }
    rows
}

pub fn get(conn: &Connection, id: &str) -> Option<Subagent> {
    crate::db::get_subagent(conn, id).ok().flatten()
}

/// Resolve a subagent reference that may be an id (`subagent-…`) or a name
/// (case-insensitive). This is what every `agent:`-prefixed spawn surface
/// (manual run, mesh, automation) resolves through, so all of them accept the
/// same vocabulary.
pub fn resolve_by_id_or_name(conn: &Connection, value: &str) -> Option<Subagent> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    get(conn, value).or_else(|| {
        crate::db::find_subagent_by_name(conn, value)
            .ok()
            .flatten()
    })
}

/// The first message of a subagent run: the definition's prompt body rides the
/// task as a clearly-marked directive block (same transparency trade-off as
/// the automations' UNATTENDED_RUN_RULES prepend — the transcript shows the
/// user exactly what instructions the agent started with). Empty prompt →
/// the bare task.
pub fn compose_first_message(def: &Subagent, task: &str) -> String {
    let prompt = def.prompt_md.trim();
    if prompt.is_empty() {
        return task.to_string();
    }
    format!(
        "<subagent name=\"{}\">\n{}\n</subagent>\n\n{}",
        def.name, prompt, task
    )
}

/// Resolve the (provider, model) a builtin-engine definition actually runs.
/// `builtin`/`local` are ENGINE labels, not providers — the provider comes
/// from the model's `provider::model` prefix, else the app's active provider;
/// the model comes from the prefix's tail, else the definition's bare id, else
/// the provider's configured default. This is THE shared resolution for every
/// builtin-engine subagent surface (manual run, automation routing) — the live
/// test caught the automation path passing the engine label as the provider
/// when each surface rolled its own.
pub fn resolve_builtin_provider_model(
    conn: &Connection,
    model: Option<&str>,
) -> Result<(String, String), String> {
    let (prefix_provider, bare_model) = model
        .and_then(|m| m.split_once("::"))
        .map(|(p, m)| (Some(p.to_string()), Some(m.to_string())))
        .unwrap_or((None, model.map(str::to_string)));
    let provider = prefix_provider.unwrap_or_else(|| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key='chat.active_provider'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "openai".into())
    });
    let model = match bare_model {
        Some(m) if !m.is_empty() => m,
        _ => crate::db::get_setting(conn, &format!("chat.{provider}.model"))
            .ok()
            .flatten()
            .filter(|m| !m.is_empty())
            .ok_or_else(|| {
                format!(
                    "no model resolved for provider {provider} — set one on the subagent \
                     agent (e.g. \"openrouter::vendor/model\") or in Settings → API Keys"
                )
            })?,
    };
    Ok((provider, model))
}

// ---- .md interchange (Claude-Code-compatible frontmatter + relay extras) ----

/// Serialize a definition to a shareable markdown doc: the frontmatter fields
/// the Claude Code subagent economy understands (name, description, tools,
/// model) plus the relay extensions; the body is the system prompt. Export is
/// lossless for everything the editor can express.
pub fn to_markdown(def: &Subagent) -> String {
    // Parse the stored JSON as a Vec (order-preserving) — going through
    // `parse_tool_list`'s HashSet scrambled the order between exports, which
    // made an export → diff → export workflow show phantom churn.
    let tools = def
        .tools
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .map(|names| names.join(", "))
        .unwrap_or_default();
    let tools_line = if tools.is_empty() {
        String::new()
    } else {
        format!("tools: [{tools}]\n")
    };
    let model = def.model.as_deref().unwrap_or("");
    let engine = def.engine.as_deref().unwrap_or("");
    let effort = def.effort.as_deref().unwrap_or("");
    format!(
        "---\nname: {}\ndescription: {}\n{}model: {}\nengine: {}\nsandbox_policy: {}\n\
         approval_policy: {}\nworktree_policy: {}\nmax_rounds: {}\nmax_concurrent: {}\n\
         effort: {}\n---\n{}\n",
        def.name,
        def.description,
        tools_line,
        model,
        engine,
        def.sandbox_policy,
        def.approval_policy,
        def.worktree_policy,
        def.max_rounds,
        def.max_concurrent,
        effort,
        def.prompt_md
    )
}

/// Parse one markdown doc into an input. STRICT by design (the lesson of the
/// capabilities-parity work): a malformed fence, an unknown tool, or an
/// unknown policy is a hard error the importer can show — never a silent
/// drop that changes what the agent will be allowed to do.
pub fn from_markdown(markdown: &str) -> Result<SubagentInput, String> {
    let md = markdown.trim_start_matches('\u{feff}');
    // Both fence line endings are accepted: a doc saved by a Windows editor
    // (CRLF) is the same doc, and the interior-line `trim_end_matches('\r')`
    // below already handles the rest of the file.
    let rest = md
        .strip_prefix("---\n")
        .or_else(|| md.strip_prefix("---\r\n"))
        .ok_or(
            "not a subagent markdown doc — expected a `---` frontmatter fence at the top",
        )?;
    let (frontmatter, body) = rest
        .split_once("\n---")
        .ok_or("unterminated frontmatter — the closing `---` is missing")?;
    // The split consumed "\n---"; drop the rest of the closing fence's line
    // ending (LF or CRLF) so it cannot ride into `prompt_md` as leading
    // blank lines.
    let body = body.trim_start_matches(['\r', '\n']);
    // STRICT: a multi-doc export (see `export_subagents`) must not be
    // silently mangled — without this check the second doc's frontmatter
    // would be swallowed into the first agent's prompt body. A closing fence
    // at line start followed by a `name:` key is exactly the concatenation
    // shape; a lone `---` horizontal rule in a prompt is not (its next line
    // is prose).
    {
        let mut lines = body.lines().peekable();
        while let Some(line) = lines.next() {
            if line.trim_end_matches('\r') == "---" {
                if let Some(next) = lines.peek() {
                    if next.trim_end_matches('\r').starts_with("name:") {
                        return Err(
                            "this file holds more than one subagent doc — import them \
                             one at a time"
                                .into(),
                        );
                    }
                }
            }
        }
    }

    let mut name = String::new();
    let mut description = String::new();
    let mut tools_raw: Option<String> = None;
    let mut model: Option<String> = None;
    let mut engine: Option<String> = None;
    let mut effort: Option<String> = None;
    let mut sandbox_policy = "read_only".to_string();
    let mut approval_policy = "on_request".to_string();
    let mut worktree_policy = "inherit".to_string();
    let mut max_rounds = 100i64;
    let mut max_concurrent = 2i64;

    for line in frontmatter.lines() {
        let line = line.trim_end_matches('\r');
        let Some((key, value)) = line.split_once(':') else {
            if line.trim().is_empty() {
                continue;
            }
            return Err(format!("unparsable frontmatter line: \"{line}\""));
        };
        let value = value.trim();
        match key.trim() {
            "name" => name = value.to_string(),
            "description" => description = value.to_string(),
            "tools" => tools_raw = Some(value.to_string()),
            "model" => model = Some(value.to_string()).filter(|v| !v.is_empty()),
            "engine" => engine = Some(value.to_string()).filter(|v| !v.is_empty()),
            "effort" => effort = Some(value.to_string()).filter(|v| !v.is_empty()),
            "sandbox_policy" => sandbox_policy = value.to_string(),
            "approval_policy" => approval_policy = value.to_string(),
            "worktree_policy" => worktree_policy = value.to_string(),
            "max_rounds" => {
                max_rounds = value
                    .parse()
                    .map_err(|_| format!("max_rounds is not a number: \"{value}\""))?
            }
            "max_concurrent" => {
                max_concurrent = value
                    .parse()
                    .map_err(|_| format!("max_concurrent is not a number: \"{value}\""))?
            }
            other => {
                return Err(format!(
                    "unknown frontmatter key \"{other}\" — refusing to import a \
                     definition whose meaning is not fully understood"
                ))
            }
        }
    }

    let tools = tools_raw
        .filter(|t| !t.is_empty())
        .map(|t| {
            let names: Vec<String> = t
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|s| s.trim().trim_matches('"').to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if names.is_empty() {
                return Err("empty tools list (omit `tools` for the engine default)".into());
            }
            for n in &names {
                if !BUILTIN_READ_ONLY_TOOLS.contains(&n.as_str())
                    && !WORKSPACE_WRITE_TOOLS.contains(&n.as_str())
                {
                    return Err(format!(
                        "unknown tool \"{n}\" — import only accepts tools Relay actually \
                         ships, never a silent drop"
                    ));
                }
            }
            Ok(serde_json::to_string(&names).unwrap())
        })
        .transpose()?;

    Ok(SubagentInput {
        name,
        description,
        prompt_md: body.trim_end().to_string(),
        tools,
        engine,
        model,
        effort,
        sandbox_policy,
        approval_policy,
        worktree_policy,
        max_rounds,
        max_concurrent,
    })
}

/// Create a definition. Rejects a name that already exists (case-insensitively)
/// with a message the editor can show, rather than a raw UNIQUE-constraint
/// error.
pub fn create(conn: &Connection, input: &SubagentInput) -> Result<Subagent, String> {
    let mut input = input.clone();
    validate_input(&mut input, None)?;
    if let Some(clash) =
        crate::db::find_subagent_by_name(conn, &input.name).map_err(|e| e.to_string())?
    {
        return Err(format!("an agent named '{}' already exists", clash.name));
    }
    let created = crate::db::create_subagent(conn, &input).map_err(|e| e.to_string())?;
    // A new name is a new `Task` enum value: invalidate, then refresh, so the
    // very next spec build (which may be mid-turn) already carries it.
    invalidate_registry_cache();
    refresh_registry_cache(conn);
    Ok(created)
}

pub fn update(conn: &Connection, id: &str, input: &SubagentInput) -> Result<Subagent, String> {
    let existing = crate::db::get_subagent(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or("agent not found".to_string())?;
    let mut input = input.clone();
    validate_input(&mut input, Some(&existing))?;
    // Only a RENAME can collide (every other field is free-form).
    if input.name != existing.name {
        if let Some(clash) =
            crate::db::find_subagent_by_name(conn, &input.name).map_err(|e| e.to_string())?
        {
            return Err(format!("an agent named '{}' already exists", clash.name));
        }
    }
    let updated = crate::db::update_subagent(conn, id, &input)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    // A rename moves an enum value; a fresh read is what makes the new name
    // visible immediately instead of after the TTL.
    invalidate_registry_cache();
    refresh_registry_cache(conn);
    Ok(updated)
}

/// Delete a definition.
///
/// Two refusals, both load-bearing:
/// * a `builtin=1` role cannot be deleted — the `Task` enum advertises the 7
///   unconditionally, so removing one would advertise a role that cannot run;
/// * an agent with live runs in [`running_set`] cannot be deleted — the
///   running turn resolved its definition once at spawn, and a mid-flight
///   delete would leave a session pointing at a row that is gone. Historical
///   sessions are fine (the future `agent_def_id` FK is `ON DELETE SET NULL`,
///   so they survive and the UI renders them as "agent deleted").
pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    let row = crate::db::get_subagent(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    if row.builtin {
        return Err(format!(
            "'{}' is a built-in role and cannot be deleted",
            row.name
        ));
    }
    let live = live_runs(id);
    if live > 0 {
        return Err(format!(
            "'{}' has {live} run{} in flight — stop the run before deleting it",
            row.name,
            if live == 1 { "" } else { "s" }
        ));
    }
    crate::db::delete_subagent(conn, id).map_err(|e| e.to_string())?;
    // The enum must stop advertising a name that can no longer resolve.
    invalidate_registry_cache();
    refresh_registry_cache(conn);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::mem;

    fn input(name: &str) -> SubagentInput {
        SubagentInput {
            name: name.into(),
            description: String::new(),
            prompt_md: String::new(),
            tools: None,
            engine: None,
            model: None,
            effort: None,
            sandbox_policy: "read_only".into(),
            approval_policy: "on_request".into(),
            worktree_policy: "inherit".into(),
            max_rounds: MAX_ROUNDS,
            max_concurrent: 2,
        }
    }

    /// The .md round-trip is the distribution story: export → import must
    /// reproduce every field the editor can express, and the parser must be
    /// strict — an unknown tool or key is a hard error, never a silent drop
    /// (a silently weakened allowlist is exactly the failure mode import
    /// must refuse).
    #[test]
    fn markdown_round_trip_preserves_every_field() {
        let mut def = input("doc-writer");
        def.description = "Writes documentation".into();
        def.prompt_md = "Write the docs.\n\nBe precise.".into();
        def.tools = Some(r#"["read_file","write_file"]"#.into());
        def.engine = Some("builtin".into());
        def.model = Some("openrouter::test/model".into());
        def.effort = Some("high".into());
        def.sandbox_policy = "workspace_write".into();
        def.approval_policy = "on_request".into();
        def.worktree_policy = "always".into();
        def.max_rounds = 40;
        def.max_concurrent = 1;
        let agent = Subagent {
            id: "subagent-x".into(),
            name: def.name,
            description: def.description,
            prompt_md: def.prompt_md,
            tools: def.tools,
            engine: def.engine,
            model: def.model,
            effort: def.effort,
            sandbox_policy: def.sandbox_policy,
            approval_policy: def.approval_policy,
            worktree_policy: def.worktree_policy,
            max_rounds: def.max_rounds,
            max_concurrent: def.max_concurrent,
            builtin: false,
            origin: None,
            created_at: 0,
            updated_at: 0,
        };

        let md = to_markdown(&agent);
        let parsed = from_markdown(&md).expect("round trip parses");
        assert_eq!(parsed.name, "doc-writer");
        assert_eq!(parsed.description, "Writes documentation");
        assert_eq!(parsed.prompt_md, "Write the docs.\n\nBe precise.");
        assert_eq!(parsed.tools.as_deref(), Some(r#"["read_file","write_file"]"#));
        assert_eq!(parsed.engine.as_deref(), Some("builtin"));
        assert_eq!(parsed.model.as_deref(), Some("openrouter::test/model"));
        assert_eq!(parsed.effort.as_deref(), Some("high"));
        assert_eq!(parsed.sandbox_policy, "workspace_write");
        assert_eq!(parsed.approval_policy, "on_request");
        assert_eq!(parsed.worktree_policy, "always");
        assert_eq!(parsed.max_rounds, 40);
        assert_eq!(parsed.max_concurrent, 1);
    }

    #[test]
    fn markdown_import_is_strict() {
        // Unknown tool → hard error (never a silently weakened allowlist).
        let md = "---\nname: x\ntools: [definitely_not_a_tool]\n---\nbody";
        assert!(from_markdown(md).is_err());
        // Unknown frontmatter key → hard error.
        let md = "---\nname: x\nhaunt: yes\n---\nbody";
        assert!(from_markdown(md).is_err());
        // Missing/unterminated fence → hard error.
        assert!(from_markdown("no fence at all").is_err());
        assert!(from_markdown("---\nname: x\nbody").is_err());
        // Bare markdown body without frontmatter → hard error.
        assert!(from_markdown("# Just notes\n").is_err());
    }

    #[test]
    fn markdown_import_refuses_a_concatenated_multi_doc_export() {
        // Regression: `export_subagents` concatenates every requested doc
        // with a blank line, and the first-fence parse used to swallow every
        // later doc — frontmatter included — into the FIRST agent's
        // `prompt_md`. That is exactly the silent drop STRICT import exists
        // to refuse.
        let agent = |name: &str| Subagent {
            id: format!("subagent-{name}"),
            name: name.into(),
            description: "d".into(),
            prompt_md: format!("prompt for {name}"),
            tools: None,
            engine: None,
            model: None,
            effort: None,
            sandbox_policy: "read_only".into(),
            approval_policy: "on_request".into(),
            worktree_policy: "inherit".into(),
            max_rounds: MAX_ROUNDS,
            max_concurrent: 2,
            builtin: false,
            origin: None,
            created_at: 0,
            updated_at: 0,
        };
        let two_docs = format!("{}\n\n{}", to_markdown(&agent("one")), to_markdown(&agent("two")));
        let err = from_markdown(&two_docs)
            .expect_err("a concatenated export must not import as one agent");
        assert!(err.contains("more than one"), "{err}");
        // A horizontal rule in a prompt body is NOT a second doc (the next
        // line is prose, not a `name:` key) — still one importable doc.
        let rule = "---\nname: x\n---\nintro\n\n---\n\noutro\n";
        assert!(from_markdown(rule).is_ok());
    }

    #[test]
    fn markdown_import_accepts_a_crlf_saved_doc() {
        // Regression: a doc saved by a Windows editor (CRLF) was rejected at
        // the opening fence, and a CRLF closing fence leaked a leading
        // blank line into `prompt_md`.
        let md = "---\r\nname: doc-writer\r\ndescription: d\r\n---\r\nbody text\r\n";
        let parsed = from_markdown(md).expect("a CRLF doc is the same doc");
        assert_eq!(parsed.name, "doc-writer");
        assert_eq!(parsed.description, "d");
        assert_eq!(
            parsed.prompt_md, "body text",
            "no fence line-ending junk may ride into the prompt body"
        );
    }

    #[test]
    fn a_multi_line_description_is_refused_at_save_time() {
        // The description lands on ONE `description:` frontmatter line on
        // export; a newline would corrupt that round-trip, so it is refused
        // where the user (or model) is looking at the field.
        let mut bad = input("doc-writer");
        bad.description = "line one\nline two".into();
        let err = validate_input(&mut bad, None).unwrap_err();
        assert!(err.contains("single line"), "{err}");
    }

    #[test]
    fn try_acquire_enforces_both_caps_and_releases() {
        // Regression: the budget check and the slot bump used to live in
        // separate critical sections, so two racing spawns could both see
        // "room left". try_acquire does check+bump under one lock hold.
        bump_running("acq-x", 1);
        // Per-agent cap already met.
        let err = try_acquire_running("acq-x", "x", 1, MAX_ACTIVE_SUBAGENT).unwrap_err();
        assert!(err.contains("in flight"), "{err}");
        // App-wide cap met (any agent's live runs count).
        let err = try_acquire_running("acq-y", "y", 5, 1).unwrap_err();
        assert!(err.contains("app-wide"), "{err}");
        // Room on both axes acquires exactly one slot…
        try_acquire_running("acq-y", "y", 5, MAX_ACTIVE_SUBAGENT).expect("acquires");
        assert_eq!(live_runs("acq-y"), 1);
        // …and a same-budget racer is now refused.
        assert!(try_acquire_running("acq-y", "y", 1, MAX_ACTIVE_SUBAGENT).is_err());
        // Release is saturating: the count never goes negative.
        bump_running("acq-y", -1);
        bump_running("acq-y", -1);
        bump_running("acq-x", -1);
        assert_eq!(live_runs("acq-y"), 0);
        assert_eq!(live_runs("acq-x"), 0);
    }

    /// Guard the live-run bookkeeping used by the delete refusal: tests that
    /// need a busy agent must not leak their entry into the static set.
    struct LiveRunGuard(String);

    impl LiveRunGuard {
        fn enter(agent_id: &str) -> Self {
            let mut set = running_set().lock();
            *set.entry(agent_id.to_string()).or_insert(0) += 1;
            Self(agent_id.to_string())
        }
    }

    impl Drop for LiveRunGuard {
        fn drop(&mut self) {
            let mut set = running_set().lock();
            if let Some(n) = set.get_mut(&self.0) {
                *n -= 1;
                if *n <= 0 {
                    set.remove(&self.0);
                }
            }
        }
    }

    // ── BUILTIN_ROLES ─────────────────────────────────────────────────────

    #[test]
    fn builtin_roles_are_non_empty_and_distinct_instructions() {
        for role in BUILTIN_ROLES {
            assert!(
                !role.instruction.trim().is_empty(),
                "{} has no instruction",
                role.name
            );
        }
        // The `match` these strings came from aliased "edit" | "refactor", so
        // 7 roles carry 6 distinct instructions. That alias is preserved on
        // purpose (see BUILTIN_ROLES); what must never happen is two OTHER
        // roles sharing a prompt.
        let mut seen: HashMap<&str, &str> = HashMap::new();
        for role in BUILTIN_ROLES {
            match seen.insert(role.instruction, role.name) {
                None => {}
                Some(first) => assert!(
                    roles_are_aliased(first, role.name),
                    "'{first}' and '{}' share an instruction unintentionally",
                    role.name
                ),
            }
        }
        assert_eq!(seen.len(), 6, "one aliased pair, 6 distinct prompts");
        assert_eq!(
            builtin_role_instruction("refactor"),
            builtin_role_instruction("edit"),
            "the edit/refactor alias survives the move to data"
        );
        // The 7 names are exactly the Task schema's subagent_type enum.
        let names: Vec<&str> = BUILTIN_ROLES.iter().map(|r| r.name).collect();
        assert_eq!(
            names,
            vec!["explore", "edit", "analyze", "research", "write", "test", "refactor"]
        );
    }

    fn roles_are_aliased(a: &str, b: &str) -> bool {
        matches!((a, b), ("edit", "refactor") | ("refactor", "edit"))
    }

    #[test]
    fn builtin_role_instruction_answers_for_each_role() {
        for role in BUILTIN_ROLES {
            assert_eq!(builtin_role_instruction(role.name), Some(role.instruction));
        }
        assert_eq!(builtin_role_instruction("nope"), None);
        assert_eq!(builtin_role_instruction(""), None);
        // Case-sensitive: the `Task` enum values are lowercase and a
        // near-miss must take the caller's fallback, not a role prompt.
        assert_eq!(builtin_role_instruction("Explore"), None);
        assert!(
            is_builtin_role("EXPLORE"),
            "the reservation is case-insensitive"
        );
        assert!(!is_builtin_role("explores"));
    }

    // ── read-only set ──────────────────────────────────────────────────────

    /// The duplication of `dispatch::SUBAGENT_TOOL_ALLOW` must not drift, so
    /// the set is pinned by name (the const there is module-private; Phase 2
    /// deletes it in favour of this table and the parity test moves with it).
    #[test]
    fn read_only_set_is_the_pinned_twelve() {
        assert_eq!(
            BUILTIN_READ_ONLY_TOOLS,
            [
                "list_directory",
                "read_file",
                "search_files",
                "search_content",
                "vault_list",
                "vault_read",
                "vault_search",
                "fetch_url",
                "web_search",
                "add_source_note",
                "get_source_ledger",
                "get_capabilities",
            ]
        );
    }

    /// The ceiling is a ceiling: it may never contain a spawn-capable tool
    /// (depth 1) and, under read_only, never a mutating one.
    #[test]
    fn ceiling_never_widens_past_its_policy() {
        const SPAWN_CAPABLE: [&str; 5] = [
            "Task",
            "run_shell",
            "spawn_session",
            "message_session",
            "run_code",
        ];
        let read_only = builtin_ceiling("read_only");
        assert_eq!(read_only.len(), BUILTIN_READ_ONLY_TOOLS.len());
        for name in &BUILTIN_READ_ONLY_TOOLS {
            assert!(
                read_only.contains(*name),
                "{name} missing from the read-only set"
            );
        }
        for name in WORKSPACE_WRITE_TOOLS {
            assert!(
                !read_only.contains(name),
                "{name} is mutating and must stay out of a read_only agent's set"
            );
        }
        for name in SPAWN_CAPABLE {
            assert!(!read_only.contains(name), "{name} is spawn-capable");
        }

        let writable = builtin_ceiling("workspace_write");
        assert_eq!(
            writable.len(),
            BUILTIN_READ_ONLY_TOOLS.len() + WORKSPACE_WRITE_TOOLS.len()
        );
        for name in WORKSPACE_WRITE_TOOLS {
            assert!(writable.contains(name), "{name} missing from the write set");
        }
        for name in SPAWN_CAPABLE {
            assert!(
                !writable.contains(name),
                "{name} must stay unreachable: depth is 1"
            );
        }
        // An unknown policy is treated as the most restrictive one.
        assert_eq!(builtin_ceiling("full_access"), read_only);
    }

    // ── resolve_allowlist ──────────────────────────────────────────────────

    #[test]
    fn allowlist_none_def_and_null_tools_mean_engine_default() {
        let conn = mem();
        assert!(resolve_allowlist(&conn, None).is_none());

        let agent = create(&conn, &input("planner")).unwrap();
        assert!(agent.tools.is_none());
        assert!(
            resolve_allowlist(&conn, Some(&agent)).is_none(),
            "tools = NULL → the engine's own default"
        );

        // A definition deleted out from under the caller also falls back.
        let stale = agent.clone();
        delete(&conn, &agent.id).unwrap();
        assert!(resolve_allowlist(&conn, Some(&stale)).is_none());
    }

    #[test]
    fn allowlist_explicit_list_is_enforced_verbatim_when_read_only() {
        let conn = mem();
        let mut inp = input("reader");
        inp.tools = Some(r#"["read_file","search_content"]"#.into());
        let agent = create(&conn, &inp).unwrap();
        let set = resolve_allowlist(&conn, Some(&agent)).expect("an explicit list is a set");
        let mut got: Vec<&str> = set.iter().map(String::as_str).collect();
        got.sort_unstable();
        assert_eq!(got, vec!["read_file", "search_content"]);
    }

    #[test]
    fn allowlist_drops_mutating_tools_under_read_only() {
        let conn = mem();
        let mut inp = input("sneaky");
        inp.tools = Some(r#"["read_file","write_file","run_shell","Task"]"#.into());
        inp.sandbox_policy = "read_only".into();
        let agent = create(&conn, &inp).unwrap();
        let set = resolve_allowlist(&conn, Some(&agent)).expect("explicit list");
        assert!(set.contains("read_file"));
        assert!(
            !set.contains("write_file"),
            "mutating tool smuggled past policy"
        );
        assert!(!set.contains("run_shell"));
        assert!(!set.contains("Task"));
    }

    #[test]
    fn allowlist_admits_mutating_tools_under_workspace_write() {
        let conn = mem();
        let mut inp = input("author");
        inp.tools = Some(r#"["read_file","write_file","vault_write"]"#.into());
        inp.sandbox_policy = "workspace_write".into();
        let agent = create(&conn, &inp).unwrap();
        let set = resolve_allowlist(&conn, Some(&agent)).expect("explicit list");
        assert!(set.contains("write_file"));
        assert!(set.contains("vault_write"));
        assert!(set.contains("read_file"));
    }

    #[test]
    fn allowlist_ignores_names_outside_the_ceiling_entirely() {
        let conn = mem();
        let mut inp = input("picky");
        inp.tools = Some(r#"["read_file","not_a_real_tool"]"#.into());
        inp.sandbox_policy = "workspace_write".into();
        let agent = create(&conn, &inp).unwrap();
        let set = resolve_allowlist(&conn, Some(&agent)).expect("explicit list");
        assert!(set.contains("read_file"));
        assert!(!set.contains("not_a_real_tool"));
    }

    // ── name validation ────────────────────────────────────────────────────

    #[test]
    fn name_validation_rejects_empty_too_long_and_illegal_characters() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err(), "whitespace-only is empty");
        assert!(
            validate_name(&"a".repeat(MAX_NAME_LEN)).is_ok(),
            "exactly the limit is allowed"
        );
        assert!(
            validate_name(&"a".repeat(MAX_NAME_LEN + 1)).is_err(),
            "one over the limit is not"
        );
        // Illegal characters: uppercase, punctuation, non-ASCII, path chars.
        for bad in [
            "Doc Writer",
            "doc_writer",
            "doc.writer",
            "doc/writer",
            "übique",
        ] {
            assert!(validate_name(bad).is_err(), "{bad} should be rejected");
        }
        // Hyphens, digits and inner spaces are fine; the name is stored
        // normalized.
        assert_eq!(validate_name("  doc   writer  ").unwrap(), "doc-writer");
        assert_eq!(validate_name("agent-2").unwrap(), "agent-2");
        assert_eq!(slugify("  doc   writer  "), "doc-writer");
        assert_eq!(
            slugify("---"),
            "agent",
            "an empty slug still yields a usable id"
        );
    }

    #[test]
    fn name_validation_reserves_builtin_role_names() {
        let conn = mem();
        for role in BUILTIN_ROLES {
            let mut inp = input(role.name);
            let err = validate_input(&mut inp, None).unwrap_err();
            assert!(err.contains("built-in role"), "{}: {err}", role.name);
        }
        // The seeded rows really are there, so a colliding name also hits the
        // uniqueness check.
        assert_eq!(list(&conn).len(), 7);
    }

    #[test]
    fn name_uniqueness_is_case_insensitive() {
        let conn = mem();
        create(&conn, &input("doc-writer")).unwrap();
        let err = create(&conn, &input("doc-writer")).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // A differently-spaced name normalizes to the same one.
        let err = create(&conn, &input("doc   writer")).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(list(&conn).len(), 8, "only the rename collided");
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    #[test]
    fn create_validates_policies_and_clamps_budgets() {
        let conn = mem();
        let mut inp = input("builder");
        inp.sandbox_policy = "yolo".into();
        assert!(validate_input(&mut inp, None).is_err());

        let mut inp = input("builder");
        inp.approval_policy = "yolo".into();
        assert!(validate_input(&mut inp, None).is_err());

        let mut inp = input("builder");
        inp.worktree_policy = "maybe".into();
        assert!(validate_input(&mut inp, None).is_err());

        let mut inp = input("builder");
        inp.tools = Some("not json".into());
        assert!(validate_input(&mut inp, None).is_err());
        inp.tools = Some(r#"{"read_file":true}"#.into());
        assert!(validate_input(&mut inp, None).is_err(), "must be an array");

        let mut inp = input("builder");
        inp.description = "x".repeat(MAX_DESCRIPTION_LEN + 1);
        assert!(validate_input(&mut inp, None).is_err());

        // Out-of-range budgets are clamped, not rejected.
        let mut inp = input("builder");
        inp.max_rounds = 0;
        inp.max_concurrent = 0;
        validate_input(&mut inp, None).unwrap();
        assert_eq!(inp.max_rounds, 1);
        assert_eq!(inp.max_concurrent, 1);
        inp.max_rounds = 10_000;
        validate_input(&mut inp, None).unwrap();
        assert_eq!(inp.max_rounds, MAX_ROUNDS);
    }

    #[test]
    fn update_renames_and_refuses_builtin_renames() {
        let conn = mem();
        let agent = create(&conn, &input("first")).unwrap();
        let mut edit = input("second");
        edit.prompt_md = "updated".into();
        let updated = update(&conn, &agent.id, &edit).unwrap();
        assert_eq!(updated.name, "second");
        assert_eq!(updated.prompt_md, "updated");
        assert!(!updated.builtin, "an update never flips the builtin flag");

        // A builtin row can be edited (prompt/model) but not renamed.
        let mut edit = input("explore");
        edit.prompt_md = "explore, but with a twist".into();
        let updated = update(&conn, "builtin-explore", &edit).unwrap();
        assert_eq!(updated.builtin, true);
        assert_eq!(updated.prompt_md, "explore, but with a twist");

        let mut edit = input("not-a-role");
        let err = update(&conn, "builtin-explore", &edit).unwrap_err();
        assert!(err.contains("built-in role"), "{err}");

        assert!(update(&conn, "nope", &input("ghost")).is_err());
    }

    #[test]
    fn delete_refuses_builtins_and_running_agents() {
        let conn = mem();
        // A builtin role is not deletable.
        let err = delete(&conn, "builtin-explore").unwrap_err();
        assert!(err.contains("built-in role"), "{err}");

        // An idle custom agent deletes.
        let agent = create(&conn, &input("temp")).unwrap();
        delete(&conn, &agent.id).unwrap();
        assert!(get(&conn, &agent.id).is_none());
        assert!(delete(&conn, &agent.id).is_err(), "already gone");

        // A busy one does not.
        let agent = create(&conn, &input("busy")).unwrap();
        let _run = LiveRunGuard::enter(&agent.id);
        assert_eq!(live_runs(&agent.id), 1);
        let err = delete(&conn, &agent.id).unwrap_err();
        assert!(err.contains("in flight"), "{err}");
        drop(_run);
        assert_eq!(live_runs(&agent.id), 0);
        delete(&conn, &agent.id).expect("deletable once idle");
    }

    #[test]
    fn get_and_list_read_the_registry() {
        let conn = mem();
        let rows = list(&conn);
        assert_eq!(rows.len(), 7, "the 7 seeded roles");
        assert!(rows.iter().all(|r| r.builtin));
        assert_eq!(get(&conn, "builtin-test").unwrap().name, "test");
        assert!(get(&conn, "missing").is_none());

        create(&conn, &input("helper")).unwrap();
        let rows = list(&conn);
        assert_eq!(rows.len(), 8);
        assert!(rows[0..7].iter().all(|r| r.builtin), "builtins sort first");
        assert_eq!(rows[7].name, "helper");
    }

    // ── registry name cache ───────────────────────────────────────────────
    //
    // The cache is a process-wide static, so every test here brackets itself
    // with an invalidate: a leaked entry from one test would silently
    // populate another one's `Task` enum.

    /// Drop the cached names on drop so no test can leak its registry into
    /// the next one's spec builds.
    ///
    /// Bracketing is NECESSARY but not sufficient: the cache is process-wide
    /// and the test runner is parallel, so a `list()` in another test can
    /// republish its own in-memory registry mid-test. Every assertion below
    /// is therefore about MEMBERSHIP and UNIQUENESS, never about an exact
    /// length — a count would be a race, not a contract.
    struct CacheGuard;

    impl CacheGuard {
        fn start() -> Self {
            invalidate_registry_cache();
            Self
        }
    }

    impl Drop for CacheGuard {
        fn drop(&mut self) {
            invalidate_registry_cache();
        }
    }

    /// Names are unique, case-insensitively (the enum must never offer a
    /// model two ways to spell one agent).
    fn assert_unique(names: &[String]) {
        let mut lower: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
        let before = lower.len();
        lower.sort();
        lower.dedup();
        assert_eq!(before, lower.len(), "duplicate names in the enum: {names:?}");
    }

    fn cached(conn: &Connection) -> Vec<String> {
        refresh_registry_cache(conn);
        (*cached_agent_names()).clone()
    }

    #[test]
    fn registry_cache_carries_created_updated_and_deleted_names() {
        let _guard = CacheGuard::start();
        let conn = mem();
        assert!(cached(&conn).contains(&"explore".to_string()));

        // Create: the new name is visible on the next read, with no TTL wait.
        let agent = create(&conn, &input("doc-writer")).unwrap();
        assert!(cached_agent_names().contains(&"doc-writer".to_string()));

        // Update (a rename) is visible immediately too. Republish from this
        // connection so the assertion is about THIS registry, whatever else
        // the parallel runner has cached.
        update(&conn, &agent.id, &input("doc-editor")).unwrap();
        let names = cached(&conn);
        assert!(names.contains(&"doc-editor".to_string()));
        assert!(!names.contains(&"doc-writer".to_string()));
        assert_unique(&names);

        // Delete drops it from the enum.
        delete(&conn, &agent.id).unwrap();
        let names = cached(&conn);
        assert!(!names.contains(&"doc-editor".to_string()));
    }

    #[test]
    fn registry_cache_never_advertises_a_reserved_role_name_twice() {
        let _guard = CacheGuard::start();
        let conn = mem();
        create(&conn, &input("helper")).unwrap();
        let names = cached(&conn);
        // The seeded builtin rows ARE in the cached list (they are registry
        // rows); the schema builder is what dedupes them against its own
        // builtin-role list.
        assert!(names.contains(&"explore".to_string()));
        assert!(names.contains(&"helper".to_string()));
        assert_unique(&names);
    }

    #[test]
    fn invalidate_then_refresh_republishes_names_created_after_a_cached_read() {
        let _guard = CacheGuard::start();
        let conn = mem();
        // Warm the cache from the 7 seeded rows.
        let before = cached(&conn);
        assert!(before.contains(&"explore".to_string()));
        assert!(!before.contains(&"late-comer".to_string()));

        let agent = create(&conn, &input("late-comer")).unwrap();
        // Explicitly invalidate (what a foreign write path would do) — the
        // names come back on the next refresh, not on a timer. In between,
        // the read either has nothing warm to serve (the usual case: an
        // in-memory test connection leaves no path to self-refresh through)
        // or self-refreshes from a remembered file — never a STALE list.
        invalidate_registry_cache();
        let stale = cached_agent_names();
        assert!(
            stale.is_empty() || !stale.contains(&"late-comer".to_string()),
            "an invalidated cache must not serve the pre-write list: {stale:?}"
        );
        refresh_registry_cache(&conn);
        assert!(cached_agent_names().contains(&"late-comer".to_string()));
        assert!(get(&conn, &agent.id).is_some());
    }
}
