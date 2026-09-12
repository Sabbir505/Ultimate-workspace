//! `commands::approval` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- Per-action tool approval ----

/// Resolve a pending filesystem-tool approval card. `approved = true` lets the
/// paused tool loop execute the action and feed its result back to the model;
/// `false` injects a "user denied" tool result instead. The tool loop itself
/// does the execution (it paused on the matching oneshot), so this command only
/// delivers the decision. Unknown / already-resolved `pending_id` is a no-op
/// (the card may have been auto-dismissed when the stream was cancelled).
/// Persist the target's parent directory as a user-granted root when an
/// approval is remembered ("always allow"). Without this, a remembered rule
/// auto-ran the NEXT call past the card — straight into the hard scope gate,
/// which refuses out-of-root writes: the remembered choice turned the write
/// into an error. Granting the directory makes the choice actually stick
/// (and gives Full Auto sessions a real root for out-of-project work).
pub(super) fn grant_directory_for_approved_tool(
    conn: &rusqlite::Connection,
    tool: &str,
    args: &serde_json::Value,
) {
    use crate::chat::tools;
    let mutating = matches!(
        tool,
        tools::WRITE_FILE
            | tools::EDIT_FILE
            | tools::DELETE_FILE
            | tools::MOVE_FILE
            | tools::COPY_FILE
            | tools::DOWNLOAD_FILE
    );
    if !mutating {
        return;
    }
    let target = crate::chat::dispatch::fs_target_path(tool, args);
    if target.is_empty() {
        return;
    }
    let path = std::path::Path::new(&target);
    let Some(dir) = path.parent() else { return };
    let dir = dir
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    // Only absolute paths have a stable root to grant.
    if dir.is_empty() || !path.is_absolute() {
        return;
    }
    let mut roots: Vec<String> = db::get_setting(conn, "permissions.grantedRoots")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).unwrap_or_default())
        .unwrap_or_default();
    if roots.iter().any(|r| r.eq_ignore_ascii_case(&dir)) {
        return;
    }
    roots.push(dir);
    let _ = db::set_setting(
        conn,
        "permissions.grantedRoots",
        &serde_json::to_string(&roots).unwrap_or_default(),
    );
}

#[tauri::command(async)]
pub fn resolve_tool_action(
    pending_id: String,
    approved: bool,
    chat_state: State<'_, crate::ChatState>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    if let Some(pending) = chat_state.0.take_pending_approval(&pending_id) {
        if approved {
            // "Always allow" on an out-of-scope path can only ever work if the
            // directory itself becomes granted — persist it now.
            grant_directory_for_approved_tool(&db.0.lock(), &pending.tool, &pending.args);
        }
        // The receiver end lives in the paused tool loop. A send error means
        // the loop already ended (stream cancelled) — ignore it.
        let _ = pending.response_tx.send(approved);
    }
    Ok(())
}

/// Resolve a `present_plan` proposal card. Same pause/resume contract as
/// `resolve_tool_action`, plus the rejection feedback: the text is stored in
/// PlanState BEFORE the oneshot is released (store-then-send ordering), so
/// the paused `present_plan` handler reads it right after waking. Unknown /
/// already-resolved `pending_id` is a no-op (card auto-dismissed on cancel).
#[tauri::command(async)]
pub fn resolve_plan_proposal(
    pending_id: String,
    approved: bool,
    feedback: Option<String>,
    chat_state: State<'_, crate::ChatState>,
    plan_state: State<'_, crate::chat::plan::PlanState>,
) -> CmdResult<()> {
    if let Some(pending) = chat_state.0.take_pending_approval(&pending_id) {
        if let Some(f) = feedback
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            plan_state.store_feedback(&pending_id, f);
        }
        let _ = pending.response_tx.send(approved);
    }
    Ok(())
}

