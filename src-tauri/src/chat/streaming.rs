//! Streaming rounds and agentic tool loops for chat mode.
//!
//! Two provider families, each with a streaming round ([`openai_stream_round`]
//! / [`anthropic_stream_round`]) that emits text and reasoning live over SSE
//! and accumulates tool-call deltas, and a tool loop
//! ([`run_openai_tool_loop`] / [`run_anthropic_tool_loop`]) that feeds tool
//! results back to the model until it produces a final answer or the iteration
//! cap is hit. The OpenAI loop also recovers Hermes-format `<tool_calls>` text
//! emitted by aggregators that don't translate the `tools` field.
//!
//! Called by [`crate::chat::run_chat_stream`], which selects the loop based on
//! the provider family. Tool execution itself lives in [`crate::chat::dispatch`];
//! tool-call parsing and message serialization in [`crate::chat::proto`].

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::chat::{permission, tools, ChatManager};
use crate::chat::dispatch::{artifacts_dir, emit_token, run_tool};
use crate::chat::proto::{
    next_synthetic_tool_id, openai_message_json, anthropic_message_json, parse_hermes_tool_calls,
    parse_tool_args, strip_hermes_tool_calls, tool_block,
};
use crate::chat::providers::{ChatProvider, ChatProviderId, ChatRequest, ChatUsage,
    calculate_anthropic_cost, calculate_openai_cost};

/// Max model⇄tool round-trips in a single tool-enabled turn before we stop,
/// to bound cost and prevent runaway loops.
const MAX_TOOL_ITERS: usize = 45;

/// Higher iteration cap for research-mode turns, where a single research task
/// legitimately chains many tool calls (reset_source_ledger + 2-3 web_search +
/// 5-8 browser_read + 5-8 add_source_note + get_source_ledger + generate_file).
/// Only applied when `research_mode` is true; non-research turns stay at
/// MAX_TOOL_ITERS so everyday Q&A stays tightly bounded.
const RESEARCH_MAX_TOOL_ITERS: usize = 96;

/// Consecutive SSE JSON parse failures before treating the stream as stalled.
/// A single malformed line is normal (partial chunk); sustained failures mean
/// the provider's SSE format has diverged or data is irrecoverably corrupt.
const MAX_PARSE_FAILURES: u32 = 50;

async fn openai_stream_round(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    app: &AppHandle,
    sid: &str,
    full: &mut String,
) -> Result<(Value, i64, i64, bool), String> {
    use futures_util::StreamExt;

    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {b}"));
    }

    let mut stream = resp.bytes_stream();
    let mut pending = String::new();

    let mut content = String::new();
    let mut suppress = false;
    let mut in_think = false;
    // Per-index accumulation of (id, name, arguments).
    let mut calls: Vec<(String, String, String)> = Vec::new();
    let mut input = 0i64;
    let mut output = 0i64;
    let mut have_usage = false;
    let mut parse_failures: u32 = 0;

    'outer: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {e}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = pending.find('\n') {
            let line: String = pending.drain(..=nl).collect();
            let line = line.trim_end();
            let data = match line.strip_prefix("data: ") {
                Some(d) => d,
                None => continue,
            };
            if data == "[DONE]" {
                break 'outer;
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => {
                    parse_failures = 0;
                    v
                }
                Err(_) => {
                    parse_failures += 1;
                    if parse_failures >= MAX_PARSE_FAILURES {
                        return Err(format!(
                            "SSE parse stalled: {MAX_PARSE_FAILURES} consecutive JSON parse failures"
                        ));
                    }
                    continue;
                }
            };
            if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                input = u.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(input);
                output = u
                    .get("completion_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(output);
                have_usage = true;
            }
            let delta = match v.pointer("/choices/0/delta") {
                Some(d) => d,
                None => continue,
            };
            if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    if in_think {
                        emit_token(app, sid, "</think>", full);
                        in_think = false;
                    }
                    content.push_str(c);
                    if !suppress && content.contains("<tool_call") {
                        suppress = true;
                    }
                    if !suppress {
                        emit_token(app, sid, c, full);
                    }
                }
            }
            if let Some(r) = delta
                .get("reasoning_content")
                .and_then(|x| x.as_str())
                .or_else(|| delta.get("reasoning").and_then(|x| x.as_str()))
            {
                if !r.is_empty() {
                    if !in_think {
                        emit_token(app, sid, "<think>", full);
                        in_think = true;
                    }
                    emit_token(app, sid, r, full);
                }
            }
            if let Some(tcs) = delta.get("tool_calls").and_then(|x| x.as_array()) {
                for tc in tcs {
                    let idx = tc.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    while calls.len() <= idx {
                        calls.push((String::new(), String::new(), String::new()));
                    }
                    if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                        if !id.is_empty() {
                            calls[idx].0 = id.to_string();
                        }
                    }
                    if let Some(name) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                        if !name.is_empty() {
                            calls[idx].1 = name.to_string();
                        }
                    }
                    if let Some(a) = tc.pointer("/function/arguments").and_then(|x| x.as_str()) {
                        calls[idx].2.push_str(a);
                    }
                }
            }
        }
    }

    if in_think {
        emit_token(app, sid, "</think>", full);
    }

    let tool_calls: Vec<Value> = calls
        .into_iter()
        .filter(|(_, name, _)| !name.is_empty())
        .map(|(id, name, args)| {
            let id = if id.is_empty() {
                next_synthetic_tool_id()
            } else {
                id
            };
            json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": args },
            })
        })
        .collect();

    Ok((
        json!({ "role": "assistant", "content": content, "tool_calls": tool_calls }),
        input,
        output,
        have_usage,
    ))
}

