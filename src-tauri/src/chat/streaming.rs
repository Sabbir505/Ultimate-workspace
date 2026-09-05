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

use crate::chat::cache;
use crate::chat::{permission, tools, ChatManager};
use crate::chat::dispatch::{artifacts_dir, emit_marker, emit_token, run_tool};
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
pub(crate) const MAX_PARSE_FAILURES: u32 = 50;

/// Upper bound on tool-call / content-block indexes accepted from the wire.
/// The index is network-controlled (OpenAI/Anthropic-compatible base URLs are
/// user-configurable, hence untrusted): without a cap, a hostile or buggy
/// endpoint can send `"index": 4294967295` and make the grow-loops below
/// allocate billions of entries — instant memory exhaustion mid-turn. Real
/// rounds use a handful of blocks; 64 is generous.
const MAX_STREAM_BLOCK_INDEX: usize = 64;

/// Read the next chunk off an SSE stream with a stall watchdog (B-9).
///
/// reqwest's interactive client has no overall timeout, so a half-open
/// connection (proxy blackhole, upstream idle after headers) parks the read
/// forever: the turn task never finishes, no `chat:done`/`chat:error` fires,
/// and the UI spinner spins until the user restarts. `openai_stream_round`
/// inlined this guard; this is the shared form used by the Anthropic round,
/// the non-tool path, and the subagent loop. The timeout covers
/// connect+headers+next-chunk only — long streams between chunks are fine as
/// long as bytes keep flowing.
pub(crate) async fn stream_next_with_watchdog<S, E, T>(
    stream: &mut S,
    grace: std::time::Duration,
) -> Result<Option<T>, String>
where
    S: futures_util::Stream<Item = Result<T, E>> + Unpin,
    E: std::fmt::Display,
{
    match tokio::time::timeout(grace, futures_util::StreamExt::next(stream)).await {
        Ok(Some(chunk)) => chunk
            .map(Some)
            .map_err(|e| format!("stream read error: {e}")),
        Ok(None) => Ok(None),
        Err(_) => Err(format!(
            "stream stalled: no data received for {}s",
            grace.as_secs()
        )),
    }
}

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
pub(crate) fn neutralize_markers(v: &str) -> String {
    v.replace("</tool>", "<\\/tool>")
        .replace("<tool>", "<\\tool>")
        .replace("<think>", "<\\think>")
}

