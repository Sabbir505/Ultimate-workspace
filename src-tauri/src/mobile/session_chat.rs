//! Session-scoped chat manager (history + dispatch).
//!
//! Handles mobile companion app session-scoped chat:
//! - History pagination (`fetch_page`)
//! - Message dispatch (`handle`) that routes through ChatManager

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use crate::chat;
use crate::db;
use crate::types::ChatMessageRecord;

use super::protocol::{
    ChatArtifactPayload, ChatAttachment, DesktopMessage, MobileMessage, SessionMessageRecord,
};

/// Ensure the `owner_session_id` column exists on `chat_sessions`.
/// Called lazily from fetch_page / handle — safe to call multiple times.
pub fn ensure_chat_session_owner_column(conn: &Connection) -> Result<(), String> {
    // Cheap schema-only probe first: in the steady state (column present)
    // this replaces the per-call ALTER attempt, which took the write lock
    // and logged a duplicate-column error EVERY call. (A process-wide
    // once-flag would be wrong here — fresh in-memory DBs, e.g. tests, each
    // need their own ALTER.)
    if conn
        .prepare("SELECT owner_session_id FROM chat_sessions LIMIT 0")
        .is_ok()
    {
        return Ok(());
    }
    let sql = "ALTER TABLE chat_sessions ADD COLUMN owner_session_id TEXT";
    if let Err(e) = conn.execute(sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(format!("failed to add owner_session_id column: {e}"));
        }
    }
    Ok(())
}

/// Look up or create a chat session row keyed by `owner_session_id` (the
/// mobile app's session identifier). Returns the chat session's internal DB id.
#[allow(dead_code)] // Wired up in Task 4.
fn resolve_chat_session(
    conn: &Connection,
    owner_session_id: &str,
    provider: &str,
    model: &str,
) -> Result<String, String> {
    // Ensure the column exists first.
    ensure_chat_session_owner_column(conn)?;

    // Try to find an existing session with this owner_session_id.
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
            rusqlite::params![owner_session_id],
            |r| r.get(0),
        )
        .ok();

    if let Some(chat_session_id) = existing {
        Ok(chat_session_id)
    } else if let Ok(existing) = conn.query_row(
        "SELECT id FROM chat_sessions WHERE id = ?1",
        rusqlite::params![owner_session_id],
        |r| r.get(0),
    ) {
        // The sent id IS a chat_sessions id (the phone's list now carries
        // chat_sessions rows directly) — nothing to create or link.
        Ok(existing)
    } else {
        // Create a new chat session and link it to owner_session_id.
        let cs = db::create_chat_session(conn, provider, model, None)
            .map_err(|e| format!("failed to create chat session: {e}"))?;
        conn.execute(
            "UPDATE chat_sessions SET owner_session_id = ?2 WHERE id = ?1",
            rusqlite::params![&cs.id, owner_session_id],
        )
        .map_err(|e| format!("failed to link owner_session_id: {e}"))?;
        Ok(cs.id)
    }
}

