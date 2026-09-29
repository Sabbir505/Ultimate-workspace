//! Request log + loopback gateway for local-model traffic.
//!
//! Two things live here, sharing one store ([`crate::db::llm_log`]):
//!
//!   - **Capture.** Every local-model HTTP exchange gets a `llm_log` row with
//!     its request and response bodies verbatim plus best-effort telemetry.
//!     Two origins reach it: Relay's own calls (hooked in at the provider
//!     request builders and the stream pumps) and traffic through the gateway.
//!   - **The gateway.** A loopback HTTP proxy other apps point their `base_url`
//!     at, so their traffic is logged too.
//!
//! # The proxy forwards bytes and never re-frames
//!
//! The three runtimes disagree on wire format: Ollama streams bare
//! newline-delimited JSON with no `data:` prefix, llama.cpp uses plain SSE
//! ending in `data: [DONE]`, and LM Studio uses SSE with *named* events. A
//! proxy that understood the stream would need three framing paths and would
//! corrupt responses the moment one drifted. So the gateway forwards bytes
//! unchanged, keeps a copy, and hands the copy to [`normalize`] for telemetry.
//! That is why a bug here can cost us a field but never a response.
//!
//! Formats and telemetry locations were measured against a live
//! `llama-server`, not taken from docs — see [`normalize`]'s table.

pub mod commands;
pub mod gateway;
pub mod normalize;

/// End-to-end tests against a real local-model server. Skips cleanly when none
/// is listening — see the module for why these are not mocks.
#[cfg(test)]
mod live_tests;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use crate::db::llm_log::{self as store, NewLogEntry};

// ── settings keys ──────────────────────────────────────────────────────────

pub const ENABLED_KEY: &str = "logs.enabled";
pub const RETENTION_DAYS_KEY: &str = "logs.retentionDays";
pub const MAX_ROWS_KEY: &str = "logs.maxRows";
pub const MAX_BODY_KB_KEY: &str = "logs.maxBodyKb";

pub const GATEWAY_ENABLED_KEY: &str = "gateway.enabled";
pub const GATEWAY_REQUIRE_AUTH_KEY: &str = "gateway.requireAuth";
pub const GATEWAY_PORT_KEY: &str = "gateway.port";
pub const GATEWAY_DEFAULT_TARGET_KEY: &str = "gateway.defaultTarget";

pub const DEFAULT_RETENTION_DAYS: i64 = 7;
pub const DEFAULT_MAX_ROWS: i64 = 5_000;

// ── retention config ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LogConfig {
    pub enabled: bool,
    pub retention_days: i64,
    pub max_rows: i64,
    pub max_body_kb: i64,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self { enabled: true, retention_days: DEFAULT_RETENTION_DAYS, max_rows: DEFAULT_MAX_ROWS, max_body_kb: store::DEFAULT_MAX_BODY_KB }
    }
}

fn setting_i64(conn: &rusqlite::Connection, key: &str, fallback: i64) -> i64 {
    crate::db::get_setting(conn, key)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn setting_bool(conn: &rusqlite::Connection, key: &str, fallback: bool) -> bool {
    crate::db::get_setting(conn, key)
        .ok()
        .flatten()
        .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
        .unwrap_or(fallback)
}

impl LogConfig {
    pub fn load(conn: &rusqlite::Connection) -> Self {
        Self {
            enabled: setting_bool(conn, ENABLED_KEY, true),
            retention_days: setting_i64(conn, RETENTION_DAYS_KEY, DEFAULT_RETENTION_DAYS),
            max_rows: setting_i64(conn, MAX_ROWS_KEY, DEFAULT_MAX_ROWS),
            max_body_kb: setting_i64(conn, MAX_BODY_KB_KEY, store::DEFAULT_MAX_BODY_KB),
        }
    }
}

// ── target classification ──────────────────────────────────────────────────

/// Ollama's default port. The one hardcoded number in this module that we
/// inherit from the world rather than choose.
pub const OLLAMA_PORT: u16 = 11434;
/// LM Studio's `lms server` default.
pub const LMSTUDIO_PORT: u16 = 1234;

/// Name a target from the URL we actually talked to.
///
/// Port beats provider id on purpose: a user can point any provider at
/// Ollama, and the log should say `ollama` because that is where the tokens
/// were spent.
pub fn classify_target(base_url: Option<&str>, provider_id: &str) -> String {
    if let Some(url) = base_url {
        if let Some(port) = url_port(url) {
            if port == OLLAMA_PORT {
                return "ollama".into();
            }
            if port == LMSTUDIO_PORT {
                return "lmstudio".into();
            }
        }
        if is_loopback(url) {
            return "llamacpp".into();
        }
    }
    if provider_id == "local_gguf" {
        return "llamacpp".into();
    }
    provider_id.to_string()
}

/// Pull the port out of `http://127.0.0.1:8080/v1` without a URL parser —
/// the only URL crate feature in play is `encoding`, and a full parse here
/// would be heavier than the problem.
fn url_port(url: &str) -> Option<u16> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split('/').next()?;
    let port = host.rsplit(':').next()?;
    port.parse::<u16>().ok()
}

