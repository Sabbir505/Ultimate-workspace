//! Per-turn performance accumulator.
//!
//! Captures the timing the composer metrics row needs (and that
//! `ChatDonePayload`/`chat_messages` persist):
//! - **TTFT** — from the first generation window's opening (the moment the
//!   first model request is issued) to the first streamed delta of any kind
//!   (text, thinking, or tool-argument JSON). Pre-flight setup — checkpoint
//!   baselines, connector/MCP attaches, docs retrieval — happens BEFORE the
//!   first `begin_gen` and is deliberately excluded; the HUD's `elapsed` chip
//!   carries wall-clock-from-turn-start.
//! - **LLM time** — cumulative wall-clock the model round is in flight: each
//!   generation round opens a window on `begin_gen` and closes it when the
//!   round's stream completes (or on `end_gen`). Includes connect + prompt
//!   eval + decode. Tool execution and approval waits fall *outside* these
//!   windows.
//! - **Decode time** — the sub-span of each generation window from that
//!   window's FIRST streamed delta to the window close, i.e. pure token
//!   emission with the prefill/queueing excluded.
//! - **tok/s** — `output_tokens / decode_ms` (streaming and final alike), so
//!   the live chip and the persisted final converge on the same definition
//!   instead of drifting. The final value uses the provider's authoritative
//!   usage output count; the live value uses text-delta event counts.
//! - **Tool time** — cumulative wall-clock spent *executing* tools, measured
//!   by `begin_tool`/`end_tool` around just the execution segment (approval
//!   waits are excluded by construction — the gate resolves before the
//!   execution segment begins).
//!
//! A throttled `chat:perf` event (~every 500ms during streaming) carries a
//! live snapshot so the composer row updates without waiting for `chat:done`.
//! Round-boundary usage (prompt tokens + cache fields) folds in via
//! `note_round_usage` so IN/CACHE can render live too.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::types::ChatPerfPayload;

/// Per-session registry of the *active* `TurnPerf`, so the token hot path
/// (`chat::dispatch::emit_token`, `agent_sessions::emit_token`) can call
/// `record_token`/`maybe_emit_perf` without threading a reference through
/// every stream helper. Registered when a turn starts and cleared when it
/// ends — same lifecycle as `stream_events`. Mirrors `stream_events`' simple
/// global `parking_lot::Mutex` map.
type ActiveRegistry = Arc<Mutex<HashMap<String, TurnPerf>>>;

static ACTIVE: once_cell::sync::Lazy<ActiveRegistry> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Register the active `TurnPerf` for a session. Calling code holds the
/// returned `TurnPerf` clone for its own reads; the registry is for the emit
/// hot path.
///
/// Also starts a 500ms heartbeat that emits `chat:perf` for as long as this
/// perf remains the session's active one. The token-driven emits only start
/// with the FIRST token, and prompt eval can take tens of seconds — without
/// the heartbeat the UI's "Working for Xs" timer had no data until the first
/// token and then jumped straight to e.g. "1min". Spawned through
/// `tauri::async_runtime` (NOT `Handle::try_current`) because harness reader
/// threads are plain `std::thread`s with no ambient tokio context — the
/// try_current guard made the heartbeat silently vanish exactly where the
/// harness HUD needed it most.
pub fn register(session_id: &str, perf: TurnPerf) -> TurnPerf {
    ACTIVE.lock().insert(session_id.to_string(), perf.clone());
    let sid = session_id.to_string();
    let heartbeat = perf.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            interval.tick().await;
            let still_active = {
                ACTIVE.lock().get(&sid).is_some_and(|p| {
                    Arc::ptr_eq(&p.inner, &heartbeat.inner)
                })
            };
            if !still_active {
                break;
            }
            heartbeat.maybe_emit_perf();
        }
    });
    perf
}

/// Clear the active `TurnPerf` for a session. Call at turn end/error.
pub fn unregister(session_id: &str) {
    ACTIVE.lock().remove(session_id);
}

/// Call `record_token` + `maybe_emit_perf` on the session's active `TurnPerf`
/// if one is registered. Idempotent no-op when none is (non-streamed paths).
pub fn record_active_token(session_id: &str) {
    if let Some(p) = ACTIVE.lock().get(session_id) {
        p.record_token();
        p.maybe_emit_perf();
    }
}