/// Resolve a phone-supplied session id to a desktop `chat_sessions` id.
/// Accepts BOTH the legacy `owner_session_id` mapping (how phone sessions
/// keyed against the old `sessions` table) AND a direct `chat_sessions.id` —
/// which is what the phone's session list has carried ever since it started
/// reading chat_sessions, i.e. every desktop-created chat.
pub(super) fn resolve_session_to_chat_id(conn: &Connection, sent_id: &str) -> Option<String> {
    if let Ok(id) = conn.query_row(
        "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
        rusqlite::params![sent_id],
        |r| r.get::<_, String>(0),
    ) {
        return Some(id);
    }
    conn.query_row(
        "SELECT id FROM chat_sessions WHERE id = ?1",
        rusqlite::params![sent_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Resolve a phone-supplied session id or fail with the canonical
/// "session not found" error. One copy of the prologue ten handlers shared
/// verbatim.
fn require_chat_id(conn: &Connection, owner_session_id: &str) -> Result<String, String> {
    resolve_session_to_chat_id(conn, owner_session_id)
        .ok_or_else(|| format!("session not found: {owner_session_id}"))
}

/// Map the phone's attachment records onto the shape the shared chat
/// pipeline takes. One copy of the loop `handle_send_chat_message` ran
/// twice (once per turn kind).
fn to_attachment_inputs(attachments: Vec<ChatAttachment>) -> Vec<crate::types::ChatAttachmentInput> {
    attachments
        .into_iter()
        .map(|a| crate::types::ChatAttachmentInput {
            name: a.name,
            kind: a.kind,
            text: a.text,
            data: a.data,
            media_type: a.media_type,
            format: a.format,
        })
        .collect()
}

/// Fetch a page of session-scoped chat messages for history pagination.
/// Returns (records, has_more) where `has_more` indicates another page exists.
pub fn fetch_page(
    db: &Connection,
    owner_session_id: &str,
    before_id: Option<i64>,
    limit: u32,
) -> Result<(Vec<SessionMessageRecord>, bool), String> {
    ensure_chat_session_owner_column(db)?;

    // Resolve the chat_session_id: the sent id may be a legacy
    // owner_session_id mapping OR a direct chat_sessions id (what the
    // phone's chat_sessions-based session list sends).
    let chat_session_id: Option<String> = resolve_session_to_chat_id(db, owner_session_id);

    let chat_session_id = match chat_session_id {
        Some(id) => id,
        None => return Ok((vec![], false)), // No session yet, return empty.
    };

    // Fetch limit+1 rows to detect if there's more. Clamp the phone-controlled
    // limit first: u32::MAX used to overflow the `+1` (panic in debug builds,
    // wrap in release) instead of yielding a bounded page.
    let limit = limit.min(200);
    let limit_plus_one = (limit + 1) as i64;
    let mut stmt = db
        .prepare(
            "SELECT id, role, content, created_at, input_tokens, output_tokens, cost_usd, started_at, completed_at
         FROM chat_messages
         WHERE chat_session_id = ?1 AND (?2 IS NULL OR id < ?2)
         ORDER BY id DESC
         LIMIT ?3",
        )
        .map_err(|e| format!("failed to prepare fetch_page query: {e}"))?;

    let rows: Vec<ChatMessageRecord> = stmt
        .query_map(
            rusqlite::params![&chat_session_id, before_id, limit_plus_one],
            |row| {
                Ok(ChatMessageRecord {
                    id: row.get(0)?,
                    chat_session_id: chat_session_id.clone(),
                    role: row.get(1)?,
                    content: row.get(2)?,
                    created_at: row.get(3)?,
                    input_tokens: row.get(4)?,
                    output_tokens: row.get(5)?,
                    cost_usd: row.get(6)?,
                    superseded_by: None,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    reasoning_output_tokens: None,
                    provider: None,
                    model_key: None,
                    pricing_estimated_usd: None,
                    started_at: row.get(7)?,
                    completed_at: row.get(8)?,
                    llm_time_ms: None,
                    tool_time_ms: None,
                    ttft_ms: None,
                    tokens_per_second: None,
                })
            },
        )
        .map_err(|e| format!("failed to fetch messages: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to map messages: {e}"))?;

    // If we got limit+1 rows, has_more = true and pop the extra.
    let has_more = rows.len() > limit as usize;
    let records = if has_more {
        rows.into_iter().take(limit as usize).collect()
    } else {
        rows
    };

    // Convert ChatMessageRecord → SessionMessageRecord (different shapes).
    // artifact_paths comes from the artifacts table's message attribution so
    // the phone can render per-message file chips (desktop MessageAttachments
    // parity). Tool-call transcript rides inside `content` (<tool> segments),
    // which the phone's renderer already parses. ONE grouped query feeds all
    // rows — the per-row SELECT ran up to 200 times per page, and this page
    // is fetched on every first token, status banner, and streaming poll.
    let artifact_paths: std::collections::HashMap<i64, Vec<String>> = {
        let ids: Vec<i64> = records.iter().map(|r| r.id).collect();
        let mut map: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
        if !ids.is_empty() {
            let placeholders = std::iter::repeat("?")
                .take(ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT chat_message_id, path FROM artifacts
                 WHERE chat_message_id IN ({placeholders})
                 ORDER BY created_at"
            );
            let mut stmt = db
                .prepare(&sql)
                .map_err(|e| format!("artifact join prepare failed: {e}"))?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("artifact join failed: {e}"))?;
            for row in rows {
                let (id, path) = row.map_err(|e| format!("artifact join failed: {e}"))?;
                map.entry(id).or_default().push(path);
            }
        }
        map
    };
    let session_records: Vec<SessionMessageRecord> = records
        .into_iter()
        .map(|r| {
            let paths = artifact_paths.get(&r.id).cloned().unwrap_or_default();
            SessionMessageRecord {
                id: r.id,
                role: r.role,
                content: r.content,
                created_at: r.created_at,
                input_tokens: r.input_tokens,
                output_tokens: r.output_tokens,
                cost_usd: r.cost_usd,
                tool_calls: None,
                artifact_paths: if paths.is_empty() { None } else { Some(paths) },
                started_at: r.started_at,
                completed_at: r.completed_at,
            }
        })
        .collect();

    Ok((session_records, has_more))
}

/// Session-scoped chat message dispatcher. Routes mobile messages to the
/// ChatManager and streams responses back via Tauri events.
pub struct SessionChatManager;

impl SessionChatManager {
    /// Dispatch a mobile message and return desktop messages to send over the relay.
    /// For streaming responses (SendChatMessage), this emits events via `app.emit`
    /// and returns an empty vec; the relay will forward the events to the mobile app.
    pub fn handle(
        msg: MobileMessage,
        app: &AppHandle,
        db: Arc<Mutex<Connection>>,
        chat_mgr: Arc<chat::ChatManager>,
    ) -> Result<Vec<DesktopMessage>, String> {
        match msg {
            MobileMessage::GetSessionMessages {
                session_id,
                before_id,
                limit,
            } => handle_get_session_messages(&db, session_id, before_id, limit),

            MobileMessage::SendChatMessage {
                session_id,
                text,
                attachments,
            } => handle_send_chat_message(&app, &db, &chat_mgr, session_id, text, attachments),

            MobileMessage::CancelSessionStream { session_id } => {
                handle_cancel_session_stream(&app, &chat_mgr, &db, session_id)
            }

            MobileMessage::ResolveSessionApproval {
                session_id,
                pending_id,
                decision,
                always_allow,
            } => {
                // Ownership: a phone that learns another session's pending id
                // must not be able to answer its approval. FAIL CLOSED — the
                // old `if let` skipped the check entirely when the phone's
                // session id didn't resolve, so sending any garbage id
                // bypassed the guard.
                let pending_chat = chat_mgr.get_pending_approval_owner(&pending_id);
                let owner_chat = {
                    let conn = db.lock();
                    resolve_session_to_chat_id(&conn, &session_id)
                };
                match (pending_chat, owner_chat) {
                    (Some((pending_chat, _)), Some(owner)) => {
                        if pending_chat != owner {
                            return Err("approval does not belong to this session".into());
                        }
                    }
                    (Some(_), None) => {
                        return Err(format!("session not found: {session_id}"));
                    }
                    (None, _) => {}
                }
                handle_resolve_session_approval(
                    &db,
                    &chat_mgr,
                    pending_id,
                    decision,
                    always_allow,
                )
            }

            MobileMessage::RenameSession { session_id, title } => {
                handle_rename_session(&db, session_id, title)
            }

            MobileMessage::SetSessionModel {
                session_id,
                provider_id,
                model,
                effort,
            } => handle_set_session_model(app, &db, session_id, provider_id, model, effort),

            MobileMessage::DeleteChatSession { session_id } => {
                handle_delete_chat_session(&db, session_id)
            }

            MobileMessage::DeleteChatMessage {
                session_id,
                message_id,
            } => handle_delete_chat_message(&db, session_id, message_id),

            MobileMessage::EditUserMessage {
                session_id,
                message_id,
                text,
            } => handle_edit_user_message(&app, &db, &chat_mgr, session_id, message_id, text),

            MobileMessage::RegenerateMessage { session_id } => {
                handle_regenerate_message(&app, &db, &chat_mgr, session_id)
            }

            MobileMessage::ListChatCheckpoints { session_id } => {
                handle_list_chat_checkpoints(&db, session_id)
            }

            MobileMessage::RestoreChatCheckpoint {
                session_id,
                checkpoint_id,
                rollback_messages,
            } => handle_restore_chat_checkpoint(app, &db, session_id, checkpoint_id, rollback_messages),

            MobileMessage::ResolveSessionQuestion { session_id, pending_id, answers, response } => {
                let chat_session_id = {
                    let conn = db.lock();
                    require_chat_id(&conn, &session_id)?
                };
                // Ownership: same threat model as ResolveSessionApproval — a
                // phone that knows another chat's pending_id must not be able
                // to answer it. The agent-ask registry is keyed by chat id
                // (a mismatch is a stale no-op there), but the ChatState
                // question registry is keyed by pending id alone, so the
                // owning chat must be checked here.
                if let Some(owner) = app
                    .try_state::<crate::ChatState>()
                    .and_then(|c| c.0.peek_pending_question_chat(&pending_id))
                {
                    if owner != chat_session_id {
                        return Err("question does not belong to this session".into());
                    }
                }
                crate::chat::commands::approval::resolve_agent_question(
                    chat_session_id,
                    pending_id.clone(),
                    answers,
                    response,
                    app.state::<crate::ChatState>(),
                    app.clone(),
                    app.state::<crate::DbState>(),
                    app.state::<crate::agent_sessions::AgentSessionState>(),
                )
                .map_err(|e| e.to_string())?;
                Ok(vec![DesktopMessage::SessionQuestionResolved { pending_id }])
            }

            MobileMessage::SetSessionPermissionMode { session_id, mode } => {
                handle_set_session_permission_mode(&db, session_id, mode)
            }

            MobileMessage::GetSessionMeta { session_id } => {
                handle_get_session_meta(&db, session_id)
            }

            MobileMessage::SetSessionStarred { session_id, starred } => {
                handle_set_session_starred(&db, session_id, starred)
            }

            MobileMessage::RegisterPushToken { token, platform } => {
                super::push::handle_register_push_token(&db, token, platform)
            }

            MobileMessage::ListSessionArtifacts { session_id } => {
                handle_list_session_artifacts(&db, session_id)
            }

            MobileMessage::ReadArtifact { session_id, path } => {
                handle_read_artifact(app, &db, session_id, &path)
            }

            MobileMessage::ResolvePlanProposal {
                session_id: _,
                pending_id,
                approved,
                feedback,
            } => handle_resolve_plan_proposal(app, pending_id, approved, feedback),

            // Other variants are not session-scoped chat and are handled by the relay.
            _ => Err(format!(
                "message not handled by SessionChatManager: {:?}",
                msg
            )),
        }
    }
}

fn handle_get_session_messages(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    before_id: Option<i64>,
    limit: u32,
) -> Result<Vec<DesktopMessage>, String> {
    let conn = db.lock();
    // Opening the chat on the phone marks it read — desktop sidebar parity
    // (the unread dot clears once the conversation is actually viewed).
    if let Some(chat_session_id) = resolve_session_to_chat_id(&conn, &owner_session_id) {
        let _ = db::set_chat_session_unread(&conn, &chat_session_id, false);
        // A phone that opens a chat is WATCHING it: desktop-started turns in
        // this chat must stream to it live (not only after a manual refresh).
        super::relay_owner::watch_chat(&chat_session_id, &owner_session_id);
    }
    let (messages, has_more) = fetch_page(&conn, &owner_session_id, before_id, limit)?;
    Ok(vec![DesktopMessage::SessionMessages {
        session_id: owner_session_id,
        messages,
        has_more,
    }])
}

/// Star/unstar a chat — desktop sidebar pin parity. No response body: the
/// phone's list picks the new state up on the next 5s poll.
fn handle_set_session_starred(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    starred: bool,
) -> Result<Vec<DesktopMessage>, String> {
    let conn = db.lock();
    let chat_session_id = require_chat_id(&conn, &owner_session_id)?;
    db::set_chat_session_starred(&conn, &chat_session_id, starred)
        .map_err(|e| format!("failed to set starred: {e}"))?;
    Ok(vec![])
}

fn handle_send_chat_message(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<chat::ChatManager>,
    owner_session_id: String,
    text: String,
    attachments: Vec<ChatAttachment>,
) -> Result<Vec<DesktopMessage>, String> {
    // 1. Look up (or create) a chat_session row keyed by owner_session_id,
    //    then read back its provider/model. The phone has no provider picker;
    //    the row is the source of truth (switch on the desktop and the next
    //    mobile turn picks it up). Previously this hardcoded Anthropic +
    //    the literal key "no-key" — every turn 401'd even with a real key
    //    configured, and non-Anthropic sessions were ignored entirely.
    let step_trace = |step: &str| {
        crate::relay_eprintln!("[mobile-relay] SendChatMessage[{}]: {}", owner_session_id, step);
    };
    step_trace("enter");
    let (chat_session_id, provider_str, model, sandbox_policy, approval_policy, agent) = {
        let conn = db.lock();
        let id = resolve_chat_session(
            &conn,
            &owner_session_id,
            "anthropic",
            "claude-sonnet-4-5-20250929",
        )?;
        let row = db::get_chat_session(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session missing right after resolve".to_string())?;
        (
            id,
            row.provider,
            row.model,
            row.sandbox_policy,
            row.approval_policy,
            row.agent,
        )
    };
    let sandbox = crate::chat::permission::SandboxPolicy::from_db(&sandbox_policy);
    let approval = crate::chat::permission::ApprovalPolicy::from_db(&approval_policy);

    // 1z. HARNESS sessions (claude_code / kimi / opencode / commandcode / …)
    // run the CLI through agent_sessions — they are NOT provider turns. The
    // relay used to send EVERY phone message down the builtin provider path,
    // so a message in a commandcode chat asked OpenRouter for the CLI's model
    // id ("xiaomi/mimo-v2.6-flash") → overload/404 + auto-fallback noise,
    // while the desktop context meter showed provider=openrouter for a model
    // the CLI owns. This branch hands the turn to the same command the
    // desktop harness composer calls; it emits the same chat:token/done/error
    // events, so the relay's stream forwarder covers it unchanged.
    // Same classifier the cancel path uses (harness: OR acp:): a phone-picked
    // ACP agent used to fall through to the builtin provider path and hit a
    // cloud model instead of the local agent process (AgentSessionManager::
    // send dispatches `acp:<id>` ids to send_acp_turn, like the desktop).
    step_trace("resolved session row");
    let agent_id: Option<String> = match agent.as_deref() {
        Some(a) if a.starts_with("harness:") => {
            Some(a.strip_prefix("harness:").unwrap_or(a).to_string())
        }
        Some(a) if a.starts_with("acp:") => Some(a.to_string()),
        _ => None,
    };
    step_trace("harness check done");
    let attachments_input = to_attachment_inputs(attachments);
    if let Some(agent_id) = agent_id {
        {
            let conn = db.lock();
            db::touch_chat_session(&conn, &chat_session_id)
                .map_err(|e| e.to_string())?;
        }
        let (project_id, cwd) = {
            let conn = db.lock();
            let project_id = db::get_chat_session(&conn, &chat_session_id)
                .ok()
                .flatten()
                .and_then(|s| s.project_id);
            // CLI turns must run in the project: the old cwd:None made the
            // CLI spawn in the artifacts/Documents dir, where it read,
            // wrote and git-diffed the wrong tree (and a later desktop turn
            // dropped the CLI session id on the cwd change).
            let cwd = project_id
                .as_deref()
                .and_then(|pid| db::get_project(&conn, pid).ok().flatten())
                .map(|p| p.path);
            (project_id, cwd)
        };
        // Same registration order as the builtin path: the forwarder needs
        // the mapping before the CLI's first token.
        super::relay_owner::record_chat_owner(&chat_session_id, &owner_session_id);
        let _ = app.emit(
            "chat:turn-started",
            crate::types::ChatTurnStartedPayload {
                chat_session_id: chat_session_id.clone(),
            },
        );
        // Fire-and-forget like the builtin path: the CLI turn runs in the
        // agent session runtime and reports through the same chat:token /
        // chat:done / chat:error events (which the relay's forwarder ships
        // to the phone).
        let app_spawn = app.clone();
        tauri::async_runtime::spawn(async move {
            let state_probe = app_spawn.clone();
            let state_agent = state_probe.state::<crate::agent_sessions::AgentSessionState>();
            let state_db = state_probe.state::<crate::DbState>();
            // The id is consumed by the send; the error branch still needs it.
            let cid_err = chat_session_id.clone();
            if let Err(e) = crate::commands::agent_cmds::send_agent_chat_message(
                app_spawn,
                state_agent,
                state_db,
                chat_session_id,
                text,
                agent_id,
                Some(model).filter(|m| !m.trim().is_empty() && m != "auto"),
                cwd,
                project_id,
                Some(attachments_input),
                None,
            )
            .await
            {
                // A rejected turn used to vanish: the phone kept its
                // optimistic bubble + streaming spinner forever (and its
                // queued follow-ups silently died). Emit the canonical
                // chat:error — the relay forwarder ships SessionChatError to
                // the phone and the desktop composer surfaces it too.
                crate::relay_eprintln!("[mobile-relay] agent turn failed: {e}");
                crate::chat::stream_events::emit_error(Some(&state_probe), &cid_err, &e);
            }
        });
        return Ok(vec![]);
    }

    step_trace("agent branch done");
    // 2. Resolve provider + credentials exactly like the desktop
    //    send_chat_message command. local_gguf is keyless; everything else
    //    reads the real key from the keychain. An Auto-routed session
    //    (provider "auto") resolves synchronously here — the WS dispatch is
    //    sync, so no live /v1/models fetch: first keyed provider (static
    //    preference order) that the health store hasn't excluded, with its
    //    persisted default model (the desktop composer path runs the full
    //    context-aware resolver and writes the pick back for stickiness).
    let (provider_str, model_str) = if provider_str == "auto" {
        // Shared sync fallback resolver (auto_router::resolve_sync_default) —
        // the ordering/keying/health logic used to be copy-pasted here.
        let picked: Option<(String, String)> = {
            let conn = db.lock();
            crate::chat::auto_router::resolve_sync_default(&conn, db::now_ts())
        };
        let Some((p, m)) = picked else {
            return Err(
                "Auto has no usable provider: add a cloud API key in Settings → API Keys."
                    .to_string(),
            );
        };
        {
            let conn = db.lock();
            db::update_chat_session_provider(&conn, &chat_session_id, &p)
                .map_err(|e| e.to_string())?;
            db::update_chat_session_model(&conn, &chat_session_id, &m)
                .map_err(|e| e.to_string())?;
        }
        (p, m)
    } else {
        (provider_str, model)
    };
    let provider_id = match crate::chat::providers::provider_kind(&provider_str) {
        // Instance ids resolve to their kind (see provider_kind).
        "anthropic" => crate::chat::providers::ChatProviderId::Anthropic,
        "openai" => crate::chat::providers::ChatProviderId::OpenAI,
        "anthropic_compatible" => crate::chat::providers::ChatProviderId::AnthropicCompatible,
        "openai_compatible" => crate::chat::providers::ChatProviderId::OpenAICompatible,
        "openrouter" => crate::chat::providers::ChatProviderId::OpenRouter,
        "local_gguf" => crate::chat::providers::ChatProviderId::LocalGguf,
        other => return Err(format!("unknown provider: {other}")),
    };
    let model = model_str;
    let api_key = if provider_str == "local_gguf" {
        "no-key".to_string()
    } else {
        let conn = db.lock();
        crate::secrets::get_chat_api_key(&conn, &provider_str)
            .ok_or_else(|| format!("no API key configured for provider: {provider_str}"))?
    };
    let base_url = {
        let conn = db.lock();
        db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .ok()
            .flatten()
    };

    // 2. Process attachments exactly like the desktop composer (the mapping
    //    to ChatAttachmentInput ran once at the top of the fn, shared with
    //    the agent branch): images become vision content on the live turn
    //    (+ a placeholder in the body text), docs are base64-decoded and run
    //    through doc_to_text then inlined as fenced blocks, text is inlined
    //    verbatim. The (extra_text, images) pair mirrors the desktop
    //    send_chat_message path so the chat pipeline receives the same shape
    //    regardless of which client sent the turn.
    let (extra_text, images) = crate::chat::commands::process_attachments(&attachments_input);
    let content = format!("{text}{extra_text}");

    step_trace("provider resolved");
    // 3. Persist the user message (with attachment-derived text inlined so the
    //    history matches what the model actually saw).
    {
        let conn = db.lock();
        db::add_user_chat_message(&conn, &chat_session_id, &content)
            .map_err(|e| format!("failed to persist user message: {e}"))?;
        db::touch_chat_session(&conn, &chat_session_id)
            .map_err(|e| format!("failed to touch chat session: {e}"))?;
    }

    step_trace("user message persisted");
    // 4. Load the conversation history from the DB so the model sees the
    //    whole session (previously an empty Vec was passed — the model
    //    received a blank conversation every turn). Mirrors the desktop
    //    history selection: compacted-active rows for local models.
    let mut messages: Vec<crate::chat::providers::ChatMessage> = {
        let conn = db.lock();
        let records = if matches!(
            provider_id,
            crate::chat::providers::ChatProviderId::LocalGguf
        ) {
            db::list_active_chat_messages(&conn, &chat_session_id)
        } else {
            db::list_chat_messages(&conn, &chat_session_id)
        }
        .map_err(|e| format!("failed to load chat history: {e}"))?;
        records
            .into_iter()
            .map(|r| crate::chat::providers::ChatMessage {
                role: r.role,
                content: r.content,
                images: Vec::new(),
            })
            .collect()
    };

    step_trace("history loaded");
    // 5. If this turn carries vision images, attach them to the final user
    //    message so the live request includes them. History rows loaded above
    //    never carry images (they're DB text only); only the live turn gets
    //    the image vec.
    if !images.is_empty() {
        if let Some(last) = messages.last_mut() {
            last.images = images.clone();
        }
    }

    step_trace("images attached");
    // 5b. Register chat -> phone BEFORE the stream starts: `chat_mgr.send`
    //     spawns the provider stream immediately, and the relay's forwarder
    //     needs the mapping for the very first token (a fast provider can
    //     finish before a post-send registration ever ran). The desktop
    //     frontend only re-broadcasts `chat:*` for the chat it has open, so
    //     without this a phone-started turn streams nowhere.
    super::relay_owner::record_chat_owner(&chat_session_id, &owner_session_id);

    // 5c. Tell the desktop a backend-initiated turn is starting so its chat
    //     store pre-creates the streaming buffer (beginRemoteTurn). Without
    //     it the desktop DROPS this turn's tokens (straggler guard) and
    //     renders nothing live.
    let _ = app.emit(
        "chat:turn-started",
        crate::types::ChatTurnStartedPayload {
            chat_session_id: chat_session_id.clone(),
        },
    );

    step_trace("owner registered");
    // 5d. PROJECT CONTEXT (desktop send-path parity). The relay used to pass
    //     empty fs_roots and no system prompt, so a project-bound phone chat
    //     had no idea where it was scoped: the model answered "you're in
    //     Relay" (the desktop process cwd) and its file tools couldn't write
    //     into the project. Mirror the desktop composer: granted roots =
    //     every registered project + the artifacts dir + remembered grants;
    //     system prompt = AGENTS.md + wiki page index + the working-directory
    //     section for the bound project (or the artifacts fallback).
step_trace("5d: fs_roots start");
    let fs_roots: Vec<String> = {
        let conn = db.lock();
        let mut roots: Vec<String> = crate::db::list_projects(&conn)
            .map(|ps| ps.into_iter().map(|p| p.path).collect())
            .unwrap_or_default();
        // `artifacts_dir(app)` re-locks DbState internally — calling it with
        // this guard held is a SELF-DEADLOCK on the non-reentrant parking_lot
        // mutex (the phone turn parked forever at "5d: fs_roots start" and
        // every other relay op queued behind it). Use the locked variant.
        roots.push(
            crate::chat::dispatch::artifacts_dir_locked(&conn, app)
                .to_string_lossy()
                .to_string(),
        );
step_trace("5d: fs_roots listed");
        let granted: Vec<String> = crate::db::get_setting(&conn, "permissions.grantedRoots")
            .ok()
            .flatten()
            .and_then(|j| serde_json::from_str(&j).unwrap_or_default())
            .unwrap_or_default();
        for root in granted {
            if !roots.iter().any(|r| r.eq_ignore_ascii_case(&root)) {
                roots.push(root);
            }
        }
        roots
    };
    let system: Option<String> = {
        // Project path in its own short guard (blocking fs probes must not
        // hold the DB mutex — desktop audit C1 pattern).
step_trace("5d: project_path start");
        let project_path: Option<String> = {
            let conn = db.lock();
            crate::db::get_chat_session(&conn, &chat_session_id)
                .ok()
                .flatten()
                .and_then(|s| s.project_id)
                .and_then(|pid| crate::db::get_project(&conn, &pid).ok().flatten())
                .map(|p| p.path)
        };
        let mut sys = String::new();
step_trace("5d: project_path resolved");
        if let Some(path) = project_path.as_deref() {
            // AGENTS.md rides the system prompt (capped in agents_md.rs).
step_trace("5d: agents_md start");
            if let Some(section) = crate::agents_md::prompt_section(path) {
                sys.push_str(&section);
            }
            // Wiki page index beside AGENTS.md; pages stay behind the
            // search_wiki / read_wiki_page tools. Gated like the desktop.
            let wiki_layer = {
                let conn = db.lock();
                crate::db::get_setting(&conn, "wiki.layer_index")
                    .ok()
                    .flatten()
                    .map(|v| v.trim() != "false")
                    .unwrap_or(true)
            };
            // canonical_project_root returns the canonical path directly.
step_trace("5d: agents_md done");
            let canonical = crate::wiki::canonical_project_root(path);
            if wiki_layer {
                let conn = db.lock();
step_trace("5d: wiki start");
                if let Some(section) =
                    crate::wiki::index_prompt_section_canonical(&conn, &canonical)
                {
                    sys.push_str(&section);
                }
            }
step_trace("5d: wiki done");
            sys.push_str(&crate::chat::commands::send::working_directory_section(path));
        } else {
            // Unbound chat still operates SOMEWHERE — the artifacts fallback,
            // already in fs_roots. Name it so the model never guesses.
            let root = crate::chat::dispatch::artifacts_dir(app).to_string_lossy().to_string();
            sys.push_str(&crate::chat::commands::send::working_directory_section(&root));
        }
        if sys.is_empty() { None } else { Some(sys) }
    };

    step_trace("fs_roots+system built");
    // 5e. LOCAL GGUF: make sure the RIGHT sidecar is up before the turn.
    //     The phone can't spawn sidecars, and the persisted base_url may
    //     point at a PREVIOUS model's dead sidecar — posting there hung the
    //     turn forever. Mirror handle_chat_turn's warm-up: reuse the running
    //     sidecar when it matches the model, spawn the correct one
    //     otherwise, and use the FRESH base_url for this turn.
    let base_url = if provider_id == crate::chat::providers::ChatProviderId::LocalGguf {
        // NO outer db.lock() here: known_models_cached takes the DB mutex
        // itself — nesting them self-deadlocks (parking_lot is not
        // reentrant), freezing the handler while it holds the mutex, which
        // blanked the whole desktop on every local-model send.
        let model_path = crate::mobile::relay::known_models_cached(db)
            .into_iter()
            .find(|f| {
                f.meta.name.as_deref() == Some(model.as_str()) || f.filename == model
            })
            .map(|f| f.path);
        let Some(gguf_path) = model_path else {
            return Err(format!(
                "unknown local model: {model} — rescan local models on the desktop"
            ));
        };
        // warm_up_local_model is async but this handler is sync (called from
        // the relay connection loop): run it on a joined OS thread — legal
        // block_on context, and the connection waits for the CORRECT sidecar
        // to be ready instead of posting into a previous model's dead port.
        let app2 = app.clone();
        let model2 = model.clone();
        let warmed = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::mobile::relay::warm_up_local_model(
                &app2, &gguf_path, &model2,
            ))
        })
        .join()
        .map_err(|_| "local model warm-up thread panicked".to_string())??;
        Some(warmed)
    } else {
        base_url
    };

    step_trace("local warm-up done");
    step_trace("5d context done");
    // 6. Hand off to the chat pipeline. `ChatManager::send` cancels any
    //    in-flight stream for this `chat_session_id`, then spawns a tokio
    //    task that emits the same `chat:token` / `chat:status` /
    //    `chat:done` / `chat:error` / `chat:approval_request` /
    //    `chat:artifact` Tauri events the desktop composer already
    //    listens to. The new `mobile:session_chat_event` family (wired
    //    up in src/state/chat.ts + src-tauri/src/mobile/relay.rs) keys
    //    those events back to this `owner_session_id` so the phone
    //    receives them.
    chat_mgr.send(
        chat_session_id.clone(),
        provider_id,
        model,
        api_key,
        base_url,
        None,
        true,
        true,
        sandbox,
        approval,
        fs_roots,
        Vec::new(),
        Vec::new(),
        system,
        messages,
        Arc::clone(db),
        app.clone(),
        false,
        // No keyword fast-path on the mobile path — the desktop composer
        // owns prompt assembly; families unlock via attach there.
        Vec::new(),
        None,
        // Mobile turns have no fail-over chain (the desktop composer runs
        // the full resolver) and no system-prompt rebuild inputs.
        Vec::new(),
        None,
    );

    // 7. (No `mobile:session_chat_owner` emit anymore: the relay's
    //    start_chat_stream_forwarder streams relay-run turns to the phone
    //    directly. Keeping the frontend mapping would make useChatEvents
    //    forward the same tokens a SECOND time — duplicated text on the
    //    phone.)

    Ok(vec![])
}