fn is_loopback(url: &str) -> bool {
    let rest = url.split("://").nth(1).unwrap_or("");
    let host = rest.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1" | "0.0.0.0")
}

// ── request capture sink ───────────────────────────────────────────────────

/// A request captured verbatim at the point it was built.
#[derive(Debug, Clone)]
pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    pub body: String,
}

// A thread-local, not a task-local — which would normally be wrong for async
// code, because tasks interleave on one thread. It is safe *here* because the
// only scope is `capture_sync` around `provider.build_request`, which is
// entirely synchronous: it builds and returns a `RequestBuilder` without a
// single `.await`, so no other task can run while the sink is installed. The
// span is microseconds and provably await-free.
//
// The request builders call `record_request` unconditionally (a cheap no-op
// when no sink is installed), so the hook is one line per builder and a
// provider added later can never be silently missed.
thread_local! {
    static SYNC_SINK: RefCell<Option<Box<dyn FnMut(CapturedRequest)>>> =
        const { RefCell::new(None) };
}

/// True when a sink is installed — lets the builders skip serializing the
/// body entirely when logging is off.
pub fn request_capture_active() -> bool {
    SYNC_SINK.with(|c| c.borrow().is_some())
}

/// Run a synchronous closure with capture enabled, returning whatever it
/// returns plus the request it built (if any). Restores any outer sink, so
/// nesting is safe.
pub fn capture_sync<F, T>(f: F) -> (T, Option<CapturedRequest>)
where
    F: FnOnce() -> T,
{
    let slot = Rc::new(RefCell::new(None::<CapturedRequest>));
    let sink_slot = Rc::clone(&slot);
    let sink: Box<dyn FnMut(CapturedRequest)> =
        Box::new(move |c: CapturedRequest| *sink_slot.borrow_mut() = Some(c));

    let prev = SYNC_SINK.with(|c| c.borrow_mut().replace(sink));
    let out = f();
    SYNC_SINK.with(|c| *c.borrow_mut() = prev);

    let captured = slot.borrow_mut().take();
    (out, captured)
}

/// Called by `chat::providers` immediately after each request body is built.
pub fn record_request(method: &str, url: &str, body: &str) {
    SYNC_SINK.with(|cell| {
        let mut b = cell.borrow_mut();
        if let Some(sink) = b.as_mut() {
            sink(CapturedRequest {
                method: method.to_string(),
                path: path_of(url).to_string(),
                body: body.to_string(),
            });
        }
    });
}

/// The app's DB handle, looked up from an `AppHandle`. `None` in headless
/// tests, which is what keeps those from needing a database to stream.
///
/// Generic over the Tauri runtime because the chat code is generic over it
/// (the tool loops take `&AppHandle<R>`), and a `Wry`-only signature would not
/// match at the call sites that matter.
pub fn db_from_app<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
) -> Option<Arc<parking_lot::Mutex<rusqlite::Connection>>> {
    use tauri::Manager;
    app?.try_state::<crate::DbState>().map(|s| Arc::clone(&s.0))
}

/// Arm a request-log row for one tool-loop round.
///
/// The tool loops build their wire body themselves (`build_openai_body`) and
/// hand it straight to reqwest, so there is no provider request-builder to
/// hook — the body arrives here already serialized, which makes this the
/// exact-by-construction capture point. One row per model round: a 20-tool
/// turn is 20 requests upstream and should read as 20 rows, not one summary
/// that hides where the time went.
pub fn begin_round<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
    provider_id: &str,
    body: &str,
) -> CaptureGuard {
    let Some(db) = db_from_app(Some(app)) else {
        return CaptureGuard::disabled();
    };
    let cfg = {
        let conn = db.lock();
        LogConfig::load(&conn)
    };
    if !cfg.enabled {
        return CaptureGuard::disabled();
    }
    let target = classify_target(Some(url), provider_id);
    // `Capture::new` pulls the model name out of the body, and attaches it as
    // the request body verbatim — which is all `attach_request` would do.
    CaptureGuard::new(
        Capture::new("relay", &target, "POST", path_of(url), Some(body)),
        db,
        cfg,
    )
}

/// Writes the row on drop, so every exit path — success, HTTP error, stream
/// error, cancellation — is logged exactly once without restructuring the
/// function it wraps.
pub struct CaptureGuard {
    cap: Option<Capture>,
    conn: Option<Arc<parking_lot::Mutex<rusqlite::Connection>>>,
    cfg: LogConfig,
}