/// Strip C0 control characters (except the printable whitespace the bubbles
/// use) from a streamed model chunk. Shared by the main tool loop and the
/// subagent loop so both streams get identical hygiene.
pub(crate) fn sanitize_stream_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\n' | '\r' | '\t' => out.push(c),
            c if (c as u32) < 0x20 || (c as u32) == 0x7f => {}
            c => out.push(c),
        }
    }
    out
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

    // B-10: bound time-to-headers (send() resolves at the header) WITHOUT a
    // total request timeout — reqwest's `.timeout()` covers the whole body
    // read, which would kill long streams. The stall watchdog below guards
    // the body.
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        client
            .post(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(body)
            .send(),
    )
    .await
    .map_err(|_| "request timed out waiting for response headers (60s)".to_string())?
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
    let mut pending = crate::util::SseLineBuffer::new();

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
    // Lives at module scope (`sanitize_stream_text`) so the subagent loop in
    // dispatch.rs reuses the exact same stream hygiene.
    let sanitize = sanitize_stream_text;
    // Per-index accumulation of (id, name, arguments).
    let mut calls: Vec<(String, String, String)> = Vec::new();
    let mut usage = RoundUsage::default();
    let mut parse_failures: u32 = 0;
    // Held-back tail of the previous chunk that could be the START of a
    // `<tool_call` opener split across SSE chunks — emitted with the next
    // chunk once it proves not to be one (classic incremental-scan carry).
    let mut carry = String::new();
    // Set when a chunk carries `finish_reason: "stop"`. NOT terminal: the
    // provider's usage chunk arrives AFTER it (llama-server order: final
    // delta → `{"choices":[],"usage":{…}}` → `[DONE]`), and breaking here
    // silently dropped token accounting on every plain (non-tool) turn —
    // tool rounds end with `finish_reason: "tool_calls"` and read on, which
    // is why only they had metrics. After stop, a short read grace bounds
    // the wait for the usage chunk; providers that never send it just hit
    // the grace instead of the 60s stall watchdog.
    let mut stop_seen = false;

    'outer: while let Some(chunk) = {
        // Watchdog: 60s with no bytes from the provider means the connection
        // stalled (half-open proxy, OpenRouter routing hang, upstream idle).
        // reqwest's interactive client has no overall timeout, so without
        // this guard a stalled stream blocks forever — the frontend's
        // `streaming[chatSessionId]` entry never clears and the stop button
        // spins indefinitely. A timeout here returns Err → chat:error.
        // After `finish_reason: "stop"` the grace shrinks to 2s: only the
        // usage chunk (and [DONE]) should follow.
        let grace = if stop_seen {
            std::time::Duration::from_secs(2)
        } else {
            std::time::Duration::from_secs(60)
        };
        match tokio::time::timeout(grace, stream.next()).await {
            Ok(Some(chunk)) => Some(chunk),
            Ok(None) => None,
            Err(_elapsed) if stop_seen => None,
            Err(_elapsed) => {
                return Err("stream stalled: no data received for 60s".to_string());
            }
        }
    } {
        let chunk = chunk.map_err(|e| format!("stream read error: {e}"))?;
        for line in pending.push(&chunk) {
            let line = line.trim_end();
            // Tolerate `data:[DONE]` (no space) and trailing `\r` from some
            // OpenAI-compatible aggregators (OpenRouter, vLLM) — a strict
            // `strip_prefix("data: ")` match used to skip these and never
            // break, hanging the turn until TCP EOF.
            let data = match line.strip_prefix("data:").map(|s| s.trim_start()) {
                Some(d) => d,
                None => continue,
            };
            if data == "[DONE]" || data == "[DONE]\r" || data.trim() == "[DONE]" {
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
            // B-17: a mid-stream {"error": …} event must fail the round, not
            // silently truncate the answer.
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                let msg = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("provider returned an error event");
                return Err(format!("provider error: {msg}"));
            }
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
            // First provider delta of any shape (text, reasoning, or
            // tool-call args) captures TTFT and anchors the round's decode
            // span — a tool-call-only round is still real token time.
            crate::chat::turn_perf::record_active_stream_delta(sid);
            if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    if in_think {
                        emit_marker(app, sid, "</think>", full);
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
                            // chunk resolves it either way. Suffix offsets
                            // must land on char boundaries — a chunk can end
                            // mid multi-byte character (e.g. an em-dash), and
                            // a raw byte slice there panics.
                            const MARKER: &str = "<tool_call";
                            let mut split = piece.len();
                            for n in (1..MARKER.len().min(piece.len())).rev() {
                                let at = piece.len() - n;
                                if !piece.is_char_boundary(at) {
                                    continue;
                                }
                                if MARKER.starts_with(&piece[at..]) {
                                    split = at;
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
                        emit_marker(app, sid, "<think>", full);
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
            // OpenAI/OpenRouter-compatible streams sometimes omit a final
            // `data: [DONE]` but do include `choices[0].finish_reason = "stop"`.
            // NOT terminal here — the provider's usage chunk follows it (see
            // `stop_seen` above); the 2s post-stop read grace ends the round
            // if it never arrives.
            if v.pointer("/choices/0/finish_reason").and_then(|x| x.as_str()) == Some("stop") {
                stop_seen = true;
            }
        }
    }

    if in_think {
        emit_marker(app, sid, "</think>", full);
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
    // (B-9 moved stream reads onto stream_next_with_watchdog, which brings
    // its own StreamExt — no local import needed.)

    // B-10: bound time-to-headers (see the OpenAI round for why there is no
    // total `.timeout()` on a streaming request).
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        client
            .post(url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(body)
            .send(),
    )
    .await
    .map_err(|_| "request timed out waiting for response headers (60s)".to_string())?
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
    let mut pending = crate::util::SseLineBuffer::new();

    'outer: loop {
        // B-9: 60s stall watchdog — a half-open connection must fail the
        // turn (surfaced as chat:error), not park it forever.
        let chunk = match stream_next_with_watchdog(&mut stream, std::time::Duration::from_secs(60))
            .await
        {
            Ok(Some(c)) => c,
            Ok(None) => break 'outer,
            Err(e) => return Err(e),
        };
        // B-14: byte-buffered line assembly — lossy-converting each raw chunk
        // independently corrupted multi-byte chars split across TCP reads.
        for line in pending.push(&chunk) {
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
                    // First delta of any kind (text/thinking/tool-args JSON)
                    // captures TTFT and anchors the round's decode span.
                    crate::chat::turn_perf::record_active_stream_delta(sid);
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
                                    emit_marker(app, sid, "</think>", full);
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
                                    emit_marker(app, sid, "<think>", full);
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
                "error" => {
                    // B-17: a mid-stream error event (after 200 OK — OpenRouter
                    // overload, credit exhaustion) used to be ignored, so the
                    // turn "completed" with silently truncated text.
                    let msg = p
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("provider returned an error event");
                    return Err(format!("provider error: {msg}"));
                }
                _ => {}
            }
        }
    }

    if in_think {
        emit_marker(app, sid, "</think>", full);
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

/// Fold sources registered by the `attach_connector` / `attach_mcp_server`
/// meta-tools into the turn's live caps (deduped by connector id / wire
/// name). Returns true when anything changed → the caller must rebuild its
/// tool-spec array. Connector tables aren't `Clone` (they hold live MCP
/// sessions), which is why the loops receive `ToolCaps` BY VALUE: the loop
/// then owns the only strong Arc ref and `try_unwrap` hands us the Vec to
/// extend. If a future caller ever shares that Arc, the connector merge
/// degrades to a restore-and-skip instead of panicking mid-turn.
fn fold_late_attaches(
    mgr: &Arc<ChatManager>,
    sid: &str,
    live_caps: &mut tools::ToolCaps,
) -> bool {
    let Some(slot) = mgr.late_attach_slot(sid) else { return false };
    let late = std::mem::take(&mut *slot.lock());
    if late.connectors.is_empty() && late.mcp.is_empty() {
        return false;
    }
    let mut changed = false;
    if !late.connectors.is_empty() {
        let taken = std::mem::replace(
            &mut live_caps.attached_connectors,
            std::sync::Arc::new(Vec::new()),
        );
        match std::sync::Arc::try_unwrap(taken) {
            Ok(mut conns) => {
                for c in late.connectors {
                    if !conns.iter().any(|e| e.connector_id == c.connector_id) {
                        conns.push(c);
                        changed = true;
                    }
                }
                live_caps.attached_connectors = std::sync::Arc::new(conns);
            }
            Err(arc) => {
                live_caps.attached_connectors = arc;
            }
        }
    }
    if !late.mcp.is_empty() {
        let mut mcp = (*live_caps.mcp_tools).clone();
        let before = mcp.len();
        for e in late.mcp {
            if !mcp.iter().any(|x| x.wire_name == e.wire_name) {
                mcp.push(e);
            }
        }
        if mcp.len() != before {
            live_caps.mcp_tools = std::sync::Arc::new(mcp);
            changed = true;
        }
    }
    changed
}

/// Tool results from earlier rounds of the SAME turn are re-sent on every
/// subsequent round, and a long agentic turn can therefore carry hundreds of
/// KB of stale output (a single `browser_read`/`read_file` result is 32-50k
/// chars). Once the model has replied to a tool result, keeping its full text
/// verbatim rarely helps — so all but the newest
/// [`KEEP_LAST_TOOL_RESULTS`] results elide to a short stub (head snippet
/// preserved) before each round's request is built.
const KEEP_LAST_TOOL_RESULTS: usize = 3;
/// How much of an elided result survives in the stub, so the model keeps a
/// hint of what it learned without the bulk.
const ELIDED_RESULT_HEAD_CHARS: usize = 300;
const ELISION_MARKER: &str = "[tool result elided to save context";

/// Render the stub that replaces an elided tool result.
fn elided_result_stub(content: &str) -> String {
    let truncated = crate::util::truncate_chars(content, ELIDED_RESULT_HEAD_CHARS);
    let ellipsis = if content.chars().count() > ELIDED_RESULT_HEAD_CHARS {
        "…"
    } else {
        ""
    };
    format!(
        "{ELISION_MARKER} — original {n} chars, first {keep} kept below; re-run the tool if you need the full output again]\n{truncated}{ellipsis}",
        n = content.len(),
        keep = ELIDED_RESULT_HEAD_CHARS,
    )
}

/// Elide tool results older than the newest [`KEEP_LAST_TOOL_RESULTS`] from a
/// turn's working `messages` array, in place. Idempotent (stubs are never
/// re-elided) and deterministic (the same array always yields the same
/// request), so the mutated prefix stays prompt-cache-stable across rounds.
/// `openai` selects the tool-result shape: OpenAI uses `role:"tool"`
/// messages; Anthropic uses `user` messages carrying `tool_result` blocks.
fn elide_stale_tool_results(messages: &mut [Value], openai: bool) {
    let is_tool_message = |m: &Value| -> bool {
        if openai {
            m.get("role").and_then(|r| r.as_str()) == Some("tool")
        } else {
            m.get("content")
                .and_then(|c| c.as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                })
                .unwrap_or(false)
        }
    };
    let tool_message_positions: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| is_tool_message(m))
        .map(|(i, _)| i)
        .collect();
    if tool_message_positions.len() <= KEEP_LAST_TOOL_RESULTS {
        return;
    }
    let elide_count = tool_message_positions.len() - KEEP_LAST_TOOL_RESULTS;
    for &pos in &tool_message_positions[..elide_count] {
        let message = &mut messages[pos];
        if openai {
            if let Some(Value::String(content)) = message.get_mut("content") {
                if !content.starts_with(ELISION_MARKER) {
                    *content = elided_result_stub(content);
                }
            }
        } else if let Some(blocks) = message
            .get_mut("content")
            .and_then(|c| c.as_array_mut())
        {
            for block in blocks.iter_mut() {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                if let Some(Value::String(content)) = block.get_mut("content") {
                    if !content.starts_with(ELISION_MARKER) {
                        *content = elided_result_stub(content);
                    }
                }
            }
        }
    }
}

/// Assemble one OpenAI `/v1/chat/completions` tool-loop round body. With
/// `cache_marks` (OpenRouter routing an `anthropic/*` model — the only
/// OpenAI-family combo that accepts them, see `cache::openrouter_anthropic`)
/// the system message and the newest message carry Anthropic-style
/// `cache_control` breakpoints, which OpenRouter translates into native
/// Claude prompt caching: the stable prefix re-reads as cache hits across
/// the turn's rounds instead of being re-billed. Marks are applied to a
/// clone — the caller's working arrays stay pristine, and the identical
/// marks every round keep the request prefix byte-stable.
fn build_openai_body(
    req: &ChatRequest,
    messages: &[Value],
    tool_specs: &[Value],
    cache_marks: bool,
) -> Value {
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
    if cache_marks {
        let mut msgs = messages.to_vec();
        if let Some(sys) = msgs.first_mut() {
            if sys.get("role").and_then(|r| r.as_str()) == Some("system") {
                if let Some(Value::String(text)) = sys.get_mut("content") {
                    if !text.is_empty() {
                        sys["content"] = cache::cached_system_block(text);
                    }
                }
            }
        }
        cache::mark_last_message(&mut msgs);
        body["messages"] = Value::Array(msgs);
    }
    body
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
    caps: tools::ToolCaps,
    sandbox: permission::SandboxPolicy,
    approval: permission::ApprovalPolicy,
    mgr: &Arc<ChatManager>,
    sid: &str,
    app: &AppHandle,
    research_mode: bool,
    // Anthropic-style cache marks on the OpenAI wire format — set ONLY for
    // OpenRouter requests whose model is `anthropic/*` (the call site gates
    // via cache::openrouter_anthropic). OpenRouter translates the marks into
    // native Claude prompt caching; stricter OpenAI-compatible backends can
    // 400 on unknown fields, so nobody else gets them.
    cache_marks: bool,
    perf: crate::chat::turn_perf::TurnPerf,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/chat/completions");
    // Mutable working copy (owned — see fold_late_attaches for why the loops
    // take ToolCaps by value): the late-attach drain folds model-initiated
    // `attach_connector` / `attach_mcp_server` results into the live caps +
    // specs mid-turn.
    let mut live_caps = caps;
    let mut tool_specs = tools::openai_tool_specs(&live_caps, sandbox);
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
    // Per-turn local-docs auto-retrieval (§3.1.7): the retrieved context is
    // appended as the LAST message, right next to the turn's question, so the
    // model answers from the user's own documents without an explicit
    // search_docs call. Appending (not injecting at the head) keeps the
    // message prefix byte-stable across turns: the synthetic message is not
    // persisted, so an injected-first copy would change the head of every
    // request and invalidate prefix caching (OpenAI's automatic cache, Z.ai's,
    // and the Anthropic breakpoints) for the entire history.
    if !req.local_docs_retrieval.is_empty() {
        messages.push(json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }

    let mut full = String::new();
    let mut total = RoundUsage::default();

    // [prompt-audit]: final wire composition. On local models the --jinja
    // chat template renders the `tools` array into the prompt, so the tools
    // JSON size — not just the system prompt — drives prompt_tokens.
    {
        let tools_json = serde_json::to_string(&tool_specs).unwrap_or_default();
        let hist_chars: usize = req.messages.iter().map(|m| m.content.len()).sum();
        let retrieval_chars: usize = req.local_docs_retrieval.iter().map(|s| s.len()).sum();
        eprintln!(
            "[prompt-audit] request: {} tool specs/{} chars JSON, system={} chars, \
             history={} msgs/{} chars, retrieval={} chars",
            tool_specs.len(),
            tools_json.len(),
            req.system.as_ref().map(|s| s.len()).unwrap_or(0),
            req.messages.len(),
            hist_chars,
            retrieval_chars
        );
        let mut by_desc: Vec<(usize, &str)> = tool_specs
            .iter()
            .filter_map(|s| {
                let name = s.pointer("/function/name").and_then(|n| n.as_str())?;
                let desc = s
                    .pointer("/function/description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("");
                Some((desc.len(), name))
            })
            .collect();
        by_desc.sort_by(|a, b| b.0.cmp(&a.0));
        let top: Vec<String> = by_desc
            .iter()
            .take(6)
            .map(|(chars, name)| format!("{name}({chars})"))
            .collect();
        eprintln!("[prompt-audit] largest tool descriptions: {}", top.join(", "));
    }

    for round in 0..cap {
        // Shrink stale tool output before the request is assembled — a 20-
        // round research turn otherwise re-sends every earlier fetch/read
        // result verbatim on every round.
        elide_stale_tool_results(&mut messages, true);
        let mut body = build_openai_body(req, &messages, &tool_specs, cache_marks);

        perf.begin_gen();
        // Mirror of the Anthropic loop's gateway fallback: a backend that
        // rejects the cache marks fails with an HTTP 400 before any byte
        // streams (nothing emitted into `full` yet), so retrying the round
        // uncached is safe.
        let (message, round_usage) = match openai_stream_round(
            client,
            &url,
            api_key,
            &body,
            app,
            sid,
            &mut full,
        )
        .await
        {
            Err(e) if cache::is_cache_rejection(&e) => {
                cache::strip_cache_control(&mut body);
                openai_stream_round(client, &url, api_key, &body, app, sid, &mut full).await?
            }
            other => other?,
        };
        perf.end_gen();
        if round_usage.have {
            eprintln!(
                "[prompt-audit] round {round}: server prompt_tokens={} completion_tokens={}",
                round_usage.input, round_usage.output
            );
        }
        // Fold round-boundary usage into the live snapshot so the composer's
        // IN/CACHE chips update before chat:done. OpenAI-style prompt_tokens
        // already includes cached tokens (inclusive).
        perf.note_round_usage(round_usage.input, round_usage.cache_read, round_usage.cache_creation, true);
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
            // PARALLEL SUBAGENT FAN-OUT: a round that contains several `Task`
            // calls (the model asking for multiple subagents at once — the
            // whole point of subagents) must run them CONCURRENTLY, not
            // one-by-one. Pre-pass: open every Task's marker and spawn its
            // run_tool onto its own tokio task; the in-order pass below then
            // awaits the handles so tool results still attach in call order.
            let mut deferred: Vec<Option<tokio::task::JoinHandle<String>>> =
                (0..tool_calls.len()).map(|_| None).collect();
            for (idx, tc) in tool_calls.iter().enumerate() {
                let name = tc.get("function").and_then(|f| f.get("name")).and_then(|x| x.as_str()).unwrap_or("");
                if name != tools::TASK {
                    continue;
                }
                let args_str = tc.get("function").and_then(|f| f.get("arguments")).and_then(|x| x.as_str()).unwrap_or("{}");
                let args = parse_tool_args(args_str);
                let block = tool_block(&name, &args);
                let open = block.strip_suffix("</tool>").unwrap_or(&block).to_string();
                emit_marker(app, sid, &open, &mut full);
                deferred[idx] = Some(crate::chat::dispatch::spawn_run_tool(
                    client.clone(),
                    art_dir.to_path_buf(),
                    std::sync::Arc::new(live_caps.clone()),
                    sandbox,
                    approval,
                    Arc::clone(mgr),
                    app.clone(),
                    sid.to_string(),
                    name.to_string(),
                    args,
                ));
            }
            for (idx, tc) in tool_calls.iter().enumerate() {
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
                // way, so the persisted message is identical. (Deferred Task
                // calls opened their marker in the pre-pass above.)
                let is_deferred = deferred[idx].is_some();
                if !is_deferred {
                    let block = tool_block(&name, &args);
                    let open = block.strip_suffix("</tool>").unwrap_or(&block).to_string();
                    emit_marker(app, sid, &open, &mut full);
                }
                perf.begin_tool();
                let result = if let Some(handle) = deferred[idx].take() {
                    handle
                        .await
                        .unwrap_or_else(|e| format!("Error: subagent task failed: {e}"))
                } else {
                    run_tool(client, &art_dir, &live_caps, sandbox, approval, mgr, app, sid, &name, &args).await
                };
                perf.end_tool();
                let block = tool_block(&name, &args);
                if block.ends_with("</tool>") {
                    emit_marker(app, sid, "</tool>", &mut full);
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
                    emit_marker(app, sid, &rm, &mut full);
                }
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": result,
                }));
            }
            // Attach-on-demand drain: fold anything the attach meta-tools
            // registered into the live caps + specs so the NEXT round can
            // call the new tools.
            if fold_late_attaches(mgr, sid, &mut live_caps) {
                tool_specs = tools::openai_tool_specs(&live_caps, sandbox);
                eprintln!(
                    "[prompt-audit] late-attach: specs now {} ({} chars JSON)",
                    tool_specs.len(),
                    serde_json::to_string(&tool_specs).map(|s| s.len()).unwrap_or(0)
                );
            }
            continue;
        }

        // No tool calls → final answer. The text was already streamed live in
        // `openai_stream_round` (Hermes markup, if any, was suppressed there).
        return Ok((full, build_usage(true, total)));
    }

    emit_marker(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(true, total)))
}

