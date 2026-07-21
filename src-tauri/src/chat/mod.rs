//! Chat mode — direct LLM HTTP API streaming (separate from CLI agent panes).
//!
//! Four providers: Anthropic, OpenAI, AnthropicCompatible, OpenAICompatible.
//! All SSE streaming, API keys stored in the OS keychain, HTTP in Rust backend.

pub mod commands;
pub mod providers;
pub mod tools;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// Max model⇄tool round-trips in a single tool-enabled turn before we stop,
/// to bound cost and prevent runaway loops.
const MAX_TOOL_ITERS: usize = 6;

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
        tools_enabled: bool,
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

        let is_openai = matches!(
            provider_id,
            ChatProviderId::OpenAI | ChatProviderId::OpenAICompatible
        );
        let is_anthropic = matches!(
            provider_id,
            ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible
        );
        // Tools need a base URL; compatible providers already carry one, native
        // providers fall back to their default endpoint.
        let tool_base = base_url.clone().unwrap_or_else(|| {
            if is_openai {
                OpenAIProvider::DEFAULT_BASE.to_string()
            } else {
                AnthropicProvider::DEFAULT_BASE.to_string()
            }
        });

        let client = self.client.clone();
        let sid = chat_session_id.clone();

        let handle = tokio::spawn(async move {
            let result = if tools_enabled && is_openai {
                run_openai_tool_loop(&client, &tool_base, &api_key, &chat_req, &sid, &app).await
            } else if tools_enabled && is_anthropic {
                run_anthropic_tool_loop(&client, &tool_base, &api_key, &chat_req, &sid, &app).await
            } else {
                run_chat_stream(
                    &client,
                    provider.as_ref(),
                    &sid,
                    &chat_req,
                    &api_key,
                    base_url.as_deref(),
                    &app,
                )
                .await
            };

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
    let mut in_think = false;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);

        for line in text.lines() {
            match provider.parse_sse_chunk(line, &mut buf)? {
                (Some(token), false) => {
                    // Reasoning tokens are sentinel-prefixed by the parser;
                    // wrap contiguous runs in <think>…</think> so the UI can
                    // render a collapsible thinking block.
                    let mut out = String::new();
                    if let Some(reasoning) = token.strip_prefix(REASONING_PREFIX) {
                        if !in_think {
                            out.push_str("<think>");
                            in_think = true;
                        }
                        out.push_str(reasoning);
                    } else {
                        if in_think {
                            out.push_str("</think>");
                            in_think = false;
                        }
                        out.push_str(&token);
                    }
                    full_text.push_str(&out);
                    let _ = app.emit(
                        "chat:token",
                        ChatTokenPayload {
                            chat_session_id: chat_session_id.to_string(),
                            token: out,
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

    if in_think {
        full_text.push_str("</think>");
        let _ = app.emit(
            "chat:token",
            ChatTokenPayload {
                chat_session_id: chat_session_id.to_string(),
                token: "</think>".to_string(),
            },
        );
    }

    let usage = provider.parse_usage(&buf);
    Ok((full_text, usage))
}

/// Emit one `chat:token` event and append it to the running transcript so the
/// persisted assistant message ends up identical to what was streamed.
fn emit_token(app: &AppHandle, sid: &str, token: &str, full: &mut String) {
    if token.is_empty() {
        return;
    }
    full.push_str(token);
    let _ = app.emit(
        "chat:token",
        ChatTokenPayload {
            chat_session_id: sid.to_string(),
            token: token.to_string(),
        },
    );
}

/// Human-readable narration of a tool call, shown (inside the `<think>` block)
/// while the tool runs.
fn tool_status_line(name: &str, args: &Value) -> String {
    if name == tools::WEB_SEARCH {
        let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        format!("Searching the web for \"{q}\"…\n")
    } else {
        format!("Running tool {name}…\n")
    }
}

/// Agentic tool loop for OpenAI-style providers (native + compatible).
///
/// Uses non-streaming `/v1/chat/completions` calls: request with `tools`, and
/// if the model responds with `tool_calls`, run each tool, feed the results
/// back, and repeat until it produces a final answer (or the iteration cap is
/// hit). Tool narration is wrapped in a `<think>` block so the UI shows it as a
/// collapsible "thought process" and it's stripped from re-sent history.
async fn run_openai_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    sid: &str,
    app: &AppHandle,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/chat/completions");
    let tool_specs = tools::openai_tool_specs();

    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }

    let mut full = String::new();
    let mut in_think = false;
    let mut total_in = 0i64;
    let mut total_out = 0i64;
    let mut have_usage = false;

    for _ in 0..MAX_TOOL_ITERS {
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": false,
            "tools": tool_specs,
        });
        if let Some(e) = &req.effort {
            body["reasoning_effort"] = json!(e);
        }

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {b}"));
        }

        let v: Value = resp.json().await.map_err(|e| format!("decode failed: {e}"))?;
        if let Some(u) = v.get("usage") {
            total_in += u.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            total_out += u.get("completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            have_usage = true;
        }

        let message = v
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .cloned()
            .ok_or_else(|| "response missing choices[0].message".to_string())?;

        let tool_calls = message
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        if !tool_calls.is_empty() {
            if !in_think {
                emit_token(app, sid, "<think>", &mut full);
                in_think = true;
            }
            // The assistant turn (carrying tool_calls) must be echoed back
            // verbatim before the matching tool results.
            messages.push(message.clone());
            for tc in &tool_calls {
                let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_str = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("{}");
                let args: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));

                emit_token(app, sid, &tool_status_line(&name, &args), &mut full);
                let result = tools::execute_tool(client, &name, &args).await;
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": result,
                }));
            }
            continue;
        }

        // No tool calls → final answer.
        if in_think {
            emit_token(app, sid, "</think>", &mut full);
        }
        let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
        emit_token(app, sid, content, &mut full);
        return Ok((full, build_usage(true, total_in, total_out, have_usage)));
    }

    if in_think {
        emit_token(app, sid, "</think>", &mut full);
    }
    emit_token(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(true, total_in, total_out, have_usage)))
}

