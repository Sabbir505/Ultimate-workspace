//! End-to-end tests that drive the **real** gateway against a **real**
//! local-model server.
//!
//! These are not mocks. A live `llama-server` is started on 127.0.0.1:18080
//! (see `scripts/live-llm-log-test.sh`), the gateway binds a real socket in
//! front of it, and a real HTTP client sends a real streamed completion
//! through. What this actually proves is the part unit tests cannot: that the
//! hand-rolled HTTP parse, the chunked relay, and the telemetry extraction
//! agree with bytes produced by an independent C++ implementation.
//!
//! When no server is listening these **skip** with a printed reason rather
//! than failing, so `cargo test --lib` stays green on a machine without one.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::Mutex;

use super::gateway;
use crate::db::llm_log as store;

/// Where `scripts/live-llm-log-test.sh` starts llama-server.
const LIVE_UPSTREAM: &str = "http://127.0.0.1:18080";
const LIVE_TARGET: &str = "live-llamacpp";
/// The key the live llama-server was started with (`--api-key`). It is NOT
/// Relay's gateway token — the two must never cross, which is the whole point
/// of `ResolvedTarget::api_key`.
const LIVE_UPSTREAM_KEY: &str = "testtoken123";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("client")
}

/// True when a real llama-server is up. Anything answering `/v1/models` counts.
async fn upstream_ready() -> bool {
    let Ok(r) = client().get(format!("{LIVE_UPSTREAM}/v1/models")).send().await else {
        return false;
    };
    r.status().is_success()
}

/// Boot the gateway against a fresh in-memory DB wired to the live upstream.
///
/// Returns the DB handle, the minted bearer token, and the bound port. The
/// port is read back out of THIS instance's DB rather than the global
/// `bound_port()`: cargo runs these in parallel, so the static is whichever
/// gateway bound last, not ours. Reading it from our own persisted setting is
/// also the check that persistence works.
async fn boot_gateway() -> Option<(Arc<Mutex<Connection>>, String, u16)> {
    if !upstream_ready().await {
        return None;
    }
    let conn = crate::db::mem();
    crate::db::set_setting(
        &conn,
        "gateway.targets",
        &format!(
            r#"{{"{LIVE_TARGET}":{{"url":"{LIVE_UPSTREAM}","apiKey":"{LIVE_UPSTREAM_KEY}"}}}}"#
        ),
    )
    .unwrap();
    crate::db::set_setting(&conn, super::GATEWAY_DEFAULT_TARGET_KEY, LIVE_TARGET).unwrap();
    crate::db::set_setting(&conn, super::GATEWAY_REQUIRE_AUTH_KEY, "1").unwrap();

    let db = Arc::new(Mutex::new(conn));
    let hook: gateway::OnLogged = Arc::new(|| {});
    let spawned = db.clone();
    tokio::spawn(async move {
        gateway::serve_with(spawned, hook).await;
    });
    // Give the accept loop a moment to bind.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (token, port) = {
        let g = db.lock().await;
        let token = crate::db::get_setting(&g, "gateway.token").ok().flatten().unwrap_or_default();
        let port = crate::db::get_setting(&g, super::GATEWAY_PORT_KEY)
            .ok()
            .flatten()
            .and_then(|p| p.parse().ok())
            .unwrap_or(0);
        (token, port)
    };
    assert_ne!(port, 0, "the gateway must have persisted its bound port");
    Some((db, token, port))
}