/// Note that a provider stream delta arrived on the session's active
/// `TurnPerf` (TTFT capture + decode-window stamping). Called from the SSE
/// round loops on every delta event; cheap when the first delta already
/// landed. Idempotent no-op when none is registered.
pub fn record_active_stream_delta(session_id: &str) {
    if let Some(p) = ACTIVE.lock().get(session_id) {
        p.record_stream_delta();
    }
}

/// Open a generation window on the session's active accumulator. The harness
/// reader loops don't hold `TurnPerf` handles (they parse CLI event streams
/// through shared handlers), so they act through the registry. No-op when
/// none is registered or a window is already open.
pub fn begin_active_gen(session_id: &str) {
    if let Some(p) = ACTIVE.lock().get(session_id) {
        p.begin_gen();
    }
}

/// Close the open generation window on the session's active accumulator.
/// No-op when none is registered or no window is open.
pub fn end_active_gen(session_id: &str) {
    if let Some(p) = ACTIVE.lock().get(session_id) {
        p.end_gen();
    }
}

/// Fold one PER-ROUND usage report into the live IN/CACHE totals (claude's
/// `message_start` reports each round's prompt separately, so reports
/// accumulate to the turn total). No-op when none is registered.
pub fn note_active_round_usage(
    session_id: &str,
    input_tokens: i64,
    cache_read: i64,
    cache_creation: i64,
    input_includes_cache: bool,
) {
    if let Some(p) = ACTIVE.lock().get(session_id) {
        p.note_round_usage(input_tokens, cache_read, cache_creation, input_includes_cache);
    }
}

/// REPLACE the live IN/CACHE totals with a turn-cumulative usage report.
/// Kimi/pi/omp/commandcode/opencode report running totals (not per-round
/// deltas), so accumulating them would double-count — the latest report wins,
/// mirroring how the handlers derive the final done values (last report
/// overwrites). No-op when none is registered.
pub fn set_active_round_usage(
    session_id: &str,
    input_tokens: i64,
    cache_read: i64,
    cache_creation: i64,
    input_includes_cache: bool,
) {
    if let Some(p) = ACTIVE.lock().get(session_id) {
        let mut g = p.inner.lock();
        g.ru_input = input_tokens;
        g.ru_cache_read = cache_read;
        g.ru_cache_creation = cache_creation;
        g.ru_inclusive = input_includes_cache;
        g.ru_seen = true;
    }
}

/// Final stats for a finishing harness turn from the active accumulator:
/// `(ttft_ms, tokens_per_second, llm_time_ms)`. Any window still open is
/// closed first (tool-less turns never hit an explicit end marker), and tok/s
/// uses the provider's authoritative output count against the accumulated
/// decode time. All `None` when no accumulator is registered.
pub fn active_harness_final(
    session_id: &str,
    output_tokens: Option<i64>,
) -> (Option<i64>, Option<f64>, Option<i64>) {
    let Some(p) = ACTIVE.lock().get(session_id).cloned() else {
        return (None, None, None);
    };
    p.close_open_windows();
    let g = p.inner.lock();
    let tok_s = output_tokens.and_then(|o| tokens_per_second(o, g.decode_ms));
    (g.ttft_ms, tok_s, (g.llm_time_ms > 0).then_some(g.llm_time_ms))
}

/// Read the session's active `TurnPerf` snapshot for a live `chat:perf`
/// event (used by the throttled emitter).
pub fn active_snapshot(session_id: &str) -> Option<ChatPerfPayload> {
    ACTIVE.lock().get(session_id).map(|p| p.snapshot())
}

/// Weak read of the active perf's cumulative counters (for `shallow` reads
/// in e.g. tests). Prefer `TurnPerf` methods directly when you hold a handle.
pub fn active_llm_time_ms(session_id: &str) -> Option<i64> {
    ACTIVE.lock().get(session_id).and_then(|p| p.llm_time_ms())
}

const PERF_EMIT_INTERVAL_MS: u128 = 500;

