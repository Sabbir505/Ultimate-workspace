//! Bots Tauri commands — thin wrappers over `db::bots` / `bot_runs`. Every
//! mutation emits `bots:changed` so the Bots view rail, the editor and the
//! activity strips refresh (same pattern as the automation run events).
//!
//! Two commands deserve a note:
//!   * `delete_bot` never purges memory unless asked (`purgeMemory`), and the
//!     outcome tells the UI exactly what was removed;
//!   * `resolve_bot_approval` REPLAYS the stored tool call verbatim through the
//!     family executors — the dispatcher is deliberately not re-entered, because
//!     its own approval cards need a paused live turn that no longer exists.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, Bot, BotInput, BotPatch, BotRun, DeleteBotOutcome};
use crate::db::bot_approvals::BotApproval;
use crate::DbState;

fn emit_changed(app: &AppHandle, action: &str, bot_id: &str) {
    let _ = app.emit(
        "bots:changed",
        serde_json::json!({ "action": action, "botId": bot_id }),
    );
}

#[tauri::command(async)]
pub fn list_bots(db: State<'_, DbState>) -> Result<Vec<Bot>, String> {
    let conn = db.0.lock();
    db::bots::list_bots(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_bot(app: AppHandle, db: State<'_, DbState>, input: BotInput) -> Result<Bot, String> {
    let bot = {
        let conn = db.0.lock();
        db::bots::create_bot(&conn, &input).map_err(|e| e.to_string())?
    };
    emit_changed(&app, "created", &bot.id);
    Ok(bot)
}

#[tauri::command(async)]
pub fn update_bot(
    app: AppHandle,
    db: State<'_, DbState>,
    bot_id: String,
    patch: BotPatch,
) -> Result<Bot, String> {
    let bot = {
        let conn = db.0.lock();
        db::bots::update_bot(&conn, &bot_id, &patch).map_err(|e| e.to_string())?
    };
    emit_changed(&app, "updated", &bot.id);
    Ok(bot)
}

#[tauri::command(async)]
pub fn delete_bot(
    app: AppHandle,
    db: State<'_, DbState>,
    bot_id: String,
    purge_memory: Option<bool>,
) -> Result<DeleteBotOutcome, String> {
    let purge = purge_memory.unwrap_or(false);
    // When the owner asks to purge, export the bot's memories to a Vault note
    // FIRST so the knowledge is recoverable (best-effort: a missing vault or a
    // write failure never blocks the delete). BOTS.md §What a bot is.
    if purge {
        let (memories, bot_name) = {
            let conn = db.0.lock();
            let profile = db::bots::bot_memory_profile(&bot_id);
            let mems = db::list_memories(&conn, &profile, false).unwrap_or_default();
            let name = db::bots::get_bot(&conn, &bot_id)
                .ok()
                .flatten()
                .map(|b| b.name)
                .unwrap_or_else(|| bot_id.clone());
            (mems, name)
        };
        if !memories.is_empty() {
            if let Ok(root) = crate::vault::current_root(&app) {
                let mut body = format!(
                    "# {bot_name} — memories\n\nExported before deleting the bot ({} memories).\n\n",
                    memories.len()
                );
                for m in &memories {
                    body.push_str(&format!(
                        "- **{}** (importance {}): {}\n",
                        m.kind, m.importance, m.content
                    ));
                }
                let safe: String = bot_name
                    .chars()
                    .map(|c| if c.is_alphanumeric() { c } else { '-' })
                    .collect();
                let rel = format!("Bots/{}-memories-{}.md", safe, db::now_ts());
                // create_note_core locks the DB itself — never call it while
                // holding the lock.
                if let Err(e) = crate::vault::create_note_core(&db.0, &root, &rel, &body) {
                    crate::relay_eprintln!("[bots] memory export to Vault skipped: {e}");
                }
            }
        }
    }
    let outcome = {
        let conn = db.0.lock();
        db::bots::delete_bot(&conn, &bot_id, purge).map_err(|e| e.to_string())?
    };
    emit_changed(&app, "deleted", &bot_id);
    Ok(outcome)
}

#[tauri::command(async)]
pub fn set_bot_enabled(
    app: AppHandle,
    db: State<'_, DbState>,
    bot_id: String,
    enabled: bool,
) -> Result<(), String> {
    {
        let conn = db.0.lock();
        db::bots::set_bot_enabled(&conn, &bot_id, enabled).map_err(|e| e.to_string())?;
    }
    emit_changed(&app, "updated", &bot_id);
    Ok(())
}

#[tauri::command(async)]
pub fn ensure_bot_session(db: State<'_, DbState>, bot_id: String) -> Result<String, String> {
    let conn = db.0.lock();
    db::bots::ensure_bot_session(&conn, &bot_id).map_err(|e| e.to_string())
}

/// Start a NEW conversation for a bot (the Bots view's "New session"). A bot may
/// hold several; `ensure_bot_session` then returns the newest one.
#[tauri::command(async)]
pub fn new_bot_session(
    app: AppHandle,
    db: State<'_, DbState>,
    bot_id: String,
) -> Result<String, String> {
    let sid = {
        let conn = db.0.lock();
        db::bots::create_bot_thread_session(&conn, &bot_id).map_err(|e| e.to_string())?
    };
    emit_changed(&app, "updated", &bot_id);
    Ok(sid)
}

/// Everything a bot has learned, for the editor's Memory section. The panel is
/// the same one the user's own memory uses, pointed at profile `bot:<id>`.
#[tauri::command(async)]
pub fn bot_memory_list(db: State<'_, DbState>, bot_id: String) -> Result<Vec<Value>, String> {
    let conn = db.0.lock();
    let profile = db::bots::bot_memory_profile(&bot_id);
    let rows = db::list_memories(&conn, &profile, false).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "kind": m.kind,
                "content": m.content,
                "importance": m.importance,
                "status": m.status,
                "createdAt": m.created_at,
            })
        })
        .collect())
}

