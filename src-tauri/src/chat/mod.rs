//! Chat mode — direct LLM HTTP API streaming (separate from CLI agent panes).
//!
//! Four providers: Anthropic, OpenAI, AnthropicCompatible, OpenAICompatible.
//! All SSE streaming, API keys stored in the OS keychain, HTTP in Rust backend.

pub mod commands;
pub mod providers;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::types::*;
use providers::*;

/// Manages active chat streams. Each chat_session_id maps to a cancellation
/// token (tokio AbortHandle). Only one stream per session is allowed — sending
/// a new message cancels the previous one automatically.
pub struct ChatManager {
    pub client: reqwest::Client,
    streams: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl ChatManager {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            streams: Mutex::new(HashMap::new()),
        }
    }

    /// Send a chat message. Spawns a tokio task that:
    /// 1. Builds the provider HTTP request
    /// 2. Reads SSE chunks, emitting `chat:token` events
    /// 3. On completion, emits `chat:done` and persists the assistant message
    /// 4. On error, emits `chat:error`
    ///
    /// The user message is assumed already persisted by the caller (commands layer).
    /// Cancelling any existing stream for this session first.
    pub fn send(
        &self,
        chat_session_id: String,
        provider_id: ChatProviderId,
        model: String,
        api_key: String,
        base_url: Option<String>,
        effort: Option<String>,
        messages: Vec<ChatMessage>,
        db: Arc<Mutex<Connection>>,
        app: AppHandle,
    ) {
        // Cancel any existing stream for this session.
        self.cancel(&chat_session_id);

        let provider = resolve_provider(&provider_id);
        let chat_req = ChatRequest {
            model,
            messages,
            max_tokens: Some(4096),
            system: None,
            effort,
        };

        let client = self.client.clone();
        let sid = chat_session_id.clone();

        let handle = tokio::spawn(async move {
            let result = run_chat_stream(
                &client,
                provider.as_ref(),
                &sid,
                &chat_req,
                &api_key,
                base_url.as_deref(),
                &app,
            )
            .await;

            match result {
                Ok((full_response, usage)) => {
                    // Persist the assistant message with usage.
                    {
                        let conn = db.lock();
                        let _ = db::add_chat_message(
                            &conn,
                            &sid,
                            "assistant",
                            &full_response,
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.input_tokens)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.output_tokens)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.cost_usd)
                                } else {
                                    None
                                }
                            }),
                        );
                        let _ = db::touch_chat_session(&conn, &sid);
                    }
                    let _ = app.emit(
                        "chat:done",
                        ChatDonePayload {
                            chat_session_id: sid.clone(),
                            input_tokens: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.input_tokens)
                                } else {
                                    None
                                }
                            }),
                            output_tokens: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.output_tokens)
                                } else {
                                    None
                                }
                            }),
                            cost_usd: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.cost_usd)
                                } else {
                                    None
                                }
                            }),
                        },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "chat:error",
                        ChatErrorPayload {
                            chat_session_id: sid.clone(),
                            message: e,
                            code: None,
                        },
                    );
                }
            }
        });

        self.streams
            .lock()
            .insert(chat_session_id.clone(), handle.abort_handle());
    }

    /// Cancel an active stream for the given session (no-op if none active).
    pub fn cancel(&self, chat_session_id: &str) {
        if let Some(handle) = self.streams.lock().remove(chat_session_id) {
            handle.abort();
        }
    }

    /// App-exit cleanup: cancel all active streams.
    pub fn cancel_all(&self) {
        let handles: Vec<_> = self.streams.lock().drain().map(|(_, h)| h).collect();
        for handle in handles {
            handle.abort();
        }
    }
}

/// Runs the full SSE stream lifecycle for one chat request.
/// Returns the accumulated assistant text and optional usage info.
async fn run_chat_stream(
    client: &reqwest::Client,
    provider: &dyn ChatProvider,
    chat_session_id: &str,
    req: &ChatRequest,
    api_key: &str,
    base_url: Option<&str>,
    app: &AppHandle,
) -> Result<(String, Option<ChatUsage>), String> {
    let request = provider
        .build_request(client, req, api_key, base_url)
        .map_err(|e| format!("failed to build request: {e}"))?;

    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    use futures_util::StreamExt;

    let mut stream = response.bytes_stream();
    let mut buf = String::new(); // SSE buffer passed to provider parser
    let mut full_text = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);

        for line in text.lines() {
            match provider.parse_sse_chunk(line, &mut buf)? {
                (Some(token), false) => {
                    full_text.push_str(&token);
                    let _ = app.emit(
                        "chat:token",
                        ChatTokenPayload {
                            chat_session_id: chat_session_id.to_string(),
                            token,
                        },
                    );
                }
                (_, true) => {
                    // Stream done — usage will be parsed from buffer below.
                    break;
                }
                _ => {}
            }
        }
    }

    let usage = provider.parse_usage(&buf);
    Ok((full_text, usage))
}

fn resolve_provider(id: &ChatProviderId) -> Box<dyn ChatProvider> {
    use providers::*;
    match id {
        ChatProviderId::Anthropic => Box::new(AnthropicProvider),
        ChatProviderId::OpenAI => Box::new(OpenAIProvider),
        ChatProviderId::AnthropicCompatible => Box::new(AnthropicCompatibleProvider),
        ChatProviderId::OpenAICompatible => Box::new(OpenAICompatibleProvider),
    }
}