/// Poll for the newest row, since the gateway writes it after the client's
/// last byte rather than before.
async fn wait_for_row(db: &Arc<Mutex<Connection>>, attempts: usize) -> Option<store::LlmLogDetail> {
    for _ in 0..attempts {
        {
            let g = db.lock().await;
            if let Ok(rows) = store::list(&g, &store::LogFilter { limit: Some(1), ..Default::default() }) {
                if let Some(s) = rows.first() {
                    return store::get(&g, &s.id).ok().flatten();
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    None
}

#[tokio::test]
async fn relays_a_real_streamed_completion_and_logs_it() {
    let Some((db, token, port)) = boot_gateway().await else {
        crate::relay_eprintln!("SKIP: no llama-server on {LIVE_UPSTREAM} — run scripts/live-llm-log-test.sh");
        return;
    };

    let body = serde_json::json!({
        "model": "local",
        "messages": [{"role": "user", "content": "Reply with the single word: pong"}],
        "max_tokens": 24,
        "stream": true,
    });
    let resp = client()
        .post(format!("http://127.0.0.1:{port}/t/{LIVE_TARGET}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("gateway request");

    // The client must have been served real SSE, not an error page.
    assert_eq!(resp.status(), 200, "gateway returned {}", resp.status());
    assert!(
        resp.headers().get("transfer-encoding").is_some(),
        "a streamed body of unknown length must come back chunked, not with a bogus Content-Length"
    );
    let text = resp.text().await.expect("response body");

    // ── the bytes must survive the relay untouched ──
    assert!(text.contains("data: "), "SSE framing lost in transit:\n{}", &text[..text.len().min(400)]);
    assert!(text.contains("[DONE]"), "stream terminator lost in transit");
    assert!(
        text.contains("chat.completion.chunk"),
        "llama.cpp's chunk object did not survive the proxy"
    );

    // ── and the row must describe it ──
    let detail = wait_for_row(&db, 25)
        .await
        .expect("the gateway must log every request it forwards");

    assert_eq!(detail.summary.target, "llamacpp", "port-based target classification");
    assert_eq!(detail.summary.origin, "external");
    assert_eq!(detail.summary.upstream_status, Some(200));
    assert_eq!(detail.summary.method, "POST");
    assert_eq!(detail.summary.path, "/v1/chat/completions", "/t/<name> prefix must be stripped upstream");

    // Verbatim: the stored response is what came back over the wire.
    let stored = detail.response_body.as_deref().expect("response body stored");
    assert_eq!(stored, text, "the log must hold the bytes, not a reconstruction");

    // Telemetry extracted from those bytes by the normalizer.
    assert!(
        detail.summary.output_tokens.unwrap_or(0) > 0,
        "predicted_n should have been read out of the final chunk's timings"
    );
    assert!(
        detail.summary.tokens_per_second.unwrap_or(0.0) > 0.0,
        "predicted_per_second should have been read"
    );
    assert!(
        detail.timings_json.is_some(),
        "the runtime's own timings object is kept unparsed for later re-derivation"
    );

    let sent = detail.request_body.as_deref().expect("request body stored");
    assert!(sent.contains("pong"), "the request body is what we sent");
}

#[tokio::test]
async fn relays_a_non_streamed_completion_with_content_length() {
    let Some((db, token, port)) = boot_gateway().await else {
        crate::relay_eprintln!("SKIP: no llama-server on {LIVE_UPSTREAM}");
        return;
    };

    let resp = client()
        .post(format!("http://127.0.0.1:{port}/t/{LIVE_TARGET}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "model": "local",
            "messages": [{"role": "user", "content": "Say hi"}],
            "max_tokens": 16,
            "stream": false,
        }))
        .send()
        .await
        .expect("gateway request");

    assert_eq!(resp.status(), 200);
    // A fixed-length upstream body must NOT be re-framed as chunked.
    assert!(
        resp.headers().get("content-length").is_some(),
        "a Content-Length upstream response must keep its framing"
    );
    let text = resp.text().await.unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json passthrough");
    assert!(parsed.get("choices").is_some(), "body must pass through unmodified");

    let detail = wait_for_row(&db, 25).await.expect("row written");
    // Non-streaming llama.cpp reports BOTH usage and timings; usage is the
    // canonical count (it includes the 6 cached tokens timings.prompt_n omits).
    assert!(detail.summary.input_tokens.unwrap_or(0) > 0, "usage.prompt_tokens");
    assert!(detail.summary.output_tokens.unwrap_or(0) > 0, "usage.completion_tokens");
}

#[tokio::test]
async fn refuses_an_unauthenticated_request() {
    let Some((_db, token, port)) = boot_gateway().await else {
        crate::relay_eprintln!("SKIP: no llama-server on {LIVE_UPSTREAM}");
        return;
    };
    assert!(!token.is_empty(), "a token must have been minted");

    let resp = client()
        .post(format!("http://127.0.0.1:{port}/t/{LIVE_TARGET}/v1/chat/completions"))
        .json(&serde_json::json!({"model":"x","messages":[]}))
        .send()
        .await
        .expect("request");
    assert_eq!(resp.status(), 401, "no token must be rejected");
}

#[tokio::test]
async fn serves_the_read_only_log_api_over_http() {
    let Some((db, token, port)) = boot_gateway().await else {
        crate::relay_eprintln!("SKIP: no llama-server on {LIVE_UPSTREAM}");
        return;
    };

    // Produce one row to read back.
    let _ = client()
        .post(format!("http://127.0.0.1:{port}/t/{LIVE_TARGET}/v1/models"))
        .bearer_auth(&token)
        .send()
        .await;
    wait_for_row(&db, 25).await.expect("row written");

    let resp = client()
        .get(format!("http://127.0.0.1:{port}/_relay/logs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("log api request");
    assert_eq!(resp.status(), 200);
    let v: serde_json::Value = resp.json().await.expect("json");
    let items = v["items"].as_array().expect("items array");
    assert!(!items.is_empty(), "the forwarded request must be listed");
    assert_eq!(items[0]["target"], "llamacpp");
}

#[tokio::test]
async fn the_clients_gateway_token_is_never_forwarded_upstream() {
    let Some((_db, token, port)) = boot_gateway().await else {
        crate::relay_eprintln!("SKIP: no llama-server on {LIVE_UPSTREAM}");
        return;
    };
    // The live server is started with `--api-key testtoken123`, so this only
    // succeeds if the gateway swapped Relay's bearer token for the upstream
    // key rather than passing ours through. Live testing is what caught this:
    // both are valid bearers, and only one is right for the far side.
    assert_ne!(token, LIVE_UPSTREAM_KEY);
    let resp = client()
        .post(format!("http://127.0.0.1:{port}/t/{LIVE_TARGET}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "model": "local",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 8,
            "stream": false,
        }))
        .send()
        .await
        .expect("gateway request");
    assert_eq!(
        resp.status(),
        200,
        "upstream saw Relay's token instead of its own key"
    );
}

#[tokio::test]
async fn the_round_guard_turns_real_stream_bytes_into_a_row() {
    // The tool loops arm the guard through `begin_round`, which needs an
    // AppHandle; this drives the guard itself against bytes a real
    // llama-server produced, so the link between "streamed response" and
    // "row in SQLite" is proven without a window.
    const REAL_SSE: &str = concat!(
        "data: {\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"content\":\"po\"}}],",
        "\"id\":\"chatcmpl-live\",\"model\":\"MiniCPM5-2B-Q8_0.gguf\",\"object\":\"chat.completion.chunk\"}\n\n",
        "data: {\"choices\":[{\"finish_reason\":\"stop\",\"index\":0,\"delta\":{}}],\"id\":\"chatcmpl-live\",",
        "\"model\":\"MiniCPM5-2B-Q8_0.gguf\",\"object\":\"chat.completion.chunk\",\"timings\":{\"cache_n\":4,",
        "\"prompt_n\":15,\"prompt_ms\":54.165,\"prompt_per_second\":276.93,\"predicted_n\":19,",
        "\"predicted_ms\":246.712,\"predicted_per_second\":72.96}}\n\n",
        "data: [DONE]\n\n"
    );

    let conn = crate::db::mem();
    crate::db::llm_log::ensure_schema(&conn).unwrap();
    let db = Arc::new(parking_lot::Mutex::new(conn));
    let cfg = super::LogConfig::default();

    {
        let mut guard = super::CaptureGuard::new(
            super::Capture::new(
                "relay",
                "llamacpp",
                "POST",
                "/v1/chat/completions",
                Some(r#"{"model":"MiniCPM5-2B-Q8_0.gguf","messages":[{"role":"user","content":"Reply pong"}]}"#),
            ),
            db.clone(),
            cfg,
        );
        guard.set_status(200);
        guard.note_first_byte();
        guard.tee(REAL_SSE.as_bytes());
        // Dropping is what writes the row — the same way the round functions
        // finish, on every return path.
    }

    let g = db.lock();
    let rows = store::list(&g, &store::LogFilter::default()).unwrap();
    assert_eq!(rows.len(), 1, "the guard must write exactly one row");
    let d = store::get(&g, &rows[0].id).unwrap().unwrap();
    assert_eq!(d.summary.origin, "relay");
    assert_eq!(d.summary.target, "llamacpp");
    assert_eq!(d.summary.upstream_status, Some(200));
    assert_eq!(d.response_body.as_deref(), Some(REAL_SSE), "stored verbatim");
    assert_eq!(d.summary.output_tokens, Some(19), "predicted_n");
    assert_eq!(d.summary.input_tokens, Some(15), "prompt_n");
    assert!(d.summary.tokens_per_second.unwrap() > 72.0);
    assert!(d.timings_json.is_some());
    assert_eq!(d.summary.model.as_deref(), Some("MiniCPM5-2B-Q8_0.gguf"));
}
