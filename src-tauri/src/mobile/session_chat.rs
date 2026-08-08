//! Session-scoped chat manager (history + dispatch).
//!
//! Handles mobile companion app session-scoped chat:
//! - History pagination (`fetch_page`)
//! - Message dispatch (`handle`) that routes through ChatManager

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::chat;
use crate::db;
use crate::types::ChatMessageRecord;

use super::protocol::{
    ChatAttachment, DesktopMessage, MobileMessage, SessionMessageRecord,
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
        let cs = db::create_chat_session(conn, provider, model)
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

    // Fetch limit+1 rows to detect if there's more.
    let limit_plus_one = (limit + 1) as i64;
    let mut stmt = db.prepare(
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
            } => handle_resolve_session_approval(&chat_mgr, pending_id, decision),

            MobileMessage::RenameSession { session_id, title } => {
                handle_rename_session(&db, session_id, title)
            }

            // Other variants are not session-scoped chat and are handled by the relay.
            _ => Err(format!("message not handled by SessionChatManager: {:?}", msg)),
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
    _attachments: Vec<ChatAttachment>,
) -> Result<Vec<DesktopMessage>, String> {
    // 1. Look up (or create) a chat_session row keyed by owner_session_id,
    //    then read back its provider/model. The phone has no provider picker;
    //    the row is the source of truth (switch on the desktop and the next
    //    mobile turn picks it up). Previously this hardcoded Anthropic +
    //    the literal key "no-key" — every turn 401'd even with a real key
    //    configured, and non-Anthropic sessions were ignored entirely.
    let (chat_session_id, provider_str, model) = {
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
        (id, row.provider, row.model)
    };

    // 2. Resolve provider + credentials exactly like the desktop
    //    send_chat_message command. local_gguf is keyless; everything else
    //    reads the real key from the keychain.
    let provider_id = match provider_str.as_str() {
        "anthropic" => crate::chat::providers::ChatProviderId::Anthropic,
        "openai" => crate::chat::providers::ChatProviderId::OpenAI,
        "anthropic_compatible" => crate::chat::providers::ChatProviderId::AnthropicCompatible,
        "openai_compatible" => crate::chat::providers::ChatProviderId::OpenAICompatible,
        "openrouter" => crate::chat::providers::ChatProviderId::OpenRouter,
        "local_gguf" => crate::chat::providers::ChatProviderId::LocalGguf,
        other => return Err(format!("unknown provider: {other}")),
    };
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

    // 2. Persist the user message. Attachments are not yet processed for the
    //    mobile path (the desktop composer formats them inline + adds vision
    //    images to the live turn; that work belongs to a later task). For
    //    now we persist the text verbatim and leave the attachment
    //    parameter as future-work so the chat pipeline receives the same
    //    shape the desktop sends.
    {
        let conn = db.lock();
        db::add_chat_message(&conn, &chat_session_id, "user", &text, None, None, None, None, None, None, None, None, None)
            .map_err(|e| format!("failed to persist user message: {e}"))?;
        db::touch_chat_session(&conn, &chat_session_id)
            .map_err(|e| format!("failed to touch chat session: {e}"))?;
    }

    // 3. Load the conversation history from the DB so the model sees the
    //    whole session (previously an empty Vec was passed — the model
    //    received a blank conversation every turn). Mirrors the desktop
    //    history selection: compacted-active rows for local models.
    let messages: Vec<crate::chat::providers::ChatMessage> = {
        let conn = db.lock();
        let records = if matches!(provider_id, crate::chat::providers::ChatProviderId::LocalGguf) {
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

    // 4. Hand off to the chat pipeline. `ChatManager::send` cancels any
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
        crate::chat::permission::PermissionMode::FullAuto,
        Vec::new(),
        Vec::new(),
        None,
        messages,
        Arc::clone(db),
        app.clone(),
        false,
        None,
    );

    // 5. Tell the React side which chat_session_id maps to this owner_session_id,
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

fn handle_resolve_session_approval(
    chat_mgr: &Arc<chat::ChatManager>,
    pending_id: String,
    decision: String,
) -> Result<Vec<DesktopMessage>, String> {
    let approved = match decision.as_str() {
        "approve" | "approved" | "yes" => true,
        "deny" | "denied" | "no" => false,
        _ => return Err(format!("invalid decision: {decision}")),
    };

    let pending = chat_mgr.take_pending_approval(&pending_id)
        .ok_or_else(|| format!("unknown pending approval id: {pending_id}"))?;

    // Deliver the decision via the oneshot channel. A send error means the
    // loop already ended (stream cancelled) — ignore it.
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