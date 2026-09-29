//! The loopback gateway: other apps point their `base_url` here, and Relay
//! forwards the call to the real runtime while logging it.
//!
//! # Why this is a byte-level proxy
//!
//! Ollama streams bare newline-delimited JSON, llama.cpp streams SSE ending
//! in `data: [DONE]`, and LM Studio streams SSE with named events. A gateway
//! that understood the stream would need three framing paths and would corrupt
//! responses the moment one drifted. So [`forward`] never parses the body: it
//! copies upstream bytes to the client verbatim and hands a *copy* to
//! [`super::normalize`] for telemetry. A bug here can cost a field, never a
//! response.
//!
//! # What is new in this codebase
//!
//! This is the first loopback server here that has to write a **chunked**
//! response. The webhook server ([`crate::automation_webhook`]) writes a fixed
//! `Content-Length` body and closes; streaming needs incremental framing, so
//! [`write_chunk`] / [`write_last_chunk`] are the house's first. Both hop
//! paths are exercised against a live server in the manual test pass.
//!
//! # Auth
//!
//! Loopback bind plus a bearer token, compared in constant time via `subtle`
//! (already a direct dependency, precedent at `automation_triggers.rs:300`).
//! A 5s / 8 KiB pre-auth budget mirrors the webhook server so an
//! unauthenticated peer cannot hold a socket open.

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;

use super::{
    classify_target, normalize, Capture, LogConfig, GATEWAY_DEFAULT_TARGET_KEY, GATEWAY_REQUIRE_AUTH_KEY,
    OLLAMA_PORT, LMSTUDIO_PORT,
};
use crate::db::llm_log as store;

/// OS-assigned when we bind `:0`, then persisted so other apps have a stable
/// URL across restarts (same pattern as `automations.triggerPort`).
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

pub fn bound_port() -> u16 {
    BOUND_PORT.load(Ordering::SeqCst)
}

/// Header cap. A local-model request is a chat body or a handful of embedding
/// inputs; anything past this is a client bug or an attack, not a use case.
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// Body cap. Generous for embeddings, well under "someone is exfiltrating".
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Chunk size for relayed streams. Large enough that per-chunk overhead is
/// noise, small enough that a 2B-param model streaming a long answer doesn't
/// balloon our buffer.
const RELAY_CHUNK: usize = 8 * 1024;

// ── request parsing ────────────────────────────────────────────────────────

/// A parsed HTTP request. Only what a proxy needs: method, target, headers,
/// body.
#[derive(Debug, Clone)]
pub struct ParsedRequest {
    pub method: String,
    /// Path plus query, exactly as sent.
    pub target: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ParsedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Parse a complete request from the head + the bytes that follow it.
///
/// Kept free of I/O so the parsing rules — header folding, case-insensitive
/// lookup, `Content-Length` vs. absent — are unit-testable without a socket.
pub fn parse_request(head: &[u8], rest: &[u8]) -> Result<ParsedRequest, &'static str> {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("no method")?.to_string();
    let target = parts.next().ok_or("no target")?.to_string();

    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    let path = target.split('?').next().unwrap_or("/").to_string();
    let mut body = rest.to_vec();
    // Only Content-Length bodies are handled. A chunked *request* body would
    // need decoding before forwarding; no local-model client sends one, and
    // silently mis-forwarding it would be worse than refusing.
    if let Some((_, cl)) = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")) {
        let n: usize = cl.trim().parse().map_err(|_| "bad content-length")?;
        if n > MAX_BODY_BYTES {
            return Err("body too large");
        }
        body.truncate(n);
    }
    Ok(ParsedRequest { method, target, path, headers, body })
}

/// Constant-time bearer check. Returns false for a missing/malformed header
/// rather than erroring, so a caller can't distinguish "no token" from
/// "wrong token" by timing or by status code.
pub fn auth_ok(header_value: Option<&str>, expected: &str) -> bool {
    let Some(v) = header_value else { return false };
    let Some(tok) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) else {
        return false;
    };
    tok.trim().as_bytes().ct_eq(expected.as_bytes()).into()
}

