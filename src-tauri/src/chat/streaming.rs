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

/// Upper bound on tool-call / content-block indexes accepted from the wire.
/// The index is network-controlled (OpenAI/Anthropic-compatible base URLs are
/// user-configurable, hence untrusted): without a cap, a hostile or buggy
/// endpoint can send `"index": 4294967295` and make the grow-loops below
/// allocate billions of entries — instant memory exhaustion mid-turn. Real
/// rounds use a handful of blocks; 64 is generous.
const MAX_STREAM_BLOCK_INDEX: usize = 64;

/// Token usage parsed from one streaming round, including the v2 detail
/// fields (cache + reasoning) the cost model bills on. The tool loops sum
/// these across rounds into a single `ChatUsage` via [`build_usage`],
/// mirroring what the non-tool path (`providers.rs::parse_usage`) reports.
#[derive(Default)]
struct RoundUsage {
    input: i64,
    output: i64,
    cache_creation: i64,
    cache_read: i64,
    reasoning: i64,
    have: bool,
}

impl RoundUsage {
    /// Fold a round's usage into the running totals. OpenAI reports each
    /// round's usage as absolute totals and Anthropic as per-event deltas
    /// already summed inside the round, so a plain sum across rounds is
    /// correct for both.
    fn add(&mut self, r: RoundUsage) {
        self.input += r.input;
        self.output += r.output;
        self.cache_creation += r.cache_creation;
        self.cache_read += r.cache_read;
        self.reasoning += r.reasoning;
        self.have = self.have || r.have;
    }
}

/// Neutralize the display-layer's structural tags inside tool RESULTS so a
/// literal `</tool>`/`<tool>`/`<think>` in shell output can't corrupt the
/// frontend's segment parser (a closing tag truncates the marker block; an
/// opener prematurely starts a new segment). Mirrors `tool_block`'s arg-side
/// sanitize in proto.rs.
fn neutralize_markers(v: &str) -> String {
    v.replace("</tool>", "<\\/tool>")
        .replace("<tool>", "<\\tool>")
        .replace("<think>", "<\\think>")
}