fn handle_cancel_session_stream(
    app: &AppHandle,
    chat_mgr: &Arc<chat::ChatManager>,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    // Streams are keyed by the INTERNAL chat_session_id (the id passed to
    // ChatManager::send), so resolve it from the phone's owner_session_id
    // first — cancelling by owner_session_id was a silent no-op that left
    // the stream running (and billing) while the phone was told it stopped.
    let (chat_session_id, agent) = {
        let conn = db.lock();
        ensure_chat_session_owner_column(&conn)?;
        let id = resolve_session_to_chat_id(&conn, &owner_session_id);
        let agent = id
            .as_deref()
            .and_then(|cid| db::get_chat_session(&conn, cid).ok().flatten())
            .and_then(|s| s.agent);
        (id, agent)
    };
    if let Some(id) = chat_session_id {
        chat_mgr.cancel(&id);
        // Harness/ACP turns run in the agent-session runtime, NOT as
        // ChatState streams — chat_mgr.cancel is a silent no-op for them and
        // the CLI process kept running (and billing) after the phone tapped
        // Stop. The desktop composer branches to cancel_agent_chat_message
        // for exactly these agents (streamingSlice isCliAgent); mirror that
        // here. Fire-and-forget on a blocking worker: cancel blocks on the
        // per-session mutex that send holds for a whole turn's setup
        // (audit B-8), and the WS dispatch task must not stall behind it.
        let is_agent_turn = agent
            .as_deref()
            .map(|a| a.starts_with("harness:") || a.starts_with("acp:"))
            .unwrap_or(false);
        if is_agent_turn {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<crate::agent_sessions::AgentSessionState>();
                if let Err(e) = state.0.cancel(&app, &id) {
                    crate::relay_eprintln!("[mobile-relay] agent turn cancel failed: {e}");
                }
            });
        }
    }
    Ok(vec![DesktopMessage::SessionChatDone {
        session_id: owner_session_id,
        usage: None,
    }])
}