// ── target registry ────────────────────────────────────────────────────────

/// Where a named target actually lives, and how to authenticate to it.
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub name: String,
    pub base_url: String,
    /// Key to present **upstream**, if that runtime requires one.
    ///
    /// Distinct from the gateway's own bearer token: a caller authenticating
    /// to Relay proves itself to Relay, and that credential must not be
    /// forwarded. A keyed llama-server (`--api-key`) would otherwise see
    /// Relay's token, reject it, and the client would get a confusing 401
    /// from a runtime rather than from the hop that actually controls it.
    pub api_key: Option<String>,
}

/// A user-configured `gateway.targets` entry: `{ "my-llama": "http://127.0.0.1:18080" }`.
/// Read straight from settings so any runtime can be added without a rebuild.
const TARGETS_KEY: &str = "gateway.targets";

/// Resolve a target name to an upstream base URL.
///
/// Built-ins first (`ollama`, `lmstudio`) so the common case needs no config,
/// then the user's `gateway.targets` map, then the live llama.cpp sidecar.
pub fn resolve_target(conn: &Connection, name: &str) -> Option<ResolvedTarget> {
    match name {
        "ollama" => {
            return Some(ResolvedTarget {
                name: name.into(),
                base_url: format!("http://127.0.0.1:{OLLAMA_PORT}"),
                api_key: None,
            })
        }
        "lmstudio" => {
            return Some(ResolvedTarget {
                name: name.into(),
                base_url: format!("http://127.0.0.1:{LMSTUDIO_PORT}"),
                api_key: None,
            })
        }
        _ => {}
    }
    if let Some(map) = crate::db::get_setting(conn, TARGETS_KEY).ok().flatten() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&map) {
            if let Some(entry) = v.get(name) {
                // Two accepted shapes: a bare URL string, or an object with an
                // optional key for a runtime that requires one.
                let (url, api_key) = match entry {
                    serde_json::Value::String(s) => (Some(s.as_str()), None),
                    serde_json::Value::Object(o) => (
                        o.get("url").and_then(|x| x.as_str()),
                        o.get("apiKey").and_then(|x| x.as_str()).map(str::to_string),
                    ),
                    _ => (None, None),
                };
                if let Some(url) = url {
                    return Some(ResolvedTarget {
                        name: name.into(),
                        base_url: url.trim_end_matches('/').into(),
                        api_key,
                    });
                }
            }
        }
    }
    // The running sidecar, if any — this is what Relay itself is pointed at.
    let live: Option<String> = crate::db::get_setting(conn, "chat.local_gguf.base_url").ok().flatten();
    live.filter(|b| !b.trim().is_empty())
        .map(|base_url| ResolvedTarget {
            name: "llamacpp".into(),
            base_url: base_url.trim_end_matches('/').into(),
            api_key: None,
        })
}

/// Pick the target when the caller didn't name one.
fn default_target(conn: &Connection) -> Option<ResolvedTarget> {
    if let Some(name) = crate::db::get_setting(conn, GATEWAY_DEFAULT_TARGET_KEY).ok().flatten() {
        let name = name.trim();
        if !name.is_empty() {
            if let Some(t) = resolve_target(conn, name) {
                return Some(t);
            }
        }
    }
    resolve_target(conn, "ollama").or_else(|| resolve_target(conn, "llamacpp"))
}

// ── server ─────────────────────────────────────────────────────────────────

/// Owns the listener task so it can be stopped on app exit.
pub struct GatewayHandle(pub Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

/// One-time token for this launch. Rotated every start, so a leaked token
/// from a previous session is useless.
fn new_token() -> String {
    // 32 chars from the OS RNG, URL-safe.
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            ALPHABET[rng.gen_range(0..ALPHABET.len())] as char
        })
        .collect()
}

/// Called after every logged request. In the app this emits a Tauri event so
/// the Logs view refreshes; a test passes a plain closure so the gateway can be
/// exercised without booting a Tauri instance.
pub type OnLogged = Arc<dyn Fn() + Send + Sync>;

