//! Subagent-agent commands: CRUD for declarative subagents (see
//! `chat/subagent.rs` + `db/subagent.rs`).
//!
//! Thin Tauri wrappers — validation and the refusals (builtin rows, agents
//! with runs in flight) live in `chat::subagent` so the chat tool layer and this
//! IPC surface can never accept different shapes. Every error is a `String`
//! because the Subagent editor shows it verbatim next to the field that caused it.

use tauri::{Manager, State};

use crate::chat::subagents::{self, Subagent, SubagentInput};
use crate::DbState;

/// Every definition, builtins first (the 7 seeded roles) then user rows by
/// name. The 7 builtin rows always exist — the seed is idempotent and runs on
/// every startup.
#[tauri::command(async)]
pub fn list_subagents(db: State<'_, DbState>) -> Result<Vec<Subagent>, String> {
    let conn = db.0.lock();
    Ok(subagents::list(&conn))
}

#[tauri::command(async)]
pub fn get_subagent(
    db: State<'_, DbState>,
    agent_id: String,
) -> Result<Option<Subagent>, String> {
    let conn = db.0.lock();
    Ok(subagents::get(&conn, &agent_id))
}

#[tauri::command(async)]
pub fn create_subagent(
    db: State<'_, DbState>,
    input: SubagentInput,
) -> Result<Subagent, String> {
    let conn = db.0.lock();
    subagents::create(&conn, &input)
}

#[tauri::command(async)]
pub fn update_subagent(
    db: State<'_, DbState>,
    agent_id: String,
    input: SubagentInput,
) -> Result<Subagent, String> {
    let conn = db.0.lock();
    subagents::update(&conn, &agent_id, &input)
}

/// Delete a definition. Refused for a builtin role and for an agent with runs
/// in flight; historical sessions survive (their `agent_def_id` is set to NULL
/// by the FK).
#[tauri::command(async)]
pub fn delete_subagent(db: State<'_, DbState>, agent_id: String) -> Result<(), String> {
    let conn = db.0.lock();
    subagents::delete(&conn, &agent_id)
}

/// Spawn a subagent run by hand (the Run button — Phase 2.5): a normal,
/// keep-chatting session carrying the definition's engine/model/policies,
/// linked by `agent_def_id`, optionally isolated in its own worktree. The
/// session id comes back so the UI can select it and watch the first turn
/// stream live (`wait` is for programmatic callers that want the turn to
/// settle first). Session Mesh does not need to be enabled — this goes
/// through `session_fabric::subagent_spawn`, not the mesh tool surface.
#[tauri::command(async)]
pub async fn run_subagent(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    agent_id: String,
    task: String,
    project_id: Option<String>,
    wait: Option<bool>,
) -> Result<String, String> {
    // The DbState handle is moved into the spawn core via `app.state`, but
    // Tauri requires the parameter to be named — touch it so the signature
    // stays honest about the dependency.
    let _ = &db;
    crate::session_fabric::subagent_spawn(
        &app,
        &agent_id,
        &task,
        project_id.as_deref(),
        wait.unwrap_or(false),
    )
    .await
}

