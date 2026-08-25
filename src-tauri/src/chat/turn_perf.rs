//! Per-turn performance accumulator.
//!
//! Captures the timing the composer metrics row needs (and that
//! `ChatDonePayload`/`chat_messages` persist):
//! - **TTFT** — wall-clock from turn start to the first emitted token.
//! - **LLM time** — cumulative wall-clock the model is actively generating
//!   text. Each generation round opens a window on `begin_gen` and closes it
//!   when the round's stream completes (or on `end_gen`). Tool execution and
//!   approval waits fall *outside* these windows, so LLM time is the true
//!   inference/generation budget.
//! - **Tool time** — cumulative wall-clock spent *executing* tools, measured
//!   by `begin_tool`/`end_tool` around just the execution segment (approval
//!   waits are excluded by construction — the gate resolves before the
//!   execution segment begins).
//! - **tok/s** — `output_tokens / llm_time_ms` (final value computed at turn
//!   end from the persisted usage).
//!
//! A throttled `chat:perf` event (~every 500ms during streaming) carries a
//! live snapshot so the composer row updates without waiting for `chat:done`.

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
/// token and then jumped straight to e.g. "1min".
pub fn register(session_id: &str, perf: TurnPerf) -> TurnPerf {
    ACTIVE.lock().insert(session_id.to_string(), perf.clone());
    // Heartbeat task: tick until this perf is no longer the session's active
    // one (turn ended → unregistered, or a new turn replaced it). Spawned
    // through Handle::try_current so non-async callers (tests) don't panic.
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let sid = session_id.to_string();
        let heartbeat = perf.clone();
        handle.spawn(async move {
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
    }
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

/// Cache-hit rate helper: `cache_read / (cache_read + cache_creation +
/// uncached_input)`. Returns `None` when no input tokens were billed (so the
/// UI shows "—" rather than a misleading 0%). `uncached_input` is the
/// provider's reported `input_tokens` *minus* the cache fields — when a
/// provider reports `input_tokens` already inclusive of cache reads, the
/// caller should pass `input_tokens` directly and let this fn subtract.
pub fn cache_hit_rate(
    cache_read: i64,
    cache_creation: i64,
    input_tokens: i64,
) -> Option<f64> {
    // Anthropic reports `input_tokens` as the *uncached* prompt tokens, with
    // `cache_read_input_tokens` and `cache_creation_input_tokens` billed
    // separately. Total prompt tokens = input + cache_read + cache_creation.
    // Hit rate = cache_read / total_prompt.
    let total_prompt = input_tokens + cache_read + cache_creation;
    if total_prompt <= 0 {
        return None;
    }
    Some(cache_read as f64 / total_prompt as f64)
}

struct Inner {
    /// Instant the turn started (captured in `TurnPerf::new`).
    started: Instant,
    /// Cumulative ms the model spent actively generating text.
    llm_time_ms: i64,
    /// Cumulative ms spent executing tools (excluding approval waits).
    tool_time_ms: i64,
    /// Time from `started` to the first emitted token (ms). `None` until the
    /// first token arrives.
    ttft_ms: Option<i64>,
    /// Start of the current open generation window, if one is in progress.
    /// `None` between rounds (e.g. while a tool executes).
    gen_start: Option<Instant>,
    /// Start of the current open tool-execution window, if one is in progress.
    tool_start: Option<Instant>,
    /// Whether the first token has been seen yet (drives TTFT capture).
    first_token_seen: bool,
    /// Last instant we emitted a `chat:perf` event (throttle gate).
    last_perf_emit: Option<Instant>,
    /// Output tokens generated so far in this turn (for live tok/s). The
    /// provider's usage at turn end is authoritative; this is a running
    /// estimate from token-event counts.
    output_tokens: i64,
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
    pub fn new(app: AppHandle, sid: &str) -> Self {
        Self {
            app: Some(app),
            sid: sid.to_string(),
            inner: Arc::new(Mutex::new(Inner {
                started: Instant::now(),
                llm_time_ms: 0,
                tool_time_ms: 0,
                ttft_ms: None,
                gen_start: None,
                tool_start: None,
                first_token_seen: false,
                last_perf_emit: None,
                output_tokens: 0,
            })),
        }
    }

    /// A no-backend variant for paths that don't have an `AppHandle` handy
    /// (e.g. headless tests). Records timing but never emits `chat:perf`.
    pub fn new_headless(sid: &str) -> Self {
        Self {
            app: None,
            sid: sid.to_string(),
            inner: Arc::new(Mutex::new(Inner {
                started: Instant::now(),
                llm_time_ms: 0,
                tool_time_ms: 0,
                ttft_ms: None,
                gen_start: None,
                tool_start: None,
                first_token_seen: false,
                last_perf_emit: None,
                output_tokens: 0,
            })),
        }
    }

    /// Open a generation window. Called when a model round's stream starts
    /// (the SSE loop begins reading). Idempotent — a second call while a
    /// window is open is a no-op (defensive against double-entry).
    pub fn begin_gen(&self) {
        let mut g = self.inner.lock();
        if g.gen_start.is_some() {
            return;
        }
        g.gen_start = Some(Instant::now());
    }

    /// Close the current generation window and fold its elapsed time into
    /// `llm_time_ms`. Called when a model round's stream completes (the SSE
    /// loop returns) — including the final round. No-op when no window is
    /// open (e.g. a round that produced zero tokens).
    pub fn end_gen(&self) {
        let mut g = self.inner.lock();
        if let Some(start) = g.gen_start.take() {
            g.llm_time_ms += start.elapsed().as_millis() as i64;
        }
    }

    /// Record a token. Marks TTFT on the first call and bumps the running
    /// output-token count (best-effort — counts token *events*, which is a
    /// good proxy for output tokens during streaming; the authoritative
    /// count comes from usage at turn end).
    pub fn record_token(&self) {
        let mut g = self.inner.lock();
        if !g.first_token_seen {
            g.first_token_seen = true;
            g.ttft_ms = Some(g.started.elapsed().as_millis() as i64);
        }
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
        if let Some(start) = g.gen_start.take() {
            g.llm_time_ms += start.elapsed().as_millis() as i64;
        }
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
    /// tok/s from the running output-token count and the cumulative LLM time
    /// (guarded against divide-by-zero).
    pub fn snapshot(&self) -> ChatPerfPayload {
        self.snapshot_locked()
    }

    fn snapshot_locked(&self) -> ChatPerfPayload {
        let g = self.inner.lock();
        ChatPerfPayload {
            chat_session_id: self.sid.clone(),
            llm_time_ms: g.llm_time_ms,
            tool_time_ms: g.tool_time_ms,
            ttft_ms: g.ttft_ms,
            tokens_per_second: tokens_per_second(g.output_tokens, g.llm_time_ms),
            output_tokens: g.output_tokens,
            elapsed_ms: g.started.elapsed().as_millis() as i64,
        }
    }

    /// Final tok/s for `ChatDonePayload`/the DB row. Uses the authoritative
    /// `output_tokens` from the provider's usage (not the running event
    /// count) divided by the cumulative LLM time.
    pub fn tokens_per_second(&self, output_tokens: i64) -> Option<f64> {
        let llm_ms = self.inner.lock().llm_time_ms;
        tokens_per_second(output_tokens, llm_ms)
    }

    /// Read-only accessors for `ChatDonePayload` / the DB row.
    pub fn llm_time_ms(&self) -> Option<i64> {
        Some(self.inner.lock().llm_time_ms)
    }
    pub fn tool_time_ms(&self) -> Option<i64> {
        Some(self.inner.lock().tool_time_ms)
    }
    pub fn ttft_ms(&self) -> Option<i64> {
        self.inner.lock().ttft_ms
    }
}

fn tokens_per_second(output_tokens: i64, llm_time_ms: i64) -> Option<f64> {
    if llm_time_ms <= 0 || output_tokens <= 0 {
        return None;
    }
    Some(output_tokens as f64 / (llm_time_ms as f64 / 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_rate_basic() {
        // 660 cache-read, 0 creation, 340 uncached → 660/1000 = 0.66.
        let r = cache_hit_rate(660, 0, 340).unwrap();
        assert!((r - 0.66).abs() < 1e-9);
    }

    #[test]
    fn cache_hit_rate_none_when_no_input() {
        assert!(cache_hit_rate(0, 0, 0).is_none());
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
        // First token captures TTFT.
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
        // No gen window is open after begin_tool.
        // (begin_gen would re-open one for the next round.)
    }
}