/// Agentic tool loop for Anthropic-style providers (native + compatible).
async fn run_anthropic_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    sid: &str,
    app: &AppHandle,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/messages");
    let tool_specs = tools::anthropic_tool_specs();

    let mut messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut full = String::new();
    let mut in_think = false;
    let mut total_in = 0i64;
    let mut total_out = 0i64;
    let mut have_usage = false;

    for _ in 0..MAX_TOOL_ITERS {
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens.unwrap_or(4096),
            "messages": messages,
            "tools": tool_specs,
            "stream": false,
        });
        if let Some(sys) = &req.system {
            if !sys.is_empty() {
                body["system"] = json!(sys);
            }
        }

        let resp = client
            .post(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {b}"));
        }

        let v: Value = resp.json().await.map_err(|e| format!("decode failed: {e}"))?;
        if let Some(u) = v.get("usage") {
            total_in += u.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            total_out += u.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            have_usage = true;
        }

        let content = v
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let tool_uses: Vec<&Value> = content
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
            .collect();

        if !tool_uses.is_empty() {
            if !in_think {
                emit_token(app, sid, "<think>", &mut full);
                in_think = true;
            }
            // Echo the assistant turn (text + tool_use blocks) verbatim.
            messages.push(json!({ "role": "assistant", "content": content }));

            let mut results: Vec<Value> = Vec::new();
            for tu in &tool_uses {
                let id = tu.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = tu.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = tu.get("input").cloned().unwrap_or_else(|| json!({}));

                emit_token(app, sid, &tool_status_line(&name, &args), &mut full);
                let result = tools::execute_tool(client, &name, &args).await;
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result,
                }));
            }
            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }

        // No tool use → final answer: concatenate text blocks.
        if in_think {
            emit_token(app, sid, "</think>", &mut full);
        }
        let text: String = content
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");
        emit_token(app, sid, &text, &mut full);
        return Ok((full, build_usage(false, total_in, total_out, have_usage)));
    }

    if in_think {
        emit_token(app, sid, "</think>", &mut full);
    }
    emit_token(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(false, total_in, total_out, have_usage)))
}

/// Build a `ChatUsage` summing across all tool-loop round-trips, picking the
/// provider's cost model.
fn build_usage(openai: bool, input: i64, output: i64, have: bool) -> Option<ChatUsage> {
    if !have {
        return None;
    }
    let cost = if openai {
        calculate_openai_cost(input, output)
    } else {
        calculate_anthropic_cost(input, output)
    };
    Some(ChatUsage {
        input_tokens: input,
        output_tokens: output,
        cost_usd: cost,
    })
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
