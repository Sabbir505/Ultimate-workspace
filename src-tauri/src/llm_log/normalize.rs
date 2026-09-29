//! Telemetry extraction from a captured local-model HTTP exchange.
//!
//! # Why this is separate from the proxy
//!
//! The gateway forwards bytes verbatim and never interprets a stream — it
//! cannot corrupt a response, and streaming stays unbuffered. What it does do
//! is keep a *copy* of what it forwarded, and hand that copy here. So this
//! module is allowed to be wrong in a way the proxy is not: every field is
//! `Option`, a renamed field in a future runtime costs us a re-parse of
//! already-stored rows, never a re-capture.
//!
//! # The three wire formats, as measured
//!
//! Formats were confirmed against a live `llama-server` (v0.1.2-dev, commit
//! a698f1c), not read off a doc page, and two details differ from what the
//! vendor docs suggest:
//!
//! | runtime | framing | where the telemetry lives |
//! |---|---|---|
//! | llama.cpp | SSE `data: {…}\n\n`, ends `data: [DONE]` | `timings` on the **same chunk that carries `finish_reason`** — there is no later telemetry event. Streaming chunks carry **no `usage` block at all**. |
//! | llama.cpp (non-stream) | one JSON object | both `usage` and `timings`; `usage.prompt_tokens` counts cached tokens that `timings.prompt_n` omits |
//! | Ollama | **newline-delimited bare JSON** — no `data:` prefix | final object with `done: true`; durations in nanoseconds |
//! | LM Studio | SSE with **named events** (`event: chat.end`) | `usage` + `stats` on the `chat.end` payload |
//!
//! `usage` is preferred over `timings` for token counts where both exist,
//! because it is the canonical count; `timings` supplies throughput.

use serde_json::Value;

/// How the response body is framed on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    /// One JSON object per line, no prefix. Ollama.
    Ndjson,
    /// `data: {…}` frames, optionally with `event:` names. llama.cpp, LM Studio.
    Sse,
    /// A single JSON object. Non-streaming responses, and our own log API.
    Json,
}

/// Best-effort telemetry. Every field optional; a missing or renamed field in
/// the runtime yields `None`, never an error.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Telemetry {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub tokens_per_second: Option<f64>,
    pub ttft_ms: Option<i64>,
    /// The runtime's own timings object, kept unparsed so it survives a
    /// normalizer fix and preserves fields we don't read.
    pub timings: Option<Value>,
    /// True when this was a streamed exchange (vs. one JSON object).
    pub streamed: bool,
    /// The runtime's completion id, when it exposes one (`chatcmpl-…` on
    /// llama.cpp). Useful for correlating a log row with an upstream trace.
    pub response_id: Option<String>,
}

/// Sniff the framing from the first non-blank bytes.
///
/// Deliberately conservative: anything that doesn't look like a `data:` or
/// `event:` line is treated as NDJSON, which is what Ollama emits and what a
/// single JSON object also parses as (its first line is a complete object).
pub fn detect_framing(body: &str) -> Framing {
    for line in body.lines() {
        let l = line.trim_start();
        if l.is_empty() {
            continue;
        }
        if l.starts_with("data:") || l.starts_with("event:") {
            return Framing::Sse;
        }
        // A line that is itself a complete JSON object means Json, not Ndjson —
        // the distinction only matters for how we iterate, and both yield the
        // same single object.
        break;
    }
    if body.lines().filter(|l| !l.trim().is_empty()).count() > 1 {
        Framing::Ndjson
    } else {
        Framing::Json
    }
}

/// Parse every SSE data payload, keeping the `event:` name that preceded it.
///
/// SSE comment lines (`: keep-alive`, emitted by llama.cpp on `--sse-ping-interval`)
/// are skipped, and a `data: [DONE]` sentinel terminates collection rather
/// than being fed to the JSON parser.
fn sse_payloads(body: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let mut event = String::new();
    for line in body.lines() {
        let l = line.trim_end_matches('\r');
        if l.is_empty() {
            continue;
        }
        // SSE comment / keep-alive.
        if l.starts_with(':') {
            continue;
        }
        if let Some(rest) = l.strip_prefix("event:") {
            event = rest.trim().to_string();
            continue;
        }
        if let Some(rest) = l.strip_prefix("data:") {
            let data = rest.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                break;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                out.push((event.clone(), v));
            }
        }
    }
    out
}