/// Filesystem mutators the desktop "always allow tool + glob" rules engine
/// governs. The phone's Always-Allow button is only shown for these; for any
/// other tool the flag is ignored (the desktop rules engine has no vocabulary
/// for them, and silently widening shell/browser powers from a phone tap
/// would be the wrong default).
const ALWAYS_ALLOWABLE_TOOLS: &[&str] = &[
    "write_file",
    "edit_file",
    "delete_file",
    "move_file",
    "copy_file",
];

fn handle_resolve_session_approval(
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<chat::ChatManager>,
    pending_id: String,
    decision: String,
    always_allow: bool,
) -> Result<Vec<DesktopMessage>, String> {
    let approved = match decision.as_str() {
        "approve" | "approved" | "yes" => true,
        "deny" | "denied" | "no" => false,
        _ => return Err(format!("invalid decision: {decision}")),
    };

    // "Always allow" needs the tool name, so look at the pending approval
    // BEFORE taking it. take_pending_approval consumes the entry.
    let pending = chat_mgr
        .take_pending_approval(&pending_id)
        .ok_or_else(|| format!("unknown pending approval id: {pending_id}"))?;
    let tool = pending.tool.clone();

    if approved && always_allow && ALWAYS_ALLOWABLE_TOOLS.contains(&tool.as_str()) {
        // Scope the persisted rule to the approved action's target directory.
        // The old empty pattern matched EVERY path for the tool — one phone
        // tap auto-approved writes anywhere the fs_roots containment allows.
        // move_file/copy_file gate on their write-side (`dest`) path; the
        // other mutators on `path`. No resolvable parent → no rule (fail
        // closed); the one-shot approval itself still goes through below.
        let target_key = if tool == "move_file" || tool == "copy_file" {
            "dest"
        } else {
            "path"
        };
        let dir = pending
            .args
            .get(target_key)
            .and_then(|v| v.as_str())
            .map(std::path::Path::new)
            .and_then(|p| p.parent())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .filter(|d| !d.trim().is_empty());
        if let Some(dir) = dir {
            let conn = db.lock();
            // The RULE is not enough on its own: `send_chat_message` only
            // bypasses the approval card via `permissions.rules`, while the
            // hard scope gate reads `permissions.grantedRoots`. A remembered
            // rule with no matching root sends the next out-of-project call
            // straight past the card and into a refusal — persisting the same
            // directory grant the desktop path does is what makes the phone's
            // "always allow" actually stick.
            crate::chat::commands::grant_directory_for_approved_tool(&conn, &tool, &pending.args);
            let mut rules: Vec<serde_json::Value> = db::get_setting(&conn, "permissions.rules")
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            rules.push(serde_json::json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "tool": tool,
                "pattern": format!("{dir}/**"),
                "createdAt": db::now_ts(),
            }));
            let serialized = serde_json::to_string(&rules)
                .map_err(|e| format!("failed to serialize approval rules: {e}"))?;
            let _ = db::set_setting(&conn, "permissions.rules", &serialized);
        }
    }

    // Deliver the decision via the oneshot channel. A send error means the
    // loop already ended (stream cancelled) — ignore it. The approval gate
    // emits `chat:approval-resolved` when the oneshot settles, and the
    // relay's stream forwarder routes that event to every phone watching the
    // chat — dismissing the card whether it was resolved here, on the
    // desktop, or on another phone. (The old bespoke notify keyed on the
    // row's owner_session_id column, which no modern phone session has, so
    // it never fired.)
    let _ = pending.response_tx.send(approved);

    Ok(vec![])
}

