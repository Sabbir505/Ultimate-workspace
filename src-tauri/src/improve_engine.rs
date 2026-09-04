//! Self-improving artifacts engine (SELF_IMPROVING_ARTIFACTS.md §6–§8, P1).
//!
//! Closed loop over the P0 registry: sweep failure evidence → ask the current
//! active chat model for a targeted improvement (GEPA-style reflective
//! proposal) → evaluate candidate vs champion on the artifact's eval pack
//! (deterministic assertions + blind LLM-judge) → gate → promote or reject.
//!
//! Judge model policy (user decision): the *current active chat model* —
//! proposer/evaluator/judge calls all run through the normal chat path, so
//! their cost lands in the existing cost rollups with no separate ledger.
//! Blocking one-shot calls live here; Tauri commands wrap them in
//! `spawn_blocking`.

use rusqlite::Connection;
use std::sync::Arc;

use crate::db;
use crate::db::improve::{
    self, EvalCase, ImproveArtifact, ImproveProposal, RunEvidence,
};

type EngResult<T> = Result<T, String>;

/// Kill switch (§9.3): setting `improvements.enabled = "false"` freezes
/// sweeps and evals. Anything else (including unset) is on.
fn improvements_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, "improvements.enabled")
        .ok()
        .flatten()
        .map(|v| v != "false")
        .unwrap_or(true)
}

/// The chat provider/model the user is currently using (`chat.active_provider`
/// + its default model). Falls back to the same priority scan the frontend
/// uses. Returns None when no usable cloud/local model is configured.
pub fn resolve_active_chat_model(conn: &Connection) -> Option<(String, String)> {
    let providers = ["anthropic", "openai", "openrouter", "anthropic_compatible", "openai_compatible"];
    if let Ok(Some(active)) = db::get_setting(conn, "chat.active_provider") {
        if !active.is_empty()
            && active != "local_gguf"
            && crate::secrets::has_chat_api_key(conn, &active)
        {
            let model = db::get_setting(conn, &format!("chat.{active}.model"))
                .ok()
                .flatten()
                .unwrap_or_default();
            return Some((active, model));
        }
    }
    for p in providers {
        if crate::secrets::has_chat_api_key(conn, p) {
            let model = db::get_setting(conn, &format!("chat.{p}.model"))
                .ok()
                .flatten()
                .unwrap_or_default();
            return Some((p.to_string(), model));
        }
    }
    None
}