/// Cache-hit rate helper: `cache_read / total_billed_prompt`.
///
/// Providers split the prompt two ways:
///  * Anthropic reports `input_tokens` as the *uncached* prompt, with
///    `cache_read_input_tokens` and `cache_creation_input_tokens` billed
///    separately — total prompt = input + cache_read + cache_creation.
///  * OpenAI-style providers report `prompt_tokens` already INCLUSIVE of
///    `prompt_tokens_details.cached_tokens` — total prompt = input (pass
///    `input_includes_cache: true` so the cached tokens aren't counted
///    twice).
///
/// Returns `None` when the provider reported no cache activity at all (both
/// cache fields zero) — the UI then hides the chip rather than showing a
/// misleading "0%" for providers that simply don't report cache splits — and
/// when no input was billed.
pub fn cache_hit_rate(
    cache_read: i64,
    cache_creation: i64,
    input_tokens: i64,
    input_includes_cache: bool,
) -> Option<f64> {
    if cache_read <= 0 && cache_creation <= 0 {
        return None;
    }
    let total_prompt = if input_includes_cache {
        // `input_tokens` already contains the cached tokens. `.max(cache_read)`
        // guards compatible backends reporting cached > prompt.
        input_tokens.max(cache_read)
    } else {
        input_tokens + cache_read + cache_creation
    };
    if total_prompt <= 0 {
        return None;
    }
    Some(cache_read as f64 / total_prompt as f64)
}

struct Inner {
    /// Instant the turn started (captured in `TurnPerf::new`) — drives the
    /// wall-clock `elapsedMs` chip only.
    started: Instant,
    /// Instant the FIRST generation window opened — the TTFT baseline. Pre-
    /// flight setup (checkpoints, connector/MCP attaches, retrieval) runs
    /// before this and is excluded from TTFT by construction.
    first_gen_start: Option<Instant>,
    /// Cumulative ms the model round was in flight (connect + prefill +
    /// decode) across all rounds.
    llm_time_ms: i64,
    /// Cumulative ms from each round's first streamed delta to that round's
    /// close — pure decode, prefill excluded. The tok/s denominator.
    decode_ms: i64,
    /// Cumulative ms spent executing tools (excluding approval waits).
    tool_time_ms: i64,
    /// Time from `first_gen_start` to the first streamed delta of any kind
    /// (ms). `None` until the first delta arrives.
    ttft_ms: Option<i64>,
    /// Start of the current open generation window, if one is in progress.
    /// `None` between rounds (e.g. while a tool executes).
    gen_start: Option<Instant>,
    /// First streamed delta inside the current open generation window — the
    /// decode-span anchor for this round. `None` until the round's first
    /// delta (a round that dies before emitting contributes 0 decode time).
    window_first_delta: Option<Instant>,
    /// Start of the current open tool-execution window, if one is in progress.
    tool_start: Option<Instant>,
    /// Whether the first stream delta has been seen yet (drives TTFT capture).
    first_token_seen: bool,
    /// Last instant we emitted a `chat:perf` event (throttle gate).
    last_perf_emit: Option<Instant>,
    /// Output tokens generated so far in this turn (for live tok/s). Counts
    /// text/thinking delta events only — structural markers (`<tool>` blocks,
    /// `<think>` tags, result cards) don't record. The provider's usage at
    /// turn end is authoritative; this is a running estimate.
    output_tokens: i64,
    /// Running totals of the round-boundary usage reported so far via
    /// `note_round_usage`, for the live IN/CACHE chips. `ru_seen` gates
    /// "no usage yet" vs zero.
    ru_input: i64,
    ru_cache_read: i64,
    ru_cache_creation: i64,
    ru_inclusive: bool,
    ru_seen: bool,
}

impl Inner {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            first_gen_start: None,
            llm_time_ms: 0,
            decode_ms: 0,
            tool_time_ms: 0,
            ttft_ms: None,
            gen_start: None,
            window_first_delta: None,
            tool_start: None,
            first_token_seen: false,
            last_perf_emit: None,
            output_tokens: 0,
            ru_input: 0,
            ru_cache_read: 0,
            ru_cache_creation: 0,
            ru_inclusive: false,
            ru_seen: false,
        }
    }
}