/// Delete one memory a bot holds. Refuses any row whose profile is not EXACTLY
/// `bot:<bot_id>`: a bot id must never be a route to deleting the user's own
/// `default` memories.
#[tauri::command(async)]
pub fn bot_memory_delete(
    app: AppHandle,
    db: State<'_, DbState>,
    bot_id: String,
    memory_id: String,
) -> Result<(), String> {
    {
        let conn = db.0.lock();
        let profile = db::bots::bot_memory_profile(&bot_id);
        let row = db::get_memory(&conn, &memory_id).map_err(|e| e.to_string())?;
        match row {
            Some(m) if m.profile == profile => {
                db::delete_memory(&conn, &memory_id).map_err(|e| e.to_string())?;
            }
            Some(_) => {
                return Err("That memory belongs to you, not to this bot — refusing to delete it.".into())
            }
            None => return Err("No such memory".into()),
        }
    }
    emit_changed(&app, "updated", &bot_id);
    Ok(())
}

#[tauri::command(async)]
pub fn list_bot_approvals(
    db: State<'_, DbState>,
    bot_id: Option<String>,
) -> Result<Vec<BotApproval>, String> {
    let conn = db.0.lock();
    db::bot_approvals::list_approvals(&conn, bot_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_bot_runs(
    db: State<'_, DbState>,
    bot_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<BotRun>, String> {
    let conn = db.0.lock();
    let limit = limit.unwrap_or(20);
    match bot_id.as_deref() {
        Some(id) => db::bots::list_bot_runs(&conn, id, limit).map_err(|e| e.to_string()),
        None => db::bots::list_recent_bot_runs(&conn, limit).map_err(|e| e.to_string()),
    }
}

/// Bots with a run in flight right now (the rail pulses these).
#[tauri::command(async)]
pub fn bots_running() -> Vec<String> {
    crate::bot_runs::running_bots()
}

/// Stop one running bot run (the run's "Stop" in the Bots rail). Returns true
/// when a live run was found.
#[tauri::command(async)]
pub fn stop_bot_run(run_id: String) -> bool {
    crate::bot_runs::stop_run(&run_id)
}

/// What each bot has cost over the last `range_days` (Usage page's Bots
/// section): every session bound to the bot — conversations and runs — summed
/// from `chat_messages`. Dearest first.
#[tauri::command(async)]
pub fn get_bot_costs(
    db: State<'_, DbState>,
    range_days: Option<i64>,
) -> Result<Vec<db::bots::BotCost>, String> {
    let conn = db.0.lock();
    let days = range_days.unwrap_or(30).clamp(1, 365);
    db::bots::bot_cost_rollups(&conn, days * 86_400).map_err(|e| e.to_string())
}

/// "Run now" / the `run_bot` tool: fire one run and return immediately with
/// the run + session ids so the view can open it while it works.
#[tauri::command(async)]
pub fn run_bot_now(
    app: AppHandle,
    bot_id: String,
    prompt: Option<String>,
) -> Result<Value, String> {
    let (run_id, session_id, prompt) =
        crate::bot_runs::start_run_async(&app, &bot_id, prompt.as_deref(), "manual", "Manual run")?;
    Ok(serde_json::json!({
        "runId": run_id,
        "sessionId": session_id,
        "prompt": prompt,
    }))
}

/// Approve or deny a queued background write.
///
/// Approve replays the stored args through the SAME family executor the live
/// dispatcher would have used, bypassing the approval gate for exactly this
/// one call (the gate was already answered — by the human). Deny writes the
/// row off. Either way a short note lands in the run session so its history
/// stays truthful about what happened.
#[tauri::command(async)]
pub async fn resolve_bot_approval(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
    approve: bool,
) -> Result<BotApproval, String> {
    let row = {
        let conn = db.0.lock();
        db::bot_approvals::get_approval(&conn, &id).map_err(|e| e.to_string())?
    };
    let row = row.ok_or_else(|| "No such approval".to_string())?;
    if row.status != "pending" {
        return Err(format!(
            "This request is already {} — nothing to do.",
            row.status
        ));
    }

    // Claim the row BEFORE replaying. The conditional update is the one
    // serialization point: if the desktop inbox and a paired phone both fire
    // an approve, exactly one wins and replays the tool; the loser returns
    // without running the side effect a second time.
    let claimed = {
        let conn = db.0.lock();
        db::bot_approvals::claim_pending_approval(
            &conn,
            &id,
            if approve { "approved" } else { "denied" },
        )
        .map_err(|e| e.to_string())?
    };
    if !claimed {
        return Err("This request was already handled — nothing to do.".into());
    }

    let (status, result) = if approve {
        match replay_approved_tool(&app, &row).await {
            Ok(text) => ("approved".to_string(), text),
            Err(e) => ("failed".to_string(), e),
        }
    } else {
        ("denied".to_string(), String::new())
    };

    {
        let conn = db.0.lock();
        db::bot_approvals::set_approval_result(&conn, &id, &status, &result)
            .map_err(|e| e.to_string())?;
        // A truthful line in the run's transcript: what the owner decided, and
        // what happened next.
        let note = match status.as_str() {
            "approved" => format!(
                "✓ Approved: {} → {}",
                row.summary,
                crate::util::truncate_chars(result.trim(), 400)
            ),
            "denied" => format!("✕ Denied: {}", row.summary),
            _ => format!("⚠ Approval failed: {} → {}", row.summary, result.trim()),
        };
        let _ = db::add_chat_message(
            &conn,
            db::NewChatMessage {
                chat_session_id: &row.run_session_id,
                role: "assistant",
                content: &note,
                ..Default::default()
            },
        );
    }
    let _ = app.emit(
        "bots:changed",
        serde_json::json!({ "action": "approval", "botId": row.bot_id }),
    );
    let updated = {
        let conn = db.0.lock();
        db::bot_approvals::get_approval(&conn, &id).map_err(|e| e.to_string())?
    };
    updated.ok_or_else(|| "approval vanished".to_string())
}

/// Replay one approved tool call. Families are called directly (never through
/// `dispatch::run_tool`, whose cards need a paused live turn); a family with no
/// replay path says so instead of pretending.
async fn replay_approved_tool(app: &AppHandle, row: &BotApproval) -> Result<String, String> {
    let args: Value = serde_json::from_str(&row.args_json)
        .map_err(|e| format!("the stored arguments are unreadable: {e}"))?;
    let name = row.tool_name.as_str();

    if crate::chat::tools::is_automation_tool(name) {
        return Ok(crate::chat::tools::execute_automation_tool(app, name, &args).await);
    }
    if crate::chat::tools::is_subagent_tool(name) {
        return Ok(crate::chat::tools::execute_subagent_tool(app, name, &args).await);
    }
    if crate::chat::tools::is_vault_tool(name) {
        return Ok(crate::chat::tools::execute_vault_tool(app, name, &args).await);
    }
    if crate::chat::tools::is_bot_tool(name) {
        return Ok(crate::chat::tools::execute_bot_tool(app, name, &args).await);
    }

    // The filesystem / system / meta families all live behind `execute_tool`.
    let db = app.state::<DbState>();
    let caps = {
        let conn = db.0.lock();
        let mut roots: Vec<String> = db::list_projects(&conn)
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.path)
            .collect();
        roots.push(crate::chat::dispatch::artifacts_dir(app).to_string_lossy().to_string());
        crate::chat::tools::ToolCaps {
            fs_roots: roots,
            ..crate::chat::tools::ToolCaps::unlocked_registry()
        }
    };

    // System tools (`run_shell`, `download_file`, `run_code`, task tracking)
    // are NOT arms of `tools::execute_tool` — they live in the dispatcher's
    // system-tool executor. Replaying an approved one through `execute_tool`
    // used to return "unknown tool" and silently no-op while the row was
    // marked approved; route it to the real executor instead.
    if crate::chat::permission::is_system_tool(name) {
        return Ok(crate::chat::dispatch::execute_system_tool(
            app,
            &row.run_session_id,
            name,
            &args,
            &caps,
        )
        .await);
    }

    let client = reqwest::Client::new();
    let artifacts_dir = crate::chat::dispatch::artifacts_dir(app);
    let outcome = crate::chat::tools::execute_tool(
        &client,
        &artifacts_dir,
        &caps,
        name,
        &args,
        Some(app),
        Some(&row.run_session_id),
    )
    .await;
    let text = outcome.text;
    // The tool ladder's catch-all is `Error: unknown tool "…".` (lowercase,
    // prefixed). The guard used to look for `starts_with("Unknown tool")`,
    // which never fired — so an unreplayable/no-op call reported success.
    if text.to_ascii_lowercase().contains("unknown tool") {
        return Err(format!(
            "\"{name}\" cannot be replayed from here — ask the bot for it in its thread instead."
        ));
    }
    Ok(text)
}

/// Honesty badge: true only where a run-while-closed mechanism is registered.
/// Windows registers a Task Scheduler entry (`relay-automation run-due`);
/// launchd/systemd parity is a follow-up, so the Bots view says "standing jobs
/// run while Relay is open" everywhere else.
#[tauri::command(async)]
pub fn scheduler_available() -> bool {
    cfg!(windows)
}