fn handle_rename_session(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    title: String,
) -> Result<Vec<DesktopMessage>, String> {
    let chat_session_id = {
        let conn = db.lock();
        require_chat_id(&conn, &owner_session_id)?
    };

    let conn = db.lock();
    db::update_chat_session_title(&conn, &chat_session_id, &title)
        .map_err(|e| format!("failed to update title: {e}"))?;

    Ok(vec![]) // No response needed — success is implicit.
}

const KNOWN_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "anthropic_compatible",
    "openai_compatible",
    "openrouter",
    "local_gguf",
    "auto",
];

fn handle_set_session_model(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    provider_id: String,
    model: String,
    effort: Option<String>,
) -> Result<Vec<DesktopMessage>, String> {
    // "harness:<family>" commits the AGENT too (the desktop picker's harness
    // pane rows are agent+model picks); cloud/local ids keep the provider.
    let harness_family = provider_id
        .strip_prefix("harness:")
        .map(str::to_string);
    // ACP agents commit the same way ("acp:<id>"); validation happens against
    // the ACP registry.
    let acp_family = provider_id.strip_prefix("acp:").map(str::to_string);
    if let Some(family) = &harness_family {
        if crate::harness_adapters::get_adapter(family).is_none() {
            return Err(format!("unknown harness: {family}"));
        }
    } else if let Some(family) = &acp_family {
        let known = {
            let conn = db.lock();
            crate::acp_agents::all_agents(&conn)
                .iter()
                .any(|x| x.id == *family)
        };
        if !known {
            return Err(format!("unknown ACP agent: {family}"));
        }
    } else if !KNOWN_PROVIDERS.contains(&provider_id.as_str()) {
        return Err(format!("unknown provider: {provider_id}"));
    }
    if model.trim().is_empty() {
        return Err("model must not be empty".to_string());
    }
    let chat_session_id = {
        let conn = db.lock();
        require_chat_id(&conn, &owner_session_id)?
    };
    {
        let conn = db.lock();
        if let Some(family) = &harness_family {
            db::update_chat_session_agent(
                &conn,
                &chat_session_id,
                Some(&format!("harness:{family}")),
            )
            .map_err(|e| format!("failed to set agent: {e}"))?;
        } else if acp_family.is_some() {
            db::update_chat_session_agent(&conn, &chat_session_id, Some(&provider_id))
                .map_err(|e| format!("failed to set agent: {e}"))?;
        } else {
            db::update_chat_session_provider(&conn, &chat_session_id, &provider_id)
                .map_err(|e| format!("failed to set provider: {e}"))?;
            // Switching BACK to a provider must clear the agent, or the row
            // keeps routing every later turn (from the phone AND the
            // desktop) through the CLI while the chip claims the provider.
            db::update_chat_session_agent(&conn, &chat_session_id, None)
                .map_err(|e| format!("failed to clear agent: {e}"))?;
        }
        db::update_chat_session_model(&conn, &chat_session_id, &model)
            .map_err(|e| format!("failed to set model: {e}"))?;
        if let Some(effort) = &effort {
            db::update_chat_session_effort(&conn, &chat_session_id, effort)
                .map_err(|e| format!("failed to set effort: {e}"))?;
        }
        // An explicit pick must LEAVE auto routing, or the next send
        // re-resolves the row back to the router's pick (openrouter/free)
        // and the user's choice silently reverts. Picking "auto" re-arms it.
        db::set_chat_session_auto(&conn, &chat_session_id, provider_id == "auto")
            .map_err(|e| format!("failed to update auto mode: {e}"))?;
    }
    // The desktop picker reads the session row; without this ping it keeps
    // showing its own (stale) model until the window reloads.
    let _ = app.emit(
        "chat:session-updated",
        serde_json::json!({ "chatSessionId": chat_session_id }),
    );
    Ok(vec![DesktopMessage::SessionModelSet {
        session_id: owner_session_id,
        provider_id,
        model,
        effort,
    }])
}