/// Per-turn perf accumulator. Shared between the streaming code (which calls
/// the record methods) and the turn-finalization code (which reads
/// `llm_time_ms`/`tool_time_ms`/`ttft_ms` for `ChatDonePayload` + the DB
/// row). Wrapped in `Arc<Mutex<Inner>>` so the free functions in the hot
/// stream path can mutably update it without a `&mut self` borrow.
#[derive(Clone)]
pub struct TurnPerf {
    app: Option<AppHandle>,
    sid: String,
    inner: Arc<Mutex<Inner>>,
}

impl TurnPerf {
    /// App-optional constructor: `chat:perf` flows only when an AppHandle is
    /// available. Harness reader threads pass the chat's handle; headless
    /// tests (and any path without an app) pass None.
    pub fn new_opt(app: Option<AppHandle>, sid: &str) -> Self {
        Self {
            app,
            sid: sid.to_string(),
            inner: Arc::new(Mutex::new(Inner::new())),
        }
    }

    pub fn new(app: AppHandle, sid: &str) -> Self {
        Self::new_opt(Some(app), sid)
    }

    /// A no-backend variant for paths that don't have an `AppHandle` handy
    /// (e.g. headless tests). Records timing but never emits `chat:perf`.
    pub fn new_headless(sid: &str) -> Self {
        Self::new_opt(None, sid)
    }

    /// Open a generation window. Called when a model round's stream starts
    /// (the SSE loop begins reading). Idempotent — a second call while a
    /// window is open is a no-op (defensive against double-entry). The first
    /// window's opening instant becomes the TTFT baseline.
    pub fn begin_gen(&self) {
        let mut g = self.inner.lock();
        if g.gen_start.is_some() {
            return;
        }
        let now = Instant::now();
        if g.first_gen_start.is_none() {
            g.first_gen_start = Some(now);
        }
        g.gen_start = Some(now);
    }

    /// Fold the open generation window into `llm_time_ms` (full window) and
    /// `decode_ms` (first delta → close). Shared by `end_gen` (round stream
    /// completed) and `begin_tool` (tool call interrupted the window).
    fn close_gen_locked(g: &mut Inner) {
        if let Some(start) = g.gen_start.take() {
            g.llm_time_ms += start.elapsed().as_millis() as i64;
            if let Some(first) = g.window_first_delta.take() {
                g.decode_ms += first.elapsed().as_millis() as i64;
            }
        }
    }

    /// Close the current generation window. Called when a model round's
    /// stream completes (the SSE loop returns) — including the final round.
    /// No-op when no window is open (e.g. a round that produced zero tokens).
    pub fn end_gen(&self) {
        let mut g = self.inner.lock();
        Self::close_gen_locked(&mut g);
    }

    /// Close any open generation/tool windows without recording new ones.
    /// Insurance for finalization paths: a successful turn normally closes
    /// its windows via `end_gen`/`end_tool`, but a window left open by a
    /// future code path would otherwise silently miss its time.
    pub fn close_open_windows(&self) {
        let mut g = self.inner.lock();
        Self::close_gen_locked(&mut g);
        if let Some(start) = g.tool_start.take() {
            g.tool_time_ms += start.elapsed().as_millis() as i64;
        }
    }

    /// Note that a provider stream delta arrived (any kind: text, thinking,
    /// or tool-argument JSON). Captures TTFT on the first delta of the turn
    /// and anchors the open window's decode span. Does NOT bump the
    /// output-token estimate — that stays on the text-token path
    /// (`record_token`).
    pub fn record_stream_delta(&self) {
        let mut g = self.inner.lock();
        stream_delta_locked(&mut g);
    }

    /// Record an output token. Marks TTFT on the first call, anchors the
    /// open window's decode span, and bumps the running output-token count
    /// (best-effort — counts text-delta *events*, a good proxy for output
    /// tokens during streaming; the authoritative count comes from usage at
    /// turn end).
    pub fn record_token(&self) {
        let mut g = self.inner.lock();
        stream_delta_locked(&mut g);
        g.output_tokens += 1;
    }