impl CaptureGuard {
    /// The no-op guard used when logging is off or there is no app handle, so
    /// call sites need no conditionals.
    pub fn disabled() -> Self {
        Self { cap: None, conn: None, cfg: LogConfig::default() }
    }

    pub fn new(
        cap: Capture,
        conn: Arc<parking_lot::Mutex<rusqlite::Connection>>,
        cfg: LogConfig,
    ) -> Self {
        Self { cap: Some(cap), conn: Some(conn), cfg }
    }

    pub fn is_active(&self) -> bool {
        self.cap.is_some()
    }

    /// Tee raw response bytes into the captured copy. Bounded so a runaway
    /// stream can't grow the row without limit; `Capture::finish` applies the
    /// configured cap on top of this.
    pub fn tee(&mut self, bytes: &[u8]) {
        const TEE_CAP: usize = 512 * 1024;
        if let Some(cap) = self.cap.as_mut() {
            if cap.response_buf.len() < TEE_CAP {
                cap.response_buf.push_str(&String::from_utf8_lossy(bytes));
            }
        }
    }

    pub fn note_first_byte(&mut self) {
        if let Some(cap) = self.cap.as_mut() {
            cap.note_first_byte();
        }
    }

    pub fn set_status(&mut self, status: i64) {
        if let Some(cap) = self.cap.as_mut() {
            cap.upstream_status = Some(status);
        }
    }

    pub fn set_error(&mut self, msg: String) {
        if let Some(cap) = self.cap.as_mut() {
            cap.error = Some(msg);
        }
    }

    /// Take the request body the provider builder captured. Called after
    /// `build_request`, so the log row has the verbatim wire body.
    pub fn attach_request(&mut self, captured: Option<CapturedRequest>) {
        if let (Some(cap), Some(c)) = (self.cap.as_mut(), captured) {
            if cap.model.is_none() {
                cap.model = normalize::model_from_request(&c.body);
            }
            cap.method = c.method;
            cap.path = c.path;
            cap.request_body = Some(c.body);
        }
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        let (Some(cap), Some(conn)) = (self.cap.take(), self.conn.as_ref()) else {
            return;
        };
        let guard = conn.lock();
        cap.finish(&guard, &self.cfg);
    }
}

/// Path + query of a full URL, for the log's `path` column.
fn path_of(url: &str) -> &str {
    match url.split("://").nth(1) {
        Some(rest) => match rest.find('/') {
            Some(i) => &rest[i..],
            None => "/",
        },
        None => url,
    }
}

// ── capture lifecycle ──────────────────────────────────────────────────────

/// An in-flight exchange. Dropping this without calling [`finish`] simply
/// logs nothing — a cancelled turn should not leave a half-written row.
pub struct Capture {
    pub id: String,
    pub started: Instant,
    pub origin: String,
    pub target: String,
    pub method: String,
    pub path: String,
    pub request_body: Option<String>,
    pub model: Option<String>,
    /// Bytes assembled so far, for streaming responses.
    pub response_buf: String,
    pub ttft_ms: Option<i64>,
    pub upstream_status: Option<i64>,
    pub error: Option<String>,
}

impl Capture {
    /// `model` is taken from the request body when the caller doesn't know it
    /// (the gateway forwards foreign requests, whose model name is in there).
    pub fn new(
        origin: &str,
        target: &str,
        method: &str,
        path: &str,
        request_body: Option<&str>,
    ) -> Self {
        let model = request_body.and_then(normalize::model_from_request);
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            started: Instant::now(),
            origin: origin.to_string(),
            target: target.to_string(),
            method: method.to_string(),
            path: path.to_string(),
            request_body: request_body.map(str::to_string),
            model,
            response_buf: String::new(),
            ttft_ms: None,
            upstream_status: None,
            error: None,
        }
    }

    /// Note the arrival of the first response byte, for transports that
    /// measure it themselves.
    pub fn note_first_byte(&mut self) {
        if self.ttft_ms.is_none() {
            self.ttft_ms = Some(self.started.elapsed().as_millis() as i64);
        }
    }

    /// Append a streamed delta to the reconstructed response body.
    pub fn push_delta(&mut self, delta: &str) {
        self.response_buf.push_str(delta);
    }

    /// Write the row. Cheap no-op when logging is off, so callers can invoke
    /// it unconditionally on the completion path.
    pub fn finish(self, conn: &rusqlite::Connection, cfg: &LogConfig) {
        if !cfg.enabled {
            return;
        }
        let duration_ms = self.started.elapsed().as_millis() as i64;
        let framing = normalize::detect_framing(&self.response_buf);
        let telem = normalize::extract(&self.response_buf, framing, self.ttft_ms);

        let entry = NewLogEntry {
            id: self.id,
            origin: self.origin,
            target: self.target,
            method: self.method,
            path: self.path,
            model: self.model,
            upstream_status: self.upstream_status,
            error: self.error,
            duration_ms: Some(duration_ms),
            ttft_ms: telem.ttft_ms,
            input_tokens: telem.input_tokens,
            output_tokens: telem.output_tokens,
            tokens_per_second: telem.tokens_per_second,
            request_bytes: self.request_body.as_ref().map(|b| b.len() as i64).unwrap_or(0),
            response_bytes: self.response_buf.len() as i64,
            truncated: false,
            request_body: self.request_body,
            response_body: Some(self.response_buf),
            timings_json: telem.timings.map(|v| v.to_string()),
        };
        if let Err(e) = store::insert(conn, &entry, cfg.max_body_kb) {
            eprintln!("[relay:llm-log] insert failed: {e}");
        }
    }
}