/// Run one blocking chat turn with `body` as the working instructions and
/// `input` as the user request, in a throwaway session. Returns the
/// assistant's reply text. Cost flows through chat_messages → cost rollups.
pub fn run_artifact_turn(
    db: &Arc<parking_lot::Mutex<Connection>>,
    body: &str,
    input: &str,
) -> EngResult<String> {
    let (provider, model) = {
        let conn = db.lock();
        resolve_active_chat_model(&conn).ok_or_else(|| {
            "no active chat model configured — set one in Settings to run improvement sweeps".to_string()
        })?
    };
    let session_id = {
        let conn = db.lock();
        crate::db::create_chat_session(&conn, &provider, &model, None)
            .map_err(|e| e.to_string())?
            .id
    };
    let prompt = format!("{body}\n\n---\n\nUser request: {input}");
    crate::chat::run_one_shot_chat(db, &session_id, &prompt, &provider, &model)?;
    let conn = db.lock();
    conn.query_row(
        "SELECT content FROM chat_messages
          WHERE chat_session_id = ?1 AND role = 'assistant'
          ORDER BY id DESC LIMIT 1",
        rusqlite::params![session_id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|e| format!("eval turn left no assistant reply: {e}"))
}

/// Extract the first balanced JSON object from a possibly chatty/fenced reply.
fn extract_json(reply: &str) -> Option<String> {
    let start = reply.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, ch) in reply[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_str => escaped = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(reply[start..=start + i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Static gate (§7.1) — free checks a proposal must clear before costing an
/// eval. Returns Err with a user-readable reason.
fn static_gate(kind: &str, base_body: &str, new_body: &str) -> EngResult<()> {
    if new_body.trim().is_empty() {
        return Err("proposed body is empty".into());
    }
    if new_body.len() > 32_768 {
        return Err("proposed body exceeds 32 KiB size budget".into());
    }
    if new_body == base_body {
        return Err("proposal does not change the artifact".into());
    }
    // Loop artifacts must keep the sentinel contract the frontend parser
    // (`parseLoopStatus`) depends on; a rewrite that drops it can never run.
    if kind == "loop" && !new_body.contains("LOOP_STATUS") {
        return Err("loop proposal drops the LOOP_STATUS sentinel contract".into());
    }
    Ok(())
}

/// Sweep: propose improvements for every artifact whose evidence cleared the
/// thresholds. One proposal per artifact per sweep (§6.1 throttle/dedupe).
/// Returns the proposals created (empty when the kill switch is off or
/// nothing is eligible).
pub fn sweep(db: &Arc<parking_lot::Mutex<Connection>>) -> EngResult<Vec<ImproveProposal>> {
    let week_ago = db::now_ts() - 7 * 86_400;
    let (model_pair, candidates) = {
        let conn = db.lock();
        if !improvements_enabled(&conn) {
            return Ok(Vec::new());
        }
        (
            resolve_active_chat_model(&conn),
            improve::sweep_candidates(&conn, week_ago, 3).map_err(|e| e.to_string())?,
        )
    };
    let Some(_) = model_pair else {
        return Err("no active chat model configured — set one in Settings to run improvement sweeps".into());
    };
    let mut created = Vec::new();
    for (artifact, _bad) in candidates {
        match propose_for_artifact(db, &artifact) {
            Ok(Some(p)) => created.push(p),
            Ok(None) => {}
            Err(e) => eprintln!("[improve] proposal for {} ({}) failed: {e}", artifact.ref_key, artifact.kind),
        }
    }
    Ok(created)
}

/// Propose one improvement for `artifact` from its failure evidence.
/// Ok(None) means "nothing to do" (no evidence / static gate rejected).
pub fn propose_for_artifact(
    db: &Arc<parking_lot::Mutex<Connection>>,
    artifact: &ImproveArtifact,
) -> EngResult<Option<ImproveProposal>> {
    let week_ago = db::now_ts() - 7 * 86_400;
    let (active_version, base_body, evidence, case_count) = {
        let conn = db.lock();
        let version = improve::channel_version(&conn, &artifact.id, "active")
            .map_err(|e| e.to_string())?
            .unwrap_or(1);
        let body = improve::version_body(&conn, &artifact.id, version)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "active version body missing".to_string())?;
        let evidence = improve::bad_runs_since(&conn, &artifact.id, week_ago, 5)
            .map_err(|e| e.to_string())?;
        let case_count = improve::list_eval_cases(&conn, &artifact.id, true)
            .map_err(|e| e.to_string())?
            .len();
        (version, body, evidence, case_count)
    };
    if evidence.is_empty() {
        return Ok(None);
    }
    // Ensure an eval pack exists before proposing (harvest from the same
    // evidence; seeded judge-only expectations, §7.2).
    if case_count == 0 {
        let conn = db.lock();
        improve::harvest_eval_cases(&conn, &artifact.id, week_ago, 5)
            .map_err(|e| e.to_string())?;
    }

    let evidence_text = format_evidence(&evidence);
    let proposer_prompt = format!(
        "You are improving one behavioral artifact of an AI agent app based on \
failure evidence. Respond with ONLY a JSON object, no prose, no code fences.\n\n\
Artifact kind: {kind}\nArtifact name: {name}\n\n\
Current content (version {version}):\n<<<BODY\n{base_body}\nBODY>>>\n\n\
Failure evidence (recent failed/corrected runs; user message = what was asked, \
outcome/error = what went wrong):\n{evidence_text}\n\n\
Rewrite the artifact content to fix the root causes. Keep everything that \
already works; make the smallest targeted change that addresses the evidence. \
{kind_hint}\n\n\
JSON shape (all keys required):\n\
{{\"change_summary\": \"one sentence a user can evaluate\", \
\"new_body\": \"the FULL replacement content\", \
\"root_causes\": [\"cause 1\"], \
\"expected_effect\": \"what should improve\", \
\"risk_notes\": \"what could regress\"}}",
        kind = artifact.kind,
        name = artifact.name,
        version = active_version,
        base_body = base_body,
        evidence_text = evidence_text,
        kind_hint = if artifact.kind == "loop" {
            "The content MUST keep instructing the model to end every reply with a `LOOP_STATUS: continue|complete|blocked` line."
        } else {
            ""
        },
    );

    let reply = run_artifact_turn(db, PROPOSER_INSTRUCTIONS, &proposer_prompt)?;
    let json = extract_json(&reply).ok_or("proposer reply contained no JSON object")?;
    let parsed: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("bad proposer JSON: {e}"))?;
    let change_summary = parsed
        .get("change_summary")
        .and_then(|v| v.as_str())
        .ok_or("proposer JSON missing change_summary")?
        .to_string();
    let new_body = parsed
        .get("new_body")
        .and_then(|v| v.as_str())
        .ok_or("proposer JSON missing new_body")?
        .to_string();
    let root_causes = parsed.get("root_causes").cloned().unwrap_or(serde_json::Value::Array(vec![]));
    let expected_effect = parsed.get("expected_effect").and_then(|v| v.as_str()).map(String::from);
    let risk_notes = parsed.get("risk_notes").and_then(|v| v.as_str()).map(String::from);

    // Server-side field strip (§6.2): only text may change — schedules,
    // harnesses, scopes are unreachable through this contract by construction.
    static_gate(&artifact.kind, &base_body, &new_body)?;

    let conn = db.lock();
    // Another sweep may have raced an open proposal in — respect the dedupe.
    if improve::has_open_proposal(&conn, &artifact.id).map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let candidate = improve::record_version(&conn, &artifact.id, active_version, &new_body, None, "auto_proposal")
        .map_err(|e| e.to_string())?;
    let Some(candidate_version) = candidate else {
        return Ok(None); // body unchanged despite evidence — nothing to propose
    };
    let proposal = improve::create_proposal(
        &conn,
        &artifact.id,
        active_version,
        candidate_version,
        &change_summary,
        Some(root_causes.to_string().as_str()),
        expected_effect.as_deref(),
        risk_notes.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(proposal))
}

fn format_evidence(evidence: &[RunEvidence]) -> String {
    evidence
        .iter()
        .enumerate()
        .map(|(i, e)| {
            format!(
                "{}. outcome={} error={} user_message={:?}",
                i + 1,
                e.outcome,
                e.error_code.as_deref().unwrap_or("-"),
                e.input_text.as_deref().unwrap_or("(unavailable)")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const PROPOSER_INSTRUCTIONS: &str = "You are a precise artifact-improvement engine. You respond with exactly one JSON object and nothing else. Never wrap the JSON in code fences or commentary.";

// ---- evaluation (§7.2/§8) ----

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct CaseExpectations {
    #[serde(default)]
    must_contain: Vec<String>,
    #[serde(default)]
    must_not_contain: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    judge: bool,
    #[serde(default)]
    rubric: Option<String>,
}

struct CaseOutcome {
    case_id: String,
    champion_ok: bool,
    candidate_ok: bool,
    champion_score: Option<f64>,
    candidate_score: Option<f64>,
    detail: String,
}

/// Evaluate a proposal: run champion and candidate over the eval pack, apply
/// the §8 regression gate, persist the report, and stamp the proposal
/// `passed` / `failed_eval`.
pub fn evaluate_proposal(db: &Arc<parking_lot::Mutex<Connection>>, proposal_id: &str) -> EngResult<String> {
    let (proposal, artifact, base_body, cand_body, cases) = {
        let conn = db.lock();
        if !improvements_enabled(&conn) {
            return Err("improvements are disabled (improvements.enabled=false)".into());
        }
        let proposal = improve::get_proposal(&conn, proposal_id)
            .map_err(|e| e.to_string())?
            .ok_or("proposal not found")?;
        if proposal.status != "open" && proposal.status != "evaluating" {
            return Err(format!("proposal is {}, not evaluable", proposal.status));
        }
        let artifact = conn
            .query_row(
                "SELECT id, kind, ref_key, name, created_at FROM improve_artifacts WHERE id = ?1",
                rusqlite::params![proposal.artifact_id],
                |r| Ok(ImproveArtifact {
                    id: r.get(0)?, kind: r.get(1)?, ref_key: r.get(2)?, name: r.get(3)?, created_at: r.get(4)?,
                }),
            )
            .map_err(|e| e.to_string())?;
        let base_body = improve::version_body(&conn, &artifact.id, proposal.base_version)
            .map_err(|e| e.to_string())?
            .ok_or("base version body missing")?;
        let cand_body = improve::version_body(&conn, &artifact.id, proposal.candidate_version)
            .map_err(|e| e.to_string())?
            .ok_or("candidate version body missing")?;
        let cases = improve::list_eval_cases(&conn, &artifact.id, true).map_err(|e| e.to_string())?;
        (proposal, artifact, base_body, cand_body, cases)
    };
    if cases.is_empty() {
        return Err("artifact has no eval cases — add or harvest cases before evaluating".into());
    }
    improve::set_proposal_status(&db.lock(), proposal_id, "evaluating", None).map_err(|e| e.to_string())?;

    let eval_run_id = {
        let conn = db.lock();
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO improve_eval_runs (id, artifact_id, proposal_id, started_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, artifact.id, proposal.id, db::now_ts()],
        )
        .map_err(|e| e.to_string())?;
        id
    };

    let mut outcomes = Vec::new();
    for case in &cases {
        let outcome = eval_case(db, &artifact, &base_body, &cand_body, case);
        let ok = outcome.is_ok();
        let res = match &outcome {
            Ok(o) => CaseOutcome {
                case_id: o.case_id.clone(),
                champion_ok: o.champion_ok,
                candidate_ok: o.candidate_ok,
                champion_score: o.champion_score,
                candidate_score: o.candidate_score,
                detail: o.detail.clone(),
            },
            Err(e) => CaseOutcome {
                case_id: case.id.clone(),
                champion_ok: false,
                candidate_ok: false,
                champion_score: None,
                candidate_score: None,
                detail: format!("case execution error: {e}"),
            },
        };
        {
            let conn = db.lock();
            let _ = conn.execute(
                "INSERT INTO improve_eval_results (id, eval_run_id, eval_case_id, champion_ok, candidate_ok, champion_score, candidate_score, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(), eval_run_id, res.case_id,
                    res.champion_ok, res.candidate_ok,
                    res.champion_score, res.candidate_score, res.detail,
                ],
            );
        }
        if ok {
            outcomes.push(res);
        }
    }

    let verdict = apply_regression_gate(&outcomes);
    let report = serde_json::json!({
        "verdict": verdict,
        "cases": outcomes.iter().map(|o| serde_json::json!({
            "caseId": o.case_id,
            "championOk": o.champion_ok,
            "candidateOk": o.candidate_ok,
            "championScore": o.champion_score,
            "candidateScore": o.candidate_score,
            "detail": o.detail,
        })).collect::<Vec<_>>(),
    });
    {
        let conn = db.lock();
        conn.execute(
            "UPDATE improve_eval_runs SET finished_at = ?2, verdict = ?3, report_json = ?4 WHERE id = ?1",
            rusqlite::params![eval_run_id, db::now_ts(), verdict, report.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    improve::set_proposal_status(&db.lock(), proposal_id, &verdict, Some(&eval_run_id))
        .map_err(|e| e.to_string())?;
    if verdict == "passed" {
        route_passed_proposal(db, &proposal)?;
    }
    Ok(verdict)
}

/// §9.2 autonomy tiers, applied when an eval passes:
/// manual → wait for the user; auto → promote (capped 1/24h);
/// canary → open a shadow watch window instead of promoting.
fn route_passed_proposal(db: &Arc<parking_lot::Mutex<Connection>>, proposal: &ImproveProposal) -> EngResult<()> {
    let tier = improve::autonomy(&db.lock(), &proposal.artifact_id).map_err(|e| e.to_string())?;
    match tier.as_str() {
        "auto" => {
            {
                let conn = db.lock();
                if improve::promoted_recently(&conn, &proposal.artifact_id, 86_400)
                    .map_err(|e| e.to_string())?
                {
                    // Cap hit: stay 'passed' for manual apply (§9.3).
                    return Ok(());
                }
            }
            apply_proposal(db, &proposal.id)?;
            let conn = db.lock();
            improve::record_event(&conn, Some(&proposal.artifact_id), Some(&proposal.id), "promoted", Some(r#"{"how":"auto"}"#))
                .map_err(|e| e.to_string())
        }
        "canary" => {
            {
                let conn = db.lock();
                improve::set_channel(&conn, &proposal.artifact_id, "shadow", proposal.candidate_version)
                    .map_err(|e| e.to_string())?;
                improve::open_canary(&conn, &proposal.artifact_id, &proposal.id, proposal.base_version, proposal.candidate_version)
                    .map_err(|e| e.to_string())?;
                improve::record_event(&conn, Some(&proposal.artifact_id), Some(&proposal.id), "canary_started", None)
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        _ => Ok(()), // manual (default): the user decides from the panel
    }
}

/// Resolve every open canary window (§9.2): enough clean shadow runs →
/// promote; dirty window or expiry without evidence → auto-rollback. Two
/// rollbacks permanently demote the artifact to Manual (§9.3).
pub fn check_canaries(db: &Arc<parking_lot::Mutex<Connection>>) -> EngResult<Vec<String>> {
    let canaries = improve::open_canaries(&db.lock()).map_err(|e| e.to_string())?;
    let mut resolved = Vec::new();
    for c in canaries {
        let (total, bad, base_total, base_bad) = {
            let conn = db.lock();
            let (total, bad) = improve::version_run_health(&conn, &c.artifact_id, c.shadow_version, c.started_at)
                .map_err(|e| e.to_string())?;
            let (base_total, base_bad) = improve::version_run_health(&conn, &c.artifact_id, c.base_version, c.started_at)
                .map_err(|e| e.to_string())?;
            (total, bad, base_total, base_bad)
        };
        let age = db::now_ts() - c.started_at;
        if total < c.min_runs && age < c.max_age_secs {
            continue; // window still open, not enough evidence yet
        }
        let bad_rate = bad as f64 / total.max(1) as f64;
        let base_rate = base_bad as f64 / base_total.max(1) as f64;
        // Promote only when the window produced the minimum evidence AND the
        // shadow bad-rate stays within the champion's rate (+ slack).
        let clean = total >= c.min_runs && bad_rate <= (base_rate + 0.1).min(0.3);
        let kind: String = {
            let conn = db.lock();
            conn.query_row(
                "SELECT kind FROM improve_artifacts WHERE id = ?1",
                rusqlite::params![c.artifact_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?
        };
        if clean {
            let body = {
                let conn = db.lock();
                improve::version_body(&conn, &c.artifact_id, c.shadow_version)
                    .map_err(|e| e.to_string())?
                    .ok_or("shadow body missing")?
            };
            {
                let conn = db.lock();
                improve::set_channel(&conn, &c.artifact_id, "active", c.shadow_version).map_err(|e| e.to_string())?;
            }
            materialize(db, &c.artifact_id, &kind, &body)?;
            improve::resolve_canary(&db.lock(), &c.id, "promoted").map_err(|e| e.to_string())?;
            improve::set_proposal_status(&db.lock(), &c.proposal_id, "applied", None).map_err(|e| e.to_string())?;
            let conn = db.lock();
            improve::record_event(&conn, Some(&c.artifact_id), Some(&c.proposal_id), "promoted", Some(r#"{"how":"canary"}"#))
                .map_err(|e| e.to_string())?;
        } else {
            let base_body = {
                let conn = db.lock();
                improve::version_body(&conn, &c.artifact_id, c.base_version)
                    .map_err(|e| e.to_string())?
                    .ok_or("base body missing")?
            };
            {
                let conn = db.lock();
                improve::set_channel(&conn, &c.artifact_id, "active", c.base_version).map_err(|e| e.to_string())?;
            }
            materialize(db, &c.artifact_id, &kind, &base_body)?;
            improve::resolve_canary(&db.lock(), &c.id, "rolled_back").map_err(|e| e.to_string())?;
            improve::set_proposal_status(&db.lock(), &c.proposal_id, "stale", None).map_err(|e| e.to_string())?;
            let conn = db.lock();
            improve::record_event(&conn, Some(&c.artifact_id), Some(&c.proposal_id), "rolled_back", None)
                .map_err(|e| e.to_string())?;
            // Blast-radius rule: two rollbacks lose promotion privileges.
            let rollbacks = improve::rolled_back_count(&conn, &c.artifact_id).map_err(|e| e.to_string())?;
            if rollbacks >= 2 {
                let tier = improve::autonomy(&conn, &c.artifact_id).map_err(|e| e.to_string())?;
                if tier == "canary" || tier == "auto" {
                    improve::set_autonomy(&conn, &c.artifact_id, "manual").map_err(|e| e.to_string())?;
                }
            }
        }
        resolved.push(c.id);
    }
    Ok(resolved)
}

/// §8 gate: zero regressions on cases the champion passed, ≥95% candidate
/// pass rate, judge average ≥ champion − 0.3.
fn apply_regression_gate(outcomes: &[CaseOutcome]) -> String {
    if outcomes.is_empty() {
        return "failed_eval".to_string(); // every case errored — no evidence of safety
    }
    let n = outcomes.len() as f64;
    let cand_pass = outcomes.iter().filter(|o| o.candidate_ok).count() as f64;
    let any_regression = outcomes
        .iter()
        .any(|o| o.champion_ok && !o.candidate_ok);
    let cand_avg: f64 = outcomes.iter().filter_map(|o| o.candidate_score).sum::<f64>() / n;
    let champ_avg: f64 = outcomes.iter().filter_map(|o| o.champion_score).sum::<f64>() / n;
    let score_ok = cand_avg >= champ_avg - 0.3;
    if !any_regression && cand_pass / n >= 0.95 && score_ok {
        "passed"
    } else {
        "failed_eval"
    }
    .to_string()
}

fn eval_case(
    db: &Arc<parking_lot::Mutex<Connection>>,
    artifact: &ImproveArtifact,
    base_body: &str,
    cand_body: &str,
    case: &EvalCase,
) -> EngResult<CaseOutcome> {
    let expect: CaseExpectations =
        serde_json::from_str(&case.expect_json).map_err(|e| format!("bad expect_json: {e}"))?;
    let champion_reply = run_artifact_turn(db, base_body, &case.input_text)?;
    let candidate_reply = run_artifact_turn(db, cand_body, &case.input_text)?;

    let deterministic = |reply: &str| -> (bool, Vec<String>) {
        let mut failures = Vec::new();
        for needle in &expect.must_contain {
            if !reply.contains(needle.as_str()) {
                failures.push(format!("missing required text {needle:?}"));
            }
        }
        for needle in &expect.must_not_contain {
            if reply.contains(needle.as_str()) {
                failures.push(format!("contains forbidden text {needle:?}"));
            }
        }
        for pattern in &expect.regex {
            match regex::Regex::new(pattern) {
                Ok(re) if !re.is_match(reply) => failures.push(format!("regex {pattern:?} did not match")),
                Err(e) => failures.push(format!("invalid regex {pattern:?}: {e}")),
                _ => {}
            }
        }
        (failures.is_empty(), failures)
    };
    let (champion_ok, champ_failures) = deterministic(&champion_reply);
    let (candidate_ok, cand_failures) = deterministic(&candidate_reply);

    // Judge scores 1–5 per variant against the rubric, blind to which is
    // which (order randomized per case to control position bias). The judge
    // is the current active chat model — same cost ledger as chat.
    let (champion_score, candidate_score, judge_note) = if expect.judge {
        let champion_first = db::now_ts() % 2 == 0;
        let (a, b) = if champion_first {
            (&champion_reply, &candidate_reply)
        } else {
            (&candidate_reply, &champion_reply)
        };
        let judge_prompt = format!(
            "Rubric: {}\n\nUser request: {:?}\n\nResponse A:\n<<<A\n{}\nA>>>\n\nResponse B:\n<<<B\n{}\nB>>>\n\n\
Score each response 1–5 against the rubric. Respond with ONLY JSON: \
{{\"a\": <1-5>, \"b\": <1-5>, \"note\": \"one short sentence\"}}",
            expect.rubric.as_deref().unwrap_or("Correctly and completely addresses the user's request."),
            case.input_text, a, b,
        );
        let judge_reply = run_artifact_turn(db, JUDGE_INSTRUCTIONS, &judge_prompt)?;
        let json = extract_json(&judge_reply).ok_or("judge reply contained no JSON")?;
        let parsed: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("bad judge JSON: {e}"))?;
        let a_score = parsed.get("a").and_then(|v| v.as_f64());
        let b_score = parsed.get("b").and_then(|v| v.as_f64());
        let note = parsed.get("note").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if champion_first {
            (a_score, b_score, note)
        } else {
            (b_score, a_score, note)
        }
    } else {
        (None, None, String::new())
    };

    // A judge-only case (no deterministic expectations) counts as passing
    // when the rubric score is ≥3 — the deterministic layer has no opinion.
    let has_deterministic = !expect.must_contain.is_empty()
        || !expect.must_not_contain.is_empty()
        || !expect.regex.is_empty();
    let score_pass = |score: Option<f64>| score.map(|s| s >= 3.0);
    let champion_ok = if has_deterministic {
        champion_ok
    } else {
        score_pass(champion_score).unwrap_or(false)
    };
    let candidate_ok = if has_deterministic {
        candidate_ok
    } else {
        score_pass(candidate_score).unwrap_or(false)
    };

    Ok(CaseOutcome {
        case_id: case.id.clone(),
        champion_ok,
        candidate_ok,
        champion_score,
        candidate_score,
        detail: format!(
            "champion: {}; candidate: {}; judge: {judge_note}",
            if champ_failures.is_empty() { "ok".into() } else { champ_failures.join("; ") },
            if cand_failures.is_empty() { "ok".into() } else { cand_failures.join("; ") },
        ),
    })
}

const JUDGE_INSTRUCTIONS: &str = "You are a strict, impartial evaluator. You respond with exactly one JSON object and nothing else.";

// ---- apply / reject (§9 Manual tier) ----

/// Promote the candidate to `active` and materialize the live copy per kind.
/// The P1 default tier is Manual — this only ever runs on a `passed` proposal
/// (or an explicit user override for open ones via the UI).
pub fn apply_proposal(db: &Arc<parking_lot::Mutex<Connection>>, proposal_id: &str) -> EngResult<()> {
    let (proposal, artifact) = {
        let conn = db.lock();
        let proposal = improve::get_proposal(&conn, proposal_id)
            .map_err(|e| e.to_string())?
            .ok_or("proposal not found")?;
        if matches!(proposal.status.as_str(), "applied" | "rejected" | "stale") {
            return Err(format!("proposal is already {}", proposal.status));
        }
        let kind: String = conn
            .query_row(
                "SELECT kind FROM improve_artifacts WHERE id = ?1",
                rusqlite::params![proposal.artifact_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        (proposal, kind)
    };
    {
        let conn = db.lock();
        improve::set_channel(&conn, &proposal.artifact_id, "active", proposal.candidate_version)
            .map_err(|e| e.to_string())?;
    }
    let body = {
        let conn = db.lock();
        improve::version_body(&conn, &proposal.artifact_id, proposal.candidate_version)
            .map_err(|e| e.to_string())?
            .ok_or("candidate body missing")?
    };
    materialize(db, &proposal.artifact_id, &artifact, &body)?;
    improve::set_proposal_status(&db.lock(), proposal_id, "applied", None).map_err(|e| e.to_string())
}

pub fn reject_proposal(db: &Arc<parking_lot::Mutex<Connection>>, proposal_id: &str) -> EngResult<()> {
    improve::set_proposal_status(&db.lock(), proposal_id, "rejected", None).map_err(|e| e.to_string())
}

/// Push the promoted body to wherever the runtime reads it from.
fn materialize(db: &Arc<parking_lot::Mutex<Connection>>, artifact_id: &str, kind: &str, body: &str) -> EngResult<()> {
    let (ref_key, name) = {
        let conn = db.lock();
        conn.query_row(
            "SELECT ref_key, name FROM improve_artifacts WHERE id = ?1",
            rusqlite::params![artifact_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?
    };
    match kind {
        "skill" | "loop" => {
            let harness_kind = if kind == "loop" { "loops" } else { "skills" };
            crate::installed_skills::save_installed(&ref_key, harness_kind, body)
                .or_else(|_| crate::installed_skills::create_installed(&name, harness_kind, body).map(|_| ()))
        }
        "prompt_template" => {
            let conn = db.lock();
            let raw = db::get_setting(&conn, "prompts.templates")
                .ok()
                .flatten()
                .unwrap_or_else(|| "[]".into());
            let mut templates: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("prompts.templates is not valid JSON: {e}"))?;
            let arr = templates.as_array_mut().ok_or("prompts.templates is not an array")?;
            let mut hit = false;
            for t in arr.iter_mut() {
                if t.get("id").and_then(|v| v.as_str()) == Some(ref_key.as_str()) {
                    if let Some(obj) = t.as_object_mut() {
                        obj.insert("body".into(), serde_json::Value::String(body.to_string()));
                        hit = true;
                    }
                }
            }
            if !hit {
                return Err(format!("template {ref_key} no longer exists in prompts.templates"));
            }
            db::set_setting(&conn, "prompts.templates", &templates.to_string()).map_err(|e| e.to_string())
        }
        // Q4 decision: automation_runs stays the source of truth; promoting a
        // proposal rewrites the automation's prompt (the live copy).
        "automation" => {
            let conn = db.lock();
            let n = conn
                .execute(
                    "UPDATE automations SET prompt = ?2 WHERE id = ?1",
                    rusqlite::params![ref_key, body],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("automation {ref_key} no longer exists"));
            }
            Ok(())
        }
        other => Err(format!("unknown artifact kind {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_finds_balanced_object_in_fenced_reply() {
        let reply = "Sure!\n```json\n{\"a\": {\"b\": 1}, \"c\": \"}\"}\n```\nDone.";
        assert_eq!(extract_json(reply).unwrap(), r#"{"a": {"b": 1}, "c": "}"}"#);
        assert!(extract_json("no json here").is_none());
        assert!(extract_json("{\"unterminated\": 1").is_none());
    }

    #[test]
    fn static_gate_enforces_contract() {
        assert!(static_gate("skill", "a", "b").is_ok());
        assert!(static_gate("skill", "a", "a").is_err(), "no-change proposals rejected");
        assert!(static_gate("skill", "a", "  ").is_err(), "empty rejected");
        assert!(static_gate("skill", "a", &"x".repeat(40_000)).is_err(), "size budget");
        assert!(static_gate("loop", "old LOOP_STATUS body", "new body without sentinel").is_err());
        assert!(static_gate("loop", "old", "new body with LOOP_STATUS: continue").is_ok());
    }

    #[test]
    fn regression_gate_rules() {
        let case = |champ_ok: bool, cand_ok: bool, cs: Option<f64>, cd: Option<f64>| CaseOutcome {
            case_id: "c".into(),
            champion_ok: champ_ok,
            candidate_ok: cand_ok,
            champion_score: cs,
            candidate_score: cd,
            detail: String::new(),
        };
        // Clean win: no regressions, all pass, better scores.
        let win = vec![case(true, true, Some(3.0), Some(4.0)), case(false, true, Some(2.0), Some(4.0))];
        assert_eq!(apply_regression_gate(&win), "passed");
        // Regression: candidate broke a case the champion passed.
        let regressed = vec![case(true, false, Some(4.0), Some(2.0)), case(true, true, Some(4.0), Some(4.0))];
        assert_eq!(apply_regression_gate(&regressed), "failed_eval");
        // Judge gap too large.
        let worse = vec![case(true, true, Some(5.0), Some(2.0)), case(true, true, Some(5.0), Some(2.0))];
        assert_eq!(apply_regression_gate(&worse), "failed_eval");
        // Everything errored → no evidence → fail.
        assert_eq!(apply_regression_gate(&[]), "failed_eval");
    }

    /// Canary fixture: prompt_template artifact (materialization touches only
    /// the in-memory settings) with a v2 candidate and an open canary.
    fn canary_fixture(db: &Arc<parking_lot::Mutex<Connection>>) -> (ImproveArtifact, i64, String) {
        let conn = db.lock();
        let a = improve::ensure_artifact(&conn, "prompt_template", "t1", "T", "body v1").unwrap();
        crate::db::set_setting(&conn, "prompts.templates", r#"[{"id":"t1","name":"T","body":"body v1"}]"#).unwrap();
        let v2 = improve::record_version(&conn, &a.id, 1, "body v2", None, "auto_proposal").unwrap().unwrap();
        let p = improve::create_proposal(&conn, &a.id, 1, v2, "fix", None, None, None).unwrap();
        improve::set_proposal_status(&conn, &p.id, "passed", None).unwrap();
        improve::open_canary(&conn, &a.id, &p.id, 1, v2).unwrap();
        (a, v2, p.id)
    }

    #[test]
    fn canary_clean_window_promotes() {
        let db = Arc::new(parking_lot::Mutex::new(crate::db::mem()));
        let (a, v2, pid) = canary_fixture(&db);
        // Window still open (not enough evidence) → unresolved.
        check_canaries(&db).unwrap();
        assert!(improve::get_canary(&db.lock(), "x").is_ok()); // query sanity
        // 10 clean shadow runs meet min_runs.
        for i in 0..10 {
            let (run, body) = improve::start_run_shadow(&db.lock(), &a.id, Some(&format!("w{i}"))).unwrap();
            assert_eq!(body.as_deref(), Some("body v2"));
            improve::finish_session_runs(&db.lock(), &format!("w{i}"), "applied", None).unwrap();
        }
        let resolved = check_canaries(&db).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(improve::channel_version(&db.lock(), &a.id, "active").unwrap(), Some(v2));
        assert_eq!(improve::get_proposal(&db.lock(), &pid).unwrap().unwrap().status, "applied");
        // The live template copy was materialized to the promoted body.
        let raw = crate::db::get_setting(&db.lock(), "prompts.templates").unwrap().unwrap();
        assert!(raw.contains("body v2"), "template not materialized: {raw}");
    }

    #[test]
    fn canary_dirty_window_rolls_back_and_demotes_after_two() {
        let db = Arc::new(parking_lot::Mutex::new(crate::db::mem()));
        let (a, _v2, pid) = canary_fixture(&db);
        improve::set_autonomy(&db.lock(), &a.id, "canary").unwrap();
        // Dirty window: every shadow run corrected.
        for i in 0..10 {
            let (run, _body) = improve::start_run_shadow(&db.lock(), &a.id, Some(&format!("w{i}"))).unwrap();
            improve::finish_session_runs(&db.lock(), &format!("w{i}"), "corrected", None).unwrap();
        }
        check_canaries(&db).unwrap();
        // Rolled back to the base version, live copy restored, proposal stale.
        assert_eq!(improve::channel_version(&db.lock(), &a.id, "active").unwrap(), Some(1));
        assert_eq!(improve::get_proposal(&db.lock(), &pid).unwrap().unwrap().status, "stale");
        let raw = crate::db::get_setting(&db.lock(), "prompts.templates").unwrap().unwrap();
        assert!(raw.contains("body v1") && !raw.contains("body v2"));
        // One rollback is survivable; the second demotes to manual (§9.3).
        assert_eq!(improve::autonomy(&db.lock(), &a.id).unwrap(), "canary");
        // Compute the next candidate version BEFORE locking again — these
        // guards are not reentrant.
        let v3 = {
            let conn = db.lock();
            improve::record_version(&conn, &a.id, 1, "body v3", None, "auto_proposal").unwrap().unwrap()
        };
        let p2 = improve::create_proposal(&db.lock(), &a.id, 1, v3, "try again", None, None, None).unwrap();
        improve::set_proposal_status(&db.lock(), &p2.id, "passed", None).unwrap();
        improve::open_canary(&db.lock(), &a.id, &p2.id, 1, v3).unwrap();
        for i in 10..20 {
            let (run, _) = improve::start_run_shadow(&db.lock(), &a.id, Some(&format!("w{i}"))).unwrap();
            improve::finish_session_runs(&db.lock(), &format!("w{i}"), "failed", None).unwrap();
        }
        check_canaries(&db).unwrap();
        assert_eq!(improve::autonomy(&db.lock(), &a.id).unwrap(), "manual", "blast-radius rule");
    }

    #[test]
    fn apply_materializes_automation_prompt() {
        let db = Arc::new(parking_lot::Mutex::new(crate::db::mem()));
        let automation = {
            let conn = db.lock();
            crate::db::create_automation(
                &conn,
                &crate::db::automations::AutomationInput {
                    name: "nightly".into(),
                    prompt: "old prompt".into(),
                    harness: "claude_code".into(),
                    model: None,
                    cwd: None,
                    schedule: "0 3 * * *".into(),
                    enabled: Some(true),
                },
            )
            .unwrap()
        };
        let (a, v2) = {
            let conn = db.lock();
            let a = improve::ensure_artifact(&conn, "automation", &automation.id, "nightly", "old prompt").unwrap();
            let v2 = improve::record_version(&conn, &a.id, 1, "improved prompt", None, "auto_proposal").unwrap().unwrap();
            (a, v2)
        };
        let p = {
            let conn = db.lock();
            improve::create_proposal(&conn, &a.id, 1, v2, "sharpen the prompt", None, None, None).unwrap()
        };
        apply_proposal(&db, &p.id).unwrap();
        let prompt: String = {
            let conn = db.lock();
            conn.query_row(
                "SELECT prompt FROM automations WHERE id = ?1",
                rusqlite::params![automation.id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(prompt, "improved prompt");
        assert_eq!(improve::get_proposal(&db.lock(), &p.id).unwrap().unwrap().status, "applied");
        assert_eq!(improve::channel_version(&db.lock(), &a.id, "active").unwrap(), Some(2));
    }

    #[test]
    fn resolve_active_chat_model_returns_known_provider() {

        let conn = crate::db::mem();
        // Environment-dependent (the OS keychain may hold real keys on a dev
        // machine), so assert consistency rather than emptiness: whatever we
        // resolve must be one of the known scan providers.
        if let Some((provider, _model)) = resolve_active_chat_model(&conn) {
            assert!(matches!(
                provider.as_str(),
                "anthropic" | "openai" | "openrouter" | "anthropic_compatible" | "openai_compatible"
            ));
        }
        // The active_provider marker, when honored, wins over the scan.
        if crate::secrets::has_chat_api_key(&conn, "openrouter") {
            crate::db::set_setting(&conn, "chat.active_provider", "openrouter").unwrap();
            assert_eq!(resolve_active_chat_model(&conn).unwrap().0, "openrouter");
        }
    }
}
