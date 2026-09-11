//! Connection-loss detection and the reconnect ladder.
//!
//! The old contract was a bare 60 s stall watchdog: a minute of silence from
//! the provider failed the turn outright, the user got an error banner, and
//! the only way forward was to press Regenerate by hand. A Wi-Fi hand-off, a
//! VPN flap, or a proxy that quietly half-closes the socket all land there
//! (and mid-answer, they take the visible partial with them) — none of those
//! are the model's fault and all of them are transient.
//!
//! This module replaces that single deadline with a pinged one:
//!
//! 1. **Detection** (`streaming::stream_next_with_watchdog`): silence no
//!    longer kills the stream by the clock alone. After [`IDLE_PROBE`] of
//!    silence the reader PINGS the provider — a `GET {base}/v1/models` that
//!    every OpenAI- and Anthropic-shaped API answers, so any HTTP status
//!    counts as reachable and only a transport failure (DNS, connect, TLS,
//!    timeout) counts as down. Reachable means the request is probably just
//!    slow (long thinking, big prompt eval) and the wait is extended up to
//!    [`IDLE_HARD_CAP`]; unreachable means the connection is gone and the
//!    turn fails fast instead of waiting the full window out.
//! 2. **Recovery** ([`reconnect`]): the turn loop then re-dials the SAME
//!    model up to [`MAX_ATTEMPTS`] times, spacing the attempts with a ping
//!    so a lost network costs seconds per try instead of hammering ten dead
//!    requests in a row, and reporting progress to the UI
//!    ("Reconnecting… (3/10)").
//!
//! Safety rule: a reconnect re-issues the request from scratch, so it may
//! only run while the turn has produced NO side effects — the caller gates
//! on `TurnPerf::tools_ran`. A stall after a tool executed keeps the old
//! fail-the-turn behavior, because re-running the round would redo the
//! write/shell call. That same restart-from-zero is why a reconnected turn
//! drops the live buffer in the UI (announced as [`REASON_RESTART`]) while
//! the discarded text is kept aside, so a ladder that ultimately fails still
//! persists what the user watched.

use std::time::Duration;

/// `chat:status` reason for "the connection dropped, a retry is coming" —
/// rendered under the assistant bubble with the attempt counter.
pub const REASON_RECONNECTING: &str = "reconnecting";
/// `chat:status` reason announcing that the pending attempt is about to
/// re-issue the request. The frontend uses this one to drop the live buffer
/// (the answer restarts from zero) while keeping the text aside.
pub const REASON_RESTART: &str = "reconnect_restart";
/// `chat:status` reason for "the retry took — clear the reconnect line".
pub const REASON_RECONNECTED: &str = "reconnected";

/// How many times a lost connection is re-dialed before the turn gives up.
pub const MAX_ATTEMPTS: u32 = 10;

/// Wall-clock ceiling for the whole ladder: a network that stays down (or a
/// stream that keeps dying) must not park the turn forever. The user can
/// always send again.
pub const TOTAL_BUDGET: Duration = Duration::from_secs(180);

/// Silence tolerated inside one stream read before the endpoint is pinged.
/// Shorter than the flat 60 s deadline the watchdog used to enforce, because
/// the ping — not the clock — now decides whether to keep waiting.
pub const IDLE_PROBE: Duration = Duration::from_secs(25);

/// Hard ceiling on silence from a provider that keeps answering pings: a
/// request that is alive but wordless for this long is treated as lost.
pub const IDLE_HARD_CAP: Duration = Duration::from_secs(90);

/// Per-ping timeout. A probe that cannot complete in this window has already
/// told us what we needed to know.
pub const PING_TIMEOUT: Duration = Duration::from_secs(4);

/// How long one attempt waits for the endpoint to answer a ping before it
/// stops waiting and tries the request anyway.
pub const PING_WAIT: Duration = Duration::from_secs(5);