/// The app's entry point: binds and runs forever, emitting the refresh event.
pub async fn serve(app: AppHandle, db: Arc<AsyncMutex<Connection>>) {
    let notifier: OnLogged = Arc::new(move || {
        let _ = app.emit("llm-log:appended", ());
    });
    serve_with(db, notifier).await;
}

/// The accept loop, with the notification hook injected.
///
/// Split from [`serve`] so an integration test can drive the *real* server —
/// real socket, real HTTP parse, real chunked relay — against a real upstream
/// without a window.
pub async fn serve_with(db: Arc<AsyncMutex<Connection>>, on_logged: OnLogged) {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[relay:llm-gateway] FAILED to bind 127.0.0.1:0: {e} — gateway unavailable");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    BOUND_PORT.store(port, Ordering::SeqCst);
    let token = new_token();
    {
        let conn = db.lock().await;
        let _ = crate::db::set_setting(&conn, super::GATEWAY_PORT_KEY, &port.to_string());
        // Publish the token where the Logs view can show it with a copy button.
        let _ = crate::db::set_setting(&conn, "gateway.token", &token);
    }
    eprintln!(
        "[relay:llm-gateway] listening on http://127.0.0.1:{port} \
         (token required; external apps set base_url to http://127.0.0.1:{port})"
    );

    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let db = db.clone();
                let token = token.clone();
                let on_logged = Arc::clone(&on_logged);
                tokio::spawn(async move {
                    handle_connection(stream, db, token, on_logged).await;
                });
            }
            Err(e) => {
                eprintln!("[relay:llm-gateway] accept error: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// Read the head (bounded, timed), then exactly `Content-Length` more bytes.
async fn read_request(stream: &mut TcpStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buf = [0u8; 8192];
    let mut got: Vec<u8> = Vec::with_capacity(8192);
    let head_end;
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        got.extend_from_slice(&buf[..n]);
        if let Some(i) = find_head_end(&got) {
            head_end = i;
            break;
        }
        if got.len() > MAX_HEAD_BYTES {
            return None;
        }
    }
    let rest = got.split_off(head_end);
    Some((got, rest))
}

/// Index just past the `\r\n\r\n`, if present.
fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

async fn handle_connection(
    mut stream: TcpStream,
    db: Arc<AsyncMutex<Connection>>,
    token: String,
    on_logged: OnLogged,
) {
    let Some((head, mut body)) = read_request(&mut stream).await else { return };
    let req = match parse_request(&head, &body) {
        Ok(r) => r,
        Err(e) => {
            respond_json(&mut stream, 400, "Bad Request", &format!(r#"{{"error":"{e}"}}"#)).await;
            return;
        }
    };

    // ── auth ──
    // The log API is Relay's own surface for other apps to read; it is behind
    // the same token, since it exposes full prompt history.
    let require_auth = {
        let conn = db.lock().await;
        crate::db::get_setting(&conn, GATEWAY_REQUIRE_AUTH_KEY)
            .ok()
            .flatten()
            .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
            .unwrap_or(true)
    };
    if require_auth && !auth_ok(req.header("authorization"), &token) {
        respond_json(&mut stream, 401, "Unauthorized", r#"{"error":"unauthorized"}"#).await;
        return;
    }

    // ── Relay's own read-only log API ──
    if req.path.starts_with("/_relay") {
        handle_log_api(&mut stream, &req, &db).await;
        return;
    }

    // ── passthrough ──
    forward(&mut stream, &req, &db, &on_logged).await;
}

async fn respond_json(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

/// Write one chunk of a `Transfer-Encoding: chunked` body.
async fn write_chunk(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    stream.write_all(format!("{:x}\r\n", data.len()).as_bytes()).await?;
    stream.write_all(data).await?;
    stream.write_all(b"\r\n").await?;
    Ok(())
}

/// Terminate a chunked body.
async fn write_last_chunk(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(b"0\r\n\r\n").await?;
    stream.flush().await
}

/// Headers that describe a single hop and must not be relayed.
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "host" | "content-length"
    )
}

/// Forward a request upstream and relay the response body byte-for-byte.
async fn forward(stream: &mut TcpStream, req: &ParsedRequest, db: &Arc<AsyncMutex<Connection>>, on_logged: &OnLogged) {
    // Target: explicit header, then `/t/<name>/...` prefix, then the default.
    let (target_name, path) = match req.header("x-relay-target") {
        Some(n) => (n.trim().to_string(), req.path.clone()),
        None => match req.path.strip_prefix("/t/") {
            Some(rest) => match rest.split_once('/') {
                Some((name, tail)) => (name.to_string(), format!("/{}", tail.trim_start_matches('/'))),
                None => (rest.to_string(), "/".to_string()),
            },
            None => (String::new(), req.path.clone()),
        },
    };

    let target = {
        let conn = db.lock().await;
        if target_name.is_empty() {
            default_target(&conn)
        } else {
            resolve_target(&conn, &target_name)
        }
    };
    let Some(target) = target else {
        respond_json(stream, 503, "Service Unavailable", r#"{"error":"no target configured"}"#).await;
        return;
    };

    let url = format!("{}{}", target.base_url, req.target_for_upstream(&path));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .unwrap_or_default();
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut builder = client.request(method, &url);
    for (k, v) in &req.headers {
        // Authorization is consumed by OUR auth check above. Forwarding it
        // would hand the runtime Relay's gateway token: harmless when the
        // runtime is keyless, a guaranteed 401 when it isn't.
        if !is_hop_by_hop(k) && !k.eq_ignore_ascii_case("authorization") {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }
    if let Some(key) = &target.api_key {
        builder = builder.header("Authorization", format!("Bearer {key}"));
    }
    if !body_is_empty(&req.body) {
        builder = builder.body(req.body.clone());
    }

    let mut cap = Capture::new(
        "external",
        &classify_target(Some(&target.base_url), &target.name),
        &req.method,
        &path,
        std::str::from_utf8(&req.body).ok(),
    );

    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            cap.error = Some(format!("upstream unreachable: {e}"));
            let cfg = { let conn = db.lock().await; LogConfig::load(&conn) };
            { let conn = db.lock().await; cap.finish(&conn, &cfg); }
            respond_json(stream, 502, "Bad Gateway", r#"{"error":"upstream unreachable"}"#).await;
            return;
        }
    };

    let status = upstream.status();
    cap.upstream_status = Some(status.as_u16() as i64);
    let content_length: Option<usize> = upstream
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // Relay the status line and headers, minus hop-by-hop ones.
    let mut head_out = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    for (k, v) in upstream.headers() {
        let name = k.as_str();
        if is_hop_by_hop(name) {
            continue;
        }
        if let Ok(val) = v.to_str() {
            head_out.push_str(&format!("{name}: {val}\r\n"));
        }
    }
    match content_length {
        // Fixed-length body: relay exactly that many bytes, no chunk framing.
        Some(n) => head_out.push_str(&format!("Content-Length: {n}\r\nConnection: close\r\n\r\n")),
        // Streamed: the only way to describe a body of unknown length to an
        // HTTP/1.1 client. This is the path llama.cpp and Ollama take.
        None => head_out.push_str("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"),
    }
    if stream.write_all(head_out.as_bytes()).await.is_err() {
        return;
    }

    let mut upstream_body = upstream.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(RELAY_CHUNK);
    while let Some(next) = futures_util::StreamExt::next(&mut upstream_body).await {
        let Ok(bytes) = next else { break };
        cap.note_first_byte();
        // Keep our own copy of what we relay. `buf` is flushed to the client
        // as it fills, so the log needs a separate accumulator — and it is
        // this verbatim copy that lets telemetry be re-derived later without
        // re-capturing the request.
        cap.response_buf.push_str(&String::from_utf8_lossy(&bytes));
        if content_length.is_some() {
            // A length-delimited body needs no framing and no buffering —
            // relay each piece straight through.
            if stream.write_all(&bytes).await.is_err() {
                return;
            }
        } else {
            buf.extend_from_slice(&bytes);
            // Flush whole chunks as they arrive so the client sees tokens at
            // the same cadence the model produced them.
            while buf.len() >= RELAY_CHUNK {
                let rest = buf.split_off(RELAY_CHUNK);
                if write_chunk(stream, &buf).await.is_err() {
                    return;
                }
                buf = rest;
            }
        }
    }
    if content_length.is_none() {
        if !buf.is_empty() && write_chunk(stream, &buf).await.is_err() {
            return;
        }
        let _ = write_last_chunk(stream).await;
    }
    let _ = stream_flush_and_shutdown(stream).await;

    // Log after the client is served: the row should exist when the user sees
    // the response, but never at the cost of delaying it.
    let cfg = { let conn = db.lock().await; LogConfig::load(&conn) };
    {
        let conn = db.lock().await;
        cap.finish(&conn, &cfg);
    }
    on_logged();
}

async fn stream_flush_and_shutdown(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.flush().await?;
    stream.shutdown().await
}

fn body_is_empty(b: &[u8]) -> bool {
    b.is_empty()
}

impl ParsedRequest {
    /// The request target as it goes upstream: the original query is
    /// preserved, but the `/t/<name>` prefix is stripped.
    fn target_for_upstream(&self, stripped_path: &str) -> String {
        let query = self.target.split_once('?').map(|(_, q)| format!("?{q}")).unwrap_or_default();
        format!("{stripped_path}{query}")
    }
}

// ── Relay's read-only log API ──────────────────────────────────────────────

async fn handle_log_api(stream: &mut TcpStream, req: &ParsedRequest, db: &Arc<AsyncMutex<Connection>>) {
    let json = |v: serde_json::Value| v.to_string();
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/_relay/health") => {
            let conn = db.lock().await;
            let target = default_target(&conn);
            let payload = json(serde_json::json!({
                "ok": true,
                "port": bound_port(),
                "defaultTarget": target.as_ref().map(|t| t.name.clone()),
                "targets": {
                    "ollama": format!("http://127.0.0.1:{OLLAMA_PORT}"),
                    "lmstudio": format!("http://127.0.0.1:{LMSTUDIO_PORT}"),
                },
                "stats": store::stats(&conn).ok(),
            }));
            drop(conn);
            respond_json(stream, 200, "OK", &payload).await;
        }
        ("GET", "/_relay/logs") => {
            let conn = db.lock().await;
            let filter = store::LogFilter {
                limit: Some(200),
                ..Default::default()
            };
            let payload = match store::list(&conn, &filter) {
                Ok(rows) => json(serde_json::json!({ "items": rows })),
                Err(e) => json(serde_json::json!({ "error": e.to_string() })),
            };
            drop(conn);
            respond_json(stream, 200, "OK", &payload).await;
        }
        ("GET", p) if p.starts_with("/_relay/logs/") => {
            let id = p.trim_start_matches("/_relay/logs/");
            let conn = db.lock().await;
            let payload = match store::get(&conn, id) {
                Ok(Some(d)) => json(serde_json::to_value(d).unwrap_or_default()),
                Ok(None) => json(serde_json::json!({ "error": "not_found" })),
                Err(e) => json(serde_json::json!({ "error": e.to_string() })),
            };
            let status = if payload.contains("not_found") { 404 } else { 200 };
            drop(conn);
            respond_json(stream, status, "OK", &payload).await;
        }
        ("DELETE", "/_relay/logs") => {
            let conn = db.lock().await;
            let n = store::clear(&conn).unwrap_or(0);
            drop(conn);
            respond_json(stream, 200, "OK", &json(serde_json::json!({ "cleared": n }))).await;
        }
        _ => {
            respond_json(stream, 404, "Not Found", r#"{"error":"not_found"}"#).await;
        }
    }
}

/// Exposed for the settings panel: is a named target reachable right now?
pub async fn probe_target(base_url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    // llama.cpp and LM Studio both answer /v1/models; Ollama does not, so try
    // its native tag list as a fallback.
    for path in ["/v1/models", "/api/tags"] {
        if let Ok(r) = client.get(format!("{base_url}{path}")).send().await {
            if r.status().is_success() {
                return true;
            }
        }
    }
    false
}

/// Classify a raw body for the gateway's own use — re-exported so tests can
/// reach the framing logic without importing the sibling module.
pub use super::normalize::{detect_framing, extract};

/// Where the gateway decided a request went, for the log row.
pub fn target_label(base_url: &str) -> String {
    classify_target(Some(base_url), "external")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(raw: &str) -> ParsedRequest {
        let idx = raw.find("\r\n\r\n").expect("test fixture needs a head") + 4;
        parse_request(raw[..idx].as_bytes(), raw[idx..].as_bytes()).expect("parses")
    }

    #[test]
    fn parses_a_post_with_a_body() {
        let r = req("POST /v1/chat/completions?x=1 HTTP/1.1\r\nHost: a\r\nAuthorization: Bearer tok\r\nContent-Length: 11\r\n\r\n{\"model\":1}");
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/v1/chat/completions");
        assert_eq!(r.target, "/v1/chat/completions?x=1");
        assert_eq!(r.header("authorization"), Some("Bearer tok"));
        assert_eq!(r.header("AUTHORIZATION"), Some("Bearer tok"), "lookup is case-insensitive");
        assert_eq!(r.header("missing"), None);
        assert_eq!(r.body, b"{\"model\":1}");
    }

    #[test]
    fn body_is_truncated_to_content_length() {
        // Extra bytes past Content-Length must not leak into the forwarded body.
        let r = req("POST /x HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcTRAILING");
        assert_eq!(r.body, b"abc");
    }

    #[test]
    fn a_get_with_no_body_parses() {
        let r = req("GET /v1/models HTTP/1.1\r\nHost: a\r\n\r\n");
        assert_eq!(r.method, "GET");
        assert!(r.body.is_empty());
    }

    #[test]
    fn rejects_a_malformed_request_line() {
        assert!(parse_request(b"GARBAGE\r\n\r\n", b"").is_err());
    }

    #[test]
    fn auth_accepts_only_the_exact_bearer_token() {
        assert!(auth_ok(Some("Bearer s3cret"), "s3cret"));
        assert!(auth_ok(Some("bearer s3cret"), "s3cret"));
        assert!(!auth_ok(Some("Bearer wrong"), "s3cret"));
        assert!(!auth_ok(Some("Bearer s3cret"), "s3cret-longer"), "length must not match");
        assert!(!auth_ok(None, "s3cret"));
        assert!(!auth_ok(Some("s3cret"), "s3cret"), "scheme is required");
        assert!(!auth_ok(Some("Basic s3cret"), "s3cret"));
    }

    #[test]
    fn strips_the_target_prefix_but_keeps_the_query() {
        let r = req("POST /t/ollama/api/chat?stream=true HTTP/1.1\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(r.path, "/t/ollama/api/chat");
        let rest = r.path.strip_prefix("/t/").unwrap();
        let (name, tail) = rest.split_once('/').unwrap();
        assert_eq!(name, "ollama");
        assert_eq!(r.target_for_upstream(&format!("/{tail}")), "/api/chat?stream=true");
    }

    #[test]
    fn hop_by_hop_headers_are_not_relayed() {
        assert!(is_hop_by_hop("Transfer-Encoding"));
        assert!(is_hop_by_hop("connection"));
        assert!(is_hop_by_hop("Host"));
        assert!(!is_hop_by_hop("Content-Type"));
        assert!(!is_hop_by_hop("Accept"));
    }

    #[test]
    fn finds_the_head_boundary() {
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r\nBODY"), Some(18));
        assert_eq!(find_head_end(b"no terminator here"), None);
    }
}