/// One streaming round against an Anthropic `/v1/messages`.
///
/// Emits assistant text (and `thinking`, wrapped in `<think>…</think>`) live as
/// it streams, accumulates `tool_use` blocks (id/name/input), and returns the
/// reconstructed `content` block array plus `(input_tokens, output_tokens,
/// have_usage)`.
async fn anthropic_stream_round(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    app: &AppHandle,
    sid: &str,
    full: &mut String,
) -> Result<(Vec<Value>, i64, i64, bool), String> {
    use futures_util::StreamExt;

    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {b}"));
    }

    // Accumulated content blocks in stream order. kind: 0=text, 1=tool, 2=thinking.
    struct Blk {
        kind: u8,
        text: String,
        id: String,
        name: String,
        json: String,
    }
    let mut blocks: Vec<Blk> = Vec::new();
    let mut in_think = false;
    let mut input = 0i64;
    let mut output = 0i64;
    let mut have_usage = false;
    let mut parse_failures: u32 = 0;

    let mut stream = resp.bytes_stream();
    let mut pending = String::new();

    'outer: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream read error: {e}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = pending.find('\n') {
            let line: String = pending.drain(..=nl).collect();
            let line = line.trim_end();
            let data = match line.strip_prefix("data: ") {
                Some(d) => d,
                None => continue,
            };
            let p: Value = match serde_json::from_str(data) {
                Ok(v) => {
                    parse_failures = 0;
                    v
                }
                Err(_) => {
                    parse_failures += 1;
                    if parse_failures >= MAX_PARSE_FAILURES {
                        return Err(format!(
                            "SSE parse stalled: {MAX_PARSE_FAILURES} consecutive JSON parse failures"
                        ));
                    }
                    continue;
                }
            };
            match p.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "message_start" => {
                    if let Some(u) = p.pointer("/message/usage") {
                        input += u.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                        have_usage = true;
                    }
                }
                "content_block_start" => {
                    let idx = p.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    let cb = p.get("content_block");
                    let kind = match cb.and_then(|c| c.get("type")).and_then(|t| t.as_str()) {
                        Some("tool_use") => 1,
                        Some("thinking") => 2,
                        _ => 0,
                    };
                    let id = cb
                        .and_then(|c| c.get("id"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = cb
                        .and_then(|c| c.get("name"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    while blocks.len() <= idx {
                        blocks.push(Blk {
                            kind: 0,
                            text: String::new(),
                            id: String::new(),
                            name: String::new(),
                            json: String::new(),
                        });
                    }
                    blocks[idx].kind = kind;
                    blocks[idx].id = id;
                    blocks[idx].name = name;
                }
                "content_block_delta" => {
                    let idx = p.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    let delta = p.get("delta");
                    let dtype = delta
                        .and_then(|d| d.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    match dtype {
                        "text_delta" => {
                            if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|x| x.as_str()) {
                                if in_think {
                                    emit_token(app, sid, "</think>", full);
                                    in_think = false;
                                }
                                if let Some(b) = blocks.get_mut(idx) {
                                    b.text.push_str(t);
                                }
                                emit_token(app, sid, t, full);
                            }
                        }
                        "input_json_delta" => {
                            if let Some(j) =
                                delta.and_then(|d| d.get("partial_json")).and_then(|x| x.as_str())
                            {
                                if let Some(b) = blocks.get_mut(idx) {
                                    b.json.push_str(j);
                                }
                            }
                        }
                        "thinking_delta" => {
                            if let Some(t) =
                                delta.and_then(|d| d.get("thinking")).and_then(|x| x.as_str())
                            {
                                if !in_think {
                                    emit_token(app, sid, "<think>", full);
                                    in_think = true;
                                }
                                emit_token(app, sid, t, full);
                            }
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    if let Some(o) = p.pointer("/usage/output_tokens").and_then(|x| x.as_i64()) {
                        output = o;
                        have_usage = true;
                    }
                }
                "message_stop" => break 'outer,
                _ => {}
            }
        }
    }

    if in_think {
        emit_token(app, sid, "</think>", full);
    }

    let content: Vec<Value> = blocks
        .into_iter()
        .filter_map(|b| match b.kind {
            1 => {
                let input_val = serde_json::from_str::<Value>(&b.json).unwrap_or_else(|_| json!({}));
                Some(json!({ "type": "tool_use", "id": b.id, "name": b.name, "input": input_val }))
            }
            2 => None,
            _ if !b.text.is_empty() => Some(json!({ "type": "text", "text": b.text })),
            _ => None,
        })
        .collect();

    Ok((content, input, output, have_usage))
}

/// Agentic tool loop for OpenAI-style providers (native + compatible).
///
/// Uses streaming `/v1/chat/completions` calls: request with `tools`, stream
/// the assistant's text/reasoning live, and if the model emits `tool_calls`,
/// run each tool, feed the results back, and repeat until it produces a final
/// answer (or the iteration cap is hit). Each tool call is emitted as a
/// `<tool>` marker the UI shows as a collapsible card and strips from re-sent
/// history.
pub(crate) async fn run_openai_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    caps: &tools::ToolCaps,
    mode: permission::PermissionMode,
    mgr: &Arc<ChatManager>,
    sid: &str,
    app: &AppHandle,
    research_mode: bool,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/chat/completions");
    let tool_specs = tools::openai_tool_specs(caps, mode);
    let art_dir = artifacts_dir(app);
    let cap = if research_mode {
        RESEARCH_MAX_TOOL_ITERS
    } else {
        MAX_TOOL_ITERS
    };

    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        messages.push(openai_message_json(m));
    }

    let mut full = String::new();
    let mut total_in = 0i64;
    let mut total_out = 0i64;
    let mut have_usage = false;

    for _ in 0..cap {
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true },
            "tools": tool_specs,
        });
        if let Some(e) = &req.effort {
            body["reasoning_effort"] = json!(e);
        }

        let (message, in_tok, out_tok, have) =
            openai_stream_round(client, &url, api_key, &body, app, sid, &mut full).await?;
        total_in += in_tok;
        total_out += out_tok;
        have_usage = have_usage || have;

        let tool_calls = message
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        // Fallback for servers that don't translate the OpenAI `tools` field
        // into the model's native tool template (common on OpenAI-compatible
        // aggregators serving Qwen / DeepSeek / MiMo fine-tunes). The model
        // then emits its trained Hermes-format tool call as plain text in
        // `content`. Recover those calls and synthesize the same structured
        // shape the loop below already handles, so the tools actually run.
        let tool_calls: Vec<Value> = if tool_calls.is_empty() {
            let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
            match parse_hermes_tool_calls(content) {
                Some(parsed) if !parsed.is_empty() => parsed
                    .into_iter()
                    .map(|(name, args)| {
                        let id = next_synthetic_tool_id();
                        json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": args.to_string(),
                            },
                        })
                    })
                    .collect(),
                _ => Vec::new(),
            }
        } else {
            tool_calls
        };

        if !tool_calls.is_empty() {
            // The assistant turn (carrying tool_calls) must be echoed back
            // before the matching tool results. Some providers emit malformed
            // `arguments` (e.g. a stray `{}` prefix); we normalize them to clean
            // JSON here so the re-sent history doesn't confuse the model into
            // repeating the same call.
            let mut echoed = message.clone();
            // When the calls were recovered from Hermes text, the message's
            // `content` still holds the raw `<tool_calls>` markup. Strip it so
            // the markup is neither re-sent nor shown to the user downstream.
            if let Some(c) = echoed.get_mut("content").and_then(|c| c.as_str()) {
                let stripped = strip_hermes_tool_calls(c);
                if stripped != c {
                    if let Some(obj) = echoed.as_object_mut() {
                        obj.insert("content".to_string(), Value::String(stripped));
                    }
                }
            }
            if let Some(arr) = echoed
                .get_mut("tool_calls")
                .and_then(|t| t.as_array_mut())
            {
                for tc in arr.iter_mut() {
                    if let Some(a) = tc.get_mut("function").and_then(|f| f.get_mut("arguments")) {
                        let cleaned = a
                            .as_str()
                            .map(parse_tool_args)
                            .unwrap_or_else(|| json!({}));
                        *a = json!(cleaned.to_string());
                    }
                }
            }
            messages.push(echoed);
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
                let args = parse_tool_args(args_str);

                emit_token(app, sid, &tool_block(&name, &args), &mut full);
                let result = run_tool(client, &art_dir, caps, mode, mgr, app, sid, &name, &args).await;
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": result,
                }));
            }
            continue;
        }

        // No tool calls → final answer. The text was already streamed live in
        // `openai_stream_round` (Hermes markup, if any, was suppressed there).
        return Ok((full, build_usage(true, total_in, total_out, have_usage)));
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
pub(crate) async fn run_anthropic_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    caps: &tools::ToolCaps,
    mode: permission::PermissionMode,
    mgr: &Arc<ChatManager>,
    sid: &str,
    app: &AppHandle,
    research_mode: bool,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/messages");
    let tool_specs = tools::anthropic_tool_specs(caps, mode);
    let art_dir = artifacts_dir(app);
    let cap = if research_mode {
        RESEARCH_MAX_TOOL_ITERS
    } else {
        MAX_TOOL_ITERS
    };

    let mut messages: Vec<Value> = req
        .messages
        .iter()
        .map(anthropic_message_json)
        .collect();

    let mut full = String::new();
    let mut total_in = 0i64;
    let mut total_out = 0i64;
    let mut have_usage = false;

    for _ in 0..cap {
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens.unwrap_or(4096),
            "messages": messages,
            "tools": tool_specs,
            "stream": true,
        });
        if let Some(sys) = &req.system {
            if !sys.is_empty() {
                body["system"] = json!(sys);
            }
        }

        let (content, in_tok, out_tok, have) =
            anthropic_stream_round(client, &url, api_key, &body, app, sid, &mut full).await?;
        total_in += in_tok;
        total_out += out_tok;
        have_usage = have_usage || have;

        let tool_uses: Vec<&Value> = content
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
            .collect();

        if !tool_uses.is_empty() {
            // Echo the assistant turn (text + tool_use blocks) verbatim.
            messages.push(json!({ "role": "assistant", "content": content }));

            let mut results: Vec<Value> = Vec::new();
            for tu in &tool_uses {
                let id = tu.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = tu.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = tu.get("input").cloned().unwrap_or_else(|| json!({}));

                emit_token(app, sid, &tool_block(&name, &args), &mut full);
                let result = run_tool(client, &art_dir, caps, mode, mgr, app, sid, &name, &args).await;
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result,
                }));
            }
            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }

        // No tool use → final answer. Text blocks were already streamed live in
        // `anthropic_stream_round`.
        return Ok((full, build_usage(false, total_in, total_out, have_usage)));
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

pub(crate) fn resolve_provider(id: &ChatProviderId) -> Box<dyn ChatProvider> {
    use crate::chat::providers::{
        AnthropicCompatibleProvider, AnthropicProvider, LocalGgufProvider,
        OpenAICompatibleProvider, OpenAIProvider, OpenRouterProvider,
    };
    match id {
        ChatProviderId::Anthropic => Box::new(AnthropicProvider),
        ChatProviderId::OpenAI => Box::new(OpenAIProvider),
        ChatProviderId::AnthropicCompatible => Box::new(AnthropicCompatibleProvider),
        ChatProviderId::OpenAICompatible => Box::new(OpenAICompatibleProvider),
        ChatProviderId::OpenRouter => Box::new(OpenRouterProvider),
        ChatProviderId::LocalGguf => Box::new(LocalGgufProvider),
    }
}
