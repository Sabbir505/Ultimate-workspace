//! Self-improving artifacts: IPC surface (SELF_IMPROVING_ARTIFACTS.md P0).
//!
//! Thin commands over `db::improve`: version history, channels (promote /
//! rollback), run telemetry from the frontend turn lifecycle, loop-session
//! persistence, and 👍/👎 feedback attribution.

use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::db;
use crate::db::improve::{ImproveArtifact, ImproveVersion, LoopSession};
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Built-in goal-loop skill body, seeded as the loop artifact's v1 the first
/// time a loop session is recorded.
const GOAL_LOOP_SKILL_BODY: &str = include_str!("../../../skills/goal-loop-skill.md");

#[tauri::command]
pub fn list_improve_artifacts(db: State<'_, DbState>) -> CmdResult<Vec<ImproveArtifact>> {
    let conn = db.0.lock();
    let mut stmt = conn
        .prepare("SELECT id, kind, ref_key, name, created_at FROM improve_artifacts ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ImproveArtifact {
                id: r.get(0)?,
                kind: r.get(1)?,
                ref_key: r.get(2)?,
                name: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_improve_versions(db: State<'_, DbState>, artifact_id: String) -> CmdResult<Vec<ImproveVersion>> {
    let conn = db.0.lock();
    db::improve::list_versions(&conn, &artifact_id).map_err(|e| e.to_string())
}

/// Promote / rollback are the same operation: re-point a channel.
#[tauri::command]
pub fn set_improve_channel(
    db: State<'_, DbState>,
    artifact_id: String,
    channel: String,
    version: i64,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::improve::set_channel(&conn, &artifact_id, &channel, version).map_err(|e| e.to_string())
}

/// Record one execution of an artifact (frontend-known invocations, e.g.
/// prompt-template fills). Skills are recorded backend-side in the send path.
#[tauri::command]
pub fn record_artifact_run(
    db: State<'_, DbState>,
    chat_session_id: String,
    kind: String,
    ref_key: String,
    name: String,
    body: String,
) -> CmdResult<String> {
    let conn = db.0.lock();
    let artifact = db::improve::ensure_artifact(&conn, &kind, &ref_key, &name, &body)
        .map_err(|e| e.to_string())?;
    db::improve::start_run(&conn, &artifact.id, Some(&chat_session_id)).map_err(|e| e.to_string())
}

/// Close the session's open runs after a turn ends (`applied`) or errors
/// (`failed` + error code from chat:error classification).
#[tauri::command]
pub fn finish_artifact_runs(
    db: State<'_, DbState>,
    chat_session_id: String,
    outcome: String,
    error_code: Option<String>,
) -> CmdResult<usize> {
    let conn = db.0.lock();
    db::improve::finish_session_runs(&conn, &chat_session_id, &outcome, error_code.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_artifact_feedback(
    db: State<'_, DbState>,
    chat_session_id: Option<String>,
    artifact_id: Option<String>,
    verdict: String,
    reason: Option<String>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    // Attribute to the session's most recent open run when no explicit
    // artifact is given; unattributable feedback is dropped silently.
    let artifact_id = match artifact_id {
        Some(a) => Some(a),
        None => conn
            .query_row(
                "SELECT artifact_id FROM improve_runs
                  WHERE chat_session_id = ?1
                  ORDER BY started_at DESC LIMIT 1",
                params![chat_session_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?,
    };
    let Some(artifact_id) = artifact_id else { return Ok(()) };
    // Runs are typically already closed (turn ended) by the time the user
    // clicks 👍/👎, so attribute to the session's most recent run of that
    // artifact — open or finished.
    let run_id: Option<String> = conn
        .query_row(
            "SELECT id FROM improve_runs
              WHERE chat_session_id = ?1 AND artifact_id = ?2
              ORDER BY started_at DESC LIMIT 1",
            params![chat_session_id, artifact_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    db::improve::record_feedback(&conn, &artifact_id, run_id.as_deref(), chat_session_id.as_deref(), &verdict, reason.as_deref())
        .map_err(|e| e.to_string())
}

// ---- goal-loop runtime persistence ----

#[tauri::command]
pub fn loop_session_start(
    db: State<'_, DbState>,
    chat_session_id: String,
    goal: String,
    max_iterations: i64,
) -> CmdResult<LoopSession> {
    let conn = db.0.lock();
    db::improve::start_loop_session(&conn, &chat_session_id, &goal, max_iterations, GOAL_LOOP_SKILL_BODY)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn loop_session_advance(db: State<'_, DbState>, loop_id: String, iteration: i64) -> CmdResult<()> {
    let conn = db.0.lock();
    db::improve::advance_loop_session(&conn, &loop_id, iteration).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn loop_session_finish(db: State<'_, DbState>, loop_id: String, status: String) -> CmdResult<()> {
    let conn = db.0.lock();
    db::improve::finish_loop_session(&conn, &loop_id, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_loop_session(db: State<'_, DbState>, loop_id: String) -> CmdResult<Option<LoopSession>> {
    let conn = db.0.lock();
    db::improve::get_loop_session(&conn, &loop_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn latest_loop_session(db: State<'_, DbState>, chat_session_id: String) -> CmdResult<Option<LoopSession>> {
    let conn = db.0.lock();
    db::improve::latest_loop_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}
