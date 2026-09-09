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
use super::relay_owner::SessionChatOwnerPayload;

/// Ensure the `owner_session_id` column exists on `chat_sessions`.
/// Called lazily from fetch_page / handle — safe to call multiple times.
pub fn ensure_chat_session_owner_column(conn: &Connection) -> Result<(), String> {
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

/// Fetch a page of session-scoped chat messages for history pagination.
/// Returns (records, has_more) where `has_more` indicates another page exists.
pub fn fetch_page(
    db: &Connection,
    owner_session_id: &str,
    before_id: Option<i64>,
    limit: u32,
) -> Result<(Vec<SessionMessageRecord>, bool), String> {
    ensure_chat_session_owner_column(db)?;

    // Resolve the chat_session_id from owner_session_id.
    let chat_session_id: Option<String> = db
        .query_row(
            "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
            rusqlite::params![owner_session_id],
            |r| r.get(0),
        )
        .ok();

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
            "SELECT id, role, content, created_at, input_tokens, output_tokens, cost_usd
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
                    started_at: None,
                    completed_at: None,
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
    // Note: SessionMessageRecord has tool_calls (Option<Value>) and artifact_paths (Option<Vec<String>>),
    // while ChatMessageRecord does not. These are left as None for now — Task 4 will populate them.
    let session_records: Vec<SessionMessageRecord> = records
        .into_iter()
        .map(|r| SessionMessageRecord {
            id: r.id,
            role: r.role,
            content: r.content,
            created_at: r.created_at,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cost_usd: r.cost_usd,
            tool_calls: None,
            artifact_paths: None,
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
                handle_cancel_session_stream(&chat_mgr, &db, session_id)
            }

            MobileMessage::ResolveSessionApproval {
                session_id: _,
                pending_id,
                decision,
                always_allow,
            } => handle_resolve_session_approval(
                &app,
                &db,
                &chat_mgr,
                pending_id,
                decision,
                always_allow,
            ),

            MobileMessage::RenameSession { session_id, title } => {
                handle_rename_session(&db, session_id, title)
            }

            MobileMessage::SetSessionModel {
                session_id,
                provider_id,
                model,
            } => handle_set_session_model(&db, session_id, provider_id, model),

            MobileMessage::DeleteChatSession { session_id } => {
                handle_delete_chat_session(&db, session_id)
            }

            MobileMessage::GetSessionMeta { session_id } => {
                handle_get_session_meta(&db, session_id)
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
    let (messages, has_more) = fetch_page(&conn, &owner_session_id, before_id, limit)?;
    Ok(vec![DesktopMessage::SessionMessages {
        session_id: owner_session_id,
        messages,
        has_more,
    }])
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
    let (chat_session_id, provider_str, model, sandbox_policy, approval_policy) = {
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
        )
    };
    let sandbox = crate::chat::permission::SandboxPolicy::from_db(&sandbox_policy);
    let approval = crate::chat::permission::ApprovalPolicy::from_db(&approval_policy);

    // 2. Resolve provider + credentials exactly like the desktop
    //    send_chat_message command. local_gguf is keyless; everything else
    //    reads the real key from the keychain. An Auto-routed session
    //    (provider "auto") resolves synchronously here — the WS dispatch is
    //    sync, so no live /v1/models fetch: first keyed provider (static
    //    preference order) that the health store hasn't excluded, with its
    //    persisted default model (the desktop composer path runs the full
    //    context-aware resolver and writes the pick back for stickiness).
    let (provider_str, model_str) = if provider_str == "auto" {
        let picked: Option<(String, String)> = {
            let conn = db.lock();
            let now = db::now_ts();
            let mut chosen: Option<(String, String)> = None;
            for p in crate::chat::auto_router::AUTO_PROVIDERS {
                if !crate::secrets::has_chat_api_key(&conn, p) {
                    continue;
                }
                if crate::chat::model_health::provider_excluded(&conn, p, now).is_some() {
                    continue;
                }
                let default_model = db::get_setting(&conn, &format!("chat.{p}.model"))
                    .ok()
                    .flatten()
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| {
                        let pid = crate::chat::commands::parse_provider_id(p);
                        crate::chat::streaming::resolve_provider(&pid.unwrap())
                            .default_model()
                            .to_string()
                    });
                chosen = Some((p.to_string(), default_model));
                break;
            }
            chosen
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
    let provider_id = match provider_str.as_str() {
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

    // 2. Process attachments exactly like the desktop composer: images become
    //    vision content on the live turn (+ a placeholder in the body text),
    //    docs are base64-decoded and run through doc_to_text then inlined as
    //    fenced blocks, text is inlined verbatim. The (extra_text, images)
    //    pair mirrors the desktop send_chat_message path so the chat pipeline
    //    receives the same shape regardless of which client sent the turn.
    let attachments_input: Vec<crate::types::ChatAttachmentInput> = attachments
        .into_iter()
        .map(|a| crate::types::ChatAttachmentInput {
            name: a.name,
            kind: a.kind,
            text: a.text,
            data: a.data,
            media_type: a.media_type,
            format: a.format,
        })
        .collect();
    let (extra_text, images) = crate::chat::commands::process_attachments(&attachments_input);
    let content = format!("{text}{extra_text}");

    // 3. Persist the user message (with attachment-derived text inlined so the
    //    history matches what the model actually saw).
    {
        let conn = db.lock();
        db::add_chat_message(
            &conn,
            db::NewChatMessage {
                chat_session_id: &chat_session_id,
                role: "user",
                content: &content,
                ..Default::default()
            },
        )
        .map_err(|e| format!("failed to persist user message: {e}"))?;
        db::touch_chat_session(&conn, &chat_session_id)
            .map_err(|e| format!("failed to touch chat session: {e}"))?;
    }

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

    // 5. If this turn carries vision images, attach them to the final user
    //    message so the live request includes them. History rows loaded above
    //    never carry images (they're DB text only); only the live turn gets
    //    the image vec.
    if !images.is_empty() {
        if let Some(last) = messages.last_mut() {
            last.images = images.clone();
        }
    }

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
        Vec::new(),
        Vec::new(),
        Vec::new(),
        None,
        messages,
        Arc::clone(db),
        app.clone(),
        false,
        None,
        // Mobile turns have no fail-over chain (the desktop composer runs
        // the full resolver) and no system-prompt rebuild inputs.
        Vec::new(),
        None,
    );

    // 7. Tell the React side which chat_session_id maps to this owner_session_id,
    //    so the re-broadcast in useChatEvents.ts can route streaming events back
    //    to the right phone via the owner map. Without this, getOwnerSessionId()
    //    always returns undefined and the re-broadcast is a no-op.
    let _ = app.emit(
        "mobile:session_chat_owner",
        SessionChatOwnerPayload {
            chat_session_id: chat_session_id.clone(),
            owner_session_id: owner_session_id.clone(),
        },
    );

    Ok(vec![])
}

fn handle_cancel_session_stream(
    chat_mgr: &Arc<chat::ChatManager>,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    // Streams are keyed by the INTERNAL chat_session_id (the id passed to
    // ChatManager::send), so resolve it from the phone's owner_session_id
    // first — cancelling by owner_session_id was a silent no-op that left
    // the stream running (and billing) while the phone was told it stopped.
    let chat_session_id = {
        let conn = db.lock();
        ensure_chat_session_owner_column(&conn)?;
        conn.query_row(
            "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
            rusqlite::params![owner_session_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    if let Some(id) = chat_session_id {
        chat_mgr.cancel(&id);
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
    app: &AppHandle,
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
    let chat_session_id = pending.chat_session_id.clone();

    if approved && always_allow && ALWAYS_ALLOWABLE_TOOLS.contains(&tool.as_str()) {
        let conn = db.lock();
        // The rules live in app_settings as a JSON array (same store the
        // desktop settings UI writes). An empty pattern matches every path —
        // still scope-gated by the dispatcher's fs_roots containment, so this
        // can never widen writes outside the granted roots.
        let mut rules: Vec<serde_json::Value> = db::get_setting(&conn, "permissions.rules")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        rules.push(serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "tool": tool,
            "pattern": "",
            "createdAt": db::now_ts(),
        }));
        let serialized = serde_json::to_string(&rules)
            .map_err(|e| format!("failed to serialize approval rules: {e}"))?;
        let _ = db::set_setting(&conn, "permissions.rules", &serialized);
    }

    // Deliver the decision via the oneshot channel. A send error means the
    // loop already ended (stream cancelled) — ignore it.
    let _ = pending.response_tx.send(approved);

    // Notify the owning phone (if any) that the card is dead — the approval
    // may have been resolved on the DESKTOP, or on a different phone
    // connection, and a stale approval card would otherwise sit there
    // forever. Rides the same `mobile:session_chat_event` channel the React
    // re-broadcast uses; the relay's listener routes it by owner_session_id.
    let owner_session_id: Option<String> = {
        let conn = db.lock();
        ensure_chat_session_owner_column(&conn).ok();
        conn.query_row(
            "SELECT owner_session_id FROM chat_sessions WHERE id = ?1 AND owner_session_id IS NOT NULL",
            rusqlite::params![chat_session_id],
            |r| r.get(0),
        )
        .ok()
    };
    if let Some(owner) = owner_session_id {
        let _ = app.emit(
            "mobile:session_chat_event",
            serde_json::json!({
                "session_id": owner,
                "kind": "approval-resolved",
                "payload": { "pendingId": pending_id },
            }),
        );
    }

    Ok(vec![])
}

fn handle_rename_session(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    title: String,
) -> Result<Vec<DesktopMessage>, String> {
    let chat_session_id = {
        let conn = db.lock();
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
                rusqlite::params![&owner_session_id],
                |r| r.get(0),
            )
            .ok();
        id.ok_or_else(|| format!("session not found: {owner_session_id}"))?
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
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    provider_id: String,
    model: String,
) -> Result<Vec<DesktopMessage>, String> {
    if !KNOWN_PROVIDERS.contains(&provider_id.as_str()) {
        return Err(format!("unknown provider: {provider_id}"));
    }
    if model.trim().is_empty() {
        return Err("model must not be empty".to_string());
    }
    let chat_session_id = {
        let conn = db.lock();
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
                rusqlite::params![&owner_session_id],
                |r| r.get(0),
            )
            .ok();
        id.ok_or_else(|| format!("session not found: {owner_session_id}"))?
    };
    {
        let conn = db.lock();
        db::update_chat_session_provider(&conn, &chat_session_id, &provider_id)
            .map_err(|e| format!("failed to set provider: {e}"))?;
        db::update_chat_session_model(&conn, &chat_session_id, &model)
            .map_err(|e| format!("failed to set model: {e}"))?;
    }
    Ok(vec![DesktopMessage::SessionModelSet {
        session_id: owner_session_id,
        provider_id,
        model,
    }])
}

fn handle_delete_chat_session(
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
) -> Result<Vec<DesktopMessage>, String> {
    let chat_session_id = {
        let conn = db.lock();
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
                rusqlite::params![&owner_session_id],
                |r| r.get(0),
            )
            .ok();
        id.ok_or_else(|| format!("session not found: {owner_session_id}"))?
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
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
            rusqlite::params![&owner_session_id],
            |r| r.get(0),
        )
        .ok();
    let Some(chat_session_id) = id else {
        // Session not created yet (no messages sent) — answer with defaults
        // so the phone's header can render without an error round-trip.
        return Ok(vec![DesktopMessage::SessionMeta {
            session_id: owner_session_id,
            provider: "auto".to_string(),
            model: String::new(),
            title: None,
        }]);
    };
    let row = db::get_chat_session(&conn, &chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat session row missing".to_string())?;
    Ok(vec![DesktopMessage::SessionMeta {
        session_id: owner_session_id,
        provider: row.provider,
        model: row.model,
        title: row.title,
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
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
            rusqlite::params![&owner_session_id],
            |r| r.get(0),
        )
        .ok();
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

fn handle_read_artifact(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    owner_session_id: String,
    path: &str,
) -> Result<Vec<DesktopMessage>, String> {
    // Containment first: the phone may only read files inside the desktop's
    // artifacts directory. Without this gate, any script that can send one
    // relay message gets an arbitrary-file-read primitive (the exact class of
    // hole PROJECT_AUDIT.md flags on the desktop's own artifact IPC).
    let root = crate::chat::dispatch::artifacts_dir(app);
    let granted = [root.to_string_lossy().to_string()];
    if !crate::chat::permission::path_within_scope(path, &granted) {
        return Err("artifact path is outside the artifacts directory".to_string());
    }
    // The artifact must also be one the session actually produced — a valid
    // path in the artifacts dir from a DIFFERENT session is still refused.
    let owns = {
        let conn = db.lock();
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM chat_sessions WHERE owner_session_id = ?1",
                rusqlite::params![&owner_session_id],
                |r| r.get(0),
            )
            .ok();
        match id {
            Some(chat_session_id) => db::list_artifacts_for_chat(&conn, &chat_session_id)
                .map(|rows| rows.iter().any(|r| r.path == path))
                .unwrap_or(false),
            None => false,
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
        let bytes = std::fs::read(path).map_err(|e| format!("failed to read artifact: {e}"))?;
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
            let bytes = std::fs::read(path).map_err(|e| format!("failed to read artifact: {e}"))?;
            Ok(vec![DesktopMessage::ArtifactContent {
                session_id: owner_session_id,
                path: path.to_string(),
                filename,
                kind,
                text: None,
                data_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
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