/// Enter or exit plan mode for a chat session from the composer's mode menu.
/// Writes the persisted label ("plan" on permission_mode; the posture label
/// derived from the untouched dual policies on exit), syncs the in-memory
/// gate flag, and emits `chat:plan-mode` so every window's mode selector
/// agrees. Exiting restores the policies the session already had — plan mode
/// never modified them.
#[tauri::command(async)]
pub fn set_chat_session_plan_mode(
    chat_session_id: String,
    active: bool,
    db: State<'_, DbState>,
    plan_state: State<'_, crate::chat::plan::PlanState>,
    app: AppHandle,
) -> CmdResult<()> {
    // Persist first so the emitted event's label matches the stored row.
    let label = {
        let conn = db.0.lock();
        crate::db::set_chat_session_plan(&conn, &chat_session_id, active)
            .map_err(|e| e.to_string())?
    };
    plan_state.set_plan_mode(
        Some(&app),
        &chat_session_id,
        active,
        if active {
            "user enabled plan mode"
        } else {
            "user disabled plan mode"
        },
        &label,
    );
    Ok(())
}

/// Set a HARNESS session's native permission mode (the mode menu shows the
/// harness's own postures — e.g. OpenCode build/plan, Claude Code
/// default/acceptEdits/plan/bypassPermissions — instead of our built-in
/// ones). Persists the label on permission_mode; the harness spawn reads it
/// per turn and maps it to the CLI's own flags. Built-in sessions go through
/// `update_chat_session_policies` / `set_chat_session_plan_mode` instead.
///
/// claude_code is special: its CLI process is LONG-LIVED, so the label alone
/// would only apply on the next respawn. We also best-effort live-apply the
/// change through the control protocol (`set_permission_mode`) — mid-turn
/// switches then take effect immediately; the label-mismatch respawn on the
/// next send remains the deterministic backstop.
#[tauri::command(async)]
pub fn set_chat_session_permission_mode(
    chat_session_id: String,
    mode: String,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<()> {
    db::update_chat_session_permission_mode(&db.0.lock(), &chat_session_id, &mode)
        .map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<crate::agent_sessions::AgentSessionState>() {
        let _ = state
            .0
            .apply_claude_permission_mode(&chat_session_id, &mode);
    }
    Ok(())
}

/// Persist a HARNESS chat's reasoning-effort tier (the agent picker's harness
/// slider). `""` = "Default" — no flag at spawn; the CLI's own configured
/// effort stands. Applied per harness at spawn: claude `--effort`, omp/pi
/// `--thinking`, kimi `KIMI_MODEL_THINKING_EFFORT`. Per-turn CLIs pick it up
/// on the next send; claude respawns (send_claude_turn compares the spawned
/// tier, same contract as the permission-mode label).
#[tauri::command(async)]
pub fn update_chat_session_effort(
    chat_session_id: String,
    effort: String,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    if !crate::agent_sessions::is_valid_effort(&effort) {
        return Err(format!(
            "unknown effort tier: {effort} (expected one of {:?} or \"\")",
            crate::agent_sessions::EFFORT_TIERS
        ));
    }
    db::update_chat_session_effort(&db.0.lock(), &chat_session_id, effort.trim())
        .map_err(|e| e.to_string())
}

/// Answer a pending harness question. Two producers share this command:
/// a Claude Code `AskUserQuestion` (can_use_tool control protocol — the
/// answer resolves the oneshot the blocked reader thread awaits), and a
/// RELAY_ASK marker question from the no-native-protocol harnesses
/// (kimi/opencode/pi/omp/commandcode — the answer dispatches a follow-up
/// turn on the harness's resumed session). `answers` maps question text →
/// chosen option label (string, or an array for multiSelect); `response` is
/// an optional free-text reply. Unknown / already-resolved ids are a no-op.
#[tauri::command(async)]
pub fn resolve_agent_question(
    chat_session_id: String,
    pending_id: String,
    answers: serde_json::Value,
    response: Option<String>,
    chat_state: State<'_, crate::ChatState>,
    app: AppHandle,
    db: State<'_, DbState>,
    agent_state: State<'_, crate::agent_sessions::AgentSessionState>,
) -> CmdResult<()> {
    let _ = &chat_session_id; // registry is keyed by pending id; kept for UI symmetry
    let answers_for_ask = answers.clone();
    let response_for_ask = response.clone();
    if let Some(pending) = chat_state.0.take_pending_question(&pending_id) {
        let answers = if answers.is_object() {
            answers
        } else {
            serde_json::json!({})
        };
        let _ = pending.response_tx.send(crate::chat::QuestionReply {
            answers,
            response: response.filter(|s| !s.trim().is_empty()),
        });
    }
    // Relay_ASK + native-question path: nothing blocks on a oneshot — route
    // the answer by producer. Off this thread: a turn can run for minutes
    // and sync commands run on the blocking pool. The conditional take keeps
    // a NEWER pending (a replacement question) intact when a stale answer
    // races it; the stale answer is dropped instead of consuming it.
    if let Some(pending) = agent_state
        .0
        .take_pending_ask_if(&chat_session_id, &pending_id)
    {
        let answers = if answers_for_ask.is_object() {
            answers_for_ask
        } else {
            serde_json::json!({})
        };
        let free = response_for_ask
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let skipped = free.is_none() && answers.as_object().map(|o| o.is_empty()).unwrap_or(true);
        match pending.route {
            crate::agent_sessions::PendingAskRoute::OpenCode {
                base_url,
                oc_session_id,
                request_id,
            } => {
                // Native opencode `question` tool: POST the answer (or
                // the reject on skip) to the parked request. The turn is
                // still in flight server-side and completes on its own.
                let body = crate::agent_sessions::build_opencode_reply_answers(
                    &pending.questions,
                    &answers,
                    free,
                );
                let app2 = app.clone();
                let sid2 = chat_session_id.clone();
                std::thread::spawn(move || {
                    if let Err(e) = crate::agent_sessions::opencode_answer_question(
                        &base_url,
                        &oc_session_id,
                        &request_id,
                        skipped,
                        &body,
                    ) {
                        // The card is already dismissed — a failed POST must
                        // not read as "answered and ignored" in the UI.
                        eprintln!("[agent] opencode question answer failed: {e}");
                        crate::agent_sessions::emit_error(
                            Some(&app2),
                            &sid2,
                            &format!("couldn't deliver your answer to the harness: {e}"),
                        );
                    }
                });
            }
            crate::agent_sessions::PendingAskRoute::FollowUpTurn => {
                let content = crate::agent_sessions::compose_ask_follow_up(
                    &pending.questions,
                    &answers,
                    free,
                    skipped,
                );
                let manager = std::sync::Arc::clone(&agent_state.0);
                let db2 = DbState(std::sync::Arc::clone(&db.0));
                let sid = chat_session_id.clone();
                let app2 = app.clone();
                std::thread::spawn(move || {
                    // The question registered MID-TURN, so the asking turn is
                    // usually still draining when the user answers — sending
                    // immediately used to hit "a turn is already running" and
                    // silently drop the answer. Wait for the asking turn to
                    // end, then dispatch. (The harness is PAUSED on the
                    // question; only its own trailing output remains.)
                    let idle =
                        manager.wait_for_turn_idle(&sid, std::time::Duration::from_secs(300));
                    if !idle {
                        eprintln!("[agent] question follow-up: asking turn never went idle");
                        crate::agent_sessions::emit_error(
                            Some(&app2),
                            &sid,
                            "couldn't deliver your answer: the harness turn is still running",
                        );
                        return;
                    }
                    if let Err(e) = manager.dispatch_ask_follow_up(&app, &db2, &sid, &content) {
                        eprintln!("[agent] question follow-up failed: {e}");
                        crate::agent_sessions::emit_error(
                            Some(&app2),
                            &sid,
                            &format!("couldn't deliver your answer to the harness: {e}"),
                        );
                    }
                });
            }
        }
    }
    Ok(())
}

/// The model id the session's harness LAST actually ran, straight from the
/// harness's own stream (claude `message.model`, opencode `info.modelID`).
/// Custom/remapped harness setups make the session's stored catalog id
/// (`claude-opus-4-8`, …) a lie — the composer's context meter and window
/// math should reflect the real model. `None` for built-in/local sessions or
/// before the first harness turn completes.
#[tauri::command(async)]
pub fn get_agent_actual_model(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    let agent = {
        let conn = db.0.lock();
        db::get_chat_session(&conn, &chat_session_id)
            .ok()
            .flatten()
            .and_then(|cs| cs.agent)
    };
    let Some(agent) = agent else { return Ok(None) };
    let Some(harness) = agent.strip_prefix("harness:") else {
        return Ok(None);
    };
    let conn = db.0.lock();
    Ok(db::get_setting(
        &conn,
        &crate::agent_sessions::actual_model_key(harness, &chat_session_id),
    )
    .ok()
    .flatten()
    .filter(|m| !m.trim().is_empty()))
}

