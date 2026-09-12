//! `commands::sessions` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- Chat session CRUD ----

/// Removes display-only process blocks — `<think>…</think>` reasoning and
/// `<tool>…</tool>` tool-call narration — from a message before it is sent
/// back to the API as conversation history. Also used by the harness context
/// primer (agent_sessions.rs) when handing a chat over to a fresh CLI session.
pub(crate) fn strip_think_blocks(content: &str) -> String {
    strip_tagged_blocks(&strip_tagged_blocks(content, "think"), "tool")
}

/// Strip every `<tag>…</tag>` span (and an unterminated trailing `<tag>…`).
pub(super) fn strip_tagged_blocks(content: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        match rest[start..].find(&close) {
            Some(end) => rest = &rest[start + end + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

#[tauri::command(async)]
pub fn list_chat_sessions(db: State<'_, DbState>) -> CmdResult<Vec<ChatSession>> {
    let conn = db.0.lock();
    db::list_chat_sessions(&conn).map_err(|e| e.to_string())
}

/// Persist a command-only user message without starting an LLM turn.
///
/// Artifact commands are real timeline events, but they must not be sent
/// through `send_chat_message` (which would create an unwanted assistant
/// response). The row is kind-marked (`artifact_command`) so every LLM
/// context builder (`list_active_chat_messages` consumers: the send payload,
/// the harness primer, compaction, the context meter) skips it — the work
/// happens out-of-band, and a stale "/create …" in the model's view made it
/// re-execute the command on every later send. Returning the inserted row
/// gives the frontend a stable message id to anchor the proposal card to.
#[tauri::command(async)]
pub fn persist_chat_command_message(
    chat_session_id: String,
    content: String,
    db: State<'_, DbState>,
) -> CmdResult<ChatMessageRecord> {
    let conn = db.0.lock();
    db::add_command_chat_message(&conn, &chat_session_id, &content, "artifact_command")
        .map_err(|e| e.to_string())
}

/// Full-text search across chat message content + session titles (powers the
/// command palette "Chats" section).
#[tauri::command(async)]
pub fn search_chat_messages(
    query: String,
    limit: Option<u32>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<ChatSearchResult>> {
    let conn = db.0.lock();
    db::search_chat_messages(&conn, &query, limit.unwrap_or(20)).map_err(|e| e.to_string())
}

// ---- Checkpoints (per-turn git working-tree snapshots) ----

/// All checkpoints for a chat session, oldest first (timeline order).
#[tauri::command(async)]
pub fn list_chat_checkpoints(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Vec<ChatCheckpoint>> {
    let conn = db.0.lock();
    db::list_chat_checkpoints(&conn, &chat_session_id).map_err(|e| e.to_string())
}

/// Roll the checkpoint's repo back to its snapshot. A safety checkpoint of
/// the CURRENT state is taken first and returned, so the restore itself is
/// one-click undoable. With `rollback_messages`, conversation messages after
/// the checkpointed turn are deleted too (the tree restore is primary; a
/// message-delete failure is logged and never fails the command). Emits
/// `checkpoint:created` for the safety snapshot.
#[tauri::command(async)]
pub fn restore_chat_checkpoint(
    checkpoint_id: i64,
    rollback_messages: bool,
    app: AppHandle,
    db: State<'_, DbState>,
) -> CmdResult<RestoreCheckpointResult> {
    // Passes the shared handle, not a held guard: checkpoints::restore scopes
    // the lock itself so the seconds-long git snapshot/restore never pin the
    // shared DB mutex.
    crate::checkpoints::restore(&app, &db.0, checkpoint_id, rollback_messages)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_chat_session(
    provider: String,
    model: String,
    project_id: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<ChatSession> {
    let conn = db.0.lock();
    db::create_chat_session(&conn, &provider, &model, project_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_chat_session(
    chat_session_id: String,
    db: State<'_, DbState>,
    agent_state: State<'_, crate::agent_sessions::AgentSessionState>,
    chat_state: State<'_, crate::ChatState>,
    plan_state: State<'_, crate::chat::plan::PlanState>,
) -> CmdResult<()> {
    // Kill any harness process still backing this chat and drop its state,
    // including the persisted CLI session ids used for cross-turn resume.
    agent_state.0.remove_session(&chat_session_id);
    // Also abort an in-flight builtin-provider stream (SSE/tool loop): without
    // this, a chat deleted mid-turn keeps streaming tokens/cost for a session
    // whose rows no longer exist. cancel() also drops pending approval cards,
    // which releases a harness reader thread blocked on can_use_tool.
    chat_state.0.cancel(&chat_session_id);
    chat_state.0.invalidate_context_tokens(&chat_session_id);
    // Drop the session's plan state (todos, plan mode, pending feedback).
    plan_state.clear_session(&chat_session_id);
    // The session's isolated worktree (roadmap P0 §3.1.1) is torn down
    // OUTSIDE the DB critical section: `git worktree remove --force` deletes a
    // whole tree (seconds), and this command used to run it on the IPC thread
    // while holding the shared DB mutex. The `relay/<id>` branch stays in the
    // repo, so committed work survives the delete either way.
    let worktree = {
        let conn = db.0.lock();
        db::get_chat_session(&conn, &chat_session_id)
            .ok()
            .flatten()
            .and_then(|sess| {
                crate::commands::worktree_cmds::worktree_teardown_target(&conn, &sess)
            })
    };
    if let Some((root, wt)) = worktree {
        let _ = tokio::task::spawn_blocking(move || {
            crate::commands::worktree_cmds::remove_worktree_blocking(root, wt);
        })
        .await;
    }
    let conn = db.0.lock();
    for harness in ["claude_code", "kimi_code", "opencode"] {
        let _ = db::delete_setting(
            &conn,
            &format!("agent.cli_session_id.{harness}.{chat_session_id}"),
        );
    }
    // Prune this session's git checkpoint refs before the rows cascade away.
    crate::checkpoints::prune_session_refs(&conn, &chat_session_id);
    db::delete_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

/// Bind (or unbind with `None`) a chat session to a project. Drives the chat's
/// nesting under the project's expandable sidebar row.
///
/// When the binding actually changes, any worktree the chat had under the OLD
/// project is removed best-effort and its pointer cleared (roadmap P0 §3.1.1):
/// a worktree belongs to a specific project, so rebinding/unbinding orphans it
/// — the `relay/<id>` branch stays in the repo, so nothing committed is lost.
///
/// `async` + a scoped guard for the same reason as [`delete_chat_session`]: the
/// teardown shells out to git, and it must not run on the UI thread or under
/// the DB mutex.
#[tauri::command]
pub async fn set_chat_session_project(
    chat_session_id: String,
    project_id: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    // Phase 1 (locked): decide what to tear down and collect paths only.
    let (teardown, changed) = {
        let conn = db.0.lock();
        let before = db::get_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())?;
        let changed = before
            .as_ref()
            .map(|s| s.project_id.as_deref() != project_id.as_deref())
            .unwrap_or(false);
        let teardown = if changed {
            before.and_then(|sess| {
                crate::commands::worktree_cmds::worktree_teardown_target(&conn, &sess)
            })
        } else {
            None
        };
        (teardown, changed)
    };
    let had_worktree = teardown.is_some();
    // Phase 2 (no lock): the slow git teardown, off the async runtime.
    if let Some((root, wt)) = teardown {
        let _ = tokio::task::spawn_blocking(move || {
            crate::commands::worktree_cmds::remove_worktree_blocking(root, wt);
        })
        .await;
    }
    let conn = db.0.lock();
    // The old binding's worktree is gone (or was never removable), so clear
    // its pointer — same end state remove_worktree_for_session left behind.
    if changed && had_worktree {
        let _ = db::set_chat_session_worktree(&conn, &chat_session_id, None);
    }
    db::set_chat_session_project(&conn, &chat_session_id, project_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete every chat session that has no messages AND is not starred —
/// the empty "Untitled" rows left behind when a brand-new chat was closed
/// before the user typed anything. `keep` (when Some) protects a single
/// session from the sweep; useful when the caller is about to select it.
/// Returns the number of rows deleted.
#[tauri::command(async)]
pub fn delete_empty_chat_sessions(keep: Option<String>, db: State<'_, DbState>) -> CmdResult<usize> {
    let conn = db.0.lock();
    db::delete_empty_chat_sessions(&conn, keep.as_deref()).map_err(|e| e.to_string())
}

/// Delete every chat session and all of its messages — the bulk form of
/// `delete_chat_session`, applying the exact same per-session cleanup (kill
/// any backing harness process, drop the persisted CLI session ids, then the
/// row). Returns the number of sessions deleted.
///
/// `async` because phase 3 prunes checkpoint refs and removes worktrees with
/// git: that work is O(sessions × git) and used to run on the IPC thread (the
/// UI thread) with the whole app serialized behind it.
#[tauri::command]
pub async fn delete_all_chat_sessions(
    db: State<'_, DbState>,
    agent_state: State<'_, crate::agent_sessions::AgentSessionState>,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<usize> {
    let sessions = {
        let conn = db.0.lock();
        db::list_chat_sessions(&conn).map_err(|e| e.to_string())?
    };
    let count = sessions.len();
    let ids = sessions.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    // Phase 1 (no DB lock): kill harness processes, abort in-flight streams,
    // and drop memoized context-meter counts. These touch in-memory state
    // only, so they stay out of the DB critical section.
    for id in &ids {
        agent_state.0.remove_session(id);
        chat_state.0.cancel(id);
        chat_state.0.invalidate_context_tokens(id);
    }
    // Phase 2 (ONE lock): the cheap DB reads/writes — CLI session-id
    // settings, checkpoint ref lists, worktree pointers. The git/FS work
    // those imply is COLLECTED here and run after the lock drops (phase 3):
    // worktree removal deletes a whole directory tree and ref pruning shells
    // out to git per repo — both used to run under this lock, serializing
    // every DB consumer behind O(sessions × git) filesystem work.
    let mut ref_groups = std::collections::BTreeMap::<String, Vec<String>>::new();
    let mut worktrees: Vec<(String, Option<String>, Option<String>)> = Vec::new(); // (session_id, worktree_path, project_path)
    {
        let conn = db.0.lock();
        for sess in &sessions {
            let id = &sess.id;
            for harness in ["claude_code", "kimi_code", "opencode"] {
                let _ = db::delete_setting(&conn, &format!("agent.cli_session_id.{harness}.{id}"));
            }
            for (repo, refs) in crate::checkpoints::collect_session_ref_groups(&conn, id) {
                ref_groups.entry(repo).or_default().extend(refs);
            }
            if let Some((root, wt)) =
                crate::commands::worktree_cmds::worktree_teardown_target(&conn, sess)
            {
                worktrees.push((id.clone(), Some(wt), root));
            }
        }
    }
    // Phase 3 (no lock, off the runtime): the slow git + filesystem cleanup.
    // Same contract as remove_worktree_for_session: best-effort removal rooted
    // at the project (branches stay in the repo if git fails).
    let _ = tokio::task::spawn_blocking(move || {
        crate::checkpoints::prune_ref_groups(ref_groups);
        for (_, worktree_path, proj_path) in &worktrees {
            if let Some(wt) = worktree_path {
                crate::commands::worktree_cmds::remove_worktree_blocking(proj_path.clone(), wt.clone());
            }
        }
    })
    .await;
    // Phase 4 (one lock): clear worktree pointers and delete the rows.
    let conn = db.0.lock();
    for sess in &sessions {
        if sess.worktree_path.is_some() {
            let _ = db::set_chat_session_worktree(&conn, &sess.id, None);
        }
        db::delete_chat_session(&conn, &sess.id).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

/// Delete a single chat message (user or assistant). The optimistic
/// just-sent message in the UI has a negative id; the backend ignores it
/// because the SQL `DELETE` simply matches zero rows. No-op if the id is
/// unknown (the UI tolerates a stale id and removes the bubble locally
/// either way).
#[tauri::command]
pub async fn delete_chat_message(message_id: i64, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_chat_message(&conn, message_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Retire the conversation branch at `message_id` (edit-to-fork). Marks that
/// message and every later row of its session as superseded, so the model no
/// longer sees the old tail. Returns how many rows were retired. The user then
/// edits the fork-point message and re-sends to continue a fresh branch.
#[tauri::command(async)]
pub fn supersede_chat_tail(message_id: i64, db: State<'_, DbState>) -> CmdResult<usize> {
    let conn = db.0.lock();
    let session_id: Option<String> = conn
        .query_row(
            "SELECT chat_session_id FROM chat_messages WHERE id = ?1",
            rusqlite::params![message_id],
            |r| r.get(0),
        )
        .ok();
    let Some(session_id) = session_id else {
        return Ok(0); // unknown message — nothing to retire
    };
    db::mark_branch_superseded(&conn, &session_id, message_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_chat_session_model(
    chat_session_id: String,
    model: String,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_model(&conn, &chat_session_id, &model).map_err(|e| e.to_string())
}

/// Switch a chat session's provider (e.g. to `local_gguf` when the user picks
/// a local model from the selector in a cloud session, or back to a cloud
/// provider from a local one). The caller is expected to also set a model
/// valid for the new provider.
#[tauri::command(async)]
pub fn update_chat_session_provider(
    chat_session_id: String,
    provider: String,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    // Validate against the known providers so a bogus value can't be persisted.
    let provider = match provider.as_str() {
        "anthropic"
        | "openai"
        | "anthropic_compatible"
        | "openai_compatible"
        | "openrouter"
        | "local_gguf" => provider,
        other => return Err(format!("unknown provider: {other}")),
    };
    let conn = db.0.lock();
    db::update_chat_session_provider(&conn, &chat_session_id, &provider).map_err(|e| e.to_string())
}

/// Update a chat session's permission posture. Per-session; new sessions
/// Update a chat session's dual sandbox + approval policies. `sandbox` is
/// `"read_only"` | `"workspace_write"`; `approval` is `"on_request"` |
/// `"auto_edit"` | `"full_access"`. The legacy `permission_mode` column is
/// also updated (derived from the dual policies) for backward compat.
#[tauri::command(async)]
pub fn update_chat_session_policies(
    chat_session_id: String,
    sandbox: String,
    approval: String,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let sandbox = match sandbox.as_str() {
        "read_only" | "workspace_write" => sandbox,
        other => return Err(format!("unknown sandbox_policy: {other}")),
    };
    let approval = match approval.as_str() {
        "on_request" | "auto_edit" | "full_access" => approval,
        other => return Err(format!("unknown approval_policy: {other}")),
    };
    let conn = db.0.lock();
    db::update_chat_session_policies(&conn, &chat_session_id, &sandbox, &approval)
        .map_err(|e| e.to_string())
}

/// Update a chat session's watch-mode pacing override. Per-session; new sessions
/// start with no override (NULL = inherit global setting). Valid values:
/// `"on"` | `"off"` | null (clears the override, falls back to global).
#[tauri::command(async)]
pub fn update_chat_session_watch_mode(
    chat_session_id: String,
    mode: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    // Validate against the known modes when a value is provided.
    if let Some(ref m) = mode {
        if m != "on" && m != "off" {
            return Err(format!("unknown watch_mode: {m} (expected 'on' or 'off')"));
        }
    }
    let conn = db.0.lock();
    db::update_chat_session_watch_mode(&conn, &chat_session_id, mode.as_deref())
        .map_err(|e| e.to_string())
}

/// Flip a chat session between Auto model routing and a pinned provider/model
/// (the composer picker's "Auto" entry). `true` marks the session auto-routed
/// and resets provider/model to "auto" placeholders until the next send
/// resolves them; `false` clears the flag only — a manual pick immediately
/// afterwards overwrites provider/model. Every send into an auto-routed
/// session re-resolves (cloud providers only; see chat/auto_router.rs) and
/// writes the concrete provider/model back to the row for the context meter,
/// cost attribution, and next-turn stickiness.
#[tauri::command(async)]
pub fn set_chat_session_auto(
    chat_session_id: String,
    auto: bool,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_chat_session_auto(&conn, &chat_session_id, auto).map_err(|e| e.to_string())
}

/// Update a chat session's agent selection from the composer's
/// agent-then-model selector. Per-session; new sessions start with no
/// selection (NULL = locked model chip). Valid values: `"builtin"` |
/// `"local"` | `"harness:<id>"` where `<id>` is a registered harness adapter
/// (e.g. `"harness:claude_code"`) | `"acp:<id>"` where `<id>` is a registered
/// ACP agent (roadmap #20, e.g. `"acp:zed"`) | null (clears the selection).
/// Harness/ACP sessions route sends to the headless CLI chat path
/// (agent_sessions.rs), not the built-in provider path.
#[tauri::command(async)]
pub fn update_chat_session_agent(
    chat_session_id: String,
    agent: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    if let Some(ref a) = agent {
        let valid = a == "builtin"
            || a == "local"
            || a.strip_prefix("harness:")
                .is_some_and(|id| crate::harness_adapters::get_adapter(id).is_some())
            || a.strip_prefix("acp:").is_some_and(|id| {
                let conn = db.0.lock();
                crate::acp_agents::find_agent(&conn, id).is_some()
            });
        if !valid {
            return Err(format!(
                "unknown agent: {a} (expected 'builtin', 'local', 'harness:<id>', or 'acp:<id>')"
            ));
        }
    }
    let conn = db.0.lock();
    db::update_chat_session_agent(&conn, &chat_session_id, agent.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn update_chat_session_title(
    chat_session_id: String,
    title: String,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_title(&conn, &chat_session_id, &title).map_err(|e| e.to_string())
}

/// Normalize a model-produced title: first non-empty line, quotes/`Title:`
/// prefix stripped, capped to a handful of words and characters, no trailing
/// punctuation.
pub(super) fn clean_title(raw: &str) -> String {
    let line = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut t = line
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string();
    if let Some(stripped) = t
        .strip_prefix("Title:")
        .or_else(|| t.strip_prefix("title:"))
    {
        t = stripped.trim().to_string();
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.len() > 8 {
        t = words[..8].join(" ");
    }
    if t.chars().count() > 60 {
        t = t.chars().take(60).collect::<String>().trim().to_string();
    }
    t.trim_end_matches(['.', ',', ';', ':']).trim().to_string()
}

/// Compact token-count formatter used in user-facing status lines (e.g.
/// "Compacted 8.2k → 1.1k tokens"). Mirrors the frontend's `formatTokens`
/// but is kept as a free function so the backend doesn't have to depend on
/// the lib crate. 0 returns "0".
pub(crate) fn format_compact_token_count(n: i64) -> String {
    let n = n.max(0) as u64;
    if n >= 1_000_000 {
        let v = n as f64 / 1_000_000.0;
        if v >= 10.0 {
            format!("{}M", v.round() as u64)
        } else {
            format!("{:.1}M", v)
        }
    } else if n >= 1000 {
        let v = n as f64 / 1000.0;
        if v >= 100.0 {
            format!("{}k", v.round() as u64)
        } else {
            format!("{:.1}k", v)
        }
    } else {
        n.to_string()
    }
}

#[tauri::command(async)]
pub fn set_chat_session_starred(
    chat_session_id: String,
    starred: bool,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_chat_session_starred(&conn, &chat_session_id, starred).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn set_chat_session_unread(
    chat_session_id: String,
    unread: bool,
    db: State<'_, DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_chat_session_unread(&conn, &chat_session_id, unread).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_chat_messages(
    chat_session_id: String,
    // M7: keyset pagination. `None`/`None` keeps the legacy behavior of the
    // full history (some callers — e.g. export — need it all), but the chat
    // view now pages 200 at a time.
    before_id: Option<i64>,
    limit: Option<i64>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<ChatMessageRecord>> {
    let conn = db.0.lock();
    match (before_id, limit) {
        (None, None) => db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string()),
        (b, l) => db::list_chat_messages_page(&conn, &chat_session_id, b, l.unwrap_or(200))
            .map_err(|e| e.to_string()),
    }
}

/// Session-level aggregate perf metrics for the composer row. Sums / weighted-
/// averages the per-turn perf columns on `chat_messages` (assistant rows only
/// — those carry `started_at`/`completed_at`/perf). Legacy rows with `NULL`
/// perf fields contribute zero and don't weigh the averages.
#[tauri::command(async)]
pub fn get_chat_session_metrics(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<ChatSessionMetricsPayload> {
    let conn = db.0.lock();
    let all = db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?;

    let mut llm_ms = 0i64;
    let mut tool_ms = 0i64;
    let mut ttft_sum = 0i64;
    let mut ttft_n = 0i64;
    let mut tok_wsum = 0.0; // Σ tok_s * output_tokens
    let mut tok_wout = 0i64; // Σ output_tokens over rows WITH tok/s — the weighted average's denominator (kept separate from the raw output total below)
    let mut output_sum = 0i64;
    let mut input_sum = 0i64;
    let mut cache_read_sum = 0i64;
    let mut total_prompt_sum = 0i64; // Σ per-row normalized total billed prompt
    let mut turn_count = 0i64;

    for m in &all {
        if m.role != "assistant" {
            continue;
        }
        turn_count += 1;
        if let Some(v) = m.llm_time_ms {
            llm_ms += v;
        }
        if let Some(v) = m.tool_time_ms {
            tool_ms += v;
        }
        if let Some(v) = m.ttft_ms {
            ttft_sum += v;
            ttft_n += 1;
        }
        if let (Some(ts), Some(out)) = (m.tokens_per_second, m.output_tokens) {
            if out > 0 {
                tok_wsum += ts * out as f64;
                tok_wout += out;
            }
        }
        let raw_input = m.input_tokens.unwrap_or(0);
        let read = m.cache_read_input_tokens.unwrap_or(0);
        let creation = m.cache_creation_input_tokens.unwrap_or(0);
        // The HUD's IN aggregate is the UNCACHED prompt slice: OpenAI-style
        // rows report input INCLUSIVE of the cache read — strip it
        // (Anthropic-style input is exclusive already), the same
        // normalization the live IN figure applies at the turn_perf fold.
        let uncached_input = if provider_input_includes_cache(m.provider.as_deref()) {
            (raw_input - read).max(0)
        } else {
            raw_input
        };
        input_sum += uncached_input;
        output_sum += m.output_tokens.unwrap_or(0);

        // Cache-hit corpus: only rows whose provider actually reported cache
        // fields contribute. Providers split the prompt two ways —
        // OpenAI-style `prompt_tokens` is INCLUSIVE of cached tokens,
        // Anthropic reports uncached input with the cache fields separate —
        // so normalize per row to the total billed prompt before summing
        // (same math as `turn_perf::cache_hit_rate`, so a session's
        // aggregate converges on the per-turn values).
        if read > 0 || creation > 0 {
            cache_read_sum += read;
            total_prompt_sum += uncached_input + read + creation;
        }
    }

    let cache_hit = if cache_read_sum > 0 && total_prompt_sum > 0 {
        Some(cache_read_sum as f64 / total_prompt_sum as f64)
    } else {
        None
    };

    let tokens_per_second = if tok_wout > 0 {
        Some(tok_wsum / tok_wout as f64)
    } else {
        None
    };

    Ok(ChatSessionMetricsPayload {
        chat_session_id,
        llm_time_ms: (llm_ms > 0).then_some(llm_ms),
        tool_time_ms: (tool_ms > 0).then_some(tool_ms),
        // `then_some` evaluates eagerly — use `then` so the division only
        // happens when `ttft_n > 0` (avoids divide-by-zero on empty sessions).
        ttft_avg_ms: (ttft_n > 0).then(|| ttft_sum / ttft_n),
        tokens_per_second,
        cache_hit_rate: cache_hit.filter(|v| v.is_finite()),
        input_tokens: input_sum,
        output_tokens: output_sum,
        turn_count,
    })
}

/// True when the provider's persisted `input_tokens` already INCLUDES the
/// cached-prompt tokens (OpenAI-style: `prompt_tokens` ⊇
/// `prompt_tokens_details.cached_tokens`). Anthropic-style providers (and
/// unknown/harness labels, which follow the Claude Code convention) report
/// uncached input with cache fields billed separately.
pub(super) fn provider_input_includes_cache(provider: Option<&str>) -> bool {
    matches!(
        provider,
        Some("openai") | Some("openai_compatible") | Some("openrouter") | Some("local_gguf")
    )
}

/// How many tokens of a prompt were cache-accounted on the reported turn —
/// the amount to subtract from a FULL prompt count to get the uncached
/// slice. OpenAI-style full prompts embed only the cache read (there is no
/// cache-write concept); Anthropic-style prompts EXCLUDE both cache fields,
/// so both count as cache-accounted.
pub(super) fn cache_accounted_tokens(provider: Option<&str>, cache_read: i64, cache_creation: i64) -> i64 {
    if provider_input_includes_cache(provider) {
        cache_read
    } else {
        cache_read + cache_creation
    }
}

#[tauri::command(async)]
pub fn touch_chat_session(chat_session_id: String, db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    db::touch_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