fn handle_delete_chat_session(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let chat_session_id = {
        let conn = db.lock();
        require_chat_id(&conn, &owner_session_id)?
    };
    {
        let conn = db.lock();
        db::delete_chat_session(&conn, &chat_session_id)
            .map_err(|e| format!("failed to delete session: {e}"))?;
    }
    Ok(vec![DesktopMessage::SessionDeleted {
        session_id: owner_session_id,
    }])
}

fn handle_get_session_meta(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let conn = db.lock();
    let id: Option<String> = resolve_session_to_chat_id(&conn, &owner_session_id);
    // Every phone session is created through CreateSession, which writes a
    // real chat_sessions row before SessionCreated goes out — so an
    // unresolvable id here means a deleted/garbage session, not a fresh
    // one. Answering with synthetic "auto" defaults let a stale chat render
    // a plausible header for a session that no longer exists; error instead.
    let Some(chat_session_id) = id else {
        return Err(format!("unknown session: {owner_session_id}"));
    };
    let row = db::get_chat_session(&conn, &chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat session row missing".to_string())?;
    let project_name = row
        .project_id
        .as_deref()
        .and_then(|pid| crate::db::get_project(&conn, pid).ok().flatten())
        .map(|p| p.name);
    Ok(vec![DesktopMessage::SessionMeta {
        session_id: owner_session_id,
        provider: row.provider,
        model: row.model,
        title: row.title,
        effort: row.effort_level,
        permission_mode: Some(row.permission_mode),
        project_id: row.project_id,
        project_name,
    }])
}

fn artifact_kind(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase()
}

/// Extensions the phone can preview as text. Everything else (pdf, png,
/// docx, …) rides as base64 and gets a save/share affordance instead.
const PREVIEWABLE_TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "json", "csv", "tsv", "toml", "yaml", "yml", "html", "css", "svg",
    "xml", "js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "h", "cpp", "sh", "bat", "ps1",
    "sql", "log",
];
/// Caps: text previews get a prefix; binaries get nothing (the phone shows a
/// save/share card instead of trying to render megabytes).
const TEXT_PREVIEW_CAP: usize = 512 * 1024;
const BINARY_CAP: usize = 8 * 1024 * 1024;