/// Extract telemetry from a captured response body.
///
/// `ttft_hint_ms` is what the transport measured (time to first byte), used
/// only when the runtime doesn't report its own time-to-first-token.
pub fn extract(body: &str, framing: Framing, ttft_hint_ms: Option<i64>) -> Telemetry {
    match framing {
        Framing::Json => match serde_json::from_str::<Value>(body) {
            Ok(v) => from_single(&v, ttft_hint_ms),
            Err(_) => Telemetry::default(),
        },
        Framing::Ndjson => extract_ndjson(body, ttft_hint_ms),
        Framing::Sse => extract_sse(body, ttft_hint_ms),
    }
}

/// Ollama: newline-delimited JSON. The telemetry rides on the last object
/// that reports `done: true`; durations are nanoseconds.
fn extract_ndjson(body: &str, ttft_hint_ms: Option<i64>) -> Telemetry {
    let mut best: Option<Value> = None;
    let mut any = false;
    for line in body.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        any = true;
        if v.get("done").and_then(Value::as_bool) == Some(true) {
            best = Some(v);
        } else if best.is_none() {
            best = Some(v);
        }
    }
    let mut t = best.map(|v| from_single(&v, ttft_hint_ms)).unwrap_or_default();
    if any {
        t.streamed = true;
    }
    t
}

/// llama.cpp / LM Studio: SSE. Scan every payload, not just the last — LM
/// Studio's `chat.end` is the aggregate, but a plain OpenAI-compatible server
/// puts `usage` on the final chunk, and we don't know which we're looking at
/// until we've read them all.
fn extract_sse(body: &str, ttft_hint_ms: Option<i64>) -> Telemetry {
    let payloads = sse_payloads(body);
    let mut t = Telemetry { streamed: true, ..Default::default() };
    if payloads.is_empty() {
        return t;
    }
    // Later payloads win, so the aggregate event overrides earlier deltas.
    for (event, v) in &payloads {
        let candidate = from_single(v, ttft_hint_ms);
        // LM Studio's stats live under `stats` on the chat.end payload.
        if let Some(stats) = v.get("stats") {
            merge_stats(&mut t, stats);
        }
        let _ = event;
        merge(&mut t, candidate);
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            t.response_id = Some(id.to_string());
        }
        if let Some(obj) = v.get("object").and_then(Value::as_str) {
            if obj.contains("chunk") || obj.contains("completion") {
                t.streamed = true;
            }
        }
    }
    // Prefer a named terminal event's usage when present.
    if let Some((_, v)) = payloads.iter().rev().find(|(e, _)| e == "chat.end") {
        let c = from_single(v, ttft_hint_ms);
        merge(&mut t, c);
        if let Some(stats) = v.get("stats") {
            merge_stats(&mut t, stats);
        }
    }
    t
}

/// Merge `other` into `t`, letting non-None values in `other` win.
fn merge(t: &mut Telemetry, other: Telemetry) {
    if other.input_tokens.is_some() { t.input_tokens = other.input_tokens; }
    if other.output_tokens.is_some() { t.output_tokens = other.output_tokens; }
    if other.tokens_per_second.is_some() { t.tokens_per_second = other.tokens_per_second; }
    if other.ttft_ms.is_some() { t.ttft_ms = other.ttft_ms; }
    if other.timings.is_some() { t.timings = other.timings; }
    if other.response_id.is_some() { t.response_id = other.response_id; }
}

/// LM Studio's `stats` object.
fn merge_stats(t: &mut Telemetry, stats: &Value) {
    if let Some(v) = stats.get("tokens_per_second").and_then(Value::as_f64) {
        t.tokens_per_second = Some(v);
    }
    if let Some(v) = stats.get("time_to_first_token").and_then(Value::as_f64) {
        t.ttft_ms = Some(v.round() as i64);
    }
}