/// Assemble one Anthropic `/v1/messages` tool-loop round body with prompt-cache
/// breakpoints (see [`crate::chat::cache`]): the last tool spec, the system
/// block, and the newest message each mark the stable prefix, so every round
/// re-reads everything before the fresh tail as 0.1×-price cache hits instead
/// of re-billing the whole prefix at full input price. The marks are applied
/// to clones — the caller's working `messages`/`tool_specs` arrays stay
/// pristine so nothing accumulates across rounds.
fn build_anthropic_body(req: &ChatRequest, messages: &[Value], tool_specs: &[Value]) -> Value {
    let mut tools = tool_specs.to_vec();
    cache::mark_last_tool(&mut tools);
    let mut msgs = messages.to_vec();
    cache::mark_last_message(&mut msgs);

    // E-3: with thinking on, Anthropic requires budget_tokens < max_tokens,
    // so the emitted cap itself is floored to 3072 (same as providers.rs) —
    // flooring only the budget derivation left max_tokens=1024 requests with
    // budget_tokens=2048, which the API rejects outright.
    let max_tokens = if req.thinking == Some(true) {
        req.max_tokens.unwrap_or(4096).max(3072)
    } else {
        req.max_tokens.unwrap_or(4096)
    };
    let mut body = json!({
        "model": req.model,
        "max_tokens": max_tokens,
        "messages": msgs,
        "tools": tools,
        "stream": true,
    });
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            body["system"] = cache::cached_system_block(sys);
        }
    }
    // Extended thinking on the tool path too — previously only the
    // non-tool request builder (providers.rs) sent this, so the
    // composer's brain toggle was a no-op with tools on (the default).
    if req.thinking == Some(true) {
        body["thinking"] = json!({
            "type": "enabled",
            "budget_tokens": (max_tokens - 1024).clamp(1024, max_tokens - 1),
        });
    }
    body
}