fn handle_list_session_artifacts(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let conn = db.lock();
    let id: Option<String> = resolve_session_to_chat_id(&conn, &owner_session_id);
    let Some(chat_session_id) = id else {
        return Ok(vec![DesktopMessage::SessionArtifacts {
            session_id: owner_session_id,
            artifacts: vec![],
        }]);
    };
    let records = db::list_artifacts_for_chat(&conn, &chat_session_id)
        .map_err(|e| format!("failed to list artifacts: {e}"))?;
    let artifacts = records
        .into_iter()
        .map(|r| {
            let kind = artifact_kind(&r.path);
            ChatArtifactPayload {
                path: r.path,
                filename: r.filename,
                kind: Some(kind),
                inline: None,
            }
        })
        .collect();
    Ok(vec![DesktopMessage::SessionArtifacts {
        session_id: owner_session_id,
        artifacts,
    }])
}

/// Run a blocking file read + encode off the async runtime workers: up to
/// 8 MB of `fs::read` plus base64 used to run inline inside the relay's
/// WebSocket task. `handle_read_artifact` is reached through the sync
/// dispatch chain (which can run ON a runtime worker), so the result is
/// joined via a plain channel — `block_on` from inside a runtime would
/// panic, a channel recv is safe from any thread.
/// `Err(String)` on either failure mode: sender dropped (join failed) or the
/// closure panicked. The old `expect` re-panicked on the CALLING thread —
/// the relay's WebSocket task — tearing down the phone's whole connection
/// over one bad read (audit L-11). Callers map this into an ordinary error
/// reply.
fn blocking_read<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tx.send(f());
    });
    rx.recv().map_err(|_| "blocking task terminated without a result".to_string())
}

fn handle_read_artifact(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    path: &str,
) -> Result<Vec<DesktopMessage>, String> {
    // Containment first: the phone may only read files inside the desktop's
    // artifacts directory (and the generated-images dir image artifacts land
    // in — the library lists those too). Without this gate, any script that
    // can send one relay message gets an arbitrary-file-read primitive (the
    // exact class of hole PROJECT_AUDIT.md flags on the desktop's own
    // artifact IPC).
    let artifacts_root = crate::chat::dispatch::artifacts_dir(app);
    let generated_root = crate::user_dirs::app_data_dir(app).join("generated-images");
    let granted = [
        artifacts_root.to_string_lossy().to_string(),
        generated_root.to_string_lossy().to_string(),
    ];
    if !crate::chat::permission::path_within_scope(path, &granted) {
        return Err("artifact path is outside the artifacts directory".to_string());
    }
    // The artifact must also be one the session actually produced — a valid
    // path in the artifacts dir from a DIFFERENT session is still refused —
    // OR an entry of the global artifact library (the deduped latest-per-path
    // list the desktop sidebar shows): the phone's library reads entries whose
    // source chat is unknown, and library membership is the authorization.
    let owns = {
        let conn = db.lock();
        let in_library: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM artifacts WHERE path = ?1 LIMIT 1",
                rusqlite::params![path],
                |r| r.get(0),
            )
            .ok();
        if in_library.is_some() {
            true
        } else {
            match resolve_session_to_chat_id(&conn, &owner_session_id) {
                Some(chat_session_id) => db::list_artifacts_for_chat(&conn, &chat_session_id)
                    .map(|rows| rows.iter().any(|r| r.path == path))
                    .unwrap_or(false),
                None => false,
            }
        }
    };
    if !owns {
        return Err("artifact not found in this session".to_string());
    }

    let kind = artifact_kind(path);
    let filename = std::path::Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("artifact")
        .to_string();
    let meta = std::fs::metadata(path);
    let is_text = PREVIEWABLE_TEXT_EXTS.contains(&kind.as_str());

    if is_text {
        let read_path = path.to_string();
        let bytes = blocking_read(move || std::fs::read(&read_path))
            .map_err(|_| "artifact read panicked".to_string())?
            .map_err(|e| format!("failed to read artifact: {e}"))?;
        let truncated = bytes.len() > TEXT_PREVIEW_CAP;
        let take = if truncated {
            TEXT_PREVIEW_CAP
        } else {
            bytes.len()
        };
        // Text extensions may still hold non-UTF-8 bytes; lossy keeps the
        // preview rendering instead of failing the whole request.
        let text = String::from_utf8_lossy(&bytes[..take]).to_string();
        return Ok(vec![DesktopMessage::ArtifactContent {
            session_id: owner_session_id,
            path: path.to_string(),
            filename,
            kind,
            text: Some(text),
            data_base64: None,
            truncated,
        }]);
    }

    match meta {
        Ok(m) if m.len() as usize <= BINARY_CAP => {
            use base64::Engine as _;
            let read_path = path.to_string();
            let data_base64 = blocking_read(move || -> Result<String, String> {
                let bytes =
                    std::fs::read(&read_path).map_err(|e| format!("failed to read artifact: {e}"))?;
                Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
            })
            .map_err(|_| "artifact read panicked".to_string())??;
            Ok(vec![DesktopMessage::ArtifactContent {
                session_id: owner_session_id,
                path: path.to_string(),
                filename,
                kind,
                text: None,
                data_base64: Some(data_base64),
                truncated: false,
            }])
        }
        Ok(m) => Err(format!(
            "artifact too large for preview ({} MB) — save it from the desktop",
            m.len() / (1024 * 1024)
        )),
        Err(e) => Err(format!("artifact unreadable: {e}")),
    }
}

fn handle_resolve_plan_proposal(
    app: &AppHandle,
    pending_id: String,
    approved: bool,
    feedback: Option<String>,
) -> Result<Vec<DesktopMessage>, String> {
    // Same core the desktop plan card uses: takes the pending approval and
    // resumes the paused loop; `approved: false` + feedback routes the
    // revision request back to the model.
    crate::chat::commands::resolve_plan_proposal(
        pending_id,
        approved,
        feedback,
        app.state::<crate::ChatState>(),
        app.state::<crate::chat::plan::PlanState>(),
    )
    .map_err(|e| e.to_string())?;
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Chat-core parity (Batch 1): message actions, checkpoints, permission mode,
// compaction. Every mutation is gated on the message/checkpoint actually
// belonging to the calling session's chat row — a phone that knows one
// session id cannot reach another chat's messages.
// ---------------------------------------------------------------------------

/// Resolve the caller's chat row and assert `message_id` belongs to it.
/// Returns (chat_session_id, role).
fn resolve_owned_message(
    conn: &Connection,
    owner_session_id: &str,
    message_id: i64,
) -> Result<(String, String), String> {
    let chat_session_id = require_chat_id(conn, owner_session_id)?;
    let role: String = conn
        .query_row(
            "SELECT role FROM chat_messages WHERE id = ?1 AND chat_session_id = ?2",
            rusqlite::params![message_id, chat_session_id],
            |r| r.get(0),
        )
        .map_err(|_| "message not found in this session".to_string())?;
    Ok((chat_session_id, role))
}

fn handle_delete_chat_message(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    message_id: i64,
) -> Result<Vec<DesktopMessage>, String> {
    {
        let conn = db.lock();
        resolve_owned_message(&conn, &owner_session_id, message_id)?;
        db::delete_chat_message(&conn, message_id).map_err(|e| e.to_string())?;
    }
    let mut out = vec![DesktopMessage::SessionMessageDeleted {
        session_id: owner_session_id.clone(),
        message_id,
    }];
    // Fresh first page so the phone's list converges without a manual pull.
    out.extend(handle_get_session_messages(db, owner_session_id, None, 50)?);
    Ok(out)
}

/// True when the chat is mid-turn (a builtin provider stream OR a harness/
/// ACP turn in the agent-session runtime). Shared by the checkpoint-restore,
/// edit, and regenerate gates.
fn chat_turn_busy(app: &AppHandle, chat_session_id: &str) -> bool {
    app.try_state::<crate::ChatState>()
        .map(|c| c.0.has_active_stream(chat_session_id))
        .unwrap_or(false)
        || app
            .try_state::<crate::agent_sessions::AgentSessionState>()
            .map(|a| a.0.is_turn_in_flight(chat_session_id))
            .unwrap_or(false)
}

fn handle_edit_user_message(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<chat::ChatManager>,
    owner_session_id: String,
    message_id: i64,
    text: String,
) -> Result<Vec<DesktopMessage>, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("edited message must not be empty".to_string());
    }
    let (chat_session_id, role) = {
        let conn = db.lock();
        resolve_owned_message(&conn, &owner_session_id, message_id)?
    };
    if role != "user" {
        return Err("only user messages can be edited".to_string());
    }
    // Same turn-idle gate the desktop edit has (and the restore gate below):
    // retiring the branch while a turn runs, then having the replacement
    // turn rejected, would leave the transcript truncated with no turn.
    if chat_turn_busy(app, &chat_session_id) {
        return Err("cannot edit while this session is running a turn — wait for it to finish or cancel it first".into());
    }
    {
        let conn = db.lock();
        // Retire this message and every later row — the old branch stops
        // being model context (desktop edit-to-fork semantics).
        db::mark_branch_superseded(&conn, &chat_session_id, message_id)
            .map_err(|e| e.to_string())?;
    }
    // The edited text continues as a fresh turn on the new branch. If the
    // send fails after the supersede, restore the branch — a rejected turn
    // (missing key, no usable auto provider) must not strand the transcript.
    let sent = handle_send_chat_message(app, db, chat_mgr, owner_session_id, trimmed, Vec::new());
    if sent.is_err() {
        let conn = db.lock();
        if let Err(e) = db::un_mark_branch_superseded(&conn, &chat_session_id, message_id) {
            crate::relay_eprintln!("[mobile-relay] failed to restore superseded branch after failed edit: {e}");
        }
    }
    sent
}