    /// Open a tool-execution window. Called just before the tool executes
    /// (after any approval gate has resolved, so approval waits are excluded
    /// by construction). Idempotent.
    pub fn begin_tool(&self) {
        let mut g = self.inner.lock();
        if g.tool_start.is_some() {
            return;
        }
        // A tool call interrupts the current generation window — close it so
        // the wait for the tool result isn't counted as LLM time. The next
        // model round re-opens a window via `begin_gen`.
        Self::close_gen_locked(&mut g);
        g.tool_start = Some(Instant::now());
    }

    /// Close the current tool-execution window and fold its elapsed time
    /// into `tool_time_ms`. No-op when no window is open.
    pub fn end_tool(&self) {
        let mut g = self.inner.lock();
        if let Some(start) = g.tool_start.take() {
            g.tool_time_ms += start.elapsed().as_millis() as i64;
        }
    }

    /// Fold one round's provider usage into the running live totals (called
    /// at each tool-loop round boundary) so the live IN/CACHE chips can
    /// render before `chat:done`. `input_includes_cache` follows the
    /// provider family (OpenAI-style inclusive, Anthropic-style exclusive) —
    /// same convention `cache_hit_rate` applies at turn end, so the live
    /// value converges on the final one.
    pub fn note_round_usage(
        &self,
        input_tokens: i64,
        cache_read: i64,
        cache_creation: i64,
        input_includes_cache: bool,
    ) {
        let mut g = self.inner.lock();
        g.ru_input += input_tokens;
        g.ru_cache_read += cache_read;
        g.ru_cache_creation += cache_creation;
        g.ru_inclusive = input_includes_cache;
        g.ru_seen = true;
    }

    /// Emit a `chat:perf` snapshot if at least `PERF_EMIT_INTERVAL_MS` has
    /// passed since the last emit. Called from the hot stream path (e.g. on
    /// each token); cheap when throttled out. No-op when no `AppHandle`.
    pub fn maybe_emit_perf(&self) {
        let app = match &self.app {
            Some(a) => a,
            None => return,
        };
        let now = Instant::now();
        let should_emit = {
            let mut g = self.inner.lock();
            let due = g
                .last_perf_emit
                .map(|t| now.duration_since(t).as_millis() >= PERF_EMIT_INTERVAL_MS)
                .unwrap_or(true);
            if due {
                g.last_perf_emit = Some(now);
            }
            due
        };
        if !should_emit {
            return;
        }
        let snap = self.snapshot_locked();
        let _ = app.emit("chat:perf", snap);
    }

    /// Build a live `ChatPerfPayload` from the current counters. Computes
    /// tok/s from the running output-token count and the cumulative DECODE
    /// time (guarded against divide-by-zero) — same definition as the final
    /// value, so the live chip converges on the persisted one.
    pub fn snapshot(&self) -> ChatPerfPayload {
        self.snapshot_locked()
    }

    fn snapshot_locked(&self) -> ChatPerfPayload {
        let g = self.inner.lock();
        let cache_hit_rate = if g.ru_seen {
            cache_hit_rate(
                g.ru_cache_read,
                g.ru_cache_creation,
                g.ru_input,
                g.ru_inclusive,
            )
        } else {
            None
        };
        ChatPerfPayload {
            chat_session_id: self.sid.clone(),
            llm_time_ms: g.llm_time_ms,
            tool_time_ms: g.tool_time_ms,
            ttft_ms: g.ttft_ms,
            tokens_per_second: tokens_per_second(g.output_tokens, g.decode_ms),
            output_tokens: g.output_tokens,
            elapsed_ms: g.started.elapsed().as_millis() as i64,
            input_tokens: g.ru_seen.then_some(g.ru_input),
            cache_hit_rate,
        }
    }

    /// Final tok/s for `ChatDonePayload`/the DB row. Uses the authoritative
    /// `output_tokens` from the provider's usage (not the running event
    /// count) divided by the cumulative DECODE time — prefill and
    /// connection time excluded, matching the industry definition of decode
    /// throughput.
    pub fn tokens_per_second(&self, output_tokens: i64) -> Option<f64> {
        let decode_ms = self.inner.lock().decode_ms;
        tokens_per_second(output_tokens, decode_ms)
    }