/// Gap between pings while waiting for the endpoint to come back.
pub const PING_INTERVAL: Duration = Duration::from_secs(2);

/// Ladder timings. The free constants above are the production values; the
/// struct exists so tests can run the ladder at millisecond scale.
#[derive(Clone, Copy)]
pub struct Config {
    pub max_attempts: u32,
    pub total_budget: Duration,
    pub ping_wait: Duration,
    pub ping_interval: Duration,
    pub backoff_cap: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_attempts: MAX_ATTEMPTS,
            total_budget: TOTAL_BUDGET,
            ping_wait: PING_WAIT,
            ping_interval: PING_INTERVAL,
            backoff_cap: Duration::from_secs(5),
        }
    }
}

impl Config {
    /// Delay before reconnect attempt `n` (1-based): linear up to
    /// `backoff_cap`, then flat — 1 s, 2 s, … 5 s, 5 s with the production
    /// cap. The ping wait that follows is where the patience lives, so a
    /// longer sleep here would only delay the recovery.
    pub fn backoff(&self, attempt: u32) -> Duration {
        self.backoff_cap / 5 * attempt.min(5)
    }
}

/// Error strings that mean "the transport died", as opposed to "the provider
/// answered with a refusal". The distinction decides who owns the failure:
/// transport loss runs the reconnect ladder, protocol errors (429, 5xx, bad
/// key, dead model) stay with the fail-over/health path — the router's
/// `PreStreamFailure` classification reads those strings and must keep
/// seeing them verbatim.
///
/// These are the exact prefixes the stream round functions build
/// (`streaming.rs` + `chat/mod.rs`), plus the reqwest/hyper io phrasing that
/// arrives wrapped inside `request failed: {e}`.
pub fn is_connection_loss(err: &str) -> bool {
    let m = err.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        // The watchdog's own two verdicts.
        "stream stalled",
        "stream read error",
        // Time-to-headers / connect failures.
        "request timed out waiting for response headers",
        "request failed:",
        // Transport-level io, however reqwest/hyper worded it.
        "connection closed",
        "connection reset",
        "connection refused",
        "connection aborted",
        "broken pipe",
        "unexpected eof",
        "incomplete message",
        "error decoding response body",
        "error trying to connect",
        "dns error",
        "tcp connect error",
    ];
    MARKERS.iter().any(|k| m.contains(k))
}

/// A reachability probe for one provider endpoint.
///
/// Deliberately NOT an authenticated health check: [`PingTarget::ping`] asks
/// only "does this endpoint complete an HTTP round trip right now". That is
/// the question the ladder needs — "is the network back?" — and it is the one
/// question every provider shape answers the same way. A 401 from a rotated
/// key, a 404 from a proxy that has no `/models`, even a 500: all of them
/// prove the socket, DNS, TLS and HTTP layers are working.
#[derive(Clone)]
pub struct PingTarget {
    client: reqwest::Client,
    url: String,
    api_key: String,
    anthropic: bool,
}

impl PingTarget {
    /// `base` is the provider root the request itself was built from
    /// (`https://api.openai.com`, `https://api.anthropic.com`, an
    /// OpenAI-compatible root, a llama-server `http://127.0.0.1:PORT`).
    pub fn new(client: &reqwest::Client, base: &str, api_key: &str, anthropic: bool) -> Self {
        Self {
            client: client.clone(),
            url: format!("{}/v1/models", base.trim_end_matches('/')),
            api_key: api_key.to_string(),
            anthropic,
        }
    }

    /// True when the endpoint answered at all (any status); false on a
    /// transport error or [`PING_TIMEOUT`].
    pub async fn ping(&self) -> bool {
        let req = self.client.get(&self.url);
        let req = if self.anthropic {
            req.header("x-api-key", &self.api_key).header(
                "anthropic-version",
                crate::chat::providers::ANTHROPIC_API_VERSION,
            )
        } else {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        };
        matches!(
            tokio::time::timeout(PING_TIMEOUT, req.send()).await,
            Ok(Ok(_))
        )
    }
}

