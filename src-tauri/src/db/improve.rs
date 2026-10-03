//! Self-improving artifacts: versioning + execution telemetry
//! (SELF_IMPROVING_ARTIFACTS.md §4 versioning, §5 observation).
//!
//! Registry tables live under the `improve_*` prefix — `artifacts` is already
//! taken by the chat-attachment table. All functions take `&Connection` for
//! in-memory testability, mirroring the other db modules.
//!
//! Design invariants:
//! - versions are append-only and immutable; the live copy is whatever the
//!   `active` channel points at;
//! - runs stay open (outcome NULL) until a terminal event classifies them —
//!   turn success/error, edit-to-fork (`corrected`), or loop finish.

use rusqlite::{params, Connection, OptionalExtension};

use super::{new_id, now_ts, DbResult};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImproveArtifact {
    pub id: String,
    pub kind: String,
    pub ref_key: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImproveVersion {
    pub id: String,
    pub artifact_id: String,
    pub version: i64,
    pub body: String,
    pub meta_json: Option<String>,
    pub origin: String,
    pub parent_version: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSession {
    pub id: String,
    pub chat_session_id: String,
    pub goal: String,
    pub iteration: i64,
    pub max_iterations: i64,
    pub status: String,
    pub run_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---- artifact registry + versioning ----

fn map_artifact(row: &rusqlite::Row) -> rusqlite::Result<ImproveArtifact> {
    Ok(ImproveArtifact {
        id: row.get("id")?,
        kind: row.get("kind")?,
        ref_key: row.get("ref_key")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
    })
}

/// Insert-or-get the registry row and guarantee it has a v1 + active channel.
/// `body` seeds v1 on first sight; existing artifacts are returned untouched
/// (lazy backfill — no migration needed).
pub fn ensure_artifact(
    conn: &Connection,
    kind: &str,
    ref_key: &str,
    name: &str,
    body: &str,
) -> DbResult<ImproveArtifact> {
    let existing = conn
        .query_row(
            "SELECT * FROM improve_artifacts WHERE kind = ?1 AND ref_key = ?2",
            params![kind, ref_key],
            map_artifact,
        )
        .optional()?;
    if let Some(a) = existing {
        return Ok(a);
    }
    let id = new_id();
    let now = now_ts();
    // One logical write: registry row + v1 seed + active channel. Bare
    // autocommitted statements let a partial failure (SQLITE_BUSY is real
    // here — the headless `relay_automation` binary opens the same DB) leave
    // the artifact row with NO v1 body and no active channel, and the early
    // return above means no later call ever repairs it: `start_run`'s
    // `unwrap_or(1)` then points runs at a nonexistent version forever
    // (audit H16). Same fix shape as `delete_chat_session` /
    // `replace_file_chunks` / `remove_corpus`.
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO improve_artifacts (id, kind, ref_key, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, kind, ref_key, name, now],
        )?;
        tx.execute(
            "INSERT INTO improve_versions (id, artifact_id, version, body, origin, created_at)
             VALUES (?1, ?2, 1, ?3, 'import', ?4)",
            params![new_id(), id, body, now],
        )?;
        tx.execute(
            "INSERT INTO improve_channels (artifact_id, channel, version, updated_at)
             VALUES (?1, 'active', 1, ?2)",
            params![id, now],
        )?;
        tx.commit()?;
    }
    Ok(ImproveArtifact {
        id,
        kind: kind.to_string(),
        ref_key: ref_key.to_string(),
        name: name.to_string(),
        created_at: now,
    })
}

/// Append a new version derived from `parent_version` when the body actually
/// changed. Returns the new version number, or None when body is unchanged
/// (idempotent re-runs must not spam the history).
pub fn record_version(
    conn: &Connection,
    artifact_id: &str,
    parent_version: i64,
    body: &str,
    meta_json: Option<&str>,
    origin: &str,
) -> DbResult<Option<i64>> {
    let parent_body: Option<String> = conn
        .query_row(
            "SELECT body FROM improve_versions WHERE artifact_id = ?1 AND version = ?2",
            params![artifact_id, parent_version],
            |r| r.get(0),
        )
        .optional()?;
    if parent_body.as_deref() == Some(body) {
        return Ok(None);
    }
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM improve_versions WHERE artifact_id = ?1",
        params![artifact_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO improve_versions (id, artifact_id, version, body, meta_json, origin, parent_version, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![new_id(), artifact_id, next, body, meta_json, origin, parent_version, now_ts()],
    )?;
    Ok(Some(next))
}

pub fn list_versions(conn: &Connection, artifact_id: &str) -> DbResult<Vec<ImproveVersion>> {
    let mut stmt = conn.prepare(
        "SELECT id, artifact_id, version, body, meta_json, origin, parent_version, created_at
           FROM improve_versions WHERE artifact_id = ?1 ORDER BY version ASC",
    )?;
    let rows = stmt.query_map(params![artifact_id], |r| {
        Ok(ImproveVersion {
            id: r.get(0)?,
            artifact_id: r.get(1)?,
            version: r.get(2)?,
            body: r.get(3)?,
            meta_json: r.get(4)?,
            origin: r.get(5)?,
            parent_version: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    rows.collect()
}

/// Point a channel at a version (promote/rollback are the same operation).
pub fn set_channel(
    conn: &Connection,
    artifact_id: &str,
    channel: &str,
    version: i64,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO improve_channels (artifact_id, channel, version, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(artifact_id, channel) DO UPDATE SET version = ?3, updated_at = ?4",
        params![artifact_id, channel, version, now_ts()],
    )?;
    Ok(())
}

pub fn channel_version(
    conn: &Connection,
    artifact_id: &str,
    channel: &str,
) -> DbResult<Option<i64>> {
    conn.query_row(
        "SELECT version FROM improve_channels WHERE artifact_id = ?1 AND channel = ?2",
        params![artifact_id, channel],
        |r| r.get(0),
    )
    .optional()
}

/// The stored body of one version.
pub fn version_body(
    conn: &Connection,
    artifact_id: &str,
    version: i64,
) -> DbResult<Option<String>> {
    conn.query_row(
        "SELECT body FROM improve_versions WHERE artifact_id = ?1 AND version = ?2",
        params![artifact_id, version],
        |r| r.get(0),
    )
    .optional()
}

// ---- run telemetry ----

/// Open a run row for one execution of the artifact's active version.
pub fn start_run(
    conn: &Connection,
    artifact_id: &str,
    chat_session_id: Option<&str>,
) -> DbResult<String> {
    let version = channel_version(conn, artifact_id, "active")?.unwrap_or(1);
    let id = new_id();
    conn.execute(
        "INSERT INTO improve_runs (id, artifact_id, version, chat_session_id, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, artifact_id, version, chat_session_id, now_ts()],
    )?;
    Ok(id)
}

/// Close every open run in a chat session with one outcome. Returns the
/// number of rows closed. Used by turn success ('applied'), turn error
/// ('failed'), and edit-to-fork ('corrected').
pub fn finish_session_runs(
    conn: &Connection,
    chat_session_id: &str,
    outcome: &str,
    error_code: Option<&str>,
) -> DbResult<usize> {
    let n = conn.execute(
        "UPDATE improve_runs
            SET finished_at = ?2, outcome = ?3, error_code = COALESCE(?4, error_code)
          WHERE chat_session_id = ?1 AND finished_at IS NULL",
        params![chat_session_id, now_ts(), outcome, error_code],
    )?;
    Ok(n)
}

pub fn record_feedback(
    conn: &Connection,
    artifact_id: &str,
    run_id: Option<&str>,
    chat_session_id: Option<&str>,
    verdict: &str,
    reason: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO improve_feedback (id, artifact_id, run_id, chat_session_id, verdict, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![new_id(), artifact_id, run_id, chat_session_id, verdict, reason, now_ts()],
    )?;
    Ok(())
}

/// Aggregate per-version health used by the P1 improvement sweep: open runs
/// are ignored, `corrected|failed` count as bad.
pub fn run_health(conn: &Connection, artifact_id: &str) -> DbResult<(i64, i64)> {
    let (total, bad) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN outcome IN ('failed', 'corrected') THEN 1 ELSE 0 END), 0)
           FROM improve_runs
          WHERE artifact_id = ?1 AND finished_at IS NOT NULL",
        params![artifact_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((total, bad))
}

// ---- goal-loop runtime persistence ----

fn map_loop(row: &rusqlite::Row) -> rusqlite::Result<LoopSession> {
    Ok(LoopSession {
        id: row.get("id")?,
        chat_session_id: row.get("chat_session_id")?,
        goal: row.get("goal")?,
        iteration: row.get("iteration")?,
        max_iterations: row.get("max_iterations")?,
        status: row.get("status")?,
        run_id: row.get("run_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Create a loop session and its telemetry run. The loop artifact is the
/// goal-loop skill itself (`kind='loop'`, `ref_key='goal'`) — one shared
/// registry entry whose version tracks the skill body.
pub fn start_loop_session(
    conn: &Connection,
    chat_session_id: &str,
    goal: &str,
    max_iterations: i64,
    loop_skill_body: &str,
) -> DbResult<LoopSession> {
    let artifact = ensure_artifact(conn, "loop", "goal", "Goal loop", loop_skill_body)?;
    let run_id = start_run(conn, &artifact.id, Some(chat_session_id))?;
    let id = new_id();
    let now = now_ts();
    conn.execute(
        "INSERT INTO loop_sessions (id, chat_session_id, goal, iteration, max_iterations, status, run_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, 'running', ?5, ?6, ?6)",
        params![id, chat_session_id, goal, max_iterations, run_id, now],
    )?;
    Ok(LoopSession {
        id,
        chat_session_id: chat_session_id.to_string(),
        goal: goal.to_string(),
        iteration: 0,
        max_iterations,
        status: "running".to_string(),
        run_id: Some(run_id),
        created_at: now,
        updated_at: now,
    })
}

pub fn advance_loop_session(conn: &Connection, loop_id: &str, iteration: i64) -> DbResult<()> {
    conn.execute(
        "UPDATE loop_sessions SET iteration = ?2, updated_at = ?3 WHERE id = ?1",
        params![loop_id, iteration, now_ts()],
    )?;
    Ok(())
}

/// Terminal transition. Maps the loop status to the run outcome:
/// complete→applied, blocked→failed, stopped/maxed→abandoned.
pub fn finish_loop_session(conn: &Connection, loop_id: &str, status: &str) -> DbResult<()> {
    let now = now_ts();
    conn.execute(
        "UPDATE loop_sessions SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![loop_id, status, now],
    )?;
    let run_id: Option<String> = conn
        .query_row(
            "SELECT run_id FROM loop_sessions WHERE id = ?1",
            params![loop_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(run_id) = run_id {
        let outcome = match status {
            "complete" => "applied",
            "blocked" => "failed",
            _ => "abandoned",
        };
        conn.execute(
            "UPDATE improve_runs SET finished_at = ?2, outcome = ?3 WHERE id = ?1 AND finished_at IS NULL",
            params![run_id, now, outcome],
        )?;
    }
    Ok(())
}

pub fn get_loop_session(conn: &Connection, loop_id: &str) -> DbResult<Option<LoopSession>> {
    conn.query_row(
        "SELECT id, chat_session_id, goal, iteration, max_iterations, status, run_id, created_at, updated_at
           FROM loop_sessions WHERE id = ?1",
        params![loop_id],
        map_loop,
    )
    .optional()
}

/// Most recent loop session for a chat session (used to resume state after
/// restart and to finish dangling sessions).
pub fn latest_loop_session(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Option<LoopSession>> {
    conn.query_row(
        "SELECT id, chat_session_id, goal, iteration, max_iterations, status, run_id, created_at, updated_at
           FROM loop_sessions WHERE chat_session_id = ?1 ORDER BY created_at DESC LIMIT 1",
        params![chat_session_id],
        map_loop,
    )
    .optional()
}

// ---- improvement proposals (P1, §6) ----

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImproveProposal {
    pub id: String,
    pub artifact_id: String,
    pub base_version: i64,
    pub candidate_version: i64,
    pub change_summary: String,
    pub root_causes_json: Option<String>,
    pub expected_effect: Option<String>,
    pub risk_notes: Option<String>,
    pub status: String,
    pub eval_run_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn map_proposal(row: &rusqlite::Row) -> rusqlite::Result<ImproveProposal> {
    Ok(ImproveProposal {
        id: row.get("id")?,
        artifact_id: row.get("artifact_id")?,
        base_version: row.get("base_version")?,
        candidate_version: row.get("candidate_version")?,
        change_summary: row.get("change_summary")?,
        root_causes_json: row.get("root_causes_json")?,
        expected_effect: row.get("expected_effect")?,
        risk_notes: row.get("risk_notes")?,
        status: row.get("status")?,
        eval_run_id: row.get("eval_run_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn create_proposal(
    conn: &Connection,
    artifact_id: &str,
    base_version: i64,
    candidate_version: i64,
    change_summary: &str,
    root_causes_json: Option<&str>,
    expected_effect: Option<&str>,
    risk_notes: Option<&str>,
) -> DbResult<ImproveProposal> {
    let id = new_id();
    let now = now_ts();
    conn.execute(
        "INSERT INTO improve_proposals (id, artifact_id, base_version, candidate_version, change_summary,
                                        root_causes_json, expected_effect, risk_notes, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?9)",
        params![id, artifact_id, base_version, candidate_version, change_summary,
                root_causes_json, expected_effect, risk_notes, now],
    )?;
    get_proposal(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_proposal(conn: &Connection, id: &str) -> DbResult<Option<ImproveProposal>> {
    conn.query_row(
        "SELECT * FROM improve_proposals WHERE id = ?1",
        params![id],
        map_proposal,
    )
    .optional()
}

pub fn list_proposals(conn: &Connection, status: Option<&str>) -> DbResult<Vec<ImproveProposal>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM improve_proposals
          WHERE (?1 IS NULL OR status = ?1)
          ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![status], map_proposal)?;
    rows.collect()
}

pub fn has_open_proposal(conn: &Connection, artifact_id: &str) -> DbResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM improve_proposals
          WHERE artifact_id = ?1 AND status IN ('open', 'evaluating')",
        params![artifact_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn set_proposal_status(
    conn: &Connection,
    id: &str,
    status: &str,
    eval_run_id: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE improve_proposals SET status = ?2, eval_run_id = COALESCE(?3, eval_run_id), updated_at = ?4 WHERE id = ?1",
        params![id, status, eval_run_id, now_ts()],
    )?;
    Ok(())
}

/// One evidence bundle row for the proposer: a finished bad run plus the user
/// message that triggered it (harvested from chat_messages by session+time).
#[derive(Debug, Clone)]
pub struct RunEvidence {
    pub run_id: String,
    pub outcome: String,
    pub error_code: Option<String>,
    pub input_text: Option<String>,
}

pub fn bad_runs_since(
    conn: &Connection,
    artifact_id: &str,
    since: i64,
    limit: i64,
) -> DbResult<Vec<RunEvidence>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.outcome, r.error_code,
                (SELECT m.content FROM chat_messages m
                  WHERE m.chat_session_id = r.chat_session_id AND m.role = 'user'
                    AND m.created_at <= r.started_at
                  ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
           FROM improve_runs r
          WHERE r.artifact_id = ?1 AND r.finished_at IS NOT NULL
            AND r.started_at >= ?2 AND r.outcome IN ('failed', 'corrected')
          ORDER BY r.started_at DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![artifact_id, since, limit], |r| {
        Ok(RunEvidence {
            run_id: r.get(0)?,
            outcome: r.get(1)?,
            error_code: r.get(2)?,
            input_text: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// Artifacts eligible for a sweep: >= `threshold` bad finished runs in the
/// window, no proposal already open. (§6.1 throttle + dedupe.)
pub fn sweep_candidates(
    conn: &Connection,
    since: i64,
    threshold: i64,
) -> DbResult<Vec<(ImproveArtifact, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.kind, a.ref_key, a.name, a.created_at, COUNT(r.id) AS bad
           FROM improve_artifacts a
           JOIN improve_runs r ON r.artifact_id = a.id
          WHERE r.finished_at IS NOT NULL AND r.started_at >= ?1
            AND r.outcome IN ('failed', 'corrected')
          GROUP BY a.id
         HAVING bad >= ?2
          ORDER BY bad DESC",
    )?;
    let rows = stmt.query_map(params![since, threshold], |r| {
        Ok((
            ImproveArtifact {
                id: r.get(0)?,
                kind: r.get(1)?,
                ref_key: r.get(2)?,
                name: r.get(3)?,
                created_at: r.get(4)?,
            },
            r.get(5)?,
        ))
    })?;
    let all: Vec<_> = rows.collect::<DbResult<Vec<_>>>()?;
    Ok(all
        .into_iter()
        .filter(|(a, _)| !has_open_proposal(conn, &a.id).unwrap_or(true))
        .collect())
}

// ---- eval packs (P1, §7/§8) ----

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCase {
    pub id: String,
    pub artifact_id: String,
    pub input_text: String,
    pub expect_json: String,
    pub source: String,
    pub enabled: bool,
    /// P3 flaky quarantine: a case whose outcome flips across identical
    /// eval runs is parked out of gating + pack health (design §"Flaky
    /// cases are auto-quarantined rather than allowed to veto candidates").
    pub quarantined: bool,
    pub quarantine_reason: String,
    pub created_at: i64,
}

fn map_case(row: &rusqlite::Row) -> rusqlite::Result<EvalCase> {
    Ok(EvalCase {
        id: row.get("id")?,
        artifact_id: row.get("artifact_id")?,
        input_text: row.get("input_text")?,
        expect_json: row.get("expect_json")?,
        source: row.get("source")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        quarantined: row.get::<_, i64>("quarantined")? != 0,
        quarantine_reason: row.get("quarantine_reason")?,
        created_at: row.get("created_at")?,
    })
}

const CASE_COLS: &str =
    "id, artifact_id, input_text, expect_json, source, enabled, quarantined, quarantine_reason, created_at";

pub fn add_eval_case(
    conn: &Connection,
    artifact_id: &str,
    input_text: &str,
    expect_json: &str,
    source: &str,
) -> DbResult<EvalCase> {
    let id = new_id();
    conn.execute(
        "INSERT INTO improve_eval_cases (id, artifact_id, input_text, expect_json, source, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
        params![id, artifact_id, input_text, expect_json, source, now_ts()],
    )?;
    Ok(EvalCase {
        id,
        artifact_id: artifact_id.to_string(),
        input_text: input_text.to_string(),
        expect_json: expect_json.to_string(),
        source: source.to_string(),
        enabled: true,
        quarantined: false,
        quarantine_reason: String::new(),
        created_at: now_ts(),
    })
}

pub fn list_eval_cases(
    conn: &Connection,
    artifact_id: &str,
    enabled_only: bool,
) -> DbResult<Vec<EvalCase>> {
    let sql = format!(
        "SELECT {CASE_COLS} FROM improve_eval_cases
          WHERE artifact_id = ?1 AND (?2 = 0 OR enabled = 1)
          ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![artifact_id, enabled_only as i64], map_case)?;
    rows.collect()
}

/// P3: park / release a case. Quarantined cases stay listed (the panel
/// shows them with the reason and an Un-quarantine action) but the engine
/// skips them and pack health counts them separately.
pub fn set_case_quarantined(
    conn: &Connection,
    case_id: &str,
    quarantined: bool,
    reason: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE improve_eval_cases SET quarantined = ?2, quarantine_reason = ?3 WHERE id = ?1",
        params![case_id, quarantined as i64, reason],
    )?;
    Ok(())
}

/// P3 flaky detection: quarantine a case when its outcome FLIPS across the
/// two most recent eval runs that evaluated the SAME (base_version,
/// candidate_version) pair — identical inputs yielding different verdicts
/// is the definition of flake. A flip across DIFFERENT versions is normal
/// iteration (the candidate actually changed), never quarantined. Returns
/// the case ids quarantined by this pass.
pub fn quarantine_flaky_cases(conn: &Connection, artifact_id: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT r.eval_case_id, p.base_version, p.candidate_version,
                COALESCE(r.candidate_ok, r.champion_ok, 0),
                ru.started_at
           FROM improve_eval_results r
           JOIN improve_eval_runs ru ON ru.id = r.eval_run_id
           LEFT JOIN improve_proposals p ON p.id = ru.proposal_id
           JOIN improve_eval_cases c ON c.id = r.eval_case_id
          WHERE ru.artifact_id = ?1 AND c.quarantined = 0
          ORDER BY r.eval_case_id, ru.started_at ASC",
    )?;
    let rows: Vec<(String, Option<i64>, Option<i64>, i64)> = stmt
        .query_map(params![artifact_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Group by case, keep the two most recent results per (base, candidate)
    // pair, compare.
    let mut by_case: std::collections::HashMap<String, Vec<(Option<i64>, Option<i64>, i64)>> =
        std::collections::HashMap::new();
    for (case_id, base, cand, ok) in rows {
        by_case.entry(case_id).or_default().push((base, cand, ok));
    }
    let mut quarantined = Vec::new();
    for (case_id, results) in by_case {
        // results are in ascending run time; walk from the end.
        if results.len() < 2 {
            continue;
        }
        // Compare the last two results OF THE SAME (base, candidate) PAIR —
        // the globally-last two could be different pairs, hiding a real flip:
        // (v2,fail), (v3,pass), (v2,pass) used to look stable even though v2
        // flipped, letting the flaky case keep vetoing candidates (audit M:
        // quarantine pairing).
        let last = results[results.len() - 1];
        let Some((b1, c1, ok1)) = results[..results.len() - 1]
            .iter()
            .rev()
            .find(|(b, c, _)| *b == last.0 && *c == last.1)
            .map(|(b, c, ok)| (*b, *c, *ok))
        else {
            continue;
        };
        let (b2, c2, ok2) = last;
        if ok1 != ok2 {
            let reason = format!(
                "flaky: pass/fail flipped across two identical eval runs \
                 (base {b1:?}, candidate {c2:?}) — parked out of gating; \
                 un-quarantine after stabilizing the expectation"
            );
            set_case_quarantined(conn, &case_id, true, &reason)?;
            quarantined.push(case_id);
        }
    }
    Ok(quarantined)
}

/// Harvest corrected/failed runs into eval cases (dedup by input text).
/// Expectations are judge-only: the deterministic layer has nothing to pin
/// against a free-form user request, so the rubric carries the weight.
pub fn harvest_eval_cases(
    conn: &Connection,
    artifact_id: &str,
    since: i64,
    max: i64,
) -> DbResult<usize> {
    let evidence = bad_runs_since(conn, artifact_id, since, max)?;
    // Dedup: same input already covered by an existing case. ONE load of the
    // artifact's stored inputs (the old per-run COUNT probe was a query per
    // candidate run); the set also collapses repeats within this harvest.
    let mut covered: std::collections::HashSet<String> = {
        let mut stmt =
            conn.prepare("SELECT input_text FROM improve_eval_cases WHERE artifact_id = ?1")?;
        let rows = stmt.query_map(params![artifact_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<String>, _>>()?
    }
    .into_iter()
    .collect();
    let mut added = 0;
    for e in evidence {
        let Some(input) = e.input_text.as_deref() else {
            continue;
        };
        if input.trim().is_empty() {
            continue;
        }
        if !covered.insert(input.to_string()) {
            continue;
        }
        add_eval_case(
            conn,
            artifact_id,
            input,
            r#"{"judge": true, "rubric": "Addresses the user's request correctly and completely."}"#,
            "harvested",
        )?;
        added += 1;
    }
    Ok(added)
}

// ---- P2: autonomy tiers, canaries, audit ----

/// Autonomy tier for one artifact (§9.2). `manual` (default) waits for the
/// user; `auto` promotes immediately after a passing eval; `canary` promotes
/// through a shadow watch window.
pub fn autonomy(conn: &Connection, artifact_id: &str) -> DbResult<String> {
    let tier: Option<String> = conn
        .query_row(
            "SELECT autonomy FROM improve_artifacts WHERE id = ?1",
            params![artifact_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(tier.unwrap_or_else(|| "manual".into()))
}

pub fn set_autonomy(conn: &Connection, artifact_id: &str, tier: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE improve_artifacts SET autonomy = ?2 WHERE id = ?1",
        params![artifact_id, tier],
    )?;
    // serde_json builds the audit detail — string formatting would break
    // (unescaped quotes) the moment a tier value isn't a plain identifier.
    record_event(
        conn,
        Some(artifact_id),
        None,
        "tier_changed",
        Some(&serde_json::json!({ "tier": tier }).to_string()),
    )
}

pub fn record_event(
    conn: &Connection,
    artifact_id: Option<&str>,
    proposal_id: Option<&str>,
    event: &str,
    detail_json: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO improve_events (id, artifact_id, proposal_id, event, detail_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            new_id(),
            artifact_id,
            proposal_id,
            event,
            detail_json,
            now_ts()
        ],
    )?;
    Ok(())
}

pub fn list_events(
    conn: &Connection,
    artifact_id: &str,
    limit: i64,
) -> DbResult<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT event, detail_json, created_at FROM improve_events
          WHERE artifact_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![artifact_id, limit], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, i64>(2)?.to_string(),
        ))
    })?;
    rows.collect()
}

/// Open a run pinned to `version` (used to serve shadow/canary bodies while
/// attributing the telemetry to the right version).
pub fn start_run_versioned(
    conn: &Connection,
    artifact_id: &str,
    version: i64,
    chat_session_id: Option<&str>,
) -> DbResult<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO improve_runs (id, artifact_id, version, chat_session_id, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, artifact_id, version, chat_session_id, now_ts()],
    )?;
    Ok(id)
}

/// If an open canary exists for the artifact, serve its shadow version:
/// returns (run_id, Some(shadow_body)). Otherwise an ordinary active run.
pub fn start_run_shadow(
    conn: &Connection,
    artifact_id: &str,
    chat_session_id: Option<&str>,
) -> DbResult<(String, Option<String>)> {
    let canary: Option<(String, i64)> = conn
        .query_row(
            "SELECT c.id, c.shadow_version FROM improve_canaries c
              WHERE c.artifact_id = ?1 AND c.resolved_at IS NULL
              ORDER BY c.started_at DESC LIMIT 1",
            params![artifact_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((_, shadow_version)) = canary {
        let body = version_body(conn, artifact_id, shadow_version)?.unwrap_or_default();
        if !body.is_empty() {
            let run = start_run_versioned(conn, artifact_id, shadow_version, chat_session_id)?;
            return Ok((run, Some(body)));
        }
    }
    Ok((start_run(conn, artifact_id, chat_session_id)?, None))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Canary {
    pub id: String,
    pub artifact_id: String,
    pub proposal_id: String,
    pub base_version: i64,
    pub shadow_version: i64,
    pub min_runs: i64,
    pub max_age_secs: i64,
    pub started_at: i64,
    pub resolved_at: Option<i64>,
    pub verdict: Option<String>,
}

fn map_canary(row: &rusqlite::Row) -> rusqlite::Result<Canary> {
    Ok(Canary {
        id: row.get("id")?,
        artifact_id: row.get("artifact_id")?,
        proposal_id: row.get("proposal_id")?,
        base_version: row.get("base_version")?,
        shadow_version: row.get("shadow_version")?,
        min_runs: row.get("min_runs")?,
        max_age_secs: row.get("max_age_secs")?,
        started_at: row.get("started_at")?,
        resolved_at: row.get("resolved_at")?,
        verdict: row.get("verdict")?,
    })
}

pub fn open_canary(
    conn: &Connection,
    artifact_id: &str,
    proposal_id: &str,
    base_version: i64,
    shadow_version: i64,
) -> DbResult<Canary> {
    // One open canary per artifact — a newer candidate supersedes by closing
    // the old window (caller decides) or by replacing it here.
    conn.execute(
        "UPDATE improve_canaries SET resolved_at = ?2, verdict = 'stale'
          WHERE artifact_id = ?1 AND resolved_at IS NULL",
        params![artifact_id, now_ts()],
    )?;
    let id = new_id();
    conn.execute(
        "INSERT INTO improve_canaries (id, artifact_id, proposal_id, base_version, shadow_version, min_runs, max_age_secs, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 10, 172800, ?6)",
        params![id, artifact_id, proposal_id, base_version, shadow_version, now_ts()],
    )?;
    get_canary(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_canary(conn: &Connection, id: &str) -> DbResult<Option<Canary>> {
    conn.query_row(
        "SELECT id, artifact_id, proposal_id, base_version, shadow_version, min_runs, max_age_secs, started_at, resolved_at, verdict
           FROM improve_canaries WHERE id = ?1",
        params![id],
        map_canary,
    )
    .optional()
}

pub fn open_canaries(conn: &Connection) -> DbResult<Vec<Canary>> {
    let mut stmt = conn.prepare(
        "SELECT id, artifact_id, proposal_id, base_version, shadow_version, min_runs, max_age_secs, started_at, resolved_at, verdict
           FROM improve_canaries WHERE resolved_at IS NULL ORDER BY started_at ASC",
    )?;
    let rows = stmt.query_map([], map_canary)?;
    rows.collect()
}

/// Finished-run health for one version since a timestamp: (total, bad).
pub fn version_run_health(
    conn: &Connection,
    artifact_id: &str,
    version: i64,
    since: i64,
) -> DbResult<(i64, i64)> {
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN outcome IN ('failed', 'corrected') THEN 1 ELSE 0 END), 0)
           FROM improve_runs
          WHERE artifact_id = ?1 AND version = ?2 AND finished_at IS NOT NULL AND started_at >= ?3",
        params![artifact_id, version, since],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

pub fn resolve_canary(conn: &Connection, id: &str, verdict: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE improve_canaries SET resolved_at = ?2, verdict = ?3 WHERE id = ?1 AND resolved_at IS NULL",
        params![id, now_ts(), verdict],
    )?;
    Ok(())
}

/// Rollback credit (§9.3 blast-radius rule): rolled_back events per artifact.
pub fn rolled_back_count(conn: &Connection, artifact_id: &str) -> DbResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM improve_events WHERE artifact_id = ?1 AND event = 'rolled_back'",
        params![artifact_id],
        |r| r.get(0),
    )
}

/// 24h auto-promotion cap (§9.3): a promoted event within the window?
pub fn promoted_recently(conn: &Connection, artifact_id: &str, within_secs: i64) -> DbResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM improve_events
          WHERE artifact_id = ?1 AND event = 'promoted' AND created_at >= ?2",
        params![artifact_id, now_ts() - within_secs],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

// ---- P3: cross-artifact pack health + artifact cost attribution ----

/// Pack health for one artifact — the P3 rollup: how many cases are active
/// vs quarantined, whether the pack DISCRIMINATES (at least one case ever
/// failed — a pack that passed everything forever proves nothing), where
/// its cases came from, and how much eval history backs it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackHealth {
    pub artifact_id: String,
    pub kind: String,
    pub name: String,
    pub cases_total: i64,
    pub cases_active: i64,
    pub cases_quarantined: i64,
    /// Cases with at least one failing result in eval history — the pack's
    /// evidence it can actually distinguish champion from candidate.
    pub cases_discriminating: i64,
    pub cases_harvested: i64,
    pub eval_runs: i64,
    pub last_eval_at: Option<i64>,
    /// Live-traffic (total, bad) runs — from `run_health`.
    pub runs_total: i64,
    pub runs_bad: i64,
    /// Derived: every active case passed every recorded run and there is
    /// enough history to expect a failure — the pack is suspect.
    pub suspect: bool,
}

pub fn pack_health(conn: &Connection, a: &ImproveArtifact) -> DbResult<PackHealth> {
    let (cases_total, cases_quarantined, cases_harvested): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(quarantined), 0),
                COALESCE(SUM(CASE WHEN source = 'harvested' THEN 1 ELSE 0 END), 0)
           FROM improve_eval_cases WHERE artifact_id = ?1",
        params![a.id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let cases_discriminating: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT r.eval_case_id)
           FROM improve_eval_results r
           JOIN improve_eval_runs ru ON ru.id = r.eval_run_id
          WHERE ru.artifact_id = ?1
            AND (COALESCE(r.champion_ok, 1) = 0 OR COALESCE(r.candidate_ok, 1) = 0)",
        params![a.id],
        |r| r.get(0),
    )?;
    let (eval_runs, last_eval_at): (i64, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), MAX(started_at) FROM improve_eval_runs WHERE artifact_id = ?1",
        params![a.id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (runs_total, runs_bad) = run_health(conn, &a.id)?;
    let cases_active = cases_total - cases_quarantined;
    // "Packs passing everything forever are suspect" (design §P3): with ≥3
    // eval runs of ≥1 active case and ZERO discriminating results, the pack
    // has never once failed anything — it cannot veto a bad candidate.
    let suspect = cases_active > 0 && cases_discriminating == 0 && eval_runs >= 3;
    Ok(PackHealth {
        artifact_id: a.id.clone(),
        kind: a.kind.clone(),
        name: a.name.clone(),
        cases_total,
        cases_active,
        cases_quarantined,
        cases_discriminating,
        cases_harvested,
        eval_runs,
        last_eval_at,
        runs_total,
        runs_bad,
        suspect,
    })
}

/// Cross-artifact rollup: pack health for every tracked artifact, in sweep
/// order (most recently created first).
pub fn pack_health_all(conn: &Connection) -> DbResult<Vec<PackHealth>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, ref_key, name, created_at FROM improve_artifacts ORDER BY created_at DESC",
    )?;
    let artifacts: Vec<ImproveArtifact> = stmt
        .query_map([], map_artifact)?
        .collect::<Result<Vec<_>, _>>()?;
    artifacts.iter().map(|a| pack_health(conn, a)).collect()
}

/// Cost attribution for one artifact: the engine's throwaway sessions
/// (eval runs) plus its LIVE runs' sessions, joined to chat_messages for
/// tokens and recorded/estimated cost. Small row counts — Rust-side
/// aggregation over per-session sums, no cross-table SQL gymnastics.
#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCost {
    pub artifact_id: String,
    pub kind: String,
    pub name: String,
    /// Live-traffic runs attributed (improve_runs with a chat session).
    pub live_runs: i64,
    /// Eval runs attributed (proposer/judge/case turns since the P3 column).
    pub eval_runs: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    /// Recorded `cost_usd`, falling back to the pricing estimate, summed.
    pub cost_usd: f64,
}

fn session_cost(conn: &Connection, session_ids: &[String]) -> DbResult<(i64, i64, i64, f64)> {
    let (mut tin, mut tout, mut tcache, mut tcost) = (0i64, 0i64, 0i64, 0f64);
    for sid in session_ids {
        let (i, o, c, cost): (i64, i64, i64, f64) = conn.query_row(
            "SELECT COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_input_tokens), 0),
                    COALESCE(SUM(COALESCE(cost_usd, pricing_estimated_usd, 0)), 0.0)
               FROM chat_messages WHERE chat_session_id = ?1",
            params![sid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        tin += i;
        tout += o;
        tcache += c;
        tcost += cost;
    }
    Ok((tin, tout, tcache, tcost))
}

pub fn artifact_cost_rollups(
    conn: &Connection,
    since_secs: i64,
    max_artifacts: i64,
) -> DbResult<Vec<ArtifactCost>> {
    let cutoff = now_ts() - since_secs;
    let mut stmt = conn.prepare(
        "SELECT id, kind, ref_key, name, created_at FROM improve_artifacts
          ORDER BY created_at DESC LIMIT ?1",
    )?;
    let artifacts: Vec<ImproveArtifact> = stmt
        .query_map(params![max_artifacts], map_artifact)?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::new();
    for a in artifacts {
        let mut cost = ArtifactCost {
            artifact_id: a.id.clone(),
            kind: a.kind.clone(),
            name: a.name.clone(),
            ..Default::default()
        };

        // Live runs: closed runs since the cutoff with a chat session.
        // Per-ROW selects — COUNT(*) with a bare column collapses to ONE
        // aggregate row, which made run counts read 1 forever.
        let mut stmt = conn.prepare(
            "SELECT chat_session_id FROM improve_runs
              WHERE artifact_id = ?1 AND finished_at IS NOT NULL AND started_at >= ?2
                AND chat_session_id IS NOT NULL",
        )?;
        let live_sessions: Vec<String> = stmt
            .query_map(params![a.id, cutoff], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        cost.live_runs = live_sessions.len() as i64;

        // Eval runs: the engine's throwaway sessions (P3 column).
        let mut stmt = conn.prepare(
            "SELECT chat_session_id FROM improve_eval_runs
              WHERE artifact_id = ?1 AND started_at >= ?2 AND chat_session_id IS NOT NULL",
        )?;
        let eval_rows: Vec<String> = stmt
            .query_map(params![a.id, cutoff], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        cost.eval_runs = eval_rows.len() as i64;
        // Runs may record MULTIPLE sessions (P3 stores the whole set for one
        // eval run, comma-joined).
        let eval_sessions: Vec<String> = eval_rows
            .iter()
            .flat_map(|s| s.split(',').map(|p| p.trim().to_string()).collect::<Vec<_>>())
            .collect();

        let (tin, tout, tcache, tcost) =
            session_cost(conn, &[live_sessions, eval_sessions].concat())?;
        cost.input_tokens = tin;
        cost.output_tokens = tout;
        cost.cache_read_tokens = tcache;
        cost.cost_usd = tcost;
        out.push(cost);
    }
    Ok(out)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_artifact_is_idempotent_and_seeds_v1() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "body v1").unwrap();
        // Same (kind, ref_key) → same row, no duplicate version.
        let a2 = ensure_artifact(&conn, "skill", "docx", "Docx renamed", "body v1").unwrap();
        assert_eq!(a.id, a2.id);
        assert_eq!(list_versions(&conn, &a.id).unwrap().len(), 1);
        assert_eq!(channel_version(&conn, &a.id, "active").unwrap(), Some(1));
    }

    #[test]
    fn record_version_appends_and_skips_unchanged_body() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        // Unchanged body → no new version.
        assert_eq!(
            record_version(&conn, &a.id, 1, "v1", None, "auto_proposal").unwrap(),
            None
        );
        // Changed body → v2.
        assert_eq!(
            record_version(&conn, &a.id, 1, "v2 improved", None, "auto_proposal").unwrap(),
            Some(2)
        );
        let versions = list_versions(&conn, &a.id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[1].parent_version, Some(1));
        assert_eq!(versions[1].origin, "auto_proposal");
    }

    #[test]
    fn channel_repoint_is_rollback() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "loop", "goal", "Goal loop", "v1").unwrap();
        let v2 = record_version(&conn, &a.id, 1, "v2", None, "auto_proposal")
            .unwrap()
            .unwrap();
        set_channel(&conn, &a.id, "active", v2).unwrap();
        assert_eq!(channel_version(&conn, &a.id, "active").unwrap(), Some(2));
        // Rollback = move the pointer back.
        set_channel(&conn, &a.id, "active", 1).unwrap();
        assert_eq!(channel_version(&conn, &a.id, "active").unwrap(), Some(1));
    }

    #[test]
    fn run_lifecycle_open_to_terminal_outcomes() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        let r1 = start_run(&conn, &a.id, Some("sess1")).unwrap();
        let r2 = start_run(&conn, &a.id, Some("sess1")).unwrap();
        // Run rows start open (outcome NULL).
        let (total, bad) = run_health(&conn, &a.id).unwrap();
        assert_eq!((total, bad), (0, 0), "open runs are not counted");
        // Turn error closes both.
        assert_eq!(
            finish_session_runs(&conn, "sess1", "failed", Some("context_overflow")).unwrap(),
            2
        );
        let (total, bad) = run_health(&conn, &a.id).unwrap();
        assert_eq!((total, bad), (2, 2));
        // Idempotent: nothing left open for that session.
        assert_eq!(
            finish_session_runs(&conn, "sess1", "corrected", None).unwrap(),
            0
        );
        let _ = r1;
        let _ = r2;
    }

    #[test]
    fn corrected_and_failed_both_count_as_bad_but_applied_not() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "template", "t1", "T", "v1").unwrap();
        start_run(&conn, &a.id, Some("s1")).unwrap();
        start_run(&conn, &a.id, Some("s2")).unwrap();
        start_run(&conn, &a.id, Some("s3")).unwrap();
        finish_session_runs(&conn, "s1", "applied", None).unwrap();
        finish_session_runs(&conn, "s2", "corrected", None).unwrap();
        finish_session_runs(&conn, "s3", "failed", None).unwrap();
        assert_eq!(run_health(&conn, &a.id).unwrap(), (3, 2));
    }

    #[test]
    fn feedback_round_trip() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "pdf", "Pdf", "v1").unwrap();
        let run = start_run(&conn, &a.id, Some("s1")).unwrap();
        record_feedback(
            &conn,
            &a.id,
            Some(&run),
            Some("s1"),
            "down",
            Some("wrong format"),
        )
        .unwrap();
        record_feedback(&conn, &a.id, None, None, "up", None).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM improve_feedback WHERE artifact_id = ?1",
                params![a.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn loop_session_lifecycle_maps_status_to_outcome() {
        let conn = super::super::mem();
        let ls =
            start_loop_session(&conn, "chat1", "fix the tests", 10, "loop skill body").unwrap();
        assert_eq!(ls.iteration, 0);
        assert_eq!(ls.status, "running");
        assert!(ls.run_id.is_some());
        // The loop artifact is created lazily and shared across sessions.
        let a = conn
            .query_row(
                "SELECT id FROM improve_artifacts WHERE kind = 'loop' AND ref_key = 'goal'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();

        advance_loop_session(&conn, &ls.id, 3).unwrap();
        let got = get_loop_session(&conn, &ls.id).unwrap().unwrap();
        assert_eq!(got.iteration, 3);

        finish_loop_session(&conn, &ls.id, "complete").unwrap();
        let got = get_loop_session(&conn, &ls.id).unwrap().unwrap();
        assert_eq!(got.status, "complete");
        // complete → run applied.
        let outcome: String = conn
            .query_row(
                "SELECT outcome FROM improve_runs WHERE id = ?1",
                params![got.run_id.unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome, "applied");

        // blocked → failed; stopped/maxed → abandoned.
        let ls2 = start_loop_session(&conn, "chat2", "g", 5, "loop skill body").unwrap();
        finish_loop_session(&conn, &ls2.id, "blocked").unwrap();
        let ls3 = start_loop_session(&conn, "chat3", "g", 5, "loop skill body").unwrap();
        finish_loop_session(&conn, &ls3.id, "maxed").unwrap();
        let (total, bad) = run_health(&conn, &a).unwrap();
        assert_eq!((total, bad), (3, 1));

        // Latest-session lookup (resume after restart).
        assert_eq!(
            latest_loop_session(&conn, "chat2").unwrap().unwrap().id,
            ls2.id
        );
        assert!(latest_loop_session(&conn, "chatX").unwrap().is_none());
    }

    #[test]
    fn artifact_cascade_deletes_history_and_runs() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "tmp", "T", "v1").unwrap();
        start_run(&conn, &a.id, Some("s")).unwrap();
        record_version(&conn, &a.id, 1, "v2", None, "user").unwrap();
        conn.execute("DELETE FROM improve_artifacts WHERE id = ?1", params![a.id])
            .unwrap();
        let versions: i64 = conn
            .query_row("SELECT COUNT(*) FROM improve_versions", [], |r| r.get(0))
            .unwrap();
        let runs: i64 = conn
            .query_row("SELECT COUNT(*) FROM improve_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!((versions, runs), (0, 0));
    }

    #[test]
    fn proposal_lifecycle_and_open_dedupe() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        let v2 = record_version(&conn, &a.id, 1, "v2", None, "auto_proposal")
            .unwrap()
            .unwrap();
        let p = create_proposal(
            &conn,
            &a.id,
            1,
            v2,
            "tighten instructions",
            None,
            Some("fewer failures"),
            None,
        )
        .unwrap();
        assert_eq!(p.status, "open");
        assert!(has_open_proposal(&conn, &a.id).unwrap());
        // Gate progression: open → evaluating → passed.
        set_proposal_status(&conn, &p.id, "evaluating", None).unwrap();
        set_proposal_status(&conn, &p.id, "passed", Some("er1")).unwrap();
        let got = get_proposal(&conn, &p.id).unwrap().unwrap();
        assert_eq!(got.status, "passed");
        assert_eq!(got.eval_run_id.as_deref(), Some("er1"));
        assert!(!has_open_proposal(&conn, &a.id).unwrap());
        assert_eq!(list_proposals(&conn, Some("passed")).unwrap().len(), 1);
        assert_eq!(list_proposals(&conn, None).unwrap().len(), 1);
    }

    #[test]
    fn sweep_candidates_respects_threshold_and_open_proposals() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "hot", "Hot", "v1").unwrap();
        let b = ensure_artifact(&conn, "skill", "quiet", "Quiet", "v1").unwrap();
        for s in ["s1", "s2", "s3"] {
            start_run(&conn, &a.id, Some(s)).unwrap();
            finish_session_runs(&conn, s, "failed", None).unwrap();
        }
        // `b` has runs but all applied — not eligible.
        start_run(&conn, &b.id, Some("s4")).unwrap();
        finish_session_runs(&conn, "s4", "applied", None).unwrap();

        let since = 0;
        let cands = sweep_candidates(&conn, since, 3).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].0.id, a.id);
        assert_eq!(cands[0].1, 3);
        // Below threshold: nothing eligible.
        assert!(sweep_candidates(&conn, since, 4).unwrap().is_empty());
        // Once a proposal is open, the artifact is deduped out.
        let v2 = record_version(&conn, &a.id, 1, "v2", None, "auto_proposal")
            .unwrap()
            .unwrap();
        create_proposal(&conn, &a.id, 1, v2, "fix", None, None, None).unwrap();
        assert!(sweep_candidates(&conn, since, 3).unwrap().is_empty());
    }

    #[test]
    fn autonomy_tiers_and_events() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        assert_eq!(autonomy(&conn, &a.id).unwrap(), "manual", "default tier");
        set_autonomy(&conn, &a.id, "canary").unwrap();
        assert_eq!(autonomy(&conn, &a.id).unwrap(), "canary");
        let events = list_events(&conn, &a.id, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "tier_changed");
    }

    #[test]
    fn canary_window_and_shadow_serving() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        let v2 = record_version(&conn, &a.id, 1, "v2", None, "auto_proposal")
            .unwrap()
            .unwrap();
        let p = create_proposal(&conn, &a.id, 1, v2, "fix", None, None, None).unwrap();
        // No canary → ordinary active run, no override body.
        let (run, body) = start_run_shadow(&conn, &a.id, Some("s0")).unwrap();
        assert!(body.is_none());
        assert_eq!(
            conn.query_row(
                "SELECT version FROM improve_runs WHERE id = ?1",
                params![run],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let c = open_canary(&conn, &a.id, &p.id, 1, v2).unwrap();
        assert!(c.resolved_at.is_none());
        // Canary open → runs serve the shadow version and carry its body.
        let (run2, body2) = start_run_shadow(&conn, &a.id, Some("s1")).unwrap();
        assert_eq!(body2.as_deref(), Some("v2"));
        assert_eq!(
            conn.query_row(
                "SELECT version FROM improve_runs WHERE id = ?1",
                params![run2],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        finish_session_runs(&conn, "s1", "applied", None).unwrap();
        // Window statistics read back per version.
        assert_eq!(version_run_health(&conn, &a.id, 2, 0).unwrap(), (1, 0));
        // Opening a second canary supersedes (stale) the first.
        let c2 = open_canary(&conn, &a.id, &p.id, 1, v2).unwrap();
        assert_eq!(
            get_canary(&conn, &c.id)
                .unwrap()
                .unwrap()
                .verdict
                .as_deref(),
            Some("stale")
        );
        assert!(
            open_canaries(&conn).unwrap().len() == 1
                && open_canaries(&conn).unwrap()[0].id == c2.id
        );
    }

    #[test]
    fn promotion_cap_and_rollback_credit() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        assert!(!promoted_recently(&conn, &a.id, 86_400).unwrap());
        record_event(&conn, Some(&a.id), None, "promoted", None).unwrap();
        assert!(promoted_recently(&conn, &a.id, 86_400).unwrap());
        record_event(&conn, Some(&a.id), None, "rolled_back", None).unwrap();
        record_event(&conn, Some(&a.id), None, "rolled_back", None).unwrap();
        assert_eq!(
            rolled_back_count(&conn, &a.id).unwrap(),
            2,
            "blast-radius rule trips at 2"
        );
    }

    #[test]
    fn eval_cases_round_trip_and_harvest_dedupes() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        add_eval_case(
            &conn,
            &a.id,
            "write a report",
            r#"{"mustContain": ["done"]}"#,
            "manual",
        )
        .unwrap();
        // Two bad runs with the same input → one harvested case only.
        for _ in 0..2 {
            // Real chat session: improve_runs.chat_session_id joins to
            // chat_messages for input attribution.
            let cs =
                super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
                    .unwrap();
            start_run(&conn, &a.id, Some(&cs.id)).unwrap();
            // Seed the triggering user message so the harvest can attribute it.
            super::super::add_chat_message(
                &conn,
                super::super::NewChatMessage {
                    chat_session_id: &cs.id,
                    role: "user",
                    content: "make a doc",
                    ..Default::default()
                },
            )
            .unwrap();
            finish_session_runs(&conn, &cs.id, "corrected", None).unwrap();
        }
        let added = harvest_eval_cases(&conn, &a.id, 0, 10).unwrap();
        assert_eq!(added, 1, "identical inputs dedupe");
        let cases = list_eval_cases(&conn, &a.id, true).unwrap();
        assert_eq!(cases.len(), 2); // manual + harvested
        assert_eq!(cases[0].source, "manual");
        assert_eq!(cases[1].source, "harvested");
        // Harvest again → still deduped.
        assert_eq!(harvest_eval_cases(&conn, &a.id, 0, 10).unwrap(), 0);
        // Enabled filter.
        assert_eq!(list_eval_cases(&conn, &a.id, false).unwrap().len(), 2);
    }

    // ---- P3: quarantine, pack health, cost attribution ----

    /// SQL fixtures for eval runs + results (no helpers existed — the engine
    /// owns these inserts, the tests need the raw shapes).
    fn p3_insert_eval_run(conn: &Connection, artifact_id: &str, proposal_id: &str, at: i64) -> String {
        let id = new_id();
        conn.execute(
            "INSERT INTO improve_eval_runs (id, artifact_id, proposal_id, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, artifact_id, proposal_id, at],
        )
        .unwrap();
        id
    }
    fn p3_insert_result(conn: &Connection, run_id: &str, case_id: &str, candidate_ok: bool) {
        conn.execute(
            "INSERT INTO improve_eval_results (id, eval_run_id, eval_case_id, champion_ok, candidate_ok)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![new_id(), run_id, case_id, candidate_ok as i64],
        )
        .unwrap();
    }

    #[test]
    fn p3_flaky_quarantine_trips_only_on_identical_runs() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        let v2 = record_version(&conn, &a.id, 1, "v2", None, "auto_proposal")
            .unwrap()
            .unwrap();
        let p = create_proposal(&conn, &a.id, 1, v2, "fix", None, None, None).unwrap();
        let c1 = add_eval_case(&conn, &a.id, "case one", r#"{"mustContain":["x"]}"#, "manual").unwrap();
        let c2 = add_eval_case(&conn, &a.id, "case two", r#"{"mustContain":["x"]}"#, "manual").unwrap();

        // Case ONE flips across two runs of the SAME (base, candidate) pair:
        // identical inputs, opposite verdicts — the definition of flake.
        let r1 = p3_insert_eval_run(&conn, &a.id, &p.id, 1_000);
        p3_insert_result(&conn, &r1, &c1.id, false);
        let r2 = p3_insert_eval_run(&conn, &a.id, &p.id, 2_000);
        p3_insert_result(&conn, &r2, &c1.id, true);
        // Case TWO "flips" across DIFFERENT candidates (v2 → v3): that is
        // the candidate actually changing — iteration, not flake.
        let v3 = record_version(&conn, &a.id, 1, "v3", None, "auto_proposal")
            .unwrap()
            .unwrap();
        let p2 = create_proposal(&conn, &a.id, 1, v3, "fix2", None, None, None).unwrap();
        p3_insert_result(&conn, &r2, &c2.id, false);
        let r3 = p3_insert_eval_run(&conn, &a.id, &p2.id, 3_000);
        p3_insert_result(&conn, &r3, &c2.id, true);

        let quarantined = quarantine_flaky_cases(&conn, &a.id).unwrap();
        assert_eq!(quarantined, vec![c1.id.clone()], "only the same-pair flip is flake");
        let cases = list_eval_cases(&conn, &a.id, false).unwrap();
        let one = cases.iter().find(|c| c.id == c1.id).unwrap();
        let two = cases.iter().find(|c| c.id == c2.id).unwrap();
        assert!(one.quarantined);
        assert!(one.quarantine_reason.contains("flaky"));
        assert!(!two.quarantined);

        // A stable third run on the SAME pair for case two must NOT newly
        // quarantine it (results: (v2,fail),(v3,pass),(v3,pass) — the last
        // two share a pair and AGREE).
        p3_insert_result(&conn, &r3, &c2.id, true);
        assert!(quarantine_flaky_cases(&conn, &a.id).unwrap().is_empty());

        // Release clears both fields.
        set_case_quarantined(&conn, &c1.id, false, "").unwrap();
        let cases = list_eval_cases(&conn, &a.id, false).unwrap();
        let one = cases.iter().find(|c| c.id == c1.id).unwrap();
        assert!(!one.quarantined);
        assert_eq!(one.quarantine_reason, "");
    }

    #[test]
    fn p3_pack_health_flags_suspect_packs_and_counts_quarantine() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();
        let v2 = record_version(&conn, &a.id, 1, "v2", None, "auto_proposal")
            .unwrap()
            .unwrap();
        let p = create_proposal(&conn, &a.id, 1, v2, "fix", None, None, None).unwrap();
        let c1 = add_eval_case(&conn, &a.id, "case one", r#"{"mustContain":["x"]}"#, "manual").unwrap();
        let c2 = add_eval_case(&conn, &a.id, "case two", r#"{"mustContain":["x"]}"#, "harvested").unwrap();

        // Three eval runs where EVERY case passes — the pack never
        // discriminated once. With ≥3 runs, that is the suspect signature.
        for i in 1..=3 {
            let r = p3_insert_eval_run(&conn, &a.id, &p.id, i * 1_000);
            p3_insert_result(&conn, &r, &c1.id, true);
            p3_insert_result(&conn, &r, &c2.id, true);
        }
        let health = pack_health(&conn, &a).unwrap();
        assert_eq!(health.cases_total, 2);
        assert_eq!(health.cases_active, 2);
        assert_eq!(health.cases_harvested, 1);
        assert_eq!(health.eval_runs, 3);
        assert_eq!(health.cases_discriminating, 0);
        assert!(health.suspect, "all-pass pack with ≥3 runs is suspect");
        assert_eq!(health.last_eval_at, Some(3_000));

        // One failing candidate result → the pack discriminates → not suspect.
        let r4 = p3_insert_eval_run(&conn, &a.id, &p.id, 4_000);
        p3_insert_result(&conn, &r4, &c1.id, false);
        let health = pack_health(&conn, &a).unwrap();
        assert_eq!(health.cases_discriminating, 1);
        assert!(!health.suspect);

        // Quarantine drops the case from ACTIVE but keeps it in TOTAL, and
        // a pack with no active cases is vacuously not suspect.
        set_case_quarantined(&conn, &c2.id, true, "flaky").unwrap();
        let health = pack_health(&conn, &a).unwrap();
        assert_eq!(health.cases_total, 2);
        assert_eq!(health.cases_quarantined, 1);
        assert_eq!(health.cases_active, 1);
        assert!(!health.suspect);
    }

    #[test]
    fn p3_artifact_costs_attribute_live_and_eval_sessions() {
        let conn = super::super::mem();
        let a = ensure_artifact(&conn, "skill", "docx", "Docx", "v1").unwrap();

        // Live traffic: one closed improve_run over a chat session whose
        // assistant message carries tokens + recorded cost.
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
            .unwrap();
        start_run(&conn, &a.id, Some(&cs.id)).unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "done",
                input_tokens: Some(1_000),
                output_tokens: Some(200),
                cache_read_input_tokens: Some(500),
                cost_usd: Some(0.01),
                ..Default::default()
            },
        )
        .unwrap();
        finish_session_runs(&conn, &cs.id, "applied", None).unwrap();

        // Eval spend: one eval run whose P3 session column holds a
        // comma-joined set — priced via the fallback estimate.
        let mk = |sid: &str| {
            let s = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
                .unwrap();
            let _ = sid;
            s.id.clone()
        };
        let sa = mk("a");
        let sb = mk("b");
        for sid in [&sa, &sb] {
            super::super::add_chat_message(
                &conn,
                super::super::NewChatMessage {
                    chat_session_id: sid,
                    role: "assistant",
                    content: "eval turn",
                    input_tokens: Some(2_000),
                    output_tokens: Some(100),
                    pricing_estimated_usd: Some(0.002),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO improve_eval_runs (id, artifact_id, proposal_id, started_at, chat_session_id)
             VALUES ('er1', ?1, NULL, ?2, ?3)",
            params![a.id, super::super::now_ts(), format!("{sa},{sb}")],
        )
        .unwrap();

        let rollups = artifact_cost_rollups(&conn, 30 * 86_400, 100).unwrap();
        let row = rollups.iter().find(|r| r.artifact_id == a.id).unwrap();
        assert_eq!(row.live_runs, 1);
        assert_eq!(row.eval_runs, 1);
        assert_eq!(row.input_tokens, 5_000);
        assert_eq!(row.output_tokens, 400);
        assert_eq!(row.cache_read_tokens, 500);
        assert!((row.cost_usd - 0.014).abs() < 1e-9, "got {}", row.cost_usd);

        // Range filter: the recent eval run shows in the 30-day window…
        let rollups = artifact_cost_rollups(&conn, 30 * 86_400, 100).unwrap();
        let row = rollups.iter().find(|r| r.artifact_id == a.id).unwrap();
        assert_eq!(row.eval_runs, 1);
        // …an eval run 45 days back stays OUT of 30 days but shows in 90.
        let old_session = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
            .unwrap()
            .id;
        conn.execute(
            "INSERT INTO improve_eval_runs (id, artifact_id, proposal_id, started_at, chat_session_id)
             VALUES ('er-old', ?1, NULL, ?2, ?3)",
            params![a.id, super::super::now_ts() - 45 * 86_400, old_session],
        )
        .unwrap();
        let rollups = artifact_cost_rollups(&conn, 30 * 86_400, 100).unwrap();
        let row = rollups.iter().find(|r| r.artifact_id == a.id).unwrap();
        assert_eq!(row.eval_runs, 1, "old eval run stays out of the 30-day window");
        let rollups = artifact_cost_rollups(&conn, 90 * 86_400, 100).unwrap();
        let row = rollups.iter().find(|r| r.artifact_id == a.id).unwrap();
        assert_eq!(row.eval_runs, 2, "90-day window sees both");
    }
}