    /// Read-only accessors for `ChatDonePayload` / the DB row.
    pub fn llm_time_ms(&self) -> Option<i64> {
        Some(self.inner.lock().llm_time_ms)
    }
    /// Cumulative pure-decode time (first delta → window close per round).
    /// Shallow read for tests/diagnostics — the tok/s paths read it through
    /// `tokens_per_second`.
    #[allow(dead_code)]
    pub fn decode_ms(&self) -> Option<i64> {
        let ms = self.inner.lock().decode_ms;
        (ms > 0).then_some(ms)
    }
    pub fn tool_time_ms(&self) -> Option<i64> {
        Some(self.inner.lock().tool_time_ms)
    }
    pub fn ttft_ms(&self) -> Option<i64> {
        self.inner.lock().ttft_ms
    }
}

/// Shared TTFT/decode-stamp body: first delta of the turn captures TTFT from
/// the first generation window's start; every delta anchors the open
/// window's decode span (only while a window is open — stray deltas outside
/// a window, e.g. from a nested subagent stream, must not poison the NEXT
/// window's anchor).
fn stream_delta_locked(g: &mut Inner) {
    if !g.first_token_seen {
        g.first_token_seen = true;
        let base = g.first_gen_start.unwrap_or(g.started);
        g.ttft_ms = Some(base.elapsed().as_millis() as i64);
    }
    if g.gen_start.is_some() && g.window_first_delta.is_none() {
        g.window_first_delta = Some(Instant::now());
    }
}