/// Export definitions as shareable markdown docs (Claude-Code-compatible
/// frontmatter + relay extensions). Omitting `agent_ids` exports every USER
/// agent — the 7 builtin roles are deliberately left out of the default:
/// they already exist in every install (the idempotent seed), and their
/// reserved names make their docs unimportable by construction. Explicit ids
/// (a user deliberately exporting a builtin to share its edited prompt) are
/// honored verbatim.
#[tauri::command(async)]
pub fn export_subagents(
    db: State<'_, DbState>,
    agent_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let conn = db.0.lock();
    let rows = match &agent_ids {
        Some(ids) => ids
            .iter()
            .filter_map(|id| subagents::get(&conn, id))
            .collect::<Vec<_>>(),
        None => subagents::list(&conn).into_iter().filter(|a| !a.builtin).collect(),
    };
    if let Some(ids) = &agent_ids {
        for id in ids {
            if !rows.iter().any(|r| &r.id == id) {
                return Err(format!("subagent \"{id}\" not found"));
            }
        }
    }
    Ok(rows
        .iter()
        .map(subagents::to_markdown)
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Import ONE markdown doc as a new definition. Strict: an unknown tool,
/// unknown policy, or unparsable frontmatter is a hard error — a silently
/// weakened allowlist is the failure mode this refuses.
#[tauri::command(async)]
pub fn import_subagent(
    db: State<'_, DbState>,
    markdown: String,
) -> Result<Subagent, String> {
    let conn = db.0.lock();
    let input = subagents::from_markdown(&markdown)?;
    subagents::create(&conn, &input)
}

/// Run history, newest first (optionally one agent's runs).
#[tauri::command(async)]
pub fn list_subagent_runs(
    db: State<'_, DbState>,
    agent_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<crate::db::SubagentRun>, String> {
    let conn = db.0.lock();
    crate::db::list_subagent_runs(&conn, agent_id.as_deref(), limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Native harness stores (see `chat::subagents`'s native-sync section).
//
// The whole point of these is that an import is a LINK, not a copy: the row
// records the `.md` it came from (`source_path`) and a re-sync writes the
// file's identity/prompt/allowlist/model back onto that same row. That is what
// makes a subagent someone wrote in `~/.claude/agents` a real member of the
// registry instead of a snapshot that silently rots.
// ---------------------------------------------------------------------------

/// What a bulk native-store sync did, per file. Returned rather than logged so
/// the panel can say what happened ("2 imported, 1 updated") instead of leaving
/// the user to infer it from the list changing underneath them.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncReport {
    /// Rows created from files that had no link yet.
    pub created: Vec<String>,
    /// Rows refreshed because their file's fields changed.
    pub updated: Vec<String>,
    /// Files that parsed but already matched their row — reported so an
    /// unchanged sync is distinguishable from one that found nothing.
    pub unchanged: Vec<String>,
    /// Linked rows whose `.md` is gone. The rows are KEPT (an agent may have
    /// run history, and the file may be temporarily unreadable) and badged in
    /// the panel; this is the list behind that badge.
    pub missing: Vec<String>,
}

/// Read one native file out of the harness's stores. Walks the same directories
/// the listing does and picks the row by its exact source path, so the
/// upsert's content always comes from a fresh parse on this side — never from
/// a payload the client could have edited in between listing and import.
fn native_row_for(
    harness_id: &str,
    project_root: Option<&str>,
    source_path: &str,
) -> Result<crate::harness_config::HarnessSubagentInfo, String> {
    let rows = crate::harness_config::harness_subagents(harness_id, project_root);
    let wanted = source_path.trim();
    rows.into_iter()
        .find(|r| r.source_path.eq_ignore_ascii_case(wanted))
        .ok_or_else(|| {
            format!(
                "no native subagent at {wanted} — the file may have been moved or \
                 deleted, or it has no `---` frontmatter"
            )
        })
}

/// Import (or re-import) ONE native file into the registry.
///
/// Idempotent by design: the first call creates a row and links it to the
/// file; every later call refreshes that row's file-owned fields in place. The
/// UI's per-row "Import" button and the watcher-driven re-sync both land here,
/// so there is exactly one definition of what a native file becomes.
#[tauri::command(async)]
pub fn import_harness_subagent(
    db: State<'_, DbState>,
    harness_id: String,
    source_path: String,
    project_root: Option<String>,
) -> Result<crate::db::Subagent, String> {
    let info = native_row_for(&harness_id, project_root.as_deref(), &source_path)?;
    let conn = db.0.lock();
    subagents::sync_native_subagent(&conn, &harness_id, &info)
        .map(|(row, _)| row)
}

/// Reconcile the registry with every CLI harness's native store: import the
/// files that aren't linked yet, refresh the ones that are.
///
/// This is the bulk, single-click counterpart to `import_harness_subagent` —
/// the user has said "bring these in", so unlike the watcher (which only
/// refreshes rows the user already linked) this one creates rows. The card
/// still never imports on its own.
#[tauri::command(async)]
pub async fn sync_harness_subagents(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    harness_ids: Option<Vec<String>>,
    project_root: Option<String>,
) -> Result<NativeSyncReport, String> {
    let wanted = harness_ids.unwrap_or_else(|| {
        crate::harness_config::NATIVE_SUBAGENT_HARNESSES
            .iter()
            .map(|s| s.to_string())
            .collect()
    });
    // The walks are blocking filesystem I/O — a sync command would run them on
    // the main thread and freeze the window on a cold, slow home directory.
    let root = project_root.clone();
    let mut infos: Vec<(String, crate::harness_config::HarnessSubagentInfo)> =
        tauri::async_runtime::spawn_blocking(move || {
            wanted
                .iter()
                .flat_map(|id| {
                    crate::harness_config::harness_subagents(id, root.as_deref())
                        .into_iter()
                        .map(move |info| (id.clone(), info))
                })
                .collect()
        })
        .await
        .map_err(|e| format!("native subagent listing join failed: {e}"))?;

    // Deterministic order so two runs over the same store allocate the same
    // -2/-3 suffixes (name de-collision is positional).
    infos.sort_by(|a, b| a.1.source_path.cmp(&b.1.source_path));

    let mut report = NativeSyncReport::default();
    {
        let conn = db.0.lock();
        for (harness_id, info) in &infos {
            match subagents::sync_native_subagent(&conn, harness_id, info) {
                Ok((row, outcome)) => {
                    let name = row.name;
                    match outcome {
                        subagents::SyncOutcome::Created => report.created.push(name),
                        subagents::SyncOutcome::Updated => report.updated.push(name),
                        subagents::SyncOutcome::Unchanged => report.unchanged.push(name),
                    }
                }
                // One unimportable file (a name that can't be slugged, a tool
                // the registry doesn't ship) must not abandon the rest of the
                // store — the card shows the failure and the other rows land.
                Err(_) => continue,
            }
        }
        report.missing = subagents::native_rows_with_missing_sources(&conn)
            .into_iter()
            .map(|a| a.name)
            .collect();
    }

    // A sync that touched the registry changes what the `Task` enum and every
    // harness's `list_subagents` will say, so the open panels re-read.
    if !report.created.is_empty() || !report.updated.is_empty() {
        let _ = tauri::Emitter::emit(
            &app,
            "harness:subagents-changed",
            serde_json::json!({ "reason": "sync" }),
        );
    }
    Ok(report)
}

/// Refresh ONLY the rows already linked to a native file — no new imports.
///
/// This is what the filesystem watcher calls: the user already chose to import
/// that file once, so following its later edits needs no further consent, and
/// a file appearing in the store for the first time is left for the card to
/// show (and the user to import) rather than silently becoming an agent.
pub fn resync_linked_native(app: &tauri::AppHandle) -> bool {
    // PHASE 1a — which files, under the lock. One indexed read, then the lock
    // is released.
    let linked: Vec<crate::db::Subagent> = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        match crate::db::list_subagents_by_source(&conn) {
            Ok(rows) => rows,
            Err(_) => return false,
        }
    };

    // PHASE 1b — the file reads, with NO lock held. Every `crate::db` call
    // takes the global `DbState` mutex, and the same mutex serializes every
    // session write, cost query and settings read in the app. Holding it across
    // `read_to_string` on a network-mounted home directory would stall the UI
    // behind a filesystem round trip, so all the I/O is finished before the
    // lock is taken again.
    let snapshot: Vec<(String, crate::harness_config::HarnessSubagentInfo)> = linked
        .into_iter()
        .filter_map(|row| {
            let path = row.source_path.as_deref()?.to_string();
            let harness_id = harness_id_for_source(&row)?;
            // The file is gone: the row stays (it may have run history) and the
            // panel badges it. Nothing to re-parse.
            if !std::path::Path::new(&path).is_file() {
                return None;
            }
            // Re-parse through the tolerant native reader. A file that no longer
            // parses (the user trimmed its frontmatter) leaves the row as it is
            // rather than blanking an agent's prompt.
            let info = crate::harness_config::native_subagent_at(std::path::Path::new(&path))?;
            Some((harness_id, info))
        })
        .collect();
    if snapshot.is_empty() {
        return false;
    }

    // PHASE 2 — writes, lock held. `sync_native_subagent` re-resolves the row
    // by path itself, so a file deleted between the two phases is skipped.
    let mut changed = false;
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        for (harness_id, info) in &snapshot {
            if let Ok((_, subagents::SyncOutcome::Updated)) =
                subagents::sync_native_subagent(&conn, harness_id, info)
            {
                changed = true;
            }
        }
    }
    if changed {
        let _ = tauri::Emitter::emit(
            app,
            "harness:subagents-changed",
            serde_json::json!({ "reason": "watcher" }),
        );
    }
    changed
}

/// The harness whose store a linked row came from — read back off the row's
/// own `engine` column (`harness:<id>`), which is where the import wrote it.
/// A row whose engine was later edited to something else is not ours to
/// re-parse.
fn harness_id_for_source(row: &crate::db::Subagent) -> Option<String> {
    row.engine
        .as_deref()?
        .strip_prefix("harness:")
        .map(|s| s.to_string())
}

/// Stop a linked row from following its `.md` — "make this mine". The row keeps
/// everything it has; it just stops being refreshed from the file, so a later
/// sync of that file imports a separate agent rather than overwriting.
#[tauri::command(async)]
pub fn unlink_native_subagent(db: State<'_, DbState>, agent_id: String) -> Result<(), String> {
    let conn = db.0.lock();
    subagents::unlink_native_subagent(&conn, &agent_id)
}