fn handle_regenerate_message(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    chat_mgr: &Arc<chat::ChatManager>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let (chat_session_id, last_user_id, last_user) = {
        let conn = db.lock();
        let chat_session_id = require_chat_id(&conn, &owner_session_id)?;
        // Same turn-idle gate as edit (above).
        if chat_turn_busy(app, &chat_session_id) {
            return Err("cannot regenerate while this session is running a turn — wait for it to finish or cancel it first".into());
        }
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, content FROM chat_messages
                 WHERE chat_session_id = ?1 AND role = 'user' AND superseded_by IS NULL
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![chat_session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let row = row.ok_or_else(|| "no user message to regenerate".to_string())?;
        db::mark_branch_superseded(&conn, &chat_session_id, row.0)
            .map_err(|e| e.to_string())?;
        (chat_session_id, row.0, row.1)
    };
    let sent = handle_send_chat_message(app, db, chat_mgr, owner_session_id, last_user, Vec::new());
    if sent.is_err() {
        let conn = db.lock();
        if let Err(e) = db::un_mark_branch_superseded(&conn, &chat_session_id, last_user_id) {
            crate::relay_eprintln!("[mobile-relay] failed to restore superseded branch after failed regenerate: {e}");
        }
    }
    sent
}

fn handle_list_chat_checkpoints(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let conn = db.lock();
    let chat_session_id = require_chat_id(&conn, &owner_session_id)?;
    let checkpoints = db::list_chat_checkpoints(&conn, &chat_session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| super::protocol::ChatCheckpointInfo {
            id: c.id,
            message_id: c.message_id,
            files: c
                .files
                .into_iter()
                .map(|f| super::protocol::CheckpointFileInfo {
                    path: f.path,
                    status: f.status,
                })
                .collect(),
            created_at: c.created_at,
        })
        .collect();
    Ok(vec![DesktopMessage::ChatCheckpoints {
        session_id: owner_session_id,
        checkpoints,
    }])
}

fn handle_restore_chat_checkpoint(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    checkpoint_id: i64,
    rollback_messages: Option<bool>,
) -> Result<Vec<DesktopMessage>, String> {
    // Ownership: the checkpoint must belong to this chat (never restore
    // another session's snapshot from a guessed id).
    let chat_session_id = {
        let conn = db.lock();
        require_chat_id(&conn, &owner_session_id)?
    };
    {
        let conn = db.lock();
        let owner: String = conn
            .query_row(
                "SELECT chat_session_id FROM chat_checkpoints WHERE id = ?1",
                rusqlite::params![checkpoint_id],
                |r| r.get(0),
            )
            .map_err(|_| "checkpoint not found".to_string())?;
        if owner != chat_session_id {
            return Err("checkpoint not found in this session".to_string());
        }
    }
    // Same turn-idle gate the desktop restore has (shared with edit /
    // regenerate via chat_turn_busy).
    // The busy gate must key on the RESOLVED chat id — the owner id can be a
    // legacy mapping, and checking the wrong key let restores through a live turn.
    if chat_turn_busy(app, &chat_session_id) {
        return Err("cannot restore a checkpoint while this session is running a turn — wait for it to finish or cancel it first".into());
    }
    let db_handle = Arc::clone(db);
    let app_owned = app.clone();
    let result = blocking_read(move || {
        crate::checkpoints::restore(
            &app_owned,
            &db_handle,
            checkpoint_id,
            rollback_messages.unwrap_or(false),
        )
    })
    .map_err(|e| e.to_string())??;
    let mut out = vec![DesktopMessage::SessionCheckpointRestored {
        session_id: owner_session_id.clone(),
        checkpoint_id,
        deleted_messages: result.deleted_messages,
    }];
    out.extend(handle_get_session_messages(db, owner_session_id, None, 50)?);
    Ok(out)
}

fn handle_set_session_permission_mode(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    mode: String,
) -> Result<Vec<DesktopMessage>, String> {
    const MODES: [&str; 5] = ["plan", "read_only", "manual", "auto_edit", "full_auto"];
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("unknown permission mode: {mode}"));
    }
    {
        let conn = db.lock();
        let chat_session_id = require_chat_id(&conn, &owner_session_id)?;
        db::update_chat_session_permission_mode(&conn, &chat_session_id, &mode)
            .map_err(|e| e.to_string())?;
    }
    Ok(vec![DesktopMessage::SessionPermissionModeSet {
        session_id: owner_session_id,
        mode,
    }])
}

pub(super) async fn handle_compact_session(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let chat_session_id = {
        let conn = db.lock();
        require_chat_id(&conn, &owner_session_id)?
    };
    // The desktop's own /compact command — same summarizer, same thresholds.
    // No composer tool toggles on this surface: the defaults (tools on, code
    // exec off) match the desktop's default tool posture.
    crate::chat::commands::selection::chat_compact_now(
        chat_session_id,
        None,
        None,
        app.state::<crate::ChatState>(),
        app.state::<crate::chat::local_models::LocalModelState>(),
        app.state::<crate::DbState>(),
        app.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(vec![DesktopMessage::SessionCompacted {
        session_id: owner_session_id,
    }])
}

pub(super) fn handle_search_chat_messages(
    db: &Arc<Mutex<Connection>>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<DesktopMessage>, String> {
    let conn = db.lock();
    let results = db::search_chat_messages(&conn, &query, limit.unwrap_or(50))
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| super::protocol::ChatSearchHit {
            chat_session_id: r.chat_session_id,
            session_title: r.session_title,
            message_id: r.message_id,
            snippet: r.snippet,
            role: r.role,
            created_at: r.created_at,
        })
        .collect();
    Ok(vec![DesktopMessage::ChatSearchResults { query, results }])
}