fn tokens_per_second(output_tokens: i64, decode_ms: i64) -> Option<f64> {
    if decode_ms <= 0 || output_tokens <= 0 {
        return None;
    }
    Some(output_tokens as f64 / (decode_ms as f64 / 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_rate_anthropic_style() {
        // Anthropic convention: 660 cache-read, 0 creation, 340 uncached
        // input → total 1000 → 660/1000 = 0.66.
        let r = cache_hit_rate(660, 0, 340, false).unwrap();
        assert!((r - 0.66).abs() < 1e-9);
    }

    #[test]
    fn cache_hit_rate_openai_inclusive_input() {
        // OpenAI convention: prompt_tokens=1000 already contains the 800
        // cached tokens. Counting them twice (the old formula) gave
        // 800/1800 ≈ 44%; the normalized total is 1000 → 0.8.
        let r = cache_hit_rate(800, 0, 1000, true).unwrap();
        assert!((r - 0.8).abs() < 1e-9);
    }

    #[test]
    fn cache_hit_rate_none_when_no_cache_reported() {
        // Providers that don't report cache fields at all must hide the chip
        // rather than show a fake "0%".
        assert!(cache_hit_rate(0, 0, 1000, true).is_none());
        assert!(cache_hit_rate(0, 0, 0, false).is_none());
    }

    #[test]
    fn cache_hit_rate_zero_reads_with_creation_is_zero() {
        // Cache written but nothing hit → a genuine 0%.
        let r = cache_hit_rate(0, 500, 500, false).unwrap();
        assert!(r.abs() < 1e-9);
    }

    #[test]
    fn tokens_per_second_computes() {
        // 72 tokens over 1000 ms = 72 tok/s.
        let r = tokens_per_second(72, 1000).unwrap();
        assert!((r - 72.0).abs() < 1e-9);
    }

    #[test]
    fn tokens_per_second_none_on_zero() {
        assert!(tokens_per_second(0, 1000).is_none());
        assert!(tokens_per_second(72, 0).is_none());
    }

    #[test]
    fn turn_perf_records_ttft_and_windows() {
        let p = TurnPerf::new_headless("test-ttft");
        p.begin_gen();
        // First token captures TTFT (anchored to begin_gen, not construction).
        p.record_token();
        // Simulate some generation time.
        std::thread::sleep(std::time::Duration::from_millis(5));
        p.end_gen();
        // A tool window.
        p.begin_tool();
        std::thread::sleep(std::time::Duration::from_millis(3));
        p.end_tool();
        // Another generation round.
        p.begin_gen();
        p.record_token();
        p.end_gen();

        let snap = p.snapshot();
        assert!(snap.ttft_ms.unwrap_or(0) >= 0);
        assert!(snap.llm_time_ms >= 5); // at least the two gen windows
        assert!(snap.tool_time_ms >= 3);
        assert_eq!(snap.output_tokens, 2);
    }

    #[test]
    fn begin_tool_closes_open_gen_window() {
        let p = TurnPerf::new_headless("test-tool-closes-gen");
        p.begin_gen();
        std::thread::sleep(std::time::Duration::from_millis(4));
        // A tool call arrives mid-generation — the open gen window must close
        // so the tool wait isn't billed as LLM time.
        p.begin_tool();
        std::thread::sleep(std::time::Duration::from_millis(2));
        p.end_tool();
        let snap = p.snapshot();
        // LLM time is the pre-tool generation only (~4ms); tool time is ~2ms.
        assert!(snap.llm_time_ms >= 4);
        assert!(snap.tool_time_ms >= 2);
    }

    #[test]
    fn ttft_anchored_to_first_gen_window_not_turn_start() {
        let p = TurnPerf::new_headless("test-ttft-anchor");
        // Pre-flight setup delay BEFORE the first request — must NOT count
        // into TTFT.
        std::thread::sleep(std::time::Duration::from_millis(20));
        p.begin_gen();
        p.record_stream_delta();
        let ttft = p.ttft_ms().unwrap();
        // ~0ms from begin_gen; if TTFT were anchored to construction it
        // would be ≥20ms. Generous bound so slow CI never flakes.
        assert!(ttft < 15, "ttft {ttft}ms should exclude pre-flight delay");
    }

    #[test]
    fn decode_time_excludes_prefill() {
        let p = TurnPerf::new_headless("test-decode");
        p.begin_gen();
        // Prefill: request in flight before the first token.
        std::thread::sleep(std::time::Duration::from_millis(15));
        p.record_token();
        p.record_token();
        // Decode tail.
        std::thread::sleep(std::time::Duration::from_millis(10));
        p.end_gen();
        // LLM time covers the whole window (≥20ms); decode only the tail
        // (≥5ms, strictly below llm time).
        assert!(p.llm_time_ms().unwrap() >= 20);
        let decode = p.decode_ms().unwrap();
        assert!(decode >= 5, "decode {decode}ms should cover the tail");
        assert!(decode < p.llm_time_ms().unwrap());
    }

    #[test]
    fn stream_delta_does_not_bump_output_tokens() {
        let p = TurnPerf::new_headless("test-delta-vs-token");
        p.begin_gen();
        p.record_stream_delta(); // tool-argument delta, not text
        p.record_stream_delta();
        assert_eq!(p.snapshot().output_tokens, 0);
        p.record_token(); // a real text delta
        assert_eq!(p.snapshot().output_tokens, 1);
        p.end_gen();
    }

    #[test]
    fn strays_between_rounds_dont_poison_next_decode_window() {
        let p = TurnPerf::new_headless("test-stray-delta");
        p.begin_gen();
        p.record_token();
        std::thread::sleep(std::time::Duration::from_millis(10));
        p.end_gen(); // round 1 decode ≈ 10ms
        // A delta arriving BETWEEN rounds (window closed) — e.g. from a
        // nested stream sharing the sid — must not anchor the next window.
        p.record_stream_delta();
        p.begin_gen();
        std::thread::sleep(std::time::Duration::from_millis(30)); // prefill
        p.record_token();
        std::thread::sleep(std::time::Duration::from_millis(20)); // decode tail
        p.end_gen();
        // Round 2's decode anchors at its own first token, so its prefill
        // gap stays in llm time and out of decode time.
        let (decode, llm) = (p.decode_ms().unwrap(), p.llm_time_ms().unwrap());
        assert!(
            decode < llm,
            "decode {decode}ms must exclude the inter-round prefill (llm {llm}ms)"
        );
    }

    #[test]
    fn note_round_usage_accumulates_and_hides_until_first_round() {
        let p = TurnPerf::new_headless("test-round-usage");
        // Before any round usage: IN unknown, cache unknown.
        let snap = p.snapshot();
        assert!(snap.input_tokens.is_none());
        assert!(snap.cache_hit_rate.is_none());
        // OpenAI-style round: prompt 1000 inclusive of 800 cached.
        p.note_round_usage(1000, 800, 0, true);
        p.note_round_usage(500, 400, 0, true);
        let snap = p.snapshot();
        assert_eq!(snap.input_tokens, Some(1500));
        // (800 + 400) / (1000 + 500) = 0.8.
        let r = snap.cache_hit_rate.unwrap();
        assert!((r - 0.8).abs() < 1e-9);
    }

    #[test]
    fn close_open_windows_folds_stragglers() {
        let p = TurnPerf::new_headless("test-close-open");
        p.begin_gen();
        std::thread::sleep(std::time::Duration::from_millis(5));
        p.begin_tool(); // begin_tool closes the gen window itself
        std::thread::sleep(std::time::Duration::from_millis(6));
        p.close_open_windows(); // folds the still-open tool window
        let snap = p.snapshot();
        assert!(snap.tool_time_ms >= 5);
        assert!(snap.llm_time_ms >= 4);
    }

    // ---- harness registry helpers ----

    #[test]
    fn active_harness_final_measures_registered_turn() {
        let sid = format!("test-harness-final-{}", uuid::Uuid::new_v4());
        let p = register(&sid, TurnPerf::new_headless(&sid));
        // Round 1: open a window, stream, close.
        p.begin_gen();
        p.record_token();
        p.record_token();
        std::thread::sleep(std::time::Duration::from_millis(6));
        p.end_gen();
        // Round 2 left OPEN at finish (tool-less turn) — active_harness_final
        // must fold it via close_open_windows, not drop it.
        p.begin_gen();
        p.record_token();
        p.note_round_usage(100, 60, 20, false);

        let (ttft, tok_s, llm_ms) = active_harness_final(&sid, Some(30));
        assert!(ttft.is_some(), "ttft captured from the first token");
        let ts = tok_s.expect("tok/s from authoritative output over decode time");
        assert!(ts > 0.0);
        assert!(llm_ms.unwrap_or(0) >= 6, "llm time covers the closed round");
        // 30 tokens over ≥6ms decode would exceed 1000 tok/s only if the
        // window stayed open; just sanity-bound the value.
        assert!(ts < 100_000.0);
        unregister(&sid);
    }

    #[test]
    fn active_harness_final_none_without_registration() {
        let sid = format!("test-harness-final-missing-{}", uuid::Uuid::new_v4());
        let (ttft, tok_s, llm_ms) = active_harness_final(&sid, Some(10));
        assert!(ttft.is_none() && tok_s.is_none() && llm_ms.is_none());
    }

    #[test]
    fn registry_gen_windows_track_decode_time() {
        let sid = format!("test-harness-gen-{}", uuid::Uuid::new_v4());
        let _p = register(&sid, TurnPerf::new_headless(&sid));
        begin_active_gen(&sid);
        record_active_token(&sid); // TTFT + decode anchor
        std::thread::sleep(std::time::Duration::from_millis(5));
        end_active_gen(&sid);
        // A second begin/end cycle on the same window pair must not crash or
        // double-count (end on a closed window is a no-op).
        end_active_gen(&sid);
        let (ttft, tok_s, llm_ms) = active_harness_final(&sid, Some(5));
        assert!(ttft.is_some());
        assert!(tok_s.unwrap_or(0.0) > 0.0, "decode window was measured");
        assert!(llm_ms.unwrap_or(0) >= 5);
        unregister(&sid);
    }

    #[test]
    fn set_active_round_usage_replaces_note_accumulates() {
        let sid = format!("test-harness-usage-{}", uuid::Uuid::new_v4());
        let p = register(&sid, TurnPerf::new_headless(&sid));
        // Accumulate (claude per-round reports).
        note_active_round_usage(&sid, 100, 60, 20, false);
        note_active_round_usage(&sid, 100, 60, 20, false);
        let snap = p.snapshot();
        assert_eq!(snap.input_tokens, Some(200));
        // Replace (running-total reporters).
        set_active_round_usage(&sid, 500, 300, 50, false);
        let snap = p.snapshot();
        assert_eq!(snap.input_tokens, Some(500));
        let rate = snap.cache_hit_rate.expect("cache reported");
        assert!((rate - (300.0 / 850.0)).abs() < 1e-9);
        unregister(&sid);
    }
}