/// Prune by retention + row cap. Called on a timer rather than per request,
/// so a chatty local model doesn't pay for a DELETE on the hot path.
pub fn prune(conn: &rusqlite::Connection, cfg: &LogConfig) -> usize {
    match store::prune(conn, cfg.retention_days, cfg.max_rows) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("[relay:llm-log] prune failed: {e}");
            0
        }
    }
}

/// Helper for callers that hold a serialized body and want the model out of
/// it without importing [`normalize`] directly.
pub fn model_of(request_body: Option<&str>) -> Option<String> {
    request_body.and_then(normalize::model_from_request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_a_loopback_runtime_by_port() {
        assert_eq!(classify_target(Some("http://127.0.0.1:11434"), "openai_compatible"), "ollama");
        assert_eq!(classify_target(Some("http://127.0.0.1:1234"), "openai_compatible"), "lmstudio");
        assert_eq!(classify_target(Some("http://127.0.0.1:18080"), "local_gguf"), "llamacpp");
        assert_eq!(classify_target(Some("http://localhost:8080"), "local_gguf"), "llamacpp");
        assert_eq!(classify_target(None, "local_gguf"), "llamacpp");
        // A cloud provider keeps its own id.
        assert_eq!(classify_target(Some("https://api.anthropic.com"), "anthropic"), "anthropic");
    }

    #[test]
    fn a_provider_pointed_at_ollama_logs_as_ollama() {
        // The port wins over the provider id — that is where tokens were spent.
        assert_eq!(classify_target(Some("http://127.0.0.1:11434"), "anthropic"), "ollama");
    }

    #[test]
    fn extracts_path_and_query_from_a_url() {
        assert_eq!(path_of("http://127.0.0.1:8080/v1/chat/completions"), "/v1/chat/completions");
        assert_eq!(path_of("https://api.anthropic.com/v1/messages?beta=1"), "/v1/messages?beta=1");
        assert_eq!(path_of("http://127.0.0.1:8080"), "/");
    }

    #[test]
    fn parses_a_port_out_of_a_url() {
        assert_eq!(url_port("http://127.0.0.1:11434/api/chat"), Some(11434));
        assert_eq!(url_port("https://api.anthropic.com/v1"), None);
    }

    #[test]
    fn the_sink_captures_only_inside_its_scope() {
        let (_, got) = capture_sync(|| {
            record_request("POST", "http://127.0.0.1:8080/v1/chat/completions", r#"{"model":"m"}"#);
            42
        });
        assert_eq!(got.expect("request captured inside the scope").path, "/v1/chat/completions");

        // Outside the scope the same call must be inert.
        assert!(!request_capture_active());
        record_request("POST", "http://127.0.0.1:8080/nope", "{}");
        assert!(request_capture_active() == false);
    }

    #[test]
    fn a_nested_scope_restores_the_outer_sink() {
        let (_, outer) = capture_sync(|| {
            record_request("POST", "http://127.0.0.1:1/inner", "{}");
            // Inner scope replaces the sink, then must put it back.
            capture_sync(|| {
                record_request("POST", "http://127.0.0.1:1/deeper", "{}");
            });
            record_request("POST", "http://127.0.0.1:1/after", "{}");
        });
        let outer = outer.expect("outer scope still owns the sink after nesting");
        assert_eq!(outer.path, "/after", "the last request the OUTER sink saw wins");
    }

    #[test]
    fn capture_takes_the_model_from_the_request_body() {
        let c = Capture::new("external", "ollama", "POST", "/api/chat", Some(r#"{"model":"llama3.2"}"#));
        assert_eq!(c.model.as_deref(), Some("llama3.2"));
        let c2 = Capture::new("external", "ollama", "GET", "/api/tags", None);
        assert_eq!(c2.model, None);
    }
}