/// Read one JSON object, in whichever dialect it speaks.
///
/// Handles all three shapes at once because the fields barely collide:
///   - OpenAI-compatible: `usage.{prompt_tokens,completion_tokens}`
///   - llama.cpp:         `timings.{prompt_n,predicted_n,predicted_per_second}`
///   - Ollama:            `prompt_eval_count` / `eval_count` + `*_duration` (ns)
fn from_single(v: &Value, ttft_hint_ms: Option<i64>) -> Telemetry {
    let mut t = Telemetry::default();

    if let Some(id) = v.get("id").and_then(Value::as_str) {
        t.response_id = Some(id.to_string());
    }

    // ── usage (OpenAI-compatible, LM Studio) ──
    if let Some(u) = v.get("usage") {
        t.input_tokens = u.get("prompt_tokens").and_then(Value::as_i64);
        t.output_tokens = u.get("completion_tokens").and_then(Value::as_i64);
    }

    // ── timings (llama.cpp) ──
    if let Some(tim) = v.get("timings") {
        t.timings = Some(tim.clone());
        if t.input_tokens.is_none() {
            t.input_tokens = tim.get("prompt_n").and_then(Value::as_i64);
        }
        if t.output_tokens.is_none() {
            t.output_tokens = tim.get("predicted_n").and_then(Value::as_i64);
        }
        if let Some(tps) = tim.get("predicted_per_second").and_then(Value::as_f64) {
            t.tokens_per_second = Some(tps);
        }
    }

    // ── Ollama ──
    // Read each field independently rather than gating the block on one of
    // them: a runtime that renames `prompt_eval_count` should still have its
    // `eval_count` picked up, not lose the whole Ollama dialect.
    if let Some(c) = v.get("prompt_eval_count").and_then(Value::as_i64) {
        t.input_tokens = Some(c);
    }
    if let Some(c) = v.get("eval_count").and_then(Value::as_i64) {
        t.output_tokens = Some(c);
    }
    // Nanoseconds → milliseconds. `prompt_eval_duration` is prefill, which is
    // the whole wait before the first token.
    if let Some(ns) = v.get("prompt_eval_duration").and_then(Value::as_i64) {
        t.ttft_ms = Some(ns / 1_000_000);
    }
    if t.tokens_per_second.is_none() {
        let eval_ns = v.get("eval_duration").and_then(Value::as_i64).unwrap_or(0);
        let eval_n = v.get("eval_count").and_then(Value::as_i64).unwrap_or(0);
        if eval_ns > 0 && eval_n > 0 {
            t.tokens_per_second = Some(eval_n as f64 / (eval_ns as f64 / 1e9));
        }
    }

    if t.ttft_ms.is_none() {
        t.ttft_ms = ttft_hint_ms;
    }
    t
}