/// Wait for a disconnected endpoint to answer, for at most `cfg.ping_wait`.
/// Returns whether it came back — and returns immediately when it is up, so
/// the happy path pays one probe, not the whole window.
async fn wait_reachable(
    ping: &PingTarget,
    cfg: &Config,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> bool {
    let deadline = std::time::Instant::now() + cfg.ping_wait;
    loop {
        if ping.ping().await {
            return true;
        }
        if is_cancelled() || std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(cfg.ping_interval).await;
    }
}

/// Re-dial a lost connection: up to `cfg.max_attempts` fresh attempts,
/// reporting every stage through `notify`.
///
/// `attempt` re-issues the whole turn (the caller's "one attempt" expression).
/// Each attempt is preceded by a ping, which is what spaces them out: while
/// the network is down every try costs the ping wait plus the backoff instead
/// of ten dead requests fired back to back, and the moment the endpoint
/// answers again the next attempt goes out immediately. The request itself
/// stays the ground truth — a provider whose `/models` is slow or missing
/// still gets its retry — so the probe never decides *whether* to retry, only
/// how long each cycle waits.
///
/// Returns the first successful attempt's value, or the last connection-loss
/// error annotated with how many retries it survived.
///
/// Metrics are deliberately NOT rewound across attempts: the discarded
/// attempt was billed by the provider, so its tokens and its wall-clock stay
/// in the turn's totals (`TurnPerf`) — the numbers the cost model and the
/// composer chips report are what the turn actually cost, not what the final
/// attempt cost.
///
/// A non-connection error from a retry is returned AS IS: the caller's
/// fail-over/health classification owns it, and wrapping it in reconnect
/// prose would strand the router on a message it cannot classify.
///
/// The callbacks are `Send + Sync` because the turn task they run inside is
/// spawned onto the async runtime.
pub async fn reconnect<T, F, Fut>(
    ping: &PingTarget,
    cfg: &Config,
    notify: &(dyn Fn(&str, String) + Send + Sync),
    first_error: String,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
    mut attempt: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let started = std::time::Instant::now();
    let mut last = first_error;
    let mut spent = 0u32;
    for n in 1..=cfg.max_attempts {
        // A cancelled turn aborts the task outright; these gates cover the
        // cancel that lands while the ladder is parked between awaits.
        if is_cancelled() || started.elapsed() >= cfg.total_budget {
            break;
        }
        let counter = format!("({n}/{})", cfg.max_attempts);
        notify(
            REASON_RECONNECTING,
            format!("Reconnecting\u{2026} {counter}"),
        );
        tokio::time::sleep(cfg.backoff(n)).await;
        wait_reachable(ping, cfg, is_cancelled).await;
        if is_cancelled() {
            break;
        }
        spent = n;
        notify(REASON_RESTART, format!("Reconnecting\u{2026} {counter}"));
        match attempt().await {
            Ok(value) => {
                notify(
                    REASON_RECONNECTED,
                    format!("Reconnected on attempt {counter}"),
                );
                return Ok(value);
            }
            Err(e) => {
                if !is_connection_loss(&e) {
                    return Err(e);
                }
                last = e;
            }
        }
    }
    Err(format!(
        "{last} \u{2014} gave up after {spent} reconnect attempts"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Millisecond-scale timings so the ladder's control flow is testable
    /// without waiting out production windows.
    fn fast() -> Config {
        Config {
            max_attempts: 10,
            total_budget: Duration::from_secs(60),
            ping_wait: Duration::from_millis(30),
            ping_interval: Duration::from_millis(5),
            backoff_cap: Duration::from_millis(5),
        }
    }

    /// A throwaway endpoint: `up` answers any request with a status (401 —
    /// reachable), `down` accepts and drops the connection without answering
    /// (a service that is there but not talking — the transport fails, so the
    /// probe reads "lost connection"). A closed port would read the same way
    /// but costs the OS's connect-retry time on every probe.
    async fn endpoint(up: bool) -> PingTarget {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                if !up {
                    continue; // drop() → the client sees the connection die
                }
                let _ = sock
                    .write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n")
                    .await;
                // Drain and hold the socket open: a close() with the request
                // still unread sends RST, which the client reads as a
                // transport failure rather than a 401.
                let mut drain = [0u8; 512];
                while matches!(sock.read(&mut drain).await, Ok(n) if n > 0) {}
            }
        });
        PingTarget::new(
            &reqwest::Client::new(),
            &format!("http://{addr}"),
            "key",
            false,
        )
    }

    #[test]
    fn connection_loss_markers_match_the_real_error_strings() {
        // The exact strings the stream rounds build for a dead transport.
        assert!(is_connection_loss("stream stalled: no data received for 60s"));
        assert!(is_connection_loss(
            "stream stalled: connection lost (endpoint unreachable)"
        ));
        assert!(is_connection_loss(
            "stream read error: connection reset by peer"
        ));
        assert!(is_connection_loss(
            "request timed out waiting for response headers (60s)"
        ));
        assert!(is_connection_loss(
            "request failed: error sending request for url (https://api.openai.com/v1/chat/completions): error trying to connect: dns error: failed to lookup address information"
        ));
    }

    #[test]
    fn provider_refusals_are_not_connection_loss() {
        // These must reach the fail-over/health classifier untouched: it
        // reads the string, so swallowing one into the ladder would strand
        // a rate-limited turn retrying a provider that already said no.
        assert!(!is_connection_loss("HTTP 429 Too Many Requests: {}"));
        assert!(!is_connection_loss("HTTP 500: internal error"));
        assert!(!is_connection_loss("provider error: overloaded"));
        assert!(!is_connection_loss(
            "HTTP 400: prompt is too long: 200000 tokens > 128000 maximum"
        ));
    }

    #[test]
    fn backoff_is_linear_and_capped() {
        let cfg = Config::default();
        assert_eq!(cfg.backoff(1), Duration::from_secs(1));
        assert_eq!(cfg.backoff(3), Duration::from_secs(3));
        assert_eq!(cfg.backoff(5), Duration::from_secs(5));
        assert_eq!(cfg.backoff(10), Duration::from_secs(5));
    }

    #[test]
    fn ping_target_builds_models_url_without_doubling_the_slash() {
        let target = PingTarget::new(
            &reqwest::Client::new(),
            "https://api.openai.com/",
            "k",
            false,
        );
        assert_eq!(target.url, "https://api.openai.com/v1/models");
        let anthropic =
            PingTarget::new(&reqwest::Client::new(), "https://api.anthropic.com", "k", true);
        assert_eq!(anthropic.url, "https://api.anthropic.com/v1/models");
    }

    #[tokio::test]
    async fn ping_treats_any_http_status_as_reachable() {
        assert!(
            endpoint(true).await.ping().await,
            "401 still proves DNS/TCP/TLS/HTTP all work"
        );
        assert!(
            !endpoint(false).await.ping().await,
            "a closed port is a lost connection"
        );
    }

    #[tokio::test]
    async fn ladder_stops_at_the_first_success() {
        let ping = endpoint(true).await;
        let cfg = fast();
        let seen = std::sync::Mutex::new(Vec::<String>::new());
        let notify = |reason: &str, _msg: String| {
            seen.lock().unwrap().push(reason.to_string());
        };
        let mut calls = 0u32;
        let result = reconnect(
            &ping,
            &cfg,
            &notify,
            "stream stalled: no data received for 60s".to_string(),
            &|| false,
            || {
                calls += 1;
                let nth = calls;
                async move {
                    if nth == 1 {
                        Err("stream stalled: no data received for 60s".to_string())
                    } else {
                        Ok("answer")
                    }
                }
            },
        )
        .await;
        assert_eq!(result.expect("second attempt answers"), "answer");
        assert_eq!(calls, 2, "the ladder must re-issue exactly once more");
        assert_eq!(
            seen.lock().unwrap().clone(),
            vec![
                // Attempt 1: announced, then re-issued, then lost again.
                REASON_RECONNECTING.to_string(),
                REASON_RESTART.to_string(),
                // Attempt 2 takes.
                REASON_RECONNECTING.to_string(),
                REASON_RESTART.to_string(),
                REASON_RECONNECTED.to_string(),
            ],
            "the UI needs the wait, the restart and the recovery, in order"
        );
    }

    #[tokio::test]
    async fn ladder_hands_provider_refusals_back_untouched() {
        let ping = endpoint(true).await;
        let cfg = fast();
        let notify = |_r: &str, _m: String| {};
        let mut calls = 0u32;
        let result: Result<&str, String> = reconnect(
            &ping,
            &cfg,
            &notify,
            "stream stalled: no data received for 60s".to_string(),
            &|| false,
            || {
                calls += 1;
                async move { Err("HTTP 429 Too Many Requests: slow down".to_string()) }
            },
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "HTTP 429 Too Many Requests: slow down",
            "a refusal is the router's business, not the ladder's"
        );
        assert_eq!(calls, 1, "no retry after a refusal");
    }

    #[tokio::test]
    async fn ladder_spends_every_attempt_before_giving_up() {
        let ping = endpoint(false).await;
        let cfg = fast();
        let notify = |_r: &str, _m: String| {};
        let mut calls = 0u32;
        let result: Result<&str, String> = reconnect(
            &ping,
            &cfg,
            &notify,
            "stream stalled: connection lost".to_string(),
            &|| false,
            || {
                calls += 1;
                async move { Err("request failed: connection refused".to_string()) }
            },
        )
        .await;
        let err = result.expect_err("a dead endpoint must end in an error");
        assert!(err.contains("gave up after 10 reconnect attempts"), "{err}");
        assert_eq!(
            calls, 10,
            "a request is still the ground truth — the ping only paces it"
        );
    }

    #[tokio::test]
    async fn notify_counts_the_attempts_the_ui_shows() {
        let ping = endpoint(true).await;
        let cfg = fast();
        let messages = std::sync::Mutex::new(Vec::<String>::new());
        let notify = |reason: &str, msg: String| {
            if reason == REASON_RECONNECTING {
                messages.lock().unwrap().push(msg);
            }
        };
        let mut calls = 0u32;
        let _: Result<&str, String> = reconnect(
            &ping,
            &cfg,
            &notify,
            "stream stalled: no data received for 60s".to_string(),
            &|| false,
            || {
                calls += 1;
                let nth = calls;
                async move {
                    if nth < 3 {
                        Err("stream stalled: no data received for 60s".to_string())
                    } else {
                        Ok("answer")
                    }
                }
            },
        )
        .await;
        // The line under the bubble names the attempt and the ceiling the
        // whole ladder shares: "Reconnecting… (n/10)".
        assert_eq!(
            messages.lock().unwrap().clone(),
            vec![
                "Reconnecting\u{2026} (1/10)".to_string(),
                "Reconnecting\u{2026} (2/10)".to_string(),
                "Reconnecting\u{2026} (3/10)".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn cancel_stops_the_ladder() {
        let ping = endpoint(true).await;
        let cfg = fast();
        let notify = |_r: &str, _m: String| {};
        let mut calls = 0u32;
        let result: Result<&str, String> = reconnect(
            &ping,
            &cfg,
            &notify,
            "stream stalled: no data received for 60s".to_string(),
            &|| true,
            || {
                calls += 1;
                async move { Ok("never runs") }
            },
        )
        .await;
        assert!(result.is_err(), "a cancelled turn must not retry");
        assert_eq!(calls, 0, "nothing is re-issued after a cancel");
    }
}