async fn openai_stream_round(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    app: &AppHandle,
    sid: &str,
    full: &mut String,
) -> Result<(Value, RoundUsage), String> {
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
        // The 400 body from llama-server names the exact rejected field
        // ("unknown field", "tool not supported", "content is empty", …) —
        // surface it in the dev log, not just the UI banner.
        eprintln!(
            "[chat:stream] HTTP {status} from {url} body={}",
            crate::util::truncate_chars(&b, 2000)
        );
        return Err(format!("HTTP {status}: {b}"));
    }

    let mut stream = resp.bytes_stream();
    let mut pending = String::new();

    let mut content = String::new();
    let mut suppress = false;
    // Byte offset in `content` where the suspected `<tool_call` markup began
    // — the held-back tail starts here if suppression turns out to be a
    // false positive.
    let mut suppressed_from = 0usize;
    let mut in_think = false;
    // Sanitize: drop ANY untrusted content that could break out of the chat
    // bubble once persisted. The model is the source of `content` and is not
    // trusted — strip control characters (BOM, zero-width space, NULs, ASCII
    // controls) that have no business in user-visible text and that some
    // React/HTML renderers handle in surprising ways. Newlines and tabs are
    // preserved (the bubble uses them for layout).
    // Hoisted to a free fn (mi1) — the closure captured nothing anyway.
    fn sanitize_model_text(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                // Keep the printable whitespace the bubble actually uses.
                '\n' | '\r' | '\t' => out.push(c),
                // Drop everything else in the C0 control range + DEL.
                c if (c as u32) < 0x20 || (c as u32) == 0x7f => {}
                c => out.push(c),
            }
        }
        out
    }
    let sanitize = sanitize_model_text;
    // Per-index accumulation of (id, name, arguments).
    let mut calls: Vec<(String, String, String)> = Vec::new();
    let mut usage = RoundUsage::default();
    let mut parse_failures: u32 = 0;
    // Held-back tail of the previous chunk that could be the START of a
    // `<tool_call` opener split across SSE chunks — emitted with the next
    // chunk once it proves not to be one (classic incremental-scan carry).
    let mut carry = String::new();

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
                usage.input = u.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(usage.input);
                usage.output = u
                    .get("completion_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(usage.output);
                // v2 detail fields (OpenAI-compatible: cached prompt tokens,
                // reasoning tokens) — same fields the cost model v2 reads.
                usage.cache_read = u
                    .pointer("/prompt_tokens_details/cached_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(usage.cache_read);
                usage.reasoning = u
                    .pointer("/completion_tokens_details/reasoning_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(usage.reasoning);
                usage.have = true;
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
                    let clean = sanitize(c);
                    content.push_str(&clean);
                    if !suppress {
                        // The emit candidate is carry + chunk: a `<tool_call`
                        // opener that straddled the chunk boundary must be
                        // detected BEFORE its leading fragment reaches the UI
                        // and `full` (a leaked `<tool` fragment used to
                        // persist in the message when the marker completed
                        // in the next chunk).
                        let mut piece = std::mem::take(&mut carry);
                        piece.push_str(&clean);
                        if let Some(pos) = piece.find("<tool_call") {
                            suppress = true;
                            suppressed_from = content.len() - piece.len() + pos;
                            // Emit any prose that preceded the markup — only
                            // the markup itself is suppressed.
                            if pos > 0 {
                                let prefix = piece[..pos].to_string();
                                emit_token(app, sid, &prefix, full);
                            }
                        } else {
                            // Hold back a trailing partial-opener tail (a
                            // proper prefix of `<tool_call`) until the next
                            // chunk resolves it either way.
                            const MARKER: &str = "<tool_call";
                            let mut split = piece.len();
                            for n in (1..MARKER.len().min(piece.len())).rev() {
                                if MARKER.starts_with(&piece[piece.len() - n..]) {
                                    split = piece.len() - n;
                                    break;
                                }
                            }
                            if split > 0 {
                                let head = piece[..split].to_string();
                                emit_token(app, sid, &head, full);
                            }
                            carry = piece[split..].to_string();
                        }
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
                    let clean = sanitize(r);
                    emit_token(app, sid, &clean, full);
                }
            }
            if let Some(tcs) = delta.get("tool_calls").and_then(|x| x.as_array()) {
                for tc in tcs {
                    let idx = tc.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    // Network-controlled index — clamp before growing the vec
                    // (see MAX_STREAM_BLOCK_INDEX).
                    if idx > MAX_STREAM_BLOCK_INDEX {
                        continue;
                    }
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
    // A held-back partial-opener tail that never resolved into a marker is
    // ordinary prose — flush it so the UI and the persisted message keep it.
    if !suppress && !carry.is_empty() {
        emit_token(app, sid, &carry, full);
    }

    // Suppression latched on a suspected `<tool_call` opener. Flush the
    // held-back tail so the UI and the persisted message don't lose it:
    // when a parseable Hermes block materialized, strip the markup and keep
    // any prose that followed it; otherwise (the model wrote literal
    // "<tool_call" in prose, or the stream ended mid-block) flush the tail
    // verbatim.
    if suppress {
        let tail = match parse_hermes_tool_calls(&content) {
            Some(calls) if !calls.is_empty() => {
                strip_hermes_tool_calls(&content[suppressed_from..])
            }
            _ => content[suppressed_from..].to_string(),
        };
        if !tail.is_empty() {
            emit_token(app, sid, &tail, full);
        }
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
        usage,
    ))
}

/// One streaming round against an Anthropic `/v1/messages`.
///
/// Emits assistant text (and `thinking`, wrapped in `<think>…</think>`) live as
/// it streams, accumulates `tool_use` blocks (id/name/input), and returns the
/// reconstructed `content` block array plus the round's [`RoundUsage`].
async fn anthropic_stream_round(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    app: &AppHandle,
    sid: &str,
    full: &mut String,
) -> Result<(Vec<Value>, RoundUsage), String> {
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
    // `sig` carries the thinking block's signature — Anthropic requires the
    // full thinking block (text + signature) to be echoed back during tool
    // use when extended thinking is enabled.
    struct Blk {
        kind: u8,
        text: String,
        id: String,
        name: String,
        json: String,
        sig: String,
    }
    let mut blocks: Vec<Blk> = Vec::new();
    let mut in_think = false;
    let mut usage = RoundUsage::default();
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
                        usage.input += u.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                        // v2 cache fields — billed differently from plain
                        // input, so the cost model needs them split out
                        // (same field names the non-tool path parses).
                        usage.cache_creation += u
                            .get("cache_creation_input_tokens")
                            .and_then(|x| x.as_i64())
                            .unwrap_or(0);
                        usage.cache_read += u
                            .get("cache_read_input_tokens")
                            .and_then(|x| x.as_i64())
                            .unwrap_or(0);
                        usage.have = true;
                    }
                }
                "content_block_start" => {
                    let idx = p.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    // Network-controlled index — clamp before growing the vec
                    // (see MAX_STREAM_BLOCK_INDEX). Deltas for skipped blocks
                    // are dropped harmlessly via blocks.get_mut below.
                    if idx > MAX_STREAM_BLOCK_INDEX {
                        continue;
                    }
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
                            sig: String::new(),
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
                                // Accumulate as well as stream: with extended
                                // thinking + tool use, Anthropic requires the
                                // full thinking block echoed back next round.
                                if let Some(b) = blocks.get_mut(idx) {
                                    b.text.push_str(t);
                                }
                                emit_token(app, sid, t, full);
                            }
                        }
                        "signature_delta" => {
                            if let Some(s) =
                                delta.and_then(|d| d.get("signature")).and_then(|x| x.as_str())
                            {
                                if let Some(b) = blocks.get_mut(idx) {
                                    b.sig.push_str(s);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    if let Some(u) = p.get("usage") {
                        if let Some(o) = u.get("output_tokens").and_then(|x| x.as_i64()) {
                            usage.output = o;
                            usage.have = true;
                        }
                        // Extended-thinking rounds report reasoning tokens
                        // separately on message_delta (when reported at all).
                        if let Some(r) = u.get("reasoning_output_tokens").and_then(|x| x.as_i64()) {
                            usage.reasoning += r;
                            usage.have = true;
                        }
                        // Cache fields normally arrive on message_start; some
                        // Anthropic-compatible backends only report them here.
                        // Take them only while unset so we never double-count.
                        if usage.cache_creation == 0 {
                            usage.cache_creation = u
                                .get("cache_creation_input_tokens")
                                .and_then(|x| x.as_i64())
                                .unwrap_or(0);
                        }
                        if usage.cache_read == 0 {
                            usage.cache_read = u
                                .get("cache_read_input_tokens")
                                .and_then(|x| x.as_i64())
                                .unwrap_or(0);
                        }
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
            // Thinking blocks must be echoed back verbatim (text + signature)
            // during tool use or the API 400s on the next round.
            2 if !b.text.is_empty() => Some(
                json!({ "type": "thinking", "thinking": b.text, "signature": b.sig }),
            ),
            2 => None,
            _ if !b.text.is_empty() => Some(json!({ "type": "text", "text": b.text })),
            _ => None,
        })
        .collect();

    Ok((content, usage))
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
    perf: crate::chat::turn_perf::TurnPerf,
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
    // Per-turn local-docs auto-retrieval (§3.1.7): inject the retrieved
    // context as the FIRST user message (right after the system prompt) so
    // the model answers from the user's own documents without an explicit
    // search_docs call. The retrieval is computed once per turn and re-sent
    // on every tool round-trip, matching how the history is re-sent.
    if !req.local_docs_retrieval.is_empty() {
        messages.push(json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }
    for m in &req.messages {
        messages.push(openai_message_json(m));
    }

    let mut full = String::new();
    let mut total = RoundUsage::default();

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
        // Local GGUF (llama.cpp) uses `chat_template_kwargs.enable_thinking`
        // for Qwen3 / DeepSeek-R1 thinking. Cloud OpenAI reasoning models
        // read `reasoning_effort` (above) and ignore this flag. Only emit
        // when the user has explicitly toggled thinking — None leaves the
        // model at its default.
        if let Some(on) = req.thinking {
            body["chat_template_kwargs"] = json!({ "enable_thinking": on });
        }

        perf.begin_gen();
        let (message, round_usage) =
            openai_stream_round(client, &url, api_key, &body, app, sid, &mut full).await?;
        perf.end_gen();
        total.add(round_usage);

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
        let mut hermes_recovered = false;
        let tool_calls: Vec<Value> = if tool_calls.is_empty() {
            let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
            match parse_hermes_tool_calls(content) {
                Some(parsed) if !parsed.is_empty() => {
                    hermes_recovered = true;
                    parsed
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
                        .collect()
                }
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
            // When the calls were recovered from Hermes text, the streamed
            // message's `tool_calls` is the empty array produced by
            // `openai_stream_round`. Insert the synthesized calls so the
            // re-sent history pairs each `role: "tool"` message below with a
            // matching assistant `tool_calls` entry — strict OpenAI-compatible
            // validators reject tool messages with unmatched ids (400).
            if hermes_recovered {
                if let Some(obj) = echoed.as_object_mut() {
                    obj.insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
                }
            }
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

                // Two-part emission: open the block BEFORE running the tool so
                // the frontend sees the step as live (spinner + live action
                // label) while it executes — the closing tag after completion
                // flips it to done. `full` accumulates the same bytes either
                // way, so the persisted message is identical.
                let block = tool_block(&name, &args);
                let open = block.strip_suffix("</tool>").unwrap_or(&block).to_string();
                emit_token(app, sid, &open, &mut full);
                perf.begin_tool();
                let result = run_tool(client, &art_dir, caps, mode, mgr, app, sid, &name, &args).await;
                perf.end_tool();
                if block.ends_with("</tool>") {
                    emit_token(app, sid, "</tool>", &mut full);
                }
                // Attach the captured terminal output to the shell step so the
                // UI shows a collapsible preview under the command. The title
                // is required: the frontend's stepLabel renders a titleless
                // marker as a phantom "working…" step row.
                if name == tools::RUN_SHELL && !result.trim().is_empty() {
                    let result_marker = json!({
                        "kind": "result",
                        "title": "Output",
                        // Neutralize the structural openers too: a literal
                        // <tool>/<think> in shell output would prematurely open
                        // a new frontend segment (see proto.rs tool_block).
                        "result": neutralize_markers(&result),
                    });
                    let rm = format!("<tool>{result_marker}</tool>");
                    emit_token(app, sid, &rm, &mut full);
                }
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
        return Ok((full, build_usage(true, total)));
    }

    emit_token(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(true, total)))
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
    perf: crate::chat::turn_perf::TurnPerf,
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
    // Per-turn local-docs auto-retrieval (§3.1.7): inject the retrieved
    // context as the FIRST user message so the model answers from the user's
    // own documents without an explicit search_docs call.
    if !req.local_docs_retrieval.is_empty() {
        messages.insert(0, json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }

    let mut full = String::new();
    let mut total = RoundUsage::default();

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
        // Extended thinking on the tool path too — previously only the
        // non-tool request builder (providers.rs) sent this, so the
        // composer's brain toggle was a no-op with tools on (the default).
        // Anthropic requires budget_tokens < max_tokens.
        if req.thinking == Some(true) {
            let max_tokens = req.max_tokens.unwrap_or(4096);
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": (max_tokens - 1024).max(1024),
            });
        }

        perf.begin_gen();
        let (content, round_usage) =
            anthropic_stream_round(client, &url, api_key, &body, app, sid, &mut full).await?;
        perf.end_gen();
        total.add(round_usage);

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

                // Two-part emission — see the OpenAI loop's marker.
                let block = tool_block(&name, &args);
                let open = block.strip_suffix("</tool>").unwrap_or(&block).to_string();
                emit_token(app, sid, &open, &mut full);
                perf.begin_tool();
                let result = run_tool(client, &art_dir, caps, mode, mgr, app, sid, &name, &args).await;
                perf.end_tool();
                if block.ends_with("</tool>") {
                    emit_token(app, sid, "</tool>", &mut full);
                }
                if name == tools::RUN_SHELL && !result.trim().is_empty() {
                    let result_marker = json!({
                        "kind": "result",
                        // Title required — see the OpenAI loop's marker.
                        "title": "Output",
                        "result": neutralize_markers(&result),
                    });
                    let rm = format!("<tool>{result_marker}</tool>");
                    emit_token(app, sid, &rm, &mut full);
                }
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
        return Ok((full, build_usage(false, total)));
    }

    emit_token(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(false, total)))
}

/// Build a `ChatUsage` summing across all tool-loop round-trips, picking the
/// provider's cost model. Carries the v2 detail fields (cache + reasoning)
/// so the cost model bills tool-mode turns the same as the non-tool path.
fn build_usage(openai: bool, u: RoundUsage) -> Option<ChatUsage> {
    if !u.have {
        return None;
    }
    let cost = if openai {
        calculate_openai_cost(u.input, u.output)
    } else {
        calculate_anthropic_cost(u.input, u.output)
    };
    Some(ChatUsage {
        input_tokens: u.input,
        output_tokens: u.output,
        cost_usd: cost,
        cache_creation_input_tokens: u.cache_creation,
        cache_read_input_tokens: u.cache_read,
        reasoning_tokens: u.reasoning,
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