/// Best-effort model name from a request body, for pre-filling the log row
/// before the response arrives.
pub fn model_from_request(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    v.get("model").and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Fixtures captured verbatim from a live llama-server 0.1.2-dev ──

    /// The real terminal frame of a streamed /v1/chat/completions response:
    /// `timings` rides on the SAME chunk as `finish_reason`, and there is no
    /// `usage` block anywhere in the stream.
    const LLAMA_FINAL_CHUNK: &str = concat!(
        r#"data: {"choices":[{"finish_reason":"length","index":0,"delta":{}}],"#,
        r#""created":1790681720,"id":"chatcmpl-9UlrvaxMIRtQ4xMQsSnX5ZW0tqdMvSMk","#,
        r#""model":"MiniCPM5-2B-Q8_0.gguf","system_fingerprint":"b1-a698f1c","#,
        r#""object":"chat.completion.chunk","timings":{"cache_n":0,"prompt_n":17,"#,
        r#""prompt_ms":255.22,"prompt_per_token_ms":15.012941176470589,"#,
        r#""prompt_per_second":66.60919990596348,"predicted_n":24,"#,
        r#""predicted_ms":343.648,"predicted_per_token_ms":14.941217391304349,"#,
        r#""predicted_per_second":66.9289505540553}}"#,
        "\n\ndata: [DONE]\n\n"
    );

    /// Real non-streaming response (fields trimmed; shape verbatim).
    const LLAMA_NONSTREAM: &str = concat!(
        r#"{"choices":[{"finish_reason":"length","index":0,"message":{"role":"assistant","content":""}}],"#,
        r#""created":1790681720,"model":"MiniCPM5-2B-Q8_0.gguf","system_fingerprint":"b1-a698f1c","#,
        r#""object":"chat.completion","usage":{"completion_tokens":16,"prompt_tokens":13,"#,
        r#""total_tokens":29,"prompt_tokens_details":{"cached_tokens":6}},"id":"chatcmpl-tNJog","#,
        r#""timings":{"cache_n":6,"prompt_n":7,"prompt_ms":35.108,"prompt_per_token_ms":5.015428571428571,"#,
        r#""prompt_per_second":199.3847556112567,"predicted_n":16,"prompt_ms":405.928,"#,
        r#""predicted_per_token_ms":27.061866666666667,"predicted_per_second":36.952365936816385}}"#,
    );

    /// The real Ollama terminal object from the documented `/api/chat` stream.
    const OLLAMA_FINAL: &str = concat!(
        r#"{"model":"llama3.2","created_at":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":"hi"},"#,
        r#""done_reason":"stop","done":true,"total_duration":5043500667,"load_duration":5025959,"#,
        r#""prompt_eval_count":26,"prompt_eval_duration":325953000,"eval_count":290,"eval_duration":4709213000}"#,
    );

    const OLLAMA_STREAM: &str = concat!(
        "{\"model\":\"llama3.2\",\"created_at\":\"x\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":false}\n",
        "{\"model\":\"llama3.2\",\"created_at\":\"x\",\"message\":{\"role\":\"assistant\",\"content\":\"Hi\"},\"done\":false}\n",
        "{\"model\":\"llama3.2\",\"created_at\":\"x\",\"message\":{\"role\":\"assistant\",\"content\":\"hi\"},\"done\":true,\"total_duration\":5043500667,\"load_duration\":5025959,\"prompt_eval_count\":26,\"prompt_eval_duration\":325953000,\"eval_count\":290,\"eval_duration\":4709213000}\n"
    );

    /// LM Studio's named-event stream, per its documented event vocabulary.
    const LMSTUDIO_STREAM: &str = concat!(
        "event: chat.start\ndata: {\"type\":\"chat.start\"}\n\n",
        "event: prompt_processing.start\ndata: {\"type\":\"prompt_processing.start\"}\n\n",
        "event: message.delta\ndata: {\"type\":\"message.delta\",\"delta\":\"Hi\"}\n\n",
        ": keep-alive\n\n",
        "event: chat.end\ndata: {\"id\":\"lm-1\",\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":8,\"total_tokens\":38},",
        "\"stats\":{\"tokens_per_second\":64.5,\"time_to_first_token\":210,\"generation_time\":124,\"stop_reason\":\"eosFound\"}}\n\n"
    );

    // ── framing detection ──

    #[test]
    fn detects_each_framing() {
        assert_eq!(detect_framing(LLAMA_FINAL_CHUNK), Framing::Sse);
        assert_eq!(detect_framing(OLLAMA_STREAM), Framing::Ndjson);
        assert_eq!(detect_framing(LLAMA_NONSTREAM), Framing::Json);
    }

    // ── llama.cpp ──

    #[test]
    fn llama_streaming_reads_timings_and_no_usage() {
        let t = extract(LLAMA_FINAL_CHUNK, Framing::Sse, None);
        // No `usage` block exists in the stream — timings is the only source.
        assert_eq!(t.input_tokens, Some(17));
        assert_eq!(t.output_tokens, Some(24));
        let tps = t.tokens_per_second.expect("predicted_per_second");
        assert!((tps - 66.9289505540553).abs() < 1e-9);
        assert!(t.streamed);
        assert_eq!(t.response_id.as_deref(), Some("chatcmpl-9UlrvaxMIRtQ4xMQsSnX5ZW0tqdMvSMk"));
        // The runtime's timings object survives unparsed.
        assert_eq!(t.timings.unwrap().get("cache_n").and_then(|v| v.as_i64()), Some(0));
    }

    #[test]
    fn llama_nonstream_prefers_usage_over_timings() {
        let t = extract(LLAMA_NONSTREAM, Framing::Json, None);
        // usage.prompt_tokens=13 counts the 6 cached tokens that
        // timings.prompt_n=7 omits — usage is the canonical count.
        assert_eq!(t.input_tokens, Some(13));
        assert_eq!(t.output_tokens, Some(16));
        let tps = t.tokens_per_second.expect("predicted_per_second");
        assert!((tps - 36.952365936816385).abs() < 1e-9);
        assert!(!t.streamed);
    }

    #[test]
    fn skips_sse_comment_pings_and_the_done_sentinel() {
        let t = extract(LMSTUDIO_STREAM, Framing::Sse, None);
        assert_eq!(t.input_tokens, Some(30), "comment lines must not break parsing");
    }

    // ── Ollama ──

    #[test]
    fn ollama_ndjson_takes_the_done_object_and_converts_nanoseconds() {
        let t = extract(OLLAMA_STREAM, Framing::Ndjson, None);
        assert_eq!(t.input_tokens, Some(26));
        assert_eq!(t.output_tokens, Some(290));
        // prompt_eval_duration = 325_953_000 ns → 325.953 ms.
        assert_eq!(t.ttft_ms, Some(325));
        let tps = t.tokens_per_second.expect("derived tok/s");
        assert!((tps - 290.0 / 4.709213).abs() < 0.01, "got {tps}");
        assert!(t.streamed);
    }

    #[test]
    fn ollama_never_invents_sse_framing() {
        // The whole point of the passthrough design: a body with no `data:`
        // prefix must still parse, because that is what Ollama sends.
        assert!(!OLLAMA_STREAM.contains("data:"));
        assert!(extract(OLLAMA_STREAM, Framing::Ndjson, None).output_tokens.is_some());
    }

    // ── LM Studio ──

    #[test]
    fn lmstudio_reads_named_event_stats() {
        let t = extract(LMSTUDIO_STREAM, Framing::Sse, None);
        assert_eq!(t.input_tokens, Some(30));
        assert_eq!(t.output_tokens, Some(8));
        assert_eq!(t.ttft_ms, Some(210));
        let tps = t.tokens_per_second.expect("stats.tokens_per_second");
        assert!((tps - 64.5).abs() < 1e-9);
        assert_eq!(t.response_id.as_deref(), Some("lm-1"));
    }

    // ── tolerance ──

    #[test]
    fn a_renamed_field_yields_null_not_an_error() {
        let body = r#"{"done":true,"prompt_eval_cnt":26,"eval_count":3}"#;
        let t = extract(body, Framing::Json, None);
        assert_eq!(t.input_tokens, None, "unknown field must not be guessed at");
        assert_eq!(t.output_tokens, Some(3));
    }

    #[test]
    fn garbage_never_panics() {
        for body in ["", "not json", "data: {broken", "\u{0}\u{1}", "data: [DONE]", "{"] {
            let _ = extract(body, detect_framing(body), Some(7));
        }
    }

    #[test]
    fn transport_ttft_is_the_fallback_when_the_runtime_is_silent() {
        let t = extract(r#"{"choices":[],"id":"x"}"#, Framing::Json, Some(42));
        assert_eq!(t.ttft_ms, Some(42));
    }

    #[test]
    fn runtime_reported_ttft_beats_the_transport_hint() {
        let t = extract(OLLAMA_FINAL, Framing::Json, Some(42));
        assert_eq!(t.ttft_ms, Some(325));
    }

    #[test]
    fn reads_the_model_out_of_a_request_body() {
        assert_eq!(
            model_from_request(r#"{"model":"MiniCPM5-2B-Q8_0.gguf","messages":[]}"#).as_deref(),
            Some("MiniCPM5-2B-Q8_0.gguf")
        );
        assert_eq!(model_from_request("garbage"), None);
        assert_eq!(model_from_request(r#"{"messages":[]}"#), None);
    }
}