/// Agentic tool loop for Anthropic-style providers (native + compatible).
pub(crate) async fn run_anthropic_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    caps: tools::ToolCaps,
    sandbox: permission::SandboxPolicy,
    approval: permission::ApprovalPolicy,
    mgr: &Arc<ChatManager>,
    sid: &str,
    app: &AppHandle,
    research_mode: bool,
    perf: crate::chat::turn_perf::TurnPerf,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/messages");
    // Mutable working copy (owned) — see the OpenAI loop's late-attach drain.
    let mut live_caps = caps;
    let mut tool_specs = tools::anthropic_tool_specs(&live_caps, sandbox);
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
    // Per-turn local-docs auto-retrieval (§3.1.7): appended as the LAST
    // message, next to the turn's question — see the OpenAI loop for why
    // appending (not injecting at the head) keeps prefix caching intact.
    if !req.local_docs_retrieval.is_empty() {
        messages.push(json!({
            "role": "user",
            "content": req.local_docs_retrieval.join("\n\n")
        }));
    }

    let mut full = String::new();
    let mut total = RoundUsage::default();

    for _ in 0..cap {
        // Same stale-tool-output shrink as the OpenAI loop (see
        // elide_stale_tool_results).
        elide_stale_tool_results(&mut messages, false);
        let mut body = build_anthropic_body(req, &messages, &tool_specs);

        perf.begin_gen();
        // Some Anthropic-compatible gateways reject `cache_control` outright.
        // That rejection is an HTTP 400 raised before any byte streams, so
        // nothing has been emitted into `full` — falling back to an uncached
        // body once is safe and keeps those providers working.
        let (content, round_usage) = match anthropic_stream_round(
            client,
            &url,
            api_key,
            &body,
            app,
            sid,
            &mut full,
        )
        .await
        {
            Err(e) if cache::is_cache_rejection(&e) => {
                cache::strip_cache_control(&mut body);
                anthropic_stream_round(client, &url, api_key, &body, app, sid, &mut full).await?
            }
            other => other?,
        };
        perf.end_gen();
        // Fold round-boundary usage into the live snapshot so the composer's
        // IN/CACHE chips update before chat:done. Anthropic's input_tokens is
        // the uncached portion (cache fields billed separately — exclusive).
        perf.note_round_usage(round_usage.input, round_usage.cache_read, round_usage.cache_creation, false);
        total.add(round_usage);

        let tool_uses: Vec<&Value> = content
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
            .collect();

        if !tool_uses.is_empty() {
            // Echo the assistant turn (text + tool_use blocks) verbatim.
            messages.push(json!({ "role": "assistant", "content": content }));

            let mut results: Vec<Value> = Vec::new();
            // PARALLEL SUBAGENT FAN-OUT — see the OpenAI loop's pre-pass.
            let mut deferred: Vec<Option<tokio::task::JoinHandle<String>>> =
                (0..tool_uses.len()).map(|_| None).collect();
            for (idx, tu) in tool_uses.iter().enumerate() {
                let name = tu.get("name").and_then(|x| x.as_str()).unwrap_or("");
                if name != tools::TASK {
                    continue;
                }
                let args = tu.get("input").cloned().unwrap_or_else(|| json!({}));
                let block = tool_block(name, &args);
                let open = block.strip_suffix("</tool>").unwrap_or(&block).to_string();
                emit_marker(app, sid, &open, &mut full);
                deferred[idx] = Some(crate::chat::dispatch::spawn_run_tool(
                    client.clone(),
                    art_dir.to_path_buf(),
                    std::sync::Arc::new(live_caps.clone()),
                    sandbox,
                    approval,
                    Arc::clone(mgr),
                    app.clone(),
                    sid.to_string(),
                    name.to_string(),
                    args,
                ));
            }
            for (idx, tu) in tool_uses.iter().enumerate() {
                let id = tu.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = tu.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = tu.get("input").cloned().unwrap_or_else(|| json!({}));

                // Two-part emission — see the OpenAI loop's marker. (Deferred
                // Task calls opened their marker in the pre-pass above.)
                if deferred[idx].is_none() {
                    let block = tool_block(&name, &args);
                    let open = block.strip_suffix("</tool>").unwrap_or(&block).to_string();
                    emit_marker(app, sid, &open, &mut full);
                }
                perf.begin_tool();
                let result = if let Some(handle) = deferred[idx].take() {
                    handle
                        .await
                        .unwrap_or_else(|e| format!("Error: subagent task failed: {e}"))
                } else {
                    run_tool(client, &art_dir, &live_caps, sandbox, approval, mgr, app, sid, &name, &args).await
                };
                perf.end_tool();
                let block = tool_block(&name, &args);
                if block.ends_with("</tool>") {
                    emit_marker(app, sid, "</tool>", &mut full);
                }
                if name == tools::RUN_SHELL && !result.trim().is_empty() {
                    let result_marker = json!({
                        "kind": "result",
                        // Title required — see the OpenAI loop's marker.
                        "title": "Output",
                        "result": neutralize_markers(&result),
                    });
                    let rm = format!("<tool>{result_marker}</tool>");
                    emit_marker(app, sid, &rm, &mut full);
                }
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result,
                }));
            }
            messages.push(json!({ "role": "user", "content": results }));
            // Attach-on-demand drain — mirror of the OpenAI loop.
            if fold_late_attaches(mgr, sid, &mut live_caps) {
                tool_specs = tools::anthropic_tool_specs(&live_caps, sandbox);
            }
            continue;
        }

        // No tool use → final answer. Text blocks were already streamed live in
        // `anthropic_stream_round`.
        return Ok((full, build_usage(false, total)));
    }

    emit_marker(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::providers::ChatMessage;

    fn sample_req(system: Option<&str>, thinking: Option<bool>) -> ChatRequest {
        ChatRequest {
            model: "claude-sonnet-4-5".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
                images: Vec::new(),
            }],
            max_tokens: Some(4096),
            system: system.map(|s| s.to_string()),
            effort: None,
            thinking,
            local_docs_retrieval: Vec::new(),
            memory_context: None,
        }
    }

    #[test]
    fn anthropic_body_places_three_cache_breakpoints() {
        let req = sample_req(Some("You are Relay."), None);
        let msgs = vec![json!({"role": "user", "content": "hello"})];
        let specs = vec![
            json!({"name": "read_file", "input_schema": {}}),
            json!({"name": "web_search", "input_schema": {}}),
        ];
        let body = build_anthropic_body(&req, &msgs, &specs);

        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        // Only the last tool carries the breakpoint (the API caches the whole
        // array up to it).
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools[1]["cache_control"]["type"], "ephemeral");

        // System rendered as a cached block array, not a bare string.
        assert_eq!(body["system"][0]["type"], "text");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");

        // Newest message marked so the prefix caches incrementally per round.
        let last = body["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(last["content"][0]["cache_control"]["type"], "ephemeral");

        // The caller's working arrays stay pristine (marks must not
        // accumulate across rounds).
        assert!(msgs[0]["content"].is_string());
        assert!(specs[1].get("cache_control").is_none());
    }

    #[test]
    fn anthropic_body_omits_system_and_thinking_when_unset() {
        let req = sample_req(None, None);
        let body = build_anthropic_body(&req, &[], &[]);
        assert!(body.get("system").is_none());
        assert!(body.get("thinking").is_none());
        assert!(body.get("tools").unwrap().as_array().unwrap().is_empty());
        // No messages → no message breakpoint, and no crash.
        assert!(body["messages"].as_array().unwrap().is_empty());
    }

    #[test]
    fn anthropic_body_keeps_thinking_floor() {
        let req = ChatRequest {
            max_tokens: Some(1024),
            thinking: Some(true),
            ..sample_req(Some("sys"), Some(true))
        };
        let body = build_anthropic_body(&req, &[], &[]);
        assert_eq!(body["thinking"]["type"], "enabled");
        // E-3 floor: budget must be < max_tokens, and max_tokens is floored
        // to 3072 before the budget is derived.
        assert_eq!(body["max_tokens"], 3072);
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
    }

    #[test]
    fn cache_rejection_detector_matches_wire_errors() {
        assert!(cache::is_cache_rejection(
            "HTTP 400 Bad Request: {\"type\":\"error\",\"error\":{\"message\":\"Unexpected value(s) `cache_control`\"}}"
        ));
        assert!(cache::is_cache_rejection(
            "HTTP 400: `ephemeral` is not a valid cache type"
        ));
        assert!(!cache::is_cache_rejection(
            "HTTP 429: rate limited"
        ));
        assert!(!cache::is_cache_rejection("request failed: connection reset"));
    }

    fn openai_turn_messages() -> Vec<Value> {
        let mut messages = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "go"}),
        ];
        for i in 0..5 {
            messages.push(json!({"role": "assistant", "content": "", "tool_calls": []}));
            messages.push(json!({"role": "tool", "tool_call_id": format!("t{i}"), "content": format!("result number {i} — {}", "x".repeat(1000))}));
        }
        messages
    }

    #[test]
    fn elision_keeps_newest_tool_results_verbatim_openai() {
        let mut messages = openai_turn_messages();
        elide_stale_tool_results(&mut messages, true);

        // 5 tool messages → the 2 oldest elide, the newest 3 stay verbatim.
        let tools: Vec<&Value> = messages
            .iter()
            .filter(|m| m["role"] == "tool")
            .collect();
        assert_eq!(tools.len(), 5);
        for (i, m) in tools.iter().enumerate() {
            let content = m["content"].as_str().unwrap();
            if i < 2 {
                assert!(content.starts_with(ELISION_MARKER), "tool {i} should be elided");
                assert!(content.contains(&format!("original {} chars", 1000 + format!("result number {i} — ").len())), "stub carries the original size: {content}");
                assert!(content.contains(&format!("result number {i}")), "stub keeps the head: {content}");
            } else {
                assert!(content.starts_with("result number"), "tool {i} must stay verbatim: {content}");
                assert!(content.contains("xxx"), "verbatim result keeps its body");
            }
        }
        // Non-tool messages untouched.
        assert_eq!(messages[0]["content"], "sys");
    }

    #[test]
    fn elision_is_idempotent() {
        let mut messages = openai_turn_messages();
        elide_stale_tool_results(&mut messages, true);
        let once = serde_json::to_string(&messages).unwrap();
        elide_stale_tool_results(&mut messages, true);
        let twice = serde_json::to_string(&messages).unwrap();
        assert_eq!(once, twice, "second pass must be a no-op");
    }

    #[test]
    fn elision_skips_small_turns() {
        let mut messages = vec![
            json!({"role": "user", "content": "go"}),
            json!({"role": "assistant", "content": "", "tool_calls": []}),
            json!({"role": "tool", "tool_call_id": "t1", "content": "a"}),
            json!({"role": "assistant", "content": "", "tool_calls": []}),
            json!({"role": "tool", "tool_call_id": "t2", "content": "b"}),
        ];
        elide_stale_tool_results(&mut messages, true);
        assert_eq!(messages[2]["content"], "a");
        assert_eq!(messages[4]["content"], "b");
    }

    #[test]
    fn elision_covers_anthropic_tool_result_blocks() {
        let mut messages = vec![json!({"role": "user", "content": "go"})];
        for i in 0..5 {
            messages.push(json!({"role": "assistant", "content": [
                {"type": "tool_use", "id": format!("t{i}"), "name": "read_file", "input": {}}
            ]}));
            messages.push(json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": format!("t{i}"), "content": format!("file body {i} — {}", "y".repeat(1000))}
            ]}));
        }
        elide_stale_tool_results(&mut messages, false);

        let results: Vec<&Value> = messages
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flat_map(|b| b.iter())
            .filter(|b| b["type"] == "tool_result")
            .collect();
        assert_eq!(results.len(), 5);
        for (i, b) in results.iter().enumerate() {
            let content = b["content"].as_str().unwrap();
            if i < 2 {
                assert!(content.starts_with(ELISION_MARKER), "result {i} should be elided");
                assert!(content.contains(&format!("file body {i}")), "stub keeps the head");
            } else {
                assert!(content.starts_with("file body"), "result {i} must stay verbatim");
            }
        }
        // Assistant tool_use echoes are never touched.
        assert!(messages[1]["content"][0].get("content").is_none());
        assert_eq!(messages[1]["content"][0]["type"], "tool_use");

        // And the Anthropic pass is idempotent too.
        let once = serde_json::to_string(&messages).unwrap();
        elide_stale_tool_results(&mut messages, false);
        assert_eq!(once, serde_json::to_string(&messages).unwrap());
    }

    fn openai_cache_req() -> ChatRequest {
        ChatRequest {
            model: "anthropic/claude-sonnet-4.5".to_string(),
            messages: vec![
                ChatMessage {
                    role: "user".to_string(),
                    content: "earlier".to_string(),
                    images: Vec::new(),
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: "earlier answer".to_string(),
                    images: Vec::new(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: "newest".to_string(),
                    images: Vec::new(),
                },
            ],
            max_tokens: Some(4096),
            system: Some("You are Relay.".to_string()),
            effort: None,
            thinking: None,
            local_docs_retrieval: Vec::new(),
            memory_context: None,
        }
    }

    #[test]
    fn openai_body_carries_cache_marks_only_when_requested() {
        let req = openai_cache_req();
        let msgs = vec![
            json!({"role": "system", "content": "You are Relay."}),
            json!({"role": "user", "content": "earlier"}),
            json!({"role": "user", "content": "newest"}),
        ];
        let specs = vec![json!({"type": "function", "function": {"name": "read_file"}})];

        // Marks OFF (native OpenAI / compatible / LocalGguf): no cache_control
        // anywhere, plain string content preserved.
        let plain = build_openai_body(&req, &msgs, &specs, false);
        let flat = serde_json::to_string(&plain).unwrap();
        assert!(!flat.contains("cache_control"), "{flat}");
        assert_eq!(plain["messages"][0]["content"], "You are Relay.");
        assert_eq!(plain["messages"][2]["content"], "newest");

        // Marks ON (OpenRouter → anthropic/*): system converted to a cached
        // content-block array, newest message marked, middle untouched, tools
        // never marked.
        let marked = build_openai_body(&req, &msgs, &specs, true);
        assert_eq!(marked["messages"][0]["content"][0]["type"], "text");
        assert_eq!(
            marked["messages"][0]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert!(marked["messages"][1]["content"].is_string());
        assert_eq!(
            marked["messages"][2]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        assert!(!serde_json::to_string(&marked["tools"])
            .unwrap()
            .contains("cache_control"));

        // The caller's working arrays stay pristine.
        assert_eq!(msgs[0]["content"], "You are Relay.");
        assert_eq!(msgs[2]["content"], "newest");
    }

    #[test]
    fn openai_body_marks_survive_a_missing_system_message() {
        let mut req = openai_cache_req();
        req.system = None;
        let msgs = vec![json!({"role": "user", "content": "only"})];
        let marked = build_openai_body(&req, &msgs, &[], true);
        let flat = serde_json::to_string(&marked).unwrap();
        // No system message to mark; the single message still gets the
        // newest-message breakpoint.
        assert_eq!(marked["messages"][0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(!flat.contains("\"role\":\"system\""));
    }

    #[test]
    fn openai_body_keeps_effort_and_thinking_fields() {
        let mut req = openai_cache_req();
        req.effort = Some("low".to_string());
        req.thinking = Some(true);
        let body = build_openai_body(&req, &[], &[], false);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }
}
